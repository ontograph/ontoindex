/**
 * Unit tests: MCP HTTP diagnostics (D4 slice)
 *
 * Covers:
 * - boundedIncrement cap behavior (counter hard cap)
 * - TTL eviction increments totalEvictions + removes session
 * - Session close (reset) removes session from activeSessions
 * - Per-session requestCount tracking and cap
 * - getDiagnostics snapshot shape and timestamps
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  boundedIncrement,
  MCP_DIAG_MAX_COUNTER,
  mountMCPEndpoints,
  type MCPDiagnosticsSnapshot,
} from '../../src/server/mcp-http.js';

// ─── Mock heavy dependencies ─────────────────────────────────────────────────

vi.mock('../../src/mcp/server.js', () => ({
  createMCPServer: vi.fn(() => ({
    connect: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock('@modelcontextprotocol/sdk/server/streamableHttp.js', async () => {
  const { JSONRPCMessageSchema, isInitializeRequest } =
    await import('@modelcontextprotocol/sdk/types.js');
  return {
    StreamableHTTPServerTransport: vi.fn().mockImplementation(function (options) {
      const t: any = {
        sessionId: undefined as string | undefined,
        onclose: undefined as (() => void) | undefined,
        handleRequest: vi.fn().mockImplementation(async (req, res, body) => {
          if (!t.sessionId) {
            const accept = req.headers.accept ?? '';
            if (
              !accept.includes('application/json') ||
              !accept.includes('text/event-stream') ||
              !req.headers['content-type']?.includes('application/json')
            ) {
              res.status(406).json({});
              return;
            }
            let messages;
            try {
              messages = (Array.isArray(body) ? body : [body]).map((message) =>
                JSONRPCMessageSchema.parse(message),
              );
            } catch {
              res.status(400).json({});
              return;
            }
            if (messages.length !== 1 || !isInitializeRequest(messages[0])) {
              res.status(400).json({});
              return;
            }
            t.sessionId = `sess-${Math.random().toString(36).slice(2)}`;
            try {
              await options.onsessioninitialized?.(t.sessionId);
            } catch (error) {
              res.status(400).json({
                jsonrpc: '2.0',
                error: { code: -32700, message: String(error) },
                id: null,
              });
              return;
            }
          }
        }),
        close: vi.fn().mockResolvedValue(undefined),
      };
      return t;
    }),
  };
});

vi.mock('@modelcontextprotocol/sdk/server/index.js', () => ({
  Server: vi.fn(),
}));

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Minimal Express mock that records the /api/mcp handler and exposes a
 * `trigger` helper for firing requests.
 *
 * Awaits the endpoint promise so initialization and finalizers finish.
 */
function makeMockApp() {
  let mcpHandler: ((req: any, res: any) => Promise<void>) | undefined;

  const app = {
    all: vi.fn((_path: string, handler: (req: any, res: any) => Promise<void>) => {
      mcpHandler = handler;
    }),
    trigger: async (
      req: Partial<{ method: string; headers: Record<string, string>; body: unknown }>,
      response: { destroyed?: boolean } = {},
    ) => {
      if (!mcpHandler) throw new Error('mountMCPEndpoints not called yet');
      const res: any = {
        headersSent: false,
        destroyed: false,
        statusCode: 200,
        status: vi.fn(function (this: any, code: number) {
          this.statusCode = code;
          return this;
        }),
        json: vi.fn(function (this: any) {
          if (this.headersSent) throw new Error('ERR_HTTP_HEADERS_SENT');
          this.headersSent = true;
          return this;
        }),
        ...response,
      };
      await mcpHandler(
        {
          method: 'POST',
          ...req,
          headers: {
            accept: 'application/json, text/event-stream',
            'content-type': 'application/json',
            ...req.headers,
          },
          body: req.body === undefined ? initializeRequest : req.body,
        },
        res,
      );
      expect(res.json.mock.calls.length).toBeLessThanOrEqual(1);
      return res;
    },
  };
  return app;
}

const initializeRequest = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'test', version: '1' },
  },
};

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('validated admission and terminal cleanup', () => {
  it('closes admitted sessions when handling returns an SDK error response', async () => {
    const { createMCPServer } = await import('../../src/mcp/server.js');
    let transport: any;
    vi.mocked(createMCPServer).mockImplementationOnce(
      () =>
        ({
          connect: vi.fn((candidate) => {
            transport = candidate;
            const handle = candidate.handleRequest.getMockImplementation();
            candidate.handleRequest.mockImplementation(async (...args: any[]) => {
              await handle(...args);
              args[1].status(400).json({});
            });
            return Promise.resolve();
          }),
          close: vi.fn().mockResolvedValue(undefined),
        }) as any,
    );
    const app = makeMockApp();
    const { cleanup, getDiagnostics } = mountMCPEndpoints(app as any, makeMockBackend());
    await app.trigger({});
    expect(getDiagnostics().activeSessionCount).toBe(0);
    expect(transport.close).toHaveBeenCalled();
    await app.trigger({});
    expect(getDiagnostics().activeSessionCount).toBe(1);
    await cleanup();
  });

  it('closes a blocked handler before draining initialization', async () => {
    const { createMCPServer } = await import('../../src/mcp/server.js');
    const handling = deferred();
    const release = deferred();
    const delivered = vi.fn();
    vi.mocked(createMCPServer).mockImplementationOnce(
      () =>
        ({
          connect: vi.fn((transport) => {
            const handle = transport.handleRequest.getMockImplementation();
            transport.handleRequest.mockImplementation(async (...args: any[]) => {
              await handle(...args);
              handling.resolve();
              await release.promise;
              delivered();
            });
            transport.close.mockImplementation(() => {
              release.resolve();
              return Promise.resolve();
            });
            return Promise.resolve();
          }),
          close: vi.fn().mockResolvedValue(undefined),
        }) as any,
    );
    const app = makeMockApp();
    const { cleanup, getDiagnostics } = mountMCPEndpoints(app as any, makeMockBackend());
    const request = app.trigger({});
    await handling.promise;
    await cleanup();
    await request;
    expect(delivered).toHaveBeenCalledOnce();
    expect(getDiagnostics().activeSessionCount).toBe(0);
  });

  it('finishes initialization started before cleanup without an SDK parse error', async () => {
    const { createMCPServer } = await import('../../src/mcp/server.js');
    const handling = deferred();
    const release = deferred();
    vi.mocked(createMCPServer).mockImplementationOnce(
      () =>
        ({
          connect: vi.fn((transport) => {
            const handle = transport.handleRequest.getMockImplementation();
            transport.handleRequest.mockImplementation(async (...args: any[]) => {
              handling.resolve();
              await release.promise;
              await handle(...args);
            });
            transport.close.mockImplementation(() => {
              release.resolve();
              return Promise.resolve();
            });
            return Promise.resolve();
          }),
          close: vi.fn().mockResolvedValue(undefined),
        }) as any,
    );
    const app = makeMockApp();
    const { cleanup, getDiagnostics } = mountMCPEndpoints(app as any, makeMockBackend());
    const request = app.trigger({});
    await handling.promise;
    const shutdown = cleanup();
    const response = await request;
    await shutdown;
    expect(response.statusCode).toBe(200);
    expect(response.json).not.toHaveBeenCalled();
    expect(getDiagnostics().totalSessionsCreated).toBe(1);
    expect(getDiagnostics().activeSessionCount).toBe(0);
    expect((await app.trigger({})).statusCode).toBe(503);
  });

  it('keeps a live session when a disconnected initialization reaches admission', async () => {
    vi.stubEnv('ONTOINDEX_HTTP_MCP_MAX_SESSIONS', '1');
    vi.resetModules();
    const { mountMCPEndpoints: mount } = await import('../../src/server/mcp-http.js');
    const app = makeMockApp();
    const { cleanup, getDiagnostics } = mount(app as any, makeMockBackend());
    await app.trigger({});
    const original = getDiagnostics().activeSessions[0]!.sessionId;
    await app.trigger({}, { destroyed: true });
    expect(getDiagnostics().activeSessions[0]!.sessionId).toBe(original);
    expect(getDiagnostics().totalSessionsCreated).toBe(1);
    expect(getDiagnostics().totalCapEvictions).toBe(0);
    await cleanup();
  });

  it('releases reservations and closes resources after connect or handle rejection', async () => {
    vi.stubEnv('ONTOINDEX_HTTP_MCP_MAX_SESSIONS', '1');
    vi.resetModules();
    const { mountMCPEndpoints: mount } = await import('../../src/server/mcp-http.js');
    const { createMCPServer } = await import('../../src/mcp/server.js');
    const app = makeMockApp();
    const { cleanup, getDiagnostics } = mount(app as any, makeMockBackend());
    for (const failure of ['connect', 'handle']) {
      const close = vi.fn().mockResolvedValue(undefined);
      let transport: any;
      vi.mocked(createMCPServer).mockImplementationOnce(
        () =>
          ({
            connect: vi.fn((candidate) => {
              transport = candidate;
              if (failure === 'connect') return Promise.reject(new Error('connect failed'));
              candidate.handleRequest.mockRejectedValueOnce(new Error('handle failed'));
              return Promise.resolve();
            }),
            close,
          }) as any,
      );
      expect((await app.trigger({})).status).toHaveBeenCalledWith(500);
      expect(close).toHaveBeenCalledOnce();
      expect(transport.close).toHaveBeenCalled();
      expect(getDiagnostics().activeSessionCount).toBe(0);
    }
    await app.trigger({});
    expect(getDiagnostics().activeSessionCount).toBe(1);
    await cleanup();
  });

  it('holds the active cap while two valid admissions await separate evictions', async () => {
    vi.stubEnv('ONTOINDEX_HTTP_MCP_MAX_SESSIONS', '2');
    vi.resetModules();
    const { mountMCPEndpoints: mount } = await import('../../src/server/mcp-http.js');
    const { createMCPServer } = await import('../../src/mcp/server.js');
    const first = deferred();
    const second = deferred();
    const firstClosing = deferred();
    const secondClosing = deferred();
    for (const [gate, started] of [
      [first, firstClosing],
      [second, secondClosing],
    ]) {
      vi.mocked(createMCPServer).mockImplementationOnce(
        () =>
          ({
            connect: vi.fn().mockResolvedValue(undefined),
            close: vi.fn(() => {
              started.resolve();
              return gate.promise;
            }),
          }) as any,
      );
    }
    const app = makeMockApp();
    const { cleanup, getDiagnostics } = mount(app as any, makeMockBackend());
    await app.trigger({});
    await app.trigger({});
    const candidate1 = app.trigger({});
    await firstClosing.promise;
    expect(getDiagnostics().activeSessionCount).toBe(2);
    const candidate2 = app.trigger({});
    await secondClosing.promise;
    expect(getDiagnostics().activeSessionCount).toBe(2);
    expect((await app.trigger({})).status).toHaveBeenCalledWith(503);
    expect(getDiagnostics().totalCapEvictions).toBe(2);
    first.resolve();
    second.resolve();
    await Promise.all([candidate1, candidate2]);
    expect(getDiagnostics().activeSessionCount).toBe(2);
    await cleanup();
  });

  it('leaves an established cap-one session intact for rejected requests and replaces it for a singleton initialize batch', async () => {
    vi.stubEnv('ONTOINDEX_HTTP_MCP_MAX_SESSIONS', '1');
    vi.resetModules();
    const { mountMCPEndpoints: mount } = await import('../../src/server/mcp-http.js');
    const app = makeMockApp();
    const { cleanup, getDiagnostics } = mount(app as any, makeMockBackend());
    await app.trigger({});
    const original = getDiagnostics().activeSessions[0]!.sessionId;
    for (const req of [
      { body: {} },
      { body: { jsonrpc: '2.0', method: 'initialize', params: initializeRequest.params } },
      { body: { jsonrpc: '1.0', id: 1, method: 'initialize' } },
      { body: { jsonrpc: '2.0', id: 1, method: 'ping' } },
      { body: { jsonrpc: '2.0', method: 'notifications/initialized' } },
      { body: [initializeRequest, { jsonrpc: '2.0', id: 2, method: 'ping' }] },
      { headers: { accept: 'application/json' } },
      { headers: { 'content-type': 'text/plain' } },
    ]) {
      await app.trigger(req);
      expect(getDiagnostics().activeSessions[0]!.sessionId).toBe(original);
      expect(getDiagnostics().totalCapEvictions).toBe(0);
      expect(getDiagnostics().totalSessionsCreated).toBe(1);
    }
    await app.trigger({ body: [initializeRequest] });
    expect(getDiagnostics().activeSessionCount).toBe(1);
    expect(getDiagnostics().activeSessions[0]!.sessionId).not.toBe(original);
    expect(getDiagnostics().totalCapEvictions).toBe(1);
    await cleanup();
  });

  it('drains blocked initialization and its final close and returns the same cleanup promise', async () => {
    const { createMCPServer } = await import('../../src/mcp/server.js');
    const connected = deferred();
    const connect = deferred();
    const closing = deferred();
    const close = deferred();
    vi.mocked(createMCPServer).mockImplementationOnce(
      () =>
        ({
          connect: vi.fn(() => {
            connected.resolve();
            return connect.promise;
          }),
          close: vi.fn(() => {
            closing.resolve();
            return close.promise;
          }),
        }) as any,
    );
    const app = makeMockApp();
    const { cleanup, getDiagnostics } = mountMCPEndpoints(app as any, makeMockBackend());
    const request = app.trigger({});
    await connected.promise;
    let complete = false;
    const shutdown = cleanup();
    expect(cleanup()).toBe(shutdown);
    void shutdown.then(() => {
      complete = true;
    });
    connect.resolve();
    await closing.promise;
    expect(complete).toBe(false);
    expect(getDiagnostics().activeSessionCount).toBe(0);
    close.resolve();
    await Promise.all([request, shutdown]);
    expect((await app.trigger({})).status).toHaveBeenCalledWith(503);
  });

  it('awaits an already-started session close', async () => {
    const { createMCPServer } = await import('../../src/mcp/server.js');
    const closing = deferred();
    const close = deferred();
    vi.mocked(createMCPServer).mockImplementationOnce(
      () =>
        ({
          connect: vi.fn().mockResolvedValue(undefined),
          close: vi.fn(() => {
            closing.resolve();
            return close.promise;
          }),
        }) as any,
    );
    const app = makeMockApp();
    const { cleanup } = mountMCPEndpoints(app as any, makeMockBackend());
    await app.trigger({});
    const { StreamableHTTPServerTransport } =
      await import('@modelcontextprotocol/sdk/server/streamableHttp.js');
    (StreamableHTTPServerTransport as any).mock.results.at(-1).value.onclose();
    await closing.promise;
    let complete = false;
    const shutdown = cleanup();
    void shutdown.then(() => {
      complete = true;
    });
    await Promise.resolve();
    expect(complete).toBe(false);
    close.resolve();
    await shutdown;
  });
});

function makeMockBackend(): any {
  return {};
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

// ─── boundedIncrement — counter cap ──────────────────────────────────────────

describe('boundedIncrement (counter cap)', () => {
  it('increments normally below cap', () => {
    expect(boundedIncrement(0)).toBe(1);
    expect(boundedIncrement(100)).toBe(101);
    expect(boundedIncrement(MCP_DIAG_MAX_COUNTER - 1)).toBe(MCP_DIAG_MAX_COUNTER);
  });

  it('does not exceed MCP_DIAG_MAX_COUNTER at the boundary', () => {
    expect(boundedIncrement(MCP_DIAG_MAX_COUNTER)).toBe(MCP_DIAG_MAX_COUNTER);
  });

  it('does not exceed MCP_DIAG_MAX_COUNTER above the boundary', () => {
    expect(boundedIncrement(MCP_DIAG_MAX_COUNTER + 1000)).toBe(MCP_DIAG_MAX_COUNTER);
  });

  it('MCP_DIAG_MAX_COUNTER is a positive finite integer', () => {
    expect(MCP_DIAG_MAX_COUNTER).toBeGreaterThan(0);
    expect(Number.isFinite(MCP_DIAG_MAX_COUNTER)).toBe(true);
    expect(Number.isInteger(MCP_DIAG_MAX_COUNTER)).toBe(true);
  });
});

// ─── Initial diagnostics snapshot ────────────────────────────────────────────

describe('getDiagnostics — initial state', () => {
  it('returns zero counters and empty sessions on fresh mount', async () => {
    const app = makeMockApp();
    const { cleanup, getDiagnostics } = mountMCPEndpoints(app as any, makeMockBackend());
    const snap: MCPDiagnosticsSnapshot = getDiagnostics();

    expect(snap.activeSessionCount).toBe(0);
    expect(snap.activeSessions).toHaveLength(0);
    expect(snap.totalSessionsCreated).toBe(0);
    expect(snap.totalEvictions).toBe(0);
    expect(snap.totalCapEvictions).toBe(0);
    expect(snap.capturedAt).toBeGreaterThan(0);

    await cleanup();
  });
});

// ─── Concurrent initialization cap ──────────────────────────────────────────

describe('concurrent initialization cap', () => {
  it('counts pending initializations and releases reservations after completion', async () => {
    vi.stubEnv('ONTOINDEX_HTTP_MCP_MAX_SESSIONS', '1');
    vi.resetModules();

    const { mountMCPEndpoints: mountWithCap } = await import('../../src/server/mcp-http.js');
    const { createMCPServer: createMockServer } = await import('../../src/mcp/server.js');
    let releaseConnect!: () => void;
    const connectGate = new Promise<void>((resolve) => {
      releaseConnect = resolve;
    });
    vi.mocked(createMockServer).mockImplementation(
      () =>
        ({
          connect: vi.fn(() => connectGate),
          close: vi.fn().mockResolvedValue(undefined),
        }) as any,
    );

    const app = makeMockApp();
    const { cleanup, getDiagnostics } = mountWithCap(app as any, makeMockBackend());
    const pending = Array.from({ length: 8 }, () =>
      app.trigger({ method: 'POST', headers: {}, body: initializeRequest }),
    );

    expect(getDiagnostics().activeSessionCount).toBe(0);
    releaseConnect();
    const responses = await Promise.all(pending);

    expect(getDiagnostics().activeSessionCount).toBe(1);
    expect(
      responses.filter((response) => response.status.mock.calls.some(([status]) => status === 503)),
    ).toHaveLength(7);

    // Terminal cleanup refuses later initialization.
    await cleanup();
    const response = await app.trigger({ method: 'POST', headers: {}, body: initializeRequest });
    expect(response.status).toHaveBeenCalledWith(503);
    expect(getDiagnostics().activeSessionCount).toBe(0);
    expect(getDiagnostics().totalSessionsCreated).toBe(1);
    await cleanup();
    vi.mocked(createMockServer).mockImplementation(
      () =>
        ({
          connect: vi.fn().mockResolvedValue(undefined),
          close: vi.fn().mockResolvedValue(undefined),
        }) as any,
    );
  });
});

// ─── TTL eviction ────────────────────────────────────────────────────────────

describe('TTL eviction', () => {
  it('increments totalEvictions and removes session after SESSION_TTL_MS of inactivity', async () => {
    vi.useFakeTimers();

    const app = makeMockApp();
    const { cleanup, getDiagnostics } = mountMCPEndpoints(app as any, makeMockBackend());

    // Create one session (trigger flushes microtasks via Promise.resolve loops)
    await app.trigger({ method: 'POST', headers: {}, body: initializeRequest });

    expect(getDiagnostics().totalSessionsCreated).toBe(1);
    expect(getDiagnostics().activeSessionCount).toBe(1);

    // Advance past TTL (30 min) and cleanup interval (5 min) — 36 min total.
    // advanceTimersByTimeAsync fires the setInterval callback AND flushes
    // any microtasks produced by async closeSession.
    await vi.advanceTimersByTimeAsync(36 * 60 * 1000);

    const snap = getDiagnostics();
    expect(snap.totalEvictions).toBeGreaterThanOrEqual(1);
    expect(snap.activeSessionCount).toBe(0);

    await cleanup();
    vi.useRealTimers();
  });
});

// ─── Session reset (close) ────────────────────────────────────────────────────

describe('session reset on close', () => {
  it('removes session from activeSessions when transport.onclose fires', async () => {
    const app = makeMockApp();
    const { cleanup, getDiagnostics } = mountMCPEndpoints(app as any, makeMockBackend());

    await app.trigger({ method: 'POST', headers: {}, body: initializeRequest });
    expect(getDiagnostics().activeSessionCount).toBe(1);

    // Retrieve the transport mock instance and fire its onclose
    const { StreamableHTTPServerTransport } =
      await import('@modelcontextprotocol/sdk/server/streamableHttp.js');
    const MockTransport = StreamableHTTPServerTransport as any;
    const transportInstance = MockTransport.mock.results.at(-1)?.value;
    expect(transportInstance).toBeDefined();

    transportInstance.onclose?.();
    // Allow closeSession microtasks to settle
    for (let i = 0; i < 20; i++) await Promise.resolve();

    expect(getDiagnostics().activeSessionCount).toBe(0);
    expect(getDiagnostics().activeSessions).toHaveLength(0);

    await cleanup();
  });

  it('requestCount is tracked per session', async () => {
    const app = makeMockApp();
    const { cleanup, getDiagnostics } = mountMCPEndpoints(app as any, makeMockBackend());

    await app.trigger({ method: 'POST', headers: {}, body: initializeRequest });
    const sessionId = getDiagnostics().activeSessions[0]?.sessionId;
    expect(sessionId).toBeDefined();

    for (let i = 0; i < 3; i++) {
      await app.trigger({ method: 'POST', headers: { 'mcp-session-id': sessionId! }, body: {} });
    }

    const sess = getDiagnostics().activeSessions.find((s) => s.sessionId === sessionId);
    expect(sess).toBeDefined();
    expect(sess!.requestCount).toBe(3);

    await cleanup();
  });

  it('requestCount increments on the session path and uses the bounded counter helper', async () => {
    const app = makeMockApp();
    const { cleanup, getDiagnostics } = mountMCPEndpoints(app as any, makeMockBackend());

    await app.trigger({ method: 'POST', headers: {}, body: initializeRequest });
    const sessionId = getDiagnostics().activeSessions[0]?.sessionId;
    expect(sessionId).toBeDefined();

    for (let i = 0; i < 5; i++) {
      await app.trigger({ method: 'POST', headers: { 'mcp-session-id': sessionId! }, body: {} });
    }

    const sess = getDiagnostics().activeSessions.find((s) => s.sessionId === sessionId);
    expect(sess!.requestCount).toBe(5);
    expect(boundedIncrement(MCP_DIAG_MAX_COUNTER)).toBe(MCP_DIAG_MAX_COUNTER);

    await cleanup();
  });

  it('errorCount increments for failed session requests without exposing payloads', async () => {
    const app = makeMockApp();
    const { cleanup, getDiagnostics } = mountMCPEndpoints(app as any, makeMockBackend());

    await app.trigger({ method: 'POST', headers: {}, body: initializeRequest });
    const sessionId = getDiagnostics().activeSessions[0]?.sessionId;
    expect(sessionId).toBeDefined();

    const { StreamableHTTPServerTransport } =
      await import('@modelcontextprotocol/sdk/server/streamableHttp.js');
    const MockTransport = StreamableHTTPServerTransport as any;
    const transportInstance = MockTransport.mock.results.at(-1)?.value;
    expect(transportInstance).toBeDefined();
    transportInstance.handleRequest.mockRejectedValueOnce(new Error('boom'));

    const response = await app.trigger({
      method: 'POST',
      headers: { 'mcp-session-id': sessionId! },
      body: { prompt: 'secret', toolArgs: { dangerous: true } },
    });

    const session = getDiagnostics().activeSessions.find((entry) => entry.sessionId === sessionId);
    expect(session?.errorCount).toBe(1);
    expect(response.status).toHaveBeenCalledWith(500);
    expect(response.json).toHaveBeenCalledWith({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Internal MCP server error' },
      id: null,
    });

    await cleanup();
  });
});

// ─── Snapshot shape ───────────────────────────────────────────────────────────

describe('MCPDiagnosticsSnapshot shape', () => {
  it('capturedAt is a recent timestamp', async () => {
    const before = Date.now();
    const app = makeMockApp();
    const { cleanup, getDiagnostics } = mountMCPEndpoints(app as any, makeMockBackend());
    const snap = getDiagnostics();
    const after = Date.now();

    expect(snap.capturedAt).toBeGreaterThanOrEqual(before);
    expect(snap.capturedAt).toBeLessThanOrEqual(after);

    await cleanup();
  });

  it('activeSessions contains correct timestamps and zero counters on creation', async () => {
    const before = Date.now();
    const app = makeMockApp();
    const { cleanup, getDiagnostics } = mountMCPEndpoints(app as any, makeMockBackend());

    await app.trigger({ method: 'POST', headers: {}, body: initializeRequest });
    const after = Date.now();

    const snap = getDiagnostics();
    expect(snap.activeSessions).toHaveLength(1);

    const sess = snap.activeSessions[0]!;
    expect(typeof sess.createdAt).toBe('number');
    expect(typeof sess.lastActivity).toBe('number');
    expect(sess.createdAt).toBeGreaterThanOrEqual(before);
    expect(sess.createdAt).toBeLessThanOrEqual(after);
    expect(sess.lastActivity).toBeGreaterThanOrEqual(sess.createdAt);
    expect(sess.requestCount).toBe(0);
    expect(sess.errorCount).toBe(0);
    expect(typeof sess.sessionId).toBe('string');
    expect(sess.sessionId.length).toBeGreaterThan(0);

    await cleanup();
  });

  it('totalSessionsCreated increments for each new connection', async () => {
    const app = makeMockApp();
    const { cleanup, getDiagnostics } = mountMCPEndpoints(app as any, makeMockBackend());

    await app.trigger({ method: 'POST', headers: {}, body: initializeRequest });
    expect(getDiagnostics().totalSessionsCreated).toBe(1);

    await app.trigger({ method: 'POST', headers: {}, body: initializeRequest });
    expect(getDiagnostics().totalSessionsCreated).toBe(2);

    await cleanup();
  });
});
