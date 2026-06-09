import { describe, it, expect } from 'vitest';
import { UndirectedGraph } from 'graphology';
import seedrandom from 'seedrandom';
import { createRequire } from 'node:module';

const _require = createRequire(import.meta.url);
const leiden = _require('../../vendor/leiden/index.cjs') as {
  detailed: (
    graph: UndirectedGraph,
    options: Record<string, unknown>,
  ) => { communities: Record<string, number>; count: number; modularity: number };
};

describe('Leiden RNG seeding — determinism', () => {
  it('produces identical community assignments for same seed', () => {
    const graph = new UndirectedGraph();
    ['a', 'b', 'c', 'd', 'e', 'f'].forEach((n) => graph.addNode(n));
    [
      ['a', 'b'],
      ['b', 'c'],
      ['a', 'c'],
      ['d', 'e'],
      ['e', 'f'],
      ['d', 'f'],
    ].forEach(([u, v]) => graph.addEdge(u, v));

    const r1 = leiden.detailed(graph, {
      resolution: 1.0,
      maxIterations: 0,
      rng: seedrandom('ontoindex-v5'),
    });
    const r2 = leiden.detailed(graph, {
      resolution: 1.0,
      maxIterations: 0,
      rng: seedrandom('ontoindex-v5'),
    });
    expect(r1.communities).toEqual(r2.communities);
  });
});
