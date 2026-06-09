/**
 * Unit tests: gnPreCommitAudit
 *
 * All external I/O (child_process, pool-adapter) is mocked via vi.mock.
 * No real git process or LadybugDB connection is used.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — must be declared before the module under test is imported.
// vi.mock factories are hoisted, so variables used inside must be defined
// with vi.fn() inline rather than referencing outer const declarations.
// ---------------------------------------------------------------------------

vi.mock('child_process', () => ({
  execFileSync: vi.fn(),
}));

vi.mock('../../../src/core/lbug/pool-adapter.js', () => ({
  executeParameterized: vi.fn(),
}));

vi.mock('../../../src/mcp/shared/target-context.js', () => ({
  resolveTargetContext: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks).
// ---------------------------------------------------------------------------

import { execFileSync } from 'child_process';
import { executeParameterized } from '../../../src/core/lbug/pool-adapter.js';
import { resolveTargetContext } from '../../../src/mcp/shared/target-context.js';
import { gnPreCommitAudit } from '../../../src/mcp/super/pre-commit-audit.js';

const mockExecFileSync = vi.mocked(execFileSync);
const mockExecute = vi.mocked(executeParameterized);
const mockResolveTargetContext = vi.mocked(resolveTargetContext);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const REPO_ID = 'test-repo';

/** Make execFileSync return a given diff output. The first call is for
 * git rev-parse --show-toplevel (repoRoot), the second for git diff. */
function setupGitDiff(diffOutput: string, reviewerOutput = '', patchOutput = '') {
  mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
    if (args.includes('--show-toplevel')) return '/repo\n';
    if (args.includes('--name-only')) return diffOutput;
    if (args.includes('--unified=0')) return patchOutput;
    if (args.includes('--format=%aN')) return reviewerOutput;
    return '';
  });
}

/** Make executeParameterized return sensible defaults for all sub-queries. */
function setupGraphMocks(
  options: {
    symbolRows?: any[];
    upstreamCount?: number;
    downstreamCount?: number;
    testFileRows?: any[];
    processRows?: any[];
  } = {},
) {
  const {
    symbolRows = [{ id: 'Function:src/foo.ts:doWork', name: 'doWork', kind: 'Function' }],
    upstreamCount = 3,
    downstreamCount = 1,
    testFileRows = [],
    processRows = [],
  } = options;

  mockExecute.mockImplementation(async (_repoId: string, cypher: string, _params: any) => {
    if (cypher.includes("type: 'DEFINES'")) {
      return symbolRows;
    }
    if (cypher.includes('count(*)') && cypher.includes('CALLS') && cypher.includes('caller')) {
      return [{ count: upstreamCount }];
    }
    if (cypher.includes('count(*)') && cypher.includes('CALLS') && cypher.includes('callee')) {
      return [{ count: downstreamCount }];
    }
    if (cypher.includes("type: 'IMPORTS'") && cypher.includes('test')) {
      return testFileRows;
    }
    if (cypher.includes("type: 'STEP_IN_PROCESS'")) {
      return processRows;
    }
    return [];
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('gnPreCommitAudit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveTargetContext.mockResolvedValue({
      version: 1,
      status: 'ok',
      repoKey: 'test-repo',
      repoPath: '/repo',
      branch: 'main',
      targetRef: 'HEAD',
      targetHead: 'abc123',
      currentHead: 'abc123',
      indexedHead: 'abc123',
      dirtyWorktree: false,
      changedSinceIndex: false,
      snapshotMode: 'committed-head',
      qualityMode: 'balanced',
      embeddings: { status: 'available' },
      lsp: { status: 'unknown' },
      sidecar: { status: 'unknown' },
      policy: { status: 'unknown' },
      warnings: [],
    });
  });

  // ---- Test 1: READY for clean staged diff with no unexpected symbols -----
  it('returns READY for a clean staged diff with no unexpected symbols', async () => {
    setupGitDiff('src/foo.ts\n');
    setupGraphMocks({ upstreamCount: 3 });

    const report = await gnPreCommitAudit(REPO_ID, { scope: 'staged' });

    expect(report.version).toBe(1);
    expect(report.verdict).toBe('READY');
    expect(report.changedFiles).toHaveLength(1);
    expect(report.changedFiles[0].path).toBe('src/foo.ts');
    expect(report.changedFiles[0].perSymbolImpact.risk).toBe('LOW');
    expect(report.unexpectedSymbols).toHaveLength(0);
    expect(report.status).toBe('ok');
    expect(report.freshness.status).toBe('fresh');
    expect(Array.isArray(report.evidence)).toBe(true);
    expect(Array.isArray(report.recommendations)).toBe(true);
    expect(report.capabilitiesMissing).toEqual([]);
    expect(report.preCommitChecklist.find((c) => c.check === 'staged diff non-empty')!.passed).toBe(
      true,
    );
    expect(report.preCommitChecklist.find((c) => c.check === 'no HIGH-risk symbols')!.passed).toBe(
      true,
    );
  });

  it('includes basedOnReads summary and preserves organic verdict even if stale', async () => {
    setupGitDiff('src/foo.ts\n');
    setupGraphMocks({ upstreamCount: 3 });

    // Inject a "stale" event into the ledger
    const { recordEvidenceReadSafe, resetEvidenceReadLedgerForTests } =
      await import('../../../src/core/runtime/evidence-read-ledger.js');
    resetEvidenceReadLedgerForTests();
    recordEvidenceReadSafe({
      readClass: 'graph_evidence',
      surface: 'mcp',
      target: 'stale-symbol',
      targetType: 'symbol',
      memoryFreshness: 'stale-index',
    });

    const report = await gnPreCommitAudit(REPO_ID, { scope: 'staged' });

    expect(report.verdict).toBe('READY'); // Organic verdict remains READY
    expect(report.basedOnReads).toBeDefined();
    expect(report.basedOnReads!.stale).toBe(true);
    expect(report.basedOnReads!.graph_evidence).toBeGreaterThan(0);
    expect(report.basedOnReads!.details?.staleSurfaces).toContain('mcp');
  });

  // ---- Test 2: REVIEW when expectedSymbols differs from actual -----------
  it('returns REVIEW when changed symbols contain unexpected entries', async () => {
    setupGitDiff('src/auth.ts\n');
    setupGraphMocks({
      symbolRows: [
        { id: 'Function:src/auth.ts:parseToken', name: 'parseToken', kind: 'Function' },
        { id: 'Function:src/auth.ts:verifyJwt', name: 'verifyJwt', kind: 'Function' },
      ],
      upstreamCount: 5,
    });

    const report = await gnPreCommitAudit(REPO_ID, {
      scope: 'staged',
      expectedSymbols: ['parseToken'], // verifyJwt is unexpected
    });

    expect(report.verdict).toBe('REVIEW');
    expect(report.unexpectedSymbols).toContain('verifyJwt');
    expect(report.unexpectedSymbols).not.toContain('parseToken');
    expect(report.reasoning).toContain('unexpected symbols');
    expect(report.recommendations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: 'review-unexpected-scope',
          target: expect.objectContaining({ name: 'verifyJwt' }),
          evidenceClasses: expect.arrayContaining(['graph_evidence']),
        }),
      ]),
    );
    const evidenceIds = new Set(report.evidence.map((entry) => entry.id));
    for (const recommendation of report.recommendations) {
      expect(recommendation.evidenceIds.length).toBeGreaterThan(0);
      for (const evidenceId of recommendation.evidenceIds) {
        expect(evidenceIds.has(evidenceId)).toBe(true);
      }
    }
    expect(
      report.preCommitChecklist.find((c) => c.check === 'symbols match expected scope')!.passed,
    ).toBe(false);
  });

  // ---- Test 3: DO-NOT-COMMIT for HIGH-risk symbol change -----------------
  it('returns DO-NOT-COMMIT when a changed symbol has HIGH upstream impact', async () => {
    setupGitDiff('src/core/engine.ts\n');
    setupGraphMocks({
      symbolRows: [{ id: 'Class:src/core/engine.ts:Engine', name: 'Engine', kind: 'Class' }],
      upstreamCount: 75, // > 50 → HIGH
      processRows: [
        { pid: 'proc-1', name: 'dispatchSuper', processType: 'function', changedStepCount: 1 },
      ],
    });

    const report = await gnPreCommitAudit(REPO_ID, { scope: 'staged' });

    expect(report.verdict).toBe('DO-NOT-COMMIT');
    expect(report.changedFiles[0].perSymbolImpact.risk).toBe('HIGH');
    expect(report.reasoning).toContain('HIGH-risk');
    expect(report.affectedProcesses).toEqual([
      { id: 'proc-1', name: 'dispatchSuper', processType: 'function', changedStepCount: 1 },
    ]);
    expect(report.recommendations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: 'review-high-risk-change',
          target: expect.objectContaining({ name: 'src/core/engine.ts' }),
          evidenceClasses: expect.arrayContaining(['graph_evidence']),
          nextTools: expect.arrayContaining(['gn_review_diff', 'gn_verify_diff']),
        }),
      ]),
    );
    expect(report.preCommitChecklist.find((c) => c.check === 'no HIGH-risk symbols')!.passed).toBe(
      false,
    );
  });

  // ---- Test 4: Empty diff returns empty changedFiles + READY -------------
  it('returns READY with empty changedFiles when diff is empty', async () => {
    setupGitDiff(''); // no files changed
    // executeParameterized should not be called
    mockExecute.mockResolvedValue([]);

    const report = await gnPreCommitAudit(REPO_ID, { scope: 'staged' });

    expect(report.verdict).toBe('READY');
    expect(report.changedFiles).toHaveLength(0);
    expect(report.reasoning).toContain('No staged changes');
    expect(mockExecute).not.toHaveBeenCalled();
    expect(report.preCommitChecklist.find((c) => c.check === 'staged diff non-empty')!.passed).toBe(
      false,
    );
  });

  // ---- Test 5: scope 'branch' uses main...HEAD git diff args -------------
  it("uses 'main...HEAD' args when scope is 'branch'", async () => {
    setupGitDiff('src/utils.ts\n');
    setupGraphMocks({ upstreamCount: 1 });

    await gnPreCommitAudit(REPO_ID, { scope: 'branch' });

    // Find the git diff call (not the rev-parse or log calls)
    const diffCall = mockExecFileSync.mock.calls.find((call) => call[1].includes('--name-only'));
    expect(diffCall).toBeDefined();
    expect(diffCall![1]).toContain('main...HEAD');
    expect(diffCall![1]).not.toContain('--cached');
  });

  // ---- Test 6: git diff failure blocks commit ----------------------------
  it('returns DO-NOT-COMMIT when git diff throws', async () => {
    mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes('--show-toplevel')) return '/repo\n';
      throw new Error('not a git repository');
    });
    mockExecute.mockResolvedValue([]);

    const report = await gnPreCommitAudit(REPO_ID, { scope: 'staged' });

    expect(report.verdict).toBe('DO-NOT-COMMIT');
    expect(report.changedFiles).toHaveLength(0);
    expect(report.warnings.some((w) => w.includes('git diff failed'))).toBe(true);
    expect(report.preCommitChecklist.find((c) => c.check === 'git diff reachable')!.passed).toBe(
      false,
    );
  });

  it('returns DO-NOT-COMMIT when git diff times out', async () => {
    mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes('--show-toplevel')) return '/repo\n';
      const err = Object.assign(new Error('spawnSync git ETIMEDOUT'), { code: 'ETIMEDOUT' });
      throw err;
    });
    mockExecute.mockResolvedValue([]);

    const report = await gnPreCommitAudit(REPO_ID, { scope: 'staged' });

    expect(report.verdict).toBe('DO-NOT-COMMIT');
    expect(report.reasoning).toContain('cannot audit');
    expect(report.preCommitChecklist.find((c) => c.check === 'git diff reachable')!.passed).toBe(
      false,
    );
  });

  it('returns DO-NOT-COMMIT when git diff exceeds maxBuffer', async () => {
    mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes('--show-toplevel')) return '/repo\n';
      const err = Object.assign(new Error('stdout maxBuffer length exceeded'), { code: 'ENOBUFS' });
      throw err;
    });
    mockExecute.mockResolvedValue([]);

    const report = await gnPreCommitAudit(REPO_ID, { scope: 'staged' });

    expect(report.verdict).toBe('DO-NOT-COMMIT');
    expect(report.warnings.some((w) => w.includes('git diff failed'))).toBe(true);
    expect(report.preCommitChecklist.find((c) => c.check === 'git diff reachable')!.passed).toBe(
      false,
    );
  });

  it('returns REVIEW when changed path scan is capped', async () => {
    const files = Array.from({ length: 501 }, (_, i) => `src/file-${i}.ts`).join('\n') + '\n';
    setupGitDiff(files);
    setupGraphMocks({ upstreamCount: 1 });

    const report = await gnPreCommitAudit(REPO_ID, { scope: 'staged' });

    expect(report.verdict).toBe('REVIEW');
    expect(report.changedFiles).toHaveLength(500);
    expect(report.reasoning).toContain('changed file scan capped');
    expect(report.warnings).toContain('Changed file scan capped at 500 paths');
    expect(
      report.preCommitChecklist.find((c) => c.check === 'changed file scan complete')!.passed,
    ).toBe(false);
  });

  it('returns REVIEW when graph symbol lookup fails', async () => {
    setupGitDiff('src/foo.ts\n');
    mockExecute.mockRejectedValue(new Error('LadybugDB not initialized'));

    const report = await gnPreCommitAudit(REPO_ID, { scope: 'staged' });

    expect(report.verdict).toBe('REVIEW');
    expect(report.reasoning).toContain('graph audit incomplete');
    expect(report.warnings.some((w) => w.includes('graph query failed for src/foo.ts'))).toBe(true);
    expect(report.warnings.some((w) => w.includes('test coverage graph query failed'))).toBe(true);
    expect(report.preCommitChecklist.find((c) => c.check === 'graph audit complete')!.passed).toBe(
      false,
    );
  });

  it('returns REVIEW when upstream or downstream impact queries fail', async () => {
    setupGitDiff('src/foo.ts\n');
    mockExecute.mockImplementation(async (_repoId: string, cypher: string, _params: any) => {
      if (cypher.includes("type: 'DEFINES'")) {
        return [{ id: 'Function:src/foo.ts:doWork', name: 'doWork', kind: 'Function' }];
      }
      if (cypher.includes('count(*)') && cypher.includes('CALLS')) {
        throw new Error('impact query unavailable');
      }
      return [];
    });

    const report = await gnPreCommitAudit(REPO_ID, { scope: 'staged' });

    expect(report.verdict).toBe('REVIEW');
    expect(report.reasoning).toContain('graph audit incomplete');
    expect(
      report.warnings.some((w) => w.includes('upstream impact graph query failed for doWork')),
    ).toBe(true);
    expect(
      report.warnings.some((w) => w.includes('downstream impact graph query failed for doWork')),
    ).toBe(true);
    expect(report.preCommitChecklist.find((c) => c.check === 'graph audit complete')!.passed).toBe(
      false,
    );
  });

  // ---- Test 7: MEDIUM risk symbol does not trigger DO-NOT-COMMIT ---------
  it('returns READY for MEDIUM-risk symbol (10-50 upstream callers)', async () => {
    setupGitDiff('src/helpers.ts\n');
    setupGraphMocks({ upstreamCount: 25 }); // 10-50 → MEDIUM

    const report = await gnPreCommitAudit(REPO_ID, { scope: 'staged' });

    expect(report.verdict).toBe('READY');
    expect(report.changedFiles[0].perSymbolImpact.risk).toBe('MEDIUM');
  });

  it('audits only symbols overlapping changed diff lines when line spans are indexed', async () => {
    setupGitDiff(
      'src/mixed.ts\n',
      '',
      [
        'diff --git a/src/mixed.ts b/src/mixed.ts',
        '--- a/src/mixed.ts',
        '+++ b/src/mixed.ts',
        '@@ -20,0 +21,2 @@',
        '+const touched = true;',
        '+doSmallThing();',
      ].join('\n'),
    );
    mockExecute.mockImplementation(async (_repoId: string, cypher: string, params: any) => {
      if (cypher.includes("type: 'DEFINES'")) {
        return [
          {
            id: 'Function:src/mixed.ts:doLargeThing',
            name: 'doLargeThing',
            startLine: 100,
            endLine: 140,
          },
          {
            id: 'Function:src/mixed.ts:doSmallThing',
            name: 'doSmallThing',
            startLine: 18,
            endLine: 24,
          },
        ];
      }
      if (cypher.includes('count(*)') && cypher.includes('caller')) {
        return [{ count: params.id.includes('doLargeThing') ? 75 : 3 }];
      }
      if (cypher.includes('count(*)') && cypher.includes('callee')) {
        return [{ count: 1 }];
      }
      return [];
    });

    const report = await gnPreCommitAudit(REPO_ID, { scope: 'staged' });

    expect(report.verdict).toBe('READY');
    expect(report.changedFiles[0].changedSymbols).toEqual(['doSmallThing']);
    expect(report.changedFiles[0].perSymbolImpact.risk).toBe('LOW');
  });

  it('falls back to file-level symbol audit when diff hunks are unavailable', async () => {
    mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes('--show-toplevel')) return '/repo\n';
      if (args.includes('--name-only')) return 'src/foo.ts\n';
      if (args.includes('--unified=0')) throw new Error('patch unavailable');
      if (args.includes('--format=%aN')) return '';
      return '';
    });
    setupGraphMocks({ upstreamCount: 3 });

    const report = await gnPreCommitAudit(REPO_ID, { scope: 'staged' });

    expect(report.verdict).toBe('READY');
    expect(report.changedFiles[0].changedSymbols).toEqual(['doWork']);
    expect(report.warnings.some((w) => w.includes('falling back to file-level symbol audit'))).toBe(
      true,
    );
    expect(report.graphSections.hunkCoverageAvailable).toBe(false);
  });

  it('surfaces degraded freshness state additively without changing verdict compatibility', async () => {
    mockResolveTargetContext.mockResolvedValue({
      version: 1,
      status: 'ok',
      repoKey: 'test-repo',
      repoPath: '/repo',
      branch: 'main',
      targetRef: 'HEAD',
      targetHead: 'def456',
      currentHead: 'def456',
      indexedHead: 'abc123',
      dirtyWorktree: true,
      changedSinceIndex: true,
      snapshotMode: 'dirty-worktree-overlay',
      qualityMode: 'balanced',
      embeddings: { status: 'available' },
      lsp: { status: 'unknown' },
      sidecar: { status: 'unknown' },
      policy: { status: 'unknown' },
      warnings: [],
    });
    setupGitDiff('src/foo.ts\n');
    setupGraphMocks({ upstreamCount: 3 });

    const report = await gnPreCommitAudit(REPO_ID, { scope: 'staged' });

    expect(report.verdict).toBe('READY');
    expect(report.status).toBe('degraded');
    expect(report.freshness.status).toBe('stale');
    expect(report.capabilitiesMissing).toContain('fresh-index');
    expect(report.warnings.some((warning) => warning.includes('Audit freshness stale'))).toBe(true);
  });
});
