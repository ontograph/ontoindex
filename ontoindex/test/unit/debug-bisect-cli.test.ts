import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', () => ({
  spawn: spawnMock,
}));

const { collectCandidateDirs, debugBisectCommand } = await import('../../src/cli/debug-bisect.js');

interface MockChild extends EventEmitter {
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
}

function createMockChild(result?: {
  code?: number | null;
  signal?: NodeJS.Signals | null;
}): MockChild {
  const child = new EventEmitter() as MockChild;
  child.stderr = new EventEmitter();
  child.kill = vi.fn(() => {
    child.emit('close', null, 'SIGTERM');
    return true;
  });

  if (result) {
    queueMicrotask(() => child.emit('close', result.code ?? 0, result.signal ?? null));
  }

  return child;
}

async function makeTempDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'gn-debug-bisect-'));
}

describe('debug-bisect CLI helper', () => {
  let tmpDir: string;
  let originalExitCode: string | number | undefined;
  let originalMaxWorkers: string | undefined;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    tmpDir = await makeTempDir();
    originalExitCode = process.exitCode;
    originalMaxWorkers = process.env.ONTOINDEX_MAX_WORKERS;
    process.exitCode = undefined;
    delete process.env.ONTOINDEX_MAX_WORKERS;
    spawnMock.mockReset();
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.useRealTimers();
    process.exitCode = originalExitCode;
    if (originalMaxWorkers === undefined) {
      delete process.env.ONTOINDEX_MAX_WORKERS;
    } else {
      process.env.ONTOINDEX_MAX_WORKERS = originalMaxWorkers;
    }
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('collects child dirs with include and extension filters', async () => {
    await fs.mkdir(path.join(tmpDir, 'packages', 'api'), { recursive: true });
    await fs.mkdir(path.join(tmpDir, 'packages', 'web'), { recursive: true });
    await fs.mkdir(path.join(tmpDir, 'node_modules', 'ignored'), { recursive: true });
    await fs.writeFile(path.join(tmpDir, 'packages', 'api', 'index.ts'), 'export const x = 1;');
    await fs.writeFile(path.join(tmpDir, 'packages', 'web', 'index.md'), '# web');

    const candidates = await collectCandidateDirs(tmpDir, {
      root: tmpDir,
      depthRemaining: 2,
      includes: ['packages'],
      extensions: new Set(['.ts']),
    });

    expect(candidates).toEqual([path.join(tmpDir, 'packages')]);
  });

  it('spawns bounded analyze runs with safe flags and worker default', async () => {
    await fs.mkdir(path.join(tmpDir, 'a'));
    spawnMock.mockImplementation(() => createMockChild({ code: 0 }));

    await debugBisectCommand(tmpDir, { timeout: '5000', maxDepth: '1', namePrefix: 'bisect-' });

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [command, args, options] = spawnMock.mock.calls[0];
    expect(command).toBe(process.execPath);
    expect(args).toContain('analyze');
    expect(args).toContain(path.join(tmpDir, 'a'));
    expect(args).toEqual(
      expect.arrayContaining([
        '--skip-git',
        '--skip-agents-md',
        '--no-stats',
        '--name',
        'bisect-a',
      ]),
    );
    expect(options.cwd).toBe(path.join(tmpDir, 'a'));
    expect(options.env.ONTOINDEX_MAX_WORKERS).toBe('2');
    expect(process.exitCode).toBeUndefined();
  });

  it('stops at a failing child and descends within the configured depth', async () => {
    await fs.mkdir(path.join(tmpDir, 'a', 'nested'), { recursive: true });
    await fs.mkdir(path.join(tmpDir, 'b'));
    spawnMock
      .mockImplementationOnce(() => createMockChild({ code: 1 }))
      .mockImplementationOnce(() => createMockChild({ code: 1 }));

    await debugBisectCommand(tmpDir, { timeout: '5000', maxDepth: '2' });

    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(spawnMock.mock.calls[0][1]).toContain(path.join(tmpDir, 'a'));
    expect(spawnMock.mock.calls[1][1]).toContain(path.join(tmpDir, 'a', 'nested'));
    expect(spawnMock.mock.calls.flat().join(' ')).not.toContain(path.join(tmpDir, 'b'));
    expect(consoleLogSpy).toHaveBeenCalledWith(
      `Smallest failing path found within bounds: ${path.join(tmpDir, 'a', 'nested')}`,
    );
    expect(process.exitCode).toBe(1);
  });

  it('treats timed out child analyzes as failures', async () => {
    await fs.mkdir(path.join(tmpDir, 'slow'));
    const child = createMockChild();
    spawnMock.mockReturnValue(child);

    await debugBisectCommand(tmpDir, { timeout: '1', maxDepth: '1' });

    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(consoleLogSpy.mock.calls.some((call) => String(call[0]).includes('timed out'))).toBe(
      true,
    );
    expect(process.exitCode).toBe(1);
  });
});
