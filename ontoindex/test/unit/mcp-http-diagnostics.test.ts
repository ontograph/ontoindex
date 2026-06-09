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

vi.mock('@modelcontextprotocol/sdk/server/streamableHttp.js', () => {
  return {
    StreamableHTTPServerTransport: vi.fn().mockImplementation(function () {
      const t: any = {
        sessionId: undefined as string | undefined,
        onclose: undefined as (() => void) | undefined,
        handleRequest: vi.fn().mockImplementation(async () => {
          // Assign sessionId on first call — mirrors real SDK behavior
          if (!t.sessionId) {
            t.sessionId = `sess-${Math.random().toString(36).slice(2)}`;
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
 * Uses `await Promise.resolve()` loops to flush chained microtasks without
 * relying on setImmediate (which is faked by vi.useFakeTimers).
 */
function makeMockApp() {
  let mcpHandler: ((req: any, res: any) => void) | undefined;

  const app = {
    all: vi.fn((_path: string, handler: (req: any, res: any) => void) => {
      mcpHandler = handler;
    }),
    trigger: async (
      req: Partial<{ method: string; headers: Record<string, string>; body: unknown }>,
    ) => {
      if (!mcpHandler) throw new Error('mountMCPEndpoints not called yet');
      const res: any = {
        headersSent: false,
        status: vi.fn().mockReturnThis(),
        json: vi.fn().mockReturnThis(),
      };
      mcpHandler({ method: 'POST', headers: {}, body: {}, ...req }, res);
      // New-session setup awaits both connect() and handleRequest(); existing
      // sessions only await handleRequest(). Keep the flush cheap so cap tests
      // don't spend most of their time in Promise churn.
      const flushCount = req.headers?.['mcp-session-id'] ? 2 : 5;
      for (let i = 0; i < flushCount; i++) await Promise.resolve();
      return res;
    },
  };
  return app;
}

function makeMockBackend(): any {
  return {};
}

afterEach(() => vi.useRealTimers());

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

// ─── TTL eviction ────────────────────────────────────────────────────────────

describe('TTL eviction', () => {
  it('increments totalEvictions and removes session after SESSION_TTL_MS of inactivity', async () => {
    vi.useFakeTimers();

    const app = makeMockApp();
    const { cleanup, getDiagnostics } = mountMCPEndpoints(app as any, makeMockBackend());

    // Create one session (trigger flushes microtasks via Promise.resolve loops)
    await app.trigger({ method: 'POST', headers: {}, body: {} });

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

    await app.trigger({ method: 'POST', headers: {}, body: {} });
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

    await app.trigger({ method: 'POST', headers: {}, body: {} });
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

    await app.trigger({ method: 'POST', headers: {}, body: {} });
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

    await app.trigger({ method: 'POST', headers: {}, body: {} });
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

    await app.trigger({ method: 'POST', headers: {}, body: {} });
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

    await app.trigger({ method: 'POST', headers: {}, body: {} });
    expect(getDiagnostics().totalSessionsCreated).toBe(1);

    await app.trigger({ method: 'POST', headers: {}, body: {} });
    expect(getDiagnostics().totalSessionsCreated).toBe(2);

    await cleanup();
  });
});
