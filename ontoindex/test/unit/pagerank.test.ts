/**
 * Unit Tests: Personalized PageRank
 *
 * Tests the core algorithm used by the repomap MCP tool.
 */
import { describe, it, expect } from 'vitest';
import { personalizedPageRank, buildFullAdjacency } from '../../src/core/graph/pagerank.js';

describe('personalizedPageRank', () => {
  it('returns empty map for empty graph', () => {
    const scores = personalizedPageRank(new Map(), new Map(), new Set());
    expect(scores.size).toBe(0);
  });

  it('assigns higher scores to seed nodes', () => {
    // A -> B -> C (linear chain)
    const adj = new Map<string, Set<string>>([
      ['A', new Set(['B'])],
      ['B', new Set(['C'])],
    ]);
    const rev = new Map<string, Set<string>>([
      ['B', new Set(['A'])],
      ['C', new Set(['B'])],
    ]);

    const scores = personalizedPageRank(adj, rev, new Set(['A']));

    // A should have highest score (it's the seed)
    expect(scores.get('A')!).toBeGreaterThan(scores.get('C')!);
  });

  it('ranks neighbors of seed higher than distant nodes', () => {
    // Star: A -> B, A -> C, A -> D, D -> E
    const adj = new Map<string, Set<string>>([
      ['A', new Set(['B', 'C', 'D'])],
      ['D', new Set(['E'])],
    ]);
    const rev = new Map<string, Set<string>>([
      ['B', new Set(['A'])],
      ['C', new Set(['A'])],
      ['D', new Set(['A'])],
      ['E', new Set(['D'])],
    ]);

    const scores = personalizedPageRank(adj, rev, new Set(['A']));

    // B (direct callee of seed) should score higher than E (2 hops away)
    expect(scores.get('B')!).toBeGreaterThan(scores.get('E')!);
  });

  it('handles multiple seeds', () => {
    // A -> C, B -> C (both A and B are seeds)
    const adj = new Map<string, Set<string>>([
      ['A', new Set(['C'])],
      ['B', new Set(['C'])],
    ]);
    const rev = new Map<string, Set<string>>([['C', new Set(['A', 'B'])]]);

    const scores = personalizedPageRank(adj, rev, new Set(['A', 'B']));

    // C should have high score (called by both seeds)
    expect(scores.get('C')!).toBeGreaterThan(0);
    // Both seeds should have similar scores
    expect(Math.abs(scores.get('A')! - scores.get('B')!)).toBeLessThan(0.01);
  });

  it('converges within max iterations', () => {
    // Large-ish cycle: A -> B -> C -> D -> A
    const adj = new Map<string, Set<string>>([
      ['A', new Set(['B'])],
      ['B', new Set(['C'])],
      ['C', new Set(['D'])],
      ['D', new Set(['A'])],
    ]);
    const rev = new Map<string, Set<string>>([
      ['B', new Set(['A'])],
      ['C', new Set(['B'])],
      ['D', new Set(['C'])],
      ['A', new Set(['D'])],
    ]);

    const scores = personalizedPageRank(adj, rev, new Set(['A']), { maxIterations: 50 });

    // All scores should be positive and finite
    for (const [_, score] of scores) {
      expect(score).toBeGreaterThan(0);
      expect(Number.isFinite(score)).toBe(true);
    }
  });
});

describe('buildFullAdjacency', () => {
  it('builds adjacency from relationship list', () => {
    const rels = [
      { sourceId: 'A', targetId: 'B', type: 'CALLS' },
      { sourceId: 'B', targetId: 'C', type: 'IMPORTS' },
      { sourceId: 'A', targetId: 'C', type: 'CONTAINS' }, // Should be excluded
    ];

    const { adjacency, reverse } = buildFullAdjacency(rels);

    expect(adjacency.get('A')?.has('B')).toBe(true);
    expect(adjacency.get('B')?.has('C')).toBe(true);
    // CONTAINS should be excluded
    expect(adjacency.get('A')?.has('C')).toBeFalsy();

    expect(reverse.get('B')?.has('A')).toBe(true);
    expect(reverse.get('C')?.has('B')).toBe(true);
  });

  it('handles empty input', () => {
    const { adjacency, reverse } = buildFullAdjacency([]);
    expect(adjacency.size).toBe(0);
    expect(reverse.size).toBe(0);
  });
});
