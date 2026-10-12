import type { Server } from 'node:http';
import fs from 'node:fs/promises';
import express from 'express';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createServer } from '../../src/server/api.js';
import { LocalBackend } from '../../src/mcp/local/local-backend.js';

const mocks = vi.hoisted(() => ({ close: vi.fn(), unregister: vi.fn() }));
vi.mock('../../src/storage/repo-manager.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/storage/repo-manager.js')>()),
  listRegisteredRepos: async () => [
    { name: 'repo', path: '/fixture/repo', storagePath: '/fixture/repo/.ontoindex' },
  ],
  resolveActiveLbugPath: async () => '/fixture/repo/.ontoindex/active.lbug',
  unregisterRepo: mocks.unregister,
}));
vi.mock('../../src/core/lbug/lbug-adapter.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/core/lbug/lbug-adapter.js')>()),
  closeLbugForPath: mocks.close,
}));
vi.mock('../../src/server/git-clone.js', () => ({ getCloneDir: () => '/fixture/clones/repo' }));
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
let base: string;
let removing: boolean;
const originalSignals = new Map(
  (['SIGINT', 'SIGTERM'] as const).map((signal) => [signal, process.listeners(signal)]),
);

beforeEach(async () => {
  vi.stubEnv('ONTOINDEX_HTTP_TOKEN', 'removal-test-token');
  removing = false;
  mocks.close.mockReset().mockImplementation(async () => {
    expect(removing).toBe(true);
  });
  mocks.unregister.mockReset().mockImplementation(async () => {
    expect(removing).toBe(true);
  });
  vi.spyOn(LocalBackend.prototype, 'init').mockImplementation(async () => {
    expect(removing).toBe(false);
  });
  vi.spyOn(LocalBackend.prototype, 'withRepoRemoval').mockImplementation(
    async (_name, _path, operation) => {
      removing = true;
      try {
        return await operation();
      } finally {
        removing = false;
      }
    },
  );
  const listen = express.application.listen;
  vi.spyOn(express.application, 'listen').mockImplementation(function (...args: unknown[]) {
    server = Reflect.apply(listen, this, args) as Server;
    return server;
  } as typeof listen);
  await createServer(0);
  const address = server!.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP address');
  base = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  try {
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server!.close((error) => (error ? reject(error) : resolve())),
      );
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

const remove = () =>
  fetch(`${base}/api/repo?repo=repo`, {
    method: 'DELETE',
    headers: { Authorization: 'Bearer removal-test-token' },
  });

it('strict close failure prevents deletion and unregistering', async () => {
  mocks.close.mockRejectedValueOnce(new Error('close failed'));
  const rm = vi.spyOn(fs, 'rm').mockResolvedValue(undefined);
  const response = await remove();
  expect(response.status).toBe(500);
  expect(await response.json()).toEqual({ error: 'close failed' });
  expect(mocks.close).toHaveBeenCalledWith('/fixture/repo/.ontoindex/active.lbug', {
    strict: true,
  });
  expect(rm).not.toHaveBeenCalled();
  expect(mocks.unregister).not.toHaveBeenCalled();
});

it('reports filesystem failure and retains registration', async () => {
  vi.spyOn(fs, 'rm').mockRejectedValueOnce(new Error('delete failed'));
  const response = await remove();
  expect(response.status).toBe(500);
  expect(await response.json()).toEqual({ error: 'delete failed' });
  expect(mocks.unregister).not.toHaveBeenCalled();
});

it('removes within the barrier, preserves unrelated same-name clones, and refreshes afterward', async () => {
  const rm = vi.spyOn(fs, 'rm').mockImplementation(async () => {
    expect(removing).toBe(true);
  });
  const stat = vi.spyOn(fs, 'stat');
  const response = await remove();
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ deleted: 'repo' });
  expect(mocks.close.mock.calls).toEqual([
    ['/fixture/repo/.ontoindex/active.lbug', { strict: true }],
    ['/fixture/repo/.ontoindex/lbug', { strict: true }],
  ]);
  expect(rm.mock.calls).toEqual([['/fixture/repo/.ontoindex', { recursive: true, force: true }]]);
  expect(stat).not.toHaveBeenCalledWith('/fixture/clones/repo');
  expect(mocks.unregister).toHaveBeenCalledWith('/fixture/repo');
  expect(LocalBackend.prototype.init).toHaveBeenCalledTimes(2);
});
