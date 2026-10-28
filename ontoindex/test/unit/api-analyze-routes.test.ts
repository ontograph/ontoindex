import { EventEmitter } from 'events';
import type { Server } from 'http';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChildProcess } from 'child_process';
import { JobManager } from '../../src/server/analyze-job.js';
import { mountAnalyzeRoutes } from '../../src/server/api-analyze-routes.js';
import { MAX_GIT_URL_LENGTH } from '../../src/server/git-clone.js';

const forkMockState = vi.hoisted(() => ({
  fork: vi.fn(),
}));

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, fork: forkMockState.fork };
});

describe('mountAnalyzeRoutes cancellation lifecycle', () => {
  let server: Server | undefined;
  let jobManager: JobManager;

  beforeEach(() => {
    forkMockState.fork.mockReset();
    jobManager = new JobManager();
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

  it.each([MAX_GIT_URL_LENGTH + 1, 200_000])(
    'rejects a %i-character URL before creating a job',
    async (length) => {
      const app = express();
      app.use(express.json({ limit: '10mb' }));
      const createJob = vi.spyOn(jobManager, 'createJob');
      const acquireRepoLock = vi.fn(() => 'busy');
      mountAnalyzeRoutes(
        app,
        jobManager,
        { init: vi.fn().mockResolvedValue(true) },
        acquireRepoLock,
        vi.fn(),
      );
      const baseUrl = await listen(app);
      const response = await fetch(`${baseUrl}/api/analyze`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: 'a'.repeat(length) }),
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: '"url" is too long' });
      expect(createJob).not.toHaveBeenCalled();
      expect(acquireRepoLock).not.toHaveBeenCalled();
      expect(forkMockState.fork).not.toHaveBeenCalled();
      createJob.mockRestore();
    },
  );

  it('allows a URL at the length limit to reach job creation', async () => {
    const app = express();
    app.use(express.json());
    const createJob = vi.spyOn(jobManager, 'createJob').mockImplementation(() => {
      throw new Error('job creation reached');
    });
    mountAnalyzeRoutes(
      app,
      jobManager,
      { init: vi.fn().mockResolvedValue(true) },
      vi.fn(() => 'busy'),
      vi.fn(),
    );
    const baseUrl = await listen(app);
    const url = `https://example.com/${'a'.repeat(MAX_GIT_URL_LENGTH - 20)}`;
    expect(url).toHaveLength(MAX_GIT_URL_LENGTH);
    const response = await fetch(`${baseUrl}/api/analyze`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    expect(response.status).toBe(500);
    expect(createJob).toHaveBeenCalledWith({ repoUrl: url, repoPath: undefined });
    createJob.mockRestore();
  });

  it('keeps the repo write lock until a cancelled analyze child exits', async () => {
    const app = express();
    app.use(express.json());

    const child = new EventEmitter() as ChildProcess & {
      stderr: EventEmitter;
      send: ReturnType<typeof vi.fn>;
      kill: ReturnType<typeof vi.fn>;
    };
    child.stderr = new EventEmitter();
    child.send = vi.fn();
    child.kill = vi.fn(() => true);
    forkMockState.fork.mockReturnValue(child);

    const repoPath = path.join(os.tmpdir(), 'ontoindex-analyze-route-test');
    const lock = { repoPath, token: Symbol('lock') };
    const acquireRepoLock = vi.fn(() => lock);
    const releaseRepoLock = vi.fn();

    mountAnalyzeRoutes(
      app,
      jobManager,
      { init: vi.fn().mockResolvedValue(true) },
      acquireRepoLock,
      releaseRepoLock,
    );
    const baseUrl = await listen(app);

    const startResponse = await fetch(`${baseUrl}/api/analyze`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: repoPath }),
    });
    expect(startResponse.status).toBe(202);
    const { jobId } = (await startResponse.json()) as { jobId: string };
    expect(acquireRepoLock).toHaveBeenCalledTimes(1);

    const cancelResponse = await fetch(`${baseUrl}/api/analyze/${jobId}`, { method: 'DELETE' });
    expect(cancelResponse.status).toBe(200);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(releaseRepoLock).not.toHaveBeenCalled();

    child.emit('message', { type: 'error', message: 'Cancelled by user' });
    expect(releaseRepoLock).not.toHaveBeenCalled();

    child.emit('exit', null, 'SIGTERM');

    expect(releaseRepoLock).toHaveBeenCalledTimes(1);
    expect(releaseRepoLock).toHaveBeenCalledWith(lock);
  });

  it('does not retry an analysis worker after disposal', async () => {
    const app = express();
    app.use(express.json());
    const child = new EventEmitter() as ChildProcess;
    child.send = vi.fn();
    child.kill = vi.fn(() => {
      child.emit('exit', null, 'SIGTERM');
      return true;
    });
    forkMockState.fork.mockReturnValue(child);
    const lock = { repoPath: path.join(os.tmpdir(), 'disposal-route'), token: Symbol('lock') };
    const release = vi.fn();
    mountAnalyzeRoutes(
      app,
      jobManager,
      { init: vi.fn().mockResolvedValue(true) },
      () => lock,
      release,
    );
    const base = await listen(app);
    const response = await fetch(`${base}/api/analyze`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: lock.repoPath }),
    });
    expect(response.status).toBe(202);
    await response.json();
    vi.useFakeTimers();
    try {
      const disposed = jobManager.dispose();
      await vi.advanceTimersByTimeAsync(1_100);
      await disposed;
      expect(forkMockState.fork).toHaveBeenCalledOnce();
      expect(release).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('ends an active progress stream and unregisters its shutdown cleanup idempotently', async () => {
    const app = express();
    const cleanups = new Set<() => void>();
    mountAnalyzeRoutes(
      app,
      jobManager,
      { init: vi.fn().mockResolvedValue(true) },
      vi.fn(() => 'busy'),
      vi.fn(),
      (cleanup) => {
        cleanups.add(cleanup);
        return () => cleanups.delete(cleanup);
      },
    );
    const job = jobManager.createJob({ repoPath: '/tmp/analyze-progress' });
    jobManager.updateJob(job.id, { status: 'analyzing' });
    const baseUrl = await listen(app);

    const response = await fetch(`${baseUrl}/api/analyze/${job.id}/progress`);
    const reader = response.body!.getReader();
    expect((await reader.read()).done).toBe(false);
    expect(cleanups.size).toBe(1);

    const cleanup = [...cleanups][0]!;
    cleanup();
    cleanup();

    expect((await reader.read()).done).toBe(true);
    expect(cleanups.size).toBe(0);
  });
});
