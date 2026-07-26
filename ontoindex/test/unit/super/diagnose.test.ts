/**
 * Unit tests: gnDiagnose
 *
 * All external I/O (child_process, gnEnsureFresh) is mocked via vi.mock.
 * No real git process, LSP binaries, or filesystem access is used.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Mocks — declared before the module under test is imported.
// vi.mock factories are hoisted.
// ---------------------------------------------------------------------------

vi.mock('child_process', () => ({
  execFile: vi.fn(),
}));

vi.mock('../../../src/mcp/super/ensure-fresh.js', () => ({
  gnEnsureFresh: vi.fn(),
}));

vi.mock('../../../src/mcp/shared/target-context.js', () => ({
  resolveTargetContext: vi.fn(),
}));

vi.mock('../../../src/core/embeddings/zvec-semantic-backend.js', () => ({
  getSemanticVectorBackendStatus: vi.fn(),
}));

vi.mock('../../../src/core/lbug/lbug-adapter.js', () => ({
  getLbugRuntimeDiagnostics: vi.fn().mockResolvedValue({
    extensionHintDir: '/tmp/lbug-ext',
    getAllTimeoutMs: 30000,
    extensions: {
      fts: { available: true, path: '/tmp/lbug-ext/libfts.lbug_extension' },
      vector: { available: true, path: '/tmp/lbug-ext/libvector.lbug_extension' },
    },
  }),
}));

vi.mock('../../../src/core/audit-lifecycle/index.js', () => ({
  getAuditProjectionPath: vi
    .fn()
    .mockReturnValue('/tmp/test-repo/.ontoindex/audit/audit-projection.json'),
  computeAuditFreshness: vi.fn().mockResolvedValue({
    state: 'clean',
    currentHead: 'abc123def456abc123def456abc123def456abc1',
    dirtyFiles: [],
  }),
}));

vi.mock('../../../src/mcp/local/tool-telemetry.js', () => ({
  readToolTelemetrySummary: vi.fn().mockResolvedValue({
    recentOversizedCount: 0,
    recentOversizedTools: [],
  }),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks).
// ---------------------------------------------------------------------------

import { execFile } from 'child_process';
import { gnEnsureFresh } from '../../../src/mcp/super/ensure-fresh.js';
import { resolveTargetContext } from '../../../src/mcp/shared/target-context.js';
import {
  computeAuditFreshness,
  getAuditProjectionPath,
} from '../../../src/core/audit-lifecycle/index.js';
import { getSemanticVectorBackendStatus } from '../../../src/core/embeddings/zvec-semantic-backend.js';
import { getLbugRuntimeDiagnostics } from '../../../src/core/lbug/lbug-adapter.js';
import { gnDiagnose } from '../../../src/mcp/super/diagnose.js';
import { ONTOINDEX_SUPER_TOOLS } from '../../../src/mcp/super/tool-definitions.js';
import { readToolTelemetrySummary } from '../../../src/mcp/local/tool-telemetry.js';

const mockExecFile = vi.mocked(execFile);
const mockGnEnsureFresh = vi.mocked(gnEnsureFresh);
const mockResolveTargetContext = vi.mocked(resolveTargetContext);
const mockGetSemanticVectorBackendStatus = vi.mocked(getSemanticVectorBackendStatus);
const mockGetLbugRuntimeDiagnostics = vi.mocked(getLbugRuntimeDiagnostics);
const mockComputeAuditFreshness = vi.mocked(computeAuditFreshness);
const mockGetAuditProjectionPath = vi.mocked(getAuditProjectionPath);
const mockReadToolTelemetrySummary = vi.mocked(readToolTelemetrySummary);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const REPO_ID = 'test-repo';
const CURRENT_COMMIT = 'abc123def456abc123def456abc123def456abc1';
const INDEXED_COMMIT = 'abc123def456abc123def456abc123def456abc1';
const STALE_COMMIT = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
const TARGET_REPO_PATH = path.resolve('/tmp/test-repo');
const TARGET_LBUG_PATH = path.join(TARGET_REPO_PATH, '.ontoindex', 'lbug');
const TARGET_CONTEXT = {
  version: 1 as const,
  status: 'ok' as const,
  repoKey: REPO_ID,
  repoPath: TARGET_REPO_PATH,
  branch: 'main',
  targetRef: 'HEAD',
  targetHead: CURRENT_COMMIT,
  currentHead: CURRENT_COMMIT,
  indexedHead: CURRENT_COMMIT,
  graphIndexId: '2026-05-17T00:00:00.000Z',
  dirtyWorktree: false,
  changedSinceIndex: false,
  snapshotMode: 'committed-head' as const,
  qualityMode: 'fast' as const,
  embeddings: { status: 'unknown' as const, reason: 'embedding-stats-unavailable' },
  lsp: { status: 'unknown' as const, reason: 'not-probed' },
  sidecar: { status: 'unknown' as const, reason: 'not-probed' },
  policy: { status: 'unknown' as const, reason: 'policy-profile-probe-not-configured' },
  warnings: [],
};

/** Minimal gnEnsureFresh return for a fresh index with no embeddings. */
function makeFreshReport(
  options: {
    isStale?: boolean;
    embeddingsCount?: number;
    embeddingsStatus?: 'ok' | 'missing' | 'metadata-unavailable' | 'drifted';
    repairCommand?: string;
    reason?: string;
  } = {},
) {
  const { isStale = false, embeddingsCount = 0 } = options;
  const embeddingsStatus = options.embeddingsStatus ?? (embeddingsCount > 0 ? 'ok' : 'missing');
  const repairCommand =
    options.repairCommand ??
    (embeddingsStatus === 'missing'
      ? `ontoindex analyze${isStale ? '' : ' --force'} --embeddings`
      : embeddingsStatus === 'metadata-unavailable'
        ? 'ontoindex analyze'
        : undefined);
  const indexedCommit = isStale ? STALE_COMMIT : INDEXED_COMMIT;
  return {
    version: 1 as const,
    preCheck: { indexedCommit, currentCommit: CURRENT_COMMIT, isStale },
    embeddingsStatus: {
      count: embeddingsCount,
      required: false,
      status: embeddingsStatus,
      ...(options.reason !== undefined ? { reason: options.reason } : {}),
      ...(repairCommand !== undefined ? { repairCommand } : {}),
    },
    repoPath: TARGET_CONTEXT.repoPath,
    runtimeHealth: {
      version: 1 as const,
      repoLabel: REPO_ID,
      repoPath: TARGET_CONTEXT.repoPath,
      indexedCommit,
      currentCommit: CURRENT_COMMIT,
      dirtyWorktree: false,
      freshnessState: 'clean' as const,
      degradedReason: null,
      repairCommand: 'ontoindex status',
      hasRuntimeArtifacts: false,
      analyzeLock: {
        path: `${TARGET_CONTEXT.repoPath}/.ontoindex/analyze.lock`,
        present: false,
        state: 'absent' as const,
      },
      analysisCheckpoint: {
        path: `${TARGET_CONTEXT.repoPath}/.ontoindex/analysis-checkpoint.json`,
        present: false,
        state: 'absent' as const,
      },
      embeddingCheckpoint: {
        path: `${TARGET_CONTEXT.repoPath}/.ontoindex/embedding-checkpoint.json`,
        present: false,
      },
      bootstrapSource: {
        path: `${TARGET_CONTEXT.repoPath}/.ontoindex/bootstrap-source.json`,
        present: false,
      },
      warnings: [],
    },
    actionsTaken: [],
    warnings: [],
    recommendations: [],
  };
}

/**
 * Configure execFile so that `which <name>` succeeds for each name in
 * `available` and throws ENOENT for all others.
 */
function setupWhich(available: string[]) {
  mockExecFile.mockImplementation((_cmd: string, args: string[], _opts: any, callback: any) => {
    const name = args[0];
    if (available.includes(name)) {
      callback(null, '', '');
      return {} as any;
    }
    const err = Object.assign(new Error(`${name}: not found`), { code: 'ENOENT' });
    callback(err, '', '');
    return {} as any;
  });
}

// ---------------------------------------------------------------------------
// Env-state save / restore (ONTOINDEX_* keys)
// ---------------------------------------------------------------------------

let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  vi.clearAllMocks();
  // Save and clear all ONTOINDEX_* env vars so tests are isolated
  savedEnv = {};
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('ONTOINDEX_')) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  }
  // Default: all LSP binaries unavailable unless test sets them up
  setupWhich([]);
  // Default: fresh index
  mockGnEnsureFresh.mockResolvedValue(makeFreshReport());
  mockResolveTargetContext.mockResolvedValue(TARGET_CONTEXT);
  mockGetSemanticVectorBackendStatus.mockResolvedValue({
    requestedBackend: 'lbug',
    actualBackend: 'lbug',
    freshness: 'unknown',
    circuitBroken: false,
  });
  mockGetLbugRuntimeDiagnostics.mockResolvedValue({
    extensionHintDir: '/tmp/lbug-ext',
    getAllTimeoutMs: 30000,
    extensions: {
      fts: { available: true, path: '/tmp/lbug-ext/libfts.lbug_extension' },
      vector: { available: true, path: '/tmp/lbug-ext/libvector.lbug_extension' },
    },
  });
  mockReadToolTelemetrySummary.mockResolvedValue({
    recentOversizedCount: 0,
    recentOversizedTools: [],
  });
});

afterEach(() => {
  // Restore ONTOINDEX_* env vars
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('ONTOINDEX_')) delete process.env[key];
  }
  for (const [key, val] of Object.entries(savedEnv)) {
    if (val === undefined) delete process.env[key];
    else process.env[key] = val;
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('gnDiagnose', () => {
  // ---- Test 1: Fresh index, no recommendations for freshness ----------------
  it('returns isStale: false and no stale recommendation when index is fresh', async () => {
    mockGnEnsureFresh.mockResolvedValue(makeFreshReport({ isStale: false }));

    const report = await gnDiagnose(REPO_ID, {
      checkLsp: false,
      checkEmbeddings: false,
      checkIndexFreshness: true,
    });

    expect(report.version).toBe(1);
    expect(report.responseBudgetHealth).toMatchObject({
      guardLimitBytes: 512 * 1024,
      guardedPreviewAvailable: true,
      recentOversizedTools: [],
    });
    expect(report.indexFreshness).toBeDefined();
    expect(report.indexFreshness!.isStale).toBe(false);
    expect(report.recommendations.some((r) => r.severity === 'WARN')).toBe(false);
    expect(report.warnings).toHaveLength(0);
  });

  it('includes recent oversized tools in response-budget health', async () => {
    mockReadToolTelemetrySummary.mockResolvedValue({
      recentOversizedCount: 2,
      recentOversizedTools: ['impact', 'audit'],
    });

    const report = await gnDiagnose(REPO_ID, {
      checkLsp: false,
      checkEmbeddings: false,
      checkIndexFreshness: false,
      checkToolContract: false,
    });

    expect(report.responseBudgetHealth.recentOversizedTools).toEqual(['impact', 'audit']);
    expect(report.toolTelemetrySummary).toEqual({
      recentOversizedCount: 2,
      recentOversizedTools: ['impact', 'audit'],
    });
  });

  // ---- Test 2: Stale index → WARN recommendation generated ------------------
  it('emits a WARN recommendation when the index is stale', async () => {
    mockGnEnsureFresh.mockResolvedValue(makeFreshReport({ isStale: true }));

    const report = await gnDiagnose(REPO_ID, {
      checkLsp: false,
      checkEmbeddings: false,
      checkIndexFreshness: true,
    });

    expect(report.indexFreshness!.isStale).toBe(true);
    expect(report.indexFreshness!.indexedCommit).toBe(STALE_COMMIT);
    expect(report.indexFreshness!.currentCommit).toBe(CURRENT_COMMIT);

    const warnRec = report.recommendations.find((r) => r.severity === 'WARN');
    expect(warnRec).toBeDefined();
    expect(warnRec!.detail).toMatch(/stale/i);
    expect(warnRec!.fix).toBe('gn_ensure_fresh({autoAnalyze: true})');
  });

  // ---- Test 3: LSP probe handles ENOENT gracefully --------------------------
  it('handles ENOENT from which gracefully and marks LSP servers as unavailable', async () => {
    // All which calls throw ENOENT (set up in beforeEach via setupWhich([]))
    mockGnEnsureFresh.mockResolvedValue(makeFreshReport());

    const report = await gnDiagnose(REPO_ID, {
      checkLsp: true,
      checkEmbeddings: false,
      checkIndexFreshness: false,
    });

    expect(report.lspAvailable).toBeDefined();
    expect(report.lspAvailable!.typescript).toBe(false);
    expect(report.lspAvailable!.python).toBe(false);
    expect(report.lspAvailable!.rust).toBe(false);
    expect(report.warnings).toHaveLength(0); // ENOENT is not a warning, just unavailable

    // INFO recommendations for each unavailable LSP
    const infoRecs = report.recommendations.filter((r) => r.severity === 'INFO');
    expect(infoRecs.some((r) => r.detail.includes('typescript-language-server'))).toBe(true);
    expect(infoRecs.some((r) => r.detail.includes('pyright'))).toBe(true);
    expect(infoRecs.some((r) => r.detail.includes('rust-analyzer'))).toBe(true);
  });

  // ---- Test 4: LSP probe marks available binaries correctly -----------------
  it('marks LSP servers as available when which succeeds', async () => {
    setupWhich(['typescript-language-server', 'pyright', 'rust-analyzer']);
    mockGnEnsureFresh.mockResolvedValue(makeFreshReport());

    const report = await gnDiagnose(REPO_ID, {
      checkLsp: true,
      checkEmbeddings: false,
      checkIndexFreshness: false,
    });

    expect(report.lspAvailable!.typescript).toBe(true);
    expect(report.lspAvailable!.python).toBe(true);
    expect(report.lspAvailable!.rust).toBe(true);

    // No LSP-related INFO recommendations
    const lspRecs = report.recommendations.filter(
      (r) =>
        r.detail.includes('typescript') ||
        r.detail.includes('pyright') ||
        r.detail.includes('rust-analyzer'),
    );
    expect(lspRecs).toHaveLength(0);
  });

  // ---- Test 5: All ONTOINDEX_* env vars enumerated ---------------------------
  it('enumerates all ONTOINDEX_* env vars from process.env', async () => {
    process.env['ONTOINDEX_INTENT_ENSEMBLE'] = '1';
    process.env['ONTOINDEX_CITATIONS'] = '1';
    process.env['ONTOINDEX_CUSTOM_VAR'] = 'hello';
    mockGnEnsureFresh.mockResolvedValue(makeFreshReport());

    const report = await gnDiagnose(REPO_ID, {
      checkLsp: false,
      checkEmbeddings: false,
      checkIndexFreshness: false,
    });

    expect(report.envVars['ONTOINDEX_INTENT_ENSEMBLE']).toBe('1');
    expect(report.envVars['ONTOINDEX_CITATIONS']).toBe('1');
    expect(report.envVars['ONTOINDEX_CUSTOM_VAR']).toBe('hello');
    // Non-ONTOINDEX_ keys must NOT appear
    expect(Object.keys(report.envVars).every((k) => k.startsWith('ONTOINDEX_'))).toBe(true);
  });

  // ---- Test 6: Multiple recommendations stack correctly ---------------------
  it('stacks multiple recommendations for stale index + no embeddings', async () => {
    mockGnEnsureFresh.mockResolvedValue(makeFreshReport({ isStale: true, embeddingsCount: 0 }));

    const report = await gnDiagnose(REPO_ID, {
      checkLsp: false,
      checkEmbeddings: true,
      checkIndexFreshness: true,
    });

    expect(report.recommendations.length).toBeGreaterThanOrEqual(2);

    const warnRec = report.recommendations.find((r) => r.severity === 'WARN');
    expect(warnRec).toBeDefined();
    expect(warnRec!.detail).toMatch(/stale/i);

    const embRec = report.recommendations.find(
      (r) => r.severity === 'INFO' && r.detail.includes('Embeddings not populated'),
    );
    expect(embRec).toBeDefined();
    expect(embRec!.fix).toBe('ontoindex analyze --embeddings');
  });

  it('recommends force embeddings when graph is fresh but embeddings are absent', async () => {
    mockGnEnsureFresh.mockResolvedValue(makeFreshReport({ isStale: false, embeddingsCount: 0 }));

    const report = await gnDiagnose(REPO_ID, {
      checkLsp: false,
      checkEmbeddings: true,
      checkIndexFreshness: true,
      checkToolContract: false,
    });

    const embRec = report.recommendations.find(
      (r) => r.severity === 'INFO' && r.detail.includes('Embeddings not populated'),
    );
    expect(embRec).toBeDefined();
    expect(embRec!.fix).toBe('ontoindex analyze --force --embeddings');
  });

  // ---- Test 7: Quality-mode recommendation when ONTOINDEX_INTENT_ENSEMBLE not set
  it('emits INFO recommendation for default quality mode when INTENT_ENSEMBLE is absent', async () => {
    // No ONTOINDEX_INTENT_ENSEMBLE in env (cleared in beforeEach)
    mockGnEnsureFresh.mockResolvedValue(makeFreshReport());

    const report = await gnDiagnose(REPO_ID, {
      checkLsp: false,
      checkEmbeddings: false,
      checkIndexFreshness: false,
    });

    const qualityRec = report.recommendations.find(
      (r) => r.severity === 'INFO' && r.detail.includes('Default quality mode'),
    );
    expect(qualityRec).toBeDefined();
    expect(qualityRec!.fix).toBe('gn_quality_mode({level: "balanced"})');
  });

  // ---- Test 8: No quality-mode recommendation when ONTOINDEX_INTENT_ENSEMBLE is set
  it('omits quality-mode recommendation when ONTOINDEX_INTENT_ENSEMBLE is set', async () => {
    process.env['ONTOINDEX_INTENT_ENSEMBLE'] = '1';
    mockGnEnsureFresh.mockResolvedValue(makeFreshReport());

    const report = await gnDiagnose(REPO_ID, {
      checkLsp: false,
      checkEmbeddings: false,
      checkIndexFreshness: false,
    });

    const qualityRec = report.recommendations.find((r) =>
      r.detail.includes('Default quality mode'),
    );
    expect(qualityRec).toBeUndefined();
  });

  // ---- Test 9: checkIndexFreshness: false skips indexFreshness field --------
  it('omits indexFreshness when checkIndexFreshness is false', async () => {
    const report = await gnDiagnose(REPO_ID, {
      checkLsp: false,
      checkEmbeddings: false,
      checkIndexFreshness: false,
    });

    expect(report.indexFreshness).toBeUndefined();
  });

  // ---- Test 10: checkEmbeddings: false skips embeddings field ---------------
  it('omits embeddings when checkEmbeddings is false', async () => {
    const report = await gnDiagnose(REPO_ID, {
      checkLsp: false,
      checkEmbeddings: false,
      checkIndexFreshness: false,
    });

    expect(report.embeddings).toBeUndefined();
  });

  // ---- Test 11: checkLsp: false skips lspAvailable field -------------------
  it('omits lspAvailable when checkLsp is false', async () => {
    const report = await gnDiagnose(REPO_ID, {
      checkLsp: false,
      checkEmbeddings: false,
      checkIndexFreshness: false,
    });

    expect(report.lspAvailable).toBeUndefined();
    // Verify which was never called
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  // ---- Test 12: gnEnsureFresh warnings are propagated ----------------------
  it('propagates warnings from gnEnsureFresh into the report', async () => {
    mockGnEnsureFresh.mockResolvedValue({
      ...makeFreshReport(),
      warnings: ['cannot read ~/.ontoindex/registry.json: ENOENT'],
    });

    const report = await gnDiagnose(REPO_ID, {
      checkLsp: false,
      checkEmbeddings: false,
      checkIndexFreshness: true,
    });

    expect(report.warnings.some((w) => w.includes('registry.json'))).toBe(true);
  });

  // ---- Test 13: gnEnsureFresh throwing is caught, warning added ------------
  it('adds a warning and continues when gnEnsureFresh throws', async () => {
    mockGnEnsureFresh.mockRejectedValue(new Error('registry read error'));

    const report = await gnDiagnose(REPO_ID, {
      checkLsp: false,
      checkEmbeddings: true,
      checkIndexFreshness: true,
    });

    expect(report.warnings.some((w) => w.includes('gnEnsureFresh failed'))).toBe(true);
    // indexFreshness should be absent (no data)
    expect(report.indexFreshness).toBeUndefined();
    // embeddings should be absent (no data)
    expect(report.embeddings).toBeUndefined();
  });

  // ---- Test 14: Embeddings populated count > 0 → no embeddings recommendation
  it('omits embeddings recommendation when embeddings are populated', async () => {
    mockGnEnsureFresh.mockResolvedValue(makeFreshReport({ embeddingsCount: 150 }));

    const report = await gnDiagnose(REPO_ID, {
      checkLsp: false,
      checkEmbeddings: true,
      checkIndexFreshness: false,
    });

    expect(report.embeddings!.count).toBe(150);
    expect(report.embeddings!.populated).toBe(true);
    const embRec = report.recommendations.find((r) =>
      r.detail.includes('Embeddings not populated'),
    );
    expect(embRec).toBeUndefined();
  });

  it('surfaces drifted embedding metadata in the diagnose report', async () => {
    mockGnEnsureFresh.mockResolvedValue(
      makeFreshReport({
        embeddingsCount: 150,
        embeddingsStatus: 'drifted',
        reason: 'embedding model hash mismatch',
        repairCommand: 'ONTOINDEX_EMBEDDING_MODEL_HASH=stored-hash ontoindex analyze --embeddings',
      }),
    );

    const report = await gnDiagnose(REPO_ID, {
      checkLsp: false,
      checkEmbeddings: true,
      checkIndexFreshness: false,
    });

    expect(report.embeddings).toMatchObject({
      count: 150,
      populated: false,
      status: 'drifted',
      repairCommand: 'ONTOINDEX_EMBEDDING_MODEL_HASH=stored-hash ontoindex analyze --embeddings',
    });
    expect(report.degradedContext.reasons).toContain('embeddings-drifted');
    expect(report.recommendations.some((r) => r.severity === 'ERROR')).toBe(true);
    expect(report.runtimeContextSummary.embeddings).toBe('absent');
  });

  it('surfaces metadata-unavailable embedding status in the diagnose report', async () => {
    mockGnEnsureFresh.mockResolvedValue(
      makeFreshReport({
        embeddingsCount: 0,
        embeddingsStatus: 'metadata-unavailable',
        reason: 'repo metadata is unavailable',
      }),
    );

    const report = await gnDiagnose(REPO_ID, {
      checkLsp: false,
      checkEmbeddings: true,
      checkIndexFreshness: false,
    });

    expect(report.embeddings).toMatchObject({
      count: 0,
      populated: false,
      status: 'metadata-unavailable',
      repairCommand: 'ontoindex analyze',
    });
    expect(report.degradedContext.reasons).toContain('embeddings-metadata-unavailable');
    expect(report.runtimeContextSummary.embeddings).toBe('unknown');
  });

  // ---- Test 15: version field is always 1 ----------------------------------
  it('always returns version: 1', async () => {
    const report = await gnDiagnose(REPO_ID, {});
    expect(report.version).toBe(1);
  });

  it('includes ADR-0026 classification summary with resource contract coverage', async () => {
    const report = await gnDiagnose(REPO_ID, {
      checkLsp: false,
      checkEmbeddings: false,
      checkIndexFreshness: false,
      checkToolContract: false,
    });

    expect(report.classification.resourceContracts).toMatchObject({
      definitions: 2,
      templates: 14,
      total: 16,
    });
    expect(report.classification.resourceContracts.byEvidenceClass.graph_evidence).toBeGreaterThan(
      0,
    );
    expect(
      report.classification.resourceContracts.byEvidenceClass.runtime_diagnostic,
    ).toBeGreaterThan(0);
    expect(report.classification.resourceContracts.byEvidenceClass.advisory_memory).toBeGreaterThan(
      0,
    );
  });

  it('includes setup and response-limit sections with bounded defaults', async () => {
    const report = await gnDiagnose(REPO_ID, {
      checkLsp: false,
      checkEmbeddings: false,
      checkIndexFreshness: false,
      checkToolContract: false,
    });

    expect(report.setup).toMatchObject({
      mcp: {
        autoAnalyze: 'unset',
        startupTimeoutMs: 30000,
      },
      auth: {
        enforcement: 'metadata-only',
      },
    });
    expect(report.responseLimits).toMatchObject({
      mcpCypherLimitMax: 5000,
      processDetailStepLimit: 1000,
      httpMcpSessionCap: 32,
    });
  });

  it('marks diagnose as degraded when MCP auto-analyze is enabled', async () => {
    process.env['ONTOINDEX_MCP_AUTO_ANALYZE'] = '1';
    const report = await gnDiagnose(REPO_ID, {
      checkLsp: false,
      checkEmbeddings: false,
      checkIndexFreshness: false,
      checkToolContract: false,
    });

    expect(report.setup.mcp.autoAnalyze).toBe('enabled');
    expect(report.degradedContext.status).toBe('degraded');
    expect(report.degradedContext.reasons).toContain('mcp-auto-analyze-enabled');
    expect(
      report.recommendations.some((r) => r.detail.includes('ONTOINDEX_MCP_AUTO_ANALYZE')),
    ).toBe(true);
  });

  it('includes the MCP tool contract health check by default', async () => {
    const report = await gnDiagnose(REPO_ID, {
      checkLsp: false,
      checkEmbeddings: false,
      checkIndexFreshness: false,
    });

    expect(report.toolContract).toMatchObject({
      status: 'ok',
      runtime: {
        packageName: 'ontoindex',
        superToolCount: ONTOINDEX_SUPER_TOOLS.length,
      },
      missing: [],
      extras: [],
    });
    expect(report.toolContract!.advertised).toContain('gn_tool_contract');
    expect(report.toolContract!.callable).toContain('gn_tool_contract');
  });

  it('omits the MCP tool contract health check when disabled', async () => {
    const report = await gnDiagnose(REPO_ID, {
      checkLsp: false,
      checkEmbeddings: false,
      checkIndexFreshness: false,
      checkToolContract: false,
    });

    expect(report.toolContract).toBeUndefined();
  });

  it('includes shared target context in the diagnose report', async () => {
    mockResolveTargetContext.mockResolvedValue({
      ...TARGET_CONTEXT,
      embeddings: { status: 'available', count: 150 },
      lsp: {
        status: 'available',
        servers: { typescript: true, python: false, rust: false },
      },
    });
    setupWhich(['typescript-language-server']);
    mockGnEnsureFresh.mockResolvedValue(makeFreshReport({ embeddingsCount: 150 }));

    const report = await gnDiagnose(REPO_ID, {
      checkLsp: true,
      checkEmbeddings: true,
      checkIndexFreshness: true,
    });

    expect(mockResolveTargetContext).toHaveBeenCalledWith({
      repo: REPO_ID,
      checkSidecar: true,
      readiness: {
        embeddingsCount: 150,
        lspAvailable: { typescript: true, python: false, rust: false },
      },
    });
    expect(report.targetContext).toMatchObject({
      repoKey: REPO_ID,
      currentHead: CURRENT_COMMIT,
      changedSinceIndex: false,
      embeddings: { status: 'available', count: 150 },
      lsp: { status: 'available' },
    });
    expect(report.runtimeContextSummary).toMatchObject({
      repoLabel: REPO_ID,
      repoPath: TARGET_REPO_PATH,
      freshness: 'fresh',
      scopeConfidence: 'unknown',
      dirtyWorktree: false,
      embeddings: 'available',
      sidecar: 'unknown',
      qualityMode: 'fast',
    });
  });

  it('reports repo-target mismatch as a P1 misconfiguration before quality recommendations', async () => {
    process.env['ONTOINDEX_MCP_REPO'] = '/opt/demodb/_workfolder/Repo With Spaces';
    process.env['ONTOINDEX_MCP_PROJECT_CWD'] = '/opt/demodb/_workfolder/Repo With Spaces';
    mockResolveTargetContext.mockResolvedValue({
      ...TARGET_CONTEXT,
      repoKey: 'codex',
      repoLabel: 'codex',
      repoPath: '/opt/demodb/_workfolder/Active Repo With Spaces',
    });

    const report = await gnDiagnose('ontoindex', {
      checkLsp: false,
      checkEmbeddings: false,
      checkIndexFreshness: false,
      checkToolContract: false,
    });

    expect(report.misconfiguration).toMatchObject({
      status: 'fail',
      severity: 'P1',
      reason: 'mcp-service-target-mismatch',
      requestedRepo: 'ontoindex',
      activeRepoLabel: 'codex',
      activeRepoPath: '/opt/demodb/_workfolder/Active Repo With Spaces',
      projectCwd: '/opt/demodb/_workfolder/Repo With Spaces',
    });
    expect(report.degradedContext.reasons).toContain('mcp-service-target-mismatch');
    expect(report.degradedContext.affectedAreas).toContain('repo-targeting');
    expect(report.recommendations[0]).toMatchObject({
      severity: 'ERROR',
      fix: expect.stringContaining(
        "ontoindex mcp --project '/opt/demodb/_workfolder/Active Repo With Spaces'",
      ),
    });
    expect(report.misconfiguration.recommendedCommand).toBe(
      "ontoindex mcp --project '/opt/demodb/_workfolder/Active Repo With Spaces' --repo 'ontoindex'",
    );
  });

  it('does not classify missing embeddings as MCP misconfiguration', async () => {
    mockGnEnsureFresh.mockResolvedValue(makeFreshReport({ embeddingsCount: 0 }));

    const report = await gnDiagnose(REPO_ID, {
      checkLsp: false,
      checkEmbeddings: true,
      checkIndexFreshness: false,
      checkToolContract: false,
    });

    expect(report.misconfiguration).toEqual({ status: 'ok' });
    expect(report.degradedContext.reasons).toContain('embeddings-unavailable');
    expect(report.degradedContext.reasons).not.toContain('mcp-service-target-mismatch');
  });

  it('includes bounded zvec backend diagnostics when ONTOINDEX_VECTOR_BACKEND=zvec', async () => {
    process.env['ONTOINDEX_VECTOR_BACKEND'] = 'zvec';
    mockGetSemanticVectorBackendStatus.mockResolvedValue({
      requestedBackend: 'zvec',
      actualBackend: 'lbug',
      freshness: 'missing',
      fallbackReason: 'zvec mirror metadata unavailable',
      circuitBroken: false,
    });

    const report = await gnDiagnose(REPO_ID, {
      checkLsp: false,
      checkEmbeddings: false,
      checkIndexFreshness: false,
      checkToolContract: false,
    });

    expect(mockGetSemanticVectorBackendStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        id: REPO_ID,
        repoPath: TARGET_REPO_PATH,
      }),
    );
    expect(report.vectorBackend).toMatchObject({
      requestedBackend: 'zvec',
      actualBackend: 'lbug',
      freshness: 'missing',
      fallbackReason: 'zvec mirror metadata unavailable',
    });
    expect(report.degradedContext.reasons).toContain('vector-backend-fallback');
    expect(
      report.recommendations.some((r) => r.detail.includes('Requested vector backend zvec')),
    ).toBe(true);
  });

  it('includes bounded vector diagnostics when ONTOINDEX_VECTOR_BACKEND=auto', async () => {
    process.env['ONTOINDEX_VECTOR_BACKEND'] = 'auto';
    mockGetSemanticVectorBackendStatus.mockResolvedValue({
      requestedBackend: 'auto',
      actualBackend: 'lbug',
      freshness: 'missing',
      fallbackReason: 'zvec mirror unavailable',
      circuitBroken: false,
    });

    const report = await gnDiagnose(REPO_ID, {
      checkLsp: false,
      checkEmbeddings: false,
      checkIndexFreshness: false,
      checkToolContract: false,
    });

    expect(mockGetSemanticVectorBackendStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        id: REPO_ID,
        repoPath: TARGET_REPO_PATH,
      }),
    );
    expect(report.vectorBackend).toMatchObject({
      requestedBackend: 'auto',
      actualBackend: 'lbug',
      freshness: 'missing',
      fallbackReason: 'zvec mirror unavailable',
    });
    expect(report.degradedContext.reasons).toContain('vector-backend-fallback');
    expect(
      report.recommendations.some((r) => r.detail.includes('Requested vector backend auto')),
    ).toBe(true);
  });

  it('does not compute file-scope diagnostics by default', async () => {
    mockGnEnsureFresh.mockResolvedValue(makeFreshReport());

    const report = await gnDiagnose(REPO_ID, {
      checkLsp: false,
      checkEmbeddings: false,
      checkIndexFreshness: true,
      checkToolContract: false,
    });

    expect(report.fileScopePreview).toBeUndefined();
    expect(report.fileScopeExplanation).toBeUndefined();
    expect(report.runtimeHealth).toBeDefined();
  });

  it('exposes degraded-file aggregates through runtime health', async () => {
    const aggregates = {
      sampledDegradedCount: 4,
      groups: [
        {
          cause: 'file exceeds scan file-size cap',
          phase: 'scan',
          language: 'python',
          count: 4,
        },
      ],
      omittedGroupCount: 1,
    };
    mockGnEnsureFresh.mockResolvedValue({
      ...makeFreshReport(),
      runtimeHealth: {
        ...makeFreshReport().runtimeHealth,
        degradedFileAggregates: aggregates,
      },
    });

    const report = await gnDiagnose(REPO_ID, {
      checkLsp: false,
      checkEmbeddings: false,
      checkIndexFreshness: true,
      checkToolContract: false,
    });

    expect(report.runtimeHealth?.degradedFileAggregates).toEqual(aggregates);
  });

  it('omits degraded-file aggregates from runtime health when absent', async () => {
    mockGnEnsureFresh.mockResolvedValue(makeFreshReport());

    const report = await gnDiagnose(REPO_ID, {
      checkLsp: false,
      checkEmbeddings: false,
      checkIndexFreshness: true,
      checkToolContract: false,
    });

    expect(report.runtimeHealth).toBeDefined();
    expect(report.runtimeHealth?.degradedFileAggregates).toBeUndefined();
  });

  it('returns requested file-scope preview and explanation', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-diagnose-file-scope-'));
    try {
      await fs.mkdir(path.join(tmpDir, 'src'), { recursive: true });
      await fs.writeFile(path.join(tmpDir, 'src/index.ts'), 'export const value = 1;\n');
      mockResolveTargetContext.mockResolvedValue({
        ...TARGET_CONTEXT,
        repoPath: tmpDir,
      });
      mockGnEnsureFresh.mockResolvedValue({
        ...makeFreshReport(),
        repoPath: tmpDir,
        runtimeHealth: {
          ...makeFreshReport().runtimeHealth,
          repoPath: tmpDir,
        },
      });

      const report = await gnDiagnose(REPO_ID, {
        checkLsp: false,
        checkEmbeddings: false,
        checkIndexFreshness: true,
        checkToolContract: false,
        includeFileScopePreview: true,
        explainFile: 'src/index.ts',
        fileScopeLimit: 1,
      });

      expect(report.fileScopePreview).toMatchObject({
        repoPath: tmpDir,
        includedCount: 1,
      });
      expect(report.fileScopeExplanation).toMatchObject({
        filePath: 'src/index.ts',
        included: true,
        reason: 'included-extension',
      });
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('returns the capability-aware envelope when legacyResponse is false', async () => {
    mockResolveTargetContext.mockResolvedValue({
      ...TARGET_CONTEXT,
      sidecar: { status: 'unavailable', reason: 'sidecar-store-empty' },
    });
    mockGnEnsureFresh.mockResolvedValue(makeFreshReport({ embeddingsCount: 0 }));

    const report = await gnDiagnose(REPO_ID, {
      legacyResponse: false,
      checkLsp: false,
      checkEmbeddings: true,
      checkIndexFreshness: true,
    });

    expect(report).toMatchObject({
      envelopeVersion: '1',
      tool: 'gn_diagnose',
      status: 'degraded',
      capabilitiesUsed: expect.arrayContaining(['target-context', 'embeddings-probe']),
      capabilitiesMissing: expect.arrayContaining(['embeddings', 'sidecar']),
      warnings: expect.arrayContaining([
        expect.stringContaining('semantic retrieval fell back to lexical/graph ranking'),
      ]),
      nextTools: expect.arrayContaining(['gn_ensure_fresh', 'gn_quality_mode']),
    });
    expect((report.results as Record<string, unknown>).embeddings).toMatchObject({
      populated: false,
    });
  });
  // ---- Test 16: Audit freshness diagnostics ---------------------------------
  it('returns status: missing when audit-projection.json does not exist', async () => {
    vi.spyOn(fs, 'readFile').mockRejectedValue(
      Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
    );

    const report = await gnDiagnose(REPO_ID, {
      checkLsp: false,
      checkEmbeddings: false,
      checkIndexFreshness: false,
    });

    expect(report.auditFreshness).toEqual({ status: 'missing' });
  });

  it('returns status: clean when audit-projection matches HEAD and has no dirty files', async () => {
    const projection = {
      sessions: [
        {
          id: 'session-123',
          targetHead: CURRENT_COMMIT,
          createdAt: '2026-06-24T12:00:00.000Z',
        },
      ],
    };
    vi.spyOn(fs, 'readFile').mockResolvedValue(JSON.stringify(projection));
    mockComputeAuditFreshness.mockResolvedValue({
      state: 'clean',
      currentHead: CURRENT_COMMIT,
      dirtyFiles: [],
      targetHead: { commit: CURRENT_COMMIT } as any,
      changedFiles: [],
      warnings: [],
      checkedAt: '',
    });

    const report = await gnDiagnose(REPO_ID, {
      checkLsp: false,
      checkEmbeddings: false,
      checkIndexFreshness: false,
    });

    expect(report.auditFreshness).toEqual({
      status: 'clean',
      targetHead: CURRENT_COMMIT,
      currentHead: CURRENT_COMMIT,
      sessionId: 'session-123',
    });
  });

  it('returns status: stale and adds WARN recommendation when audit targetHead differs from current HEAD', async () => {
    const projection = {
      sessions: [
        {
          id: 'session-123',
          targetHead: STALE_COMMIT,
          createdAt: '2026-06-24T12:00:00.000Z',
        },
      ],
    };
    vi.spyOn(fs, 'readFile').mockResolvedValue(JSON.stringify(projection));
    mockComputeAuditFreshness.mockResolvedValue({
      state: 'stale',
      currentHead: CURRENT_COMMIT,
      dirtyFiles: [],
      targetHead: { commit: STALE_COMMIT } as any,
      changedFiles: [],
      warnings: [],
      checkedAt: '',
    });

    const report = await gnDiagnose(REPO_ID, {
      checkLsp: false,
      checkEmbeddings: false,
      checkIndexFreshness: false,
    });

    expect(report.auditFreshness).toEqual({
      status: 'stale',
      targetHead: STALE_COMMIT,
      currentHead: CURRENT_COMMIT,
      sessionId: 'session-123',
      repairCommand: 'gn_audit_replay({session: "session-123"})',
    });
    expect(
      report.recommendations.some((r) => r.severity === 'WARN' && r.detail.includes('stale')),
    ).toBe(true);
  });

  // ---- Test 17: MCP resource bridge diagnostics -----------------------------
  it('reports mcpResourceBridge status correctly', async () => {
    vi.spyOn(fs, 'readFile').mockImplementation((p) => {
      if (p.toString().endsWith('.claude.json')) {
        return Promise.resolve(JSON.stringify({ mcpServers: { ontoindex: {} } }));
      }
      return Promise.reject(new Error('ENOENT'));
    });

    const report = await gnDiagnose(REPO_ID, {
      checkLsp: false,
      checkEmbeddings: false,
      checkIndexFreshness: false,
    });

    expect(report.mcpResourceBridge).toEqual({
      exposed: true,
      exposedTo: ['Claude Code'],
    });
  });

  it('includes bounded support diagnostics for the Ladybug store and runtime', async () => {
    vi.spyOn(fs, 'readFile').mockRejectedValue(
      Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
    );
    vi.spyOn(fs, 'stat').mockImplementation(async (targetPath: fs.PathLike) => {
      if (targetPath.toString() === TARGET_LBUG_PATH) {
        return { size: 4096, mtime: new Date('2026-06-27T12:00:00.000Z') } as any;
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    mockGetLbugRuntimeDiagnostics.mockResolvedValue({
      extensionHintDir: '/tmp/lbug-ext',
      getAllTimeoutMs: 30000,
      extensions: {
        fts: { available: true, path: '/tmp/lbug-ext/libfts.lbug_extension' },
        vector: { available: false, path: null },
      },
    });

    const report = await gnDiagnose(REPO_ID, {
      checkLsp: false,
      checkEmbeddings: false,
      checkIndexFreshness: false,
      checkToolContract: false,
    });

    expect(report.support).toEqual({
      lbugStore: {
        path: TARGET_LBUG_PATH,
        exists: true,
        sizeBytes: 4096,
        modifiedAt: '2026-06-27T12:00:00.000Z',
        walPresent: false,
        lockPresent: false,
      },
      ladybugExtensions: {
        hintDir: '/tmp/lbug-ext',
        ftsAvailable: true,
        vectorAvailable: false,
      },
      timeoutHints: {
        nativeGetAllMs: 30000,
      },
    });
  });

  it('does not flag repo path mismatches that differ only by case on Windows', async () => {
    const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
    const previousProjectCwd = process.env.ONTOINDEX_MCP_PROJECT_CWD;
    Object.defineProperty(process, 'platform', {
      value: 'win32',
      configurable: true,
    });
    process.env.ONTOINDEX_MCP_PROJECT_CWD = '/Repo/Test-Repo';
    mockResolveTargetContext.mockResolvedValue({
      ...TARGET_CONTEXT,
      repoPath: '/repo/test-repo',
    });

    try {
      const report = await gnDiagnose(REPO_ID, {
        checkLsp: false,
        checkEmbeddings: false,
        checkIndexFreshness: false,
        checkToolContract: false,
      });

      expect(report.misconfiguration).toEqual({ status: 'ok' });
    } finally {
      if (previousProjectCwd === undefined) delete process.env.ONTOINDEX_MCP_PROJECT_CWD;
      else process.env.ONTOINDEX_MCP_PROJECT_CWD = previousProjectCwd;
      if (platformDescriptor) Object.defineProperty(process, 'platform', platformDescriptor);
    }
  });
});
