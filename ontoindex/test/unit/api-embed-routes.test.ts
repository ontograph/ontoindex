import type { Server } from 'http';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JobManager } from '../../src/server/analyze-job.js';
import { mountEmbedRoutes } from '../../src/server/api-embed-routes.js';

const embedMocks = vi.hoisted(() => ({
  executeQuery: vi.fn(),
  executeWithReusedStatement: vi.fn(),
  fetchExistingEmbeddingHashes: vi.fn(),
  runEmbeddingPipeline: vi.fn(),
  withLbugDb: vi.fn((_lbugPath: string, run: () => unknown) => run()),
}));

vi.mock('../../src/core/lbug/lbug-adapter.js', () => ({
  executeQuery: embedMocks.executeQuery,
  executeWithReusedStatement: embedMocks.executeWithReusedStatement,
  fetchExistingEmbeddingHashes: embedMocks.fetchExistingEmbeddingHashes,
  withLbugDb: embedMocks.withLbugDb,
}));

vi.mock('../../src/core/embeddings/embedding-pipeline.js', () => ({
  runEmbeddingPipeline: embedMocks.runEmbeddingPipeline,
}));

describe('mountEmbedRoutes', () => {
  let server: Server | undefined;
  let jobManager: JobManager;

  beforeEach(() => {
    vi.clearAllMocks();
    jobManager = new JobManager();
    embedMocks.fetchExistingEmbeddingHashes.mockResolvedValue(new Map());
    embedMocks.runEmbeddingPipeline.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      if (!server) {
        resolve();
        return;
      }
      server.close((err) => (err ? reject(err) : resolve()));
    });
    server = undefined;
    await jobManager.dispose();
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

  const waitFor = async (condition: () => boolean): Promise<void> => {
    for (let i = 0; i < 25; i++) {
      if (condition()) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error('Timed out waiting for condition');
  };

  const mount = async (
    overrides: {
      resolveRepo?: Parameters<typeof mountEmbedRoutes>[2];
      acquireRepoLock?: Parameters<typeof mountEmbedRoutes>[4];
      releaseRepoLock?: Parameters<typeof mountEmbedRoutes>[5];
    } = {},
  ) => {
    const app = express();
    app.use(express.json());
    const lock = { repoPath: '/tmp/ontoindex-embed-route-test/storage', token: Symbol('lock') };
    const releaseRepoLock = overrides.releaseRepoLock ?? vi.fn();
    mountEmbedRoutes(
      app,
      jobManager,
      overrides.resolveRepo ??
        vi.fn().mockResolvedValue({
          name: 'repo',
          storagePath: '/tmp/ontoindex-embed-route-test/storage',
        }),
      () => 'repo',
      overrides.acquireRepoLock ?? vi.fn(() => lock),
      releaseRepoLock,
    );
    return { baseUrl: await listen(app), lock, releaseRepoLock };
  };

  it('returns 404 when the requested repo is missing', async () => {
    const { baseUrl } = await mount({ resolveRepo: vi.fn().mockResolvedValue(null) });

    const response = await fetch(`${baseUrl}/api/embed`, { method: 'POST' });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Repository not found' });
    expect(embedMocks.runEmbeddingPipeline).not.toHaveBeenCalled();
  });

  it('starts an embedding job with analyzing status and releases the repo lock on completion', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    embedMocks.fetchExistingEmbeddingHashes.mockResolvedValue(
      new Map([['Function:existing:src/a.ts', 'abc123']]),
    );
    embedMocks.runEmbeddingPipeline.mockImplementation(async (_query, _stmt, onProgress) => {
      onProgress({ phase: 'loading-model', percent: 5 });
      onProgress({ phase: 'embedding', percent: 42 });
      onProgress({ phase: 'indexing', percent: 90 });
      onProgress({ phase: 'ready', percent: 100 });
    });
    const { baseUrl, lock, releaseRepoLock } = await mount();

    const response = await fetch(`${baseUrl}/api/embed`, { method: 'POST' });

    expect(response.status).toBe(202);
    const body = (await response.json()) as { jobId: string; status: string };
    expect(body.status).toBe('analyzing');

    await waitFor(() => jobManager.getJob(body.jobId)?.status === 'complete');
    const job = jobManager.getJob(body.jobId);
    expect(job?.repoName).toBe('repo');
    expect(job?.progress).toEqual({
      phase: 'complete',
      percent: 100,
      message: 'Embeddings complete',
    });
    expect(releaseRepoLock).toHaveBeenCalledTimes(1);
    expect(releaseRepoLock).toHaveBeenCalledWith(lock);
    expect(logSpy).toHaveBeenCalledWith(
      '[embed] 1 nodes already embedded — incremental run with content-hash comparison',
    );
    logSpy.mockRestore();
  });

  it('preserves failed-job state and fallback message when the async pipeline rejects a non-Error', async () => {
    embedMocks.runEmbeddingPipeline.mockRejectedValue('primitive failure');
    const { baseUrl, releaseRepoLock } = await mount();

    const response = await fetch(`${baseUrl}/api/embed`, { method: 'POST' });

    expect(response.status).toBe(202);
    const { jobId } = (await response.json()) as { jobId: string };
    await waitFor(() => jobManager.getJob(jobId)?.status === 'failed');
    expect(jobManager.getJob(jobId)?.error).toBe('Embedding generation failed');
    expect(releaseRepoLock).toHaveBeenCalledTimes(1);
  });

  it('returns 409 for already-in-progress start errors', async () => {
    const { baseUrl } = await mount({
      acquireRepoLock: vi.fn(() => {
        throw { message: 'Embedding already in progress for this repository' };
      }),
    });

    const response = await fetch(`${baseUrl}/api/embed`, { method: 'POST' });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: 'Embedding already in progress for this repository',
    });
  });

  it('uses the 500 fallback message for non-Error start failures', async () => {
    const app = express();
    app.use(express.json());
    mountEmbedRoutes(
      app,
      jobManager,
      vi.fn().mockRejectedValue('primitive failure'),
      () => 'repo',
      vi.fn(() => ({
        repoPath: '/tmp/ontoindex-embed-route-test/storage',
        token: Symbol('lock'),
      })),
      vi.fn(),
    );
    const baseUrl = await listen(app);

    const response = await fetch(`${baseUrl}/api/embed`, { method: 'POST' });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Failed to start embedding generation' });
  });
});
