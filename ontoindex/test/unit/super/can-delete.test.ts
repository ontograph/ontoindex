/**
 * Unit tests for gn_can_delete super-function (Phase 2 W2b).
 *
 * All external primitives are mocked so tests run without a live DB.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — must be declared before the import under test.
// ---------------------------------------------------------------------------

vi.mock('../../../src/core/lbug/pool-adapter.js', () => ({
  executeParameterized: vi.fn(),
}));

vi.mock('../../../src/mcp/super/_helpers/test-coverage.js', () => ({
  findTestFiles: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks).
// ---------------------------------------------------------------------------

import { executeParameterized } from '../../../src/core/lbug/pool-adapter.js';
import { findTestFiles } from '../../../src/mcp/super/_helpers/test-coverage.js';
import { gnCanDelete } from '../../../src/mcp/super/can-delete.js';

// Typed mock handles.
const mockExecuteParameterized = executeParameterized as unknown as ReturnType<typeof vi.fn>;
const mockFindTestFiles = findTestFiles as unknown as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

const REPO_ID = 'test-repo';

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

/** A test-file row (IMPORTS edge from test file). */
function testFileRow(filePath = 'src/__tests__/utils.test.ts'): any {
  return { filePath };
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
  });

  // ---- Test 1: DELETE-SAFE for orphan symbol -------------------------------

  it('returns DELETE-SAFE for an orphan symbol with no callers, tests, or co-change activity', async () => {
    mockOrphanSymbol();

    const report = await gnCanDelete(REPO_ID, { symbol: 'orphanHelper' });

    expect(report.version).toBe(1);
    expect(report.verdict).toBe('DELETE-SAFE');
    expect(report.blockers).toHaveLength(0);
    expect(report.callers).toHaveLength(0);
    expect(report.tests).toHaveLength(0);
    expect(report.coChangeNetwork.recentTouchDays).toBe(-1);
    expect(report.warnings).toHaveLength(0);
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

  it('returns DELETE-SAFE with "symbol not in index" warning when symbol is not found', async () => {
    // Fuzzy lookup returns no rows
    mockExecuteParameterized.mockResolvedValueOnce([]);

    const report = await gnCanDelete(REPO_ID, { symbol: 'nonExistentSymbol' });

    expect(report.version).toBe(1);
    expect(report.verdict).toBe('DELETE-SAFE');
    expect(report.symbol.nodeId).toBe('');
    expect(report.symbol.name).toBe('nonExistentSymbol');
    expect(report.reasoning).toContain('already gone');
    expect(report.warnings).toContain('symbol not in index');
    expect(report.blockers).toHaveLength(0);
  });

  // ---- Bonus test 7: DELETE-SAFE when co-change is old (>= 7 days) ---------

  it('returns DELETE-SAFE when co-change activity is old (not recent)', async () => {
    mockExecuteParameterized
      .mockResolvedValueOnce([resolvedRow()]) // resolve
      .mockResolvedValueOnce([]) // callers
      .mockResolvedValueOnce([oldCoChangeRow()]); // co-change — 60 days ago
    mockFindTestFiles.mockResolvedValueOnce({ coveringTests: [], likelihoodOfCoverage: 'NONE' });

    const report = await gnCanDelete(REPO_ID, { symbol: 'orphanHelper' });

    expect(report.verdict).toBe('DELETE-SAFE');
    expect(report.coChangeNetwork.recentTouchDays).toBeGreaterThanOrEqual(7);
    expect(report.blockers.filter((b) => b.type === 'co-change-recent')).toHaveLength(0);
  });
});
