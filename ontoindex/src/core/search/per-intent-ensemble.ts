/**
 * Per-intent ensemble scoring for v13 P1.
 *
 * Implements weighted Reciprocal Rank Fusion over BM25 + vector legs with
 * per-intent weight tables.  Graph (step-2) and CE (step-3) legs are NOT
 * wired in step-1; their weights are defined here but their scores are always
 * passed as 0 until the respective steps add the legs.
 *
 * Key correctness properties (step-1):
 *  - BM25-first iteration order (Attack 2 fix): matches symbol-merge.ts:40-62
 *    so the `ambiguous` row is field-level identical to mergeSymbolsWithRRF.
 *  - Confidence soft-gate at 0.7 (Attack 3 fix): low-confidence intent → ambiguous weights.
 *  - Rev 2 weight table (Attack 1 fix): cross-file-impact vec = 0.10 (not 0.30).
 *  - MIN_VEC_POOL_SIZE exported for step-3 CE thin-pool guard (G2 / Confirmation 2).
 */

import type { EnrichedSymbolRow, RRFTraceEntry, RRFTraceSource } from './symbol-merge.js';
import { Intent } from './intent-classifier.js';

export type { Intent };

export type IntentLabel = Intent;

type TraceableEnrichedSymbolRow = EnrichedSymbolRow & {
  distance?: number;
  score?: number;
  semanticScore?: number;
};

export interface EnsembleWeights {
  bm25: number;
  vec: number;
  graph: number;
  ce: number;
}

/**
 * Per-intent weight table (rev 2).
 *
 * Each row sums to 1.0.  Graph and CE weights are non-zero in the table so
 * steps 2 and 3 can use them; in step-1 the callers pass graphResults=[] and
 * ceScores=[] so those legs contribute 0 to the final score.
 *
 * Rev 2 changes vs rev 1:
 *  - cross-file-impact: vec 0.30 → 0.10, bm25 0.20 → 0.30, graph 0.50 → 0.60
 *    (snowflake-384d default; jina mismatch would cause empty vec results)
 */
export const INTENT_WEIGHTS: Record<IntentLabel, EnsembleWeights> = {
  'calls-of': { bm25: 0.55, vec: 0.1, graph: 0.35, ce: 0.0 },
  'cross-file-impact': { bm25: 0.3, vec: 0.1, graph: 0.6, ce: 0.0 }, // rev 2: vec 0.30→0.10
  'nl-conceptual': { bm25: 0.2, vec: 0.5, graph: 0.0, ce: 0.3 },
  ambiguous: { bm25: 0.5, vec: 0.5, graph: 0.0, ce: 0.0 },
};

/**
 * Minimum vector pool size required to permit CE reranking (G2 / Confirmation 2 fix).
 *
 * If semanticResults.length < MIN_VEC_POOL_SIZE the CE weight is suppressed
 * for that query regardless of intent classification.  This prevents CE-on-thin-pool
 * degenerate results (the v12 W2c catastrophe pattern).
 *
 * Default 5; env-overridable via ONTOINDEX_VEC_POOL_MIN.
 * NOTE: not used in step-1 (CE not wired). Defined here for step-3 import.
 */
export const MIN_VEC_POOL_SIZE: number = (() => {
  const raw = process.env.ONTOINDEX_VEC_POOL_MIN;
  if (raw !== undefined) {
    const n = parseInt(raw, 10);
    if (!isNaN(n) && n > 0) return n;
  }
  return 5;
})();

/**
 * Resolve effective weights for a given intent and confidence.
 *
 * Attack 3 fix (soft-gate): if confidence < 0.7, force route to `ambiguous`
 * weights regardless of the intent label.  The `ambiguous` row is the v12 RRF
 * default — routing to it can never make things worse than v12.
 *
 * Env override: ONTOINDEX_INTENT_WEIGHTS_JSON may contain a JSON object with
 * partial or full weight overrides keyed by intent label.  On parse error the
 * override is silently ignored and the table defaults apply.
 */
function resolveWeights(intent: IntentLabel, confidence?: number): EnsembleWeights {
  const effectiveIntent: IntentLabel =
    confidence !== undefined && confidence < 0.7 ? 'ambiguous' : intent;

  // Start from the built-in table.
  const base: EnsembleWeights = { ...INTENT_WEIGHTS[effectiveIntent] };

  // Apply env-level overlay (for W1c weight sweeps without recompilation).
  const overrideJson = process.env.ONTOINDEX_INTENT_WEIGHTS_JSON;
  if (overrideJson) {
    try {
      const overlay = JSON.parse(overrideJson) as Partial<
        Record<IntentLabel, Partial<EnsembleWeights>>
      >;
      const intentOverride = overlay[effectiveIntent];
      if (intentOverride && typeof intentOverride === 'object') {
        if (typeof intentOverride.bm25 === 'number') base.bm25 = intentOverride.bm25;
        if (typeof intentOverride.vec === 'number') base.vec = intentOverride.vec;
        if (typeof intentOverride.graph === 'number') base.graph = intentOverride.graph;
        if (typeof intentOverride.ce === 'number') base.ce = intentOverride.ce;
      }
    } catch {
      // silently ignore malformed JSON
    }
  }

  return base;
}

function getTraceRawScore(
  result: TraceableEnrichedSymbolRow,
  source: RRFTraceSource,
  fallback?: number,
): number | null {
  if (source === 'bm25') {
    return typeof result.bm25Score === 'number' ? result.bm25Score : (fallback ?? null);
  }
  if (source === 'semantic') {
    if (typeof result.semanticScore === 'number') return result.semanticScore;
    if (typeof result.score === 'number') return result.score;
    if (typeof result.distance === 'number') return 1 - result.distance;
  }
  if (source === 'ce') return fallback ?? null;
  if (source === 'graph' && typeof result.score === 'number') return result.score;
  return fallback ?? null;
}

function appendTrace(
  item: { trace?: RRFTraceEntry[] },
  source: RRFTraceSource,
  rank: number,
  rawScore: number | null,
  weight: number,
  contribution: number,
): void {
  const entry: RRFTraceEntry = { source, rank, rawScore, weight, contribution };
  if (item.trace) {
    item.trace.push(entry);
  } else {
    item.trace = [entry];
  }
}

/**
 * Apply per-intent weighted RRF ensemble.
 *
 * BM25 + vector legs are the base.  Graph leg (step-2) and CE leg (step-3) are
 * wired via the respective optional parameters; passing [] for either is a no-op.
 *
 * Iteration order (Attack 2 fix): BM25 first, then semantic.  For symbols
 * appearing in both lists the BM25 `data` field wins — matches symbol-merge.ts:40-62
 * exactly, guaranteeing field-level byte-identity for the `ambiguous` row.
 *
 * CE alignment (step-3 fix): ceScores[i] is aligned to ceResults[i], NOT to
 * graphResults[i].  ceResults must be the top-N slice of semanticResults so
 * that CE scores are applied to the correct candidate objects.
 *
 * @param intent          - Intent label from classifyIntent().intent
 * @param bm25Results     - Ranked BM25 results (index 0 = rank 1)
 * @param semanticResults - Ranked vector results (index 0 = rank 1)
 * @param limit           - Maximum results to return
 * @param confidence      - Classifier confidence (optional); < 0.7 forces ambiguous weights
 * @param graphResults    - Graph traversal results (step-2; pass [] to skip)
 * @param ceScores        - CE rerank scores aligned to ceResults by index (step-3; pass [] to skip)
 * @param ceResults       - CE candidate rows aligned to ceScores; must be top-N of semanticResults
 */
export function applyEnsemble(
  intent: IntentLabel,
  bm25Results: EnrichedSymbolRow[],
  semanticResults: EnrichedSymbolRow[],
  limit: number,
  confidence?: number,
  graphResults: EnrichedSymbolRow[] = [],
  ceScores: number[] = [],
  ceResults: EnrichedSymbolRow[] = [],
  options: { includeTrace?: boolean } = {},
): Array<[string, { score: number; data: EnrichedSymbolRow; trace?: RRFTraceEntry[] }]> {
  const weights = resolveWeights(intent, confidence);
  const includeTrace = options.includeTrace === true;

  const scoreMap = new Map<
    string,
    { score: number; data: EnrichedSymbolRow; trace?: RRFTraceEntry[] }
  >();

  // --- BM25 leg (iterate first — Attack 2 fix: BM25 data preference) ---
  for (let i = 0; i < bm25Results.length; i++) {
    const result = bm25Results[i];
    const key = result.nodeId || result.filePath;
    const rrfScore = weights.bm25 * (1 / (60 + i + 1));
    const existing = scoreMap.get(key);
    if (existing) {
      existing.score += rrfScore;
      // BM25 data already set (BM25 wins — do not overwrite)
    } else {
      scoreMap.set(key, { score: rrfScore, data: result });
    }
    if (includeTrace) {
      appendTrace(
        existing ?? scoreMap.get(key)!,
        'bm25',
        i + 1,
        getTraceRawScore(result, 'bm25'),
        weights.bm25,
        rrfScore,
      );
    }
  }

  // --- Vector leg (iterate second — BM25 data wins for tied keys) ---
  for (let i = 0; i < semanticResults.length; i++) {
    const result = semanticResults[i];
    const key = result.nodeId || result.filePath;
    const rrfScore = weights.vec * (1 / (60 + i + 1));
    const existing = scoreMap.get(key);
    if (existing) {
      existing.score += rrfScore;
      // Do not overwrite existing.data — BM25 data preference preserved
    } else {
      scoreMap.set(key, { score: rrfScore, data: result });
    }
    if (includeTrace) {
      appendTrace(
        existing ?? scoreMap.get(key)!,
        'semantic',
        i + 1,
        getTraceRawScore(result as TraceableEnrichedSymbolRow, 'semantic'),
        weights.vec,
        rrfScore,
      );
    }
  }

  // --- Graph leg (step-2; no-op in step-1 because graphResults=[]) ---
  for (let i = 0; i < graphResults.length; i++) {
    const result = graphResults[i];
    const key = result.nodeId || result.filePath;
    const rrfScore = weights.graph * (1 / (60 + i + 1));
    const existing = scoreMap.get(key);
    if (existing) {
      existing.score += rrfScore;
    } else {
      scoreMap.set(key, { score: rrfScore, data: result });
    }
    if (includeTrace) {
      appendTrace(
        existing ?? scoreMap.get(key)!,
        'graph',
        i + 1,
        getTraceRawScore(result as TraceableEnrichedSymbolRow, 'graph'),
        weights.graph,
        rrfScore,
      );
    }
  }

  // --- CE leg (step-3; no-op when ceScores=[] or ceResults=[]) ---
  // ceScores[i] is aligned to ceResults[i] by index — ceResults must be the
  // top-N slice of semanticResults so that CE contributions are applied to the
  // correct candidate objects (NOT graphResults — that was the step-1 alignment bug).
  // CE score is sigmoid output [0,1]; use as-is (NOT RRF-style).
  for (let i = 0; i < ceScores.length && i < ceResults.length; i++) {
    const result = ceResults[i];
    const key = result.nodeId || result.filePath;
    const ceContrib = weights.ce * ceScores[i];
    const existing = scoreMap.get(key);
    if (existing) {
      existing.score += ceContrib;
    } else {
      scoreMap.set(key, { score: ceContrib, data: result });
    }
    if (includeTrace) {
      appendTrace(
        existing ?? scoreMap.get(key)!,
        'ce',
        i + 1,
        getTraceRawScore(result as TraceableEnrichedSymbolRow, 'ce', ceScores[i]),
        weights.ce,
        ceContrib,
      );
    }
  }

  return Array.from(scoreMap.entries())
    .sort((a, b) => b[1].score - a[1].score)
    .slice(0, limit);
}
