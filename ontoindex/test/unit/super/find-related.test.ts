/**
 * Unit tests for gn_find_related super-function (W1c).
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

// ---------------------------------------------------------------------------
// Imports (after mocks).
// ---------------------------------------------------------------------------

import { executeParameterized } from '../../../src/core/lbug/pool-adapter.js';
import { gnFindRelated } from '../../../src/mcp/super/find-related.js';

// Typed mock handle.
const mockExecuteParameterized = executeParameterized as unknown as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

const REPO_ID = 'test-repo';

/** A minimal resolved-symbol row. */
function resolvedRow(
  nodeId = 'Function:src/auth.ts:parseToken',
  name = 'parseToken',
  filePath = 'src/auth.ts',
  kind = 'Function',
): any {
  return { nodeId, name, filePath, kind, callerCount: 3 };
}

/** A caller row. */
function callerRow(
  nodeId = 'Function:src/app.ts:handle',
  name = 'handle',
  filePath = 'src/app.ts',
  relKind = 'CALLS',
): any {
  return { nodeId, name, filePath, relKind };
}

/** A callee row. */
function calleeRow(
  nodeId = 'Function:src/utils.ts:verify',
  name = 'verify',
  filePath = 'src/utils.ts',
  relKind = 'CALLS',
): any {
  return { nodeId, name, filePath, relKind };
}

/** A co-changed-file row. */
function coChangedRow(
  filePath = 'src/middleware.ts',
  coChangeCount = 5,
  lastDate = '2025-01-01',
): any {
  return { filePath, coChangeCount, lastDate };
}

/** A cluster-sibling row. */
function siblingRow(
  nodeId = 'Function:src/other.ts:helper',
  name = 'helper',
  filePath = 'src/other.ts',
  clusterName = 'auth-cluster',
): any {
  return { nodeId, name, filePath, clusterName };
}

/** A close-match row. */
function closeMatchRow(
  nodeId = 'Function:src/auth.ts:parseToken',
  name = 'parseToken',
  filePath = 'src/auth.ts',
  kind = 'Function',
): any {
  return { nodeId, name, filePath, kind };
}

// ---------------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------------

describe('gnFindRelated', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  // ---- Test 1: fuzzy symbol → canonical nodeId resolution -----------------

  it('resolves a fuzzy symbol name to a canonical nodeId', async () => {
    // First call: fuzzy lookup (no canonical prefix)
    mockExecuteParameterized
      .mockResolvedValueOnce([resolvedRow()]) // resolve
      .mockResolvedValueOnce([callerRow()]) // callers
      .mockResolvedValueOnce([calleeRow()]) // callees
      .mockResolvedValueOnce([coChangedRow()]) // co-changed
      .mockResolvedValueOnce([siblingRow()]); // cluster siblings

    const report = await gnFindRelated(REPO_ID, { symbol: 'parseToken' });

    expect(report.version).toBe(1);
    expect(report.resolvedSymbol.nodeId).toBe('Function:src/auth.ts:parseToken');
    expect(report.resolvedSymbol.name).toBe('parseToken');
    expect(report.warnings).toHaveLength(0);

    // Verify fuzzy-lookup query was used (no CANONICAL_NODE_ID_RE prefix)
    const firstCall = mockExecuteParameterized.mock.calls[0];
    expect(firstCall[1]).toContain('s.name = $name');
    expect(firstCall[2]).toEqual({ name: 'parseToken' });
  });

  // ---- Test 1b: read-first projection is included in default output -------

  it('projects read-first files and omitted counts in the default report', async () => {
    mockExecuteParameterized
      .mockResolvedValueOnce([resolvedRow()]) // resolve
      .mockResolvedValueOnce([
        callerRow('Function:src/app.ts:handle', 'handle', 'src/app.ts'),
        callerRow('Function:src/middleware.ts:gate', 'gate', 'src/middleware.ts'),
      ]) // callers
      .mockResolvedValueOnce([calleeRow()]) // callees
      .mockResolvedValueOnce([coChangedRow('src/utils.ts')]) // co-changed
      .mockResolvedValueOnce([siblingRow()]); // cluster siblings

    const report = await gnFindRelated(REPO_ID, { symbol: 'parseToken' });

    expect(report.readFirstFiles.map((item) => item.filePath)).toEqual([
      'src/auth.ts',
      'src/app.ts',
      'src/middleware.ts',
      'src/utils.ts',
      'src/other.ts',
    ]);
    expect(report.readFirstFiles.map((item) => item.source)).toEqual([
      'definition',
      'caller',
      'caller',
      'callee',
      'cluster',
    ]);
    expect(report.omittedCounts).toEqual({
      invalid: 0,
      duplicate: 1,
      truncated: 0,
      total: 1,
    });
    expect(report.callers).toHaveLength(2);
    expect(report.callees).toHaveLength(1);
    expect(report.clusterSiblings).toHaveLength(1);
  });

  // ---- Test 2: callers limited to maxItemsPerCategory ---------------------

  it('limits callers to maxItemsPerCategory', async () => {
    mockExecuteParameterized
      .mockResolvedValueOnce([resolvedRow()]) // resolve
      .mockResolvedValueOnce([callerRow(), callerRow('Function:src/b.ts:b', 'b', 'src/b.ts')]) // callers
      .mockResolvedValueOnce([]) // callees
      .mockResolvedValueOnce([]) // co-changed
      .mockResolvedValueOnce([]); // cluster siblings

    const report = await gnFindRelated(REPO_ID, { symbol: 'parseToken', maxItemsPerCategory: 2 });

    expect(report.callers.length).toBeLessThanOrEqual(2);

    // Verify LIMIT $max was passed with max=2
    const callersCall = mockExecuteParameterized.mock.calls[1];
    expect(callersCall[2]).toMatchObject({ max: 2 });
  });

  // ---- Test 3: callees include CALLS, REFERENCES, IMPORTS -----------------

  it('callees include CALLS, REFERENCES, and IMPORTS relationship kinds', async () => {
    const calleeRows = [
      calleeRow('Function:src/a.ts:a', 'a', 'src/a.ts', 'CALLS'),
      calleeRow('Function:src/b.ts:b', 'b', 'src/b.ts', 'REFERENCES'),
      calleeRow('Function:src/c.ts:c', 'c', 'src/c.ts', 'IMPORTS'),
    ];

    mockExecuteParameterized
      .mockResolvedValueOnce([resolvedRow()]) // resolve
      .mockResolvedValueOnce([]) // callers
      .mockResolvedValueOnce(calleeRows) // callees
      .mockResolvedValueOnce([]) // co-changed
      .mockResolvedValueOnce([]); // cluster siblings

    const report = await gnFindRelated(REPO_ID, { symbol: 'parseToken' });

    const kinds = report.callees.map((c) => c.relationshipKind);
    expect(kinds).toContain('CALLS');
    expect(kinds).toContain('REFERENCES');
    expect(kinds).toContain('IMPORTS');
  });

  // ---- Test 4: cluster siblings exclude the target symbol itself -----------

  it('cluster siblings exclude the target symbol', async () => {
    const targetNodeId = 'Function:src/auth.ts:parseToken';
    const siblings = [
      siblingRow('Function:src/other.ts:helper', 'helper', 'src/other.ts', 'auth-cluster'),
      // The target itself should never appear in sibling results due to WHERE sibling.id <> $id.
      // We simulate the DB correctly excluding it by not including it in the mock result.
    ];

    mockExecuteParameterized
      .mockResolvedValueOnce([resolvedRow(targetNodeId)]) // resolve
      .mockResolvedValueOnce([]) // callers
      .mockResolvedValueOnce([]) // callees
      .mockResolvedValueOnce([]) // co-changed
      .mockResolvedValueOnce(siblings); // cluster siblings

    const report = await gnFindRelated(REPO_ID, { symbol: targetNodeId });

    const siblingIds = report.clusterSiblings.map((s) => s.nodeId);
    expect(siblingIds).not.toContain(targetNodeId);
    expect(siblingIds).toContain('Function:src/other.ts:helper');

    // Verify the Cypher query includes the exclusion predicate
    const siblingsCall = mockExecuteParameterized.mock.calls[4];
    expect(siblingsCall[1]).toContain('sibling.id <> $id');

    // Verify reason format
    expect(report.clusterSiblings[0].reason).toMatch(/same Leiden community: auth-cluster/);
  });

  // ---- Test 5: crossRepoReferences omitted when includeCrossRepo not set --

  it('omits crossRepoReferences when includeCrossRepo is not set', async () => {
    mockExecuteParameterized
      .mockResolvedValueOnce([resolvedRow()]) // resolve
      .mockResolvedValueOnce([]) // callers
      .mockResolvedValueOnce([]) // callees
      .mockResolvedValueOnce([]) // co-changed
      .mockResolvedValueOnce([]); // cluster siblings

    const report = await gnFindRelated(REPO_ID, { symbol: 'parseToken' });

    expect(report.crossRepoReferences).toBeUndefined();
    expect(report.warnings).toHaveLength(0);
  });

  // ---- Test 5a: compact files format returns read-first projection only ----

  it('returns only the files projection when format is files', async () => {
    mockExecuteParameterized
      .mockResolvedValueOnce([resolvedRow()]) // resolve
      .mockResolvedValueOnce([callerRow()]) // callers
      .mockResolvedValueOnce([calleeRow()]) // callees
      .mockResolvedValueOnce([coChangedRow()]) // co-changed
      .mockResolvedValueOnce([siblingRow()]); // cluster siblings

    const report = await gnFindRelated(REPO_ID, { symbol: 'parseToken', format: 'files' });

    expect(report).toEqual(
      expect.objectContaining({
        version: 1,
        resolvedSymbol: expect.objectContaining({ nodeId: 'Function:src/auth.ts:parseToken' }),
        readFirstFiles: expect.any(Array),
        omittedCounts: expect.objectContaining({
          invalid: 0,
          duplicate: 0,
          truncated: 0,
          total: 0,
        }),
        warnings: [],
      }),
    );
    expect(report).not.toHaveProperty('callers');
    expect(report).not.toHaveProperty('callees');
    expect(report).not.toHaveProperty('coChangedFiles');
    expect(report).not.toHaveProperty('clusterSiblings');
    expect(report).not.toHaveProperty('crossRepoReferences');
  });

  // ---- Test 5b: crossRepoReferences empty + warning when includeCrossRepo true

  it('returns empty crossRepoReferences and warning when includeCrossRepo is true', async () => {
    mockExecuteParameterized
      .mockResolvedValueOnce([resolvedRow()]) // resolve
      .mockResolvedValueOnce([]) // callers
      .mockResolvedValueOnce([]) // callees
      .mockResolvedValueOnce([]) // co-changed
      .mockResolvedValueOnce([]); // cluster siblings

    const report = await gnFindRelated(REPO_ID, {
      symbol: 'parseToken',
      includeCrossRepo: true,
    });

    expect(report.crossRepoReferences).toEqual([]);
    expect(report.warnings).toContain('cross-repo not yet wired');
  });

  // ---- Test 6: symbol not found returns warning + empty report -------------

  it('returns warning and empty report when symbol is not found', async () => {
    // Fuzzy lookup returns no rows
    mockExecuteParameterized
      .mockResolvedValueOnce([]) // resolve
      .mockResolvedValueOnce([
        closeMatchRow(),
        closeMatchRow('Class:src/auth.ts:Auth', 'Auth', 'src/auth.ts', 'Class'),
      ]); // close matches

    const report = await gnFindRelated(REPO_ID, { symbol: 'nonExistentSymbol' });

    expect(report.version).toBe(1);
    expect(report.resolvedSymbol.nodeId).toBe('');
    expect(report.callers).toHaveLength(0);
    expect(report.callees).toHaveLength(0);
    expect(report.coChangedFiles).toHaveLength(0);
    expect(report.clusterSiblings).toHaveLength(0);
    expect(report.readFirstFiles).toHaveLength(0);
    expect(report.omittedCounts).toEqual({
      invalid: 0,
      duplicate: 0,
      truncated: 0,
      total: 0,
    });
    expect(report.warnings).toContain('symbol not found in index');
    expect(report.closeMatches).toHaveLength(2);
    expect(report.closeMatches?.[0]).toEqual(
      expect.objectContaining({
        nodeId: 'Function:src/auth.ts:parseToken',
        name: 'parseToken',
        filePath: 'src/auth.ts',
        kind: 'Function',
        suggestedNextCalls: [
          'inspect({ action: "context", repo: "test-repo", uid: "Function:src/auth.ts:parseToken" })',
          'impact({ action: "symbol", repo: "test-repo", target_uid: "Function:src/auth.ts:parseToken", target: "parseToken" })',
        ],
      }),
    );
    const resolveCall = mockExecuteParameterized.mock.calls[0];
    const closeMatchCall = mockExecuteParameterized.mock.calls[1];
    expect(resolveCall[1]).toContain('s.name = $name');
    expect(closeMatchCall[1]).toContain('toLower(s.name) CONTAINS $needle');
    expect(closeMatchCall[2]).toEqual({ needle: 'nonExistentSymbol'.toLowerCase(), max: 5 });
  });

  // ---- Test 6b: compact files format includes close matches on not found ---

  it('returns close matches in files format when symbol is not found', async () => {
    mockExecuteParameterized
      .mockResolvedValueOnce([]) // resolve
      .mockResolvedValueOnce([closeMatchRow()]); // close matches

    const report = await gnFindRelated(REPO_ID, { symbol: 'nonExistentSymbol', format: 'files' });

    expect(report).toEqual(
      expect.objectContaining({
        version: 1,
        resolvedSymbol: expect.objectContaining({ nodeId: '' }),
        closeMatches: expect.arrayContaining([
          expect.objectContaining({
            nodeId: 'Function:src/auth.ts:parseToken',
            suggestedNextCalls: expect.arrayContaining([
              'inspect({ action: "context", repo: "test-repo", uid: "Function:src/auth.ts:parseToken" })',
            ]),
          }),
        ]),
        readFirstFiles: [],
        omittedCounts: expect.objectContaining({
          invalid: 0,
          duplicate: 0,
          truncated: 0,
          total: 0,
        }),
        warnings: ['symbol not found in index'],
      }),
    );
    expect(report).not.toHaveProperty('callers');
    expect(report).not.toHaveProperty('callees');
    expect(report).not.toHaveProperty('coChangedFiles');
    expect(report).not.toHaveProperty('clusterSiblings');
  });

  // ---- Test 7: canonical nodeId bypasses fuzzy lookup ----------------------

  it('accepts a canonical nodeId and verifies it exists without fuzzy lookup', async () => {
    const canonicalId = 'Function:src/auth.ts:parseToken';

    mockExecuteParameterized
      .mockResolvedValueOnce([resolvedRow(canonicalId)]) // canonical verify
      .mockResolvedValueOnce([callerRow()]) // callers
      .mockResolvedValueOnce([]) // callees
      .mockResolvedValueOnce([]) // co-changed
      .mockResolvedValueOnce([]); // cluster siblings

    const report = await gnFindRelated(REPO_ID, { symbol: canonicalId });

    expect(report.resolvedSymbol.nodeId).toBe(canonicalId);

    // Verify the canonical-lookup query was used (not the fuzzy one)
    const firstCall = mockExecuteParameterized.mock.calls[0];
    expect(firstCall[1]).toContain('s.id = $id');
    expect(firstCall[2]).toEqual({ id: canonicalId });
  });
});
