# ADR 0082: Semantic ANN Neighbor Graph and One-Shot Retrieval Frontier

**Status:** Implemented - opt-in core and analyze-time materialization
**Date:** 2026-06-09
**Source:** Instagram semantic-memory prototype review; narrowed against existing OntoIndex embedding, query, and graph-navigation architecture.

## Context

The reviewed prototype proved one useful pattern for OntoIndex: semantic nearest-neighbor search
becomes practical when graph expansion and scoring happen inside one backend operation instead of
through repeated client or MCP round trips.

Most of the prototype is not new functionality for OntoIndex:

- OntoIndex already has an embedding pipeline.
- OntoIndex already has hybrid lexical/vector retrieval concepts.
- OntoIndex already has graph storage and traversal primitives.
- OntoIndex already has response diagnostics and query-budget conventions.
- JSON-text vector storage is a host-system workaround, not a fit for OntoIndex core.

This ADR therefore keeps only the core extension that OntoIndex does not already have:

```text
existing embeddings + existing graph store
  -> materialized semantic-neighbor relationships
  -> one-shot bounded semantic frontier search
  -> recall/latency benchmark gate
```

## Review and Challenge

The first draft was too broad. It mixed new core functionality with diagnostics, CLI ideas, MCP
surface shape, fallback behavior, and rejected storage patterns.

Challenge findings:

1. **Exact cosine search is not the product feature.** It is a benchmark oracle for ANN quality, not
   a new retrieval surface to prioritize.
2. **A new MCP tool is premature.** Core storage and backend retrieval must land first. Existing
   query/context surfaces can expose the result later if benchmarks justify it.
3. **The useful storage change is an edge class, not vector storage.** OntoIndex should add semantic
   neighbor relationships over existing embedded nodes, not copy the prototype's JSON-vector table.
4. **The important runtime change is one-shot frontier search.** Any implementation that walks the
   graph by repeated MCP/tool calls repeats the prototype's slow path and is rejected.
5. **Semantic similarity must stay advisory.** ANN edges are retrieval hints, never dependency,
   impact, ownership, or audit-authority relationships.

## Decision

Add an opt-in OntoIndex core extension with two new primitives and one validation gate:

1. `ANN_NEIGHBOR` relationships between embedded code entities.
2. `semanticFrontierSearch` backend operation that expands, scores, ranks, and diagnoses candidates
   in one call.
3. an exact-vs-ANN benchmark gate before default enablement or public tool promotion.

No new database, no client-side traversal loop, and no standalone public MCP frontier are approved by
this ADR.

## Core Functionality

### 1. `ANN_NEIGHBOR` Relationship

Materialize bounded nearest-neighbor edges between embedded code entities.

Relationship:

```text
(source)-[:ANN_NEIGHBOR {
  model,
  score,
  rank,
  sourceContentHash,
  targetContentHash,
  builtAt,
  buildId
}]->(target)
```

Required behavior:

- endpoints are stable graph node IDs;
- outbound degree is capped, initially `k=16` or `k=32`;
- edges are versioned by embedding model and content hash;
- stale edges are ignored, deleted, or downgraded before retrieval;
- edges are excluded from impact/dependency/audit traversals by default;
- relationship metadata records enough provenance to reproduce or invalidate the edge set.

Allowed source nodes:

- embedded symbols;
- embedded files or chunks only if they already have stable graph IDs and freshness metadata.

Rejected source nodes:

- assistant memories;
- remote documents;
- docs-sidecar-only records;
- unindexed files.

### 2. `semanticFrontierSearch`

Add one backend operation that performs semantic neighborhood expansion and ranking without repeated
client or MCP calls.

Proposed internal shape:

```ts
semanticFrontierSearch({
  repo,
  queryVector,
  seeds,
  topK,
  ef,
  maxVisited,
  freshnessRequired,
});
```

Required behavior:

1. receive a query vector and seed candidates from existing retrieval lanes;
2. expand `ANN_NEIGHBOR` edges inside the backend up to `ef` and `maxVisited`;
3. score visited candidates against the query vector;
4. rank and return top-k;
5. include diagnostics for seed lanes, visited count, truncation, freshness, and fallback reason.

This operation may be implemented with LadybugDB traversal, a native in-process frontier loop, or a
future graph-query primitive. The public contract is still one request and one result envelope.

### 3. Seed Policy

Seed selection extends existing retrieval instead of creating a new search stack.

Allowed seed lanes:

- lexical/BM25 hits;
- existing vector-index candidates;
- active symbol or file anchor;
- current `context` or `impact` target;
- community representatives after ADR 0067-style structures exist.

Every response must report seed lanes and seed counts. Hardcoded demo seeds are rejected.

### 4. Result Diagnostics

The frontier result must follow existing OntoIndex response-diagnostic conventions.

Required fields:

```json
{
  "repo": "OntoIndex",
  "repoPath": "/path/to/repo",
  "mode": "ann",
  "embeddingReady": true,
  "indexFreshness": "fresh",
  "visited": 384,
  "maxVisited": 512,
  "truncated": false,
  "seedLanes": ["bm25", "vector"],
  "warnings": [],
  "results": []
}
```

ANN results are advisory retrieval candidates. They must not be rendered as complete impact analysis.

## Benchmark Gate

ANN is not accepted as default behavior until benchmarked against exact cosine ranking.

Suggested benchmark command:

```bash
cd ontoindex && npm run bench:semantic-ann -- --fixture test/fixtures/semantic-ann/realistic-code-symbols.json --ef 16,32,64
```

Required metrics:

| Metric | Purpose |
|--------|---------|
| `embeddedNodes` | corpus size under test |
| `k` | requested result count |
| `ef` | frontier width |
| `visited` | candidates scored |
| `latencyMs` | one-shot backend latency |
| `speedup` | exact comparisons / visited |
| `recall@1` | nearest-result quality |
| `recall@5` | near-neighbor quality |
| `fallbackReason` | explains exact/hybrid/disabled path |

The exact cosine path is required only as the benchmark oracle and regression test baseline.

## Implementation Plan

### Phase 1: Edge Schema and Builder

- Define `ANN_NEIGHBOR` as a retrieval-only relationship class.
- Build edges from existing embeddings.
- Store model/hash/build metadata.
- Add stale-edge suppression or cleanup.
- Add tests proving ANN edges do not appear in impact/dependency traversals.

### Phase 2: One-Shot Frontier Search

- Implement `semanticFrontierSearch` behind an internal API.
- Enforce `ef`, `maxVisited`, freshness, and query-budget limits.
- Return seed, visited, truncation, and fallback diagnostics.
- Add tests proving the implementation does not require iterative MCP/tool calls.

### Phase 3: Benchmark Harness

- Add exact-vs-ANN fixture queries.
- Report recall, visited count, speedup, latency, and fallback reason.
- Keep ANN opt-in until benchmark results meet the release threshold.

### Phase 4: Existing Surface Integration

- Integrate through existing query/context retrieval surfaces only after Phases 1-3 pass.
- Add MCP exposure only as a wrapper around the one-shot backend operation.
- Preserve response-envelope compatibility and repoPath/freshness diagnostics.

## Rejected Alternatives

### JSON Text Vector Store

Rejected. OntoIndex should use existing embedding and graph storage.

### Client-Side or MCP-Hop ANN Traversal

Rejected. The core lesson is to avoid repeated round trips.

### ANN as Dependency Evidence

Rejected. Semantic similarity is a retrieval signal, not a code relationship.

### New External Vector Database

Rejected for this ADR. Native graph/sidecar storage must be measured before adding deployment
complexity.

### Public Tool Before Core Backend

Rejected. A public tool without a stable backend operation would lock in the wrong abstraction.

## Consequences

Positive:

- Extends OntoIndex with a native semantic-neighborhood layer.
- Reduces large-repo semantic search cost when embeddings are available.
- Keeps retrieval explainable through seed, freshness, visited, and truncation diagnostics.
- Avoids an extra database and avoids MCP round-trip loops.

Negative:

- Adds derived relationship state that must be versioned and invalidated.
- Requires benchmark infrastructure before default use.
- Approximate search can miss exact nearest neighbors.

Mitigations:

- Keep ANN opt-in until recall gates pass.
- Preserve exact ranking as a benchmark oracle.
- Mark ANN relationships as retrieval-only.
- Suppress stale edges and report degraded freshness.

## Guardrails

- No new graph database.
- No JSON-text vector storage as core architecture.
- No repeated MCP/tool calls for ANN traversal.
- No ANN edge in impact, dependency, ownership, or audit-authority traversals.
- No default-on ANN without recall and latency benchmarks.
- No hidden fallback; result envelopes must report mode and fallback reason.
- No stale edge use without warning or freshness downgrade.

## Acceptance Criteria

- `ANN_NEIGHBOR` edges can be built from existing embeddings with model/hash/build metadata.
- ANN edges are excluded from impact/dependency/audit traversals.
- `semanticFrontierSearch` returns ranked candidates in one backend call.
- Result envelopes include repoPath, mode, seed lanes, visited count, truncation, freshness, and
  warnings.
- Benchmark output reports `recall@1`, `recall@5`, `visited`, `latencyMs`, `speedup`, and fallback
  reasons.
- ANN remains opt-in until benchmark gates pass.

## Implementation Status

Implemented as opt-in core functionality:

- `ANN_NEIGHBOR` edge helpers and one-shot frontier search code are present in:
  - `ontoindex/src/core/embeddings/`
  - `ontoindex/src/core/search/semantic-frontier-search.ts`
- The MCP/search surface can opt in with `retrieval_policy: "symbol-neighborhood"`.
- `ontoindex analyze --ann-neighbors` materializes `ANN_NEIGHBOR` edges after embeddings are available.
- Benchmark gating is available through `npm run bench:semantic-ann`.
- ANN remains retrieval-only and is not included in default impact, dependency, or audit traversals.

## Validation

For implementation work, run focused tests for touched modules plus:

```bash
cd ontoindex && npx tsc --noEmit --pretty false
cd ontoindex && npm test -- --run test/unit/ann-neighbor-builder.test.ts test/unit/ann-neighbor-store.test.ts test/unit/semantic-frontier-search.test.ts test/unit/semantic-frontier-adapter.test.ts test/unit/backend-search-typed.test.ts test/unit/hybrid-search.test.ts
cd ontoindex && npm run bench:semantic-ann -- --fixture test/fixtures/semantic-ann/realistic-code-symbols.json --ef 19 --min-recall-at-1 1 --min-recall-at-5 1 --max-visited 19
```

If implementation touches graph traversal, add tests proving `ANN_NEIGHBOR` is retrieval-only.

If implementation exposes the feature through MCP or query/context surfaces, run the relevant
tool-contract and response-envelope tests.
