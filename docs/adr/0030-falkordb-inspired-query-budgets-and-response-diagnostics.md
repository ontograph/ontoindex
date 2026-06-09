# ADR 0030: Query Budgets, Response Diagnostics, and Economic Retrieval

**Status:** Partially Implemented
**Date:** 2026-05-08; Updated 2026-06-01 to consolidate ADR 0035, 0036, 0038, 0040, 0042, 0043, 0046, 0050, and 0062.

## Context

OntoIndex performs expensive graph traversals and retrieval operations. To ensure reliability, performance, and cost-control, we require a unified contract for reporting **Execution Budgets**, **Response Diagnostics**, and **Index Health**.

This ADR serves as the foundational contract for "Honest Retrieval" - ensuring callers know why a result was truncated and which capabilities are degraded. Financial/token cost reporting is proposed follow-up work.

## Decision

Adopt a unified query execution and diagnostic envelope for all high-rigor tool paths.

### Consolidated Requirements:

1.  **Unified Execution Diagnostics**: A single report containing budget, database health, internal phases, and capability state.
2.  **Proposed Economic Retrieval Tracking**: Track `inputTokens`, `outputTokens`, and estimated `usdCost` per query after query-cost accounting exists.
3.  **Response Capping and Truncation**: Structured diagnostics for capped responses, including `omittedCount` and `maxRecommendedSize` (replacing ad-hoc truncation).
4.  **Standardized Degradation Reasons**: Enum-based reasons for partial results (e.g., `fts-timeout`, `semantic-unavailable`).
5.  **Index Capability Health**: Explicit reporting of available graph features (e.g., `impact: 'degraded'`) based on index mode (ADR 0034).
6.  **Database Operation Phases**: Breakdown of internal timing (e.g., `pool-init`, `execute`, `materialize`).
7.  **Proposed Semantic Retrieval Cache**: A query-similarity cache to reduce repeated token spend.

## Algorithm/Technique

### 1. Diagnostic Interfaces

```ts
interface QueryBudgetSnapshot {
  maxDepth?: number;
  maxNodes?: number;
  timeoutMs?: number;
  elapsedMs?: number;
  truncated: boolean;
  truncatedReasons: string[];
  degradedReasons: string[];
  fallback?: string;
  steps?: QueryBudgetStepSnapshot[];
}

interface IndexCapabilityHealth {
  symbols: boolean;
  impact: 'full' | 'degraded' | 'unavailable';
  processes: boolean;
  sidecars: 'enabled' | 'disabled' | 'unknown';
  embeddings: 'enabled' | 'disabled' | 'missing';
  graphFreshness: 'fresh' | 'stale' | 'unknown';
}

interface QueryExecutionDiagnostics {
  budget: QueryBudgetSnapshot;
  capabilities: IndexCapabilityHealth;
  database?: {
    readOnly: boolean;
    pool: { available: number; waiters: number };
    extensions: Record<string, 'loading' | 'available' | 'failed'>;
    preparedCache?: { hit: boolean; size: number };
  };
  access?: { mode: 'read-only' | 'write'; passed: boolean; reasons: string[] };
  phases?: Array<{ name: string, elapsedMs: number, status: 'success' | 'failed' | 'timeout' }>;
}

type RetrievalDegradationReason =
  | 'fts-timeout' | 'semantic-unavailable' | 'graph-unavailable'
  | 'hybrid-partial' | 'candidate-limit' | 'stale-index';
```

### 2. Implementation Surface
- `ontoindex/src/core/runtime/query-budget.ts`
- `ontoindex/src/storage/index-capabilities.ts` (health mapping)
- `ontoindex/src/core/runtime/evidence-diagnostics.ts` (bounded evidence diagnostics)
- `ontoindex/src/mcp/local/backend-search.ts` (structured retrieval capability state)

## Consequences

**Positive:**
- Callers get a complete, honest picture of the search rigor.
- Consolidates performance, graph, and financial budgets.
- Standardized error/degradation codes enable better automated retries and agent reasoning.

**Negative:**
- Diagnostic overhead adds small latency (<5ms).
- USD cost is an estimate based on static pricing.
