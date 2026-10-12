import { afterEach, describe, expect, it, vi } from 'vitest';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createMCPServer } from '../../src/mcp/server.js';

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

  it('stops admission and awaits admitted work across repeated close calls', async () => {
    let resolveOperation!: () => void;
    const operation = new Promise<void>((resolve) => {
      resolveOperation = resolve;
    });
    const backend = {
      withOperation: vi.fn(async (callback: () => Promise<unknown>) => callback()),
      callTool: vi.fn(async () => operation),
      resolveRepo: vi.fn(),
      ensureRepoInitialized: vi.fn(),
      dispose: vi.fn(async () => undefined),
    };
    const handlerSpy = vi.spyOn(Server.prototype, 'setRequestHandler');
    const server = createMCPServer(backend as any);
    const handler = handlerSpy.mock.calls.find(
      ([schema]) => schema === CallToolRequestSchema,
    )?.[1] as ((request: any, extra?: unknown) => Promise<any>) | undefined;

    expect(handler).toBeDefined();
    const request = handler!({ params: { name: 'example', arguments: {} } }, { signal: 'kept' });
    const firstClose = server.close();
    const secondClose = server.close();
    let closed = false;
    void firstClose.then(() => {
      closed = true;
    });

    await expect(handler!({ params: { name: 'late', arguments: {} } })).rejects.toThrow(
      'Server is closing.',
    );
    await Promise.resolve();
    expect(closed).toBe(false);
    expect(server.close()).toBe(firstClose);

    resolveOperation();
    await expect(request).resolves.toMatchObject({ content: [{ type: 'text' }] });
    await Promise.all([firstClose, secondClose]);
    expect(closed).toBe(true);
    expect(backend.callTool).toHaveBeenCalledTimes(1);
    expect(backend.dispose).not.toHaveBeenCalled();
  });

  it('finishes close when an admitted operation rejects', async () => {
    let rejectOperation!: (error: Error) => void;
    const operation = new Promise<unknown>((_resolve, reject) => {
      rejectOperation = reject;
    });
    const backend = {
      withOperation: vi.fn(() => operation),
      callTool: vi.fn(),
      resolveRepo: vi.fn(),
      ensureRepoInitialized: vi.fn(),
    };
    const handlerSpy = vi.spyOn(Server.prototype, 'setRequestHandler');
    const server = createMCPServer(backend as any);
    const handler = handlerSpy.mock.calls.find(
      ([schema]) => schema === CallToolRequestSchema,
    )?.[1] as ((request: any, extra?: unknown) => Promise<any>) | undefined;
    const request = handler!({ params: { name: 'example', arguments: {} } });
    const closing = server.close();

    rejectOperation(new Error('operation failed'));
    await expect(request).rejects.toThrow('operation failed');
    await expect(closing).resolves.toBeUndefined();
    expect(backend.callTool).not.toHaveBeenCalled();
  });
});
