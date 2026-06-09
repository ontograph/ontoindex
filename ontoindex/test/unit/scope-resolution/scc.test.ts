import { describe, expect, it } from 'vitest';
import { tarjanSccs } from 'ontoindex-shared';

describe('tarjanSccs', () => {
  it('returns acyclic components in reverse-topological order', () => {
    const graph = new Map<string, ReadonlySet<string>>([
      ['a', new Set(['b'])],
      ['b', new Set(['c'])],
      ['c', new Set()],
    ]);

    expect(tarjanSccs(graph)).toEqual([
      { nodes: ['c'], isCycle: false },
      { nodes: ['b'], isCycle: false },
      { nodes: ['a'], isCycle: false },
    ]);
  });

  it('detects multi-node cycles and single-node self-loops', () => {
    const graph = new Map<string, ReadonlySet<string>>([
      ['a', new Set(['b'])],
      ['b', new Set(['a'])],
      ['self', new Set(['self'])],
    ]);

    expect(tarjanSccs(graph)).toEqual([
      { nodes: ['b', 'a'], isCycle: true },
      { nodes: ['self'], isCycle: true },
    ]);
  });

  it('preserves adjacency insertion order inside observable SCCs', () => {
    const graph = new Map<string, ReadonlySet<string>>([
      ['a', new Set(['c', 'b'])],
      ['b', new Set(['a'])],
      ['c', new Set(['a'])],
    ]);

    expect(tarjanSccs(graph)).toEqual([{ nodes: ['c', 'b', 'a'], isCycle: true }]);
  });
});
