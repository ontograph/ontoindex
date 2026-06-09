import { describe, expect, it, vi, beforeEach } from 'vitest';

const mockExecuteParameterized = vi.fn();

vi.mock('../../src/core/lbug/pool-adapter.js', () => ({
  executeParameterized: (...args: unknown[]) => mockExecuteParameterized(...args),
}));

import {
  computeGraphPath,
  computeGraphPathWithDiagnostics,
} from '../../src/core/search/graph-path.js';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('computeGraphPath', () => {
  it('maps object-field and tuple-index rows with object field precedence', async () => {
    mockExecuteParameterized.mockImplementation(
      (_repoId: string, _cypher: string, params: { nodeId: string }) => {
        if (params.nodeId === 'seed') {
          return Promise.resolve([
            { toId: 'object-child', edgeType: 'CALLS', 0: 'tuple-child', 1: 'IMPORTS' },
            ['tuple-only', 'REFERENCES'],
          ]);
        }
        return Promise.resolve([]);
      },
    );

    const result = await computeGraphPath('repo1', 'seed');

    expect(result).toEqual([
      { fromId: 'seed', toId: 'object-child', type: 'CALLS', depth: 1 },
      { fromId: 'seed', toId: 'tuple-only', type: 'REFERENCES', depth: 1 },
    ]);
  });

  it('continues best-effort after a DB failure on one frontier node', async () => {
    mockExecuteParameterized.mockImplementation(
      (_repoId: string, _cypher: string, params: { nodeId: string }) => {
        if (params.nodeId === 'seed') {
          return Promise.resolve([
            { toId: 'bad-child', edgeType: 'CALLS' },
            { toId: 'good-child', edgeType: 'IMPORTS' },
          ]);
        }
        if (params.nodeId === 'bad-child') {
          return Promise.reject(new Error('db unavailable'));
        }
        if (params.nodeId === 'good-child') {
          return Promise.resolve([{ toId: 'grandchild', edgeType: 'REFERENCES' }]);
        }
        return Promise.resolve([]);
      },
    );

    const result = await computeGraphPath('repo1', 'seed');

    expect(result).toContainEqual({ fromId: 'seed', toId: 'bad-child', type: 'CALLS', depth: 1 });
    expect(result).toContainEqual({
      fromId: 'good-child',
      toId: 'grandchild',
      type: 'REFERENCES',
      depth: 2,
    });
  });

  it('reports diagnostics for graph expansion', async () => {
    mockExecuteParameterized.mockImplementation(
      (_repoId: string, _cypher: string, params: { nodeId: string }) => {
        if (params.nodeId === 'seed') {
          return Promise.resolve([
            { toId: 'child1', edgeType: 'CALLS' },
            { toId: 'child2', edgeType: 'IMPORTS' },
          ]);
        }
        if (params.nodeId === 'child1') {
          return Promise.resolve([{ toId: 'grandchild1', edgeType: 'REFERENCES' }]);
        }
        return Promise.resolve([]);
      },
    );

    const result = await computeGraphPathWithDiagnostics('repo1', 'seed');

    expect(result.report.nodesVisited).toBe(4); // seed, child1, child2, grandchild1
    expect(result.report.maxObservedDepth).toBe(2);
    expect(result.report.byRelationshipType).toEqual({
      CALLS: 1,
      IMPORTS: 1,
      REFERENCES: 1,
    });
    expect(result.report.truncated).toBe(false);
    expect(result.traversalStrategy).toBe('simple-bfs');
    expect(result.report.weightedTraversal.status).toBe('not-requested');
    expect(result.report.passiveFacts).toEqual({
      status: 'unavailable',
      reason: 'passive-fact-source-not-configured',
      facts: [],
    });
    expect(result.passiveFacts).toEqual([]);
  });

  it('keeps simple BFS row order by default', async () => {
    mockExecuteParameterized.mockImplementation(
      (_repoId: string, _cypher: string, params: { nodeId: string }) => {
        if (params.nodeId === 'seed') {
          return Promise.resolve([
            { toId: 'reference-child', edgeType: 'REFERENCES' },
            { toId: 'call-child', edgeType: 'CALLS' },
          ]);
        }
        return Promise.resolve([]);
      },
    );

    const result = await computeGraphPathWithDiagnostics('repo1', 'seed');

    expect(result.edges.map((edge) => edge.toId)).toEqual(['reference-child', 'call-child']);
    expect(result.report.traversalStrategy).toBe('simple-bfs');
  });

  it('adds weighted traversal ranking only when requested', async () => {
    mockExecuteParameterized.mockImplementation(
      (_repoId: string, _cypher: string, params: { nodeId: string }) => {
        if (params.nodeId === 'seed') {
          return Promise.resolve([
            { toId: 'reference-child', edgeType: 'REFERENCES' },
            { toId: 'import-child', edgeType: 'IMPORTS' },
            { toId: 'call-child', edgeType: 'CALLS' },
          ]);
        }
        return Promise.resolve([]);
      },
    );

    const result = await computeGraphPathWithDiagnostics('repo1', 'seed', {
      traversalStrategy: 'weighted-bfs',
    });

    expect(result.edges.map((edge) => edge.toId)).toEqual([
      'call-child',
      'import-child',
      'reference-child',
    ]);
    expect(result.report.weightedTraversal.status).toBe('available');
    expect(result.report.weightedTraversal.rankedEdges.map((edge) => edge.toId)).toEqual([
      'call-child',
      'import-child',
      'reference-child',
    ]);
    expect(result.report.weightedTraversal.rankedEdges[0]).toMatchObject({
      toId: 'call-child',
      edgeWeight: 1,
      depthWeight: 1,
      score: 1,
    });
    expect(result.report.passiveFacts.status).toBe('unavailable');
  });
});
