import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AnalysisJobRecord } from '../../../src/core/analysis/analysis-coordinator.js';
import type { RuntimeAnalyzeLockState } from '../../../src/core/runtime/runtime-health.js';
import type { EnsureFreshReport } from '../../../src/mcp/super/ensure-fresh.js';
import {
  resolveFreshWaitBudgetMs,
  waitForFreshness,
  type FreshnessWaitDeps,
} from '../../../src/mcp/super/fresh-wait.js';

const REPO = '/repo';
const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);

function report(
  submission: EnsureFreshReport['analysisSubmission'],
  lockState: RuntimeAnalyzeLockState['state'] = 'absent',
): EnsureFreshReport {
  return {
    version: 1,
    preCheck: { indexedCommit: 'x', currentCommit: 'y', isStale: true },
    embeddingsStatus: { count: 0, required: false, status: 'ok' },
    repoPath: REPO,
    runtimeHealth: {
      analyzeLock: { path: `${REPO}/.ontoindex/analyze.lock`, present: true, state: lockState },
    } as EnsureFreshReport['runtimeHealth'],
    actionsTaken: [],
    analysisSubmission: submission,
    warnings: [],
    recommendations: [],
  };
}

function job(
  id: string,
  status: AnalysisJobRecord['status'],
  digest = DIGEST_A,
): AnalysisJobRecord {
  return {
    version: 1,
    id,
    status,
    repoPath: REPO,
    targetHead: 'y',
    requestedCapabilities: {} as AnalysisJobRecord['requestedCapabilities'],
    sourceIdentity: 'commit:y',
    sourceManifestDigest: digest,
    optionsDigest: 'o',
    command: 'node',
    args: [],
    logPath: `${REPO}/.ontoindex/analysis-jobs/${id}.log`,
    createdAt: new Date(0).toISOString(),
  };
}

/** Virtual clock so waits run instantly and deterministically. */
function clock() {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += Math.max(ms, 1);
    },
  };
}

function deps(overrides: Partial<FreshnessWaitDeps>): FreshnessWaitDeps {
  const c = clock();
  return {
    evaluate: vi.fn(async () => report({ status: 'not-needed' })),
    getJob: vi.fn(async () => null),
    getActiveJob: vi.fn(async () => null),
    readLock: vi.fn(async () => ({ path: '', present: false, state: 'absent' as const })),
    currentManifestDigest: vi.fn(async () => DIGEST_A),
    autoAnalyze: true,
    now: c.now,
    sleep: c.sleep,
    ...overrides,
  };
}

afterEach(() => {
  delete process.env.ONTOINDEX_FRESH_WAIT_MAX_MS;
});

describe('waitForFreshness', () => {
  it('waits for its own job and does not resubmit when sources are unchanged', async () => {
    const states: AnalysisJobRecord['status'][] = ['running', 'running', 'complete'];
    const d = deps({ getJob: vi.fn(async () => job('j1', states.shift() ?? 'complete')) });

    const { wait } = await waitForFreshness(report({ status: 'queued', jobId: 'j1' }), 10_000, d);

    expect(wait).toMatchObject({ outcome: 'published', jobId: 'j1', rounds: 1, waitedOn: 'job' });
    expect(d.evaluate).toHaveBeenCalledTimes(1);
    expect(d.evaluate).toHaveBeenCalledWith(false);
  });

  it('joins a job started by another caller without submitting its own', async () => {
    const d = deps({
      autoAnalyze: false,
      getActiveJob: vi.fn(async () => job('other', 'running')),
      getJob: vi.fn(async () => job('other', 'complete')),
    });

    const { wait } = await waitForFreshness(report({ status: 'not-requested' }), 10_000, d);

    expect(wait).toMatchObject({ outcome: 'published', jobId: 'other' });
    expect(d.evaluate).toHaveBeenCalledWith(false);
  });

  it('submits one follow-up when sources changed while the joined job ran', async () => {
    const d = deps({
      getJob: vi.fn(async (_repo, id) => job(id, 'complete', id === 'j1' ? DIGEST_A : DIGEST_B)),
      currentManifestDigest: vi.fn(async () => DIGEST_B),
      evaluate: vi.fn(async (submit: boolean) =>
        submit ? report({ status: 'queued', jobId: 'j2' }) : report({ status: 'not-needed' }),
      ),
    });

    const { wait } = await waitForFreshness(report({ status: 'queued', jobId: 'j1' }), 10_000, d);

    expect(wait).toMatchObject({ outcome: 'published', jobId: 'j2', rounds: 2 });
    expect(vi.mocked(d.evaluate).mock.calls.map(([submit]) => submit)).toEqual([true, false]);
  });

  it('re-submits its own request after joining a conflicting job', async () => {
    const d = deps({
      getJob: vi.fn(async (_repo, id) => job(id, 'complete')),
      evaluate: vi.fn(async (submit: boolean) =>
        submit ? report({ status: 'queued', jobId: 'mine' }) : report({ status: 'not-needed' }),
      ),
    });

    const { wait } = await waitForFreshness(
      report({
        status: 'blocked',
        reasonCode: 'ACTIVE_JOB_CONFLICT',
        message: 'busy',
        jobId: 'theirs',
      }),
      10_000,
      d,
    );

    expect(wait).toMatchObject({ outcome: 'published', jobId: 'mine', rounds: 2 });
  });

  it('returns the stale verdict and job id when the budget elapses', async () => {
    const d = deps({ getJob: vi.fn(async () => job('j1', 'running')) });

    const { report: out, wait } = await waitForFreshness(
      report({ status: 'queued', jobId: 'j1' }),
      3_000,
      d,
    );

    expect(wait).toMatchObject({ outcome: 'timeout', jobId: 'j1', jobStatus: 'running' });
    expect(wait.waitedMs).toBeGreaterThanOrEqual(3_000);
    expect(wait.waitedMs).toBeLessThan(3_000 + 2_001);
    expect(out.analysisJob?.id).toBe('j1');
    expect(d.evaluate).not.toHaveBeenCalled();
  });

  it('reports a failed job without retrying when inputs are unchanged', async () => {
    const d = deps({ getJob: vi.fn(async () => job('j1', 'failed')) });

    const { wait } = await waitForFreshness(report({ status: 'queued', jobId: 'j1' }), 10_000, d);

    expect(wait.outcome).toBe('job-failed');
    expect(d.evaluate).toHaveBeenCalledWith(false);
  });

  it('retries a failed job once when sources changed during analysis', async () => {
    const d = deps({
      getJob: vi.fn(async (_repo, id) => job(id, 'failed', DIGEST_A)),
      currentManifestDigest: vi.fn(async () => DIGEST_B),
      evaluate: vi.fn(async (submit: boolean) =>
        submit ? report({ status: 'queued', jobId: 'retry' }) : report({ status: 'not-needed' }),
      ),
    });

    const { wait } = await waitForFreshness(report({ status: 'queued', jobId: 'j1' }), 10_000, d);

    expect(wait).toMatchObject({ outcome: 'job-failed', jobId: 'retry', rounds: 2 });
    expect(vi.mocked(d.evaluate).mock.calls.map(([submit]) => submit)).toEqual([true, false]);
  });

  it('waits on an unmanaged analyze lock and then re-evaluates', async () => {
    const locks: RuntimeAnalyzeLockState['state'][] = ['active', 'active', 'absent'];
    const d = deps({
      readLock: vi.fn(async () => ({ path: '', present: true, state: locks.shift() ?? 'absent' })),
    });

    const { wait } = await waitForFreshness(
      report({ status: 'blocked', reasonCode: 'LOCK_CONFLICT', message: 'cli analyze' }),
      10_000,
      d,
    );

    expect(wait).toMatchObject({ outcome: 'published', waitedOn: 'analyze-lock', rounds: 1 });
    expect(d.readLock).toHaveBeenCalledTimes(3);
  });

  it('stops after the maximum number of refresh rounds', async () => {
    let n = 0;
    const d = deps({
      getJob: vi.fn(async (_repo, id) => job(id, 'complete', DIGEST_A)),
      currentManifestDigest: vi.fn(async () => `${++n}`.padStart(64, 'c')),
      evaluate: vi.fn(async () => report({ status: 'queued', jobId: `j${n}` })),
    });

    const { wait } = await waitForFreshness(report({ status: 'queued', jobId: 'j0' }), 60_000, d);

    expect(wait.outcome).toBe('max-rounds');
    expect(wait.rounds).toBe(3);
  });

  it('does not wait when nothing is running or requested', async () => {
    const d = deps({});
    const { wait } = await waitForFreshness(report({ status: 'not-requested' }), 10_000, d);
    expect(wait).toMatchObject({ outcome: 'no-wait-needed', rounds: 0, waitedMs: 0 });
  });
});

describe('resolveFreshWaitBudgetMs', () => {
  it('caps the requested wait by the configured maximum', () => {
    expect(resolveFreshWaitBudgetMs(120_000)).toBe(55_000);
    process.env.ONTOINDEX_FRESH_WAIT_MAX_MS = '5000';
    expect(resolveFreshWaitBudgetMs(120_000)).toBe(5_000);
    expect(resolveFreshWaitBudgetMs(0)).toBe(0);
    expect(resolveFreshWaitBudgetMs(-1)).toBe(0);
  });
});
