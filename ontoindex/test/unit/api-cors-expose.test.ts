import type { Server } from 'node:http';
import express from 'express';
import { describe, expect, it, vi } from 'vitest';
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

describe('HTTP API CORS exposed headers', () => {
  it('exposes the MCP session header to an allowed browser origin', async () => {
    vi.stubEnv('ONTOINDEX_HTTP_TOKEN', 'cors-test-token');
    vi.spyOn(LocalBackend.prototype, 'init').mockResolvedValue(undefined);
    let server: Server | undefined;
    const listen = express.application.listen;
    vi.spyOn(express.application, 'listen').mockImplementation(function (...args: unknown[]) {
      server = Reflect.apply(listen, this, args) as Server;
      return server;
    } as typeof listen);

    try {
      await createServer(0);
      const address = server!.address();
      if (!address || typeof address === 'string') throw new Error('Expected TCP address');
      const response = await fetch(`http://127.0.0.1:${address.port}/`, {
        headers: { Origin: 'http://localhost:3000' },
      });
      expect(response.headers.get('access-control-expose-headers')).toBe('Mcp-Session-Id');
    } finally {
      if (server) {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => {
          server!.close((error) => (error ? reject(error) : resolve()));
        });
      }
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
    }
  });
});
