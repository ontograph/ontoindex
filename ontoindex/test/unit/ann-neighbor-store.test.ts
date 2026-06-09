import { describe, expect, it, vi } from 'vitest';

import {
  ANN_NEIGHBOR_RELATION_TYPE,
} from '../../src/core/embeddings/ann-neighbor.js';
import {
  adaptAnnNeighborEdgesForFrontier,
  buildAnnNeighborDeleteQuery,
  buildAnnNeighborLoadQuery,
  buildAnnNeighborPersistQuery,
  cleanupAnnNeighborEdges,
  loadAnnNeighborEdges,
  persistAnnNeighborEdges,
} from '../../src/core/embeddings/ann-neighbor-store.js';
import {
  DEFAULT_IMPACT_RELATION_TYPES,
  SAFE_EDIT_UPSTREAM_RELATION_TYPES,
  SAFE_EDIT_DOWNSTREAM_RELATION_TYPES,
  VALID_RELATION_TYPES,
} from '../../src/core/impact/impact-kernel.js';

const makeEdge = (index: number, source = 'Function:source:A') => ({
  relationType: ANN_NEIGHBOR_RELATION_TYPE,
  sourceId: source,
  targetId: `Function:target:${String(index).padStart(2, '0')}`,
  score: 1 - index / 100,
  rank: index,
  model: 'text-embedding-3-small',
  sourceContentHash: `source-hash-${String(index).padStart(2, '0')}`,
  targetContentHash: `target-hash-${String(index).padStart(2, '0')}`,
  builtAt: '2026-06-09T00:00:00.000Z',
  buildId: 'build-001',
  isStale: false,
  staleReasons: [],
});

const staleMetadataRow = (
  edge: {
    relationType: string;
    model: string;
    sourceId: string;
    targetId: string;
    score: number;
    rank: number;
    sourceContentHash: string;
    targetContentHash: string;
    builtAt: string;
    buildId: string;
    staleReasons?: readonly string[];
  },
  isStale = false,
) => ({
  sourceId: edge.sourceId,
  targetId: edge.targetId,
  score: edge.score,
  rank: edge.rank,
  reason: JSON.stringify({
    model: edge.model,
    sourceContentHash: edge.sourceContentHash,
    targetContentHash: edge.targetContentHash,
    builtAt: edge.builtAt,
    buildId: edge.buildId,
    isStale,
    staleReasons: edge.staleReasons ?? [],
  }),
});

describe('ann-neighbor-store query builders', () => {
  it('builds parameterized CREATE query without injecting node ids', () => {
    const query = buildAnnNeighborPersistQuery();
    const dangerousSource = 'Function:bad\'; MATCH (n) DETACH DELETE n; //';
    const dangerousTarget = 'Function:target\'; DETACH DELETE n; //';

    expect(query).not.toContain(dangerousSource);
    expect(query).not.toContain(dangerousTarget);

    expect(query).toContain('$sourceId');
    expect(query).toContain('$targetId');
    expect(query).toContain('$relationType');
    expect(query).toContain('$score');
    expect(query).toContain('$reason');
    expect(query).toContain('$rank');
  });

  it('builds load query with optional source-id predicate using placeholders', () => {
    const queryWithFilter = buildAnnNeighborLoadQuery(true);
    const queryWithoutFilter = buildAnnNeighborLoadQuery(false);
    expect(queryWithFilter).toContain('source.id IN $sourceIds');
    expect(queryWithoutFilter).not.toContain('source.id IN $sourceIds');
    expect(queryWithFilter).toContain('r.type = $relationType');
    expect(queryWithoutFilter).toContain('r.type = $relationType');
  });

  it('builds delete query with placeholders only', () => {
    const query = buildAnnNeighborDeleteQuery();
    expect(query).toContain('$sourceId');
    expect(query).toContain('$targetId');
    expect(query).toContain('$relationType');
    expect(query).not.toContain('\"');
  });
});

describe('ann-neighbor-store persist/load', () => {
  it('persists only ANN_NEIGHBOR edges through injected batch executor', async () => {
    const executeWithReusedStatement = vi.fn().mockResolvedValue(undefined);
    const edges = [
      makeEdge(1),
      {
        ...makeEdge(2),
        relationType: 'CALLS',
      },
      makeEdge(3),
    ] as const;

    await persistAnnNeighborEdges(executeWithReusedStatement, edges);
    const calls = executeWithReusedStatement.mock.calls[0];
    expect(calls[0]).toContain('MATCH (source), (target)');
    expect(calls[1]).toHaveLength(2);
    expect(calls[1][0]).toMatchObject({
      sourceId: edges[0].sourceId,
      targetId: edges[0].targetId,
      relationType: ANN_NEIGHBOR_RELATION_TYPE,
    });
  });

  it('loads fresh/stale edges with map-based freshness filtering', async () => {
    const staleSource = makeEdge(1, 'Function:source:A');
    const freshSource = makeEdge(2, 'Function:source:A');
    const freshTarget = makeEdge(3, 'Function:source:B');

    const executeQuery = vi.fn().mockResolvedValue([
      staleMetadataRow(staleSource, false),
      staleMetadataRow(freshSource, false),
      staleMetadataRow(freshTarget, false),
    ]);
    const loadedFreshOnly = await loadAnnNeighborEdges(executeQuery, {
      sourceIds: ['Function:source:A'],
      includeStale: false,
      currentContentHashByNodeId: new Map([
        [staleSource.sourceId, 'current-source-hash'],
        [freshSource.sourceId, 'source-hash-02'],
        [freshTarget.sourceId, 'source-hash-03'],
        [staleSource.targetId, 'target-hash-01'],
        [freshSource.targetId, 'target-hash-02'],
        [freshTarget.targetId, 'target-hash-03'],
      ]),
    });

    expect(loadedFreshOnly).toHaveLength(1);
    expect(loadedFreshOnly[0].targetId).toBe(freshSource.targetId);
    expect(loadedFreshOnly[0].isStale).toBe(false);

    const loadedIncludeStale = await loadAnnNeighborEdges(executeQuery, {
      sourceIds: ['Function:source:A'],
      includeStale: true,
      currentContentHashByNodeId: new Map([
        [staleSource.sourceId, 'current-source-hash'],
        [freshSource.sourceId, 'source-hash-02'],
        [freshSource.targetId, 'target-hash-02'],
        [freshTarget.targetId, 'target-hash-03'],
      ]),
    });
    expect(loadedIncludeStale).toHaveLength(2);
    expect(loadedIncludeStale.some((edge) => edge.isStale)).toBe(true);
  });

  it('limits outbound degree per source id during load', async () => {
    const denseSource = 'Function:source:Hub';
    const edges = Array.from({ length: 20 }, (_, index) =>
      staleMetadataRow(
        {
          ...makeEdge(index + 1, denseSource),
          sourceId: denseSource,
          rank: index + 1,
        },
      ),
    );

    const executeQuery = vi.fn().mockResolvedValue(edges);
    const loaded = await loadAnnNeighborEdges(executeQuery, {
      sourceIds: [denseSource],
      maxOutboundDegree: 8,
      includeStale: true,
    });

    expect(loaded).toHaveLength(8);
    expect(loaded[0].rank).toBe(1);
    expect(loaded[7].rank).toBe(8);
  });

  it('adapts ANN edges to frontier edges (score + stale metadata)', async () => {
    const edges = [makeEdge(1), makeEdge(2)];
    const executeQuery = vi.fn().mockResolvedValue([
      staleMetadataRow(edges[0], false),
      staleMetadataRow(edges[1], true),
    ]);

    const loaded = await loadAnnNeighborEdges(executeQuery, {
      includeStale: true,
      sourceIds: [edges[0].sourceId],
    });
    const frontierEdges = adaptAnnNeighborEdgesForFrontier(loaded);

    expect(frontierEdges).toHaveLength(loaded.length);
    expect(frontierEdges[0].toId).toBe(loaded[0].targetId);
    expect(frontierEdges[0].stale).toBe(false);
  });

  it('delete path filters stale edges and only deletes intended rows', async () => {
    const staleEdge = staleMetadataRow(
      {
        relationType: ANN_NEIGHBOR_RELATION_TYPE,
        ...makeEdge(1),
      },
      true,
    );
    const freshEdge = staleMetadataRow(
      {
        relationType: ANN_NEIGHBOR_RELATION_TYPE,
        ...makeEdge(2),
      },
      false,
    );

    const executeQuery = vi
      .fn()
      .mockResolvedValueOnce([staleEdge, freshEdge])
      .mockResolvedValueOnce([staleEdge, freshEdge]);

    const executeWithReusedStatement = vi.fn().mockResolvedValue(undefined);
    const result = await cleanupAnnNeighborEdges(
      executeQuery,
      executeWithReusedStatement,
      {
        staleOnly: true,
      },
    );

    expect(result).toHaveProperty('deletedCount', 1);
    expect(executeWithReusedStatement).toHaveBeenCalledOnce();
    const [deleteQuery, deleteParams] = executeWithReusedStatement.mock.calls[0] as [
      string,
      Array<{ sourceId: string; targetId: string }>,
    ];
    expect(deleteQuery).toContain('MATCH (source), (target)');
    expect(deleteParams).toHaveLength(1);
    expect(deleteParams[0]).toMatchObject({ sourceId: staleEdge.sourceId, targetId: staleEdge.targetId });
  });

  it('keeps ANN_NEIGHBOR outside impact/dependency traversal relation sets', () => {
    expect(VALID_RELATION_TYPES.has(ANN_NEIGHBOR_RELATION_TYPE)).toBe(false);
    expect(DEFAULT_IMPACT_RELATION_TYPES.includes(ANN_NEIGHBOR_RELATION_TYPE)).toBe(false);
    expect(SAFE_EDIT_UPSTREAM_RELATION_TYPES.includes(ANN_NEIGHBOR_RELATION_TYPE)).toBe(false);
    expect(SAFE_EDIT_DOWNSTREAM_RELATION_TYPES.includes(ANN_NEIGHBOR_RELATION_TYPE)).toBe(false);
  });
});
