/**
 * Unit tests for gn_can_delete super-function (Phase 2 W2b).
 *
 * All external primitives are mocked so tests run without a live DB.
 */

import { afterEach, describe, it, expect, vi, beforeEach } from 'vitest';

afterEach(() => vi.unstubAllEnvs());

// ---------------------------------------------------------------------------
// Mocks — must be declared before the import under test.
// ---------------------------------------------------------------------------

vi.mock('../../../src/core/lbug/pool-adapter.js', () => ({
  executeParameterized: vi.fn(),
}));

vi.mock('../../../src/mcp/super/_helpers/test-coverage.js', () => ({
  findTestFiles: vi.fn(),
}));

vi.mock('../../../src/core/process/exec-file.js', () => ({
  execFileText: vi.fn(),
}));

vi.mock('../../../src/storage/git.js', () => ({
  getCurrentCommit: vi.fn(),
}));

vi.mock('../../../src/storage/repo-manager.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/storage/repo-manager.js')>()),
  getStoragePaths: vi.fn(() => ({ storagePath: '/repo/.ontoindex' })),
  listRegisteredRepos: vi.fn(),
  loadMeta: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks).
// ---------------------------------------------------------------------------

import { executeParameterized } from '../../../src/core/lbug/pool-adapter.js';
import { findTestFiles } from '../../../src/mcp/super/_helpers/test-coverage.js';
import { execFileText } from '../../../src/core/process/exec-file.js';
import { getCurrentCommit } from '../../../src/storage/git.js';
import { listRegisteredRepos, loadMeta, type RepoMeta } from '../../../src/storage/repo-manager.js';
import { gnCanDelete } from '../../../src/mcp/super/can-delete.js';
import { dispatchSuper } from '../../../src/mcp/super/dispatch.js';
import { dispatchFacade } from '../../../src/mcp/facade/dispatch.js';
import { attachRepoScopeIdentity } from '../../../src/mcp/shared/response-envelope.js';
import type { LocalBackend } from '../../../src/mcp/local/local-backend.js';

// Typed mock handles.
const mockExecuteParameterized = executeParameterized as unknown as ReturnType<typeof vi.fn>;
const mockFindTestFiles = findTestFiles as unknown as ReturnType<typeof vi.fn>;
const mockExecFileText = vi.mocked(execFileText);
const mockGetCurrentCommit = vi.mocked(getCurrentCommit);
const mockListRegisteredRepos = vi.mocked(listRegisteredRepos);
const mockLoadMeta = vi.mocked(loadMeta);

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

const REPO_ID = 'test-repo';

const COMPLETE_META: RepoMeta = {
  repoPath: '/repo',
  lastCommit: 'abc123',
  indexedAt: '2026-07-25T00:00:00.000Z',
  pipelineProfile: 'full',
  sourceManifest: {
    version: 1,
    head: 'abc123',
    sourceDigest: 'source',
    sourceEntryCount: 2,
    includePaths: [],
    scopeDigest: 'scope',
    ignorePolicyDigest: 'ignore',
    pipelineProfile: 'full',
    analyzerContractVersion: 'ontoindex-source-manifest-v1',
    coverage: 'complete',
  },
  parserEvidence: { version: 1, parseErrorCount: 0, parseErrorFiles: [], truncated: false },
};

/** A resolved-symbol row (fuzzy lookup result). */
function resolvedRow(
  nodeId = 'Function:src/utils.ts:orphanHelper',
  name = 'orphanHelper',
  filePath = 'src/utils.ts',
  kind = 'Function',
): any {
  return { nodeId, name, filePath, kind, callerCount: 0 };
}

/** A caller row. */
function callerRow(
  nodeId = 'Function:src/app.ts:handle',
  name = 'handle',
  filePath = 'src/app.ts',
): any {
  return { nodeId, name, filePath };
}

/** A co-change row. */
function coChangeRow(
  filePath = 'src/shared.ts',
  confidence = 0.8,
  lastDate = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(), // 2 days ago
): any {
  return { filePath, confidence, lastDate };
}

/** A co-change row with an old date (not recently touched). */
function oldCoChangeRow(filePath = 'src/legacy.ts'): any {
  return {
    filePath,
    confidence: 0.3,
    lastDate: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString(), // 60 days ago
  };
}

// ---------------------------------------------------------------------------
// Mock sequence helpers.
// The gnCanDelete function makes these executeParameterized calls in order:
//   1. Symbol resolution (fuzzy or canonical)
//   2. Callers query
//   3. Test files query
//   4. Co-change network query
// ---------------------------------------------------------------------------

function mockOrphanSymbol(): void {
  mockExecuteParameterized
    .mockResolvedValueOnce([resolvedRow()]) // resolve
    .mockResolvedValueOnce([]) // callers — none
    .mockResolvedValueOnce([]); // co-change — none
  mockFindTestFiles.mockResolvedValueOnce({ coveringTests: [], likelihoodOfCoverage: 'NONE' });
}

// ---------------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------------

describe('gnCanDelete', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockListRegisteredRepos.mockResolvedValue([
      {
        name: REPO_ID,
        path: '/repo',
        storagePath: '/repo/.ontoindex',
        indexedAt: '2026-07-25T00:00:00.000Z',
        lastCommit: 'abc123',
      },
    ]);
    mockLoadMeta.mockResolvedValue(COMPLETE_META);
    mockGetCurrentCommit.mockReturnValue('abc123');
    mockExecFileText.mockImplementation(async (_command, args) => {
      if (args[0] === 'git' || args[0] === 'grep') return '';
      if (args.includes('grep')) return '';
      if (args.includes('ls-files')) return 'src/utils.ts\n';
      return '';
    });
  });

  // ---- Test 1: fail closed for a reference-free symbol ----------------------

  it.each<[string, Partial<RepoMeta>, 'complete' | 'incomplete' | 'unavailable']>([
    ['complete generation', {}, 'complete'],
    ['symbols-only index', { indexMode: 'symbols-only' }, 'incomplete'],
    ['symbols profile', { pipelineProfile: 'symbols' }, 'incomplete'],
    ['missing full profile', { pipelineProfile: undefined }, 'incomplete'],
    ['skipped parsing', { skippedPhases: ['parse'] }, 'incomplete'],
    [
      'unrelated degraded file',
      { degradedFiles: [{ filePath: 'src/other.ts', reason: 'parse failed' }] },
      'incomplete',
    ],
    [
      'degraded manifest without a target-file entry',
      { sourceManifest: { ...COMPLETE_META.sourceManifest!, coverage: 'degraded' } },
      'incomplete',
    ],
    [
      'aggregate sample count only',
      { degradedFileAggregates: { sampledDegradedCount: 1, groups: [], omittedGroupCount: 0 } },
      'incomplete',
    ],
    [
      'aggregate omitted group count only',
      { degradedFileAggregates: { sampledDegradedCount: 0, groups: [], omittedGroupCount: 1 } },
      'incomplete',
    ],
    [
      'aggregate group count only',
      {
        degradedFileAggregates: {
          sampledDegradedCount: 0,
          groups: [{ cause: 'parse failed', phase: 'parse', language: 'typescript', count: 1 }],
          omittedGroupCount: 0,
        },
      },
      'incomplete',
    ],
    [
      'unrelated parser error',
      {
        parserEvidence: {
          version: 1,
          parseErrorCount: 1,
          parseErrorFiles: ['src/other.ts'],
          truncated: false,
        },
      },
      'incomplete',
    ],
    [
      'truncated parser evidence',
      {
        parserEvidence: { version: 1, parseErrorCount: 0, parseErrorFiles: [], truncated: true },
      },
      'incomplete',
    ],
    ['missing parser evidence', { parserEvidence: undefined }, 'unavailable'],
    [
      'invalid parser evidence',
      { parserEvidence: { version: 1 } as RepoMeta['parserEvidence'] },
      'unavailable',
    ],
    [
      'contradictory zero-error parser evidence',
      {
        parserEvidence: {
          version: 1,
          parseErrorCount: 0,
          parseErrorFiles: ['src/other.ts'],
          truncated: false,
        },
      },
      'unavailable',
    ],
    ['missing source manifest', { sourceManifest: undefined }, 'unavailable'],
    [
      'unknown source manifest coverage',
      { sourceManifest: { ...COMPLETE_META.sourceManifest!, coverage: 'unknown' } },
      'unavailable',
    ],
    [
      'known degradation with missing parser evidence',
      {
        parserEvidence: undefined,
        degradedFiles: [{ filePath: 'src/other.ts', reason: 'parse failed' }],
      },
      'incomplete',
    ],
    [
      'known parser error with missing manifest',
      {
        sourceManifest: undefined,
        parserEvidence: {
          version: 1,
          parseErrorCount: 1,
          parseErrorFiles: ['src/other.ts'],
          truncated: false,
        },
      },
      'incomplete',
    ],
    [
      'zero degradation aggregates',
      { degradedFileAggregates: { sampledDegradedCount: 0, groups: [], omittedGroupCount: 0 } },
      'complete',
    ],
  ])('reports generation-wide parser coverage for %s', async (_name, metadata, expected) => {
    mockOrphanSymbol();
    mockLoadMeta.mockResolvedValue({ ...COMPLETE_META, ...metadata });

    const report = await gnCanDelete(REPO_ID, { symbol: 'orphanHelper' });

    expect(report.evidence.parserCoverage).toBe(expected);
    const coverageBlockers = report.blockers.filter(
      (blocker) =>
        blocker.type === 'incomplete-evidence' && blocker.detail.startsWith('parser coverage '),
    );
    expect(coverageBlockers).toEqual(
      expected === 'complete'
        ? []
        : [{ type: 'incomplete-evidence', detail: `parser coverage ${expected}` }],
    );
  });

  it.each(['caller', 'unresolved'] as const)(
    'preserves the real %s handler report through the facade adapter',
    async (scenario) => {
      const seedQueries = () => {
        mockExecuteParameterized.mockReset();
        mockFindTestFiles.mockReset();
        if (scenario === 'unresolved') {
          mockExecuteParameterized.mockResolvedValueOnce([]);
        } else {
          mockExecuteParameterized
            .mockResolvedValueOnce([resolvedRow()])
            .mockResolvedValueOnce([callerRow()])
            .mockResolvedValueOnce([]);
          mockFindTestFiles.mockResolvedValueOnce({
            coveringTests: [],
            likelihoodOfCoverage: 'NONE',
          });
        }
      };
      const args = { action: 'can_delete', symbol: 'orphanHelper', includeCrossRepo: false };
      const original = structuredClone(args);
      const repo = { id: REPO_ID, repoPath: '/repo' };
      const resolveRepo = vi.fn().mockResolvedValue(repo);
      const callTool = vi.fn();
      const withCommittedGraphNotice = vi.fn(async (report) => report);
      vi.stubEnv('ONTOINDEX_AUTO_WORKSPACE', '0');
      seedQueries();
      const direct = await dispatchSuper('gn_can_delete', args, REPO_ID);

      seedQueries();
      const facade = await dispatchFacade('audit', 'can_delete', args, {
        resolveRepo,
        callTool,
        withCommittedGraphNotice,
        ensureRepoInitialized: vi.fn(async () => {}),
        withPreparedRepoRead: vi.fn(async (_repo, _options, operation) => operation()),
      } as unknown as LocalBackend);

      expect(facade).toEqual(attachRepoScopeIdentity(direct, repo));
      expect(direct).toMatchObject({
        verdict: scenario === 'caller' ? 'DO-NOT-DELETE' : 'CAUTION',
      });
      expect(direct).toHaveProperty(
        'blockers',
        expect.arrayContaining([
          scenario === 'caller'
            ? { type: 'caller', detail: 'called by handle' }
            : { type: 'incomplete-evidence', detail: 'symbol resolution failed' },
        ]),
      );
      expect(direct).toHaveProperty('evidence.buildManifest', 'unavailable');
      expect(withCommittedGraphNotice).toHaveBeenCalledExactlyOnceWith(direct, repo);
      expect(resolveRepo).toHaveBeenCalledExactlyOnceWith(undefined);
      expect(callTool).not.toHaveBeenCalled();
      expect(args).toEqual(original);
    },
  );

  it.each([{}, { symbol: 42 }, { symbol: 'orphanHelper', includeCrossRepo: 'true' }])(
    'rejects malformed adapter arguments before graph queries: %j',
    async (args) => {
      const resolveRepo = vi.fn().mockResolvedValue({ id: REPO_ID, repoPath: '/repo' });
      const callTool = vi.fn();

      await expect(dispatchSuper('gn_can_delete', args, REPO_ID)).rejects.toThrow(
        'Invalid arguments for gn_can_delete',
      );
      await expect(
        dispatchFacade('audit', 'can_delete', args, {
          resolveRepo,
          callTool,
          ensureRepoInitialized: vi.fn(async () => {}),
          withPreparedRepoRead: vi.fn(async (_repo, _options, operation) => operation()),
        } as unknown as LocalBackend),
      ).rejects.toThrow('Invalid arguments for gn_can_delete');
      expect(mockExecuteParameterized).not.toHaveBeenCalled();
      expect(mockFindTestFiles).not.toHaveBeenCalled();
      expect(mockExecFileText).not.toHaveBeenCalled();
      expect(callTool).not.toHaveBeenCalled();
    },
  );

  it('returns CAUTION for a reference-free symbol when build-manifest proof is unavailable', async () => {
    mockOrphanSymbol();

    const report = await gnCanDelete(REPO_ID, { symbol: 'orphanHelper' });

    expect(report.version).toBe(1);
    expect(report.verdict).toBe('CAUTION');
    expect(report.blockers).toContainEqual({
      type: 'incomplete-evidence',
      detail: 'build-manifest coverage unavailable',
    });
    expect(report.callers).toHaveLength(0);
    expect(report.tests).toHaveLength(0);
    expect(report.coChangeNetwork.recentTouchDays).toBe(-1);
    expect(report.warnings).toContain('build-manifest coverage unavailable');
    expect(report.symbol.nodeId).toBe('Function:src/utils.ts:orphanHelper');
  });

  // ---- Test 2: DO-NOT-DELETE when callers exist ----------------------------

  it('returns DO-NOT-DELETE when callers exist', async () => {
    mockExecuteParameterized
      .mockResolvedValueOnce([resolvedRow()]) // resolve
      .mockResolvedValueOnce([callerRow()]) // callers — 1 caller
      .mockResolvedValueOnce([]); // co-change
    mockFindTestFiles.mockResolvedValueOnce({ coveringTests: [], likelihoodOfCoverage: 'NONE' });

    const report = await gnCanDelete(REPO_ID, { symbol: 'orphanHelper' });

    expect(report.verdict).toBe('DO-NOT-DELETE');
    expect(report.callers).toHaveLength(1);
    expect(report.callers[0].name).toBe('handle');
    expect(report.blockers).toContainEqual({
      type: 'caller',
      detail: 'called by handle',
    });
    expect(report.reasoning).toContain('caller');
  });

  // ---- Test 3: DO-NOT-DELETE when tests exist ------------------------------

  it('returns DO-NOT-DELETE when test files import the symbol', async () => {
    mockExecuteParameterized
      .mockResolvedValueOnce([resolvedRow()]) // resolve
      .mockResolvedValueOnce([]) // callers — none
      .mockResolvedValueOnce([]); // co-change
    mockFindTestFiles.mockResolvedValueOnce({
      coveringTests: ['src/__tests__/utils.test.ts'],
      likelihoodOfCoverage: 'MEDIUM',
    });

    const report = await gnCanDelete(REPO_ID, { symbol: 'orphanHelper' });

    expect(report.verdict).toBe('DO-NOT-DELETE');
    expect(report.tests).toHaveLength(1);
    expect(report.tests[0]).toBe('src/__tests__/utils.test.ts');
    expect(report.blockers).toContainEqual({
      type: 'test',
      detail: 'imported by test src/__tests__/utils.test.ts',
    });
    expect(report.reasoning).toContain('test file');
  });

  // ---- Test 4: CAUTION when recently touched but no callers/tests ----------

  it('returns CAUTION when symbol was recently touched but has no callers or tests', async () => {
    mockExecuteParameterized
      .mockResolvedValueOnce([resolvedRow()]) // resolve
      .mockResolvedValueOnce([]) // callers — none
      .mockResolvedValueOnce([coChangeRow()]); // co-change — 2 days ago
    mockFindTestFiles.mockResolvedValueOnce({ coveringTests: [], likelihoodOfCoverage: 'NONE' });

    const report = await gnCanDelete(REPO_ID, { symbol: 'orphanHelper' });

    expect(report.verdict).toBe('CAUTION');
    expect(report.coChangeNetwork.recentTouchDays).toBeGreaterThanOrEqual(0);
    expect(report.coChangeNetwork.recentTouchDays).toBeLessThan(7);
    expect(report.blockers).toContainEqual(expect.objectContaining({ type: 'co-change-recent' }));
    expect(report.reasoning).toContain('recently touched');
  });

  // ---- Test 5: cross-repo kill-switch returns [] + warning -----------------

  it('returns empty crossRepoReferences and warning when includeCrossRepo is true (kill-switch)', async () => {
    mockOrphanSymbol();

    const report = await gnCanDelete(REPO_ID, {
      symbol: 'orphanHelper',
      includeCrossRepo: true,
    });

    expect(report.crossRepoReferences).toEqual([]);
    expect(report.warnings).toContain('cross-repo not yet wired');
    // No cross-repo blockers should be added — kill-switch returns empty
    expect(report.blockers.filter((b) => b.type === 'cross-repo')).toHaveLength(0);
  });

  // ---- Bonus test 6: symbol not in index → DELETE-SAFE + warning -----------

  it('fails closed when the symbol is not found', async () => {
    // Fuzzy lookup returns no rows
    mockExecuteParameterized.mockResolvedValueOnce([]);

    const report = await gnCanDelete(REPO_ID, { symbol: 'nonExistentSymbol' });

    expect(report.version).toBe(1);
    expect(report.verdict).toBe('CAUTION');
    expect(report.symbol.nodeId).toBe('');
    expect(report.symbol.name).toBe('nonExistentSymbol');
    expect(report.reasoning).toContain('cannot be proven');
    expect(report.warnings).toContain('symbol not in index');
    expect(report.blockers).toContainEqual({
      type: 'incomplete-evidence',
      detail: 'symbol resolution failed',
    });
  });

  // ---- Bonus test 7: old co-change remains non-positive without full proof --

  it('returns CAUTION when co-change activity is old but build-manifest proof is unavailable', async () => {
    mockExecuteParameterized
      .mockResolvedValueOnce([resolvedRow()]) // resolve
      .mockResolvedValueOnce([]) // callers
      .mockResolvedValueOnce([oldCoChangeRow()]); // co-change — 60 days ago
    mockFindTestFiles.mockResolvedValueOnce({ coveringTests: [], likelihoodOfCoverage: 'NONE' });

    const report = await gnCanDelete(REPO_ID, { symbol: 'orphanHelper' });

    expect(report.verdict).toBe('CAUTION');
    expect(report.coChangeNetwork.recentTouchDays).toBeGreaterThanOrEqual(7);
    expect(report.blockers.filter((b) => b.type === 'co-change-recent')).toHaveLength(0);
  });

  it.each([
    ['CornerGroup', 'new cool.CornerGroup()'],
    ['CornerHeader', 'new cool.CornerHeader()'],
    ['GroupBase', 'class RowGroup extends GroupBase {}'],
    ['CanvasTileLayer', 'window.L.CalcTileLayer = window.L.CanvasTileLayer.extend({})'],
  ])('blocks bounded dynamic production reference for %s', async (name, sourceLine) => {
    mockExecuteParameterized
      .mockResolvedValueOnce([
        resolvedRow(`Class:src/groups.ts:${name}`, name, 'src/groups.ts', 'Class'),
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    mockFindTestFiles.mockResolvedValueOnce({ coveringTests: [], likelihoodOfCoverage: 'NONE' });
    mockExecFileText.mockImplementation(async (_command, args) => {
      if (args.includes('grep')) {
        return `src/groups.ts:1:export class ${name} {}\nsrc/app.ts:8:${sourceLine}\n`;
      }
      if (args.includes('ls-files')) return 'src/groups.ts\n';
      return '';
    });

    const report = await gnCanDelete(REPO_ID, { symbol: name });

    expect(report.verdict).toBe('DO-NOT-DELETE');
    expect(report.evidence.sourceReferences).toContainEqual(
      expect.objectContaining({ filePath: 'src/app.ts', text: sourceLine }),
    );
  });

  it('fails closed when the index is stale', async () => {
    mockOrphanSymbol();
    mockGetCurrentCommit.mockReturnValue('def456');

    const report = await gnCanDelete(REPO_ID, { symbol: 'orphanHelper' });

    expect(report.verdict).toBe('CAUTION');
    expect(report.evidence.freshness).toBe('stale');
  });

  it('fails closed when a graph evidence lane throws', async () => {
    mockExecuteParameterized
      .mockResolvedValueOnce([resolvedRow()])
      .mockRejectedValueOnce(new Error('graph unavailable'))
      .mockResolvedValueOnce([]);
    mockFindTestFiles.mockResolvedValueOnce({ coveringTests: [], likelihoodOfCoverage: 'NONE' });

    const report = await gnCanDelete(REPO_ID, { symbol: 'orphanHelper' });

    expect(report.verdict).toBe('CAUTION');
    expect(report.evidence.graph).toBe('unavailable');
  });
});
