import express from 'express';
import path from 'path';
import { JobManager } from './analyze-job.js';
import { executeQuery, executeWithReusedStatement, withLbugDb } from '../core/lbug/lbug-adapter.js';

interface RepoWriteLock {
  repoPath: string;
  token: symbol;
}

interface ResolvedRepoEntry {
  name: string;
  storagePath: string;
}

type ResolveRepo = (
  repoName?: string,
  isRetry?: boolean,
  req?: express.Request,
) => Promise<ResolvedRepoEntry | null | undefined>;

type ReusedStatementParamsList = Parameters<typeof executeWithReusedStatement>[1];

const EMBED_INITIAL_STATUS = 'analyzing' as const;

function legacyMessageValue(err: unknown): unknown {
  return (err as { message?: unknown }).message;
}

function legacyMessageOrFallback(err: unknown, fallback: string): string {
  return (legacyMessageValue(err) || fallback) as string;
}

function legacyMessageIncludes(err: unknown, needle: string): boolean {
  return Boolean(
    (err as { message?: { includes: (value: string) => boolean } }).message?.includes(needle),
  );
}

export function mountEmbedRoutes(
  app: express.Application,
  jobManager: JobManager,
  resolveRepo: ResolveRepo,
  requestedRepo: (req: express.Request) => string | undefined,
  acquireRepoLock: (repoPath: string) => RepoWriteLock | string,
  releaseRepoLock: (lock: RepoWriteLock) => void,
): void {
  // POST /api/embed — trigger server-side embedding generation
  app.post('/api/embed', async (req, res) => {
    let lock: RepoWriteLock | null = null;
    try {
      const entry = await resolveRepo(requestedRepo(req));
      if (!entry) {
        res.status(404).json({ error: 'Repository not found' });
        return;
      }

      // Check shared repo lock — prevent concurrent analyze + embed on same repo
      const repoLockPath = entry.storagePath;
      const acquiredLock = acquireRepoLock(repoLockPath);
      if (typeof acquiredLock === 'string') {
        res.status(409).json({ error: acquiredLock });
        return;
      }
      lock = acquiredLock;

      const job = jobManager.createJob({ repoPath: entry.storagePath });
      jobManager.updateJob(job.id, {
        repoName: entry.name,
        status: EMBED_INITIAL_STATUS,
        progress: { phase: 'analyzing', percent: 0, message: 'Starting embedding generation...' },
      });

      // 30-minute timeout for embedding jobs (same as analyze jobs)
      const EMBED_TIMEOUT_MS = 30 * 60 * 1000;
      let lockReleased = false;
      const releaseEmbedLock = () => {
        if (lockReleased) return;
        lockReleased = true;
        if (lock) releaseRepoLock(lock);
        lock = null;
      };
      const abortController = new AbortController();
      const unregisterCancelHandler = jobManager.registerCancelHandler(job.id, () => {
        abortController.abort(new Error('Cancelled by user'));
      });

      const embedTimeout = setTimeout(() => {
        const current = jobManager.getJob(job.id);
        if (current && current.status !== 'complete' && current.status !== 'failed') {
          abortController.abort(new Error('Embedding timed out (30 minute limit)'));
          jobManager.cancelJob(job.id, 'Embedding timed out (30 minute limit)');
        }
      }, EMBED_TIMEOUT_MS);

      // Run embedding pipeline asynchronously
      (async () => {
        try {
          const lbugPath = path.join(entry.storagePath, 'lbug');
          const executeScopedQuery = (cypher: string) =>
            withLbugDb(lbugPath, () => executeQuery(cypher));
          const executeScopedWithReusedStatement = (
            cypher: string,
            paramsList: ReusedStatementParamsList,
          ) => withLbugDb(lbugPath, () => executeWithReusedStatement(cypher, paramsList));

          const { runEmbeddingPipeline } = await import('../core/embeddings/embedding-pipeline.js');
          // Fetch existing content hashes for incremental embedding. Each DB call
          // is scoped separately so model loading/embedding work does not hold
          // the singleton LadybugDB session lock for the whole job.
          const { fetchExistingEmbeddingHashes } = await import('../core/lbug/lbug-adapter.js');
          const existingEmbeddings = await fetchExistingEmbeddingHashes(executeScopedQuery);
          if (existingEmbeddings && existingEmbeddings.size > 0) {
            console.log(
              `[embed] ${existingEmbeddings.size} nodes already embedded — incremental run with content-hash comparison`,
            );
          }
          await runEmbeddingPipeline(
            executeScopedQuery,
            executeScopedWithReusedStatement,
            (p) => {
              jobManager.updateJob(job.id, {
                progress: {
                  phase:
                    p.phase === 'ready' ? 'complete' : p.phase === 'error' ? 'failed' : p.phase,
                  percent: p.percent,
                  message:
                    p.phase === 'loading-model'
                      ? 'Loading embedding model...'
                      : p.phase === 'embedding'
                        ? `Embedding nodes (${p.percent}%)...`
                        : p.phase === 'indexing'
                          ? 'Creating vector index...'
                          : p.phase === 'ready'
                            ? 'Embeddings complete'
                            : `${p.phase} (${p.percent}%)`,
                },
              });
            },
            {}, // config: use defaults
            undefined, // skipNodeIds
            undefined, // context
            existingEmbeddings,
            abortController.signal,
          );

          clearTimeout(embedTimeout);
          unregisterCancelHandler();
          releaseEmbedLock();
          // Don't overwrite 'failed' if the job was cancelled while the pipeline was running
          const current = jobManager.getJob(job.id);
          if (!current || current.status !== 'failed') {
            jobManager.updateJob(job.id, { status: 'complete' });
          }
        } catch (err: unknown) {
          clearTimeout(embedTimeout);
          unregisterCancelHandler();
          releaseEmbedLock();
          const current = jobManager.getJob(job.id);
          if (!current || current.status !== 'failed') {
            jobManager.updateJob(job.id, {
              status: 'failed',
              error: legacyMessageOrFallback(err, 'Embedding generation failed'),
            });
          }
        }
      })();

      res.status(202).json({ jobId: job.id, status: EMBED_INITIAL_STATUS });
    } catch (err: unknown) {
      if (lock) releaseRepoLock(lock);
      if (legacyMessageIncludes(err, 'already in progress')) {
        res.status(409).json({ error: legacyMessageValue(err) });
      } else {
        res
          .status(500)
          .json({ error: legacyMessageOrFallback(err, 'Failed to start embedding generation') });
      }
    }
  });

  // GET /api/embed/:jobId — poll embedding job status
  app.get('/api/embed/:jobId', (req, res) => {
    const job = jobManager.getJob(req.params.jobId);
    if (!job) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }
    res.json({
      id: job.id,
      status: job.status,
      repoName: job.repoName,
      progress: job.progress,
      error: job.error,
      startedAt: job.startedAt,
      completedAt: job.completedAt,
    });
  });

  // GET /api/embed/:jobId/progress — SSE stream (shared helper)
  app.get('/api/embed/:jobId/progress', (req, res) => {
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

  // DELETE /api/embed/:jobId — cancel embedding job
  app.delete('/api/embed/:jobId', (req, res) => {
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
