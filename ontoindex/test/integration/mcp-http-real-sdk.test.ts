import express from 'express';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';

const initialize = {
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

async function boundedGate(gate: Promise<void>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      gate,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error('Timed out awaiting transport closure'));
        }, 4000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function fixture() {
  vi.stubEnv('ONTOINDEX_HTTP_MCP_MAX_SESSIONS', '1');
  vi.resetModules();
  const { mountMCPEndpoints } = await import('../../src/server/mcp-http.js');
  const app = express();
  app.use(express.json());
  const handle = mountMCPEndpoints(app, { listRepos: async () => [] } as any);
  const errors: unknown[] = [];
  const errorSpy = vi.spyOn(console, 'error').mockImplementation((...args) => {
    errors.push(args);
  });
  const rejection = (reason: unknown) => {
    errors.push(reason);
  };
  process.on('unhandledRejection', rejection);
  const server: Server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => {
      resolve(listening);
    });
  });
  server.on('error', rejection);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP listener');
  const url = `http://127.0.0.1:${address.port}/api/mcp`;
  return {
    handle,
    errors,
    request: (body: unknown, headers: Record<string, string> = {}) =>
      fetch(url, {
        method: 'POST',
        headers: {
          accept: 'application/json, text/event-stream',
          'content-type': 'application/json',
          ...headers,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(5000),
      }),
    close: async () => {
      try {
        await handle.cleanup();
        await new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error) reject(error);
            else resolve();
          });
          server.closeAllConnections();
        });
      } finally {
        process.off('unhandledRejection', rejection);
        server.off('error', rejection);
        errorSpy.mockRestore();
      }
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('MCP HTTP with the installed SDK', () => {
  it('preserves a legitimate session across invalid initialization requests', async () => {
    const f = await fixture();
    try {
      const response = await f.request(initialize);
      expect(response.status).toBe(200);
      const id = response.headers.get('mcp-session-id');
      expect(id).toBeTruthy();
      await response.text();
      const { id: ignored, ...notification } = initialize;
      for (const [body, headers] of [
        [notification, {}],
        [{ ...initialize, jsonrpc: '1.0' }, {}],
        [{ ...initialize, id: null }, {}],
        [{ ...initialize, params: {} }, {}],
        [initialize, { accept: 'application/json' }],
      ] as [unknown, Record<string, string>][]) {
        const invalid = await f.request(body, headers);
        expect(invalid.status).toBeGreaterThanOrEqual(400);
        await invalid.text();
        expect(f.handle.getDiagnostics().activeSessions[0]?.sessionId).toBe(id);
        expect(f.handle.getDiagnostics().totalCapEvictions).toBe(0);
        const list = await f.request(
          { jsonrpc: '2.0', id: 2, method: 'tools/list' },
          {
            'mcp-session-id': id!,
            'mcp-protocol-version': '2025-03-26',
          },
        );
        expect(list.status).toBe(200);
        expect(await list.text()).toContain('tools');
      }
      expect(f.errors).toEqual([]);
    } finally {
      await f.close();
    }
    expect(f.errors).toEqual([]);
  });

  it('drains initialization awaiting victim closure during terminal cleanup', async () => {
    const f = await fixture();
    const entered = deferred();
    const release = deferred();
    let candidate: Promise<Response> | undefined;
    let shutdown: Promise<void> | undefined;
    try {
      const first = await f.request(initialize);
      expect(first.status).toBe(200);
      await first.text();
      const { StreamableHTTPServerTransport } =
        await import('@modelcontextprotocol/sdk/server/streamableHttp.js');
      const original = StreamableHTTPServerTransport.prototype.close;
      let gated = false;
      vi.spyOn(StreamableHTTPServerTransport.prototype, 'close').mockImplementation(
        async function () {
          if (!gated) {
            gated = true;
            entered.resolve();
            await release.promise;
          }
          await original.call(this);
        },
      );
      candidate = f.request(initialize);
      void candidate.catch(() => {});
      await boundedGate(entered.promise);
      expect(f.handle.getDiagnostics().activeSessionCount).toBe(1);
      const initialized = await candidate;
      expect(initialized.status).toBe(200);
      const candidateId = initialized.headers.get('mcp-session-id');
      expect(candidateId).toBeTruthy();
      expect(await initialized.text()).not.toContain('Parse error');
      let finished = false;
      shutdown = f.handle.cleanup();
      void shutdown.then(() => {
        finished = true;
      });
      expect(f.handle.getDiagnostics().activeSessionCount).toBe(0);
      await Promise.resolve();
      expect(finished).toBe(false);
      release.resolve();
      await shutdown;
      const later = await f.request(initialize);
      expect(later.status).toBe(503);
      expect(await later.text()).not.toContain('Parse error');
      const list = await f.request(
        { jsonrpc: '2.0', id: 2, method: 'tools/list' },
        {
          'mcp-session-id': candidateId!,
          'mcp-protocol-version': '2025-03-26',
        },
      );
      expect(list.status).toBe(503);
      expect(await list.text()).not.toContain('Parse error');
      expect(f.handle.getDiagnostics().activeSessionCount).toBe(0);
      expect(f.errors).toEqual([]);
    } finally {
      release.resolve();
      await Promise.allSettled([candidate, shutdown].filter(Boolean));
      await f.close();
    }
    expect(f.errors).toEqual([]);
  });
});
