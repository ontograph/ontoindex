/**
 * Unit tests: gnDiffImpact + gnReviewDiff
 *
 * All external I/O (child_process, pool-adapter, target-context) is mocked via vi.mock.
 * No real git process or LadybugDB connection is used.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — must be declared before the module under test is imported.
// ---------------------------------------------------------------------------

vi.mock('child_process', () => ({
  execFileSync: vi.fn(),
}));

vi.mock('../../../src/core/lbug/pool-adapter.js', () => ({
  executeParameterized: vi.fn(),
  executeQuery: vi.fn(),
}));

vi.mock('../../../src/mcp/shared/target-context.js', () => ({
  resolveTargetContext: vi.fn(),
}));

vi.mock('../../../src/storage/git.js', () => ({
  resolveBranchComparisonBase: vi.fn(() => ({
    ref: 'main',
    commit: 'base123',
    range: 'main...HEAD',
    source: 'main',
  })),
}));

vi.mock('../../../src/mcp/super/docs-evidence.js', () => ({
  collectAdvisoryDocsEvidence: vi.fn(async () => ({
    enabled: true,
    sidecar: { status: 'available', staleReasons: [], degradedReasons: {} },
    freshness: { statusCounts: { fresh: 1 }, stale: false, reasons: [] },
    docEvidence: [
      {
        kind: 'requirement',
        docPath: 'docs/adr/0028-answer-engine-inspired-evidence-expansion.md',
        lineSpan: { start: 120, end: 126 },
        requirementId: 'ADR-0028',
        confidence: 0.9,
        status: 'fresh',
        reasons: [],
        ambiguous: false,
        stale: false,
      },
    ],
    relatedDocs: [
      {
        docPath: 'docs/adr/0028-answer-engine-inspired-evidence-expansion.md',
        evidenceCount: 1,
        confidence: 0.9,
        reasons: [],
        freshness: 'fresh',
      },
    ],
    limits: { maxEvidence: 12, maxRelatedDocs: 5, totalEvidence: 1, truncated: false },
  })),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks).
// ---------------------------------------------------------------------------

import { execFileSync } from 'child_process';
import { executeParameterized, executeQuery } from '../../../src/core/lbug/pool-adapter.js';
import { resolveTargetContext } from '../../../src/mcp/shared/target-context.js';
import { collectAdvisoryDocsEvidence } from '../../../src/mcp/super/docs-evidence.js';
import {
  applyChangedPathLimitForReview,
  gnDiffImpact,
  gnReviewDiff,
} from '../../../src/mcp/super/diff-impact.js';

const mockExecFileSync = vi.mocked(execFileSync);
const mockExecute = vi.mocked(executeParameterized);
const mockExecuteQuery = vi.mocked(executeQuery);
const mockResolveTargetContext = vi.mocked(resolveTargetContext);
const mockCollectAdvisoryDocsEvidence = vi.mocked(collectAdvisoryDocsEvidence);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const REPO_ID = 'test-repo';

const MOCK_TARGET_CONTEXT = {
  version: 1 as const,
  status: 'ok' as const,
  repoKey: REPO_ID,
  repoPath: '/repo',
  branch: 'main',
  targetRef: 'HEAD',
  targetHead: 'abc123',
  currentHead: 'abc123',
  indexedHead: 'abc123',
  graphAuthority: {
    state: 'authoritative' as const,
    reason: 'current source manifest matches indexed generation',
    generationId: 'generation-1',
    manifestDigest: 'manifest-1',
    coverage: 'complete' as const,
  },
  dirtyWorktree: false,
  changedSinceIndex: false,
  snapshotMode: 'live' as const,
  qualityMode: 'standard' as const,
  embeddings: { status: 'ok' as const, reason: 'populated' },
  lsp: { status: 'unknown' as const, reason: 'not-probed' },
  sidecar: { status: 'unknown' as const, reason: 'not-probed' },
  policy: { status: 'unknown' as const, reason: 'not-configured' },
  warnings: [],
};

/**
 * Wire up execFileSync to return predictable outputs.
 * - git rev-parse --show-toplevel  → '/repo'
 * - git diff ... --name-only       → nameOnlyOutput
 * - git diff ... --numstat         → numstatOutput
 * - git log --format=%aN ...       → reviewerOutput
 */
function setupGitMocks(nameOnlyOutput: string, numstatOutput = '', reviewerOutput = '') {
  mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
    if (args.includes('--show-toplevel')) return '/repo\n';
    if (args.includes('--name-only')) return nameOnlyOutput;
    if (args.includes('--numstat')) return numstatOutput;
    if (args.includes('--format=%aN')) return reviewerOutput;
    return '';
  });
}

/** Wire up executeParameterized and executeQuery with sensible defaults. */
function setupGraphMocks(
  options: {
    symbolRows?: any[];
    upstreamCount?: number;
    downstreamCount?: number;
    testFileRows?: any[];
    processRows?: any[];
    communityRows?: any[];
  } = {},
) {
  const {
    symbolRows = [{ id: 'Function:src/foo.ts:doWork', name: 'doWork' }],
    upstreamCount = 3,
    downstreamCount = 1,
    testFileRows = [],
    processRows = [],
    communityRows = [],
  } = options;

  mockExecute.mockImplementation(async (_repoId: string, cypher: string, _params: any) => {
    if (cypher.includes("type: 'DEFINES'")) return symbolRows;
    // Heuristic downstream count (still a cheap direct probe in the shared builder)
    if (cypher.includes('count(*)') && cypher.includes('callee')) {
      return [{ count: downstreamCount }];
    }
    if (cypher.includes("type: 'STEP_IN_PROCESS'")) return processRows;
    if (cypher.includes("type: 'MEMBER_OF'")) return communityRows;
    if (cypher.includes("type: 'IMPORTS'") && cypher.includes('test')) {
      return testFileRows;
    }
    return [];
  });

  // executeQuery is used by the impact kernel for the upstream traversal (depth=1).
  // Return `upstreamCount` mock caller rows so rawCounts.direct equals upstreamCount.
  mockExecuteQuery.mockImplementation(async (_repoId: string, cypher: string) => {
    if (cypher.includes('MATCH (caller)-[r:CodeRelation]->(n)')) {
      return Array.from({ length: upstreamCount }, (_, i) => ({
        sourceId: 'node-id',
        id: `caller-${i}`,
        name: `callerFn${i}`,
        type: 'Function',
        filePath: 'src/other.ts',
        relType: 'CALLS',
        confidence: 0.9,
      }));
    }
    return [];
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('gnDiffImpact', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveTargetContext.mockResolvedValue(MOCK_TARGET_CONTEXT as any);
  });

  // ---- Test 1: commitRange provided → correct git diff args ---------------
  it('uses the provided commitRange in git diff args', async () => {
    setupGitMocks('src/foo.ts\n', '5\t2\tsrc/foo.ts\n');
    setupGraphMocks({ upstreamCount: 2 });

    await gnDiffImpact(REPO_ID, { commitRange: 'HEAD~3..HEAD' });

    const nameOnlyCall = mockExecFileSync.mock.calls.find((c) => c[1].includes('--name-only'));
    expect(nameOnlyCall).toBeDefined();
    expect(nameOnlyCall![1]).toContain('HEAD~3..HEAD');
    expect(nameOnlyCall![1]).not.toContain('--cached');

    const numstatCall = mockExecFileSync.mock.calls.find((c) => c[1].includes('--numstat'));
    expect(numstatCall).toBeDefined();
    expect(numstatCall![1]).toContain('HEAD~3..HEAD');
    expect(nameOnlyCall?.[2]).toMatchObject({ cwd: '/repo' });
    expect(mockResolveTargetContext).toHaveBeenCalledWith({
      repo: REPO_ID,
      verifyGraphAuthority: true,
      requiredGraphCapabilities: ['symbols', 'impact', 'processes'],
    });
  });

  it('rejects an unresolved explicit repository before executing git', async () => {
    mockResolveTargetContext.mockResolvedValue({
      ...MOCK_TARGET_CONTEXT,
      status: 'not-found',
      repoPath: undefined,
      action: 'Repository "missing" is not indexed.',
    } as any);

    await expect(gnDiffImpact('missing', { scope: 'staged' })).rejects.toThrow(
      'Repository "missing" is not indexed.',
    );
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  it('uses the requested repository path when process cwd points at another repository', async () => {
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue('/repo-a');
    mockResolveTargetContext.mockResolvedValue({
      ...MOCK_TARGET_CONTEXT,
      repoPath: '/repo-b',
    } as any);
    setupGitMocks('src/foo.ts\n', '5\t2\tsrc/foo.ts\n');
    setupGraphMocks({ upstreamCount: 2 });

    try {
      await gnDiffImpact(REPO_ID, { commitRange: 'HEAD~1..HEAD' });
    } finally {
      cwdSpy.mockRestore();
    }

    expect(mockExecFileSync.mock.calls.some((call) => call[1].includes('--show-toplevel'))).toBe(
      false,
    );
    expect(
      mockExecFileSync.mock.calls
        .filter((call) => call[0] === 'git')
        .every((call) => (call[2] as { cwd?: string } | undefined)?.cwd === '/repo-b'),
    ).toBe(true);
  });

  // ---- Test 2: scope 'staged' → --cached args -----------------------------
  it("uses '--cached' when scope is 'staged'", async () => {
    setupGitMocks('src/bar.ts\n', '10\t3\tsrc/bar.ts\n');
    setupGraphMocks({ upstreamCount: 1 });

    await gnDiffImpact(REPO_ID, { scope: 'staged' });

    const nameOnlyCall = mockExecFileSync.mock.calls.find((c) => c[1].includes('--name-only'));
    expect(nameOnlyCall![1]).toContain('--cached');
    expect(nameOnlyCall![1]).not.toContain('main...HEAD');
  });

  // ---- Test 3: scope 'branch' → main...HEAD args --------------------------
  it("uses 'main...HEAD' when scope is 'branch'", async () => {
    setupGitMocks('src/utils.ts\n', '7\t1\tsrc/utils.ts\n');
    setupGraphMocks({ upstreamCount: 5 });

    await gnDiffImpact(REPO_ID, { scope: 'branch' });

    const nameOnlyCall = mockExecFileSync.mock.calls.find((c) => c[1].includes('--name-only'));
    expect(nameOnlyCall![1]).toContain('main...HEAD');
    expect(nameOnlyCall![1]).not.toContain('--cached');
  });

  // ---- Test 4: per-symbol impact aggregated into changedSymbols -----------
  it('populates changedSymbols with upstream/downstream counts and risk', async () => {
    setupGitMocks('src/engine.ts\n', '20\t5\tsrc/engine.ts\n');
    setupGraphMocks({
      symbolRows: [
        { id: 'Class:src/engine.ts:Engine', name: 'Engine' },
        { id: 'Function:src/engine.ts:init', name: 'init' },
      ],
      upstreamCount: 15,
      downstreamCount: 4,
    });

    const report = await gnDiffImpact(REPO_ID, { commitRange: 'HEAD~1..HEAD' });

    expect(report.changedFiles).toHaveLength(1);
    const file = report.changedFiles[0];
    expect(file.path).toBe('src/engine.ts');
    expect(file.addedLines).toBe(20);
    expect(file.removedLines).toBe(5);
    expect(file.changedSymbols).toHaveLength(2);

    const engine = file.changedSymbols.find((s) => s.name === 'Engine')!;
    expect(engine.nodeId).toBe('Class:src/engine.ts:Engine');
    expect(engine.impact.upstreamCount).toBe(15);
    expect(engine.impact.downstreamCount).toBe(4);
    expect(engine.impact.risk).toBe('MEDIUM'); // 15 is in [10,50]

    expect(report.totalSymbolsChanged).toBe(2);
  });

  it('emits a deterministic responseContract for gnDiffImpact', async () => {
    setupGitMocks('src/engine.ts\n', '20\t5\tsrc/engine.ts\n');
    setupGraphMocks({
      symbolRows: [{ id: 'Function:src/engine.ts:init', name: 'init' }],
      upstreamCount: 2,
      downstreamCount: 1,
    });

    const report = await gnDiffImpact(REPO_ID, { commitRange: 'HEAD~1..HEAD' });

    expect(report.responseContract).toMatchObject({
      mode: 'summary-first',
      stablePrefix: 'repo-and-contract',
      deterministicOrder: true,
      expandable: false,
      anchorScheme: 'source-identity-v1',
      anchors: ['test-repo:src/engine.ts', 'test-repo:Function:src/engine.ts:init'],
    });
    expect(report.responseContract).not.toHaveProperty('omittedItems');
    expect(report.responseContract).not.toHaveProperty('expandHint');
  });

  // ---- Test 5: HIGH-risk symbol surfaced in highRiskSymbols ---------------
  it('surfaces HIGH-risk symbol names in highRiskSymbols', async () => {
    setupGitMocks('src/core/critical.ts\n', '100\t0\tsrc/core/critical.ts\n');
    setupGraphMocks({
      symbolRows: [{ id: 'Function:src/core/critical.ts:processAll', name: 'processAll' }],
      upstreamCount: 75, // > 50 → HIGH
    });

    const report = await gnDiffImpact(REPO_ID, { commitRange: 'main...HEAD' });

    expect(report.highRiskSymbols).toContain('processAll');
    expect(report.changedFiles[0].changedSymbols[0].impact.risk).toBe('HIGH');
  });

  // ---- Test 6: reviewer extraction from git log ---------------------------
  it('extracts top-3 reviewers from git log', async () => {
    setupGitMocks(
      'src/api.ts\n',
      '30\t10\tsrc/api.ts\n',
      'Alice\nBob\nAlice\nCharlie\nAlice\nBob\n',
    );
    setupGraphMocks({ upstreamCount: 2 });

    const report = await gnDiffImpact(REPO_ID, {
      commitRange: 'HEAD~5..HEAD',
      includeReviewers: true,
    });

    expect(report.suggestedReviewers).toBeDefined();
    expect(report.suggestedReviewers![0]).toBe('Alice'); // most commits
    expect(report.suggestedReviewers![1]).toBe('Bob');
    expect(report.suggestedReviewers!.length).toBeLessThanOrEqual(3);
  });

  // ---- Test 7: includeReviewers=false skips git log -----------------------
  it('does not call git log when includeReviewers is false', async () => {
    setupGitMocks('src/util.ts\n', '5\t0\tsrc/util.ts\n');
    setupGraphMocks({ upstreamCount: 1 });

    const report = await gnDiffImpact(REPO_ID, {
      commitRange: 'HEAD~1..HEAD',
      includeReviewers: false,
    });

    const logCall = mockExecFileSync.mock.calls.find((c) => c[1].includes('--format=%aN'));
    expect(logCall).toBeUndefined();
    expect(report.suggestedReviewers).toBeUndefined();
  });

  // ---- Test 8: empty diff returns empty report ----------------------------
  it('returns an empty report when diff produces no changed files', async () => {
    setupGitMocks(''); // no files
    mockExecute.mockResolvedValue([]);

    const report = await gnDiffImpact(REPO_ID, { commitRange: 'HEAD~1..HEAD' });

    expect(report.version).toBe(1);
    expect(report.commitRange).toBe('HEAD~1..HEAD');
    expect(report.changedFiles).toHaveLength(0);
    expect(report.totalSymbolsChanged).toBe(0);
    expect(report.highRiskSymbols).toHaveLength(0);
    expect(report.warnings).toHaveLength(0);
    expect(mockExecute).not.toHaveBeenCalled();
  });

  // ---- Test 9: git diff failure returns warning, no throw -----------------
  it('returns a warning report when git diff throws', async () => {
    mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes('--show-toplevel')) return '/repo\n';
      throw new Error('not a git repository');
    });
    mockExecute.mockResolvedValue([]);

    const report = await gnDiffImpact(REPO_ID, { commitRange: 'HEAD~1..HEAD' });

    expect(report.changedFiles).toHaveLength(0);
    expect(report.warnings.some((w) => w.includes('git diff failed'))).toBe(true);
  });

  // ---- Test 10: numstat line counts parsed correctly ----------------------
  it('parses numstat output and maps line counts to changedFiles', async () => {
    setupGitMocks('src/a.ts\nsrc/b.ts\n', '10\t2\tsrc/a.ts\n50\t0\tsrc/b.ts\n');
    setupGraphMocks({ symbolRows: [], upstreamCount: 0 });

    const report = await gnDiffImpact(REPO_ID, { commitRange: 'HEAD~2..HEAD' });

    const a = report.changedFiles.find((f) => f.path === 'src/a.ts')!;
    const b = report.changedFiles.find((f) => f.path === 'src/b.ts')!;
    expect(a.addedLines).toBe(10);
    expect(a.removedLines).toBe(2);
    expect(b.addedLines).toBe(50);
    expect(b.removedLines).toBe(0);
  });

  it('adds evidence-backed recommendations and additive evidence ids', async () => {
    setupGitMocks('src/engine.ts\n', '20\t5\tsrc/engine.ts\n');
    setupGraphMocks({
      symbolRows: [{ id: 'Function:src/engine.ts:processAll', name: 'processAll' }],
      upstreamCount: 75,
      downstreamCount: 4,
      processRows: [
        {
          pid: 'Process:review',
          name: 'dispatchSuper',
          processType: 'request',
          changedStepCount: 1,
        },
      ],
      testFileRows: [],
    });

    const report = await gnDiffImpact(REPO_ID, { commitRange: 'HEAD~1..HEAD' });

    expect(report.changedFiles[0]?.evidenceIds.length).toBeGreaterThan(0);
    expect(report.changedFiles[0]?.changedSymbols[0]?.evidenceIds.length).toBeGreaterThan(0);
    expect(report.affectedProcesses[0]?.evidenceIds.length).toBeGreaterThan(0);
    expect(report.recommendations.length).toBeGreaterThan(0);
    expect(report.recommendations.every((rec) => rec.evidenceIds.length > 0)).toBe(true);
    expect(report.recommendations.every((rec) => rec.evidenceClasses.length > 0)).toBe(true);
    for (const recommendation of report.recommendations) {
      if (recommendation.confidence !== 'high') continue;
      expect(
        recommendation.evidenceClasses.some(
          (evidenceClass) =>
            evidenceClass === 'graph_evidence' || evidenceClass === 'audit_evidence',
        ),
      ).toBe(true);
    }
    expect(report.recommendations.map((rec) => rec.action)).toEqual(
      expect.arrayContaining([
        'review-high-risk-symbol',
        'review-affected-process',
        'review-test-gap',
      ]),
    );
    expect(
      report.warningDetails.find((warning) =>
        warning.message.includes('No linked test import evidence'),
      )?.evidenceIds.length,
    ).toBeGreaterThan(0);
  });

  it('downgrades recommendation confidence when freshness is stale', async () => {
    setupGitMocks('src/critical.ts\n', '80\t0\tsrc/critical.ts\n');
    setupGraphMocks({
      symbolRows: [{ id: 'Function:src/critical.ts:dispatch', name: 'dispatch' }],
      upstreamCount: 60,
    });
    mockResolveTargetContext.mockResolvedValue({
      ...MOCK_TARGET_CONTEXT,
      targetHead: 'def456',
      indexedHead: 'abc123',
      currentHead: 'def456',
      changedSinceIndex: true,
      graphAuthority: {
        ...MOCK_TARGET_CONTEXT.graphAuthority,
        state: 'review',
        reason: 'target commit differs from indexed generation',
      },
    } as any);

    const report = await gnDiffImpact(REPO_ID, { commitRange: 'main...HEAD' });

    const highRiskRecommendation = report.recommendations.find(
      (recommendation) => recommendation.action === 'review-high-risk-symbol',
    );
    expect(highRiskRecommendation).toBeDefined();
    expect(['low', 'medium']).toContain(highRiskRecommendation?.confidence);
    expect(highRiskRecommendation?.confidence).not.toBe('high');
    expect(report.capabilityState.freshness.status).toBe('stale');
    expect(report.capabilityState.capabilitiesMissing).toContain('authoritative-graph');
  });

  it('keeps opt-in docs evidence advisory and out of recommendation authority', async () => {
    setupGitMocks('src/critical.ts\n', '80\t0\tsrc/critical.ts\n');
    setupGraphMocks({
      symbolRows: [{ id: 'Function:src/critical.ts:dispatch', name: 'dispatch' }],
      upstreamCount: 75,
    });

    const report = await gnDiffImpact(REPO_ID, {
      commitRange: 'HEAD~1..HEAD',
      docsEvidence: true,
    });

    expect(mockCollectAdvisoryDocsEvidence).toHaveBeenCalledWith(
      REPO_ID,
      expect.arrayContaining([
        expect.objectContaining({ filePath: 'src/critical.ts' }),
        expect.objectContaining({ name: 'dispatch', filePath: 'src/critical.ts' }),
      ]),
    );
    expect(report.docEvidence?.docEvidence).toHaveLength(1);
    expect(report.relatedDocs?.[0]?.docPath).toBe(
      'docs/adr/0028-answer-engine-inspired-evidence-expansion.md',
    );
    expect(report.recommendations.length).toBeGreaterThan(0);
    expect(
      report.recommendations.every(
        (recommendation) => !recommendation.evidenceClasses.includes('docs_evidence'),
      ),
    ).toBe(true);
    for (const recommendation of report.recommendations) {
      if (recommendation.confidence !== 'high') continue;
      expect(
        recommendation.evidenceClasses.some(
          (evidenceClass) =>
            evidenceClass === 'graph_evidence' || evidenceClass === 'audit_evidence',
        ),
      ).toBe(true);
    }
  });

  it('returns summary-first bounded detail for large diff payloads', async () => {
    const previousFileLimit = process.env.ONTOINDEX_DIFF_IMPACT_MAX_DETAIL_FILES;
    const previousSymbolLimit = process.env.ONTOINDEX_DIFF_IMPACT_MAX_DETAIL_SYMBOLS_PER_FILE;
    process.env.ONTOINDEX_DIFF_IMPACT_MAX_DETAIL_FILES = '1';
    process.env.ONTOINDEX_DIFF_IMPACT_MAX_DETAIL_SYMBOLS_PER_FILE = '1';
    setupGitMocks('src/a.ts\nsrc/b.ts\n', '5\t1\tsrc/a.ts\n7\t2\tsrc/b.ts\n');
    setupGraphMocks({
      symbolRows: [
        { id: 'Function:src/file.ts:first', name: 'first' },
        { id: 'Function:src/file.ts:second', name: 'second' },
      ],
      upstreamCount: 2,
    });

    try {
      const report = await gnDiffImpact(REPO_ID, { commitRange: 'HEAD~1..HEAD' });

      expect(report.summary).toMatchObject({
        totalChangedFiles: 2,
        emittedChangedFiles: 1,
        totalChangedSymbols: 4,
        emittedChangedSymbols: 1,
        detailTruncated: true,
        truncatedFileCount: 1,
        truncatedSymbolCount: 3,
      });
      expect(report.limits).toMatchObject({
        summaryFirst: true,
        truncated: true,
        maxChangedFiles: 1,
        maxChangedSymbolsPerFile: 1,
        emittedChangedFiles: 1,
        totalChangedFiles: 2,
        emittedChangedSymbols: 1,
        totalChangedSymbols: 4,
        truncatedFileCount: 1,
        truncatedSymbolCount: 3,
        cursor: null,
      });
      expect(report.limits.retryHint).toContain('narrower commit range');
      expect(report.changedFiles).toHaveLength(1);
      expect(report.changedFiles[0]).toMatchObject({
        path: 'src/a.ts',
        detailTruncated: true,
        totalChangedSymbols: 2,
      });
      expect(report.changedFiles[0].changedSymbols).toHaveLength(1);
      expect(report.warnings).toContain('Diff impact detailed file output capped at 1 files');
      expect(report.warnings).toContain('Diff impact per-file symbol detail capped at 1 symbols');
    } finally {
      if (previousFileLimit === undefined) {
        delete process.env.ONTOINDEX_DIFF_IMPACT_MAX_DETAIL_FILES;
      } else {
        process.env.ONTOINDEX_DIFF_IMPACT_MAX_DETAIL_FILES = previousFileLimit;
      }
      if (previousSymbolLimit === undefined) {
        delete process.env.ONTOINDEX_DIFF_IMPACT_MAX_DETAIL_SYMBOLS_PER_FILE;
      } else {
        process.env.ONTOINDEX_DIFF_IMPACT_MAX_DETAIL_SYMBOLS_PER_FILE = previousSymbolLimit;
      }
    }
  });

  it('adds compact pr-pack readiness without changing default output', async () => {
    setupGitMocks(
      'src/critical.ts\n.github/workflows/ci.yml\n',
      '80\t0\tsrc/critical.ts\n4\t1\t.github/workflows/ci.yml\n',
    );
    setupGraphMocks({
      symbolRows: [{ id: 'Function:src/critical.ts:dispatch', name: 'dispatch' }],
      upstreamCount: 75,
    });

    const baseReport = await gnDiffImpact(REPO_ID, { commitRange: 'main...HEAD' });
    const report = await gnDiffImpact(REPO_ID, {
      commitRange: 'main...HEAD',
      docsEvidence: true,
      profile: 'pr-pack',
    });

    expect(baseReport.prReadiness).toBeUndefined();
    expect(report.prReadiness).toMatchObject({
      profile: 'pr-pack',
      verdict: 'BLOCKED',
      summary: {
        changedFiles: 2,
        changedSymbols: 2,
        highRiskSymbols: 2,
        affectedProcesses: 0,
        testGapWarnings: 2,
        relatedDocs: 1,
        securitySensitivePaths: ['.github/workflows/ci.yml'],
      },
    });
    expect(report.prReadiness?.stopConditions.map((condition) => condition.reason)).toEqual(
      expect.arrayContaining([
        '2 high-risk changed symbol(s).',
        '2 changed file(s) have no linked test import evidence.',
        '1 security-sensitive path hint(s).',
      ]),
    );
    expect(report.prReadiness?.nextCommands).toContain('npm test');
    expect(report.prReadiness?.nextCommands).toContain('npm exec tsc -- --noEmit');
  });
});

// ---------------------------------------------------------------------------
// REV-5: gnReviewDiff — MCP review envelope tests
// ---------------------------------------------------------------------------

describe('gnReviewDiff', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveTargetContext.mockResolvedValue(MOCK_TARGET_CONTEXT as any);
  });

  // ---- RD-1: returns ADR 0018 envelope shape --------------------------------
  it('returns an ADR 0018 envelope with envelopeVersion and results', async () => {
    setupGitMocks('src/foo.ts\n', '5\t2\tsrc/foo.ts\n');
    setupGraphMocks({ upstreamCount: 2 });

    const envelope = await gnReviewDiff(REPO_ID, { commitRange: 'HEAD~1..HEAD' });

    expect(envelope.envelopeVersion).toBe('1');
    expect(envelope.tool).toBe('gn_review_diff');
    expect(envelope.version).toBe(1);
    expect(envelope.results).toBeDefined();
    expect(envelope.results.resolvedRange).toBe('HEAD~1..HEAD');
    expect(envelope.results.summary).toMatchObject({
      totalChangedFiles: 1,
      emittedChangedFiles: 1,
      totalChangedSymbols: 1,
      emittedChangedSymbols: 1,
      detailTruncated: false,
      truncatedFileCount: 0,
      truncatedSymbolCount: 0,
    });
    expect(envelope.results.evidenceTrajectory).toMatchObject({
      tool: 'gn_review_diff',
      target: 'HEAD~1..HEAD',
      candidates: 1,
      curated: 1,
      pruned: 0,
      verification: 'verified',
      reasons: [],
    });
    expect(envelope.results.contextCost).toMatchObject({
      candidateItems: 1,
      emittedItems: 1,
      prunedItems: 0,
      summaryFirst: true,
      truncated: false,
      reasons: [],
    });
    expect(envelope.results.responseContract).toMatchObject({
      mode: 'summary-first',
      stablePrefix: 'repo-and-contract',
      deterministicOrder: true,
      expandable: false,
      anchorScheme: 'source-identity-v1',
      anchors: ['test-repo:src/foo.ts', 'test-repo:Function:src/foo.ts:doWork'],
    });
    expect(envelope.results.responseContract).not.toHaveProperty('omittedItems');
    expect(envelope.results.responseContract).not.toHaveProperty('expandHint');
    expect(envelope.results.contextCost.emittedChars).toBeGreaterThan(0);
    expect(envelope.results.reviewedFiles).toBeInstanceOf(Array);
    expect(envelope.results.totalSymbolsChanged).toBeGreaterThanOrEqual(0);
    expect(envelope.results.highRiskSymbols).toBeInstanceOf(Array);
    expect(envelope.results.affectedProcesses).toBeInstanceOf(Array);
    expect(envelope.results.affectedCommunities).toBeInstanceOf(Array);
    expect(envelope.capabilitiesUsed).toContain('git-diff');
    expect(envelope.capabilitiesUsed).toContain('graph-review');
    expect(envelope.capabilitiesUsed).toContain('blast-radius');
    expect(envelope.warnings).toBeInstanceOf(Array);
    expect(envelope.limits.maxChangedPaths).toBe(500);
    expect(envelope.limits).toMatchObject({
      summaryFirst: true,
      truncated: false,
      maxChangedFiles: 500,
      maxChangedSymbolsPerFile: 10,
      cursor: null,
    });
    expect(envelope.limits.budget).toMatchObject({
      maxCandidates: 500,
      emitted: 1,
      truncated: false,
      truncatedReasons: [],
      degradedReasons: [],
    });
    expect((envelope.limits.budget as { elapsedMs?: number }).elapsedMs).toBeGreaterThanOrEqual(0);
    const diffCall = mockExecFileSync.mock.calls.find((call) => call[1].includes('--name-only'));
    expect(diffCall?.[2]).toMatchObject({ cwd: '/repo' });
    expect(mockResolveTargetContext).toHaveBeenCalledWith({
      repo: REPO_ID,
      verifyGraphAuthority: true,
      requiredGraphCapabilities: ['symbols', 'impact', 'processes'],
    });
  });

  it('marks graph diagnostics advisory when manifest authority is unavailable', async () => {
    mockResolveTargetContext.mockResolvedValue({
      ...MOCK_TARGET_CONTEXT,
      graphAuthority: {
        state: 'degraded',
        reason: 'index manifest missing',
        coverage: 'unknown',
      },
    } as any);
    setupGitMocks('src/foo.ts\n', '5\t2\tsrc/foo.ts\n');
    setupGraphMocks({ upstreamCount: 2 });

    const envelope = await gnReviewDiff(REPO_ID, { commitRange: 'HEAD~1..HEAD' });

    expect(envelope.freshness).toMatchObject({
      status: 'degraded',
      actionable: false,
      graphAuthorityState: 'degraded',
    });
    expect(envelope.results.diagnostics.records).toContainEqual(
      expect.objectContaining({
        subject: 'changed symbols',
        authority: 'advisory',
        degraded: true,
      }),
    );
  });

  it.each([
    ['source mismatch', 'review', 'current source manifest does not match indexed manifest'],
    ['degraded coverage', 'degraded', 'indexed coverage is degraded'],
    ['missing capability', 'degraded', 'required graph capabilities unavailable: processes'],
  ] as const)('marks graph diagnostics advisory for %s', async (_label, state, reason) => {
    mockResolveTargetContext.mockResolvedValue({
      ...MOCK_TARGET_CONTEXT,
      graphAuthority: {
        state,
        reason,
        generationId: 'generation-1',
        manifestDigest: 'manifest-1',
        coverage: 'complete',
      },
    } as any);
    setupGitMocks('src/foo.ts\n', '5\t2\tsrc/foo.ts\n');
    setupGraphMocks({ upstreamCount: 2 });

    const envelope = await gnReviewDiff(REPO_ID, { commitRange: 'HEAD~1..HEAD' });

    expect(envelope.status).toBe('degraded');
    expect(envelope.freshness.actionable).toBe(false);
    expect(envelope.results.diagnostics.records).toContainEqual(
      expect.objectContaining({
        subject: 'changed symbols',
        authority: 'advisory',
        degraded: true,
      }),
    );
  });

  // ---- RD-2: scope 'branch' resolves to main...HEAD -----------------------
  it('uses the requested repository path when process cwd points at another repository', async () => {
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue('/repo-a');
    mockResolveTargetContext.mockResolvedValue({
      ...MOCK_TARGET_CONTEXT,
      repoPath: '/repo-b',
    } as any);
    setupGitMocks('src/foo.ts\n', '5\t2\tsrc/foo.ts\n');
    setupGraphMocks({ upstreamCount: 2 });

    try {
      await gnReviewDiff(REPO_ID, { commitRange: 'HEAD~1..HEAD' });
    } finally {
      cwdSpy.mockRestore();
    }

    expect(mockExecFileSync.mock.calls.some((call) => call[1].includes('--show-toplevel'))).toBe(
      false,
    );
    expect(
      mockExecFileSync.mock.calls
        .filter((call) => call[0] === 'git')
        .every((call) => (call[2] as { cwd?: string } | undefined)?.cwd === '/repo-b'),
    ).toBe(true);
  });

  // ---- RD-2: scope 'branch' resolves to main...HEAD -----------------------
  it("resolves scope 'branch' to main...HEAD", async () => {
    setupGitMocks('src/x.ts\n', '3\t1\tsrc/x.ts\n');
    setupGraphMocks({ upstreamCount: 0 });

    const envelope = await gnReviewDiff(REPO_ID, { scope: 'branch' });

    expect(envelope.results.resolvedRange).toBe('main...HEAD');
  });

  // ---- RD-3: scope 'staged' (default) resolves to --cached ----------------
  it('defaults to --cached when no commitRange or scope is given', async () => {
    setupGitMocks('src/y.ts\n', '1\t0\tsrc/y.ts\n');
    setupGraphMocks({ upstreamCount: 0 });

    const envelope = await gnReviewDiff(REPO_ID, {});

    expect(envelope.results.resolvedRange).toBe('--cached');
  });

  // ---- RD-4: empty diff returns empty results, status ok ------------------
  it('returns empty results and status ok for an empty diff', async () => {
    setupGitMocks('');
    mockExecute.mockResolvedValue([]);

    const envelope = await gnReviewDiff(REPO_ID, { commitRange: 'HEAD~1..HEAD' });

    expect(envelope.results.reviewedFiles).toHaveLength(0);
    expect(envelope.results.totalSymbolsChanged).toBe(0);
    expect(envelope.results.highRiskSymbols).toHaveLength(0);
    expect(envelope.status).toBe('ok');
    expect(envelope.warnings).toHaveLength(0);
  });

  // ---- RD-5: HIGH-risk symbol appears in results.highRiskSymbols ----------
  it('surfaces HIGH-risk symbols in results.highRiskSymbols', async () => {
    setupGitMocks('src/critical.ts\n', '80\t0\tsrc/critical.ts\n');
    setupGraphMocks({
      symbolRows: [{ id: 'Function:src/critical.ts:dispatch', name: 'dispatch' }],
      upstreamCount: 60, // > 50 → HIGH
    });

    const envelope = await gnReviewDiff(REPO_ID, { commitRange: 'main...HEAD' });

    expect(envelope.results.highRiskSymbols).toContain('dispatch');
    const sym = envelope.results.reviewedFiles[0].changedSymbols[0];
    expect(sym.impact.risk).toBe('HIGH');
  });

  // ---- RD-6: git diff failure surfaces warning, returns degraded ----------
  it('returns degraded status when git diff fails', async () => {
    mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes('--show-toplevel')) return '/repo\n';
      throw new Error('not a git repository');
    });
    mockExecute.mockResolvedValue([]);

    const envelope = await gnReviewDiff(REPO_ID, { commitRange: 'HEAD~1..HEAD' });

    expect(envelope.warnings.some((w) => w.includes('git diff failed'))).toBe(true);
    expect(envelope.status).toBe('degraded');
    expect(envelope.limits.budget).toMatchObject({
      emitted: 0,
      truncated: false,
      degradedReasons: ['git-diff-name-only-failed'],
    });
  });

  it('caps changed paths with deterministic budget metadata', () => {
    const capped = applyChangedPathLimitForReview(['src/a.ts', 'src/b.ts', 'src/c.ts'], 2);

    expect(capped).toMatchObject({
      changedPaths: ['src/a.ts', 'src/b.ts'],
      warning: 'Changed file scan capped at 2 paths',
      truncated: true,
    });
  });

  it('filters gnDiffImpact to includePaths and warns about omitted ambient files', async () => {
    setupGitMocks('src/api.ts\ndocs/note.md\n', '5\t1\tsrc/api.ts\n1\t0\tdocs/note.md\n');
    setupGraphMocks({
      symbolRows: [{ id: 'Function:src/api.ts:handleReq', name: 'handleReq' }],
      upstreamCount: 2,
    });

    const report = await gnDiffImpact(REPO_ID, {
      commitRange: 'HEAD~1..HEAD',
      includePaths: ['src'],
    });

    expect(report.changedFiles).toHaveLength(1);
    expect(report.changedFiles[0].path).toBe('src/api.ts');
    expect(report.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Omitted 1 changed file outside includePaths (src): docs/note.md'),
      ]),
    );
  });

  it('reports response-local evidence pruning metadata when review output is capped', async () => {
    const paths = Array.from({ length: 501 }, (_, index) => `src/file-${index}.ts`).join('\n');
    setupGitMocks(`${paths}\n`, '');
    setupGraphMocks({ upstreamCount: 0 });

    const envelope = await gnReviewDiff(REPO_ID, { commitRange: 'main...HEAD' });

    expect(envelope.results.evidenceTrajectory).toMatchObject({
      tool: 'gn_review_diff',
      target: 'main...HEAD',
      candidates: 500,
      curated: 500,
      pruned: 0,
      verification: 'partial',
      reasons: ['changed-path-cap'],
    });
    expect(envelope.results.contextCost).toMatchObject({
      candidateItems: 500,
      emittedItems: 500,
      prunedItems: 0,
      summaryFirst: true,
      truncated: true,
      reasons: ['changed-path-cap'],
    });
    expect(envelope.results.responseContract).toMatchObject({
      expandable: true,
      omittedItems: 1,
    });
    expect(envelope.results.responseContract.expandHint).toContain('narrower commit range');
    expect(envelope.results.responseContract.anchors[0]).toBe('test-repo:src/file-0.ts');
    expect(envelope.results.contextCost.emittedChars).toBeGreaterThan(0);
    expect(envelope.warnings).toContain('Changed file scan capped at 500 paths');
  });

  it('filters gnReviewDiff to includePaths and warns about omitted ambient files', async () => {
    setupGitMocks('src/x.ts\ndocs/note.md\n', '3\t1\tsrc/x.ts\n1\t0\tdocs/note.md\n');
    setupGraphMocks({
      symbolRows: [{ id: 'Function:src/x.ts:run', name: 'run' }],
      upstreamCount: 1,
    });

    const envelope = await gnReviewDiff(REPO_ID, {
      commitRange: 'HEAD~1..HEAD',
      includePaths: ['src'],
    });

    expect(envelope.results.reviewedFiles).toHaveLength(1);
    expect(envelope.results.reviewedFiles[0].path).toBe('src/x.ts');
    expect(envelope.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Omitted 1 changed file outside includePaths (src): docs/note.md'),
      ]),
    );
  });

  // ---- RD-7: does not include reviewers (separate from gn_diff_impact) ----
  it('does not include suggestedReviewers in results', async () => {
    setupGitMocks('src/api.ts\n', '10\t2\tsrc/api.ts\n', 'Alice\nBob\n');
    setupGraphMocks({ upstreamCount: 1 });

    const envelope = await gnReviewDiff(REPO_ID, { commitRange: 'HEAD~1..HEAD' });

    expect((envelope.results as Record<string, unknown>).suggestedReviewers).toBeUndefined();
  });

  // ---- RD-8: freshness and targetContext are present ----------------------
  it('includes freshness and targetContext in the envelope', async () => {
    setupGitMocks('src/mod.ts\n', '2\t1\tsrc/mod.ts\n');
    setupGraphMocks({ upstreamCount: 1 });

    const envelope = await gnReviewDiff(REPO_ID, { commitRange: 'HEAD~1..HEAD' });

    expect(envelope.freshness).toBeDefined();
    expect(envelope.freshness.status).toBeDefined();
    expect(envelope.targetContext).toBeDefined();
  });
});
