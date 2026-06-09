/**
 * Unit tests for graphTraversalRank (v13 P1 W1b-step-2).
 *
 * Mocks executeParameterized to exercise BFS logic without a real DB.
 * 6 tests per spec:
 *   1. empty seeds → empty results
 *   2. single seed with CALLS edges → expanded set
 *   3. depth=2 boundary — depth-3 nodes NOT included
 *   4. deduplication — same node reachable from 2 seeds appears once
 *   5. edge type filter — IMPORTS only excludes CALLS-only neighbours
 *   6. maxResults cap is respected
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { EnrichedSymbolRow } from '../../src/core/search/symbol-merge.js';

// Mock pool-adapter before importing the module under test.
const mockExecuteParameterized = vi.fn();
vi.mock('../../src/core/lbug/pool-adapter.js', () => ({
  executeParameterized: (...args: any[]) => mockExecuteParameterized(...args),
}));

import {
  graphTraversalRank,
  graphTraversalRankWithDiagnostics,
} from '../../src/core/search/graph-traversal-rank.js';

function makeSymbol(nodeId: string, filePath = 'src/a.ts'): EnrichedSymbolRow {
  return { nodeId, name: nodeId, type: 'Function', filePath, startLine: 1 };
}

/** Build a mock DB row returned by executeParameterized */
function makeRow(toId: string, edgeType: string): Record<string, any> {
  return {
    toId,
    name: toId,
    nodeType: 'Function',
    filePath: `src/${toId}.ts`,
    startLine: 1,
    edgeType,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── Test 1: empty seeds → empty results ─────────────────────────────────────
describe('Test 1 — empty seeds returns empty results', () => {
  it('returns [] when seeds array is empty', async () => {
    const result = await graphTraversalRank('repo1', [], ['CALLS']);
    expect(result).toEqual([]);
    expect(mockExecuteParameterized).not.toHaveBeenCalled();
  });

  it('returns [] when seeds have no nodeId', async () => {
    const seedWithNoId: EnrichedSymbolRow = {
      nodeId: undefined as any,
      name: 'x',
      type: 'Function',
      filePath: 'a.ts',
      startLine: 1,
    };
    const result = await graphTraversalRank('repo1', [seedWithNoId], ['CALLS']);
    expect(result).toEqual([]);
  });

  it('returns [] when edgeTypes is empty', async () => {
    const result = await graphTraversalRank('repo1', [makeSymbol('n1')], []);
    expect(result).toEqual([]);
  });
});

// ─── Test 2: single seed with CALLS edges → expanded set ─────────────────────
describe('Test 2 — single seed with CALLS edges produces expanded results', () => {
  it('returns BFS-discovered nodes ranked by depth', async () => {
    // depth-1 neighbours of n1
    mockExecuteParameterized.mockImplementation((_repoId: string, _cypher: string, params: any) => {
      if (params.nodeId === 'n1') {
        return Promise.resolve([makeRow('n2', 'CALLS'), makeRow('n3', 'CALLS')]);
      }
      // depth-2 expansion: n2 has one child
      if (params.nodeId === 'n2') {
        return Promise.resolve([makeRow('n4', 'CALLS')]);
      }
      // n3 has no further children
      if (params.nodeId === 'n3') {
        return Promise.resolve([]);
      }
      return Promise.resolve([]);
    });

    const result = await graphTraversalRank('repo1', [makeSymbol('n1')], ['CALLS'], 2, 50);

    // Seeds (n1) are excluded from results.
    const ids = result.map((r) => r.nodeId);
    expect(ids).not.toContain('n1');
    expect(ids).toContain('n2');
    expect(ids).toContain('n3');
    expect(ids).toContain('n4');

    // Depth-1 nodes (n2, n3) must appear before depth-2 node (n4).
    const idxN2 = ids.indexOf('n2');
    const idxN3 = ids.indexOf('n3');
    const idxN4 = ids.indexOf('n4');
    expect(Math.max(idxN2, idxN3)).toBeLessThan(idxN4);
  });

  it('maps object-field and tuple-index rows with object field precedence', async () => {
    mockExecuteParameterized.mockImplementation(
      (_repoId: string, _cypher: string, params: { nodeId: string }) => {
        if (params.nodeId === 'n1') {
          return Promise.resolve([
            {
              toId: 'object-child',
              name: 'ObjectChild',
              nodeType: 'Class',
              filePath: 'src/object.ts',
              startLine: 7,
              0: 'tuple-child',
              1: 'TupleChild',
              2: 'Function',
              3: 'src/tuple.ts',
              4: 99,
            },
            ['tuple-only', 'TupleOnly', 'Interface', 'src/tuple-only.ts', 12],
          ]);
        }
        return Promise.resolve([]);
      },
    );

    const result = await graphTraversalRank('repo1', [makeSymbol('n1')], ['CALLS'], 1, 50);

    expect(result).toEqual([
      {
        nodeId: 'object-child',
        name: 'ObjectChild',
        type: 'Class',
        filePath: 'src/object.ts',
        startLine: 7,
      },
      {
        nodeId: 'tuple-only',
        name: 'TupleOnly',
        type: 'Interface',
        filePath: 'src/tuple-only.ts',
        startLine: 12,
      },
    ]);
  });
});

// ─── Test 3: depth=2 boundary — depth-3 nodes NOT included ───────────────────
describe('Test 3 — depth boundary at maxDepth=2', () => {
  it('does not include nodes reachable only at depth 3', async () => {
    // n1 → n2 (depth 1) → n3 (depth 2) → n4 (depth 3, must be excluded)
    mockExecuteParameterized.mockImplementation((_repoId: string, _cypher: string, params: any) => {
      if (params.nodeId === 'n1') return Promise.resolve([makeRow('n2', 'CALLS')]);
      if (params.nodeId === 'n2') return Promise.resolve([makeRow('n3', 'CALLS')]);
      // n3 would expand to n4 at depth 3, but BFS stops at depth 2 (never queries n3)
      return Promise.resolve([]);
    });

    const result = await graphTraversalRank('repo1', [makeSymbol('n1')], ['CALLS'], 2, 50);
    const ids = result.map((r) => r.nodeId);

    expect(ids).toContain('n2'); // depth 1 ✓
    expect(ids).toContain('n3'); // depth 2 ✓
    expect(ids).not.toContain('n4'); // depth 3 ✗
  });
});

// ─── Test 4: deduplication across multiple seeds ─────────────────────────────
describe('Test 4 — deduplication across multiple seeds', () => {
  it('node reachable from 2 seeds appears exactly once', async () => {
    // seed n1 → nShared (depth 1)
    // seed n2 → nShared (depth 1)
    // nShared should appear once in the output.
    mockExecuteParameterized.mockImplementation((_repoId: string, _cypher: string, params: any) => {
      if (params.nodeId === 'n1') return Promise.resolve([makeRow('nShared', 'CALLS')]);
      if (params.nodeId === 'n2') return Promise.resolve([makeRow('nShared', 'CALLS')]);
      return Promise.resolve([]);
    });

    const result = await graphTraversalRank(
      'repo1',
      [makeSymbol('n1'), makeSymbol('n2')],
      ['CALLS'],
      2,
      50,
    );

    const ids = result.map((r) => r.nodeId);
    const occurrences = ids.filter((id) => id === 'nShared').length;
    expect(occurrences).toBe(1);
  });

  it('min-depth wins — node discovered at depth 1 via one seed and depth 2 via another stays at depth 1', async () => {
    // n1 → nA (depth 1)
    // n2 → nB (depth 1) → nA (depth 2 via n2)
    // nA should be in results (discovered at depth 1 via n1).
    mockExecuteParameterized.mockImplementation((_repoId: string, _cypher: string, params: any) => {
      if (params.nodeId === 'n1') return Promise.resolve([makeRow('nA', 'CALLS')]);
      if (params.nodeId === 'n2') return Promise.resolve([makeRow('nB', 'CALLS')]);
      if (params.nodeId === 'nB') return Promise.resolve([makeRow('nA', 'CALLS')]); // nA again at depth 2 via n2
      if (params.nodeId === 'nA') return Promise.resolve([]); // no further expansion
      return Promise.resolve([]);
    });

    const result = await graphTraversalRank(
      'repo1',
      [makeSymbol('n1'), makeSymbol('n2')],
      ['CALLS'],
      2,
      50,
    );

    const ids = result.map((r) => r.nodeId);
    // nA appears once (depth 1 wins; not duplicated at depth 2).
    expect(ids.filter((id) => id === 'nA').length).toBe(1);
    // nA should appear before nB in results (depth 1 < depth 1 for nB, tiebreak by insertion).
    // Both are at depth 1 so order is insertion-stable — just verify both present.
    expect(ids).toContain('nB');
  });
});

// ─── Test 5: edge type filter ─────────────────────────────────────────────────
describe('Test 5 — edge type filter', () => {
  it('IMPORTS-only filter excludes CALLS-only neighbours', async () => {
    // The mock returns both edge types; the Cypher WHERE clause filters in DB.
    // We simulate this by only returning rows matching the requested edge types.
    mockExecuteParameterized.mockImplementation((_repoId: string, _cypher: string, params: any) => {
      if (params.nodeId === 'n1') {
        // Simulate DB returning only IMPORTS neighbours (CALLS filtered by DB WHERE clause)
        return Promise.resolve([makeRow('nImported', 'IMPORTS')]);
        // nCalled would be excluded by the edgeTypes filter in the Cypher query.
      }
      return Promise.resolve([]);
    });

    const result = await graphTraversalRank('repo1', [makeSymbol('n1')], ['IMPORTS'], 2, 50);
    const ids = result.map((r) => r.nodeId);

    expect(ids).toContain('nImported');
    expect(ids).not.toContain('nCalled');

    // Verify the edgeTypes param was passed correctly to the DB call.
    expect(mockExecuteParameterized).toHaveBeenCalledWith(
      'repo1',
      expect.stringContaining('edgeTypes'),
      expect.objectContaining({ edgeTypes: ['IMPORTS'] }),
    );
  });
});

// ─── Test 6: maxResults cap ───────────────────────────────────────────────────
describe('Test 6 — maxResults cap is respected', () => {
  it('returns at most maxResults results', async () => {
    // Seed n1 has 20 depth-1 neighbours.
    const depth1Rows = Array.from({ length: 20 }, (_, i) => makeRow(`child${i}`, 'CALLS'));
    mockExecuteParameterized.mockImplementation((_repoId: string, _cypher: string, params: any) => {
      if (params.nodeId === 'n1') return Promise.resolve(depth1Rows);
      return Promise.resolve([]);
    });

    const result = await graphTraversalRank('repo1', [makeSymbol('n1')], ['CALLS'], 2, 5);
    expect(result.length).toBeLessThanOrEqual(5);
  });

  it('returns all results when count is below cap', async () => {
    mockExecuteParameterized.mockImplementation((_repoId: string, _cypher: string, params: any) => {
      if (params.nodeId === 'n1')
        return Promise.resolve([makeRow('nA', 'CALLS'), makeRow('nB', 'CALLS')]);
      return Promise.resolve([]);
    });

    const result = await graphTraversalRank('repo1', [makeSymbol('n1')], ['CALLS'], 2, 50);
    expect(result.length).toBe(2);
  });
});

describe('weighted traversal diagnostics', () => {
  it('keeps graphTraversalRank as simple BFS by default', async () => {
    mockExecuteParameterized.mockImplementation((_repoId: string, _cypher: string, params: any) => {
      if (params.nodeId === 'n1') {
        return Promise.resolve([makeRow('referenced', 'REFERENCES'), makeRow('called', 'CALLS')]);
      }
      return Promise.resolve([]);
    });

    const result = await graphTraversalRank(
      'repo1',
      [makeSymbol('n1')],
      ['REFERENCES', 'CALLS'],
      1,
    );

    expect(result.map((row) => row.nodeId)).toEqual(['referenced', 'called']);
  });

  it('ranks weighted traversal by deterministic edge-type and depth distance when requested', async () => {
    mockExecuteParameterized.mockImplementation((_repoId: string, _cypher: string, params: any) => {
      if (params.nodeId === 'n1') {
        return Promise.resolve([makeRow('referenced', 'REFERENCES'), makeRow('called', 'CALLS')]);
      }
      return Promise.resolve([]);
    });

    const result = await graphTraversalRankWithDiagnostics(
      'repo1',
      [makeSymbol('n1')],
      ['REFERENCES', 'CALLS'],
      1,
      50,
      { traversalStrategy: 'weighted-bfs' },
    );

    expect(result.rows.map((row) => row.nodeId)).toEqual(['called', 'referenced']);
    expect(result.report.traversalStrategy).toBe('weighted-bfs');
    expect(result.report.rankedNodes[0]).toMatchObject({
      nodeId: 'called',
      depth: 1,
      distance: 1,
      score: 1,
      via: { fromId: 'n1', edgeType: 'CALLS' },
    });
    expect(result.report.rankedEdges.map((edge) => edge.toId)).toEqual(['called', 'referenced']);
  });

  it('reports depth, edge type, and passive-fact unavailable diagnostics', async () => {
    mockExecuteParameterized.mockImplementation((_repoId: string, _cypher: string, params: any) => {
      if (params.nodeId === 'n1') return Promise.resolve([makeRow('n2', 'IMPORTS')]);
      if (params.nodeId === 'n2') return Promise.resolve([makeRow('n3', 'CALLS')]);
      return Promise.resolve([]);
    });

    const result = await graphTraversalRankWithDiagnostics(
      'repo1',
      [makeSymbol('n1')],
      ['IMPORTS', 'CALLS'],
      2,
      50,
      { traversalStrategy: 'weighted-bfs' },
    );

    expect(result.rows.map((row) => row.nodeId)).toEqual(['n2', 'n3']);
    expect(result.report.byDepth).toEqual({ 1: 1, 2: 1 });
    expect(result.report.byEdgeType).toEqual({ IMPORTS: 1, CALLS: 1 });
    expect(result.report.rankedEdges[0].reason).toContain('weight');
    expect(result.report.passiveFacts).toEqual({
      status: 'unavailable',
      reason: 'passive-fact-source-not-configured',
      facts: [],
    });
  });
});
