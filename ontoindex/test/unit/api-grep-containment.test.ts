import type { Server } from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterEach, expect, it, vi } from 'vitest';
import { createServer } from '../../src/server/api.js';
import { LocalBackend } from '../../src/mcp/local/local-backend.js';

const mocks = vi.hoisted(() => ({ listRegisteredRepos: vi.fn(), executeQuery: vi.fn() }));
vi.mock('../../src/storage/repo-manager.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/storage/repo-manager.js')>()),
  listRegisteredRepos: mocks.listRegisteredRepos,
}));
vi.mock('../../src/core/lbug/lbug-adapter.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/core/lbug/lbug-adapter.js')>()),
  executeQuery: mocks.executeQuery,
  withLbugDb: async (_path: string, operation: () => Promise<unknown>) => operation(),
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

let server: Server | undefined;
let fixture: string | undefined;
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
    if (fixture) await fs.rm(fixture, { recursive: true, force: true });
  } finally {
    server = undefined;
    fixture = undefined;
    for (const [signal, listeners] of originalSignals) {
      for (const listener of process.listeners(signal)) {
        if (!listeners.includes(listener)) process.removeListener(signal, listener);
      }
    }
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  }
});

it('/api/grep skips indexed files replaced by external symlinks and allows internal symlinks', async () => {
  fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'ontoindex-grep-'));
  const repo = path.join(fixture, 'repo');
  await fs.mkdir(repo);
  await fs.writeFile(path.join(repo, 'indexed.txt'), 'needle indexed\n');
  await fs.writeFile(path.join(repo, 'internal.txt'), 'needle internal\n');
  await fs.writeFile(path.join(fixture, 'external.txt'), 'needle external secret\n');
  mocks.listRegisteredRepos.mockResolvedValue([
    {
      name: 'repo',
      path: repo,
      storagePath: path.join(repo, '.ontoindex'),
    },
  ]);
  mocks.executeQuery.mockResolvedValue([{ filePath: 'indexed.txt' }, { filePath: 'link.txt' }]);
  await fs.unlink(path.join(repo, 'indexed.txt'));
  await fs.symlink(path.join(fixture, 'external.txt'), path.join(repo, 'indexed.txt'));
  await fs.symlink(path.join(repo, 'internal.txt'), path.join(repo, 'link.txt'));

  vi.stubEnv('ONTOINDEX_HTTP_TOKEN', 'grep-test-token');
  vi.spyOn(LocalBackend.prototype, 'init').mockResolvedValue(undefined);
  const listen = express.application.listen;
  vi.spyOn(express.application, 'listen').mockImplementation(function (...args: unknown[]) {
    server = Reflect.apply(listen, this, args) as Server;
    return server;
  } as typeof listen);
  await createServer(0);
  const address = server!.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP address');
  const response = await fetch(
    `http://127.0.0.1:${address.port}/api/grep?repo=repo&pattern=needle`,
    {
      headers: { Authorization: 'Bearer grep-test-token' },
    },
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    results: [{ filePath: 'link.txt', line: 1, text: 'needle internal' }],
  });
  await fs.mkdir(path.join(repo, '.git'));
  await fs.writeFile(path.join(repo, '.git/config'), 'private git config');
  await fs.symlink(path.join(repo, '.git/config'), path.join(repo, 'config-alias'));
  for (const file of ['.git/config', 'config-alias']) {
    const denied = await fetch(`http://127.0.0.1:${address.port}/api/file?repo=repo&path=${file}`, {
      headers: { Authorization: 'Bearer grep-test-token' },
    });
    expect(denied.status).toBe(403);
  }
  const oversized = await fetch(`http://127.0.0.1:${address.port}/api/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: 'x'.repeat(11 * 1024 * 1024) }),
  });
  expect(oversized.status).toBe(413);
  expect(await oversized.json()).toEqual({ error: 'Request body too large' });
  const malformed = await fetch(`http://127.0.0.1:${address.port}/api/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{',
  });
  expect(malformed.status).toBe(400);
});
