import express from 'express';
import http from 'node:http';
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

describe('HTTP quality configuration isolation', () => {
  it('rejects process-wide quality changes without mutating environment', async () => {
    const f = await fixture();
    const before = { ...process.env };
    try {
      const initialized = await f.request(initialize);
      const id = initialized.headers.get('mcp-session-id');
      await initialized.text();
      const response = await f.request(
        {
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: {
            name: 'gn_quality_mode',
            arguments: { level: 'thorough' },
          },
        },
        { 'mcp-session-id': id!, 'mcp-protocol-version': '2025-03-26' },
      );
      const body = await response.text();
      expect(body).toContain('unavailable over HTTP');
      expect(body).toContain('isError');
      expect(process.env).toEqual(before);
    } finally {
      await f.close();
    }
  });
});

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
  const { Server: MCPServer } = await import('@modelcontextprotocol/sdk/server/index.js');
  const protocols: InstanceType<typeof MCPServer>[] = [];
  const connect = MCPServer.prototype.connect;
  vi.spyOn(MCPServer.prototype, 'connect').mockImplementation(async function (transport) {
    protocols.push(this);
    await connect.call(this, transport);
  });
  const app = express();
  app.use(express.json());
  const handle = mountMCPEndpoints(app, { listRepos: async () => [] } as any, {
    host: '127.0.0.1',
    port: 0,
  });
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
    protocols,
    deleteSession: (id: string) =>
      fetch(url, {
        method: 'DELETE',
        headers: { 'mcp-session-id': id, 'mcp-protocol-version': '2025-03-26' },
        signal: AbortSignal.timeout(5000),
      }),
    // fetch() overrides the Host header, so DNS-rebinding checks need node:http.
    requestWithHost: (body: unknown, host: string) =>
      new Promise<number>((resolve, reject) => {
        const req = http.request(
          url,
          {
            method: 'POST',
            headers: {
              host,
              accept: 'application/json, text/event-stream',
              'content-type': 'application/json',
            },
            timeout: 5000,
          },
          (res) => {
            res.resume();
            res.on('end', () => resolve(res.statusCode ?? 0));
          },
        );
        req.on('error', reject);
        req.end(JSON.stringify(body));
      }),
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
  it.each(['spontaneous', 'delete', 'eviction', 'cleanup'] as const)(
    'detaches protocol state and aborts pending handlers on %s closure',
    async (mode) => {
      const f = await fixture();
      let pending: Promise<Response> | undefined;
      try {
        const initialized = await f.request(initialize);
        const id = initialized.headers.get('mcp-session-id')!;
        await initialized.text();
        const protocol = f.protocols[0]!;
        const transport = protocol.transport!;
        const sdkOnclose = transport.onclose;
        const onclose = protocol.onclose!;
        const closed = vi.fn(() => onclose());
        protocol.onclose = closed;
        const entered = deferred();
        const aborted = deferred();
        const { PingRequestSchema } = await import('@modelcontextprotocol/sdk/types.js');
        protocol.setRequestHandler(PingRequestSchema, async (_request, extra) => {
          entered.resolve();
          await new Promise<void>((resolve) => {
            extra.signal.addEventListener(
              'abort',
              () => {
                aborted.resolve();
                resolve();
              },
              { once: true },
            );
          });
          return {};
        });
        pending = f.request(
          { jsonrpc: '2.0', id: 9, method: 'ping' },
          {
            'mcp-session-id': id,
            'mcp-protocol-version': '2025-03-26',
          },
        );
        void pending.catch(() => {});
        await boundedGate(entered.promise);
        if (mode === 'spontaneous') await transport.close();
        else if (mode === 'delete') {
          const deleted = await f.deleteSession(id);
          expect(deleted.status).toBe(200);
          await deleted.text();
        } else if (mode === 'eviction') {
          const replacement = await f.request(initialize);
          expect(replacement.status).toBe(200);
          await replacement.text();
        } else {
          const cleanup = f.handle.cleanup();
          expect(f.handle.cleanup()).toBe(cleanup);
          await cleanup;
        }
        await boundedGate(aborted.promise);
        expect(protocol.transport).toBeUndefined();
        expect(transport.onclose).toBe(sdkOnclose);
        expect(closed).toHaveBeenCalledOnce();
        expect(f.handle.getDiagnostics().activeSessionCount).toBe(mode === 'eviction' ? 1 : 0);
        await f.handle.cleanup();
        expect(closed).toHaveBeenCalledOnce();
      } finally {
        await f.close();
        await Promise.allSettled(pending ? [pending] : []);
      }
      expect(f.errors).toEqual([]);
    },
  );

  it('rejects a rebinding host while accepting loopback hosts', async () => {
    const f = await fixture();
    try {
      expect(await f.requestWithHost(initialize, 'attacker.example')).toBe(403);
      expect(await f.requestWithHost(initialize, 'localhost')).toBe(200);
    } finally {
      await f.close();
    }
  });
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
