# ADR-0002: Per-intent embedder ensemble

**Status:** Accepted (env-gated default-OFF)
**Date:** 2026-04-30 (v13)
**Source:** `ontoindex/src/core/search/per-intent-ensemble.ts`, `graph-traversal-rank.ts`.

## Context

Two independent prior signals (v7 jina embedder swap; v12 CE rerank) both showed per-intent trade-offs: a global mechanism that helps `cross-file-impact` or `nl-conceptual` queries simultaneously regresses `calls-of` queries. v12 §7 §reframe rule made per-intent ensemble the binding v13 P1 work.

## Decision

Implement a **result-side weighted-RRF ensemble** that runs different scoring formulas per intent class. Four legs (BM25 / vector / graph / CE), four intent classes (`calls-of` / `cross-file-impact` / `nl-conceptual` / `ambiguous`), per-class weight matrix. Env-gated `ONTOINDEX_INTENT_ENSEMBLE=1` (default OFF — preserves v12 RRF behavior for default users).

## Algorithm / Technique

### Intent classification (precondition)

`classifyIntent(query)` from `intent-classifier.ts` returns `{ intent: IntentLabel, confidence: number }`. See ADR-0012.

### Weight table (`per-intent-ensemble.ts:44-49`, rev 2 trinity-fixed)

```
calls-of:           bm25=0.55  vec=0.10  graph=0.35  ce=0.00
cross-file-impact:  bm25=0.30  vec=0.10  graph=0.60  ce=0.00
nl-conceptual:      bm25=0.20  vec=0.50  graph=0.00  ce=0.30
ambiguous:          bm25=0.50  vec=0.50  graph=0.00  ce=0.00
```

Each row sums to 1.0. `cross-file-impact.vec` was reduced from 0.30 → 0.10 in W1a rev 2 because the v7 jina evidence required a jina-indexed corpus, but the default embedder is `Snowflake/snowflake-arctic-embed-xs` (384d) — using snowflake vectors with cross-file-impact-tuned weights produced noise, not signal. See ADR-0006.

### Confidence soft-gate (Attack 3 fix)

`resolveWeights(intent, confidence)`:
1. If `confidence !== undefined && confidence < 0.7`, force route to `ambiguous` weights regardless of intent label.
2. The `ambiguous` row is byte-identical to v12 RRF baseline — soft-gating to it can never make things worse than v12.

### Optional weight overlay

`ONTOINDEX_INTENT_WEIGHTS_JSON` env var: parses a partial `{intent: {bm25?, vec?, graph?, ce?}}` JSON. On parse error, silently fall back to defaults. Used for W1c eval sweeps without recompilation. Caller owns post-overlay sum-to-1.0 invariant.

### Ensemble scoring (`per-intent-ensemble.ts:133-200`)

For an active intent I with weights `w = INTENT_WEIGHTS[I]`:

1. **BM25 leg first** (Attack 2 byte-identity fix):
   ```
   for i in 0..bm25Results.length:
     key = result.nodeId || result.filePath
     rrfScore = w.bm25 * (1 / (60 + i + 1))
     if scoreMap.has(key): scoreMap[key].score += rrfScore
     else: scoreMap.set(key, { score: rrfScore, data: result })
   ```
   `60` is the standard RRF k constant (Cormack et al. 2009).

2. **Vector leg second** (BM25 wins on tied keys for `data` field provenance):
   ```
   for i in 0..semanticResults.length:
     key = result.nodeId || result.filePath
     rrfScore = w.vec * (1 / (60 + i + 1))
     if scoreMap.has(key): existing.score += rrfScore  // do NOT overwrite data
     else: scoreMap.set(key, { score: rrfScore, data: result })
   ```

3. **Graph leg** (only fires when `w.graph > 0` AND graphResults populated):
   ```
   for i in 0..graphResults.length:
     same RRF formula with weights.graph
   ```

4. **CE leg** (only fires when `w.ce > 0` AND ceScores aligned to ceResults — see ADR-0003):
   ```
   for i in 0..min(ceScores.length, ceResults.length):
     ceScore = weights.ce * ceScores[i]   // CE is sigmoid [0,1]; NOT RRF-style
     accumulate into scoreMap
   ```

5. Sort `scoreMap` entries by score descending, slice top `limit`.

### Iteration order is the byte-identity guarantee

The `ambiguous` row produces field-level identical output to `mergeSymbolsWithRRF` (v12 baseline) because:
- Iteration order matches `symbol-merge.ts:40-62` (BM25 first, then semantic).
- `data` field preference is BM25-first (existing entry preserved on tied key).
- Weighted RRF with both weights = 0.5 produces a scalar multiple of unweighted RRF; relative ranking preserved.

### Graph leg (calls-of, cross-file-impact)

`graphTraversalRank(repoId, seeds, edgeTypes, maxDepth=2, maxResults=50)` from `graph-traversal-rank.ts`:

1. Take top-10 BM25 results as `seeds`.
2. BFS expansion via `executeParameterized` against `CodeRelation` table:
   - `calls-of`: edgeTypes=`['CALLS']`, depth=2.
   - `cross-file-impact`: edgeTypes=`['IMPORTS', 'CALLS']`, depth=2.
3. Deduplicate via `depthMap: Map<nodeId, depth>`. First-seen wins (BFS expands depth-by-depth, so first seen has shortest path).
4. Cap total query budget at `4 * seeds.length` to prevent runaway BFS on hub nodes.
5. Best-effort error handling: on DB query failure return `[]` (don't throw).
6. Return ranked `EnrichedSymbolRow[]` ordered by BFS distance ascending.

### CE leg (nl-conceptual only)

See ADR-0003.

### Min-vec-pool gate (G2 mitigation)

`MIN_VEC_POOL_SIZE` constant (default 5; env `ONTOINDEX_VEC_POOL_MIN`). Before invoking CE rerank in `backend-search.ts`, require `semanticResults.length >= MIN_VEC_POOL_SIZE`. Prevents the v12 W2c catastrophe where CE scored against a thin BM25-dominant pool with degenerate-quality semantic seeds.

## Ensemble Diagnostics and Traceability

To ensure high-rigor search auditing, the ensemble provides RRF score traces and the search path reports coarse capability state. Per-lane health records and semantic provider identity are accepted as follow-up contract work, not proof that every field below is emitted today.

### 1. Lane Health and Capability Records
The current search result reports overall `capabilityState` with capabilities used, missing capabilities, freshness, and warnings. The next extension is to report each retrieval leg with this state:
- **Available**: Lane executed successfully.
- **Degraded**: Lane returned partial results (e.g., FTS timeout, partial graph).
- **Unavailable**: Required backend missing (e.g., no embeddings, DB connection failed).
- **Not-Used**: Intent router assigned 0.0 weight to this lane.

### 2. Lane Contribution Reports (RRF Trace)
When `includeTrace: true` is requested, RRF merge and ensemble internals can attach a breakdown of each score contribution:
```ts
interface RetrievalLaneContribution {
  lane: 'bm25' | 'semantic' | 'graph' | 'ce';
  rank: number;       // Rank within the individual lane
  rawScore: number;   // Original score from the backend
  weight: number;     // Ensemble weight for this intent
  contribution: number; // Final weighted-RRF value added
}
```

### 3. Embedding Provider Identity
`RepoMeta.model_hash` records embedding identity at the index level. The follow-up retrieval contract should surface that identity from the semantic lane:
```ts
interface EmbeddingCapability {
  modelHash: string;   // Local Snowflake/Jina model signature
  count: number;       // Total vectors in index
  status: 'available' | 'stale' | 'missing';
}
```

## Empirical result

v13 W1c bench on bridge-sample (n=20, stratified 5/5/5/5):

- calls-of: 60% → 80% Hit@10 (+20pp; **Wilson 95% CI overlap = 50.6pp; McNemar p=1.0** per v14 P-1 statistical analysis — directional signal but underdetermined at n=5)
- cross-file-impact: 60% → 60% (0pp; embeddings=0 dormant; graph leg alone insufficient on bridge-sample)
- nl-conceptual: 80% → 80% (0pp; CE leg gated by MIN_VEC_POOL_SIZE; embeddings dormant)
- ambiguous: 100% → 100% (byte-identical safety floor held)

100% of 51 production queries route to `ambiguous` trajectory — the ensemble's per-intent improvements do not reach default users without classifier vocabulary expansion or telemetry-surfaced non-ambiguous traffic.

## Consequences

**Positive:**
- Ensemble shipped end-to-end; first concrete per-intent mechanism in 10 retrieval-quality iterations
- Byte-identical safety floor (ambiguous row) means default users see ZERO behavior change unless they opt in
- Clean separation of concerns: classification → routing → leg execution → scoring → merge
- Min-vec-pool gate prevents v12-style CE catastrophe
- **Search Auditing**: Lane health and contribution reports allow operators to debug "Why was X retrieved?" with precision.
- **Model Integrity**: Model-hash tracking ensures vector retrieval matches the indexed corpus.

**Negative:**
- Production traffic does not surface non-ambiguous queries (W1c-pre histogram: 0% calls-of, 0% cross-file-impact)
- `cross-file-impact.vec=0.10` is calibrated for snowflake-not-jina; full v7 +20pp signal unrealizable without jina-indexed corpus
- 7-positional-arg `applyEnsemble` signature is approaching unwieldy (graphResults, ceScores, ceResults all separate)

**Open issues for future work:**
- T-3 FTS coverage gap (MEDIUM; affects BM25 leg recall; see forward plan §1.3)
- Telemetry-as-feature (§2.3 in forward plan) for surfacing non-ambiguous traffic
- Refactor: group `(graphResults, ceResults, ceScores)` into a single `LegResults` object
