import { describe, expect, it, vi } from 'vitest';

import { runAnnNeighborFrontierSearch } from '../../src/core/search/semantic-frontier-adapter.js';

const makeMetadataRow = (sourceId: string, targetId: string, rank: number) => ({
  sourceId,
  targetId,
  score: 0.91 - rank * 0.1,
  rank,
  reason: JSON.stringify({
    model: 'test-model',
    sourceContentHash: `source-${sourceId}`,
    targetContentHash: `target-${targetId}`,
    builtAt: '2026-06-09T00:00:00.000Z',
    buildId: 'build-id',
    isStale: false,
    staleReasons: [],
  }),
});

describe('runAnnNeighborFrontierSearch', () => {
  it('returns explicit disabled fallback without loading ANN edges', async () => {
    const executeQuery = vi.fn().mockResolvedValue([]);

    const result = await runAnnNeighborFrontierSearch(
      executeQuery,
      'repo',
      '/tmp/repo',
      [1, 0],
      [{ nodeId: 'seed-a', vector: [1, 0], lanes: ['seed-a'] }],
      {
        maxVisited: 128,
        enabled: false,
      },
    );

    expect(executeQuery).not.toHaveBeenCalled();
    expect(result.fallbackReason).toBe('symbol-neighborhood-frontier-disabled');
    expect(result.truncated).toBe(false);
    expect(result.visited).toBe(0);
  });

  it('loads ANN edges and runs frontier once when enabled', async () => {
    const executeQuery = vi.fn().mockResolvedValue([makeMetadataRow('seed-a', 'ann-1', 1)]);
    const frontier = vi.fn(async () => ({
      repo: 'repo',
      repoPath: '/tmp/repo',
      mode: 'ann',
      embeddingReady: true,
      indexFreshness: 'fresh',
      visited: 1,
      maxVisited: 10,
      truncated: false,
      seedLanes: ['seed-a'],
      warnings: [],
      results: [],
      fallbackReason: undefined,
    }));

    await runAnnNeighborFrontierSearch(
      executeQuery,
      'repo',
      '/tmp/repo',
      [1, 0],
      [{ nodeId: 'seed-a', vector: [1, 0], lanes: ['seed-a'] }],
      {
        enabled: true,
        frontierSearch: frontier,
        topK: 10,
      },
    );

    expect(executeQuery).toHaveBeenCalledTimes(1);
    expect(frontier).toHaveBeenCalledTimes(1);
    expect(frontier).toHaveBeenCalledWith(
      expect.objectContaining({
        repo: 'repo',
        repoPath: '/tmp/repo',
        topK: 10,
        edges: expect.arrayContaining([
          expect.objectContaining({
            fromId: 'seed-a',
            toId: 'ann-1',
          }),
        ]),
      }),
    );
  });

  it('returns frontier fallback diagnostics when ANN edges are empty', async () => {
    const executeQuery = vi.fn().mockResolvedValue([]);
    const result = await runAnnNeighborFrontierSearch(
      executeQuery,
      'repo',
      '/tmp/repo',
      [1, 0],
      [{ nodeId: 'seed-a', vector: [1, 0], lanes: ['seed-a'] }],
      {
        enabled: true,
      },
    );

    expect(executeQuery).toHaveBeenCalledTimes(1);
    expect(result.fallbackReason).toBe('neighbor-source-missing');
    expect(result.visited).toBe(0);
    expect(result.truncated).toBe(false);
    expect(result.results).toHaveLength(0);
  });
});
