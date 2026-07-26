import { bench, describe } from 'vitest';
import { mergeWithRRF } from '../../src/core/search/hybrid-search.js';
import type { BM25SearchResult } from '../../src/core/search/bm25-index.js';
import type { SemanticSearchResult } from '../../src/core/embeddings/types.js';

export const PRODUCTION_BENCHMARK = 'hybrid RRF merge of 10 BM25 and 10 semantic results';
export const CONTROL_BENCHMARK = 'control sort and slice of 20 numeric scores';

const RESULT_COUNT = 10;
const bm25Results: BM25SearchResult[] = Array.from({ length: RESULT_COUNT }, (_, index) => ({
  filePath: `src/search/result-${index}.ts`,
  score: RESULT_COUNT - index,
  rank: index + 1,
}));
const semanticResults: SemanticSearchResult[] = Array.from(
  { length: RESULT_COUNT },
  (_, index) => ({
    filePath: `src/search/result-${index + RESULT_COUNT / 2}.ts`,
    distance: index / RESULT_COUNT,
    nodeId: `Function:src/search/result-${index}.ts:query`,
    name: `query${index}`,
    label: 'Function',
    startLine: index + 1,
    endLine: index + 10,
  }),
);
const controlScores = Array.from(
  { length: RESULT_COUNT * 2 },
  (_, index) => ((index * 17) % (RESULT_COUNT * 2)) + index / 100,
);

describe('Query Benchmarks', () => {
  bench(PRODUCTION_BENCHMARK, () => mergeWithRRF(bm25Results, semanticResults, RESULT_COUNT), {
    time: 2000,
    warmupTime: 1000,
  });

  bench(
    CONTROL_BENCHMARK,
    () => controlScores.toSorted((left, right) => right - left).slice(0, RESULT_COUNT),
    { time: 2000, warmupTime: 1000 },
  );
});
