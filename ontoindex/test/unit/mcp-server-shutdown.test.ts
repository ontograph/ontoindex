import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Regression: signal handlers must not receive the signal name as the
 * process.exit() code. Node invokes handlers with the signal string, and
 * process.exit('SIGINT') throws ERR_INVALID_ARG_TYPE, aborting shutdown
 * before backend.dispose() and server.close() finish.
 */
describe('MCP server graceful shutdown', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock('@modelcontextprotocol/sdk/server/stdio.js');
  });

  it('exits with a numeric code when a signal handler fires', async () => {
    vi.resetModules();
    vi.doMock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
      StdioServerTransport: class {
        async start(): Promise<void> {}
        async close(): Promise<void> {}
        async send(): Promise<void> {}
      },
    }));

    const { startMCPServer } = await import('../../src/mcp/server.js');

    const dispose = vi.fn(async () => undefined);
    const backend = {
      callTool: vi.fn(),
      resolveRepo: vi.fn(),
      ensureRepoInitialized: vi.fn(),
      dispose,
    };

    const signalHandlers = new Map<string, (...args: unknown[]) => void>();
    const onSpy = vi.spyOn(process, 'on').mockImplementation(((
      event: string,
      handler: (...args: unknown[]) => void,
    ) => {
      if (event === 'SIGINT' || event === 'SIGTERM') signalHandlers.set(event, handler);
      return process;
    }) as typeof process.on);
    vi.spyOn(process.stdin, 'on').mockReturnValue(process.stdin);
    vi.spyOn(process.stdout, 'on').mockReturnValue(process.stdout);

    const exitCodes: unknown[] = [];
    vi.spyOn(process, 'exit').mockImplementation(((code?: unknown) => {
      exitCodes.push(code);
      return undefined as never;
    }) as typeof process.exit);

    await startMCPServer(backend as never);
    onSpy.mockRestore();

    const sigint = signalHandlers.get('SIGINT');
    expect(sigint).toBeDefined();

    // Node passes the signal name as the first argument.
    sigint?.('SIGINT', 2);
    await vi.waitFor(() => expect(exitCodes).toHaveLength(1));

    expect(dispose).toHaveBeenCalledTimes(1);
    expect(exitCodes[0]).toBe(0);
  });
});
