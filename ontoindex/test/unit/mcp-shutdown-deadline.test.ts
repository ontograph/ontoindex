import { afterEach, describe, expect, it, vi } from 'vitest';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { getMcpShutdownGraceMs, startMCPServer, withShutdownGrace } from '../../src/mcp/server.js';

const listeners: Array<[NodeJS.EventEmitter, string, (...args: any[]) => void]> = [];

afterEach(() => {
  for (const [emitter, event, listener] of listeners.splice(0))
    emitter.removeListener(event, listener);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
  vi.doUnmock('../../src/mcp/local/local-backend.js');
  vi.doUnmock('../../src/storage/git.js');
});

async function harness(dispose = vi.fn().mockResolvedValue(undefined)) {
  vi.useFakeTimers();
  vi.stubEnv('ONTOINDEX_MCP_SHUTDOWN_GRACE_MS', '100');
  vi.spyOn(Server.prototype, 'connect').mockResolvedValue(undefined);
  vi.spyOn(Server.prototype, 'close').mockResolvedValue(undefined);
  const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
  const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  for (const emitter of [process, process.stdin, process.stdout]) {
    const on = emitter.on.bind(emitter);
    vi.spyOn(emitter, 'on').mockImplementation(((
      event: string,
      listener: (...args: any[]) => void,
    ) => {
      listeners.push([emitter, event, listener]);
      return on(event, listener);
    }) as any);
  }
  await startMCPServer({ dispose } as any);
  return { exit, stderr, dispose };
}

describe('MCP shutdown deadline', () => {
  it.each([
    ['', 5000],
    ['bad', 5000],
    ['99', 5000],
    ['60001', 5000],
    ['100', 100],
    ['60000', 60000],
  ])('bounds the grace setting %s', (value, expected) => {
    vi.stubEnv('ONTOINDEX_MCP_SHUTDOWN_GRACE_MS', value);
    expect(getMcpShutdownGraceMs()).toBe(expected);
  });

  it('exits after the grace period when stdin ends and disposal hangs', async () => {
    const { exit, stderr } = await harness(vi.fn(() => new Promise<void>(() => {})));
    process.stdin.emit('end');
    await vi.advanceTimersByTimeAsync(100);
    expect(exit).toHaveBeenCalledWith(0);
    expect(stderr).toHaveBeenCalledWith('[ontoindex:mcp] shutdown grace expired; forcing exit\n');
  });

  it('clears the timer after normal cleanup', async () => {
    const { exit, stderr } = await harness();
    process.stdin.emit('end');
    await vi.advanceTimersByTimeAsync(0);
    expect(exit).toHaveBeenCalledWith(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(stderr).not.toHaveBeenCalled();
  });

  it('a repeated signal waits for the same grace deadline', async () => {
    const { exit } = await harness(vi.fn(() => new Promise<void>(() => {})));
    process.emit('SIGTERM');
    await vi.advanceTimersByTimeAsync(0);
    process.emit('SIGTERM');
    await vi.advanceTimersByTimeAsync(0);
    expect(exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5000);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('bounds startup timeout cleanup even when disposal hangs', async () => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.stubEnv('ONTOINDEX_MCP_STARTUP_TIMEOUT_MS', '10');
    vi.stubEnv('ONTOINDEX_MCP_SHUTDOWN_GRACE_MS', '100');
    vi.doMock('../../src/mcp/local/local-backend.js', () => ({
      LocalBackend: class {
        init() {
          return new Promise<boolean>(() => {});
        }
        dispose() {
          return new Promise<void>(() => {});
        }
      },
    }));
    vi.doMock('../../src/storage/git.js', () => ({ getGitRoot: () => null }));
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const previousExitCode = process.exitCode;
    try {
      const { mcpCommand } = await import('../../src/cli/mcp.js');
      const command = mcpCommand();
      await vi.advanceTimersByTimeAsync(110);
      await command;
      expect(exit).toHaveBeenCalledWith(1);
      expect(error).toHaveBeenCalledWith(expect.stringContaining('startup timed out after 10ms'));
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  it('clears the shared grace timer when cleanup rejects', async () => {
    vi.useFakeTimers();
    await expect(withShutdownGrace(Promise.reject(new Error('cleanup')), 100)).rejects.toThrow(
      'cleanup',
    );
    expect(vi.getTimerCount()).toBe(0);
  });
});
