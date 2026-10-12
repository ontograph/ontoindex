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
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.doUnmock('@modelcontextprotocol/sdk/server/stdio.js');
    vi.doUnmock('../../src/mcp/local/local-backend.js');
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

  it.each([false, true])(
    'CLI fatal shutdown waits past 100ms for close and disposal (signal first: %s)',
    async (signalFirst) => {
      vi.resetModules();
      vi.useFakeTimers();
      let finishClose!: () => void;
      const closing = new Promise<void>((resolve) => {
        finishClose = resolve;
      });
      let finishDispose!: () => void;
      const disposing = new Promise<void>((resolve) => {
        finishDispose = resolve;
      });
      const backend = {
        init: vi.fn().mockResolvedValue(false),
        listRepos: vi.fn().mockResolvedValue([]),
        dispose: vi.fn(() => disposing),
      };
      vi.doMock('../../src/mcp/local/local-backend.js', () => ({
        LocalBackend: vi.fn(function () {
          return backend;
        }),
      }));
      const { mcpCommand } = await import('../../src/cli/mcp.js');
      const { Server: ActiveServer } = await import('@modelcontextprotocol/sdk/server/index.js');
      const close = vi.spyOn(ActiveServer.prototype, 'close').mockImplementation(() => closing);
      const handlers = new Map<string, Array<(...args: any[]) => unknown>>();
      vi.spyOn(process, 'on').mockImplementation(((
        event: string,
        handler: (...args: any[]) => unknown,
      ) => {
        const listeners = handlers.get(event) ?? [];
        listeners.push(handler);
        handlers.set(event, listeners);
        return process;
      }) as typeof process.on);
      vi.spyOn(process.stdin, 'on').mockReturnValue(process.stdin);
      vi.spyOn(process.stdout, 'on').mockReturnValue(process.stdout);
      vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

      await mcpCommand({ repo: '', project: process.cwd() });
      const emit = (event: string, ...args: any[]) => {
        for (const handler of handlers.get(event) ?? []) handler(...args);
      };

      if (signalFirst) emit('SIGTERM', 'SIGTERM');
      else emit('uncaughtException', new Error('fatal during operation'));
      emit('SIGINT', 'SIGINT');
      await vi.advanceTimersByTimeAsync(150);
      expect(close).toHaveBeenCalledTimes(1);
      expect(backend.dispose).not.toHaveBeenCalled();
      expect(exit).not.toHaveBeenCalled();

      finishClose();
      await vi.advanceTimersByTimeAsync(0);
      expect(backend.dispose).toHaveBeenCalledTimes(1);
      emit('uncaughtException', new Error('fatal during disposal'));
      emit('SIGTERM', 'SIGTERM');
      await vi.advanceTimersByTimeAsync(150);
      expect(exit).not.toHaveBeenCalled();

      finishDispose();
      await vi.advanceTimersByTimeAsync(0);
      expect(handlers.get('uncaughtException')).toHaveLength(1);
      expect(handlers.get('unhandledRejection')).toHaveLength(1);
      expect(close).toHaveBeenCalledTimes(1);
      expect(backend.dispose).toHaveBeenCalledTimes(1);
      expect(exit).toHaveBeenCalledTimes(1);
      expect(exit).toHaveBeenCalledWith(1);
    },
  );

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
