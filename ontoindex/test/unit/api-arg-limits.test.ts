import type { Server } from 'node:http';
import express from 'express';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createServer } from '../../src/server/api.js';
import { evalServerArgumentError } from '../../src/cli/eval-server.js';
import { LocalBackend } from '../../src/mcp/local/local-backend.js';

const mocks = vi.hoisted(() => ({ repos: vi.fn(async () => []), query: vi.fn() }));
vi.mock('../../src/storage/repo-manager.js', async (original) => ({
  ...(await original<typeof import('../../src/storage/repo-manager.js')>()),
  listRegisteredRepos: mocks.repos,
}));
vi.mock('../../src/core/lbug/lbug-adapter.js', async (original) => ({
  ...(await original<typeof import('../../src/core/lbug/lbug-adapter.js')>()),
  executeQuery: mocks.query,
}));
vi.mock('../../src/server/analyze-job.js', () => ({
  JobManager: class {
    async init() {}
    async dispose() {}
  },
}));
vi.mock('../../src/server/mcp-http.js', () => ({
  mountMCPEndpoints: () => ({ cleanup: async () => {}, getDiagnostics: vi.fn() }),
}));

let server: Server;
let base: string;
const signals = new Map((['SIGINT', 'SIGTERM'] as const).map((s) => [s, process.listeners(s)]));
beforeEach(async () => {
  vi.stubEnv('ONTOINDEX_HTTP_TOKEN', 'limit-test');
  vi.spyOn(LocalBackend.prototype, 'init').mockResolvedValue(undefined);
  const listen = express.application.listen;
  vi.spyOn(express.application, 'listen').mockImplementation(function (...args: unknown[]) {
    server = Reflect.apply(listen, this, args) as Server;
    return server;
  } as typeof listen);
  await createServer(0);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP address');
  base = `http://127.0.0.1:${address.port}`;
  mocks.repos.mockClear();
  mocks.query.mockClear();
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const [signal, listeners] of signals) {
    for (const listener of process.listeners(signal))
      if (!listeners.includes(listener)) process.removeListener(signal, listener);
  }
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
const post = (route: string, body: unknown) =>
  fetch(`${base}/api/${route}`, {
    method: 'POST',
    headers: { Authorization: 'Bearer limit-test', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
it.each([
  ['search', 'query'],
  ['query', 'cypher'],
])('rejects oversized %s before repository or database access', async (route, key) => {
  const response = await post(route, { [key]: 'x'.repeat(3 * 1024 * 1024) });
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({
    error: `Invalid arguments: ${key}: string longer than 2097152 characters`,
  });
  expect(mocks.repos).not.toHaveBeenCalled();
  expect(mocks.query).not.toHaveBeenCalled();
});
it('honors a lower configured cap', async () => {
  vi.stubEnv('ONTOINDEX_MAX_ARG_CHARS', '2048');
  expect((await post('search', { query: 'x'.repeat(2049) })).status).toBe(400);
  expect(mocks.repos).not.toHaveBeenCalled();
});
it('allows a 1 MB search to reach repository lookup', async () => {
  expect((await post('search', { query: 'x'.repeat(1024 * 1024 - 64) })).status).toBe(404);
  expect(mocks.repos).toHaveBeenCalledOnce();
});
it('reports eval tool argument errors using the same configured cap', () => {
  vi.stubEnv('ONTOINDEX_MAX_ARG_CHARS', '2048');
  expect(evalServerArgumentError('query', { query: 'x'.repeat(2049) })).toBe(
    'Error: Invalid arguments for query: query: string longer than 2048 characters',
  );
  expect(evalServerArgumentError('query', { query: 'x'.repeat(2048) })).toBeUndefined();
  expect(evalServerArgumentError('query', null)).toBeUndefined();
});
