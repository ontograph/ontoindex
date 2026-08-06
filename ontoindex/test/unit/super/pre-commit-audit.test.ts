/**
 * Unit tests: gnPreCommitAudit
 *
 * All external I/O (child_process, pool-adapter) is mocked via vi.mock.
 * No real git process or LadybugDB connection is used.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs/promises';

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

vi.mock('../../../src/storage/git.js', () => ({
  resolveBranchComparisonBase: vi.fn(() => ({
    ref: 'main',
    commit: 'base123',
    range: 'main...HEAD',
    source: 'main',
  })),
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

/** Make execFileSync return a given diff output. */
function setupGitDiff(
  diffOutput: string,
  reviewerOutput = '',
  patchOutput = '',
  untrackedOutput = '',
) {
  mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
    if (args.includes('--show-toplevel')) return '/repo\n';
    if (args.includes('--others') && args.includes('--exclude-standard')) return untrackedOutput;
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
      graphAuthority: {
        state: 'authoritative',
        reason: 'current source manifest matches indexed generation',
        generationId: 'graph-index-1',
        manifestDigest: 'manifest-1',
        coverage: 'complete',
      },
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
    expect(mockResolveTargetContext).toHaveBeenCalledWith({
      repo: REPO_ID,
      verifyGraphAuthority: true,
      requiredGraphCapabilities: ['symbols', 'impact', 'processes'],
    });
    const diffCall = mockExecFileSync.mock.calls.find((call) => call[1].includes('--name-only'));
    expect(diffCall?.[2]).toMatchObject({ cwd: '/repo' });
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
    expect(report.preCommitChecklist.find((c) => c.check === 'staged diff non-empty')!.state).toBe(
      'PASS',
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
      true,
    );
    expect(report.preCommitChecklist.find((c) => c.check === 'staged diff non-empty')!.state).toBe(
      'SKIPPED',
    );
  });

  it('does not execute git when the explicit repository cannot be resolved', async () => {
    mockResolveTargetContext.mockResolvedValue({
      version: 1,
      status: 'not-found',
      targetRef: 'HEAD',
      dirtyWorktree: null,
      changedSinceIndex: null,
      snapshotMode: 'unknown',
      qualityMode: 'balanced',
      embeddings: { status: 'unknown' },
      lsp: { status: 'unknown' },
      sidecar: { status: 'unknown' },
      policy: { status: 'unknown' },
      action: 'Repository "missing" is not indexed.',
      warnings: [],
    });

    const report = await gnPreCommitAudit('missing', { scope: 'staged' });

    expect(report.verdict).toBe('DO-NOT-COMMIT');
    expect(report.reasoning).toContain('could not be resolved');
    expect(mockExecFileSync).not.toHaveBeenCalled();
    expect(report.preCommitChecklist).toContainEqual(
      expect.objectContaining({ check: 'repository resolved', state: 'FAIL' }),
    );
  });

  it('uses the requested repository path when process cwd points at another repository', async () => {
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue('/repo-a');
    mockResolveTargetContext.mockResolvedValue({
      version: 1,
      status: 'ok',
      repoKey: REPO_ID,
      repoPath: '/repo-b',
      branch: 'main',
      targetRef: 'HEAD',
      targetHead: 'abc123',
      currentHead: 'abc123',
      indexedHead: 'abc123',
      graphAuthority: {
        state: 'authoritative',
        reason: 'current source manifest matches indexed generation',
        generationId: 'graph-index-1',
        manifestDigest: 'manifest-1',
        coverage: 'complete',
      },
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
    setupGitDiff('src/foo.ts\n');
    setupGraphMocks({ upstreamCount: 3 });

    try {
      await gnPreCommitAudit(REPO_ID, { scope: 'staged' });
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

  it('returns READY for an authoritative dirty source snapshot', async () => {
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
      graphAuthority: {
        state: 'authoritative',
        reason: 'current source manifest matches indexed generation',
        generationId: 'graph-index-1',
        manifestDigest: 'manifest-1',
        coverage: 'complete',
      },
      dirtyWorktree: true,
      dirtyFileCount: 1,
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
    expect(report.freshness).toMatchObject({ status: 'fresh', actionable: true });
    expect(report.capabilitiesMissing).not.toContain('clean-worktree');
    expect(report.warnings).toContain('Audit target context includes a dirty worktree overlay.');
  });

  it('returns REVIEW for a legacy dirty index without manifest authority', async () => {
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
      dirtyWorktree: true,
      dirtyFileCount: 1,
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

    expect(report.verdict).toBe('REVIEW');
    expect(report.freshness).toMatchObject({ status: 'degraded', actionable: false });
    expect(report.preCommitChecklist).toContainEqual(
      expect.objectContaining({ check: 'graph authority established', state: 'DEGRADED' }),
    );
  });

  it('filters gnPreCommitAudit to includePaths and warns about omitted ambient files', async () => {
    setupGitDiff('src/foo.ts\ndocs/note.md\n');
    setupGraphMocks({ upstreamCount: 3 });

    const report = await gnPreCommitAudit(REPO_ID, {
      scope: 'staged',
      includePaths: ['src'],
    });

    expect(report.verdict).toBe('READY');
    expect(report.changedFiles).toHaveLength(1);
    expect(report.changedFiles[0].path).toBe('src/foo.ts');
    expect(report.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Omitted 1 changed file outside includePaths (src): docs/note.md'),
      ]),
    );
  });

  it.each(['all', 'unstaged'] as const)('includes untracked files for %s scope', async (scope) => {
    setupGitDiff('src/tracked.ts\n', '', '', 'src/untracked.ts\n');
    setupGraphMocks({ upstreamCount: 3 });

    const report = await gnPreCommitAudit(REPO_ID, { scope });

    expect(report.changedFiles.map((file) => file.path)).toEqual([
      'src/tracked.ts',
      'src/untracked.ts',
    ]);
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'git',
      ['ls-files', '--others', '--exclude-standard'],
      expect.objectContaining({ cwd: '/repo' }),
    );
  });

  it('keeps staged scope limited to the index', async () => {
    setupGitDiff('src/staged.ts\n', '', '', 'src/untracked.ts\n');
    setupGraphMocks({ upstreamCount: 3 });

    const report = await gnPreCommitAudit(REPO_ID, { scope: 'staged' });

    expect(report.changedFiles.map((file) => file.path)).toEqual(['src/staged.ts']);
    expect(
      mockExecFileSync.mock.calls.some(
        (call) => call[1].includes('--others') && call[1].includes('--exclude-standard'),
      ),
    ).toBe(false);
  });

  it('applies includePaths after merging tracked and untracked files', async () => {
    setupGitDiff('docs/tracked.md\n', '', '', 'src/untracked.ts\n');
    setupGraphMocks({ upstreamCount: 3 });

    const report = await gnPreCommitAudit(REPO_ID, {
      scope: 'all',
      includePaths: ['src'],
    });

    expect(report.changedFiles.map((file) => file.path)).toEqual(['src/untracked.ts']);
    expect(report.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          'Omitted 1 changed file outside includePaths (src): docs/tracked.md',
        ),
      ]),
    );
  });

  it('blocks commit when untracked-file enumeration fails', async () => {
    mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes('--name-only')) return 'src/tracked.ts\n';
      if (args.includes('--others')) throw new Error('untracked scan unavailable');
      return '';
    });

    const report = await gnPreCommitAudit(REPO_ID, { scope: 'all' });

    expect(report.verdict).toBe('DO-NOT-COMMIT');
    expect(report.reasoning).toContain('changed-path scan failed');
    expect(report.warnings).toContain('git changed-path scan failed: untracked scan unavailable');
    expect(report.preCommitChecklist).toContainEqual(
      expect.objectContaining({ check: 'git diff reachable', state: 'FAIL' }),
    );
  });

  it('returns READY with an explicit no in-scope changes message when includePaths omit all dirty files', async () => {
    setupGitDiff('docs/note.md\n');
    mockExecute.mockResolvedValue([]);

    const report = await gnPreCommitAudit(REPO_ID, {
      scope: 'staged',
      includePaths: ['src'],
    });

    expect(report.verdict).toBe('READY');
    expect(report.changedFiles).toHaveLength(0);
    expect(report.reasoning).toContain('No in-scope changes to audit');
    expect(report.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Omitted 1 changed file outside includePaths (src): docs/note.md'),
      ]),
    );
    expect(report.preCommitChecklist.find((c) => c.check === 'staged diff non-empty')?.detail).toBe(
      'no in-scope changes',
    );
    expect(report.preCommitChecklist.find((c) => c.check === 'staged diff non-empty')?.state).toBe(
      'SKIPPED',
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
    expect(
      mockExecFileSync.mock.calls.some(
        (call) => call[1].includes('--others') && call[1].includes('--exclude-standard'),
      ),
    ).toBe(false);
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
    expect(report.warnings.some((w) => w.includes('git changed-path scan failed'))).toBe(true);
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
    expect(report.warnings.some((w) => w.includes('git changed-path scan failed'))).toBe(true);
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

  it('returns REVIEW when required graph evidence is not authoritative', async () => {
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
      graphAuthority: {
        state: 'review',
        reason: 'current source manifest does not match indexed manifest',
        generationId: 'graph-index-1',
        manifestDigest: 'manifest-1',
        coverage: 'complete',
      },
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

    expect(report.verdict).toBe('REVIEW');
    expect(report.status).toBe('degraded');
    expect(report.freshness.status).toBe('stale');
    expect(report.capabilitiesMissing).toContain('fresh-index');
    expect(report.warnings.some((warning) => warning.includes('Audit freshness stale'))).toBe(true);
    expect(
      report.preCommitChecklist.find((c) => c.check === 'graph authority established')?.state,
    ).toBe('DEGRADED');
  });

  it('skips only an absent boundary-rules file', async () => {
    setupGitDiff('src/foo.ts\n');
    setupGraphMocks({ upstreamCount: 3 });

    const report = await gnPreCommitAudit(REPO_ID, { scope: 'staged' });

    expect(report.verdict).toBe('READY');
    expect(report.preCommitChecklist.find((c) => c.check === 'boundary rules')).toMatchObject({
      state: 'SKIPPED',
      passed: true,
    });
  });

  it('blocks commit when the boundary-rules file cannot be read', async () => {
    setupGitDiff('src/foo.ts\n');
    setupGraphMocks({ upstreamCount: 3 });
    const readFile = vi
      .spyOn(fs, 'readFile')
      .mockRejectedValueOnce(Object.assign(new Error('permission denied'), { code: 'EACCES' }));

    try {
      const report = await gnPreCommitAudit(REPO_ID, { scope: 'staged' });

      expect(report.verdict).toBe('DO-NOT-COMMIT');
      expect(report.preCommitChecklist.find((c) => c.check === 'boundary rules')).toMatchObject({
        state: 'FAIL',
        passed: false,
      });
      expect(report.reasoning).toContain('could not be read');
    } finally {
      readFile.mockRestore();
    }
  });
});
