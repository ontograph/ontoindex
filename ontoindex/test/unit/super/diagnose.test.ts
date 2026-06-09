/**
 * Unit tests: gnDiagnose
 *
 * All external I/O (child_process, gnEnsureFresh) is mocked via vi.mock.
 * No real git process, LSP binaries, or filesystem access is used.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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

// ---------------------------------------------------------------------------
// Imports (after mocks).
// ---------------------------------------------------------------------------

import { execFile } from 'child_process';
import { gnEnsureFresh } from '../../../src/mcp/super/ensure-fresh.js';
import { resolveTargetContext } from '../../../src/mcp/shared/target-context.js';
import { gnDiagnose } from '../../../src/mcp/super/diagnose.js';
import { ONTOINDEX_SUPER_TOOLS } from '../../../src/mcp/super/tool-definitions.js';

const mockExecFile = vi.mocked(execFile);
const mockGnEnsureFresh = vi.mocked(gnEnsureFresh);
const mockResolveTargetContext = vi.mocked(resolveTargetContext);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const REPO_ID = 'test-repo';
const CURRENT_COMMIT = 'abc123def456abc123def456abc123def456abc1';
const INDEXED_COMMIT = 'abc123def456abc123def456abc123def456abc1';
const STALE_COMMIT = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
const TARGET_CONTEXT = {
  version: 1 as const,
  status: 'ok' as const,
  repoKey: REPO_ID,
  repoPath: '/tmp/test-repo',
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
function makeFreshReport(options: { isStale?: boolean; embeddingsCount?: number } = {}) {
  const { isStale = false, embeddingsCount = 0 } = options;
  const indexedCommit = isStale ? STALE_COMMIT : INDEXED_COMMIT;
  return {
    version: 1 as const,
    preCheck: { indexedCommit, currentCommit: CURRENT_COMMIT, isStale },
    embeddingsStatus: { count: embeddingsCount, required: false },
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
    expect(report.indexFreshness).toBeDefined();
    expect(report.indexFreshness!.isStale).toBe(false);
    expect(report.recommendations.some((r) => r.severity === 'WARN')).toBe(false);
    expect(report.warnings).toHaveLength(0);
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
});
