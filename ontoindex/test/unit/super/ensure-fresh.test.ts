/**
 * Unit tests: gnEnsureFresh
 *
 * All external I/O (child_process, fs, os) is mocked via vi.mock.
 * No real git process, filesystem, or registry access is used.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Mocks — declared before the module under test is imported.
// vi.mock factories are hoisted.
// ---------------------------------------------------------------------------

vi.mock('child_process', () => ({
  execFile: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock('fs', () => ({
  readFileSync: vi.fn(),
}));

vi.mock('../../../src/storage/repo-manager.js', () => ({
  loadMeta: vi.fn(),
  readActiveGenerationMeta: vi.fn(),
  resolveActiveIndexGeneration: vi.fn(),
}));

vi.mock('os', () => ({
  homedir: vi.fn(() => '/home/testuser'),
}));

vi.mock('../../../src/core/runtime/runtime-health.js', () => ({
  readRuntimeHealth: vi.fn(),
}));

vi.mock('../../../src/core/analysis/analysis-coordinator.js', () => ({
  submitAnalysisJob: vi.fn(),
}));

vi.mock('../../../src/core/indexing/source-manifest.js', () => ({
  computeSourceManifest: vi.fn(),
  sourceManifestDigest: vi.fn(),
}));

vi.mock('../../../src/mcp/shared/target-context.js', () => ({
  resolveTargetContext: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks).
// ---------------------------------------------------------------------------

import { EventEmitter } from 'events';
import { execFile, spawn } from 'child_process';
import { readFileSync } from 'fs';
import { gnEnsureFresh } from '../../../src/mcp/super/ensure-fresh.js';
import { readRuntimeHealth } from '../../../src/core/runtime/runtime-health.js';
import {
  loadMeta,
  readActiveGenerationMeta,
  resolveActiveIndexGeneration,
} from '../../../src/storage/repo-manager.js';
import { submitAnalysisJob } from '../../../src/core/analysis/analysis-coordinator.js';
import {
  computeSourceManifest,
  sourceManifestDigest,
} from '../../../src/core/indexing/source-manifest.js';
import { resolveTargetContext } from '../../../src/mcp/shared/target-context.js';

const mockExecFile = vi.mocked(execFile);
const mockSpawn = vi.mocked(spawn);
const mockReadFileSync = vi.mocked(readFileSync);
const mockReadRuntimeHealth = vi.mocked(readRuntimeHealth);
const mockLoadMeta = vi.mocked(loadMeta);
const mockReadActiveGenerationMeta = vi.mocked(readActiveGenerationMeta);
const mockResolveActiveIndexGeneration = vi.mocked(resolveActiveIndexGeneration);
const mockSubmitAnalysisJob = vi.mocked(submitAnalysisJob);
const mockComputeSourceManifest = vi.mocked(computeSourceManifest);
const mockSourceManifestDigest = vi.mocked(sourceManifestDigest);
const mockResolveTargetContext = vi.mocked(resolveTargetContext);

let savedEnv: Record<string, string | undefined> = {};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const REPO_ID = 'test-repo';
const REPO_PATH = path.resolve('/home/testuser/_wrk/test-repo');
const CURRENT_COMMIT = 'abc123def456abc123def456abc123def456abc1';
const INDEXED_COMMIT = 'abc123def456abc123def456abc123def456abc1'; // same = fresh
const EMBEDDING_MODEL_HASH = 'hash-a';
const SOURCE_MANIFEST_DIGEST = 'd'.repeat(64);

const STALE_INDEXED_COMMIT = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';

function makeRuntimeHealth(
  freshnessState:
    | 'clean'
    | 'stale'
    | 'dirty'
    | 'degraded'
    | 'untrusted'
    | 'failed-after-partial-run' = 'clean',
) {
  return {
    version: 1 as const,
    repoLabel: REPO_ID,
    repoPath: REPO_PATH,
    indexedCommit: INDEXED_COMMIT,
    currentCommit: CURRENT_COMMIT,
    dirtyWorktree: false,
    freshnessState,
    degradedReason: freshnessState === 'clean' ? null : `${freshnessState} reason`,
    repairCommand: 'ontoindex analyze --force',
    repairAction: {
      tool: 'ontoindex' as const,
      command: 'analyze' as const,
      args: ['--force'],
      reason: 'fixture repair',
    },
    hasRuntimeArtifacts: freshnessState !== 'clean',
    analyzeLock: {
      path: `${REPO_PATH}/.ontoindex/analyze.lock`,
      present: false,
      state: 'absent' as const,
    },
    analysisCheckpoint: {
      path: `${REPO_PATH}/.ontoindex/analysis-checkpoint.json`,
      present: false,
      state: 'absent' as const,
    },
    embeddingCheckpoint: {
      path: `${REPO_PATH}/.ontoindex/embedding-checkpoint.json`,
      present: false,
    },
    bootstrapSource: {
      path: `${REPO_PATH}/.ontoindex/bootstrap-source.json`,
      present: false,
    },
    warnings: [],
  };
}

/** Build a minimal registry JSON string. */
function makeRegistry(
  options: {
    name?: string;
    path?: string;
    lastCommit?: string;
    embeddings?: number;
  } = {},
): string {
  return JSON.stringify([
    {
      name: options.name ?? REPO_ID,
      path: options.path ?? REPO_PATH,
      lastCommit: options.lastCommit ?? INDEXED_COMMIT,
      stats: {
        embeddings: options.embeddings ?? 0,
      },
    },
  ]);
}

function makeMeta(
  options: {
    lastCommit?: string;
    embeddings?: number;
    modelHash?: string;
  } = {},
) {
  return {
    repoPath: REPO_PATH,
    lastCommit: options.lastCommit ?? INDEXED_COMMIT,
    indexedAt: '2026-06-17T00:00:00.000Z',
    generationId: 'generation-1',
    model_hash: options.modelHash ?? EMBEDDING_MODEL_HASH,
    stats: {
      embeddings: options.embeddings ?? 12,
    },
  };
}

/** Set up execFile to handle the standard calls. */
function setupExecFile(
  options: {
    currentCommit?: string;
    repoRoot?: string;
    statusOutput?: string;
  } = {},
) {
  const { currentCommit = CURRENT_COMMIT, repoRoot = REPO_PATH, statusOutput = '' } = options;

  mockExecFile.mockImplementation((_cmd: string, args: string[], _opts: any, callback: any) => {
    // git rev-parse --show-toplevel
    if (args.includes('--show-toplevel')) {
      callback(null, repoRoot + '\n', '');
      return {} as any;
    }
    // git rev-parse HEAD
    if (args.includes('HEAD') && args.includes('rev-parse')) {
      callback(null, currentCommit + '\n', '');
      return {} as any;
    }
    if (args.includes('status') && args.includes('--porcelain')) {
      callback(null, statusOutput, '');
      return {} as any;
    }
    callback(null, '', '');
    return {} as any;
  });
}

function setupSpawnExit(code: number = 0) {
  mockSpawn.mockImplementation(() => {
    const child = new EventEmitter() as any;
    child.kill = vi.fn();
    setImmediate(() => child.emit('exit', code, null));
    return child;
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('gnEnsureFresh', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    savedEnv = {};
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('ONTOINDEX_')) {
        savedEnv[key] = process.env[key];
        delete process.env[key];
      }
    }
    process.env.ONTOINDEX_EMBEDDING_MODEL_HASH = EMBEDDING_MODEL_HASH;
    setupSpawnExit();
    mockReadRuntimeHealth.mockResolvedValue(makeRuntimeHealth());
    mockLoadMeta.mockResolvedValue(makeMeta() as any);
    mockResolveActiveIndexGeneration.mockResolvedValue({
      generationId: 'generation-1',
      generationPath: `${REPO_PATH}/.ontoindex/generations/generation-1`,
    } as any);
    mockReadActiveGenerationMeta.mockImplementation(async (storagePath) => {
      const activeGeneration = await mockResolveActiveIndexGeneration(storagePath);
      const meta = await mockLoadMeta(storagePath);

      if (activeGeneration && meta?.generationId === activeGeneration.generationId) {
        return { activeGeneration, meta, authority: 'active-generation' };
      }
      if (!activeGeneration && meta && meta.generationId === undefined) {
        return { activeGeneration: null, meta, authority: 'legacy-root' };
      }
      return {
        activeGeneration,
        meta: null,
        authority: 'untrusted',
        reason: activeGeneration
          ? meta
            ? 'active-generation-metadata-mismatch'
            : 'active-generation-metadata-unavailable'
          : meta?.generationId
            ? 'generation-tagged-root-metadata-without-active-generation'
            : 'legacy-root-metadata-unavailable',
      };
    });
    mockSubmitAnalysisJob.mockResolvedValue({
      reused: false,
      job: {
        version: 1,
        id: 'job-1',
        status: 'queued',
        repoPath: REPO_PATH,
        targetHead: CURRENT_COMMIT,
        optionsDigest: 'options-digest',
        command: process.execPath,
        args: ['analyze'],
        logPath: `${REPO_PATH}/.ontoindex/analysis-jobs/job-1.log`,
        createdAt: '2026-08-05T00:00:00.000Z',
      },
    });
    mockComputeSourceManifest.mockResolvedValue({
      version: 1,
      head: CURRENT_COMMIT,
      sourceDigest: 'source-digest',
      sourceEntryCount: 1,
      includePaths: [],
      scopeDigest: 'scope-digest',
      ignorePolicyDigest: 'ignore-digest',
      pipelineProfile: 'full',
      analyzerContractVersion: 'ontoindex-source-manifest-v1',
      coverage: 'complete',
    });
    mockSourceManifestDigest.mockReturnValue(SOURCE_MANIFEST_DIGEST);
    mockResolveTargetContext.mockResolvedValue({
      version: 1,
      status: 'ok',
      repoKey: REPO_ID,
      repoLabel: REPO_ID,
      repoPath: REPO_PATH,
      targetRef: 'HEAD',
      targetHead: CURRENT_COMMIT,
      currentHead: CURRENT_COMMIT,
      indexedHead: CURRENT_COMMIT,
      dirtyWorktree: true,
      dirtyFileCount: 1,
      dirtyWorkspace: {
        state: 'dirty-file',
        changedFiles: ['src/edit.ts'],
        untrackedFiles: [],
        deletedFiles: [],
        graphCoveredFiles: [],
        unknownGraphCoverageFiles: ['src/edit.ts'],
        graphCoveredCount: 0,
        unknownGraphCoverageCount: 1,
      },
      changedSinceIndex: true,
      snapshotMode: 'worktree',
      qualityMode: 'fast',
      scopeConfidence: 'medium',
      embeddings: { status: 'available', count: 12 },
      lsp: { status: 'unknown' },
      sidecar: { status: 'unknown' },
      policy: { status: 'unknown' },
      warnings: [],
    } as any);
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('ONTOINDEX_')) delete process.env[key];
    }
    for (const [key, val] of Object.entries(savedEnv)) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
  });

  // ---- Test 1: Fresh index → isStale: false --------------------------------
  it('returns isStale: false when indexedCommit matches currentCommit', async () => {
    setupExecFile({ currentCommit: CURRENT_COMMIT });
    mockReadFileSync.mockReturnValue(makeRegistry({ lastCommit: CURRENT_COMMIT }) as any);

    const report = await gnEnsureFresh(REPO_ID, {});

    expect(report.version).toBe(1);
    expect(report.preCheck.isStale).toBe(false);
    expect(report.preCheck.currentCommit).toBe(CURRENT_COMMIT);
    expect(report.preCheck.indexedCommit).toBe(CURRENT_COMMIT);
    expect(report.repoLabel).toBe(REPO_ID);
    expect(report.repoPath).toBe(REPO_PATH);
    expect(report.headCommit).toBe(CURRENT_COMMIT);
    expect(report.indexedCommit).toBe(CURRENT_COMMIT);
    expect(report.dirtyFileCount).toBe(0);
    expect(report.scopeConfidence).toBe('high');
    expect(report.actionsTaken).toHaveLength(0);
    expect(report.warnings).toHaveLength(0);
    // No stale recommendation
    expect(report.recommendations.some((r) => r.includes('stale'))).toBe(false);
  });

  it('uses canonical dirty-worktree freshness without changing commit staleness', async () => {
    setupExecFile({ currentCommit: CURRENT_COMMIT, statusOutput: ' M src/edit.ts\n' });
    mockReadFileSync.mockReturnValue(makeRegistry({ lastCommit: CURRENT_COMMIT }) as any);

    const envelope = await gnEnsureFresh(REPO_ID, { legacyResponse: false });

    expect(envelope.freshness).toMatchObject({
      status: 'degraded',
      reason: 'dirty-worktree-overlay',
      isStale: false,
      dirtyFileCount: 1,
    });
    expect(envelope.results).not.toHaveProperty('preCheck');
    expect(envelope.results).not.toHaveProperty('isStale');
    expect(envelope.results).not.toHaveProperty('dirtyFileCount');
    expect(envelope.results).not.toHaveProperty('scopeConfidence');
  });

  it('resolves MCP backend repo ids case-insensitively and reads HEAD from the registry path', async () => {
    let headCwd: string | undefined;
    mockExecFile.mockImplementation((_cmd: string, args: string[], opts: any, callback: any) => {
      if (args.includes('HEAD') && args.includes('rev-parse')) {
        headCwd = opts.cwd;
        callback(null, CURRENT_COMMIT + '\n', '');
        return {} as any;
      }
      callback(null, '', '');
      return {} as any;
    });
    mockReadFileSync.mockReturnValue(
      makeRegistry({ name: 'Test-Repo', path: REPO_PATH, lastCommit: CURRENT_COMMIT }) as any,
    );

    const report = await gnEnsureFresh('test-repo', {});

    expect(headCwd).toBe(REPO_PATH);
    expect(report.preCheck).toEqual({
      indexedCommit: CURRENT_COMMIT,
      currentCommit: CURRENT_COMMIT,
      isStale: false,
    });
    expect(report.repoLabel).toBe('Test-Repo');
    expect(report.repoPath).toBe(REPO_PATH);
    expect(report.scopeConfidence).toBe('high');
    expect(report.warnings).toHaveLength(0);
  });

  it('resolves absolute repo path selectors without depending on process cwd', async () => {
    let headCwd: string | undefined;
    mockExecFile.mockImplementation((_cmd: string, args: string[], opts: any, callback: any) => {
      if (args.includes('HEAD') && args.includes('rev-parse')) {
        headCwd = opts.cwd;
        callback(null, CURRENT_COMMIT + '\n', '');
        return {} as any;
      }
      callback(null, '', '');
      return {} as any;
    });
    mockReadFileSync.mockReturnValue(
      makeRegistry({ path: REPO_PATH, lastCommit: CURRENT_COMMIT }) as any,
    );

    const report = await gnEnsureFresh(REPO_PATH, {});

    expect(headCwd).toBe(REPO_PATH);
    expect(report.preCheck.currentCommit).toBe(CURRENT_COMMIT);
    expect(report.preCheck.indexedCommit).toBe(CURRENT_COMMIT);
    expect(report.repoLabel).toBe(REPO_ID);
    expect(report.repoPath).toBe(REPO_PATH);
    expect(report.scopeConfidence).toBe('high');
    expect(report.warnings).toHaveLength(0);
  });

  it('falls back to the cwd repo when no selector is provided', async () => {
    setupExecFile({ currentCommit: CURRENT_COMMIT });
    mockReadFileSync.mockReturnValue(makeRegistry({ lastCommit: CURRENT_COMMIT }) as any);

    const report = await gnEnsureFresh('', {});

    expect(report.repoLabel).toBe(REPO_ID);
    expect(report.repoPath).toBe(REPO_PATH);
    expect(report.scopeConfidence).toBe('medium');
    expect(report.dirtyFileCount).toBe(0);
  });

  // ---- Test 2: Stale without autoAnalyze → recommendations, no actions ----
  it('populates recommendations but takes no actions when stale and autoAnalyze is false', async () => {
    setupExecFile({ currentCommit: CURRENT_COMMIT });
    mockReadFileSync.mockReturnValue(makeRegistry({ lastCommit: CURRENT_COMMIT }) as any);
    mockLoadMeta.mockResolvedValue(makeMeta({ lastCommit: STALE_INDEXED_COMMIT }) as any);

    const report = await gnEnsureFresh(REPO_ID, { autoAnalyze: false });

    expect(report.preCheck.isStale).toBe(true);
    expect(report.preCheck.indexedCommit).toBe(STALE_INDEXED_COMMIT);
    expect(report.preCheck.currentCommit).toBe(CURRENT_COMMIT);
    expect(report.actionsTaken).toHaveLength(0);
    expect(report.recommendations.length).toBeGreaterThan(0);
    expect(report.recommendations[0]).toContain('stale');
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  // ---- Test 3: Stale with autoAnalyze: true → durable job submitted --------
  it('submits ontoindex analyze when stale and autoAnalyze: true', async () => {
    setupExecFile({ currentCommit: CURRENT_COMMIT });
    // First readFileSync call: pre-check registry; second: post-check registry
    mockReadFileSync.mockReturnValue(makeRegistry({ lastCommit: CURRENT_COMMIT }) as any);
    mockLoadMeta.mockResolvedValue(makeMeta({ lastCommit: STALE_INDEXED_COMMIT }) as any);

    const report = await gnEnsureFresh(REPO_ID, { autoAnalyze: true });

    expect(mockSubmitAnalysisJob).toHaveBeenCalledTimes(1);
    expect(mockSubmitAnalysisJob).toHaveBeenCalledWith(
      expect.objectContaining({
        repoPath: REPO_PATH,
        targetHead: CURRENT_COMMIT,
        sourceIdentity: `commit:${CURRENT_COMMIT}`,
        requestedCapabilities: {
          version: 1,
          graph: true,
          graphCapabilities: ['symbols'],
          embeddings: false,
          embeddingModelHash: null,
        },
        sourceManifestDigest: SOURCE_MANIFEST_DIGEST,
      }),
    );
    expect(mockComputeSourceManifest).toHaveBeenCalledWith(REPO_PATH, {
      includePaths: [],
      pipelineProfile: 'full',
    });
    expect(mockSubmitAnalysisJob.mock.calls[0][0].args).toContain('analyze');
    expect(mockSubmitAnalysisJob.mock.calls[0][0].args).not.toContain('--embeddings');

    expect(report.actionsTaken).toHaveLength(1);
    expect(report.actionsTaken[0]).toContain('job-1');
    expect(report.analysisJob?.id).toBe('job-1');
    expect(report.analysisSubmission).toEqual({ status: 'queued', jobId: 'job-1' });
    expect(report.postCheck).toBeUndefined();
  });

  it('does not autoAnalyze when runtime health is untrusted', async () => {
    setupExecFile({ currentCommit: CURRENT_COMMIT });
    mockReadRuntimeHealth.mockResolvedValue(makeRuntimeHealth('untrusted'));
    mockReadFileSync.mockReturnValue(makeRegistry({ lastCommit: STALE_INDEXED_COMMIT }) as any);

    const report = await gnEnsureFresh(REPO_ID, { autoAnalyze: true });

    expect(mockSubmitAnalysisJob).not.toHaveBeenCalled();
    expect(report.runtimeHealth?.freshnessState).toBe('untrusted');
    expect(report.recommendations.some((item) => item.includes('repair manually'))).toBe(true);
    expect(report.actionsTaken).toHaveLength(0);
  });

  it('routes stale-lock recovery through one managed analyze invocation', async () => {
    setupExecFile({ currentCommit: CURRENT_COMMIT });
    mockReadRuntimeHealth.mockResolvedValue({
      ...makeRuntimeHealth('untrusted'),
      analyzeLock: {
        path: `${REPO_PATH}/.ontoindex/analyze.lock`,
        present: true,
        state: 'stale' as const,
        pid: 123,
      },
    });
    mockReadFileSync.mockReturnValue(makeRegistry({ lastCommit: CURRENT_COMMIT }) as any);

    const report = await gnEnsureFresh(REPO_ID, { autoAnalyze: true });

    expect(mockSubmitAnalysisJob).toHaveBeenCalledTimes(1);
    expect(mockSubmitAnalysisJob.mock.calls[0][0].args).toContain('analyze');
    expect(mockSubmitAnalysisJob.mock.calls[0][0].args).toContain('--force');
    expect(report.actionsTaken).toHaveLength(1);
  });

  it('forces managed recovery after a failed partial run', async () => {
    setupExecFile({ currentCommit: CURRENT_COMMIT });
    mockReadRuntimeHealth.mockResolvedValue(makeRuntimeHealth('failed-after-partial-run'));
    mockReadFileSync.mockReturnValue(makeRegistry({ lastCommit: CURRENT_COMMIT }) as any);

    const report = await gnEnsureFresh(REPO_ID, { autoAnalyze: true });

    expect(mockSubmitAnalysisJob).toHaveBeenCalledTimes(1);
    expect(mockSubmitAnalysisJob.mock.calls[0][0].args).toContain('--force');
    expect(report.analysisSubmission).toEqual({ status: 'queued', jobId: 'job-1' });
  });

  // ---- Test 4: withEmbeddings: true adds --embeddings to analyze args ------
  it('adds --embeddings to analyze args when withEmbeddings: true', async () => {
    setupExecFile({ currentCommit: CURRENT_COMMIT });
    mockReadFileSync.mockReturnValue(makeRegistry({ lastCommit: STALE_INDEXED_COMMIT }) as any);
    mockLoadMeta.mockResolvedValue(makeMeta({ lastCommit: STALE_INDEXED_COMMIT }) as any);

    await gnEnsureFresh(REPO_ID, { autoAnalyze: true, withEmbeddings: true });

    expect(mockSubmitAnalysisJob).toHaveBeenCalledTimes(1);
    expect(mockSubmitAnalysisJob.mock.calls[0][0].args).toContain('--embeddings');
    expect(mockSubmitAnalysisJob.mock.calls[0][0].requestedCapabilities).toEqual({
      version: 1,
      graph: true,
      graphCapabilities: ['symbols'],
      embeddings: true,
      embeddingModelHash: EMBEDDING_MODEL_HASH,
    });
  });

  it('normalizes requested graph capabilities before submission', async () => {
    setupExecFile({ currentCommit: CURRENT_COMMIT });
    mockReadFileSync.mockReturnValue(makeRegistry({ lastCommit: STALE_INDEXED_COMMIT }) as any);
    mockLoadMeta.mockResolvedValue(makeMeta({ lastCommit: STALE_INDEXED_COMMIT }) as any);

    await gnEnsureFresh(REPO_ID, {
      autoAnalyze: true,
      requiredGraphCapabilities: ['symbols', 'impact', 'symbols', 'processes'],
    });

    expect(mockSubmitAnalysisJob.mock.calls[0][0].requestedCapabilities.graphCapabilities).toEqual([
      'impact',
      'processes',
      'symbols',
    ]);
  });

  it.each([{ capabilities: [] }, { capabilities: ['unknown'] }])(
    'rejects invalid required graph capabilities ($capabilities)',
    async ({ capabilities }) => {
      await expect(
        gnEnsureFresh(REPO_ID, { requiredGraphCapabilities: capabilities as any }),
      ).rejects.toThrow(/requiredGraphCapabilities/);
      expect(mockSubmitAnalysisJob).not.toHaveBeenCalled();
    },
  );

  it('blocks managed embedding analysis without a model identity', async () => {
    setupExecFile({ currentCommit: CURRENT_COMMIT });
    mockReadFileSync.mockReturnValue(makeRegistry({ lastCommit: STALE_INDEXED_COMMIT }) as any);
    delete process.env.ONTOINDEX_EMBEDDING_MODEL_HASH;

    const report = await gnEnsureFresh(REPO_ID, { autoAnalyze: true, withEmbeddings: true });

    expect(report.analysisSubmission).toMatchObject({
      status: 'blocked',
      reasonCode: 'EMBEDDING_MODEL_IDENTITY_UNAVAILABLE',
    });
    expect(mockComputeSourceManifest).not.toHaveBeenCalled();
    expect(mockSubmitAnalysisJob).not.toHaveBeenCalled();
  });

  it('queues forced embeddings repair when HEAD is fresh but requested embeddings are missing', async () => {
    setupExecFile({ currentCommit: CURRENT_COMMIT });
    mockReadFileSync.mockReturnValue(
      makeRegistry({ lastCommit: CURRENT_COMMIT, embeddings: 0 }) as any,
    );
    mockLoadMeta.mockResolvedValue(makeMeta({ embeddings: 0 }) as any);

    const report = await gnEnsureFresh(REPO_ID, {
      autoAnalyze: true,
      withEmbeddings: true,
    });

    expect(mockSubmitAnalysisJob).toHaveBeenCalledTimes(1);
    expect(mockSubmitAnalysisJob.mock.calls[0][0]).toMatchObject({
      sourceIdentity: `commit:${CURRENT_COMMIT}`,
      requestedCapabilities: { graph: true, embeddings: true },
    });
    expect(mockSubmitAnalysisJob.mock.calls[0][0].args).toEqual(
      expect.arrayContaining(['analyze', '--force', '--embeddings']),
    );
    expect(report.analysisSubmission).toEqual({ status: 'queued', jobId: 'job-1' });
    expect(report.actionsTaken[0]).toContain('analyze --force --embeddings');
  });

  it('does not submit analysis when HEAD and requested embeddings are already satisfied', async () => {
    setupExecFile({ currentCommit: CURRENT_COMMIT });
    mockReadFileSync.mockReturnValue(
      makeRegistry({ lastCommit: CURRENT_COMMIT, embeddings: 12 }) as any,
    );
    mockLoadMeta.mockResolvedValue(makeMeta({ embeddings: 12 }) as any);

    const report = await gnEnsureFresh(REPO_ID, {
      autoAnalyze: true,
      withEmbeddings: true,
    });

    expect(mockSubmitAnalysisJob).not.toHaveBeenCalled();
    expect(mockComputeSourceManifest).not.toHaveBeenCalled();
    expect(report.analysisSubmission).toEqual({ status: 'not-needed' });
    expect(report.actionsTaken).toHaveLength(0);
  });

  it('blocks analysis when the worktree is dirty', async () => {
    setupExecFile({ currentCommit: CURRENT_COMMIT, statusOutput: ' M src/edit.ts\n' });
    mockReadFileSync.mockReturnValue(makeRegistry({ lastCommit: CURRENT_COMMIT }) as any);

    const report = await gnEnsureFresh(REPO_ID, { autoAnalyze: true });

    expect(mockSubmitAnalysisJob).not.toHaveBeenCalled();
    expect(report.analysisSubmission).toMatchObject({
      status: 'blocked',
      reasonCode: 'WORKTREE_DIRTY',
    });
  });

  it('blocks analysis when worktree status is unavailable', async () => {
    mockExecFile.mockImplementation((_cmd: string, args: string[], _opts: any, callback: any) => {
      if (args.includes('HEAD') && args.includes('rev-parse')) {
        callback(null, CURRENT_COMMIT + '\n', '');
        return {} as any;
      }
      if (args.includes('status') && args.includes('--porcelain')) {
        callback(new Error('status unavailable'), '', '');
        return {} as any;
      }
      callback(null, '', '');
      return {} as any;
    });
    mockReadFileSync.mockReturnValue(makeRegistry({ lastCommit: CURRENT_COMMIT }) as any);

    const report = await gnEnsureFresh(REPO_ID, { autoAnalyze: true });

    expect(mockSubmitAnalysisJob).not.toHaveBeenCalled();
    expect(report.analysisSubmission).toMatchObject({
      status: 'blocked',
      reasonCode: 'WORKTREE_STATUS_UNAVAILABLE',
    });
  });

  it.each(['', 'not-a-commit'])(
    'blocks analysis when HEAD is unavailable or malformed (%s)',
    async (head) => {
      setupExecFile({ currentCommit: head });
      mockReadFileSync.mockReturnValue(makeRegistry({ lastCommit: STALE_INDEXED_COMMIT }) as any);
      mockReadRuntimeHealth.mockResolvedValue(makeRuntimeHealth('failed-after-partial-run'));

      const report = await gnEnsureFresh(REPO_ID, { autoAnalyze: true });

      expect(mockSubmitAnalysisJob).not.toHaveBeenCalled();
      expect(report.analysisSubmission).toMatchObject({
        status: 'blocked',
        reasonCode: 'HEAD_UNAVAILABLE',
      });
    },
  );

  it('accepts a valid 64-character git HEAD for clean analysis submission', async () => {
    const sha256Head = 'a'.repeat(64);
    setupExecFile({ currentCommit: sha256Head });
    mockReadFileSync.mockReturnValue(makeRegistry({ lastCommit: STALE_INDEXED_COMMIT }) as any);

    const report = await gnEnsureFresh(REPO_ID, { autoAnalyze: true });

    expect(mockSubmitAnalysisJob).toHaveBeenCalledWith(
      expect.objectContaining({
        targetHead: sha256Head,
        sourceIdentity: `commit:${sha256Head}`,
      }),
    );
    expect(report.analysisSubmission).toEqual({ status: 'queued', jobId: 'job-1' });
  });

  // ---- Test 5: embeddingsCount surfaced from registry ---------------------
  it('surfaces embeddingsCount from registry stats', async () => {
    setupExecFile({ currentCommit: CURRENT_COMMIT });
    mockReadFileSync.mockReturnValue(
      makeRegistry({ lastCommit: CURRENT_COMMIT, embeddings: 42 }) as any,
    );
    mockLoadMeta.mockResolvedValue(makeMeta({ embeddings: 42 }) as any);

    const report = await gnEnsureFresh(REPO_ID, {});

    expect(report.embeddingsStatus.count).toBe(42);
    expect(report.embeddingsStatus.required).toBe(false);
    expect(report.embeddingsStatus.status).toBe('ok');
    expect(report.embeddingsStatus.repairCommand).toBeUndefined();
  });

  // ---- Bonus Test 6: withEmbeddings + count=0 → required: true + recommendation
  it('marks embeddingsStatus.required: true when withEmbeddings and count is 0', async () => {
    setupExecFile({ currentCommit: CURRENT_COMMIT });
    mockReadFileSync.mockReturnValue(
      makeRegistry({ lastCommit: CURRENT_COMMIT, embeddings: 0 }) as any,
    );
    mockLoadMeta.mockResolvedValue(makeMeta({ embeddings: 0 }) as any);

    const report = await gnEnsureFresh(REPO_ID, { withEmbeddings: true });

    expect(report.embeddingsStatus.required).toBe(true);
    expect(report.embeddingsStatus.status).toBe('missing');
    expect(report.recommendations.some((r) => r.includes('ontoindex analyze'))).toBe(true);
  });

  it('marks embeddingsStatus.metadata-unavailable when repo metadata is missing', async () => {
    setupExecFile({ currentCommit: CURRENT_COMMIT });
    mockReadFileSync.mockReturnValue(
      makeRegistry({ lastCommit: CURRENT_COMMIT, embeddings: 5 }) as any,
    );
    mockLoadMeta.mockResolvedValue(null);

    const report = await gnEnsureFresh(REPO_ID, {});

    expect(report.embeddingsStatus.status).toBe('metadata-unavailable');
    expect(report.embeddingsStatus.reason).toMatch(/unavailable/i);
    expect(report.embeddingsStatus.repairCommand).toBe('ontoindex analyze');
  });

  it('marks embeddingsStatus.drifted when the stored embedding hash differs from the runtime hash', async () => {
    setupExecFile({ currentCommit: CURRENT_COMMIT });
    mockReadFileSync.mockReturnValue(
      makeRegistry({ lastCommit: CURRENT_COMMIT, embeddings: 12 }) as any,
    );
    mockLoadMeta.mockResolvedValue(makeMeta({ modelHash: 'stored-hash', embeddings: 12 }) as any);
    process.env.ONTOINDEX_EMBEDDING_MODEL_HASH = 'runtime-hash';

    const report = await gnEnsureFresh(REPO_ID, {});

    expect(report.embeddingsStatus.status).toBe('drifted');
    expect(report.embeddingsStatus.reason).toContain('stored-hash');
    expect(report.embeddingsStatus.repairCommand).toBe('ontoindex analyze --force --embeddings');
  });

  it('keeps embeddingsStatus.ok when embeddings exist and the runtime hash is unset', async () => {
    setupExecFile({ currentCommit: CURRENT_COMMIT });
    mockReadFileSync.mockReturnValue(
      makeRegistry({ lastCommit: CURRENT_COMMIT, embeddings: 12 }) as any,
    );
    mockLoadMeta.mockResolvedValue(makeMeta({ modelHash: 'stored-hash', embeddings: 12 }) as any);
    delete process.env.ONTOINDEX_EMBEDDING_MODEL_HASH;

    const report = await gnEnsureFresh(REPO_ID, {});

    expect(report.embeddingsStatus.status).toBe('ok');
    expect(report.embeddingsStatus.count).toBe(12);
    expect(report.embeddingsStatus.reason).toContain('drift check skipped');
  });

  // ---- Bonus Test 7: repo not in registry → warning + empty preCheck ------
  it('returns warning when repo is not found in registry', async () => {
    setupExecFile({ currentCommit: CURRENT_COMMIT });
    // Registry has a different repo
    mockReadFileSync.mockReturnValue(
      JSON.stringify([{ name: 'other-repo', path: '/other', lastCommit: 'aaa', stats: {} }]) as any,
    );

    const report = await gnEnsureFresh(REPO_ID, {});

    expect(report.warnings.some((w) => w.includes('not in registry'))).toBe(true);
    expect(report.preCheck.isStale).toBe(false);
    expect(report.actionsTaken).toHaveLength(0);
  });

  it('reports autoAnalyze as blocked when the repo is not registered', async () => {
    setupExecFile({ currentCommit: CURRENT_COMMIT });
    mockReadFileSync.mockReturnValue(
      JSON.stringify([{ name: 'other-repo', path: '/other', lastCommit: 'aaa', stats: {} }]) as any,
    );

    const report = await gnEnsureFresh(REPO_ID, { autoAnalyze: true });

    expect(report.analysisSubmission).toEqual({
      status: 'blocked',
      reasonCode: 'REPO_NOT_REGISTERED',
      message: 'Repository is not registered; analysis cannot be submitted.',
    });
  });

  // ---- Bonus Test 8: analyze failure → warning, no crash ------------------
  it('records a warning when autoAnalyze process fails', async () => {
    setupExecFile({ currentCommit: CURRENT_COMMIT });
    mockSubmitAnalysisJob.mockRejectedValue(new Error('spawn failed'));
    mockReadFileSync.mockReturnValue(makeRegistry({ lastCommit: STALE_INDEXED_COMMIT }) as any);
    mockLoadMeta.mockResolvedValue(makeMeta({ lastCommit: STALE_INDEXED_COMMIT }) as any);

    const report = await gnEnsureFresh(REPO_ID, { autoAnalyze: true });

    expect(report.warnings.some((w) => w.includes('submission failed'))).toBe(true);
    expect(report.analysisSubmission).toEqual({
      status: 'failed',
      errorCode: 'ANALYZE_JOB_SUBMISSION_FAILED',
      message: 'spawn failed',
    });
    expect(report.actionsTaken).toHaveLength(0);
  });

  it('returns an error envelope when requested job submission fails', async () => {
    setupExecFile({ currentCommit: CURRENT_COMMIT });
    mockSubmitAnalysisJob.mockRejectedValue(
      Object.assign(new Error('directory read'), { code: 'EISDIR' }),
    );
    mockReadFileSync.mockReturnValue(makeRegistry({ lastCommit: STALE_INDEXED_COMMIT }) as any);
    mockLoadMeta.mockResolvedValue(makeMeta({ lastCommit: STALE_INDEXED_COMMIT }) as any);

    const envelope = await gnEnsureFresh(REPO_ID, { autoAnalyze: true, legacyResponse: false });

    expect(envelope.status).toBe('error');
    expect(envelope.results.analysisSubmission).toEqual({
      status: 'failed',
      errorCode: 'ANALYZE_JOB_SUBMISSION_FAILED',
      causeCode: 'EISDIR',
      message: 'directory read',
    });
  });

  it('maps coordinator lock conflicts to a degraded blocked envelope', async () => {
    setupExecFile({ currentCommit: CURRENT_COMMIT });
    mockSubmitAnalysisJob.mockRejectedValue(
      Object.assign(new Error('another managed analysis owns the lock'), { code: 'LOCK_CONFLICT' }),
    );
    mockReadFileSync.mockReturnValue(makeRegistry({ lastCommit: STALE_INDEXED_COMMIT }) as any);
    mockLoadMeta.mockResolvedValue(makeMeta({ lastCommit: STALE_INDEXED_COMMIT }) as any);

    const envelope = await gnEnsureFresh(REPO_ID, { autoAnalyze: true, legacyResponse: false });

    expect(envelope.status).toBe('degraded');
    expect(envelope.results.analysisSubmission).toEqual({
      status: 'blocked',
      reasonCode: 'LOCK_CONFLICT',
      message: 'another managed analysis owns the lock',
    });
    expect(envelope.warnings.join('\n')).not.toMatch(/delete.*lock/i);
  });

  it('maps active managed job conflicts to the existing job ID', async () => {
    setupExecFile({ currentCommit: CURRENT_COMMIT });
    mockSubmitAnalysisJob.mockRejectedValue(
      Object.assign(new Error('an incompatible managed analysis is already active'), {
        code: 'ACTIVE_JOB_CONFLICT',
        activeJobId: 'job-active',
      }),
    );
    mockReadFileSync.mockReturnValue(makeRegistry({ lastCommit: STALE_INDEXED_COMMIT }) as any);
    mockLoadMeta.mockResolvedValue(makeMeta({ lastCommit: STALE_INDEXED_COMMIT }) as any);

    const envelope = await gnEnsureFresh(REPO_ID, { autoAnalyze: true, legacyResponse: false });

    expect(envelope.status).toBe('degraded');
    expect(envelope.results.analysisSubmission).toEqual({
      status: 'blocked',
      reasonCode: 'ACTIVE_JOB_CONFLICT',
      message: 'an incompatible managed analysis is already active',
      jobId: 'job-active',
    });
  });

  it('reports an exact coordinator reuse as reused', async () => {
    setupExecFile({ currentCommit: CURRENT_COMMIT });
    mockReadFileSync.mockReturnValue(makeRegistry({ lastCommit: STALE_INDEXED_COMMIT }) as any);
    mockLoadMeta.mockResolvedValue(makeMeta({ lastCommit: STALE_INDEXED_COMMIT }) as any);
    mockSubmitAnalysisJob.mockResolvedValue({
      reused: true,
      job: {
        version: 1,
        id: 'job-reused',
        status: 'running',
        repoPath: REPO_PATH,
        targetHead: CURRENT_COMMIT,
        sourceIdentity: `commit:${CURRENT_COMMIT}`,
        requestedCapabilities: {
          version: 1,
          graph: true,
          graphCapabilities: ['symbols'],
          embeddings: false,
          embeddingModelHash: null,
        },
        optionsDigest: 'options-digest',
        sourceManifestDigest: SOURCE_MANIFEST_DIGEST,
        command: process.execPath,
        args: ['analyze'],
        logPath: `${REPO_PATH}/.ontoindex/analysis-jobs/job-reused.log`,
        createdAt: '2026-08-05T00:00:00.000Z',
      },
    } as any);

    const report = await gnEnsureFresh(REPO_ID, { autoAnalyze: true });

    expect(report.analysisSubmission).toEqual({ status: 'reused', jobId: 'job-reused' });
    expect(report.actionsTaken[0]).toContain('Reused analysis job job-reused');
  });

  // ---- Test 9: killMcpForLock:true is advisory only → no process kill ----
  it('does not kill MCP processes when killMcpForLock:true', async () => {
    setupExecFile({ currentCommit: CURRENT_COMMIT });
    mockReadFileSync.mockReturnValue(makeRegistry({ lastCommit: STALE_INDEXED_COMMIT }) as any);
    mockLoadMeta.mockResolvedValue(makeMeta({ lastCommit: STALE_INDEXED_COMMIT }) as any);

    const report = await gnEnsureFresh(REPO_ID, { autoAnalyze: true, killMcpForLock: true });

    expect(mockExecFile.mock.calls.some((call) => call[0] === 'kill')).toBe(false);
    expect(mockExecFile.mock.calls.some((call) => call[0] === 'pgrep')).toBe(false);
    // analyze ran
    expect(report.actionsTaken.some((a) => a.includes('job-1'))).toBe(true);
    expect(report.warnings.some((w) => w.includes('advisory only'))).toBe(true);
    expect(report.recommendations.some((r) => r.includes('Stop only the MCP process'))).toBe(true);
  });

  // ---- Test 10: killMcpForLock:true + autoAnalyze:false → note in recommendations ----
  it('adds a note in recommendations when killMcpForLock:true but autoAnalyze:false', async () => {
    setupExecFile({ currentCommit: CURRENT_COMMIT });
    mockReadFileSync.mockReturnValue(makeRegistry({ lastCommit: STALE_INDEXED_COMMIT }) as any);

    const report = await gnEnsureFresh(REPO_ID, { autoAnalyze: false, killMcpForLock: true });

    // no kill, no analyze
    expect(mockExecFile.mock.calls.some((call) => call[0] === 'kill')).toBe(false);
    expect(mockSpawn).not.toHaveBeenCalled();
    // note in recommendations
    expect(
      report.recommendations.some((r) => r.includes('no effect without autoAnalyze: true')),
    ).toBe(true);
  });
});
