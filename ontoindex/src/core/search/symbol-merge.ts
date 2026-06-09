/**
 * Post-enrichment symbol-row RRF merge.
 *
 * Merges BM25 and semantic search results that have already been enriched into
 * symbol rows (nodeId, name, type, filePath, …).  This is distinct from
 * mergeWithRRF in hybrid-search.ts, which operates on pre-enrichment file
 * primitives (BM25SearchResult / SemanticSearchResult).
 *
 * Formula: 1 / (60 + rank) where rank is 1-indexed (rank of first result = 1).
 */

export interface EnrichedSymbolRow {
  nodeId?: string;
  name?: string;
  type?: string;
  filePath: string;
  startLine?: number;
  endLine?: number;
  bm25Score?: number;
}

export type RRFTraceSource = 'bm25' | 'semantic' | 'graph' | 'ce';

export interface RRFTraceEntry {
  source: RRFTraceSource;
  rank: number;
  rawScore: number | null;
  weight: number;
  contribution: number;
}

type TraceableSymbolRow = EnrichedSymbolRow & {
  distance?: number;
  score?: number;
  semanticScore?: number;
};

function getTraceRawScore(result: TraceableSymbolRow, source: RRFTraceSource): number | null {
  if (source === 'bm25') {
    return typeof result.bm25Score === 'number' ? result.bm25Score : null;
  }
  if (source === 'semantic') {
    if (typeof result.semanticScore === 'number') return result.semanticScore;
    if (typeof result.score === 'number') return result.score;
    if (typeof result.distance === 'number') return 1 - result.distance;
  }
  return null;
}

function appendTrace(
  item: { trace?: RRFTraceEntry[] },
  source: RRFTraceSource,
  rank: number,
  rawScore: number | null,
  contribution: number,
): void {
  const entry: RRFTraceEntry = {
    source,
    rank,
    rawScore,
    weight: 1,
    contribution,
  };
  if (item.trace) {
    item.trace.push(entry);
  } else {
    item.trace = [entry];
  }
}

/**
 * Merge two ranked lists of enriched symbol rows using Reciprocal Rank Fusion.
 *
 * Returns an array of Map-style entries ([key, {score, data}]) sorted
 * descending by RRF score and sliced to `limit`.  The entries shape preserves
 * the existing `for (const [, item] of merged)` call-site in backend-search.ts.
 *
 * When the same symbol (same key) appears in both lists its RRF scores are
 * summed.  The `data` field is taken from the BM25 list when available;
 * otherwise from the semantic list.
 */
export function mergeSymbolsWithRRF(
  bm25Results: EnrichedSymbolRow[],
  semanticResults: EnrichedSymbolRow[],
  limit: number,
  options: { includeTrace?: boolean } = {},
): Array<[string, { score: number; data: EnrichedSymbolRow; trace?: RRFTraceEntry[] }]> {
  const includeTrace = options.includeTrace === true;
  const scoreMap = new Map<
    string,
    { score: number; data: EnrichedSymbolRow; trace?: RRFTraceEntry[] }
  >();

  for (let i = 0; i < bm25Results.length; i++) {
    const result = bm25Results[i];
    const key = result.nodeId || result.filePath;
    const rrfScore = 1 / (60 + i + 1); // rank is 1-indexed
    const existing = scoreMap.get(key);
    if (existing) {
      existing.score += rrfScore;
    } else {
      scoreMap.set(key, { score: rrfScore, data: result });
    }
    if (includeTrace) {
      appendTrace(
        existing ?? scoreMap.get(key)!,
        'bm25',
        i + 1,
        getTraceRawScore(result, 'bm25'),
        rrfScore,
      );
    }
  }

  for (let i = 0; i < semanticResults.length; i++) {
    const result = semanticResults[i];
    const key = result.nodeId || result.filePath;
    const rrfScore = 1 / (60 + i + 1); // rank is 1-indexed
    const existing = scoreMap.get(key);
    if (existing) {
      existing.score += rrfScore;
    } else {
      scoreMap.set(key, { score: rrfScore, data: result });
    }
    if (includeTrace) {
      appendTrace(
        existing ?? scoreMap.get(key)!,
        'semantic',
        i + 1,
        getTraceRawScore(result as TraceableSymbolRow, 'semantic'),
        rrfScore,
      );
    }
  }

  return Array.from(scoreMap.entries())
    .sort((a, b) => b[1].score - a[1].score)
    .slice(0, limit);
}
