/**
 * Hybrid Search with Reciprocal Rank Fusion (RRF)
 *
 * Combines BM25 (keyword) and semantic (embedding) search results.
 * Uses RRF to merge rankings without needing score normalization.
 *
 * This is the same approach used by Elasticsearch, Pinecone, and other
 * production search systems.
 */

import { searchFTSFromLbug, type BM25SearchResult } from './bm25-index.js';
import type { SemanticSearchResult } from '../embeddings/types.js';
import { getFileSkeleton } from './skeleton.js';
import type { RRFTraceEntry } from './symbol-merge.js';

/**
 * RRF constant - standard value used in the literature
 * Higher values give more weight to lower-ranked results
 */
const RRF_K = 60;

export interface HybridSearchResult {
  filePath: string;
  score: number; // RRF score
  rank: number; // Final rank
  sources: ('bm25' | 'semantic')[]; // Which methods found this
  trace?: RRFTraceEntry[];
  summary?: string; // AST skeleton of the file

  // Metadata from semantic search (if available)
  nodeId?: string;
  name?: string;
  label?: string;
  startLine?: number;
  endLine?: number;

  // Original scores for debugging
  bm25Score?: number;
  semanticScore?: number;
}

type HybridQueryResult<Row = unknown> = Row[];
type HybridQueryExecutor<Row = unknown> = (cypher: string) => Promise<HybridQueryResult<Row>>;
type HybridSemanticSearch<Row = unknown> = (
  executeQuery: HybridQueryExecutor<Row>,
  query: string,
  k?: number,
) => Promise<SemanticSearchResult[]>;

const executeSemanticSearch = <Row>(
  semanticSearch: HybridSemanticSearch<Row>,
  executeQuery: HybridQueryExecutor<Row>,
  query: string,
  limit: number,
): Promise<SemanticSearchResult[]> => semanticSearch(executeQuery, query, limit);

function appendTrace(
  item: HybridSearchResult,
  source: 'bm25' | 'semantic',
  rank: number,
  rawScore: number,
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
 * Perform hybrid search combining BM25 and semantic results
 *
 * @param bm25Results - Results from BM25 keyword search
 * @param semanticResults - Results from semantic/embedding search
 * @param limit - Maximum results to return
 * @returns Merged and re-ranked results
 */
export const mergeWithRRF = (
  bm25Results: BM25SearchResult[],
  semanticResults: SemanticSearchResult[],
  limit: number = 10,
  options: { includeTrace?: boolean } = {},
): HybridSearchResult[] => {
  const includeTrace = options.includeTrace === true;
  const merged = new Map<string, HybridSearchResult>();

  // Process BM25 results
  for (let i = 0; i < bm25Results.length; i++) {
    const r = bm25Results[i];
    const rrfScore = 1 / (RRF_K + i + 1); // i+1 because rank starts at 1

    merged.set(r.filePath, {
      filePath: r.filePath,
      score: rrfScore,
      rank: 0, // Will be set after sorting
      sources: ['bm25'],
      bm25Score: r.score,
    });
    if (includeTrace) {
      appendTrace(merged.get(r.filePath)!, 'bm25', i + 1, r.score, rrfScore);
    }
  }

  // Process semantic results and merge
  for (let i = 0; i < semanticResults.length; i++) {
    const r = semanticResults[i];
    const rrfScore = 1 / (RRF_K + i + 1);

    const existing = merged.get(r.filePath);
    if (existing) {
      // Found by both methods - add scores
      existing.score += rrfScore;
      existing.sources.push('semantic');
      existing.semanticScore = 1 - r.distance;

      // Add semantic metadata
      existing.nodeId = r.nodeId;
      existing.name = r.name;
      existing.label = r.label;
      existing.startLine = r.startLine;
      existing.endLine = r.endLine;
      if (includeTrace) {
        appendTrace(existing, 'semantic', i + 1, 1 - r.distance, rrfScore);
      }
    } else {
      // Only found by semantic
      merged.set(r.filePath, {
        filePath: r.filePath,
        score: rrfScore,
        rank: 0,
        sources: ['semantic'],
        semanticScore: 1 - r.distance,
        nodeId: r.nodeId,
        name: r.name,
        label: r.label,
        startLine: r.startLine,
        endLine: r.endLine,
      });
      if (includeTrace) {
        appendTrace(merged.get(r.filePath)!, 'semantic', i + 1, 1 - r.distance, rrfScore);
      }
    }
  }

  // Sort by RRF score descending
  const sorted = Array.from(merged.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  // Assign final ranks
  sorted.forEach((r, i) => {
    r.rank = i + 1;
  });

  return sorted;
};

/**
 * Check if hybrid search is available
 * LadybugDB FTS is always available once the database is initialized.
 * Semantic search is optional - hybrid works with just FTS if embeddings aren't ready.
 */

/**
 * Execute BM25 + semantic search and merge with RRF.
 * Uses LadybugDB FTS for always-fresh BM25 results (no cached data).
 * The semanticSearch function is injected to keep this module environment-agnostic.
 */
export const hybridSearch = async <Row = unknown>(
  query: string,
  limit: number,
  executeQuery: HybridQueryExecutor<Row>,
  semanticSearch: HybridSemanticSearch<Row>,
  repoId?: string,
): Promise<HybridSearchResult[]> => {
  // Use LadybugDB FTS for always-fresh BM25 results
  const bm25Results = await searchFTSFromLbug(query, limit, repoId);
  const semanticResults = await executeSemanticSearch(semanticSearch, executeQuery, query, limit);
  const merged = mergeWithRRF(bm25Results, semanticResults, limit);

  // Populate summaries (skeletons) for top results if repoId is available
  if (repoId) {
    await Promise.all(
      merged.slice(0, 5).map(async (r) => {
        r.summary = await getFileSkeleton(repoId, r.filePath);
      }),
    );
  }

  return merged;
};
