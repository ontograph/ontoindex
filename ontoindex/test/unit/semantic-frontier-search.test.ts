import { describe, expect, it, vi } from 'vitest';

import { semanticFrontierSearch } from '../../src/core/search/semantic-frontier-search.js';

describe('semanticFrontierSearch', () => {
  it('respects ef frontier bound for one-shot traversal', async () => {
    const result = await semanticFrontierSearch({
      repo: 'repo1',
      queryVector: [1, 0],
      ef: 2,
      maxVisited: 10,
      topK: 10,
      seeds: [
        {
          nodeId: 'seed-a',
          lanes: ['seed-a'],
          vector: [1, 0],
        },
        {
          nodeId: 'seed-b',
          lanes: ['seed-b'],
          vector: [1, 0],
        },
      ],
      edges: [
        {
          fromId: 'seed-a',
          toId: 'n1',
          score: 0.9,
          target: {
            nodeId: 'n1',
            vector: [1, 0],
            lanes: ['ann'],
          },
        },
        {
          fromId: 'seed-a',
          toId: 'n2',
          score: 0.8,
          target: {
            nodeId: 'n2',
            vector: [1, 0],
            lanes: ['ann'],
          },
        },
        {
          fromId: 'n1',
          toId: 'n3',
          target: {
            nodeId: 'n3',
            vector: [1, 0],
            lanes: ['ann'],
          },
        },
      ],
    });

    expect(result.truncated).toBe(true);
    expect(result.results.map((row) => row.nodeId)).toEqual(['n1', 'n2']);
    expect(result.fallbackReason).toBe('ef-cap');
  });

  it('respects maxVisited cap and reports truncation reason', async () => {
    const result = await semanticFrontierSearch({
      repo: 'repo1',
      queryVector: [1, 0],
      ef: 20,
      maxVisited: 1,
      topK: 10,
      seeds: [
        {
          nodeId: 'seed',
          lanes: ['seed'],
          vector: [1, 0],
        },
      ],
      edges: [
        {
          fromId: 'seed',
          toId: 'a',
          target: {
            nodeId: 'a',
            vector: [1, 0],
          },
        },
        {
          fromId: 'seed',
          toId: 'b',
          target: {
            nodeId: 'b',
            vector: [1, 0],
          },
        },
      ],
    });

    expect(result.truncated).toBe(true);
    expect(result.visited).toBe(1);
    expect(result.results).toHaveLength(1);
    expect(result.fallbackReason).toBe('maxVisited-cap');
  });

  it('scores and ranks candidates by similarity to queryVector', async () => {
    const result = await semanticFrontierSearch({
      repo: 'repo1',
      queryVector: [1, 0],
      topK: 3,
      ef: 10,
      maxVisited: 10,
      seeds: [
        {
          nodeId: 'seed',
          vector: [1, 0],
          lanes: ['seed'],
        },
      ],
      edges: [
        {
          fromId: 'seed',
          toId: 'best',
          target: {
            nodeId: 'best',
            vector: [1, 0],
          },
        },
        {
          fromId: 'seed',
          toId: 'middle',
          target: {
            nodeId: 'middle',
            vector: [1, 1],
          },
        },
        {
          fromId: 'seed',
          toId: 'worst',
          target: {
            nodeId: 'worst',
            vector: [-1, 0],
          },
        },
      ],
    });

    expect(result.results.map((row) => row.nodeId)).toEqual(['best', 'middle', 'worst']);
    expect(result.results[0].score).toBeGreaterThan(result.results[1].score);
    expect(result.results[1].score).toBeGreaterThan(result.results[2].score);
  });

  it('propagates and reports seed lanes', async () => {
    const result = await semanticFrontierSearch({
      repo: 'repo1',
      queryVector: [1, 0],
      topK: 5,
      ef: 10,
      maxVisited: 10,
      seeds: [
        {
          nodeId: 'seed-a',
          lanes: ['seed-a-lane'],
          vector: [1, 0],
        },
        {
          nodeId: 'seed-b',
          lanes: ['seed-b-lane'],
          vector: [1, 0],
        },
      ],
      edges: [
        {
          fromId: 'seed-a',
          toId: 'shared',
          target: {
            nodeId: 'shared',
            vector: [1, 0],
            lanes: ['edge-lane'],
          },
        },
        {
          fromId: 'seed-b',
          toId: 'shared',
          target: {
            nodeId: 'shared',
            vector: [1, 0],
            lanes: ['edge-lane'],
          },
        },
      ],
    });

    expect(result.seedLanes.sort()).toEqual(['seed-a-lane', 'seed-b-lane']);
    expect(result.results).toHaveLength(1);
    expect(result.results[0].lanes.sort()).toEqual(['edge-lane', 'seed-a-lane']);
  });

  it('calls neighbor provider exactly once for neighbor sourcing', async () => {
    const mockProvider = vi.fn(async () => [
      {
        fromId: 'seed',
        toId: 'ann-1',
        target: {
          nodeId: 'ann-1',
          vector: [1, 0],
        },
      },
    ]);

    await semanticFrontierSearch({
      repo: 'repo1',
      queryVector: [1, 0],
      topK: 5,
      seeds: [
        {
          nodeId: 'seed',
          vector: [1, 0],
          lanes: ['seed'],
        },
      ],
      neighborProvider: mockProvider,
      ef: 10,
      maxVisited: 10,
    });

    expect(mockProvider).toHaveBeenCalledTimes(1);
    expect(mockProvider).toHaveBeenCalledWith(
      'repo1',
      expect.arrayContaining([expect.objectContaining({ nodeId: 'seed' })]),
    );
  });
});
