# ADR-0003: Cross-encoder rerank batched + intent-conditional

**Status:** Accepted (env-gated default-OFF)
**Date:** 2026-04-29 (v11 W2a/b infra) → 2026-04-30 (v13 W1b-step3 intent-conditional)
**Source:** `ontoindex/src/mcp/core/ce-reranker.ts`; usage in `ontoindex/src/mcp/local/backend-search.ts`.

## Context

v10 P2 W2c attempted global CE rerank on every query → p95=4414ms (vs 800ms budget) AND Hit@10 -20pp regression on calls-of. v11 W2a probe found batched native inference (jina-reranker-v1-tiny-en) at 776ms cold / 456ms warm on synthetic — viable in isolation. v12 W2c full-pipeline eval revealed end-to-end p95=897ms (BM25+vec+RRF baseline ~500ms; CE adds ~250ms-400ms), AND the categorical issue: CE scoring against file-path strings catastrophically reorders calls-of (Hit@10 80%→0%).

## Decision

Use **AutoTokenizer + AutoModelForSequenceClassification** (NOT `pipeline('text-classification')` which saturates) with **batched inference** (`MAX_RERANK_BATCH=30`), gated to **`nl-conceptual` intent only** with a **minimum vector pool size gate** (`MIN_VEC_POOL_SIZE=5`). Env-gated `ONTOINDEX_CE_RERANK=<model-id>` (default unset; default OFF).

## Algorithm / Technique

### Model + tokenizer initialization (`ce-reranker.ts:initCEReranker`)

1. Read `ONTOINDEX_CE_RERANK` env var (e.g., `jinaai/jina-reranker-v1-tiny-en`). Throw if unset.
2. Load `AutoTokenizer.from_pretrained(modelId)`.
3. Load `AutoModelForSequenceClassification.from_pretrained(modelId)`.
4. Cache both as module-level singletons (one model load per process).
5. **NOT** `pipeline('text-classification')`: that wrapper applies softmax over a 1-class output and saturates to 1.0, destroying ranking signal. Use the raw model + sigmoid manually.

### Batched scoring (`ce-reranker.ts:scoreCEBatch`)

```
function scoreCEBatch(query: string, docs: string[]): number[] {
  if (docs.length === 0) return [];
  const out: number[] = [];
  for i in 0..docs.length step MAX_RERANK_BATCH:
    const sub = docs.slice(i, i + MAX_RERANK_BATCH);
    out.push(...scoreCEBatchInner(query, sub));
  return out;
}
```

### Inner batch (single forward pass) (`ce-reranker.ts:scoreCEBatchInner`)

1. Build inputs: `tokenizer(Array(docs.length).fill(query), { text_pair: docs, padding: true, truncation: true, max_length: 512 })`. This produces a single batched tensor with all (query, doc) pairs.
2. Run `model(inputs)` — single forward pass.
3. Apply `sigmoid` to logits column 0.
4. Return scores as `number[]` aligned to input `docs[]` order.

### Forced-sequential fallback

`ONTOINDEX_CE_FORCE_SEQUENTIAL=1` env: bypass batching, score one (query, doc) pair at a time. Used for debugging or environments where batched inference fails (e.g., low-VRAM systems).

### Batch cap

`ONTOINDEX_CE_BATCH_CAP=<int>` env: override `MAX_RERANK_BATCH`. Default 30. Larger batches improve throughput up to a memory cap; smaller batches reduce peak memory.

### Intent gate (`backend-search.ts`, v13 W1b-step-3)

CE leg fires only when ALL of:

1. `ONTOINDEX_INTENT_ENSEMBLE === '1'`
2. `queryIntent === 'nl-conceptual'` (hard equality, NOT a list — explicitly excludes calls-of and cross-file-impact)
3. `intentResult.confidence >= 0.7` (confidence soft-gate; see ADR-0012)
4. `semanticResults.length >= MIN_VEC_POOL_SIZE` (default 5, env `ONTOINDEX_VEC_POOL_MIN`)

If any condition fails: pass `ceScores=[]` and `ceResults=[]` to `applyEnsemble` (no-op for the CE leg).

### Candidate alignment (Attack 2 fix)

CE candidate set = `semanticResults.slice(0, 50)` (top-50 from vector leg). Score:

```
ceResults = semanticResults.slice(0, 50);
ceDocs = ceResults.map(r => r.filePath + '\n' + r.name);
ceScores = await scoreCEBatch(query, ceDocs);
applyEnsemble(intent, bm25Results, semanticResults, limit, confidence,
              graphResults, ceScores, ceResults);
```

`ceScores[i]` is aligned to `ceResults[i]` by index. Per-intent-ensemble's CE loop iterates `ceResults[i]` (NOT `graphResults[i]` — that was the v13 W1b-step-1 alignment bug fixed in step-3).

### Why NOT global CE

v12 W2c data:
- `calls-of`: Hit@10 80% → **0%** (catastrophic)
- `cross-file-impact`: Hit@10 60% → 60% (no signal)
- `nl-conceptual`: Hit@10 80% → 100% (improvement)

CE scores `(query, filePath+name)` pairs. For natural-language queries, this captures semantic relevance. For identifier queries (`calls-of`), the file-path string is uninformative; CE ranks based on accidental token overlap and reshuffles results destructively.

The intent gate restricts CE to where it helps.

### Score combination

CE scores are sigmoid [0, 1]; NOT rank-based. Per-intent-ensemble multiplies by `weights.ce` (0.30 for nl-conceptual) and adds to `scoreMap[key].score` directly (NOT through the RRF formula).

## Consequences

**Positive:**
- CE infrastructure shipped env-gated; safe default-off
- Min-vec-pool gate prevents thin-pool catastrophe
- Intent gate isolates CE to where it helps (nl-conceptual)
- AutoTokenizer + AutoModel pattern avoids the `pipeline()` saturation bug

**Negative:**
- Cold start latency (~2-4s model load) on first nl-conceptual query — bounded but visible
- v13 W1c eval did not exercise CE leg (embeddings=0 dormant) → no production-condition latency validation
- Adding 0.30 weight to a sigmoid score in a mostly-RRF ensemble is awkward dimensionally; future tuning may need score normalization

**Open issues for future work:**
- Pre-warm CE singleton at MCP server startup (deferred per F1 due to MCP stdio framing risk)
- Real-corpus latency validation under proper embeddings populated
- Intent-conditional batch cap tuning
