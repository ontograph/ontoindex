/**
 * Bounded wait for an index refresh.
 *
 * Exactly one analysis runs per repository (enforced by the analysis
 * coordinator and analyze.lock). Callers that need a fresh index join the
 * running analysis instead of starting another one, wait up to a bounded
 * budget, then re-evaluate freshness. When the tree changed while the job
 * ran, the re-evaluation submits one follow-up job; concurrent callers
 * converge on it through the coordinator's reuse/conflict semantics.
 *
 * The wait never outlives its budget: on timeout the caller receives the
 * current (stale) verdict plus the job id so it can keep reading the
 * published generation and retry the wait later.
 */

import type { AnalysisJobRecord } from '../../core/analysis/analysis-coordinator.js';
import type { RuntimeAnalyzeLockState } from '../../core/runtime/runtime-health.js';
import { getStoragePath } from '../../storage/repo-manager.js';
import type { EnsureFreshReport } from './ensure-fresh.js';

export const DEFAULT_FRESH_WAIT_MAX_MS = 55_000;
export const MAX_FRESH_WAIT_ROUNDS = 3;
const MIN_POLL_MS = 250;
const MAX_POLL_MS = 2_000;

export type FreshnessWaitOutcome =
  | 'no-wait-needed'
  | 'published'
  | 'timeout'
  | 'job-failed'
  | 'max-rounds';

export interface FreshnessWaitSummary {
  requestedMs: number;
  budgetMs: number;
  waitedMs: number;
  rounds: number;
  outcome: FreshnessWaitOutcome;
  jobId?: string;
  jobStatus?: AnalysisJobRecord['status'];
  waitedOn?: 'job' | 'analyze-lock';
  message: string;
}

export interface FreshnessWaitDeps {
  /**
   * Build a live (uncached) freshness report. `submit` requests a follow-up
   * analysis when refresh work remains; it is only true for autoAnalyze callers.
   */
  evaluate: (submit: boolean) => Promise<EnsureFreshReport>;
  getJob: (repoPath: string, jobId: string) => Promise<AnalysisJobRecord | null>;
  getActiveJob: (repoPath: string) => Promise<AnalysisJobRecord | null>;
  readLock: (storagePath: string) => Promise<RuntimeAnalyzeLockState>;
  /** Digest of the current source inputs; used to retry a job that failed on changed inputs. */
  currentManifestDigest: (repoPath: string) => Promise<string | null>;
  autoAnalyze: boolean;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** `own` marks a job whose request matches ours (queued or reused by the coordinator). */
type WaitTarget = { kind: 'job'; jobId: string; own: boolean } | { kind: 'analyze-lock' };

const TERMINAL: ReadonlySet<AnalysisJobRecord['status']> = new Set([
  'complete',
  'failed',
  'cancelled',
]);

export function resolveFreshWaitBudgetMs(requestedMs: number): number {
  const raw = Number(process.env.ONTOINDEX_FRESH_WAIT_MAX_MS);
  const cap = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_FRESH_WAIT_MAX_MS;
  if (!Number.isFinite(requestedMs) || requestedMs <= 0) return 0;
  return Math.min(Math.floor(requestedMs), cap);
}

async function resolveWaitTarget(
  report: EnsureFreshReport,
  deps: FreshnessWaitDeps,
): Promise<WaitTarget | null> {
  const submission = report.analysisSubmission;
  if (submission.status === 'queued' || submission.status === 'reused') {
    return { kind: 'job', jobId: submission.jobId, own: true };
  }
  if (submission.status === 'blocked') {
    if (submission.reasonCode === 'ACTIVE_JOB_CONFLICT' && submission.jobId) {
      return { kind: 'job', jobId: submission.jobId, own: false };
    }
    if (submission.reasonCode === 'LOCK_CONFLICT') return { kind: 'analyze-lock' };
    return null;
  }
  if (!report.repoPath) return null;
  // Not submitting ourselves: join a refresh another caller already started.
  if (submission.status === 'not-requested') {
    const active = await deps.getActiveJob(report.repoPath);
    if (active) return { kind: 'job', jobId: active.id, own: false };
    if (report.runtimeHealth?.analyzeLock.state === 'active') return { kind: 'analyze-lock' };
  }
  return null;
}

export async function waitForFreshness(
  initial: EnsureFreshReport,
  requestedMs: number,
  deps: FreshnessWaitDeps,
): Promise<{ report: EnsureFreshReport; wait: FreshnessWaitSummary }> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const budgetMs = resolveFreshWaitBudgetMs(requestedMs);
  const started = now();
  const deadline = started + budgetMs;
  let report = initial;
  let rounds = 0;
  let lastJob: AnalysisJobRecord | null = null;
  let waitedOn: WaitTarget['kind'] | undefined;
  let retriedChangedInputs = false;

  const finish = (outcome: FreshnessWaitOutcome, message: string) => ({
    // lastJob is the most recent observation of the job we waited on.
    report: lastJob ? { ...report, analysisJob: lastJob } : report,
    wait: {
      requestedMs,
      budgetMs,
      waitedMs: Math.max(0, now() - started),
      rounds,
      outcome,
      ...(lastJob ? { jobId: lastJob.id, jobStatus: lastJob.status } : {}),
      ...(waitedOn ? { waitedOn } : {}),
      message,
    } satisfies FreshnessWaitSummary,
  });

  if (budgetMs <= 0) {
    return finish('no-wait-needed', 'No wait budget was requested.');
  }

  while (true) {
    const target = await resolveWaitTarget(report, deps);
    if (!target) {
      return rounds === 0
        ? finish('no-wait-needed', 'No running or requested refresh to wait for.')
        : finish('published', 'The refresh finished and no further refresh is pending.');
    }
    if (rounds >= MAX_FRESH_WAIT_ROUNDS) {
      return finish(
        'max-rounds',
        `Stopped after ${rounds} refresh rounds; sources keep changing. Reads use the published generation.`,
      );
    }
    rounds += 1;
    waitedOn = target.kind;

    let pollMs = MIN_POLL_MS;
    let settled = false;
    while (now() < deadline) {
      if (target.kind === 'job') {
        const job = report.repoPath ? await deps.getJob(report.repoPath, target.jobId) : null;
        if (job) lastJob = job;
        // A missing job record (expired or removed) is treated as settled.
        if (!job || TERMINAL.has(job.status)) {
          settled = true;
          break;
        }
      } else {
        const lock = report.repoPath
          ? await deps.readLock(getStoragePath(report.repoPath))
          : ({ state: 'absent' } as RuntimeAnalyzeLockState);
        if (lock.state !== 'active' && lock.state !== 'unknown') {
          settled = true;
          break;
        }
      }
      await sleep(Math.min(pollMs, Math.max(0, deadline - now())));
      pollMs = Math.min(MAX_POLL_MS, pollMs * 2);
    }
    if (!settled) {
      return finish(
        'timeout',
        'Wait budget elapsed while the refresh is still running. Reads use the published generation; retry with waitForFreshMs to keep waiting on the same job.',
      );
    }

    if (target.kind === 'analyze-lock' || !lastJob) {
      // An unmanaged CLI analyze (or an expired job record) settled; re-check.
      report = await deps.evaluate(deps.autoAnalyze);
      continue;
    }

    const job = lastJob;
    const digest = report.repoPath
      ? await deps.currentManifestDigest(report.repoPath).catch(() => null)
      : null;
    const inputsUnchanged =
      digest !== null && digest.toLowerCase() === job.sourceManifestDigest.toLowerCase();

    if (job.status === 'complete') {
      if (!deps.autoAnalyze || (target.own && inputsUnchanged)) {
        // The finished job analyzed exactly the current sources (dirty edits
        // included), so do not resubmit even though the tree is still dirty.
        report = await deps.evaluate(false);
        return finish('published', `Refresh job ${job.id} completed and was published.`);
      }
      // Sources changed while the job ran, or the joined job served a different
      // request: submit our follow-up (reused by the coordinator if equivalent).
      report = await deps.evaluate(true);
      continue;
    }

    // failed or cancelled: retry once only when inputs changed since the job
    // was submitted (edits during analysis); identical inputs would fail again.
    if (!deps.autoAnalyze || retriedChangedInputs || digest === null || inputsUnchanged) {
      report = await deps.evaluate(false);
      return finish(
        'job-failed',
        `Refresh job ${job.id} ended ${job.status}${job.error ? `: ${job.error}` : ''}. Reads use the published generation; inspect ${job.logPath}.`,
      );
    }
    retriedChangedInputs = true;
    report = await deps.evaluate(true);
  }
}
