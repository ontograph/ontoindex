import { describe, it, expect } from 'vitest';
import { mergeSymbolsWithRRF, type EnrichedSymbolRow } from '../../src/core/search/symbol-merge.js';

// RRF score for rank-1 result (i=0): 1 / (60 + 0 + 1) = 1/61
const RRF_RANK1 = 1 / 61;
// RRF score for rank-2 result (i=1): 1 / (60 + 1 + 1) = 1/62
const RRF_RANK2 = 1 / 62;

function makeRow(nodeId: string, filePath = 'src/foo.ts'): EnrichedSymbolRow {
  return { nodeId, filePath };
}

describe('mergeSymbolsWithRRF', () => {
  it('BM25-only: rank-0 result gets score 1/(60+1)', () => {
    const bm25: EnrichedSymbolRow[] = [makeRow('n1')];
    const result = mergeSymbolsWithRRF(bm25, [], 10);
    expect(result).toHaveLength(1);
    expect(result[0][1].score).toBeCloseTo(RRF_RANK1, 10);
  });

  it('semantic-only: rank-0 result gets score 1/(60+1)', () => {
    const sem: EnrichedSymbolRow[] = [makeRow('n2')];
    const result = mergeSymbolsWithRRF([], sem, 10);
    expect(result).toHaveLength(1);
    expect(result[0][1].score).toBeCloseTo(RRF_RANK1, 10);
  });

  it('result in both lists gets sum of RRF scores', () => {
    const row = makeRow('shared');
    const result = mergeSymbolsWithRRF([row], [row], 10);
    expect(result).toHaveLength(1);
    expect(result[0][1].score).toBeCloseTo(RRF_RANK1 + RRF_RANK1, 10);
  });

  it('results sorted descending by score', () => {
    // n1 appears only in semantic at rank 0; n2 appears in both at rank 1 → n2 wins
    const bm25: EnrichedSymbolRow[] = [makeRow('n2')];
    const sem: EnrichedSymbolRow[] = [makeRow('n1'), makeRow('n2')];
    // n1: 1/61; n2 (bm25 rank-0) + (semantic rank-1) = 1/61 + 1/62
    const result = mergeSymbolsWithRRF(bm25, sem, 10);
    expect(result[0][0]).toBe('n2');
    expect(result[1][0]).toBe('n1');
  });

  it('limit is honored', () => {
    const bm25: EnrichedSymbolRow[] = [makeRow('a'), makeRow('b'), makeRow('c')];
    const result = mergeSymbolsWithRRF(bm25, [], 2);
    expect(result).toHaveLength(2);
  });

  it('data field carries the original row object', () => {
    const row: EnrichedSymbolRow = {
      nodeId: 'nx',
      filePath: 'src/x.ts',
      name: 'myFn',
      type: 'Function',
    };
    const result = mergeSymbolsWithRRF([row], [], 10);
    expect(result[0][1].data).toBe(row);
  });

  it('when same nodeId in both lists, data comes from BM25 list (first seen)', () => {
    const bm25Row: EnrichedSymbolRow = { nodeId: 'shared', filePath: 'a.ts', name: 'fromBM25' };
    const semRow: EnrichedSymbolRow = { nodeId: 'shared', filePath: 'a.ts', name: 'fromSemantic' };
    const result = mergeSymbolsWithRRF([bm25Row], [semRow], 10);
    expect(result).toHaveLength(1);
    // BM25 was first — its entry is retained in scoreMap
    expect(result[0][1].data.name).toBe('fromBM25');
  });

  it('falls back to filePath as key when nodeId is absent', () => {
    const row: EnrichedSymbolRow = { filePath: 'src/file.ts' }; // no nodeId
    const result = mergeSymbolsWithRRF([row], [row], 10);
    expect(result).toHaveLength(1); // deduped by filePath
    expect(result[0][0]).toBe('src/file.ts');
    // Score should be sum of both appearances
    expect(result[0][1].score).toBeCloseTo(RRF_RANK1 + RRF_RANK1, 10);
  });

  it('returns entries-style pairs [key, {score, data}]', () => {
    const row = makeRow('n1');
    const result = mergeSymbolsWithRRF([row], [], 10);
    // Must satisfy: for (const [, item] of merged) — item has .score and .data
    for (const [key, item] of result) {
      expect(typeof key).toBe('string');
      expect(typeof item.score).toBe('number');
      expect(item.data).toBeDefined();
    }
  });

  it('empty inputs return empty array', () => {
    expect(mergeSymbolsWithRRF([], [], 10)).toHaveLength(0);
  });

  it('second rank result has lower score than first rank', () => {
    const bm25: EnrichedSymbolRow[] = [makeRow('n1'), makeRow('n2')];
    const result = mergeSymbolsWithRRF(bm25, [], 10);
    expect(result[0][1].score).toBeGreaterThan(result[1][1].score);
    expect(result[0][1].score).toBeCloseTo(RRF_RANK1, 10);
    expect(result[1][1].score).toBeCloseTo(RRF_RANK2, 10);
  });

  it('trace mode records per-source contributions without changing order', () => {
    const bm25: EnrichedSymbolRow[] = [
      { nodeId: 'shared', filePath: 'src/shared.ts', bm25Score: 11 },
      { nodeId: 'bm25-only', filePath: 'src/bm25.ts', bm25Score: 7 },
    ];
    const sem: EnrichedSymbolRow[] = [
      {
        nodeId: 'shared',
        filePath: 'src/shared.ts',
        name: 'shared',
        distance: 0.2,
      } as EnrichedSymbolRow,
      {
        nodeId: 'semantic-only',
        filePath: 'src/semantic.ts',
        name: 'semanticOnly',
        distance: 0.4,
      } as EnrichedSymbolRow,
    ];

    const withoutTrace = mergeSymbolsWithRRF(bm25, sem, 10);
    const withTrace = mergeSymbolsWithRRF(bm25, sem, 10, { includeTrace: true });

    expect(withTrace.map(([key]) => key)).toEqual(withoutTrace.map(([key]) => key));
    const shared = withTrace.find(([key]) => key === 'shared');
    expect(shared?.[1].trace).toEqual([
      { source: 'bm25', rank: 1, rawScore: 11, weight: 1, contribution: RRF_RANK1 },
      { source: 'semantic', rank: 1, rawScore: 0.8, weight: 1, contribution: RRF_RANK1 },
    ]);
  });
});
