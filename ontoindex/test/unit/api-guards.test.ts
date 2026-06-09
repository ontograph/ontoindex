import type { Server } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildApiMcpDiagnosticsResponse,
  buildApiSearchResponse,
  isAuthorizedApiRequest,
  isPublicApiRoute,
  isSafeGrepPattern,
  parseApiSearchRequestBody,
} from '../../src/server/api.js';
import { MCP_DIAG_MAX_COUNTER, type MCPDiagnosticsSnapshot } from '../../src/server/mcp-http.js';

let server: Server | undefined;

afterEach(async () => {
  await new Promise<void>((resolve, reject) => {
    if (!server) {
      resolve();
      return;
    }
    server.close((err) => (err ? reject(err) : resolve()));
  });
  server = undefined;
});

const listen = async (app: express.Application): Promise<string> =>
  new Promise((resolve, reject) => {
    server = app.listen(0, '127.0.0.1', () => {
      const address = server?.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Expected TCP server address'));
        return;
      }
      resolve(`http://127.0.0.1:${address.port}`);
    });
    server.on('error', reject);
  });

const makeDiagnosticsRouteApp = (snapshot: MCPDiagnosticsSnapshot, token = 'test-token') => {
  const app = express();
  app.use('/api', (req, res, next) => {
    if (isPublicApiRoute(req.method, req.originalUrl)) {
      next();
      return;
    }
    if (isAuthorizedApiRequest(req.headers.authorization, token)) {
      next();
      return;
    }

    res.setHeader('WWW-Authenticate', 'Bearer realm="ontoindex"');
    res.status(401).json({ error: 'Unauthorized' });
  });
  app.get('/api/mcp/diagnostics', (_req, res) => {
    res.json(buildApiMcpDiagnosticsResponse(snapshot));
  });
  return { app, token };
};

describe('api guards', () => {
  it('allows simple grep regex patterns', () => {
    expect(isSafeGrepPattern('TODO|FIXME')).toBe(true);
    expect(isSafeGrepPattern('function\\s+\\w+')).toBe(true);
  });

  it('rejects regex constructs with high backtracking risk', () => {
    expect(isSafeGrepPattern('(a+)+$')).toBe(false);
    expect(isSafeGrepPattern('(.*)+x')).toBe(false);
    expect(isSafeGrepPattern('(a|aa)+$')).toBe(false);
    expect(isSafeGrepPattern('(x+x+)+y')).toBe(false);
    expect(isSafeGrepPattern('(a+)+')).toBe(false);
  });

  it('allows safe patterns', () => {
    expect(isSafeGrepPattern('hello world')).toBe(true);
    expect(isSafeGrepPattern('foo.*bar')).toBe(true);
  });

  it('rejects backreferences and lookaround in grep patterns', () => {
    expect(isSafeGrepPattern('(a)\\1')).toBe(false);
    expect(isSafeGrepPattern('(?<=foo)bar')).toBe(false);
    expect(isSafeGrepPattern('foo(?=bar)')).toBe(false);
  });

  it('leaves only browser-detection endpoints unauthenticated', () => {
    expect(isPublicApiRoute('GET', '/api/heartbeat')).toBe(true);
    expect(isPublicApiRoute('GET', '/api/info?probe=1')).toBe(true);
    expect(isPublicApiRoute('OPTIONS', '/api/query')).toBe(true);

    expect(isPublicApiRoute('GET', '/api/repos')).toBe(false);
    expect(isPublicApiRoute('GET', '/api/mcp/diagnostics')).toBe(false);
    expect(isPublicApiRoute('POST', '/api/query')).toBe(false);
    expect(isPublicApiRoute('GET', '/api/graph')).toBe(false);
  });

  it('accepts matching bearer tokens only', () => {
    expect(isAuthorizedApiRequest('Bearer local-session-token', 'local-session-token')).toBe(true);
    expect(isAuthorizedApiRequest('bearer local-session-token', 'local-session-token')).toBe(true);
    expect(isAuthorizedApiRequest('Bearer wrong-token', 'local-session-token')).toBe(false);
    expect(isAuthorizedApiRequest('Basic local-session-token', 'local-session-token')).toBe(false);
    expect(isAuthorizedApiRequest(undefined, 'local-session-token')).toBe(false);
  });

  it('/api/file holds repo read access around filesystem reads', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'src/server/api.ts'), 'utf-8');
    const handlerStart = source.indexOf("app.get('/api/file'");
    const handlerEnd = source.indexOf("app.get('/api/grep'", handlerStart);
    const handler = source.slice(handlerStart, handlerEnd);

    const lockIndex = handler.indexOf('const releaseRead = acquireReadAccess');
    const statIndex = handler.indexOf('await fs.stat(fullPath)');
    const readIndex = handler.indexOf("await fs.readFile(fullPath, 'utf-8')");
    const releaseIndex = handler.indexOf('releaseRead();');

    expect(handlerStart).toBeGreaterThanOrEqual(0);
    expect(handlerEnd).toBeGreaterThan(handlerStart);
    expect(lockIndex).toBeGreaterThanOrEqual(0);
    expect(statIndex).toBeGreaterThan(lockIndex);
    expect(readIndex).toBeGreaterThan(lockIndex);
    expect(releaseIndex).toBeGreaterThan(readIndex);
  });

  it('/api/search defaults keep passive retrieval out of the response contract', () => {
    const request = parseApiSearchRequestBody({ query: 'auth flow' });
    const response = buildApiSearchResponse([]);

    expect(request.enrich).toBe(true);
    expect(request.passive).toEqual({
      consume_enrichment_facts: false,
      include_passive_related_facts: false,
      include_markdown_context: false,
      include_markdown_ppr: false,
    });
    expect(response).toEqual({ results: [] });
    expect(response).not.toHaveProperty('passive');
    expect(response).not.toHaveProperty('passive_enrichment');
    expect(response).not.toHaveProperty('explanation');
  });

  it('/api/search passive option names are distinct from graph decoration enrich', () => {
    const request = parseApiSearchRequestBody({
      query: 'auth flow',
      enrich: false,
      consume_enrichment_facts: true,
      include_passive_related_facts: true,
      include_markdown_context: true,
      include_markdown_ppr: true,
    });

    expect(request.enrich).toBe(false);
    expect(request.passive).toEqual({
      consume_enrichment_facts: true,
      include_passive_related_facts: true,
      include_markdown_context: true,
      include_markdown_ppr: true,
    });
  });

  it('keeps /api/mcp/diagnostics authenticated', async () => {
    const snapshot: MCPDiagnosticsSnapshot = {
      activeSessions: [],
      activeSessionCount: 0,
      totalSessionsCreated: 0,
      totalEvictions: 0,
      totalCapEvictions: 0,
      capturedAt: 1_700_000_000_000,
    };
    const { app, token } = makeDiagnosticsRouteApp(snapshot);
    const baseUrl = await listen(app);

    const response = await fetch(`${baseUrl}/api/mcp/diagnostics`);

    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toBe('Bearer realm="ontoindex"');
    expect(await response.json()).toEqual({ error: 'Unauthorized' });

    const authorized = await fetch(`${baseUrl}/api/mcp/diagnostics`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(authorized.status).toBe(200);
    expect(await authorized.json()).toEqual({
      activeSessions: [],
      activeSessionCount: 0,
      totalSessionsCreated: 0,
      totalIdleEvictions: 0,
      totalCapEvictions: 0,
      capturedAt: 1_700_000_000_000,
    });
  });

  it('builds a valid empty diagnostics response', () => {
    const response = buildApiMcpDiagnosticsResponse({
      activeSessions: [],
      activeSessionCount: 0,
      totalSessionsCreated: 0,
      totalEvictions: 0,
      totalCapEvictions: 0,
      capturedAt: 1_700_000_000_000,
    });

    expect(response).toEqual({
      activeSessions: [],
      activeSessionCount: 0,
      totalSessionsCreated: 0,
      totalIdleEvictions: 0,
      totalCapEvictions: 0,
      capturedAt: 1_700_000_000_000,
    });
  });

  it('redacts active session identifiers and excludes unsafe fields', () => {
    const response = buildApiMcpDiagnosticsResponse({
      activeSessions: [
        {
          sessionId: 'session-secret-123',
          createdAt: 1_699_999_999_000,
          lastActivity: 1_699_999_999_500,
          requestCount: MCP_DIAG_MAX_COUNTER,
          errorCount: MCP_DIAG_MAX_COUNTER,
        },
      ],
      activeSessionCount: 1,
      totalSessionsCreated: 4,
      totalEvictions: 2,
      totalCapEvictions: 1,
      capturedAt: 1_700_000_000_000,
    });

    expect(response).toEqual({
      activeSessions: [
        {
          sessionIdHash: expect.stringMatching(/^[a-f0-9]{16}$/),
          ageMs: 1000,
          lastActivityAt: 1_699_999_999_500,
          requestCount: MCP_DIAG_MAX_COUNTER,
          errorCount: MCP_DIAG_MAX_COUNTER,
        },
      ],
      activeSessionCount: 1,
      totalSessionsCreated: 4,
      totalIdleEvictions: 2,
      totalCapEvictions: 1,
      capturedAt: 1_700_000_000_000,
    });

    const session = response.activeSessions[0]!;
    expect(session.sessionIdHash).not.toBe('session-secret-123');
    expect(session).not.toHaveProperty('sessionId');
    expect(session).not.toHaveProperty('createdAt');
    expect(session).not.toHaveProperty('prompt');
    expect(session).not.toHaveProperty('toolArgs');
    expect(session).not.toHaveProperty('requestBody');
    expect(session).not.toHaveProperty('responseBody');
    expect(session).not.toHaveProperty('payload');
    expect(session).not.toHaveProperty('recentTools');
    expect(response).not.toHaveProperty('indexFreshness');
  });
});
