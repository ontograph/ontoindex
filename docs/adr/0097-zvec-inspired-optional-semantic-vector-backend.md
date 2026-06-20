# ADR 0097: Zvec-Inspired Optional Semantic Vector Backend

Status: Proposed - challenged/narrowed
Date: 2026-06-19
Source reviewed: `./tmp/zvec`, `./tmp/zvec-option2`

## Decision

Extend OntoIndex's existing semantic retrieval path with an optional zvec-backed vector index.

This is not a storage replacement. LadybugDB remains the source of truth for the repository graph,
embedding rows, FTS, MCP responses, and symbol hydration. zvec is allowed only as a derived,
rebuildable vector-search acceleration layer behind the existing semantic search contract.

Default behavior remains unchanged:

```bash
ONTOINDEX_VECTOR_BACKEND=lbug
```

Opt-in behavior:

```bash
ONTOINDEX_VECTOR_BACKEND=zvec
```

If zvec is missing, stale, unsupported, or fails at query time, OntoIndex falls back to the current
LadybugDB vector path.

## Architecture Fit Gate

### Real New Functionality

Approved:

- optional zvec-backed semantic vector lookup using existing OntoIndex embeddings;
- derived `.ontoindex/zvec/` collection freshness checks;
- vector backend diagnostics in existing diagnose/search surfaces;
- benchmark and replay gates using the existing semantic-ann benchmark and replay report envelopes;
- graceful fallback when zvec native bindings or collections are unavailable.

Rejected:

- replacing LadybugDB graph storage;
- making zvec a required runtime dependency;
- copying zvec's full database, SQL, WAL, or FTS subsystem into OntoIndex;
- adding a second MCP search tool family;
- changing default retrieval behavior from benchmark data alone;
- exposing zvec-specific result shapes to callers.

### Core Extension

This ADR extends existing owners only:

- `ontoindex/src/core/lbug/schema.ts` for the current `CodeEmbedding` table and vector index;
- `ontoindex/src/mcp/local/backend-query.ts` for the existing `semanticSearch` result contract;
- `ontoindex/src/core/search/hybrid-search.ts` for current BM25 + semantic fusion;
- `ontoindex/src/core/embeddings/` for embedding persistence and mirror hooks;
- `ontoindex/src/storage/repo-manager.ts` for `.ontoindex/` path helpers;
- `ontoindex/src/mcp/super/diagnose.ts` and related health checks for backend readiness.

No parallel graph, wiki, audit, or MCP workflow is approved.

## Context

OntoIndex already stores embeddings in LadybugDB:

- `CodeEmbedding` carries `id`, `nodeId`, `chunkIndex`, line spans, embedding vector, and content hash.
- `CREATE_VECTOR_INDEX(... metric := 'cosine')` creates the current HNSW vector index.
- `semanticSearch` embeds the query, calls `QUERY_VECTOR_INDEX`, then hydrates symbols from the
  existing graph.
- `hybridSearch` already merges BM25 and semantic results with RRF.

zvec is useful because it provides a local in-process vector database with HNSW, DiskANN, hybrid
query support, and prebuilt Node bindings.

### Preliminary Evidence

A scratch benchmark using the current OntoIndex index showed a promising vector-call latency signal:

| Sample | Queries | TopK | zvec median | Ladybug median | zvec ingest |
| -----: | ------: | ---: | ----------: | -------------: | ----------: |
|    200 |       5 |   10 |     0.80 ms |      442.88 ms |    13.23 ms |
|  5,000 |      50 |   10 |     1.13 ms |       17.87 ms |   130.84 ms |
| 34,035 |     100 |   10 |     4.88 ms |       15.65 ms |   821.67 ms |
| 34,035 |     100 |   50 |     5.06 ms |       17.83 ms |   823.91 ms |

These numbers justify a gated adapter prototype. They do not justify changing defaults.

Caveat: the benchmark used existing embedding vectors as query vectors. It measured direct vector
lookup latency, not embedding generation, real natural-language semantic quality, or end-to-end
OntoIndex search latency.

The gate for implementation is:

- zvec must show at least a 2x median direct vector-query speedup on a real indexed repo; and
- retrieval replay must show no expected-anchor regression within the accepted top-K window.

The replay gate now accepts an optional vector-backend comparison payload on the existing replay
report shape:

```ts
{
  baselineMedianMs: number;
  candidateMedianMs: number;
  expectedAnchorRegression?: boolean;
}
```

When supplied, the gate passes only when the candidate median is at least 2x faster than the
baseline and `expectedAnchorRegression` is false. Incomplete comparison data warns instead of
changing the default replay behavior.

The benchmark evidence comes from the existing
`ontoindex/scripts/semantic-ann-benchmark.mjs` output, which already reports per-row `speedup`.

## Algorithm/Technique

### Storage Layout

Add a derived zvec collection under the existing repo-local storage root:

```text
.ontoindex/
  lbug/
  zvec/
    current.json
    generations/
      <generation-id>/
        embeddings/
        metadata.json
```

`metadata.json` records:

- OntoIndex vector mirror schema version;
- zvec npm package version;
- embedding dimension;
- embedding model hash;
- source commit / current HEAD;
- graph index id or graph hash when available;
- `CodeEmbedding` row count;
- deterministic digest over `(id, nodeId, chunkIndex, contentHash)`;
- build timestamp;
- backend index type and params.

`current.json` points to the verified generation. Do not rely on atomically renaming an open native
database directory. Build a new generation, close all zvec handles, verify metadata and query sanity,
then update `current.json`.

### Document Shape

Do not use raw OntoIndex node IDs as zvec primary keys. zvec rejected IDs containing OntoIndex
symbol punctuation during the benchmark.

Use a safe synthetic ID and keep OntoIndex identity in scalar fields:

```ts
{
  id: "doc_<stableOrdinalOrHash>",
  vectors: {
    embedding: Float32Array
  },
  fields: {
    nodeId: string,
    chunkIndex: number,
    startLine: number,
    endLine: number,
    contentHash: string
  }
}
```

### Mirror Build

1. Read current `CodeEmbedding` rows from LadybugDB.
2. Validate one embedding dimension for the whole mirror.
3. Create a new generation under `.ontoindex/zvec/generations/<generation-id>/`.
4. Insert in chunks of at most 1024 documents. zvec enforces this batch limit.
5. Close zvec handles.
6. Write `metadata.json` after all inserts succeed.
7. Reopen the generation and run one bounded sanity query.
8. Update `current.json` only after verification succeeds.
9. If any step fails, remove the new generation and keep LadybugDB active.

### Query Flow

Existing `semanticSearch` keeps the same external shape:

```text
semanticSearch(query)
  -> embed query with existing OntoIndex embedder
  -> if ONTOINDEX_VECTOR_BACKEND=zvec and mirror is fresh:
       query zvec collection
       map docs to nodeId/chunk metadata
     else:
       query LadybugDB vector index
  -> hydrate node metadata from LadybugDB
  -> return SymbolSearchResult[]
```

Fallback rules:

- native zvec binding missing: use LadybugDB;
- unsupported platform: use LadybugDB;
- collection missing: use LadybugDB;
- metadata drift: use LadybugDB and report stale zvec mirror;
- query error: use LadybugDB, emit bounded diagnostic, and trip a per-process circuit breaker;
- dimension mismatch: use LadybugDB and mark mirror stale.

The circuit breaker marks zvec degraded after the first runtime failure and prevents repeated zvec
query attempts until process restart or explicit mirror refresh.

### Diagnostics

Extend the retrieval diagnostics shape from ADR 0096 rather than adding a new tool or parallel
diagnostic contract:

```ts
type VectorBackendDiagnostics = {
  backend: "lbug" | "zvec";
  requestedBackend: "lbug" | "zvec";
  available: boolean;
  freshness: "fresh" | "missing" | "stale" | "unsupported" | "error";
  fallbackReason?: string;
  mirroredRows?: number;
  queryMedianMs?: number;
};
```

Expose this through existing search diagnostics and `gn_diagnose` / `ontoindex status` style health
reporting.

## New Core Functionality Kept From zvec Review

Only these ideas survive the architecture gate:

1. Optional derived vector backend for semantic search.
2. Backend readiness and freshness metadata.
3. Safe synthetic zvec document IDs.
4. Chunked zvec ingest at 1024 docs.
5. Native binding availability diagnostics.
6. Query-time fallback to LadybugDB.
7. Backend latency diagnostics in existing retrieval reports.
8. Replay-quality gate before any default change.

### Verification

- `cd ontoindex && ONTOINDEX_TEST_WORKERS=2 npx vitest run test/unit/retrieval-replay-gate.test.ts test/unit/retrieval-replay-runner.test.ts`
- `cd ontoindex && npx tsc --noEmit`

## Postponed

- zvec FTS integration;
- zvec MultiQuery replacing OntoIndex RRF;
- sparse vector support;
- automatic backend selection;
- DiskANN benchmark lane for large repositories;
- DiskANN as default for large repositories;
- cleanup command or mode for `.ontoindex/zvec`;
- zvec-backed web UI inspection.

These are allowed only after the optional vector backend is correct, measured, and replay-safe.

## Acceptance Criteria

- Default search behavior is unchanged.
- `ONTOINDEX_VECTOR_BACKEND=zvec` is opt-in.
- zvec unavailability never breaks semantic search.
- zvec result mapping returns the current `SymbolSearchResult` shape.
- Mirror drift is detected before query use.
- Mirror freshness uses commit/index identity plus deterministic embedding-row digest, not only row count.
- Deletes and re-analysis cannot leave a silently stale zvec mirror.
- zvec runtime query failure trips a per-process circuit breaker.
- Benchmark output reports ingest time, median query time, sample size, query count, and `topk`.
- Replay gates show result quality is not worse than LadybugDB on existing retrieval fixtures.
- Tests cover missing binding, stale metadata, dimension mismatch, query failure fallback, and result mapping.

## Consequences

Positive:

- keeps OntoIndex's graph architecture intact;
- gives a measured path to faster semantic vector lookup;
- creates a future DiskANN path for memory-constrained large repos;
- keeps risky native dependency behind an opt-in backend.

Negative:

- duplicates embedding storage when enabled;
- adds mirror consistency work to analyze/reindex flows;
- adds native package/platform failure modes;
- requires replay-quality proof before it can become default.

## Non-Goals

- Replace LadybugDB.
- Vendor zvec C++ source.
- Add a new graph store.
- Add a new MCP search surface.
- Replace OntoIndex hybrid ranking.
- Make zvec mandatory.
