import { EventEmitter } from 'events';
import type { Server } from 'http';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChildProcess } from 'child_process';
import { JobManager } from '../../src/server/analyze-job.js';
import { mountAnalyzeRoutes } from '../../src/server/api-analyze-routes.js';

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
});
