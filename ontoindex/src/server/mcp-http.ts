/**
 * MCP over HTTP
 *
 * Mounts the OntoIndex MCP server on Express using StreamableHTTP transport.
 * Each connecting client gets its own stateful session; the LocalBackend
 * is shared across all sessions (thread-safe — lazy LadybugDB per repo).
 *
 * Sessions are cleaned up on explicit close or after SESSION_TTL_MS of inactivity
 * (guards against network drops that never trigger onclose).
 */

import type { Express, Request, Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { createMCPServer } from '../mcp/server.js';
import type { LocalBackend } from '../mcp/local/local-backend.js';
import { randomUUID } from 'crypto';

// ─── Diagnostics types ──────────────────────────────────────────────────────

/** Hard cap on per-session request/error counters. Prevents unbounded growth. */
export const MCP_DIAG_MAX_COUNTER = 65_535;

/** Increments n by 1, capped at MCP_DIAG_MAX_COUNTER. */
export function boundedIncrement(n: number): number {
  return n >= MCP_DIAG_MAX_COUNTER ? MCP_DIAG_MAX_COUNTER : n + 1;
}

/** Read-only per-session diagnostics snapshot. */
export interface MCPSessionDiagnostics {
  readonly sessionId: string;
  readonly createdAt: number;
  readonly lastActivity: number;
  readonly requestCount: number;
  readonly errorCount: number;
}

/** Read-only global diagnostics snapshot from the HTTP MCP layer. */
export interface MCPDiagnosticsSnapshot {
  readonly activeSessions: readonly MCPSessionDiagnostics[];
  readonly activeSessionCount: number;
  readonly totalSessionsCreated: number;
  readonly totalEvictions: number;
  readonly totalCapEvictions: number;
  readonly capturedAt: number;
}

/** Handle returned by mountMCPEndpoints. */
export interface MCPEndpointHandle {
  /** Closes all active sessions and stops the cleanup timer. */
  cleanup: () => Promise<void>;
  /** Returns a read-only snapshot of current diagnostics. */
  getDiagnostics: () => MCPDiagnosticsSnapshot;
}

// ─── Internal session state ─────────────────────────────────────────────────

interface MCPSession {
  server: Server;
  transport: StreamableHTTPServerTransport;
  lastActivity: number;
  createdAt: number;
  requestCount: number;
  errorCount: number;
}

type ClosableTransport = StreamableHTTPServerTransport & {
  close?: (this: StreamableHTTPServerTransport) => unknown;
};

/** Idle sessions are evicted after 30 minutes */
const SESSION_TTL_MS = 30 * 60 * 1000;
/** Cleanup sweep runs every 5 minutes */
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
/** Hard cap to prevent reconnect storms from retaining unbounded servers/transports. */
const MAX_HTTP_MCP_SESSIONS = (() => {
  const raw = Number.parseInt(process.env.ONTOINDEX_HTTP_MCP_MAX_SESSIONS ?? '', 10);
  return Number.isFinite(raw) ? Math.max(1, Math.min(raw, 256)) : 32;
})();

async function closeTransportQuietly(transport: StreamableHTTPServerTransport): Promise<void> {
  try {
    const closeTransport = (transport as ClosableTransport).close;
    if (typeof closeTransport === 'function') {
      await Promise.resolve(closeTransport.call(transport));
    }
  } catch {}
}

export function mountMCPEndpoints(app: Express, backend: LocalBackend): MCPEndpointHandle {
  const sessions = new Map<string, MCPSession>();
  const closingSessions = new Set<string>();

  // Global diagnostics counters
  let totalSessionsCreated = 0;
  let totalEvictions = 0;
  let totalCapEvictions = 0;

  const closeSession = async (id: string, session: MCPSession): Promise<void> => {
    if (closingSessions.has(id)) return;
    closingSessions.add(id);
    sessions.delete(id);
    session.transport.onclose = undefined;
    try {
      await Promise.resolve(session.server.close());
    } catch {}
    await closeTransportQuietly(session.transport);
    closingSessions.delete(id);
  };

  const evictOldestSession = async (): Promise<void> => {
    let oldestId: string | null = null;
    let oldestActivity = Infinity;
    for (const [id, session] of sessions) {
      if (session.lastActivity < oldestActivity) {
        oldestId = id;
        oldestActivity = session.lastActivity;
      }
    }
    if (oldestId) {
      await closeSession(oldestId, sessions.get(oldestId)!);
    }
  };

  // Periodic cleanup of idle sessions (guards against network drops)
  const cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [id, session] of sessions) {
      if (now - session.lastActivity > SESSION_TTL_MS) {
        totalEvictions++;
        void closeSession(id, session);
      }
    }
  }, CLEANUP_INTERVAL_MS);
  if (cleanupTimer && typeof cleanupTimer === 'object' && 'unref' in cleanupTimer) {
    (cleanupTimer as NodeJS.Timeout).unref();
  }

  const handleMcpRequest = async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    if (sessionId && sessions.has(sessionId)) {
      // Existing session — delegate to its transport
      const session = sessions.get(sessionId)!;
      session.lastActivity = Date.now();
      session.requestCount = boundedIncrement(session.requestCount);
      await session.transport.handleRequest(req, res, req.body);
    } else if (sessionId) {
      // Unknown/expired session ID — tell client to re-initialize (per MCP spec)
      res.status(404).json({
        jsonrpc: '2.0',
        error: { code: -32001, message: 'Session not found. Re-initialize.' },
        id: null,
      });
    } else if (req.method === 'POST') {
      // No session ID — new client initializing
      if (sessions.size >= MAX_HTTP_MCP_SESSIONS) {
        totalCapEvictions++;
        await evictOldestSession();
      }
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
      });
      const server = createMCPServer(backend);
      let registered = false;
      try {
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);

        if (transport.sessionId) {
          registered = true;
          const now = Date.now();
          sessions.set(transport.sessionId, {
            server,
            transport,
            lastActivity: now,
            createdAt: now,
            requestCount: 0,
            errorCount: 0,
          });
          totalSessionsCreated++;
          transport.onclose = () => {
            const id = transport.sessionId;
            if (!id) return;
            const session = sessions.get(id);
            if (session) void closeSession(id, session);
          };
        }
      } finally {
        if (!registered) {
          try {
            await Promise.resolve(server.close());
          } catch {}
          await closeTransportQuietly(transport);
        }
      }
    } else {
      res.status(400).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'No valid session. Send a POST to initialize.' },
        id: null,
      });
    }
  };

  app.all('/api/mcp', (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    void handleMcpRequest(req, res).catch((err: unknown) => {
      console.error('MCP HTTP request failed:', err);
      if (sessionId) {
        const session = sessions.get(sessionId);
        if (session) session.errorCount = boundedIncrement(session.errorCount);
      }
      if (res.headersSent) return;
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Internal MCP server error' },
        id: null,
      });
    });
  });

  const cleanup = async () => {
    clearInterval(cleanupTimer);
    const closers = [...sessions].map(([id, session]) => closeSession(id, session));
    await Promise.allSettled(closers);
  };

  const getDiagnostics = (): MCPDiagnosticsSnapshot => ({
    activeSessions: [...sessions.entries()].map(([id, s]) => ({
      sessionId: id,
      createdAt: s.createdAt,
      lastActivity: s.lastActivity,
      requestCount: s.requestCount,
      errorCount: s.errorCount,
    })),
    activeSessionCount: sessions.size,
    totalSessionsCreated,
    totalEvictions,
    totalCapEvictions,
    capturedAt: Date.now(),
  });

  console.log('MCP HTTP endpoints mounted at /api/mcp');
  return { cleanup, getDiagnostics };
}
