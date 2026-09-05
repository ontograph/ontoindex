import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/core/analysis/analysis-coordinator.js', () => ({
  cancelAnalysisJob: vi.fn(),
  getAnalysisJob: vi.fn(),
}));
vi.mock('../../../src/core/analysis/analysis-publication-receipt.js', () => ({
  readAnalysisPublicationReceipt: vi.fn(),
  isValidSourceIdentity: (value: unknown, targetHead: string, digest: string) =>
    value === `commit:${targetHead}` || value === `worktree:${digest}`,
}));
vi.mock('../../../src/storage/repo-manager.js', () => ({
  resolveActiveIndexGeneration: vi.fn(),
}));
vi.mock('../../../src/mcp/shared/target-context.js', () => ({ resolveTargetContext: vi.fn() }));
vi.mock('../../../src/mcp/super/ensure-fresh.js', () => ({ gnEnsureFresh: vi.fn() }));

import {
  cancelAnalysisJob,
  getAnalysisJob,
  type AnalysisJobRecord,
} from '../../../src/core/analysis/analysis-coordinator.js';
import { readAnalysisPublicationReceipt } from '../../../src/core/analysis/analysis-publication-receipt.js';
import { SOURCE_MANIFEST_CONTRACT } from '../../../src/core/indexing/source-manifest.js';
import { resolveActiveIndexGeneration } from '../../../src/storage/repo-manager.js';
import { resolveTargetContext } from '../../../src/mcp/shared/target-context.js';
import { gnAnalyzeJob } from '../../../src/mcp/super/analyze-job.js';
import { gnEnsureFresh } from '../../../src/mcp/super/ensure-fresh.js';

const cancelJob = vi.mocked(cancelAnalysisJob);
const getJob = vi.mocked(getAnalysisJob);
const readReceipt = vi.mocked(readAnalysisPublicationReceipt);
const activeGeneration = vi.mocked(resolveActiveIndexGeneration);
const targetContext = vi.mocked(resolveTargetContext);
const ensureFresh = vi.mocked(gnEnsureFresh);

const repoPath = path.resolve('/workspace/repo');
const targetHead = 'a'.repeat(40);
const otherHead = 'b'.repeat(40);
const optionsDigest = 'c'.repeat(64);
const manifestDigest = 'd'.repeat(64);
const generationId = 'generation-1';
const jobId = 'job-1';

const graphCapabilities = ['symbols'] as const;

function requestedCapabilities(
  overrides: Partial<AnalysisJobRecord['requestedCapabilities']> = {},
): AnalysisJobRecord['requestedCapabilities'] {
  return {
    version: 1,
    graph: true,
    graphCapabilities: [...graphCapabilities],
    embeddings: false,
    embeddingModelHash: null,
    ...overrides,
  };
}

function makeJob(overrides: Partial<AnalysisJobRecord> = {}): AnalysisJobRecord {
  return {
    version: 1,
    id: jobId,
    status: 'complete',
    repoPath,
    targetHead,
    sourceIdentity: `commit:${targetHead}`,
    requestedCapabilities: requestedCapabilities(),
    optionsDigest,
    command: process.execPath,
    args: ['analyze'],
    logPath: path.join(repoPath, '.ontoindex', 'analysis-jobs', `${jobId}.log`),
    createdAt: '2026-08-18T00:00:00.000Z',
    completedAt: '2026-08-18T00:01:00.000Z',
    exitCode: 0,
    generationId,
    sourceManifestDigest: manifestDigest,
    ...overrides,
  };
}

function makeReceipt(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    jobId,
    repoPath,
    targetHead,
    sourceIdentity: `commit:${targetHead}`,
    optionsDigest,
    sourceManifestDigest: manifestDigest,
    generationId,
    requestedCapabilities: requestedCapabilities(),
    analyzerContractVersion: SOURCE_MANIFEST_CONTRACT,
    publishedAt: '2026-08-18T00:00:59.000Z',
    ...overrides,
  };
}

function makeFreshness(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    preCheck: { indexedCommit: targetHead, currentCommit: targetHead, isStale: false },
    embeddingsStatus: { count: 0, required: false, status: 'missing' },
    repoLabel: 'repo',
    repoPath,
    indexedCommit: targetHead,
    headCommit: targetHead,
    isStale: false,
    dirtyFileCount: 0,
    actionsTaken: [],
    analysisSubmission: { status: 'not-requested' },
    warnings: [],
    recommendations: [],
    ...overrides,
  };
}

function makeTargetContext(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    status: 'ok',
    repoPath,
    targetRef: 'HEAD',
    targetHead,
    currentHead: targetHead,
    indexedHead: targetHead,
    graphAuthority: {
      state: 'authoritative',
      reason: 'verified',
      generationId,
      manifestDigest,
      coverage: 'complete',
    },
    dirtyWorktree: false,
    changedSinceIndex: false,
    snapshotMode: 'committed-head',
    qualityMode: 'fast',
    embeddings: { status: 'unknown' },
    lsp: { status: 'unknown' },
    sidecar: { status: 'unknown' },
    policy: { status: 'unknown' },
    warnings: [],
    ...overrides,
  };
}

describe('gnAnalyzeJob', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ensureFresh.mockResolvedValue(makeFreshness() as any);
    getJob.mockResolvedValue(makeJob());
    activeGeneration.mockResolvedValue({
      generationId,
      generationPath: path.join(repoPath, '.ontoindex', 'generations', generationId),
    } as any);
    readReceipt.mockResolvedValue(makeReceipt() as any);
    targetContext.mockResolvedValue(makeTargetContext() as any);
  });

  it('preserves cancel compatibility without recovery checks', async () => {
    cancelJob.mockResolvedValue({ job: makeJob({ status: 'running' }), cancelled: true });
    const result = await gnAnalyzeJob('repo', { jobId, action: 'cancel' });
    expect(result).toMatchObject({ cancelled: true, repoLabel: 'repo', repoPath });
    expect(readReceipt).not.toHaveBeenCalled();
  });

  it.each(['queued', 'running'] as const)('reports %s as refresh running', async (status) => {
    getJob.mockResolvedValue(makeJob({ status }));
    const result: any = await gnAnalyzeJob('repo', { jobId });
    expect(result.recovery).toMatchObject({
      disposition: 'REFRESH_RUNNING',
      reasonCode: 'ANALYSIS_IN_PROGRESS',
    });
    expect(activeGeneration).not.toHaveBeenCalled();
  });

  it.each(['queued', 'running'] as const)(
    'fails closed for %s without exact commit source identity',
    async (status) => {
      getJob.mockResolvedValue(makeJob({ status, sourceIdentity: undefined }));
      const result: any = await gnAnalyzeJob('repo', { jobId });
      expect(result.recovery).toMatchObject({
        disposition: 'FRESHNESS_UNCONFIRMED',
        reasonCode: 'JOB_SOURCE_IDENTITY_MISMATCH',
      });
      expect(activeGeneration).not.toHaveBeenCalled();
    },
  );

  it('reports cancelled as failed', async () => {
    getJob.mockResolvedValue(makeJob({ status: 'cancelled' }));
    const result: any = await gnAnalyzeJob('repo', { jobId });
    expect(result.recovery).toMatchObject({ disposition: 'FAILED', reasonCode: 'CANCELLED' });
  });

  it.each([
    ['complete', 'FRESHNESS_UNCONFIRMED', 'PUBLICATION_RECEIPT_UNAVAILABLE'],
    ['failed', 'FAILED', 'ANALYSIS_FAILED'],
  ] as const)('fails closed without a receipt for %s', async (status, disposition, reasonCode) => {
    getJob.mockResolvedValue(makeJob({ status, exitCode: status === 'failed' ? 7 : 0 }));
    readReceipt.mockResolvedValue(null);
    const result: any = await gnAnalyzeJob('repo', { jobId });
    expect(result.recovery).toMatchObject({
      disposition,
      reasonCode,
    });
    expect(readReceipt).toHaveBeenCalledTimes(status === 'complete' ? 1 : 0);
  });

  it('fails closed for a pre-upgrade terminal job without capability identity', async () => {
    getJob.mockResolvedValue({ ...makeJob(), requestedCapabilities: undefined } as any);
    const result: any = await gnAnalyzeJob('repo', { jobId });
    expect(result.recovery).toMatchObject({
      disposition: 'FRESHNESS_UNCONFIRMED',
      reasonCode: 'JOB_CAPABILITIES_UNAVAILABLE',
    });
    expect(activeGeneration).not.toHaveBeenCalled();
  });

  it.each([undefined, 'not-a-digest'])(
    'fails closed without a valid job manifest identity',
    async (digest) => {
      getJob.mockResolvedValue(makeJob({ sourceManifestDigest: digest as any }));
      const result: any = await gnAnalyzeJob('repo', { jobId });
      expect(result.recovery).toMatchObject({
        disposition: 'FRESHNESS_UNCONFIRMED',
        reasonCode: 'JOB_MANIFEST_IDENTITY_UNAVAILABLE',
      });
      expect(activeGeneration).not.toHaveBeenCalled();
    },
  );

  it('fails closed for embedding capabilities without a model identity', async () => {
    getJob.mockResolvedValue(
      makeJob({
        requestedCapabilities: requestedCapabilities({
          embeddings: true,
          embeddingModelHash: null,
        }),
      }),
    );
    const result: any = await gnAnalyzeJob('repo', { jobId });
    expect(result.recovery).toMatchObject({
      disposition: 'FRESHNESS_UNCONFIRMED',
      reasonCode: 'JOB_CAPABILITIES_UNAVAILABLE',
    });
  });

  it.each([
    ['complete', 'FRESHNESS_UNCONFIRMED'],
    ['failed', 'FAILED'],
  ] as const)(
    'fails closed for %s when job source identity is unavailable',
    async (status, disposition) => {
      getJob.mockResolvedValue(
        makeJob({ status, sourceIdentity: undefined, exitCode: status === 'failed' ? 7 : 0 }),
      );
      const result: any = await gnAnalyzeJob('repo', { jobId });
      expect(result.recovery).toMatchObject({
        disposition,
        reasonCode: 'JOB_SOURCE_IDENTITY_MISMATCH',
      });
      expect(activeGeneration).not.toHaveBeenCalled();
    },
  );

  it('rejects receipt identity and capability mismatches', async () => {
    readReceipt.mockResolvedValue(
      makeReceipt({
        requestedCapabilities: requestedCapabilities({
          graphCapabilities: ['impact', 'symbols'],
        }),
      }) as any,
    );
    const result: any = await gnAnalyzeJob('repo', { jobId });
    expect(result.recovery).toMatchObject({
      disposition: 'FRESHNESS_UNCONFIRMED',
      reasonCode: 'RECEIPT_CAPABILITIES_MISMATCH',
    });
  });

  it('rejects a receipt whose source identity does not match the job', async () => {
    readReceipt.mockResolvedValue(makeReceipt({ sourceIdentity: `commit:${otherHead}` }) as any);
    const result: any = await gnAnalyzeJob('repo', { jobId });
    expect(result.recovery).toMatchObject({
      disposition: 'FRESHNESS_UNCONFIRMED',
      reasonCode: 'RECEIPT_SOURCE_IDENTITY_MISMATCH',
    });
  });

  it('rejects a receipt whose manifest identity does not match the job', async () => {
    readReceipt.mockResolvedValue(makeReceipt({ sourceManifestDigest: 'e'.repeat(64) }) as any);
    const result: any = await gnAnalyzeJob('repo', { jobId });
    expect(result.recovery).toMatchObject({
      disposition: 'FRESHNESS_UNCONFIRMED',
      reasonCode: 'RECEIPT_MANIFEST_MISMATCH',
    });
  });

  it('reports refreshed only after receipt, target, authority, and generation checks pass', async () => {
    const result: any = await gnAnalyzeJob('repo', { jobId });
    expect(result.recovery).toMatchObject({
      disposition: 'REFRESHED',
      reasonCode: 'PUBLICATION_VERIFIED',
      receipt: { generationId },
      postCheck: { indexedCommit: targetHead, headCommit: targetHead },
    });
    expect(ensureFresh).toHaveBeenNthCalledWith(2, repoPath, {
      repo: repoPath,
      withEmbeddings: false,
      requiredGraphCapabilities: ['symbols'],
    });
    expect(ensureFresh).toHaveBeenNthCalledWith(3, repoPath, {
      repo: repoPath,
      withEmbeddings: false,
      requiredGraphCapabilities: ['symbols'],
    });
    expect(ensureFresh).toHaveBeenNthCalledWith(4, repoPath, {
      repo: repoPath,
      withEmbeddings: false,
      requiredGraphCapabilities: ['symbols'],
    });
    expect(targetContext).toHaveBeenCalledTimes(3);
    expect(activeGeneration).toHaveBeenCalledTimes(3);
    expect(targetContext).toHaveBeenCalledWith({
      repo: repoPath,
      verifyGraphAuthority: true,
      requiredGraphCapabilities: ['symbols'],
    });
  });

  it('keeps a failed execution failed even if receipt and postconditions look successful', async () => {
    getJob.mockResolvedValue(makeJob({ status: 'failed', exitCode: 9 }));
    const result: any = await gnAnalyzeJob('repo', { jobId });
    expect(result.job).toMatchObject({ status: 'failed', exitCode: 9 });
    expect(result.recovery).toMatchObject({
      disposition: 'FAILED',
      reasonCode: 'ANALYSIS_FAILED',
    });
    expect(result.recovery.message).toContain('exit code 9');
    expect(activeGeneration).not.toHaveBeenCalled();
    expect(readReceipt).not.toHaveBeenCalled();
    expect(targetContext).not.toHaveBeenCalled();
    expect(ensureFresh).toHaveBeenCalledTimes(1);
  });

  it('does not bless a job after HEAD advances beyond its target', async () => {
    ensureFresh.mockResolvedValueOnce(makeFreshness() as any).mockResolvedValueOnce(
      makeFreshness({
        preCheck: { indexedCommit: targetHead, currentCommit: otherHead, isStale: true },
        headCommit: otherHead,
        isStale: true,
      }) as any,
    );
    const result: any = await gnAnalyzeJob('repo', { jobId });
    expect(result.recovery).toMatchObject({
      disposition: 'FRESHNESS_UNCONFIRMED',
      reasonCode: 'POSTCHECK_TARGET_MISMATCH',
    });
  });

  it('fails closed when the checkout changes after the first valid post-check', async () => {
    ensureFresh
      .mockResolvedValueOnce(makeFreshness() as any)
      .mockResolvedValueOnce(makeFreshness() as any)
      .mockResolvedValueOnce(
        makeFreshness({
          preCheck: { indexedCommit: targetHead, currentCommit: otherHead, isStale: true },
          headCommit: otherHead,
          isStale: true,
        }) as any,
      );

    const result: any = await gnAnalyzeJob('repo', { jobId });

    expect(result.recovery).toMatchObject({
      disposition: 'FRESHNESS_UNCONFIRMED',
      reasonCode: 'POSTCHECK_TARGET_MISMATCH',
    });
  });

  it.each([
    [
      'a dirty freshness post-check',
      {
        freshness: { dirtyFileCount: 1 },
        context: {},
        reasonCode: 'POSTCHECK_WORKTREE_UNCONFIRMED',
      },
    ],
    [
      'an unconfirmed target worktree',
      {
        freshness: {},
        context: { dirtyWorktree: null },
        reasonCode: 'TARGET_CONTEXT_WORKTREE_UNCONFIRMED',
      },
    ],
    [
      'a non-committed snapshot',
      {
        freshness: {},
        context: { snapshotMode: 'dirty-worktree-overlay' },
        reasonCode: 'TARGET_CONTEXT_SNAPSHOT_MISMATCH',
      },
    ],
    [
      'changes since the published index',
      {
        freshness: {},
        context: { changedSinceIndex: true },
        reasonCode: 'TARGET_CONTEXT_INDEX_DRIFT',
      },
    ],
  ] as const)('fails closed for %s', async (_label, proof) => {
    ensureFresh
      .mockResolvedValueOnce(makeFreshness() as any)
      .mockResolvedValueOnce(makeFreshness(proof.freshness) as any);
    targetContext.mockResolvedValue(makeTargetContext(proof.context) as any);

    const result: any = await gnAnalyzeJob('repo', { jobId });

    expect(result.recovery).toMatchObject({
      disposition: 'FRESHNESS_UNCONFIRMED',
      reasonCode: proof.reasonCode,
    });
  });

  it('fails closed when the authoritative post-check cannot be completed', async () => {
    ensureFresh
      .mockResolvedValueOnce(makeFreshness() as any)
      .mockRejectedValueOnce(new Error('no'));
    const result: any = await gnAnalyzeJob('repo', { jobId });
    expect(result.recovery).toMatchObject({
      disposition: 'FRESHNESS_UNCONFIRMED',
      reasonCode: 'POSTCHECK_UNAVAILABLE',
      receipt: { jobId },
    });
  });

  it('requires embeddings when the job requested them', async () => {
    const embeddingCapabilities = requestedCapabilities({
      graphCapabilities: ['impact', 'processes', 'symbols'],
      embeddings: true,
      embeddingModelHash: 'sha256:model-a',
    });
    getJob.mockResolvedValue(makeJob({ requestedCapabilities: embeddingCapabilities }));
    readReceipt.mockResolvedValue(
      makeReceipt({ requestedCapabilities: embeddingCapabilities }) as any,
    );
    const result: any = await gnAnalyzeJob('repo', { jobId });
    expect(result.recovery).toMatchObject({
      disposition: 'FRESHNESS_UNCONFIRMED',
      reasonCode: 'EMBEDDINGS_UNCONFIRMED',
    });
    expect(ensureFresh).toHaveBeenNthCalledWith(2, repoPath, {
      repo: repoPath,
      withEmbeddings: true,
      requiredGraphCapabilities: ['impact', 'processes', 'symbols'],
    });
  });

  it('reports refreshed when the requested embedding model is proven end to end', async () => {
    const embeddingCapabilities = requestedCapabilities({
      graphCapabilities: ['impact', 'processes', 'symbols'],
      embeddings: true,
      embeddingModelHash: 'sha256:model-a',
    });
    getJob.mockResolvedValue(makeJob({ requestedCapabilities: embeddingCapabilities }));
    readReceipt.mockResolvedValue(
      makeReceipt({ requestedCapabilities: embeddingCapabilities }) as any,
    );
    ensureFresh.mockResolvedValue(
      makeFreshness({
        embeddingsStatus: {
          count: 12,
          required: false,
          status: 'ok',
          expectedModelHash: 'sha256:model-a',
          actualModelHash: 'sha256:model-a',
        },
      }) as any,
    );
    targetContext.mockResolvedValue(
      makeTargetContext({
        embeddings: { status: 'available', count: 12, modelHash: 'sha256:model-a' },
      }) as any,
    );

    const result: any = await gnAnalyzeJob('repo', { jobId });

    expect(result.recovery).toMatchObject({
      disposition: 'REFRESHED',
      reasonCode: 'PUBLICATION_VERIFIED',
    });
  });

  it('fails closed if active generation changes during verification', async () => {
    activeGeneration
      .mockResolvedValueOnce({
        generationId,
        generationPath: path.join(repoPath, '.ontoindex', 'generations', generationId),
      } as any)
      .mockResolvedValueOnce({
        generationId: 'generation-2',
        generationPath: path.join(repoPath, '.ontoindex', 'generations', 'generation-2'),
      } as any);
    const result: any = await gnAnalyzeJob('repo', { jobId });
    expect(result.recovery).toMatchObject({
      disposition: 'FRESHNESS_UNCONFIRMED',
      reasonCode: 'ACTIVE_GENERATION_CHANGED',
    });
  });

  it('fails closed if active generation changes after the final post-check', async () => {
    activeGeneration
      .mockResolvedValueOnce({
        generationId,
        generationPath: path.join(repoPath, '.ontoindex', 'generations', generationId),
      } as any)
      .mockResolvedValueOnce({
        generationId,
        generationPath: path.join(repoPath, '.ontoindex', 'generations', generationId),
      } as any)
      .mockResolvedValueOnce({
        generationId: 'generation-2',
        generationPath: path.join(repoPath, '.ontoindex', 'generations', 'generation-2'),
      } as any);

    const result: any = await gnAnalyzeJob('repo', { jobId });

    expect(result.recovery).toMatchObject({
      disposition: 'FRESHNESS_UNCONFIRMED',
      reasonCode: 'ACTIVE_GENERATION_CHANGED',
    });
    expect(ensureFresh).toHaveBeenCalledTimes(3);
    expect(targetContext).toHaveBeenCalledTimes(2);
  });
});
