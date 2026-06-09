import express from 'express';
import path from 'path';
import { fork } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';
import { createRequire } from 'node:module';
import { JobManager } from './analyze-job.js';
import { getStoragePath } from '../storage/repo-manager.js';
import { extractRepoName, getCloneDir, cloneOrPull } from './git-clone.js';

const _require = createRequire(import.meta.url);
const BACKEND_RELOAD_TIMEOUT_MS = 30_000;

interface RepoWriteLock {
  repoPath: string;
  token: symbol;
}

interface WorkerProgressMessage {
  type: 'progress';
  phase: string;
  percent: number;
  message: string;
}

interface WorkerCompleteMessage {
  type: 'complete';
  result: {
    repoName: string;
  };
}

interface WorkerErrorMessage {
  type: 'error';
  message: string;
}

type AnalyzeWorkerMessage = WorkerProgressMessage | WorkerCompleteMessage | WorkerErrorMessage;

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isAnalyzeWorkerMessage(msg: unknown): msg is AnalyzeWorkerMessage {
  if (!isUnknownRecord(msg)) return false;
  switch (msg.type) {
    case 'progress':
      return (
        typeof msg.phase === 'string' &&
        typeof msg.percent === 'number' &&
        typeof msg.message === 'string'
      );
    case 'complete':
      return isUnknownRecord(msg.result) && typeof msg.result.repoName === 'string';
    case 'error':
      return typeof msg.message === 'string';
    default:
      return false;
  }
}

function withTimeout<T>(
  run: (signal: AbortSignal) => Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort(new Error(`${label} timed out after ${ms}ms`));
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);
  });
  return Promise.race([run(controller.signal), timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

type ReloadableBackend = {
  init(options?: { signal?: AbortSignal }): Promise<boolean>;
};

function reloadBackendWithTimeout(backend: ReloadableBackend): Promise<boolean> {
  return withTimeout(
    (signal) => backend.init({ signal }),
    BACKEND_RELOAD_TIMEOUT_MS,
    'backend.init',
  );
}

function isAbortError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === 'AbortError' || err.message.includes('backend.init timed out'))
  );
}

function reloadErrorMessage(err: unknown): string {
  if (isAbortError(err)) {
    return 'Server reload timed out after analysis. Try again.';
  }
  return 'Server failed to reload after analysis. Try again.';
}

function thrownMessage(err: unknown): string | undefined {
  if (err instanceof Error) return err.message;
  if (typeof err !== 'object' || err === null || !('message' in err)) return undefined;
  const { message } = err as { message?: unknown };
  return message ? String(message) : undefined;
}

function thrownMessageOrFallback(err: unknown, fallback: string): string {
  return thrownMessage(err) || fallback;
}

export function mountAnalyzeRoutes(
  app: express.Application,
  jobManager: JobManager,
  backend: ReloadableBackend,
  acquireRepoLock: (repoPath: string) => RepoWriteLock | string,
  releaseRepoLock: (lock: RepoWriteLock) => void,
): void {
  // POST /api/analyze — start a new analysis job
  app.post('/api/analyze', async (req, res) => {
    try {
      const { url: repoUrl, path: repoLocalPath, force, embeddings } = req.body;

      // Input type validation
      if (repoUrl !== undefined && typeof repoUrl !== 'string') {
        res.status(400).json({ error: '"url" must be a string' });
        return;
      }
      if (repoLocalPath !== undefined && typeof repoLocalPath !== 'string') {
        res.status(400).json({ error: '"path" must be a string' });
        return;
      }

      if (!repoUrl && !repoLocalPath) {
        res.status(400).json({ error: 'Provide "url" (git URL) or "path" (local path)' });
        return;
      }

      // Path validation: require absolute path, reject traversal (e.g. /tmp/../etc/passwd)
      if (repoLocalPath) {
        if (!path.isAbsolute(repoLocalPath)) {
          res.status(400).json({ error: '"path" must be an absolute path' });
          return;
        }
        if (path.normalize(repoLocalPath) !== path.resolve(repoLocalPath)) {
          res.status(400).json({ error: '"path" must not contain traversal sequences' });
          return;
        }
      }

      const job = jobManager.createJob({ repoUrl, repoPath: repoLocalPath });

      // If job was already running (dedup), just return its id
      if (job.status !== 'queued') {
        res.status(202).json({ jobId: job.id, status: job.status });
        return;
      }

      // Mark as active synchronously to prevent race with concurrent requests
      jobManager.updateJob(job.id, { status: 'cloning' });

      // Start async work — don't await
      (async () => {
        let targetPath = repoLocalPath;
        let analyzeLock: RepoWriteLock | null = null;
        let unregisterCancelHandler: (() => void) | null = null;
        let retryTimer: ReturnType<typeof setTimeout> | null = null;
        const clearRetryTimer = () => {
          if (!retryTimer) return;
          clearTimeout(retryTimer);
          retryTimer = null;
        };
        try {
          // Clone if URL provided
          if (repoUrl && !repoLocalPath) {
            const repoName = extractRepoName(repoUrl);
            targetPath = getCloneDir(repoName);
            const cloneAbort = new AbortController();
            unregisterCancelHandler = jobManager.registerCancelHandler(job.id, () => {
              cloneAbort.abort(new Error('Cancelled by user'));
            });

            jobManager.updateJob(job.id, {
              status: 'cloning',
              repoName,
              progress: { phase: 'cloning', percent: 0, message: `Cloning ${repoUrl}...` },
            });

            try {
              await cloneOrPull(
                repoUrl,
                targetPath,
                (progress) => {
                  jobManager.updateJob(job.id, {
                    progress: { phase: progress.phase, percent: 5, message: progress.message },
                  });
                },
                { signal: cloneAbort.signal },
              );
            } finally {
              unregisterCancelHandler?.();
              unregisterCancelHandler = null;
            }
          }

          if (!targetPath) {
            throw new Error('No target path resolved');
          }

          // Acquire shared repo lock (keyed on storagePath to match embed handler)
          const analyzeLockKey = getStoragePath(targetPath);
          const lock = acquireRepoLock(analyzeLockKey);
          if (typeof lock === 'string') {
            jobManager.updateJob(job.id, { status: 'failed', error: lock });
            return;
          }
          analyzeLock = lock;

          jobManager.updateJob(job.id, { repoPath: targetPath, status: 'analyzing' });

          // ── Worker fork with auto-retry ──────────────────────────────
          //
          // Forks a child process with 8GB heap. If the worker crashes
          // (OOM, native addon segfault, etc.), it retries up to
          // MAX_WORKER_RETRIES times with exponential backoff before
          // marking the job as permanently failed.
          //
          // In dev mode (tsx), registers the tsx ESM hook via a file://
          // URL so the child can compile TypeScript on-the-fly.

          const MAX_WORKER_RETRIES = 2;
          const callerPath = fileURLToPath(import.meta.url);
          const isDev = callerPath.endsWith('.ts');
          const workerFile = isDev ? 'analyze-worker.ts' : 'analyze-worker.js';
          const workerPath = path.join(path.dirname(callerPath), workerFile);
          const tsxHookArgs: string[] = isDev
            ? ['--import', pathToFileURL(_require.resolve('tsx/esm')).href]
            : [];

          let workerCompleted = false;
          let lockReleased = false;
          const releaseAnalyzeLock = () => {
            if (lockReleased) return;
            lockReleased = true;
            clearRetryTimer();
            unregisterCancelHandler?.();
            unregisterCancelHandler = null;
            if (analyzeLock) {
              releaseRepoLock(analyzeLock);
              analyzeLock = null;
            }
          };
          let workerProcessActive = false;
          unregisterCancelHandler = jobManager.registerCancelHandler(job.id, () => {
            clearRetryTimer();
            if (!workerProcessActive) {
              releaseAnalyzeLock();
            }
          });

          const forkWorker = () => {
            retryTimer = null;
            const currentJob = jobManager.getJob(job.id);
            if (!currentJob || currentJob.status === 'complete' || currentJob.status === 'failed') {
              releaseAnalyzeLock();
              return;
            }

            const child = fork(workerPath, [], {
              execArgv: [...tsxHookArgs, '--max-old-space-size=8192'],
              stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
            });
            workerProcessActive = true;

            // Capture stderr for crash diagnostics
            let stderrChunks = '';
            child.stderr?.on('data', (chunk: Buffer) => {
              stderrChunks += chunk.toString();
              if (stderrChunks.length > 4096) stderrChunks = stderrChunks.slice(-4096);
            });

            child.on('message', (msg: unknown) => {
              if (!isAnalyzeWorkerMessage(msg)) return;

              if (msg.type === 'progress') {
                jobManager.updateJob(job.id, {
                  status: 'analyzing',
                  progress: { phase: msg.phase, percent: msg.percent, message: msg.message },
                });
              } else if (msg.type === 'complete') {
                workerCompleted = true;
                releaseAnalyzeLock();
                // Reinitialize backend BEFORE marking complete — ensures the new
                // repo is queryable when the client receives the SSE complete event.
                reloadBackendWithTimeout(backend)
                  .then(() => {
                    const currentJob = jobManager.getJob(job.id);
                    if (!currentJob || currentJob.status === 'failed') return;
                    jobManager.updateJob(job.id, {
                      status: 'complete',
                      repoName: msg.result.repoName,
                    });
                  })
                  .catch((err) => {
                    console.error('backend.init() failed after analyze:', err);
                    jobManager.updateJob(job.id, {
                      status: 'failed',
                      error: reloadErrorMessage(err),
                    });
                  });
              } else if (msg.type === 'error') {
                if (!workerProcessActive) {
                  releaseAnalyzeLock();
                }
                jobManager.updateJob(job.id, {
                  status: 'failed',
                  error: msg.message,
                });
              }
            });

            child.on('error', (err) => {
              releaseAnalyzeLock();
              jobManager.updateJob(job.id, {
                status: 'failed',
                error: `Worker process error: ${err.message}`,
              });
            });

            child.on('exit', (code) => {
              workerProcessActive = false;
              const j = jobManager.getJob(job.id);
              if (workerCompleted) return;
              if (!j || j.status === 'complete' || j.status === 'failed') return;

              // Worker crashed — attempt retry if under the limit
              if (j.retryCount < MAX_WORKER_RETRIES) {
                j.retryCount++;
                const delay = 1000 * Math.pow(2, j.retryCount - 1); // 1s, 2s
                const lastErr = stderrChunks.trim().split('\n').pop() || '';
                console.warn(
                  `Analyze worker crashed (code ${code}), retry ${j.retryCount}/${MAX_WORKER_RETRIES} in ${delay}ms` +
                    (lastErr ? `: ${lastErr}` : ''),
                );
                jobManager.updateJob(job.id, {
                  status: 'analyzing',
                  progress: {
                    phase: 'retrying',
                    percent: j.progress.percent,
                    message: `Worker crashed, retrying (${j.retryCount}/${MAX_WORKER_RETRIES})...`,
                  },
                });
                stderrChunks = '';
                clearRetryTimer();
                retryTimer = setTimeout(forkWorker, delay);
                retryTimer.unref?.();
              } else {
                // Exhausted retries — permanent failure
                releaseAnalyzeLock();
                jobManager.updateJob(job.id, {
                  status: 'failed',
                  error: `Worker crashed ${MAX_WORKER_RETRIES + 1} times (code ${code})${stderrChunks ? ': ' + stderrChunks.trim().split('\n').pop() : ''}`,
                });
              }
            });

            // Register child for cancellation + timeout tracking
            jobManager.registerChild(job.id, child, {
              onTerminalExit: releaseAnalyzeLock,
            });

            // Send start command to child
            child.send({
              type: 'start',
              repoPath: targetPath,
              options: { force: !!force, embeddings: !!embeddings },
            });
          };

          forkWorker();
        } catch (err: unknown) {
          clearRetryTimer();
          unregisterCancelHandler?.();
          if (analyzeLock) releaseRepoLock(analyzeLock);
          jobManager.updateJob(job.id, {
            status: 'failed',
            error: thrownMessageOrFallback(err, 'Analysis failed'),
          });
        }
      })();

      res.status(202).json({ jobId: job.id, status: job.status });
    } catch (err: unknown) {
      const message = thrownMessage(err);
      if (message?.includes('already in progress')) {
        res.status(409).json({ error: message });
      } else {
        res.status(500).json({ error: message || 'Failed to start analysis' });
      }
    }
  });

  // GET /api/analyze/:jobId — poll job status
  app.get('/api/analyze/:jobId', (req, res) => {
    const job = jobManager.getJob(req.params.jobId);
    if (!job) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }
    res.json({
      id: job.id,
      status: job.status,
      repoUrl: job.repoUrl,
      repoPath: job.repoPath,
      repoName: job.repoName,
      progress: job.progress,
      error: job.error,
      startedAt: job.startedAt,
      completedAt: job.completedAt,
    });
  });

  // GET /api/analyze/:jobId/progress — SSE stream (shared helper)
  app.get('/api/analyze/:jobId/progress', (req, res) => {
    const job = jobManager.getJob(req.params.jobId);
    if (!job) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }

    let eventId = 0;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    // Send current state immediately
    eventId++;
    res.write(`id: ${eventId}\ndata: ${JSON.stringify(job.progress)}\n\n`);

    // If already terminal, send event and close
    if (job.status === 'complete' || job.status === 'failed') {
      eventId++;
      res.write(
        `id: ${eventId}\nevent: ${job.status}\ndata: ${JSON.stringify({
          repoName: job.repoName,
          error: job.error,
        })}\n\n`,
      );
      res.end();
      return;
    }

    // Heartbeat to detect zombie connections
    const heartbeat = setInterval(() => {
      try {
        res.write(':heartbeat\n\n');
      } catch {
        clearInterval(heartbeat);
        unsubscribe();
      }
    }, 30_000);

    // Subscribe to progress updates
    const unsubscribe = jobManager.onProgress(job.id, (progress) => {
      try {
        eventId++;
        if (progress.phase === 'complete' || progress.phase === 'failed') {
          const eventJob = jobManager.getJob(req.params.jobId);
          res.write(
            `id: ${eventId}\nevent: ${progress.phase}\ndata: ${JSON.stringify({
              repoName: eventJob?.repoName,
              error: eventJob?.error,
            })}\n\n`,
          );
          clearInterval(heartbeat);
          res.end();
          unsubscribe();
        } else {
          res.write(`id: ${eventId}\ndata: ${JSON.stringify(progress)}\n\n`);
        }
      } catch {
        clearInterval(heartbeat);
        unsubscribe();
      }
    });

    req.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  // DELETE /api/analyze/:jobId — cancel a running analysis job
  app.delete('/api/analyze/:jobId', (req, res) => {
    const job = jobManager.getJob(req.params.jobId);
    if (!job) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }
    if (job.status === 'complete' || job.status === 'failed') {
      res.status(400).json({ error: `Job already ${job.status}` });
      return;
    }
    jobManager.cancelJob(req.params.jobId, 'Cancelled by user');
    res.json({ id: job.id, status: 'failed', error: 'Cancelled by user' });
  });
}
