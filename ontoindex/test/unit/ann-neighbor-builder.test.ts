import { describe, it, expect } from 'vitest';
import {
  SAFE_EDIT_DOWNSTREAM_RELATION_TYPES,
  SAFE_EDIT_UPSTREAM_RELATION_TYPES,
  DEFAULT_IMPACT_RELATION_TYPES,
  VALID_RELATION_TYPES,
} from '../../src/core/impact/impact-kernel.js';
import {
  ANN_NEIGHBOR_RELATION_TYPE,
  buildAnnNeighborsFromEmbeddingRows,
  buildAnnNeighborsFromExplicitCandidates,
  ANN_NEIGHBOR_DEFAULT_OUTBOUND_DEGREE,
  type AnnEmbeddingRow,
  type AnnNeighborExplicitCandidate,
} from '../../src/core/embeddings/ann-neighbor.js';

const makeEmbedding = (
  overrides: Partial<AnnEmbeddingRow> = {},
): AnnEmbeddingRow => ({
  nodeId: 'Function:source:A',
  model: 'text-embedding-3-small',
  buildId: 'build-001',
  builtAt: '2026-06-09T00:00:00.000Z',
  contentHash: 'hash-source-a',
  embedding: [1, 0],
  ...overrides,
});

const makeCandidate = (
  overrides: Partial<AnnNeighborExplicitCandidate> = {},
): AnnNeighborExplicitCandidate => ({
  sourceId: 'Function:source:A',
  targetId: 'Function:target:B',
  score: 0.5,
  sourceContentHash: 'hash-source-a',
  targetContentHash: 'hash-target-b',
  ...overrides,
});

describe('buildAnnNeighborsFromEmbeddingRows', () => {
  it('limits outbound ANN_NEIGHBOR degree using default cap (ANN_NEIGHBOR_DEFAULT_OUTBOUND_DEGREE)', () => {
    const embeddings: AnnEmbeddingRow[] = [
      makeEmbedding(),
      ...Array.from({ length: 20 }, (_, index) =>
        makeEmbedding({
          nodeId: `Function:target:${String(index + 1).padStart(2, '0')}`,
          contentHash: `hash-target-${index + 1}`,
          embedding: [1, index + 1],
        }),
      ),
    ];

    const edges = buildAnnNeighborsFromEmbeddingRows({ embeddings }).filter(
      (edge) => edge.sourceId === 'Function:source:A',
    );

    expect(edges.length).toBe(ANN_NEIGHBOR_DEFAULT_OUTBOUND_DEGREE);
    expect(edges[0].targetId).toBe('Function:target:01');
    expect(edges[15].rank).toBe(16);
    expect(edges[0].score).toBeGreaterThan(edges[15].score);
  });

  it('propagates ANN metadata including model, hashes, buildId, builtAt, and stale status', () => {
    const source = makeEmbedding();
    const target = makeEmbedding({
      nodeId: 'Function:neighbor:target',
      contentHash: 'hash-target',
      embedding: [0.9, 0.1],
    });

    const [edge] = buildAnnNeighborsFromEmbeddingRows({
      embeddings: [source, target],
    }).filter((candidate) => candidate.sourceId === source.nodeId);

    expect(edge.relationType).toBe(ANN_NEIGHBOR_RELATION_TYPE);
    expect(edge.sourceId).toBe(source.nodeId);
    expect(edge.targetId).toBe(target.nodeId);
    expect(edge.model).toBe(target.model);
    expect(edge.sourceContentHash).toBe(source.contentHash);
    expect(edge.targetContentHash).toBe(target.contentHash);
    expect(edge.buildId).toBe(target.buildId);
    expect(edge.builtAt).toBe(target.builtAt);
    expect(edge.isStale).toBe(false);
    expect(edge.staleReasons).toEqual([]);
    expect(edge.rank).toBe(1);
  });

  it('excludes stale edges when stale content hash differs from current index hashes', () => {
    const source = makeEmbedding();
    const target = makeEmbedding({
      nodeId: 'Function:neighbor:target',
      contentHash: 'hash-target-old',
      embedding: [0.9, 0.1],
    });
    const edges = buildAnnNeighborsFromEmbeddingRows({
      embeddings: [source, target],
      currentContentHashByNodeId: new Map([
        ['Function:source:A', 'hash-source-a'],
        ['Function:neighbor:target', 'hash-target-fresh'],
      ]),
    });

    expect(edges).toHaveLength(0);
  });

  it('supports emitting stale edges when requested', () => {
    const source = makeEmbedding();
    const target = makeEmbedding({
      nodeId: 'Function:neighbor:target',
      contentHash: 'hash-target-old',
      embedding: [0.9, 0.1],
    });
    const edges = buildAnnNeighborsFromEmbeddingRows({
      embeddings: [source, target],
      includeStaleEdges: true,
      currentContentHashByNodeId: new Map([
        ['Function:source:A', 'hash-source-a'],
        ['Function:neighbor:target', 'hash-target-fresh'],
      ]),
    }).filter((edge) => edge.isStale);

    expect(edges).toHaveLength(2);
    expect(edges.every((edge) => edge.isStale)).toBe(true);
    expect(edges.some((edge) => edge.staleReasons.includes('target-content-hash-mismatch'))).toBe(
      true,
    );
    expect(edges.some((edge) => edge.staleReasons.includes('source-content-hash-mismatch'))).toBe(
      true,
    );
  });

  it('flags stale edges when build ids differ from current build ids', () => {
    const source = makeEmbedding({ buildId: 'build-old' });
    const target = makeEmbedding({
      nodeId: 'Function:neighbor:target',
      buildId: 'build-ancient',
      contentHash: 'hash-target',
      embedding: [0.9, 0.1],
    });
    const stale = buildAnnNeighborsFromEmbeddingRows({
      embeddings: [source, target],
      currentBuildIdByNodeId: new Map([
        ['Function:source:A', 'build-current'],
        ['Function:neighbor:target', 'build-current'],
      ]),
    });

    expect(stale).toHaveLength(0);

    const emitted = buildAnnNeighborsFromEmbeddingRows({
      embeddings: [source, target],
      includeStaleEdges: true,
      currentBuildIdByNodeId: new Map([
        ['Function:source:A', 'build-current'],
        ['Function:neighbor:target', 'build-current'],
      ]),
    });

    expect(emitted).toHaveLength(2);
    expect(emitted.every((edge) => edge.isStale)).toBe(true);
    expect(emitted.every((edge) => edge.staleReasons.includes('source-build-id-mismatch'))).toBe(true);
  });
});

describe('buildAnnNeighborsFromExplicitCandidates', () => {
  it('excludes self-edges before ranking and capping', () => {
    const edges = buildAnnNeighborsFromExplicitCandidates({
      model: 'text-embedding-3-small',
      buildId: 'build-001',
      builtAt: '2026-06-09T00:00:00.000Z',
      candidates: [
        makeCandidate({
          sourceId: 'Function:source:A',
          targetId: 'Function:source:A',
          score: 0.95,
        }),
        makeCandidate({
          sourceId: 'Function:source:A',
          targetId: 'Function:target:B',
          score: 0.4,
          targetContentHash: 'hash-b',
        }),
        makeCandidate({
          sourceId: 'Function:source:A',
          targetId: 'Function:target:C',
          score: 0.9,
          targetContentHash: 'hash-c',
        }),
      ],
      maxOutboundDegree: 1,
    });

    expect(edges).toHaveLength(1);
    expect(edges[0].sourceId).toBe('Function:source:A');
    expect(edges[0].targetId).toBe('Function:target:C');
    expect(edges[0].rank).toBe(1);
  });

  it('excludes stale explicit candidates unless stale edge output is requested', () => {
    const staleEdges = buildAnnNeighborsFromExplicitCandidates({
      model: 'text-embedding-3-small',
      buildId: 'build-001',
      builtAt: '2026-06-09T00:00:00.000Z',
      currentContentHashByNodeId: new Map([
        ['Function:source:A', 'hash-source-fresh'],
        ['Function:target:B', 'hash-target-b'],
      ]),
      candidates: [
        makeCandidate({
          sourceId: 'Function:source:A',
          targetId: 'Function:target:B',
          score: 0.75,
          sourceContentHash: 'hash-source-stale',
          targetContentHash: 'hash-target-b',
        }),
      ],
    });

    expect(staleEdges).toHaveLength(0);

    const allowedEdges = buildAnnNeighborsFromExplicitCandidates({
      model: 'text-embedding-3-small',
      buildId: 'build-001',
      builtAt: '2026-06-09T00:00:00.000Z',
      includeStaleEdges: true,
      currentContentHashByNodeId: new Map([
        ['Function:source:A', 'hash-source-fresh'],
        ['Function:target:B', 'hash-target-b'],
      ]),
      candidates: [
        makeCandidate({
          sourceId: 'Function:source:A',
          targetId: 'Function:target:B',
          score: 0.75,
          sourceContentHash: 'hash-source-stale',
          targetContentHash: 'hash-target-b',
        }),
      ],
    });

    expect(allowedEdges).toHaveLength(1);
    expect(allowedEdges[0].isStale).toBe(true);
    expect(allowedEdges[0].staleReasons).toContain('source-content-hash-mismatch');
  });
});

describe('ANN_NEIGHBOR relation type', () => {
  it('is not included in impact relation type filters', () => {
    expect(VALID_RELATION_TYPES.has(ANN_NEIGHBOR_RELATION_TYPE)).toBe(false);
    expect(DEFAULT_IMPACT_RELATION_TYPES.includes(ANN_NEIGHBOR_RELATION_TYPE)).toBe(false);
    expect(SAFE_EDIT_UPSTREAM_RELATION_TYPES.includes(ANN_NEIGHBOR_RELATION_TYPE)).toBe(false);
    expect(SAFE_EDIT_DOWNSTREAM_RELATION_TYPES.includes(ANN_NEIGHBOR_RELATION_TYPE)).toBe(false);
  });
});
