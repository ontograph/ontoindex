import type { Server } from 'node:http';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer } from '../../src/server/api.js';
import { LocalBackend } from '../../src/mcp/local/local-backend.js';

const lifecycle = vi.hoisted(() => ({ cleanup: vi.fn(), disposeJob: vi.fn(), listRepos: vi.fn() }));
vi.mock('../../src/storage/repo-manager.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/storage/repo-manager.js')>()),
  listRegisteredRepos: lifecycle.listRepos,
}));

vi.mock('../../src/server/analyze-job.js', () => ({
  JobManager: class {
    async init() {}
    getJob(id: string) {
      return {
        id,
        status: 'analyzing',
        progress: { phase: 'analyzing', percent: 0, message: 'Running' },
      };
    }
    onProgress() {
      return () => {};
    }
    async dispose() {
      await lifecycle.disposeJob();
    }
  },
}));
vi.mock('../../src/server/mcp-http.js', () => ({
  mountMCPEndpoints: () => ({ cleanup: lifecycle.cleanup, getDiagnostics: vi.fn() }),
}));

let server: Server | undefined;
const originalSignals = new Map(
  (['SIGINT', 'SIGTERM'] as const).map((signal) => [signal, process.listeners(signal)]),
);

afterEach(async () => {
  try {
    if (server) {
      server.closeAllConnections();
      if (server.listening) {
        await new Promise<void>((resolve, reject) => {
          server!.close((error) => (error ? reject(error) : resolve()));
        });
      }
    }
  } finally {
    server = undefined;
    for (const [signal, listeners] of originalSignals) {
      for (const listener of process.listeners(signal)) {
        if (!listeners.includes(listener)) process.removeListener(signal, listener);
      }
    }
    vi.restoreAllMocks();
    vi.resetAllMocks();
    vi.unstubAllEnvs();
  }
});

describe('HTTP server startup and preflight', () => {
  it('ends heartbeat and job progress streams, drains requests, and disposes once across signals', async () => {
    vi.stubEnv('ONTOINDEX_HTTP_TOKEN', 'startup-test-token');
    vi.spyOn(LocalBackend.prototype, 'init').mockResolvedValue(undefined);
    const dispose = vi.spyOn(LocalBackend.prototype, 'dispose').mockResolvedValue(undefined);
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const listen = express.application.listen;
    let lateHeartbeat!: (req: unknown, res: unknown) => void;
    vi.spyOn(express.application, 'listen').mockImplementation(function (...args: unknown[]) {
      lateHeartbeat = this.router.stack.find(
        (layer: { route?: { path: string } }) => layer.route?.path === '/api/heartbeat',
      ).route.stack[0].handle;
      server = Reflect.apply(listen, this, args) as Server;
      return server;
    } as typeof listen);
    await createServer(0);
    const address = server!.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP address');
    const base = `http://127.0.0.1:${address.port}`;
    const heartbeat = await fetch(`${base}/api/heartbeat`, { headers: { Connection: 'close' } });
    const reader = heartbeat.body!.getReader();
    expect((await reader.read()).done).toBe(false);
    const progressReaders = [];
    for (const kind of ['analyze', 'embed']) {
      const progress = await fetch(`${base}/api/${kind}/active/progress`, {
        headers: { Authorization: 'Bearer startup-test-token', Connection: 'close' },
      });
      expect(progress.status).toBe(200);
      const progressReader = progress.body!.getReader();
      expect((await progressReader.read()).done).toBe(false);
      progressReaders.push(progressReader);
    }
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    lifecycle.listRepos.mockImplementation(async () => {
      entered();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return [];
    });
    const pending = fetch(`${base}/api/repos`, {
      headers: { Authorization: 'Bearer startup-test-token', Connection: 'close' },
    });
    await started;
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      const listener = process
        .listeners(signal)
        .find((candidate) => !originalSignals.get(signal)!.includes(candidate));
      expect(listener).toBeDefined();
      listener!();
    }
    const lateResponse = { status: vi.fn().mockReturnThis(), end: vi.fn() };
    lateHeartbeat({}, lateResponse);
    expect(lateResponse.status).toHaveBeenCalledWith(503);
    expect(lateResponse.end).toHaveBeenCalledOnce();
    expect((await reader.read()).done).toBe(true);
    for (const progressReader of progressReaders) {
      expect((await progressReader.read()).done).toBe(true);
    }
    expect(dispose).not.toHaveBeenCalled();
    release();
    const response = await pending;
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([]);
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    expect(exit).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(lifecycle.cleanup).toHaveBeenCalledTimes(1);
    expect(lifecycle.disposeJob).toHaveBeenCalledTimes(2);
  });
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
