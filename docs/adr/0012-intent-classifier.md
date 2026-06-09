# ADR-0012: Intent classifier + confidence soft-gate

**Status:** Accepted
**Date:** 2026-04-27 (v6 W0b base; v8 W1a router; v13 W1a confidence soft-gate)
**Source:** `ontoindex/src/core/search/intent-classifier.ts`; usage in `ontoindex/src/mcp/local/backend-search.ts`.

## Context

Different query types benefit from different retrieval strategies. v7 (jina embedder swap on `cross-file-impact`) and v12 (CE rerank on `nl-conceptual`) both showed per-intent value — but routing the wrong query to the wrong mechanism produces catastrophic regressions (v12 calls-of 80% → 0%). A pre-retrieval intent classification step is required before per-intent routing or ensemble (ADR-0002) can be safely activated.

## Decision

A **keyword-based classifier** with **confidence scoring** that returns one of four intent labels: `calls-of`, `cross-file-impact`, `nl-conceptual`, `ambiguous`. Below confidence 0.7, callers must soft-gate to `ambiguous` (= v12 RRF baseline behavior) regardless of label.

## Algorithm / Technique

### Public API (`intent-classifier.ts:23-107`)

```
type IntentLabel = 'calls-of' | 'cross-file-impact' | 'nl-conceptual' | 'ambiguous';

interface IntentClassification {
  intent: IntentLabel;
  confidence: number;  // [0, 1]
}

function classifyIntent(query: string): IntentClassification;
```

### Keyword sets

```typescript
const CALLS_OF_KEYWORDS = ['what calls', 'who calls', 'callers of', 'who invokes', 'invokes', 'invocations of'];
const CROSS_FILE_IMPACT_KEYWORDS = ['impact of', 'what depends on', 'breaks if', 'affected by', 'transitively'];
const NL_CONCEPTUAL_KEYWORDS = ['how does', 'why does', 'explain', 'where is', 'show me'];
```

(Exact lists in `intent-classifier.ts:31-90` — these are illustrative; the actual lists are slightly longer with synonyms.)

### Classification rules

```
function classifyIntent(query: string): IntentClassification {
  const lower = query.toLowerCase();
  const tokens = lower.split(/\s+/).filter(t => t.length > 0);

  // Rule 1: ≤ 2 tokens, no class signal → ambiguous (high confidence — definitely short)
  if (tokens.length <= 2) {
    return { intent: 'ambiguous', confidence: 0.7 };
  }

  // Rule 2: keyword match → high-confidence specific intent
  for (const kw of CALLS_OF_KEYWORDS) {
    if (lower.includes(kw)) return { intent: 'calls-of', confidence: 0.9 };
  }
  for (const kw of CROSS_FILE_IMPACT_KEYWORDS) {
    if (lower.includes(kw)) return { intent: 'cross-file-impact', confidence: 0.85 };
  }
  for (const kw of NL_CONCEPTUAL_KEYWORDS) {
    if (lower.includes(kw)) return { intent: 'nl-conceptual', confidence: 0.8 };
  }

  // Rule 3: > 2 tokens, no keyword → nl-conceptual fallback at LOW confidence
  return { intent: 'nl-conceptual', confidence: 0.5 };
}
```

### Why confidence values

- **0.9 calls-of:** highly specific keywords (`who calls`, `callers of`) — vanishingly rare in natural English
- **0.85 cross-file-impact:** specific but slightly broader (`impact of` could be ambiguous)
- **0.8 nl-conceptual:** common interrogatives (`how does`, `why does`) — still strong signal
- **0.7 ambiguous (short):** short queries are inherently ambiguous; users typing a single identifier
- **0.5 nl-conceptual fallback:** default for >2-token queries that don't match any keyword — directionally suggests "natural language" but underconfident

### Soft-gate at consumer (Attack 3 fix from v13 W1a)

Per ADR-0002 (per-intent ensemble), callers must apply:

```
const effectiveIntent = (confidence < 0.7) ? 'ambiguous' : intent;
```

This recaptures the 0.5-confidence nl-conceptual fallback into the safe `ambiguous` row (v12 RRF baseline). Without the soft-gate, the ensemble would route a multi-token no-keyword query (e.g., `auth handler routing`) into `nl-conceptual`'s vec-heavy weights — risky on a corpus with embeddings=0.

### Production class distribution (v13 W1c-pre histogram)

51 real-repo production queries:
- `[0.0, 0.5)`: 0% (no queries with confidence below 0.5)
- `[0.5, 0.7)`: 57.6% (multi-token no-keyword fallback → soft-gates to ambiguous)
- `[0.7, 0.8)`: 0% (no `nl-conceptual` keyword matches)
- `[0.7]`: 42.4% (≤2-token queries → ambiguous direct)
- **Net: 100% routes to ambiguous after soft-gate.**

This is the structural production-blocker for the per-intent ensemble: real queries don't trigger non-ambiguous paths. v14 P-1 confirmed this and triggered the TERMINAL closure.

### Why keyword-based, not ML

- Deterministic — same query → same label across runs
- No model load — runs in microseconds in the query path
- Human-auditable — operators can see why a query was classified a way
- Trade-off: poor recall on synonyms ("show me callers" misses calls-of because `callers of` requires `of`)

ML-based classification is a candidate for a future project (telemetry-as-feature § in forward plan would expose data to train it).

## Consequences

**Positive:**
- Fast — runs in microseconds; no inference cost in the query path
- Deterministic — same input produces same output
- Explainable — operators can see exactly why classification fired a way
- Soft-gate provides safety: low-confidence queries never trigger experimental ensemble paths
- **Economic Foundation**: Provides the intent-signal required for "Tiered Model Routing" to optimize USD spend.

**Negative:**
- Brittle to vocabulary — `show me callers` doesn't match calls-of (no `of`)
- 100% production traffic falls into `ambiguous` trajectory (per v13 W1c-pre histogram); ensemble's per-intent improvements don't reach default users
- Static keyword lists; no learning from production traffic
- 4 intent labels — no "all intents apply" or "uncertain between A and B" output

**Open issues for future work:**
- Classifier vocabulary expansion (forward plan §1.7 / §2.7 candidate)
- ML-based classifier trained on production telemetry (forward plan §2.3 telemetry-as-feature)
- **Cost-Aware Model Routing**: Extend the router to select LLM models based on intent complexity. (e.g., `nl-conceptual` queries use cheaper Tier-2 models; `refactor` and `audit` intents use high-fidelity Tier-1 models). This "Tiered Routing" ensures expensive compute is reserved for high-rigor tasks.
- Multi-label output (e.g., 60% calls-of, 30% nl-conceptual)
- Per-language keyword sets (Japanese / Spanish / etc.)
