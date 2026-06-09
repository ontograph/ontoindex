import { describe, expect, it } from 'vitest';
import {
  buildReachabilityAdjacency,
  collectNextFrontierFromRows,
  collectReachableIds,
} from '../../src/mcp/local/backend-dead-code-reachability.js';

describe('dead-code reachability kernel', () => {
  it('marks reachable ids from normalized edge rows without DB access', () => {
    const adjacency = buildReachabilityAdjacency([
      { sourceId: 'root', targetId: 'a' },
      { sourceId: 'a', targetId: 'b' },
      { sourceId: 'dead', targetId: 'island' },
      { sourceId: 'b', targetId: 'a' },
    ]);

    expect([...collectReachableIds(new Set(['root']), adjacency)].sort()).toEqual([
      'a',
      'b',
      'root',
    ]);
  });

  it('collects a frontier from lbug object and tuple rows', () => {
    const visited = new Set(['already-seen']);

    expect(
      collectNextFrontierFromRows(
        [{ id: 'a' }, ['b'], { id: 'already-seen' }, { id: 42 }, []],
        visited,
      ),
    ).toEqual(['a', 'b']);
    expect([...visited].sort()).toEqual(['a', 'already-seen', 'b']);
  });
});
