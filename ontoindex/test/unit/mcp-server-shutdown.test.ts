import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createMCPServer } from '../../src/mcp/server.js';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);
const tsxImportUrl = pathToFileURL(
  path.join(path.dirname(require.resolve('tsx/package.json')), 'dist/loader.mjs'),
).href;

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

  // Regression for the EPIPE loop after the client closes stderr. The stdin-end case fails
  // deterministically without the stderr error listener; the SIGTERM case depends on whether
  // the shutdown log write sees EPIPE before exit, so it is kept as a timing-dependent check.
  it.each(['SIGTERM', 'stdin end'])(
    'exits after %s when the client closes stderr',
    async (shutdownMethod) => {
      const child = spawn(
        process.execPath,
        [
          '--import',
          tsxImportUrl,
          path.join(packageRoot, 'test/fixtures/mcp-stdio-cancellation-server.ts'),
        ],
        { cwd: packageRoot, stdio: ['pipe', 'pipe', 'pipe'] },
      );
      let stderr = '';
      let stdout = '';
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        stderr += chunk;
      });
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        stdout += chunk;
      });

      try {
        child.stdin.write(
          '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}\n',
        );
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error(`Timed out waiting for initialize; stderr: ${stderr}`)),
            10_000,
          );
          child.stdout.on('data', () => {
            if (stdout.includes('"id":1')) {
              clearTimeout(timer);
              resolve();
            }
          });
          child.once('error', (error) => {
            clearTimeout(timer);
            reject(error);
          });
          child.once('exit', (code, signal) => {
            clearTimeout(timer);
            reject(
              new Error(`Child exited before initialize (${code ?? signal}); stderr: ${stderr}`),
            );
          });
        });

        child.stderr.destroy();
        if (shutdownMethod === 'SIGTERM') child.kill('SIGTERM');
        else child.stdin.end();

        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            child.kill('SIGKILL');
            reject(new Error(`Child did not exit within 10 seconds; stderr: ${stderr}`));
          }, 10_000);
          child.once('exit', () => {
            clearTimeout(timer);
            resolve();
          });
        });
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }
    },
    30_000,
  );

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
    vi.spyOn(process.stderr, 'on').mockReturnValue(process.stderr);

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
      vi.spyOn(process.stderr, 'on').mockReturnValue(process.stderr);
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
      expect(backend.dispose).toHaveBeenCalledTimes(1);
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

  it('disposes builders while close waits for an admitted reader', async () => {
    vi.resetModules();
    let finishRead!: () => void;
    const read = new Promise<void>((resolve) => {
      finishRead = resolve;
    });
    const backend = {
      withOperation: vi.fn(async (callback: () => Promise<unknown>) => callback()),
      callTool: vi.fn(() => read),
      resolveRepo: vi.fn(),
      ensureRepoInitialized: vi.fn(),
      dispose: vi.fn(async () => {
        finishRead();
      }),
    };
    const { startMCPServer } = await import('../../src/mcp/server.js');
    const { Server: ActiveServer } = await import('@modelcontextprotocol/sdk/server/index.js');
    const handlerSpy = vi.spyOn(ActiveServer.prototype, 'setRequestHandler');
    let shutdown!: () => void;
    vi.spyOn(process, 'on').mockImplementation(((event: string, handler: () => void) => {
      if (event === 'SIGTERM') shutdown = handler;
      return process;
    }) as typeof process.on);
    vi.spyOn(process.stdin, 'on').mockReturnValue(process.stdin);
    vi.spyOn(process.stdout, 'on').mockReturnValue(process.stdout);
    vi.spyOn(process.stderr, 'on').mockReturnValue(process.stderr);
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    await startMCPServer(backend as never);
    const handler = handlerSpy.mock.calls.find(
      ([schema]) => schema === CallToolRequestSchema,
    )?.[1] as (request: any) => Promise<unknown>;
    const request = handler({ params: { name: 'example', arguments: {} } });
    await vi.waitFor(() => expect(backend.callTool).toHaveBeenCalledTimes(1));

    shutdown();
    shutdown();
    await expect(handler({ params: { name: 'late', arguments: {} } })).rejects.toThrow(
      'Server is closing.',
    );
    await request;
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    expect(backend.dispose).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it.each(['close', 'dispose', 'timeout'])(
    'reports %s failure and exits nonzero',
    async (failure) => {
      vi.resetModules();
      vi.useFakeTimers();
      const { startMCPServer, getMcpShutdownGraceMs } = await import('../../src/mcp/server.js');
      const { Server: ActiveServer } = await import('@modelcontextprotocol/sdk/server/index.js');
      const close = vi.spyOn(ActiveServer.prototype, 'close').mockImplementation(() => {
        if (failure === 'close') throw new Error('close failed');
        return failure === 'timeout' ? new Promise<void>(() => {}) : Promise.resolve();
      });
      const dispose = vi.fn(() => {
        if (failure === 'dispose') throw new Error('dispose failed');
        return Promise.resolve();
      });
      let shutdown!: () => void;
      vi.spyOn(process, 'on').mockImplementation(((event: string, handler: () => void) => {
        if (event === 'SIGTERM') shutdown = handler;
        return process;
      }) as typeof process.on);
      vi.spyOn(process.stdin, 'on').mockReturnValue(process.stdin);
      vi.spyOn(process.stdout, 'on').mockReturnValue(process.stdout);
      vi.spyOn(process.stderr, 'on').mockReturnValue(process.stderr);
      const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
      await startMCPServer({ dispose } as never);

      shutdown();
      shutdown();
      await vi.advanceTimersByTimeAsync(getMcpShutdownGraceMs());
      expect(close).toHaveBeenCalledTimes(1);
      expect(dispose).toHaveBeenCalledTimes(1);
      expect(exit).toHaveBeenCalledExactlyOnceWith(1);
      expect(stderr.mock.calls.map(([message]) => String(message)).join('')).toContain(
        failure === 'timeout'
          ? 'shutdown grace expired'
          : `${failure === 'close' ? 'server close' : 'backend disposal'} failed`,
      );
    },
  );

  it('stops admission and awaits admitted work across repeated close calls', async () => {
    let resolveOperation!: () => void;
    const operation = new Promise<void>((resolve) => {
      resolveOperation = resolve;
    });
    const backend = {
      withOperation: vi.fn(
        async (callback: () => Promise<unknown>, _options?: { signal?: AbortSignal }) => callback(),
      ),
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
    const controller = new AbortController();
    const request = handler!(
      { params: { name: 'example', arguments: {} } },
      { signal: controller.signal },
    );
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
    expect(backend.withOperation).toHaveBeenCalledWith(expect.any(Function), {
      signal: controller.signal,
    });
    controller.abort();
    expect(backend.withOperation.mock.calls[0][1]?.signal?.aborted).toBe(true);
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
