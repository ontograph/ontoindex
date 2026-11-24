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
  getGlobalRegistryPath: vi.fn(
    () => `${process.env.ONTOINDEX_HOME || '/home/testuser/.ontoindex'}/registry.json`,
  ),
  loadMeta: vi.fn(),
  registerRepo: vi.fn(),
  RegistryNameCollisionError: class RegistryNameCollisionError extends Error {},
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

vi.mock('../../../src/mcp/shared/target-context.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/mcp/shared/target-context.js')>()),
  resolveTargetContext: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks).
// ---------------------------------------------------------------------------

import { EventEmitter } from 'events';
import { execFile, spawn } from 'child_process';
import { readFileSync } from 'fs';
import { gnEnsureFresh, resetFreshnessCache } from '../../../src/mcp/super/ensure-fresh.js';
import { dispatchFacade } from '../../../src/mcp/facade/dispatch.js';
import { ONTOINDEX_FACADE_TOOLS } from '../../../src/mcp/facade/tool-definitions.js';
import { ONTOINDEX_SUPER_TOOLS } from '../../../src/mcp/super/tool-definitions.js';
import type { LocalBackend } from '../../../src/mcp/local/local-backend.js';
import { readRuntimeHealth } from '../../../src/core/runtime/runtime-health.js';
import {
  loadMeta,
  registerRepo,
  RegistryNameCollisionError,
  readActiveGenerationMeta,
  resolveActiveIndexGeneration,
} from '../../../src/storage/repo-manager.js';
import { submitAnalysisJob } from '../../../src/core/analysis/analysis-coordinator.js';
import { createEnvelopeFromLegacy } from '../../../src/mcp/shared/response-envelope.js';
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
const mockRegisterRepo = vi.mocked(registerRepo);
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
const WORKSPACE_READINESS_WARNING =
  'Workspace readiness was not checked: this freshness report does not prove that workspace reads (the default read_mode) can be prepared. If a workspace read fails, inspect its diagnostics; read_mode="committed" queries the last index for supported operations.';
const WORKSPACE_READINESS_NO_COMMIT_WARNING =
  'Workspace readiness was not checked: this freshness report does not prove that workspace reads (the default read_mode) can be prepared. If a workspace read fails, inspect its diagnostics; this index has no trusted commit, so read_mode="committed" is unavailable.';

const STALE_INDEXED_COMMIT = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';

function makeRuntimeHealth(
  freshnessState:
    'clean' | 'stale' | 'dirty' | 'degraded' | 'untrusted' | 'failed-after-partial-run' = 'clean',
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
    workspaceReadiness: {
      state: 'not-checked' as const,
      dirtyCoverageScope: 'symbol-overlay-eligibility' as const,
      preparationChecked: false as const,
    },
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
    modelHash?: string | null;
  } = {},
) {
  return {
    repoPath: REPO_PATH,
    lastCommit: options.lastCommit ?? INDEXED_COMMIT,
    indexedAt: '2026-06-17T00:00:00.000Z',
    generationId: 'generation-1',
    ...(options.modelHash === null
      ? {}
      : { model_hash: options.modelHash ?? EMBEDDING_MODEL_HASH }),
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
    if (args.includes('status') && args.some((arg) => arg.startsWith('--porcelain'))) {
      callback(null, statusOutput, '');
      return {} as any;
    }
    callback(null, '', '');
    return {} as any;
  });
}

function setupSourceManifestMismatchTargetContext() {
  setupExecFile({ currentCommit: CURRENT_COMMIT, statusOutput: '' });
  mockReadFileSync.mockReturnValue(makeRegistry({ lastCommit: CURRENT_COMMIT }) as any);
  mockLoadMeta.mockResolvedValue(makeMeta({ lastCommit: CURRENT_COMMIT }) as any);
  mockReadRuntimeHealth.mockResolvedValue(makeRuntimeHealth('clean'));
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
    graphAuthority: {
      state: 'review',
      reason: 'current source manifest does not match indexed manifest',
    },
    dirtyWorktree: false,
    dirtyFileCount: 0,
    changedSinceIndex: false,
    snapshotMode: 'committed-head',
    qualityMode: 'fast',
    scopeConfidence: 'high',
    embeddings: { status: 'available', count: 12 },
    lsp: { status: 'unknown' },
    sidecar: { status: 'unknown' },
    policy: { status: 'unknown' },
    warnings: [],
  } as any);
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
  it('advertises omitted, true, and false embedding semantics without a schema default', () => {
    const facadeManage = ONTOINDEX_FACADE_TOOLS.find((tool) => tool.name === 'manage');
    const superEnsureFresh = ONTOINDEX_SUPER_TOOLS.find((tool) => tool.name === 'gn_ensure_fresh');
    const facadeProperty = facadeManage?.inputSchema.properties.withEmbeddings;
    const superProperty = superEnsureFresh?.inputSchema.properties.withEmbeddings;

    for (const property of [facadeProperty, superProperty]) {
      expect(property).toMatchObject({ type: 'boolean' });
      expect(property).not.toHaveProperty('default');
      expect(property?.description).toContain('Omit to preserve existing vectors');
      expect(property?.description).toContain('true to populate or refresh embeddings');
      expect(property?.description).toContain('false to block refreshes');
    }
  });

  it.each([undefined, '/custom/ontoindex-home'])(
    'reads the call-time registry home (%s)',
    async (home) => {
      if (home) process.env.ONTOINDEX_HOME = home;
      else delete process.env.ONTOINDEX_HOME;
      mockReadFileSync.mockReturnValue(makeRegistry() as any);
      setupExecFile();
      await gnEnsureFresh(REPO_ID, {});
      expect(mockReadFileSync).toHaveBeenCalledWith(
        `${home ?? '/home/testuser/.ontoindex'}/registry.json`,
        'utf8',
      );
    },
  );
  beforeEach(() => {
    vi.clearAllMocks();
    resetFreshnessCache();
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
      } as Awaited<ReturnType<typeof mockSubmitAnalysisJob>>['job'],
    });
    mockRegisterRepo.mockResolvedValue('registered-repo');
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
        dirtyPaths: ['src/edit.ts'],
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
    expect(report.warnings).toEqual([WORKSPACE_READINESS_WARNING]);
    // No stale recommendation
    expect(report.recommendations.some((r) => r.includes('stale'))).toBe(false);
  });

  it('warns that committed reads are unavailable when generation metadata has no commit', async () => {
    setupExecFile({ currentCommit: CURRENT_COMMIT });
    mockReadFileSync.mockReturnValue(makeRegistry({ lastCommit: CURRENT_COMMIT }) as any);
    mockLoadMeta.mockResolvedValue(makeMeta({ lastCommit: '' }) as any);

    const report = await gnEnsureFresh(REPO_ID, {});

    expect(report.warnings).toContain(WORKSPACE_READINESS_NO_COMMIT_WARNING);
    expect(report.warnings).not.toContain(WORKSPACE_READINESS_WARNING);
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

    const targetContext = await mockResolveTargetContext.mock.results[0].value;
    const dirtyResultEnvelope = createEnvelopeFromLegacy({
      legacy: { filePath: 'src/edit.ts' },
      tool: 'gn_ensure_fresh',
      status: 'success',
      targetContext,
      freshness: envelope.freshness,
    });
    expect(dirtyResultEnvelope.freshness.dirtyResultPaths).toEqual(['src/edit.ts']);
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
    expect(report.warnings).toContain(WORKSPACE_READINESS_WARNING);
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
    expect(report.warnings).toContain(WORKSPACE_READINESS_WARNING);
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

  it('recommends managed freshness and source/git until a stale index is fresh', async () => {
    setupExecFile({ currentCommit: CURRENT_COMMIT });
    const repoPathWithSpecialCharacters = `${REPO_PATH}/quoted"segment\\worktree`;
    mockReadFileSync.mockReturnValue(
      makeRegistry({ path: repoPathWithSpecialCharacters, lastCommit: CURRENT_COMMIT }) as any,
    );
    mockLoadMeta.mockResolvedValue(makeMeta({ lastCommit: STALE_INDEXED_COMMIT }) as any);

    const report = await gnEnsureFresh(REPO_ID, { autoAnalyze: false });

    expect(report.recommendations.slice(0, 2)).toEqual([
      `Index is stale (indexed ${STALE_INDEXED_COMMIT} vs current ${CURRENT_COMMIT}). Coordinator: use manage({ action: "ensure_fresh", repo: ${JSON.stringify(repoPathWithSpecialCharacters)}, autoAnalyze: true }), wait for the managed analysis job to complete successfully, and recheck freshness before using graph evidence.`,
      'Workers: use source files and git until the index is fresh; do not use stale graph evidence.',
    ]);
    expect(report.recommendations.join('\n')).not.toMatch(
      /ontoindex analyze|explicit stale-index consent/i,
    );
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
          embeddings: true,
          embeddingModelHash: EMBEDDING_MODEL_HASH,
        },
        sourceManifestDigest: SOURCE_MANIFEST_DIGEST,
      }),
    );
    expect(mockComputeSourceManifest).toHaveBeenCalledWith(REPO_PATH, {
      includePaths: [],
      pipelineProfile: 'full',
    });
    expect(mockSubmitAnalysisJob.mock.calls[0][0].args).toContain('analyze');
    expect(mockSubmitAnalysisJob.mock.calls[0][0].args).toContain('--skip-ai-context');
    expect(mockSubmitAnalysisJob.mock.calls[0][0].args).toContain('--embeddings');

    expect(report.actionsTaken).toHaveLength(1);
    expect(report.actionsTaken[0]).toContain('job-1');
    expect(report.analysisJob?.id).toBe('job-1');
    expect(report.analysisSubmission).toEqual({ status: 'queued', jobId: 'job-1' });
    expect(report.postCheck).toBeUndefined();
  });

  it('recommends public analyze_job polling with JSON-escaped repo path and job ID', async () => {
    setupExecFile({ currentCommit: CURRENT_COMMIT });
    const repoPathWithSpecialCharacters = `${REPO_PATH}/quoted"segment\\worktree`;
    const jobIdWithSpecialCharacters = 'job"\\id';
    mockReadFileSync.mockReturnValue(
      makeRegistry({ path: repoPathWithSpecialCharacters, lastCommit: CURRENT_COMMIT }) as any,
    );
    mockLoadMeta.mockResolvedValue(makeMeta({ lastCommit: STALE_INDEXED_COMMIT }) as any);
    mockSubmitAnalysisJob.mockResolvedValueOnce({
      reused: false,
      job: {
        version: 1,
        id: jobIdWithSpecialCharacters,
        status: 'queued',
        repoPath: repoPathWithSpecialCharacters,
        targetHead: CURRENT_COMMIT,
        optionsDigest: 'options-digest',
        command: process.execPath,
        args: ['analyze'],
        logPath: `${repoPathWithSpecialCharacters}/.ontoindex/analysis-jobs/job.log`,
        createdAt: '2026-08-05T00:00:00.000Z',
      } as Awaited<ReturnType<typeof mockSubmitAnalysisJob>>['job'],
    });

    const report = await gnEnsureFresh(REPO_ID, { autoAnalyze: true });

    expect(report.recommendations).toContain(
      `Poll the managed job with manage({ action: "analyze_job", repo: ${JSON.stringify(repoPathWithSpecialCharacters)}, jobId: ${JSON.stringify(jobIdWithSpecialCharacters)} }) until terminal status; verify success (exit code 0), generation ID, and log path.`,
    );
  });

  it('submits managed analysis when the source manifest is stale and the worktree is clean', async () => {
    setupExecFile({ currentCommit: CURRENT_COMMIT, statusOutput: '' });
    mockReadFileSync.mockReturnValue(makeRegistry({ lastCommit: CURRENT_COMMIT }) as any);
    mockLoadMeta.mockResolvedValue(makeMeta({ lastCommit: CURRENT_COMMIT }) as any);
    mockReadRuntimeHealth.mockResolvedValue({
      ...makeRuntimeHealth('stale'),
      degradedReason: 'current source manifest does not match indexed manifest',
    });

    const report = await gnEnsureFresh(REPO_ID, { autoAnalyze: true });

    expect(mockSubmitAnalysisJob).toHaveBeenCalledTimes(1);
    expect(mockSubmitAnalysisJob.mock.calls[0][0].args).toContain('analyze');
    expect(mockSubmitAnalysisJob.mock.calls[0][0].args).not.toContain('--force');
    expect(report.preCheck.isStale).toBe(false);
    expect(report.dirtyFileCount).toBe(0);
    expect(report.runtimeHealth?.freshnessState).toBe('stale');
    expect(report.analysisSubmission).toEqual({ status: 'queued', jobId: 'job-1' });
  });

  it('queues managed analysis when the modern graph authority reports a source-manifest mismatch', async () => {
    setupSourceManifestMismatchTargetContext();

    const envelope = await gnEnsureFresh(REPO_ID, { autoAnalyze: true, legacyResponse: false });

    expect(mockSubmitAnalysisJob).toHaveBeenCalledTimes(1);
    expect(mockSubmitAnalysisJob.mock.calls[0][0].args).toContain('analyze');
    expect(mockSubmitAnalysisJob.mock.calls[0][0].args).not.toContain('--force');
    expect(envelope.freshness).toMatchObject({
      status: 'stale',
      reason: 'current source manifest does not match indexed manifest',
      graphAuthorityState: 'review',
    });
    expect(envelope.results.analysisSubmission).toEqual({ status: 'queued', jobId: 'job-1' });
    expect(mockResolveTargetContext).toHaveBeenCalledTimes(1);
  });

  it('queues managed analysis for a legacy response when graph authority reports a source-manifest mismatch', async () => {
    setupSourceManifestMismatchTargetContext();

    const report = await gnEnsureFresh(REPO_ID, { autoAnalyze: true, legacyResponse: true });

    expect(mockSubmitAnalysisJob).toHaveBeenCalledTimes(1);
    expect(mockSubmitAnalysisJob.mock.calls[0][0].args).not.toContain('--force');
    expect(report.analysisSubmission).toEqual({ status: 'queued', jobId: 'job-1' });
    expect(mockResolveTargetContext).toHaveBeenCalledTimes(1);
  });

  it('passes the recorded scope to the manifest and analyze job', async () => {
    setupExecFile();
    mockReadFileSync.mockReturnValue(makeRegistry() as any);
    mockLoadMeta.mockResolvedValue(makeMeta({ lastCommit: STALE_INDEXED_COMMIT }) as any);
    const scope = {
      includePaths: ['extension/aso/', 'test/sql/aso/'],
      pipelineProfile: 'symbols' as const,
    };
    await gnEnsureFresh(REPO_ID, { autoAnalyze: true, scope });
    expect(mockComputeSourceManifest).toHaveBeenCalledWith(REPO_PATH, scope);
    expect(mockSubmitAnalysisJob.mock.calls[0][0].args).toEqual(
      expect.arrayContaining([
        '--include-path',
        'extension/aso/',
        '--include-path',
        'test/sql/aso/',
        '--symbols-only',
      ]),
    );
    expect(mockSubmitAnalysisJob.mock.calls[0][0].options).toEqual({
      withEmbeddings: true,
      scope,
    });
  });

  it('inherits indexed scope when no managed refresh scope is supplied', async () => {
    setupExecFile();
    mockReadFileSync.mockReturnValue(makeRegistry() as any);
    mockLoadMeta.mockResolvedValue({
      ...makeMeta({ lastCommit: STALE_INDEXED_COMMIT }),
      includePaths: ['src/api/'],
      pipelineProfile: 'symbols',
    } as any);

    await gnEnsureFresh(REPO_ID, { autoAnalyze: true });

    expect(mockComputeSourceManifest).toHaveBeenCalledWith(REPO_PATH, {
      includePaths: ['src/api/'],
      pipelineProfile: 'symbols',
    });
    expect(mockSubmitAnalysisJob.mock.calls[0][0].options).toEqual({
      withEmbeddings: true,
      scope: { includePaths: ['src/api/'], pipelineProfile: 'symbols' },
    });
  });

  it('treats dirty tracked and untracked sources as fresh when the complete indexed manifest matches', async () => {
    setupExecFile({
      currentCommit: CURRENT_COMMIT,
      statusOutput: ' M src/tracked.ts\n?? src/new-untracked.ts\n',
    });
    mockReadFileSync.mockReturnValue(makeRegistry({ lastCommit: CURRENT_COMMIT }) as any);
    const sourceManifest = {
      version: 1,
      head: CURRENT_COMMIT,
      sourceDigest: 'source-digest',
      sourceEntryCount: 2,
      includePaths: [],
      scopeDigest: 'scope-digest',
      ignorePolicyDigest: 'ignore-policy-digest',
      pipelineProfile: 'full',
      analyzerContractVersion: 'ontoindex-source-manifest-v1',
      coverage: 'complete',
    };
    mockLoadMeta.mockResolvedValue({
      ...makeMeta({ lastCommit: CURRENT_COMMIT }),
      sourceManifest,
    } as any);
    mockReadRuntimeHealth.mockResolvedValue({
      ...makeRuntimeHealth('clean'),
      dirtyWorktree: true,
    } as any);
    mockResolveTargetContext.mockResolvedValue({
      version: 1,
      status: 'ok',
      repoPath: REPO_PATH,
      targetHead: CURRENT_COMMIT,
      currentHead: CURRENT_COMMIT,
      indexedHead: CURRENT_COMMIT,
      graphAuthority: {
        state: 'authoritative',
        generationId: 'generation-1',
        manifestDigest: SOURCE_MANIFEST_DIGEST,
        coverage: 'complete',
      },
      dirtyWorktree: true,
      dirtyFileCount: 2,
      changedSinceIndex: true,
      snapshotMode: 'dirty-worktree-overlay',
    } as any);

    const report = await gnEnsureFresh(REPO_ID, { autoAnalyze: true });

    expect(report).toMatchObject({
      isStale: false,
      dirtyFileCount: 2,
      analysisSubmission: { status: 'not-needed' },
    });
    expect(report.warnings).toContain(
      '2 uncommitted file changes match the complete indexed source manifest; tracked changes and eligible untracked files are represented in the current graph.',
    );
    expect(report.warnings.join('\n')).not.toContain('untracked files are absent from the graph');
    expect(mockSubmitAnalysisJob).not.toHaveBeenCalled();
    expect(mockResolveTargetContext).toHaveBeenCalledWith({
      repo: REPO_ID,
      verifyGraphAuthority: true,
      ignorePinnedGraphContext: true,
      requiredGraphCapabilities: ['symbols'],
    });
  });

  it('blocks managed refresh when explicit opt-out would discard existing vectors', async () => {
    setupExecFile();
    mockReadFileSync.mockReturnValue(makeRegistry({ lastCommit: STALE_INDEXED_COMMIT }) as any);
    mockLoadMeta.mockResolvedValue(makeMeta({ lastCommit: STALE_INDEXED_COMMIT }) as any);

    const report = await gnEnsureFresh(REPO_ID, { autoAnalyze: true, withEmbeddings: false });

    expect(report.analysisSubmission).toMatchObject({
      status: 'blocked',
      reasonCode: 'EMBEDDING_PRESERVATION_DISABLED',
    });
    expect(mockSubmitAnalysisJob).not.toHaveBeenCalled();
    expect(mockComputeSourceManifest).not.toHaveBeenCalled();
  });

  it.each([undefined, false])(
    'treats a recorded zero embedding count as empty despite model identity (%s)',
    async (withEmbeddings) => {
      setupExecFile({ currentCommit: CURRENT_COMMIT });
      mockReadFileSync.mockReturnValue(
        makeRegistry({ lastCommit: STALE_INDEXED_COMMIT, embeddings: 0 }) as any,
      );
      mockLoadMeta.mockResolvedValue(
        makeMeta({ lastCommit: STALE_INDEXED_COMMIT, embeddings: 0 }) as any,
      );

      const report = await gnEnsureFresh(REPO_ID, {
        autoAnalyze: true,
        ...(withEmbeddings === undefined ? {} : { withEmbeddings }),
      });

      expect(report.analysisSubmission).toEqual({ status: 'queued', jobId: 'job-1' });
      expect(report.embeddingsStatus).toMatchObject({ count: 0, required: false, status: 'missing' });
      expect(mockSubmitAnalysisJob).toHaveBeenCalledTimes(1);
      expect(mockSubmitAnalysisJob.mock.calls[0][0].args).not.toContain('--embeddings');
      expect(mockSubmitAnalysisJob.mock.calls[0][0].options.withEmbeddings).toBe(false);
      expect(mockSubmitAnalysisJob.mock.calls[0][0].requestedCapabilities.embeddings).toBe(false);
    },
  );

  it('allows explicit embeddings opt-in for a zero-count index with a different stored model hash', async () => {
    setupExecFile({ currentCommit: CURRENT_COMMIT });
    mockReadFileSync.mockReturnValue(
      makeRegistry({ lastCommit: STALE_INDEXED_COMMIT, embeddings: 0 }) as any,
    );
    mockLoadMeta.mockResolvedValue(
      makeMeta({ lastCommit: STALE_INDEXED_COMMIT, embeddings: 0, modelHash: 'old-hash' }) as any,
    );

    const report = await gnEnsureFresh(REPO_ID, {
      autoAnalyze: true,
      withEmbeddings: true,
    });

    expect(report.analysisSubmission).toEqual({ status: 'queued', jobId: 'job-1' });
    expect(mockSubmitAnalysisJob).toHaveBeenCalledTimes(1);
    expect(mockSubmitAnalysisJob.mock.calls[0][0].args).toContain('--embeddings');
    expect(mockSubmitAnalysisJob.mock.calls[0][0].options.withEmbeddings).toBe(true);
  });

  it('blocks managed refresh when stored and configured model identities differ', async () => {
    setupExecFile();
    mockReadFileSync.mockReturnValue(makeRegistry({ lastCommit: STALE_INDEXED_COMMIT }) as any);
    mockLoadMeta.mockResolvedValue(
      makeMeta({ lastCommit: STALE_INDEXED_COMMIT, modelHash: 'stored-hash' }) as any,
    );

    const report = await gnEnsureFresh(REPO_ID, { autoAnalyze: true });

    expect(report.analysisSubmission).toMatchObject({
      status: 'blocked',
      reasonCode: 'EMBEDDING_MODEL_IDENTITY_MISMATCH',
    });
    expect(mockSubmitAnalysisJob).not.toHaveBeenCalled();
  });

  it('does not block a fresh populated index when runtime model identity is unavailable', async () => {
    setupExecFile({ currentCommit: CURRENT_COMMIT });
    mockReadFileSync.mockReturnValue(makeRegistry({ lastCommit: CURRENT_COMMIT }) as any);
    mockLoadMeta.mockResolvedValue(makeMeta({ lastCommit: CURRENT_COMMIT }) as any);
    delete process.env.ONTOINDEX_EMBEDDING_MODEL_HASH;

    const report = await gnEnsureFresh(REPO_ID, { autoAnalyze: true });

    expect(report.analysisSubmission).toEqual({ status: 'not-needed' });
    expect(mockSubmitAnalysisJob).not.toHaveBeenCalled();
  });

  it('does not block a fresh populated index when embeddings are explicitly disabled', async () => {
    setupExecFile({ currentCommit: CURRENT_COMMIT });
    mockReadFileSync.mockReturnValue(makeRegistry({ lastCommit: CURRENT_COMMIT }) as any);
    mockLoadMeta.mockResolvedValue(makeMeta({ lastCommit: CURRENT_COMMIT }) as any);

    const report = await gnEnsureFresh(REPO_ID, {
      autoAnalyze: true,
      withEmbeddings: false,
    });

    expect(report.analysisSubmission).toEqual({ status: 'not-needed' });
    expect(mockSubmitAnalysisJob).not.toHaveBeenCalled();
  });

  it('still blocks a stale populated index when runtime model identity is unavailable', async () => {
    setupExecFile({ currentCommit: CURRENT_COMMIT });
    mockReadFileSync.mockReturnValue(makeRegistry({ lastCommit: STALE_INDEXED_COMMIT }) as any);
    mockLoadMeta.mockResolvedValue(makeMeta({ lastCommit: STALE_INDEXED_COMMIT }) as any);
    delete process.env.ONTOINDEX_EMBEDDING_MODEL_HASH;

    const report = await gnEnsureFresh(REPO_ID, { autoAnalyze: true });

    expect(report.analysisSubmission).toMatchObject({
      status: 'blocked',
      reasonCode: 'EMBEDDING_MODEL_IDENTITY_UNAVAILABLE',
    });
    expect(mockSubmitAnalysisJob).not.toHaveBeenCalled();
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

  it('submits a normal managed analysis for a clean repo with no prior index', async () => {
    setupExecFile({ currentCommit: CURRENT_COMMIT, statusOutput: '' });
    mockReadFileSync.mockReturnValue(makeRegistry({ lastCommit: '' }) as any);
    mockReadActiveGenerationMeta.mockResolvedValue({
      activeGeneration: null,
      meta: null,
      authority: 'untrusted',
      reason: 'index-not-created',
    });
    mockReadRuntimeHealth.mockResolvedValue({
      ...makeRuntimeHealth('untrusted'),
      hasRuntimeArtifacts: false,
    });

    const report = await gnEnsureFresh(REPO_ID, { autoAnalyze: true, withEmbeddings: true });

    expect(mockSubmitAnalysisJob).toHaveBeenCalledTimes(1);
    expect(mockSubmitAnalysisJob.mock.calls[0][0].args).toContain('analyze');
    expect(mockSubmitAnalysisJob.mock.calls[0][0].args).not.toContain('--force');
    expect(mockSubmitAnalysisJob.mock.calls[0][0].args).toContain('--embeddings');
    expect(report.analysisSubmission.status).toBe('queued');
    expect(report.runtimeHealth?.freshnessState).toBe('degraded');
    expect(report.warnings).toContain(
      'No index has been created for this registered repository yet.',
    );
    expect(
      report.warnings.some((warning) => warning.includes('metadata authority is untrusted')),
    ).toBe(false);
  });

  it('creates the first index for a dirty repo using its worktree identity', async () => {
    setupExecFile({ currentCommit: CURRENT_COMMIT, statusOutput: ' M src/edit.ts\n' });
    mockReadFileSync.mockReturnValue(makeRegistry({ lastCommit: '' }) as any);
    mockReadActiveGenerationMeta.mockResolvedValue({
      activeGeneration: null,
      meta: null,
      authority: 'untrusted',
      reason: 'index-not-created',
    });
    mockReadRuntimeHealth.mockResolvedValue({
      ...makeRuntimeHealth('untrusted'),
      dirtyWorktree: true,
      hasRuntimeArtifacts: false,
    });

    const report = await gnEnsureFresh(REPO_ID, { autoAnalyze: true });

    expect(mockSubmitAnalysisJob).toHaveBeenCalledTimes(1);
    const submission = mockSubmitAnalysisJob.mock.calls[0][0];
    expect(submission.args).not.toContain('--force');
    expect(submission.sourceIdentity).toBe(`worktree:${submission.sourceManifestDigest}`);
    expect(report.analysisSubmission.status).toBe('queued');
  });

  it('still blocks autoAnalyze when active-generation metadata is mismatched', async () => {
    setupExecFile({ currentCommit: CURRENT_COMMIT });
    mockReadActiveGenerationMeta.mockResolvedValue({
      activeGeneration: {
        generationId: 'generation-1',
        generationPath: `${REPO_PATH}/.ontoindex/generations/generation-1`,
        lbugPath: `${REPO_PATH}/.ontoindex/generations/generation-1/lbug`,
        metaPath: `${REPO_PATH}/.ontoindex/generations/generation-1/meta.json`,
        snapshotPath: `${REPO_PATH}/.ontoindex/generations/generation-1/snapshot.json`,
      },
      meta: null,
      authority: 'untrusted',
      reason: 'active-generation-metadata-mismatch',
    });
    mockReadRuntimeHealth.mockResolvedValue(makeRuntimeHealth('clean'));

    const report = await gnEnsureFresh(REPO_ID, { autoAnalyze: true });

    expect(mockSubmitAnalysisJob).not.toHaveBeenCalled();
    expect(report.runtimeHealth?.freshnessState).toBe('untrusted');
    expect(report.analysisSubmission.reasonCode).toBe('untrusted');
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
    mockLoadMeta.mockResolvedValue(
      makeMeta({ lastCommit: STALE_INDEXED_COMMIT, modelHash: null }) as any,
    );
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

  it.each([undefined, false])(
    'does not require repair or submit analysis for optional missing embeddings (%s)',
    async (withEmbeddings) => {
      setupExecFile({ currentCommit: CURRENT_COMMIT });
      mockReadFileSync.mockReturnValue(
        makeRegistry({ lastCommit: CURRENT_COMMIT, embeddings: 0 }) as any,
      );
      mockLoadMeta.mockResolvedValue(makeMeta({ embeddings: 0, modelHash: null }) as any);
      delete process.env.ONTOINDEX_EMBEDDING_MODEL_HASH;

      const report = await gnEnsureFresh(REPO_ID, { autoAnalyze: true, withEmbeddings });

      expect(report.embeddingsStatus).toMatchObject({
        count: 0,
        status: 'missing',
        required: false,
        repairCommand: 'ontoindex analyze --force --embeddings',
      });
      expect(report.embeddingsStatus).not.toHaveProperty('prerequisites');
      expect(report.recommendations.some((r) => r.includes('--embeddings'))).toBe(false);
      expect(report.analysisSubmission).toEqual({ status: 'not-needed' });
      expect(mockSubmitAnalysisJob).not.toHaveBeenCalled();
      expect(mockComputeSourceManifest).not.toHaveBeenCalled();
      expect(report.actionsTaken).toHaveLength(0);
    },
  );

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

  it('submits analysis for a dirty worktree under working-tree source identity', async () => {
    setupExecFile({ currentCommit: CURRENT_COMMIT, statusOutput: ' M src/edit.ts\n' });
    mockReadFileSync.mockReturnValue(makeRegistry({ lastCommit: CURRENT_COMMIT }) as any);

    const report = await gnEnsureFresh(REPO_ID, { autoAnalyze: true });

    expect(mockSubmitAnalysisJob).toHaveBeenCalledTimes(1);
    const submission = mockSubmitAnalysisJob.mock.calls[0][0];
    expect(submission.sourceIdentity).toBe(`worktree:${submission.sourceManifestDigest}`);
    expect(submission.targetHead).toBe(CURRENT_COMMIT);
    expect(report.analysisSubmission).not.toMatchObject({ status: 'blocked' });
  });

  it('keeps commit source identity when the worktree is clean', async () => {
    setupExecFile({ currentCommit: CURRENT_COMMIT });
    mockReadFileSync.mockReturnValue(makeRegistry({ lastCommit: CURRENT_COMMIT }) as any);
    mockLoadMeta.mockResolvedValue(makeMeta({ lastCommit: STALE_INDEXED_COMMIT }) as any);

    await gnEnsureFresh(REPO_ID, { autoAnalyze: true });

    expect(mockSubmitAnalysisJob).toHaveBeenCalledTimes(1);
    expect(mockSubmitAnalysisJob.mock.calls[0][0].sourceIdentity).toBe(`commit:${CURRENT_COMMIT}`);
  });

  it('blocks analysis when worktree status is unavailable', async () => {
    mockExecFile.mockImplementation((_cmd: string, args: string[], _opts: any, callback: any) => {
      if (args.includes('HEAD') && args.includes('rev-parse')) {
        callback(null, CURRENT_COMMIT + '\n', '');
        return {} as any;
      }
      if (args.includes('status') && args.some((arg) => arg.startsWith('--porcelain'))) {
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
    expect(report.recommendations).toContain(
      'Restore the git worktree status probe before retrying autoAnalyze.',
    );
    expect(report.recommendations.some((r) => r.includes('worktree is clean'))).toBe(false);
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
    expect(report.recommendations).toContain('ontoindex analyze --force --embeddings');
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

  it('keeps omitted and explicit-false embedding requests separate in the read-only cache', async () => {
    setupExecFile({ currentCommit: CURRENT_COMMIT });
    mockReadFileSync.mockReturnValue(makeRegistry({ lastCommit: CURRENT_COMMIT }) as any);
    mockLoadMeta.mockResolvedValue(
      makeMeta({ lastCommit: CURRENT_COMMIT, modelHash: 'stored-hash', embeddings: 12 }) as any,
    );

    const defaultReport = await gnEnsureFresh(REPO_ID, {});
    const optOutReport = await gnEnsureFresh(REPO_ID, { withEmbeddings: false });

    expect(defaultReport.embeddingsStatus).toMatchObject({ required: true, status: 'drifted' });
    expect(optOutReport.embeddingsStatus).toMatchObject({ required: false, status: 'drifted' });
    expect(mockLoadMeta).toHaveBeenCalledTimes(2);
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
    expect(mockRegisterRepo).not.toHaveBeenCalled();
  });

  it('registers an exact unindexed worktree root before submitting its first analysis', async () => {
    setupExecFile({ currentCommit: CURRENT_COMMIT });
    mockReadFileSync
      .mockImplementationOnce(() => {
        throw Object.assign(new Error('registry is missing'), { code: 'ENOENT' });
      })
      .mockReturnValueOnce(
        makeRegistry({ name: 'registered-repo', path: REPO_PATH, lastCommit: '' }) as any,
      );
    mockReadActiveGenerationMeta.mockResolvedValue({
      activeGeneration: null,
      meta: null,
      authority: 'untrusted',
      reason: 'index-not-created',
    });
    mockReadRuntimeHealth.mockResolvedValue({
      ...makeRuntimeHealth('untrusted'),
      hasRuntimeArtifacts: false,
    });
    mockResolveTargetContext.mockResolvedValueOnce({
      version: 1,
      status: 'not-found',
      targetRef: 'HEAD',
      dirtyWorktree: null,
      changedSinceIndex: null,
      snapshotMode: 'unknown',
      qualityMode: 'fast',
      embeddings: { status: 'unknown' },
      lsp: { status: 'unknown' },
      sidecar: { status: 'unknown' },
      policy: { status: 'unknown' },
      warnings: [],
    } as any);

    const report = await gnEnsureFresh(REPO_PATH, {
      repo: REPO_PATH,
      autoAnalyze: true,
      legacyResponse: false,
    });

    expect(mockRegisterRepo).toHaveBeenCalledWith(
      REPO_PATH,
      expect.objectContaining({ lastCommit: '', indexedAt: '' }),
      expect.objectContaining({ name: expect.any(String), ifAbsent: true }),
    );
    expect(mockSubmitAnalysisJob).toHaveBeenCalledTimes(1);
    expect(mockSubmitAnalysisJob.mock.calls[0][0].args).not.toContain('--force');
    expect(report.results.analysisSubmission).toEqual({ status: 'queued', jobId: 'job-1' });
    expect(report.results.actionsTaken).toEqual(
      expect.arrayContaining([expect.stringContaining('Ensured registry entry')]),
    );
    expect(mockResolveTargetContext).toHaveBeenCalledTimes(2);
  });

  it('does not register an absolute path below the Git worktree root', async () => {
    setupExecFile({ currentCommit: CURRENT_COMMIT, repoRoot: REPO_PATH });
    mockReadFileSync.mockReturnValue('[]' as any);

    const report = await gnEnsureFresh(REPO_ID, {
      repo: path.join(REPO_PATH, 'nested'),
      autoAnalyze: true,
    });

    expect(report.analysisSubmission).toMatchObject({
      status: 'blocked',
      reasonCode: 'REPO_PATH_NOT_WORKTREE_ROOT',
    });
    expect(mockRegisterRepo).not.toHaveBeenCalled();
    expect(mockSubmitAnalysisJob).not.toHaveBeenCalled();
  });

  it('retries an unindexed worktree registration with a path-specific name after a collision', async () => {
    setupExecFile({ currentCommit: CURRENT_COMMIT });
    mockReadFileSync
      .mockReturnValueOnce('[]' as any)
      .mockReturnValueOnce(
        makeRegistry({ name: 'registered-repo', path: REPO_PATH, lastCommit: '' }) as any,
      );
    mockRegisterRepo
      .mockRejectedValueOnce(
        new RegistryNameCollisionError('repo-name', '/another/repo', REPO_PATH),
      )
      .mockResolvedValueOnce('registered-repo');
    mockReadActiveGenerationMeta.mockResolvedValue({
      activeGeneration: null,
      meta: null,
      authority: 'untrusted',
      reason: 'index-not-created',
    });
    mockReadRuntimeHealth.mockResolvedValue({
      ...makeRuntimeHealth('untrusted'),
      hasRuntimeArtifacts: false,
    });

    const report = await gnEnsureFresh(REPO_PATH, { repo: REPO_PATH, autoAnalyze: true });

    expect(mockRegisterRepo).toHaveBeenCalledTimes(2);
    expect(mockRegisterRepo.mock.calls[1][2]?.name).toMatch(/-[a-f0-9]{8}$/);
    expect(report.analysisSubmission.status).toBe('queued');
  });

  it('preserves the real unregistered-repo freshness report through the facade', async () => {
    setupExecFile({ currentCommit: CURRENT_COMMIT });
    mockReadFileSync.mockReturnValue('[]');
    const resolveRepo = vi
      .fn()
      .mockRejectedValue(new Error('repository resolution must be bypassed'));
    const backend = { resolveRepo } as unknown as LocalBackend;
    const params = { repo: REPO_ID, autoAnalyze: true };

    const directReport = await gnEnsureFresh(REPO_ID, params);
    resetFreshnessCache();
    const facadeReport = await dispatchFacade('manage', 'ensure_fresh', params, backend);

    expect(directReport.analysisSubmission).toEqual({
      status: 'blocked',
      reasonCode: 'REPO_NOT_REGISTERED',
      message: 'Repository is not registered; analysis cannot be submitted.',
    });
    expect(facadeReport).toEqual(directReport);
    expect(resolveRepo).not.toHaveBeenCalled();
    expect(mockSubmitAnalysisJob).not.toHaveBeenCalled();
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('preserves omitted embeddings and blocks explicit false through the public facade', async () => {
    setupExecFile({ currentCommit: CURRENT_COMMIT });
    mockReadFileSync.mockReturnValue(makeRegistry({ lastCommit: STALE_INDEXED_COMMIT }) as any);
    mockLoadMeta.mockResolvedValue(makeMeta({ lastCommit: STALE_INDEXED_COMMIT }) as any);
    const backend = { resolveRepo: vi.fn() } as unknown as LocalBackend;

    const preserved = (await dispatchFacade(
      'manage',
      'ensure_fresh',
      { repo: REPO_ID, autoAnalyze: true },
      backend,
    )) as Awaited<ReturnType<typeof gnEnsureFresh>>;

    expect(preserved.analysisSubmission).toEqual({ status: 'queued', jobId: 'job-1' });
    expect(mockSubmitAnalysisJob).toHaveBeenCalledTimes(1);
    expect(mockSubmitAnalysisJob.mock.calls[0][0].args).toContain('--embeddings');
    expect(preserved.recommendations[0]).toContain('use manage({ action: "ensure_fresh"');

    mockSubmitAnalysisJob.mockClear();
    const optedOut = (await dispatchFacade(
      'manage',
      'ensure_fresh',
      { repo: REPO_ID, autoAnalyze: true, withEmbeddings: false },
      backend,
    )) as Awaited<ReturnType<typeof gnEnsureFresh>>;

    expect(optedOut.analysisSubmission).toMatchObject({
      status: 'blocked',
      reasonCode: 'EMBEDDING_PRESERVATION_DISABLED',
    });
    expect(mockSubmitAnalysisJob).not.toHaveBeenCalled();
    expect(optedOut.recommendations[0]).toContain('use manage({ action: "ensure_fresh"');
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
      } as Awaited<ReturnType<typeof mockSubmitAnalysisJob>>['job'],
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

  // ---- Dirty-worktree breakdown ----
  it('splits the dirty worktree into tracked and untracked counts', async () => {
    setupExecFile({
      currentCommit: CURRENT_COMMIT,
      statusOutput: ' M src/edit.ts\n?? src/new-file.rs\n?? src/other.ts\n',
    });
    mockReadFileSync.mockReturnValue(makeRegistry({ lastCommit: CURRENT_COMMIT }) as any);

    const report = await gnEnsureFresh(REPO_ID, {});

    expect(report.dirtyFileCount).toBe(3);
    expect(report.dirtyWorktreeBreakdown).toEqual({
      trackedChangedCount: 1,
      untrackedCount: 2,
    });
    expect(report.warnings.some((w) => w.includes('coverage is unconfirmed'))).toBe(true);
  });

  it('counts every nested untracked file with the shared porcelain status mode', async () => {
    setupExecFile({
      currentCommit: CURRENT_COMMIT,
      statusOutput: [
        ' M src/modified file.ts',
        'R  src/rename source.ts -> src/rename destination.ts',
        '?? ontoindex/undefined/one.ts',
        '?? ontoindex/undefined/nested dir/two file.ts',
        '?? ontoindex/undefined/nested dir/deeper/three.ts',
        '',
      ].join('\n'),
    });
    mockReadFileSync.mockReturnValue(makeRegistry({ lastCommit: CURRENT_COMMIT }) as any);

    const report = await gnEnsureFresh(REPO_ID, {});

    expect(report.dirtyFileCount).toBe(5);
    expect(report.dirtyWorktreeBreakdown).toEqual({
      trackedChangedCount: 2,
      untrackedCount: 3,
    });
    expect(mockExecFile.mock.calls).toContainEqual(
      expect.arrayContaining([
        'git',
        ['status', '--porcelain=v1', '--untracked-files=all'],
      ]),
    );
  });

  it('does not claim partial working-tree changes are absent from a dirty indexed graph', async () => {
    setupExecFile({
      currentCommit: CURRENT_COMMIT,
      statusOutput: ' M src/edit.ts\n?? src/new-file.rs\n',
    });
    mockReadFileSync.mockReturnValue(makeRegistry({ lastCommit: CURRENT_COMMIT }) as any);
    mockLoadMeta.mockResolvedValue({
      ...makeMeta({ lastCommit: CURRENT_COMMIT }),
      sourceManifest: {
        version: 1,
        head: CURRENT_COMMIT,
        sourceDigest: 'source-digest',
        sourceEntryCount: 2,
        includePaths: [],
        scopeDigest: 'scope-digest',
        ignorePolicyDigest: 'ignore-policy-digest',
        pipelineProfile: 'full',
        analyzerContractVersion: 'ontoindex-source-manifest-v1',
        coverage: 'complete',
      },
    } as any);
    mockReadRuntimeHealth.mockResolvedValue(makeRuntimeHealth('stale'));

    const report = await gnEnsureFresh(REPO_ID, {});

    const warning = report.warnings.find((w) => w.includes('coverage is unconfirmed'));
    expect(warning).toBe(
      '1 tracked change and 1 untracked file are present; the indexed manifest does not confirm this worktree, so graph coverage is unconfirmed.',
    );
    expect(warning).not.toContain('absent');
    expect(warning).not.toContain('indexed at the indexed commit');
  });

  it('reports a clean worktree with zeroed breakdown and no untracked warning', async () => {
    setupExecFile({ currentCommit: CURRENT_COMMIT });
    mockReadFileSync.mockReturnValue(makeRegistry({ lastCommit: CURRENT_COMMIT }) as any);

    const report = await gnEnsureFresh(REPO_ID, {});

    expect(report.dirtyWorktreeBreakdown).toEqual({
      trackedChangedCount: 0,
      untrackedCount: 0,
    });
    expect(report.warnings.some((w) => w.includes('coverage is unconfirmed'))).toBe(false);
  });

  it('warns that dirty analysis is not published under the commit identity', async () => {
    setupExecFile({ currentCommit: CURRENT_COMMIT, statusOutput: ' M src/edit.ts\n' });
    mockReadFileSync.mockReturnValue(makeRegistry({ lastCommit: CURRENT_COMMIT }) as any);

    const report = await gnEnsureFresh(REPO_ID, { autoAnalyze: true });

    expect(
      report.warnings.some(
        (w) => w.includes('working-tree identity') && w.includes('uncommitted change'),
      ),
    ).toBe(true);
  });

  // ---- Read-only freshness caching ----
  it('serves repeated read-only probes from cache and re-probes after reset', async () => {
    setupExecFile({ currentCommit: CURRENT_COMMIT });
    mockReadFileSync.mockReturnValue(makeRegistry({ lastCommit: CURRENT_COMMIT }) as any);

    const first = await gnEnsureFresh(REPO_ID, {});
    expect(first.warnings).toContain(WORKSPACE_READINESS_WARNING);
    const revParseCalls = () =>
      mockExecFile.mock.calls.filter((call) => (call[1] as string[]).includes('rev-parse')).length;
    const afterFirst = revParseCalls();
    const second = await gnEnsureFresh(REPO_ID, {});

    expect(second).toEqual(first);
    expect(
      second.warnings.filter((warning) => warning === WORKSPACE_READINESS_WARNING),
    ).toHaveLength(1);
    expect(revParseCalls()).toBe(afterFirst);

    resetFreshnessCache();
    await gnEnsureFresh(REPO_ID, {});
    expect(revParseCalls()).toBeGreaterThan(afterFirst);
  });

  it('omits the workspace readiness warning when automatic workspace is disabled', async () => {
    process.env.ONTOINDEX_AUTO_WORKSPACE = '0';
    setupExecFile({ currentCommit: CURRENT_COMMIT });
    mockReadFileSync.mockReturnValue(makeRegistry({ lastCommit: CURRENT_COMMIT }) as any);

    const report = await gnEnsureFresh(REPO_ID, {});

    expect(report.warnings).not.toContain(WORKSPACE_READINESS_WARNING);
  });

  it('never serves an autoAnalyze request from cache', async () => {
    setupExecFile({ currentCommit: CURRENT_COMMIT, statusOutput: ' M src/edit.ts\n' });
    mockReadFileSync.mockReturnValue(makeRegistry({ lastCommit: CURRENT_COMMIT }) as any);

    await gnEnsureFresh(REPO_ID, {});
    const revParseCalls = () =>
      mockExecFile.mock.calls.filter((call) => (call[1] as string[]).includes('rev-parse')).length;
    const afterReadOnly = revParseCalls();

    await gnEnsureFresh(REPO_ID, { autoAnalyze: true });

    expect(revParseCalls()).toBeGreaterThan(afterReadOnly);
  });
});
