import type { Server } from 'node:http';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer } from '../../src/server/api.js';
import { LocalBackend } from '../../src/mcp/local/local-backend.js';

vi.mock('../../src/server/analyze-job.js', () => ({
  JobManager: class {
    async init() {}
    async dispose() {}
  },
}));
vi.mock('../../src/server/mcp-http.js', () => ({
  mountMCPEndpoints: () => ({ cleanup: async () => {}, getDiagnostics: vi.fn() }),
}));

let server: Server | undefined;
const originalSignals = new Map(
  (['SIGINT', 'SIGTERM'] as const).map((signal) => [signal, process.listeners(signal)]),
);

afterEach(async () => {
  try {
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server!.close((error) => (error ? reject(error) : resolve()));
      });
    }
  } finally {
    server = undefined;
    for (const [signal, listeners] of originalSignals) {
      for (const listener of process.listeners(signal)) {
        if (!listeners.includes(listener)) process.removeListener(signal, listener);
      }
    }
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  }
});

describe('HTTP server startup and preflight', () => {
  it('starts with Express 5 and preserves CORS/PNA without bypassing API auth', async () => {
    vi.stubEnv('ONTOINDEX_HTTP_TOKEN', 'startup-test-token');
    vi.spyOn(LocalBackend.prototype, 'init').mockResolvedValue(undefined);
    const listen = express.application.listen;
    vi.spyOn(express.application, 'listen').mockImplementation(function (...args: unknown[]) {
      server = Reflect.apply(listen, this, args) as Server;
      return server;
    } as typeof listen);
    await createServer(0);
    const address = server!.address();
    expect(address).not.toBeNull();
    if (!address || typeof address === 'string') throw new Error('Expected TCP address');
    const base = `http://127.0.0.1:${address.port}`;
    for (const route of ['/', '/api/query']) {
      const response = await fetch(`${base}${route}`, {
        method: 'OPTIONS',
        headers: {
          Origin: 'http://localhost:3000',
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'Authorization, Content-Type',
          'Access-Control-Request-Private-Network': 'true',
        },
      });
      expect(response.status).toBe(204);
      expect(response.headers.get('access-control-allow-origin')).toBe('http://localhost:3000');
      expect(response.headers.get('access-control-allow-private-network')).toBe('true');
      expect(response.headers.get('access-control-allow-headers')).toContain('Authorization');
      expect(response.headers.get('access-control-allow-methods')).toContain('POST');
    }
    for (const origin of ['https://untrusted.example', undefined]) {
      const response = await fetch(`${base}/api/query`, {
        method: 'OPTIONS',
        headers: {
          ...(origin ? { Origin: origin } : {}),
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Private-Network': 'true',
        },
      });
      expect(response.headers.get('access-control-allow-private-network')).toBeNull();
      if (origin) expect(response.headers.get('access-control-allow-origin')).toBeNull();
    }
    expect((await fetch(`${base}/api/repos`)).status).toBe(401);
  });
});
