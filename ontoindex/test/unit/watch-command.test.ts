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

function makeHarness(options: { initiallyDirty?: boolean; lockHeld?: boolean } = {}) {
  let emit: ((filename: string) => void) | undefined;
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn();

  const spawn = vi.fn(() => child as never);
  const log = vi.fn();
  const error = vi.fn();
  const onSignal = vi.fn();
  const offSignal = vi.fn();
  const planDirtyOverlay = vi.fn(async () => ({
    includePaths: options.initiallyDirty ? ['src/dirty.ts'] : [],
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
    child,
    spawn,
    log,
    error,
    planDirtyOverlay,
    emit(filename: string) {
      emit?.(filename);
    },
    async start() {
      return createWatchCommand('/repo', {
        spawn,
        createWatcher,
        isLockHeld: () => options.lockHeld ?? false,
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
      });
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('watch command', () => {
  it('coalesces a burst of saves into one child analyze', async () => {
    vi.useFakeTimers();
    const harness = makeHarness();
    const command = await harness.start();
    for (let i = 0; i < 10; i++) harness.emit(`src/file-${i}.ts`);
    await vi.advanceTimersByTimeAsync(100);

    expect(harness.spawn).toHaveBeenCalledTimes(1);
    expect(harness.spawn).toHaveBeenCalledWith(
      process.execPath,
      ['/cli/index.js', 'analyze', '--dirty-overlay', '/repo'],
      expect.objectContaining({
        cwd: '/repo',
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

  it('logs child failure and keeps watching for later saves', async () => {
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
    expect(harness.spawn).toHaveBeenCalledTimes(2);
    command.stop();
  });

  it('kills a running child when stopped', async () => {
    vi.useFakeTimers();
    const harness = makeHarness({ initiallyDirty: true });
    const command = await harness.start();
    expect(harness.spawn).toHaveBeenCalledTimes(1);

    command.stop();
    expect(harness.child.kill).toHaveBeenCalledWith('SIGTERM');
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
    expect(harness.log).toHaveBeenCalledWith('Watching /repo (debounce 750 ms); tree is clean');
    command.stop();
  });

  it('logs the dirty source count before starting the initial overlay build', async () => {
    const harness = makeHarness({ initiallyDirty: true });
    const command = await harness.start();

    expect(harness.log).toHaveBeenNthCalledWith(
      1,
      'Watching /repo (debounce 750 ms); 1 dirty source file(s), building overlay',
    );
    expect(harness.spawn).toHaveBeenCalledTimes(1);
    command.stop();
  });

  it('logs unknown dirty state and still starts the watcher when planning rejects', async () => {
    const harness = makeHarness();
    harness.planDirtyOverlay.mockRejectedValueOnce(new Error('git unavailable'));
    const command = await harness.start();

    expect(harness.log).toHaveBeenCalledWith(
      'Watching /repo (debounce 750 ms); dirty state unknown',
    );
    expect(harness.error).toHaveBeenCalledWith(
      'Initial watch overlay planning failed: git unavailable',
    );
    expect(harness.spawn).not.toHaveBeenCalled();
    command.stop();
  });

  it('reports an over-limit dirty tree instead of treating omitted paths as clean', async () => {
    const harness = makeHarness();
    harness.planDirtyOverlay.mockResolvedValueOnce({
      includePaths: [],
      tombstones: [],
      tooMany: true,
      skipped: [],
    });
    const command = await harness.start();

    expect(harness.log).toHaveBeenCalledWith(
      'Watching /repo (debounce 750 ms); tree is dirty; overlay skipped because the source-file limit was exceeded',
    );
    expect(harness.spawn).not.toHaveBeenCalled();
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
