import fs from 'node:fs';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { PassThrough } from 'node:stream';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createDebouncedWatcher,
  createWatchCommand,
  type DebouncedWatcherOptions,
} from '../../src/cli/watch.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const temporaryRepos = new Set<string>();

function makeHarness(
  options: {
    initiallyDirty?: boolean;
    lockHeld?: boolean;
    head?: string;
    commit?: string;
    generationId?: string;
    headFails?: boolean;
  } = {},
) {
  const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-repo-'));
  temporaryRepos.add(repoPath);
  fs.mkdirSync(path.join(repoPath, 'src'));
  fs.writeFileSync(path.join(repoPath, 'src/dirty.ts'), 'initial');
  const leasePath = path.join(repoPath, 'watch.lease');
  let emit: ((filename: string) => void) | undefined;
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn(() => {
    child.emit('exit', 0, null);
    return true;
  });

  const spawn = vi.fn(() => child as never);
  const log = vi.fn();
  const error = vi.fn();
  const onSignal = vi.fn();
  const offSignal = vi.fn();
  const planDirtyOverlay = vi.fn(async () => ({
    includePaths: options.initiallyDirty ? ['src/dirty.ts'] : [],
    uncoveredPaths: [],
    allDirtyPaths: options.initiallyDirty ? ['src/dirty.ts'] : [],
    tombstones: [],
    tooMany: false,
    skipped: [],
  }));
  const createWatcher = vi.fn((opts: DebouncedWatcherOptions) =>
    createDebouncedWatcher({
      ...opts,
      debounceMs: 100,
      watchImpl: ((_root, _options, listener) => {
        emit = (filename) => listener('change', filename);
        return { close: vi.fn() } as never;
      }) as typeof import('node:fs').watch,
    }),
  );

  return {
    repoPath,
    leasePath,
    child,
    spawn,
    log,
    error,
    planDirtyOverlay,
    emit(filename: string) {
      emit?.(filename);
    },
    async start(overrides: Parameters<typeof createWatchCommand>[1] = {}) {
      const command = await createWatchCommand(repoPath, {
        leasePath,
        spawn,
        createWatcher,
        isLockHeld: () => options.lockHeld ?? false,
        readHead: async () => {
          if (options.headFails) throw new Error('git unavailable');
          return options.head ?? 'head';
        },
        readBase: async () => ({
          commit: options.commit ?? 'head',
          generationId: options.generationId ?? 'generation',
        }),
        planDirtyOverlay,
        createIgnoreFilter: vi.fn(async () => ({
          ignored: () => false,
          childrenIgnored: () => false,
        })) as never,
        log,
        error,
        cliPath: '/cli/index.js',
        env: { PATH: '/bin', ONTOINDEX_EMBEDDING_MODEL_HASH: 'test', HF_HOME: '/models' },
        onSignal,
        offSignal,
        ...overrides,
      });
      // Allow the startup refresh's dirty plan and base reads to settle.
      for (let i = 0; i < 10; i++) await Promise.resolve();
      return command;
    },
  };
}

afterEach(() => {
  for (const repoPath of temporaryRepos) fs.rmSync(repoPath, { recursive: true, force: true });
  temporaryRepos.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('watch command', () => {
  it('refreshes a changed HEAD once before rebuilding the overlay', async () => {
    vi.useFakeTimers();
    const options = { head: 'head', commit: 'head' };
    const harness = makeHarness(options);
    const command = await harness.start();
    options.head = 'next';
    await vi.advanceTimersByTimeAsync(30000);
    expect(harness.spawn.mock.calls[0]?.[1]).toEqual([
      '/cli/index.js',
      'analyze',
      harness.repoPath,
    ]);
    harness.emit('src/save.ts');
    await vi.advanceTimersByTimeAsync(100);
    expect(harness.spawn).toHaveBeenCalledTimes(1);
    options.commit = 'next';
    harness.child.emit('close', 0, null);
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.spawn.mock.calls[1]?.[1]).toEqual([
      '/cli/index.js',
      'analyze',
      '--dirty-overlay',
      harness.repoPath,
    ]);
    harness.child.emit('close', 0, null);
    await vi.advanceTimersByTimeAsync(30000);
    expect(harness.spawn).toHaveBeenCalledTimes(2);
    command.stop();
  });

  it('retries failed base refresh for the same HEAD', async () => {
    vi.useFakeTimers();
    const options = { head: 'next', commit: 'old' };
    const harness = makeHarness(options);
    const command = await harness.start();
    harness.child.emit('close', 7, null);
    await vi.advanceTimersByTimeAsync(60000);
    expect(harness.spawn).toHaveBeenCalledTimes(2);
    expect(harness.error).toHaveBeenCalledTimes(1);
    expect(harness.error).toHaveBeenCalledWith('Watch base analyze failed with code 7.');
    harness.child.emit('close', 0, null);
    options.head = 'newer';
    await vi.advanceTimersByTimeAsync(30000);
    expect(harness.spawn.mock.calls.some((call) => !call[1].includes('--dirty-overlay'))).toBe(
      true,
    );
    command.stop();
  });

  it.each(['base', 'overlay'] as const)(
    'bounds failed %s retries until repository identity changes',
    async (kind) => {
      vi.useFakeTimers();
      const options = {
        head: 'next',
        commit: kind === 'base' ? 'old' : 'next',
        initiallyDirty: kind === 'overlay',
      };
      const harness = makeHarness(options);
      const command = await harness.start({ retryDelaysMs: [1000], maxRetryAttempts: 2 });
      try {
        await vi.waitFor(() => expect(harness.spawn).toHaveBeenCalledTimes(1));
        for (let attempt = 0; attempt < 3; attempt++) {
          await vi.waitFor(() => expect(harness.spawn).toHaveBeenCalledTimes(attempt + 1));
          harness.child.emit('close', 7, null);
          for (let event = 0; event < 3; event++) {
            harness.emit('src/dirty.ts');
            await vi.advanceTimersByTimeAsync(100);
          }
          expect(harness.spawn).toHaveBeenCalledTimes(attempt + 1);
          await vi.advanceTimersByTimeAsync(700);
        }
        const exhausted =
          'Watch retries exhausted after 2 attempts; waiting for repository changes';
        expect(harness.error.mock.calls.filter(([message]) => message === exhausted)).toHaveLength(
          1,
        );
        await vi.advanceTimersByTimeAsync(90000);
        harness.emit('src/dirty.ts');
        await vi.advanceTimersByTimeAsync(100);
        expect(harness.spawn).toHaveBeenCalledTimes(3);
        expect(harness.error.mock.calls.filter(([message]) => message === exhausted)).toHaveLength(
          1,
        );

        options.head = 'newer';
        await vi.waitFor(async () => {
          await vi.advanceTimersByTimeAsync(30000);
          expect(harness.spawn).toHaveBeenCalledTimes(4);
        });
        for (let attempt = 0; attempt < 3; attempt++) {
          await vi.waitFor(() => expect(harness.spawn).toHaveBeenCalledTimes(attempt + 4));
          harness.child.emit('close', 7, null);
          await vi.advanceTimersByTimeAsync(1000);
        }
        expect(harness.spawn).toHaveBeenCalledTimes(6);
        expect(harness.error.mock.calls.filter(([message]) => message === exhausted)).toHaveLength(
          2,
        );
      } finally {
        await command.stop();
      }
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('retries a skipped base refresh after analyze.lock is released', async () => {
    vi.useFakeTimers();
    const options = { head: 'next', commit: 'old', lockHeld: true };
    const harness = makeHarness(options);
    const command = await harness.start();
    expect(harness.spawn).not.toHaveBeenCalled();
    options.lockHeld = false;
    await vi.advanceTimersByTimeAsync(30000);
    expect(harness.spawn.mock.calls[0]?.[1]).toEqual([
      '/cli/index.js',
      'analyze',
      harness.repoPath,
    ]);
    command.stop();
  });

  it('refreshes only the overlay when the base generation changes', async () => {
    vi.useFakeTimers();
    const options = { generationId: 'one' };
    const harness = makeHarness(options);
    const command = await harness.start();
    options.generationId = 'two';
    await vi.advanceTimersByTimeAsync(30000);
    expect(harness.spawn.mock.calls[0]?.[1]).toEqual([
      '/cli/index.js',
      'analyze',
      '--dirty-overlay',
      harness.repoPath,
    ]);
    harness.child.emit('close', 0, null);
    await vi.advanceTimersByTimeAsync(30000);
    expect(harness.spawn).toHaveBeenCalledTimes(1);
    command.stop();
  });

  it('rebuilds exactly one overlay when the generation changes during reconciliation', async () => {
    vi.useFakeTimers();
    const options = { generationId: 'one' };
    const harness = makeHarness(options);
    const command = await harness.start();

    options.generationId = 'two';
    await vi.advanceTimersByTimeAsync(30000);
    await vi.waitFor(() => expect(harness.spawn).toHaveBeenCalledTimes(1));

    expect(harness.spawn.mock.calls[0]?.[1]).toEqual([
      '/cli/index.js',
      'analyze',
      '--dirty-overlay',
      harness.repoPath,
    ]);
    harness.child.emit('close', 0, null);
    await vi.advanceTimersByTimeAsync(30000);
    expect(harness.spawn).toHaveBeenCalledTimes(1);
    command.stop();
  });

  it('queues one overlay rebuild when the generation changes during an overlay child', async () => {
    vi.useFakeTimers();
    const options = { initiallyDirty: true, generationId: 'one' };
    const harness = makeHarness(options);
    const command = await harness.start();
    await vi.waitFor(() => expect(harness.spawn).toHaveBeenCalledTimes(1));

    options.generationId = 'two';
    await vi.advanceTimersByTimeAsync(30000);
    expect(harness.spawn).toHaveBeenCalledTimes(1);

    harness.child.emit('close', 0, null);
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(async () => {
      await vi.advanceTimersByTimeAsync(30000);
      expect(harness.spawn).toHaveBeenCalledTimes(2);
    });
    expect(harness.spawn.mock.calls[0]?.[1]).toEqual([
      '/cli/index.js',
      'analyze',
      '--dirty-overlay',
      harness.repoPath,
    ]);
    expect(harness.spawn.mock.calls[1]?.[1]).toEqual([
      '/cli/index.js',
      'analyze',
      '--dirty-overlay',
      harness.repoPath,
    ]);

    harness.child.emit('close', 0, null);
    await vi.advanceTimersByTimeAsync(30000);
    expect(harness.spawn).toHaveBeenCalledTimes(2);
    command.stop();
  });

  it('retries the base refresh once after analyze.lock is released', async () => {
    vi.useFakeTimers();
    const options = { head: 'next', commit: 'old', lockHeld: true };
    const harness = makeHarness(options);
    const command = await harness.start();

    await vi.advanceTimersByTimeAsync(30000);
    expect(harness.spawn).not.toHaveBeenCalled();

    options.lockHeld = false;
    await vi.advanceTimersByTimeAsync(30000);
    await vi.waitFor(() => expect(harness.spawn).toHaveBeenCalledTimes(1));
    expect(harness.spawn.mock.calls[0]?.[1]).toEqual([
      '/cli/index.js',
      'analyze',
      harness.repoPath,
    ]);
    await vi.advanceTimersByTimeAsync(30000);
    expect(harness.spawn).toHaveBeenCalledTimes(1);
    command.stop();
  });

  it('does not refresh the base when reading HEAD fails', async () => {
    vi.useFakeTimers();
    const harness = makeHarness({ headFails: true, commit: 'old' });
    const command = await harness.start();
    await vi.advanceTimersByTimeAsync(60000);
    expect(harness.spawn).not.toHaveBeenCalled();
    command.stop();
  });
  it('reconciles a missed save at the next tick', async () => {
    vi.useFakeTimers();
    const options = { initiallyDirty: false };
    const harness = makeHarness(options);
    const command = await harness.start();
    options.initiallyDirty = true;
    await vi.advanceTimersByTimeAsync(30000);
    await vi.waitFor(() => expect(harness.spawn).toHaveBeenCalledTimes(1));
    expect(harness.spawn).toHaveBeenCalledTimes(1);
    harness.child.emit('close', 0, null);
    await vi.advanceTimersByTimeAsync(30000);
    await vi.waitFor(() => expect(harness.planDirtyOverlay).toHaveBeenCalledTimes(4));
    expect(harness.spawn).toHaveBeenCalledTimes(1);
    command.stop();
  });

  it('reconciles a save to an already dirty file once after an overlay build', async () => {
    vi.useFakeTimers();
    const harness = makeHarness({ initiallyDirty: true });
    const command = await harness.start();
    await vi.waitFor(() => expect(harness.spawn).toHaveBeenCalledTimes(1));
    expect(harness.spawn).toHaveBeenCalledTimes(1);

    fs.appendFileSync(path.join(harness.repoPath, 'src/dirty.ts'), ' changed');
    harness.child.emit('close', 0, null);
    await vi.advanceTimersByTimeAsync(30000);
    await vi.waitFor(() => expect(harness.spawn).toHaveBeenCalledTimes(2));
    expect(harness.spawn).toHaveBeenCalledTimes(2);

    harness.child.emit('close', 0, null);
    const plansBefore = harness.planDirtyOverlay.mock.calls.length;
    await vi.waitFor(async () => {
      await vi.advanceTimersByTimeAsync(30000);
      expect(harness.planDirtyOverlay.mock.calls.length).toBeGreaterThanOrEqual(plansBefore + 2);
    });
    expect(harness.spawn).toHaveBeenCalledTimes(2);
    command.stop();
  });

  it('does not refresh an unchanged covered file during reconciliation', async () => {
    vi.useFakeTimers();
    const harness = makeHarness({ initiallyDirty: true });
    const command = await harness.start();
    await vi.waitFor(() => expect(harness.spawn).toHaveBeenCalledTimes(1));
    harness.child.emit('close', 0, null);
    const plansBefore = harness.planDirtyOverlay.mock.calls.length;
    await vi.waitFor(async () => {
      await vi.advanceTimersByTimeAsync(30000);
      expect(harness.planDirtyOverlay.mock.calls.length).toBeGreaterThanOrEqual(plansBefore + 2);
    });

    expect(harness.spawn).toHaveBeenCalledTimes(1);
    command.stop();
  });

  it('does not build or watch with a live lease', async () => {
    const harness = makeHarness({ initiallyDirty: true });
    fs.writeFileSync(
      harness.leasePath,
      JSON.stringify({ pid: process.pid, heartbeat: Date.now() }),
    );
    const command = await harness.start();
    harness.emit('src/file.ts');
    expect(harness.spawn).not.toHaveBeenCalled();
    expect(harness.planDirtyOverlay).not.toHaveBeenCalled();
    expect(command.owned).toBe(false);
    expect(harness.child.kill).not.toHaveBeenCalled();
    expect(harness.log).toHaveBeenCalledWith(expect.stringContaining('another watcher'));
    command.stop();
    expect(fs.existsSync(harness.leasePath)).toBe(true);
  });

  it('takes over a stale lease and removes its own lease on stop', async () => {
    const harness = makeHarness();
    fs.writeFileSync(
      harness.leasePath,
      JSON.stringify({ pid: process.pid, heartbeat: Date.now() - 90001 }),
    );
    const command = await harness.start();
    expect(JSON.parse(fs.readFileSync(harness.leasePath, 'utf8')).pid).toBe(process.pid);
    command.stop();
    expect(fs.existsSync(harness.leasePath)).toBe(false);
  });

  it('preserves a replacement owner lease on stop', async () => {
    const harness = makeHarness();
    const command = await harness.start();
    fs.writeFileSync(harness.leasePath, JSON.stringify({ pid: 123456, heartbeat: Date.now() }));
    command.stop();
    expect(JSON.parse(fs.readFileSync(harness.leasePath, 'utf8')).pid).toBe(123456);
  });

  it('coalesces a burst of saves into one child analyze', async () => {
    vi.useFakeTimers();
    const harness = makeHarness();
    const command = await harness.start();
    for (let i = 0; i < 10; i++) harness.emit(`src/file-${i}.ts`);
    await vi.advanceTimersByTimeAsync(100);

    expect(harness.spawn).toHaveBeenCalledTimes(1);
    expect(harness.spawn).toHaveBeenCalledWith(
      process.execPath,
      ['/cli/index.js', 'analyze', '--dirty-overlay', harness.repoPath],
      expect.objectContaining({
        cwd: harness.repoPath,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { PATH: '/bin', HF_HOME: '/models' },
      }),
    );
    command.stop();
  });

  it('queues at most one follow-up when files change during a child run', async () => {
    vi.useFakeTimers();
    const harness = makeHarness();
    const command = await harness.start();
    harness.emit('src/one.ts');
    await vi.advanceTimersByTimeAsync(100);
    harness.emit('src/two.ts');
    harness.emit('src/three.ts');
    await vi.advanceTimersByTimeAsync(100);
    expect(harness.spawn).toHaveBeenCalledTimes(1);

    harness.child.emit('close', 0, null);
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.spawn).toHaveBeenCalledTimes(2);
    command.stop();
  });

  it('skips and logs refresh while the analyze lock is held', async () => {
    vi.useFakeTimers();
    const harness = makeHarness({ lockHeld: true });
    const command = await harness.start();
    harness.emit('src/file.ts');
    await vi.advanceTimersByTimeAsync(100);

    expect(harness.spawn).not.toHaveBeenCalled();
    expect(harness.log).toHaveBeenCalledWith(expect.stringContaining('analyze.lock is held'));
    command.stop();
  });

  it('refreshes dirty startup after lock release without another save', async () => {
    vi.useFakeTimers();
    const options = { initiallyDirty: true, lockHeld: true };
    const harness = makeHarness(options);
    const command = await harness.start();
    await vi.advanceTimersByTimeAsync(300);
    expect(harness.spawn).not.toHaveBeenCalled();
    options.lockHeld = false;
    await vi.advanceTimersByTimeAsync(100);
    await vi.waitFor(() => expect(harness.spawn).toHaveBeenCalledTimes(1));
    expect(harness.spawn).toHaveBeenCalledTimes(1);
    command.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retains saves during the startup child as one follow-up', async () => {
    vi.useFakeTimers();
    const harness = makeHarness({ initiallyDirty: true });
    const command = await harness.start();
    await vi.waitFor(() => expect(harness.spawn).toHaveBeenCalledTimes(1));
    expect(harness.spawn).toHaveBeenCalledTimes(1);
    harness.emit('src/one.ts');
    harness.emit('src/two.ts');
    await vi.advanceTimersByTimeAsync(100);
    expect(harness.spawn).toHaveBeenCalledTimes(1);
    harness.child.emit('close', 0, null);
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(harness.spawn).toHaveBeenCalledTimes(2));
    expect(harness.spawn).toHaveBeenCalledTimes(2);
    command.stop();
  });

  it('logs child failure and keeps later saves within retry backoff', async () => {
    vi.useFakeTimers();
    const harness = makeHarness();
    const command = await harness.start();
    harness.emit('src/first.ts');
    await vi.advanceTimersByTimeAsync(100);
    harness.child.emit('close', 1, null);
    await vi.advanceTimersByTimeAsync(0);

    expect(harness.error).toHaveBeenCalledWith(expect.stringContaining('failed with code 1'));
    harness.emit('src/second.ts');
    await vi.advanceTimersByTimeAsync(100);
    expect(harness.spawn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(900);
    expect(harness.spawn).toHaveBeenCalledTimes(2);
    command.stop();
  });

  it('kills a running child when stopped', async () => {
    vi.useFakeTimers();
    const harness = makeHarness({ initiallyDirty: true });
    const command = await harness.start();
    await vi.waitFor(() => expect(harness.spawn).toHaveBeenCalledTimes(1));
    expect(harness.spawn).toHaveBeenCalledTimes(1);

    command.stop();
    expect(harness.child.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('routes automatic refreshes through the callback and retries failures with capped backoff', async () => {
    vi.useFakeTimers();
    const harness = makeHarness({ head: 'next', commit: 'old' });
    const callback = vi
      .fn()
      .mockRejectedValueOnce(new Error('one'))
      .mockRejectedValueOnce(new Error('two'))
      .mockResolvedValue(undefined);
    const command = await harness.start({ refreshCallback: callback, retryDelaysMs: [10, 20] });
    expect(callback).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(9);
    expect(callback).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(callback).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(19);
    expect(callback).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(callback).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(60000);
    expect(callback).toHaveBeenCalledTimes(3);
    expect(harness.spawn).not.toHaveBeenCalled();
    await command.stop();
  });

  it('bounds automatic callback retries and rearms after dirty content changes', async () => {
    vi.useFakeTimers();
    const harness = makeHarness({ initiallyDirty: true });
    const callback = vi.fn().mockRejectedValue(new Error('persistent failure'));
    const command = await harness.start({
      refreshCallback: callback,
      retryDelaysMs: [1000],
      maxRetryAttempts: 2,
    });
    try {
      await vi.waitFor(() => expect(callback).toHaveBeenCalledTimes(1));
      for (let attempt = 0; attempt < 3; attempt++) {
        await vi.waitFor(() => expect(callback).toHaveBeenCalledTimes(attempt + 1));
        harness.emit('src/dirty.ts');
        await vi.advanceTimersByTimeAsync(100);
        expect(callback).toHaveBeenCalledTimes(attempt + 1);
        await vi.advanceTimersByTimeAsync(900);
      }
      await vi.advanceTimersByTimeAsync(90000);
      expect(callback).toHaveBeenCalledTimes(3);
      const exhausted = 'Watch retries exhausted after 2 attempts; waiting for repository changes';
      expect(harness.error.mock.calls.filter(([message]) => message === exhausted)).toHaveLength(1);
      fs.writeFileSync(path.join(harness.repoPath, 'src/dirty.ts'), 'changed content');
      await vi.advanceTimersByTimeAsync(30000);
      await vi.waitFor(() => expect(callback).toHaveBeenCalledTimes(6), { timeout: 5000 });
      expect(harness.error.mock.calls.filter(([message]) => message === exhausted)).toHaveLength(2);
      expect(harness.spawn).not.toHaveBeenCalled();
    } finally {
      await command.stop();
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it('runs automatic startup and event refresh without children', async () => {
    vi.useFakeTimers();
    const harness = makeHarness({ initiallyDirty: true });
    const callback = vi.fn(async () => {});
    const command = await harness.start({ refreshCallback: callback });
    await vi.waitFor(() => expect(callback).toHaveBeenCalledWith('startup'));
    harness.emit('src/dirty.ts');
    await vi.advanceTimersByTimeAsync(100);
    await vi.waitFor(() => expect(callback).toHaveBeenCalledWith('event'));
    expect(harness.spawn).not.toHaveBeenCalled();
    await command.stop();
  });

  it('keeps the lease until an in-flight automatic refresh settles', async () => {
    const harness = makeHarness({ initiallyDirty: true });
    let finish!: () => void;
    const callback = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const command = await harness.start({ refreshCallback: callback });
    await vi.waitFor(() => expect(callback).toHaveBeenCalledTimes(1));
    let stopped = false;
    const stopping = command.stop().then(() => {
      stopped = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(stopped).toBe(false);
    expect(fs.existsSync(harness.leasePath)).toBe(true);
    finish();
    await stopping;
    expect(fs.existsSync(harness.leasePath)).toBe(false);
  });

  it('rejects cleanup when child exit cannot be proven', async () => {
    vi.useFakeTimers();
    const harness = makeHarness({ initiallyDirty: true });
    harness.child.kill.mockImplementation(() => true);
    const command = await harness.start();
    await vi.waitFor(() => expect(harness.spawn).toHaveBeenCalledTimes(1));
    const stopped = command.stop();
    const rejected = expect(stopped).rejects.toThrow('cleanup failure');
    await vi.advanceTimersByTimeAsync(5000);
    await rejected;
    expect(fs.existsSync(harness.leasePath)).toBe(true);
  });

  it('preserves a replacement token with the same PID', async () => {
    const harness = makeHarness();
    const command = await harness.start();
    fs.writeFileSync(
      harness.leasePath,
      JSON.stringify({ pid: process.pid, token: 'replacement', heartbeat: Date.now() }),
    );
    await command.stop();
    expect(JSON.parse(fs.readFileSync(harness.leasePath, 'utf8')).token).toBe('replacement');
  });

  it('awaits child exit, escalates and returns the same stop promise', async () => {
    vi.useFakeTimers();
    const harness = makeHarness({ initiallyDirty: true });
    harness.child.kill.mockImplementation(() => true);
    const command = await harness.start();
    await vi.waitFor(() => expect(harness.spawn).toHaveBeenCalledTimes(1));
    const stopped = command.stop();
    expect(command.stop()).toBe(stopped);
    expect(fs.existsSync(harness.leasePath)).toBe(true);
    await vi.advanceTimersByTimeAsync(2000);
    expect(harness.child.kill).toHaveBeenLastCalledWith('SIGKILL');
    harness.child.emit('exit', 0, null);
    await stopped;
    expect(fs.existsSync(harness.leasePath)).toBe(false);
  });

  it('registers watch in CLI help', () => {
    const cliEntry = path.join(repoRoot, 'src/cli/index.ts');
    const result = spawnSync(process.execPath, ['--import', 'tsx', cliEntry, 'watch', '--help'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('watch [options] [path]');
  });

  it('logs one clean-tree startup line with the watched root and debounce', async () => {
    const harness = makeHarness();
    const command = await harness.start();

    expect(harness.log).toHaveBeenCalledTimes(1);
    expect(harness.log).toHaveBeenCalledWith(
      `Watching ${harness.repoPath} (debounce 750 ms); tree is clean`,
    );
    command.stop();
  });

  it('logs the dirty source count before starting the initial overlay build', async () => {
    const harness = makeHarness({ initiallyDirty: true });
    const command = await harness.start();
    await vi.waitFor(() => expect(harness.spawn).toHaveBeenCalledTimes(1));

    expect(harness.log).toHaveBeenNthCalledWith(
      1,
      `Watching ${harness.repoPath} (debounce 750 ms); 1 dirty source path(s), covering 1 file(s) and leaving 0 uncovered`,
    );
    expect(harness.spawn).toHaveBeenCalledTimes(1);
    command.stop();
  });

  it('logs unknown dirty state and still starts the watcher when planning rejects', async () => {
    const harness = makeHarness();
    harness.planDirtyOverlay.mockRejectedValueOnce(new Error('git unavailable'));
    const command = await harness.start();

    expect(harness.log).toHaveBeenCalledWith(
      `Watching ${harness.repoPath} (debounce 750 ms); dirty state unknown`,
    );
    expect(harness.error).toHaveBeenCalledWith(
      'Initial watch overlay planning failed: git unavailable',
    );
    expect(harness.spawn).not.toHaveBeenCalled();
    command.stop();
  });

  it('builds the covered subset and reports uncovered paths for an over-limit dirty tree', async () => {
    const harness = makeHarness();
    harness.planDirtyOverlay.mockResolvedValueOnce({
      includePaths: ['src/covered.ts'],
      uncoveredPaths: ['src/uncovered.ts'],
      allDirtyPaths: ['src/covered.ts', 'src/uncovered.ts'],
      tombstones: [],
      tooMany: true,
      skipped: [],
    });
    const command = await harness.start();

    expect(harness.log).toHaveBeenCalledWith(
      `Watching ${harness.repoPath} (debounce 750 ms); 2 dirty source path(s), covering 1 file(s) and leaving 1 uncovered`,
    );
    expect(harness.spawn).toHaveBeenCalledTimes(1);
    command.stop();
  });

  it('does not log again while idle', async () => {
    vi.useFakeTimers();
    const harness = makeHarness();
    const command = await harness.start();
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);

    expect(harness.log).toHaveBeenCalledTimes(1);
    command.stop();
  });
});
