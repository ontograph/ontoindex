# ADR-0007: Server JobManager persistence + per-repo concurrency

**Status:** Accepted
**Date:** 2026-04-30 (perf-stability)
**Source:** `ontoindex/src/server/analyze-job.ts`, `api.ts`.

## Context

The HTTP server tracks long-running analyze and embed jobs. Pre-perf-stability:
- Jobs were in-memory only — server restart lost job state
- One global active-job slot — concurrent analyze requests for different repos serialized unnecessarily
- Hold queue used 1-second polling — wasted CPU when waiting for active jobs

## Decision

Add **optional `jobs.json` ledger** persisted to the global OntoIndex dir. Switch from **global single-slot to per-repo-path concurrency**. Replace polling with **`onProgress()` listener** wait pattern. `dispose()` is now `async` to await pending ledger writes.

## Algorithm / Technique

### Constructor + init (`analyze-job.ts`)

```
class JobManager {
  constructor(opts: { persistencePath?: string; ... }) {
    this.ledgerPath = opts.persistencePath;  // optional
  }

  async init(): Promise<void> {
    if (this.ledgerPath) await this.loadLedger();
  }
}
```

Callers must invoke `await manager.init()` after construction.

### loadLedger() — recovery from prior run

```
async loadLedger(): Promise<void> {
  let raw: string;
  try {
    raw = await fs.readFile(this.ledgerPath, 'utf8');
  } catch (err) {
    return;  // ENOENT or unreadable — start fresh
  }
  const persisted: PersistedJob[] = JSON.parse(raw);
  for (const j of persisted) {
    // Mark non-terminal jobs from old session as 'failed'
    const status = (j.status === 'pending' || j.status === 'running') ? 'failed' : j.status;
    this.jobs.set(j.id, { ...j, status });
  }
}
```

Non-terminal jobs at startup are marked failed — the prior server died mid-execution; we cannot resume.

### saveLedger() — serial write queue (perf-stability Wave 1.5 fix)

The race-correct version (3+ concurrent callers serialize properly):

```
async saveLedger(): Promise<void> {
  this.pendingSave = (this.pendingSave ?? Promise.resolve())
    .catch(() => {})
    .then(async () => {
      try {
        const data = JSON.stringify([...this.jobs.values()], null, 2);
        await fs.writeFile(this.ledgerPath, data, 'utf8');
      } catch (err) {
        console.error('JobManager: ledger write failed:', err);
      }
    });
  return this.pendingSave;
}
```

Key: assign `this.pendingSave` BEFORE the await chain. Subsequent callers chain off the new promise. The old pattern `if (pendingSave) await it; pendingSave = IIFE` had a race for 3+ callers (B and C both await A; both then unconditionally overwrite `pendingSave` and write concurrently).

### createJob() — per-repo-path concurrency

```
async createJob(params: CreateJobParams): Promise<Job> {
  // 1. Same-URL dedup (always — even URL-only jobs)
  for (const existing of this.jobs.values()) {
    if (existing.repoUrl === params.repoUrl && !isTerminal(existing.status)) {
      return existing;
    }
  }

  // 2. Per-repo-path concurrency (only if repoPath present)
  if (params.repoPath) {
    for (const existing of this.jobs.values()) {
      if (existing.repoPath === params.repoPath && !isTerminal(existing.status)) {
        // Re-use the same-URL early return above; duplicate-path jobs return existing
        return existing;
      }
    }
  }

  // 3. Create new job
  const job = { id: uuid(), status: 'pending', ...params };
  this.jobs.set(job.id, job);
  this.saveLedger();  // fire-and-forget
  return job;
}
```

Multiple repos can analyze concurrently. Same-repo requests deduplicate to the same job ID.

### updateJob() — fire-and-forget save

```
updateJob(id: string, patch: Partial<Job>): void {
  const job = this.jobs.get(id);
  if (!job) return;
  Object.assign(job, patch);
  this.saveLedger();  // fire-and-forget
  this.emitProgress(job);  // notify listeners
}
```

Save is fire-and-forget because callers don't need to await. The serial queue in `saveLedger` ensures eventual consistency.

### dispose() — async + cleanup

```
async dispose(): Promise<void> {
  if (this.cleanupTimer) clearInterval(this.cleanupTimer);
  if (this.pendingSave) await this.pendingSave;  // ensure final write
}
```

API server shutdown handler:

```
await jobManager.dispose();
await embedJobManager.dispose();
```

### onProgress() listener (api.ts hold queue)

Pre-perf-stability used 1-second `setTimeout` polling:

```
// OLD:
while (await jobManager.getJob(activeJobId)?.status === 'running') {
  await sleep(1000);
}
```

Now uses event listener with race-check:

```
// NEW:
return new Promise<RepoEntry | null>((resolve) => {
  let settled = false;

  const settle = (value: RepoEntry | null) => {
    if (settled) return;
    settled = true;
    jobManager.offProgress(listener);
    resolve(value);
  };

  const listener = (progress: AnalyzeJobProgress) => {
    if (progress.jobId !== activeJobId) return;
    if (progress.phase === 'complete') {
      // Re-resolve repo from registry
      settle(getRepoEntry(activeJobRepoPath));
    } else if (progress.phase === 'failed') {
      settle(null);
    }
  };
  jobManager.onProgress(listener);

  // Race check: did the job complete BETWEEN the active-check and listener attach?
  const currentJob = jobManager.getJob(activeJobId);
  if (currentJob && (currentJob.status === 'complete' || currentJob.status === 'failed')) {
    settle(currentJob.status === 'complete' ? getRepoEntry(activeJobRepoPath) : null);
  }

  // Timeout: return null (NOT a truthy sentinel — Wave 1.5 fix-2)
  setTimeout(() => settle(null), HOLD_QUEUE_TIMEOUT_MS);
});
```

The race-check after `onProgress` attachment handles the gap between "we observed the job is running" and "we attached our listener" — if the job completed in that gap, we'd miss the event without this check.

### Wave 1.5 fix-2: resolveRepo timeout sentinel

Pre-fix returned `{ __timedOut: true, repoName }` on timeout. This object is truthy; 7 of 8 routes did `if (!entry) return 404; ...; entry.storagePath` and crashed with TypeError when `storagePath` was `undefined`.

Post-fix: `done(null)` on timeout. The existing `if (!entry) return 404` guard handles all routes uniformly. A separate `console.error` logs the diagnostic (repo exists but timed out).

## Consequences

**Positive:**
- Jobs survive server restart (failed-on-recovery for non-terminal)
- Concurrent analyze for different repos
- O(1) wait via `onProgress` instead of O(N) polling
- Race-correct serial ledger writes
- Async dispose ensures final write before exit

**Negative:**
- `loadLedger()` swallows non-ENOENT errors silently (could be improved to log JSON-parse / EPERM)
- The dead second loop in `createJob` (per-repo-path check) can never trigger for same-path because the same-URL early return covers it (cosmetic; not a correctness bug)
- No `isDisposed` flag — saveLedger() called after dispose() resolves writes to a possibly-stale state (low probability)

**Open issues for future work:**
- `loadLedger()` non-ENOENT error logging
- `isDisposed` guard in `saveLedger()`
- Test flakiness: `analyze-job.test.ts` ledger recovery test had a `setTimeout(100ms)` wait; replaced with explicit `dispose()` await in Wave 1.5 minor-fix-7
