# ADR 0098: Core Embedding Performance Optimizations

Status: Implemented - pending release
Date: 2026-06-20
Source: User-selected options from embedding performance review

## Decision

Extend the existing OntoIndex embedding pipeline with five narrow performance improvements:

1. make the embedding sub-batch size configurable and default it to 16;
2. add chunk-level content hashes so changed large symbols do not force every chunk to be
   re-embedded;
3. auto-use a fresh zvec mirror when available, with LadybugDB as fallback;
4. add resumable embedding checkpoints for interrupted embedding runs;
5. skip derived vector rebuilds when embedding rows are unchanged and the existing index or mirror is
   proven present.

Do not replace the embedding provider, LadybugDB graph store, MCP search API, or ADR 0097 zvec
mirror design.

## Architecture Fit Gate

### Real New Functionality

Approved:

- faster default embedding throughput through a configurable sub-batch size;
- finer incremental embedding reuse at chunk granularity;
- automatic use of the already-approved zvec acceleration layer when it is fresh;
- recoverable embedding runs after late crashes, extension failures, or process interruption;
- unchanged-row detection before rebuilding zvec mirrors or LadybugDB vector indexes.

Rejected:

- a new vector database;
- a new embedding framework;
- background daemon embedding refresh;
- distributed workers;
- a second MCP semantic-search tool;
- changing semantic result shape for callers.

### Core Extension

This ADR extends existing owners only:

- `ontoindex/src/core/embeddings/embedding-pipeline.ts`;
- `ontoindex/src/core/embeddings/embedder.ts`;
- `ontoindex/src/core/embeddings/zvec-semantic-backend.ts`;
- `ontoindex/src/core/embeddings/zvec-mirror.ts`;
- `ontoindex/src/core/lbug/schema.ts`;
- `ontoindex/src/storage/repo-manager.ts`;
- existing diagnose/search metadata from ADR 0096 and ADR 0097.

No parallel storage, web, wiki, or agent workflow is approved.

## Review Challenge

This ADR is accepted only in its narrow form:

1. **Batch size 16 is a candidate default, not guaranteed faster everywhere.** If local
   transformers.js on common machines regresses memory or latency, keep runtime default at 8 and
   document 16 as the recommended override for HTTP/GPU-backed embedding.
2. **Chunk-level hashes require additive schema/read-path work.** This is not a pure in-memory
   optimization. Legacy indexes without `chunkContentHash` must stay readable and refresh safely.
3. **Checkpoints must stay compact.** Do not store every completed chunk hash in one JSON array.
   Durable `CodeEmbedding` rows remain the source of truth; checkpoints should store only run
   identity and a resume cursor.
4. **Digest equality alone cannot skip rebuilds.** The target vector index or zvec mirror must also
   be verified present. If verification is cheap but inconclusive, rebuild.
5. **`auto` zvec remains opt-in.** Default LadybugDB behavior must not change until benchmark and
   replay evidence justify it.

## Context

OntoIndex already has the right primitives:

- `CodeEmbedding` stores chunk rows with `nodeId`, `chunkIndex`, line spans, vector, and
  `contentHash`;
- `runEmbeddingPipeline` skips unchanged nodes when an existing node-level hash matches;
- `embedBatch` supports batch inference;
- ADR 0097 adds an optional derived zvec mirror;
- `gn_diagnose` and `gn_ensure_fresh` already report embedding readiness and drift.

The performance gap is mostly avoidable work:

- the internal embedding sub-batch is hard-coded to 8;
- a changed large symbol re-embeds all chunks, even when only one chunk changed;
- zvec must be manually requested even when the mirror is fresh;
- interrupted runs lose useful completed embedding work;
- vector indexes can be rebuilt even when embedding rows did not change.

## Implementation Slices

### Slice 1: Configurable Sub-Batch Size

Replace the hard-coded embedding sub-batch value with a bounded config value.

Default:

```text
ONTOINDEX_EMBED_SUB_BATCH=16
```

Rules:

- minimum: 1;
- maximum: 128;
- invalid values fall back to 16;
- local transformers.js and HTTP embedding mode both use the same value;
- no new CLI flag is required for the first slice.

Acceptance:

- a unit test proves default 16 and invalid-value fallback;
- an integration/focused test proves the pipeline passes batches no larger than the configured cap.

### Slice 2: Chunk-Level Incremental Hashes

Keep the existing node-level `contentHash`, but add a chunk-level hash for exact reuse:

```ts
chunkContentHash = sha1(EMBEDDING_TEXT_VERSION + "\n" + generatedChunkText)
```

Rules:

- reuse an existing chunk row only when `nodeId`, `chunkIndex`, and `chunkContentHash` match;
- delete and recreate only stale chunk rows for changed nodes;
- if old indexes do not have chunk hashes, fall back to current node-level behavior;
- schema changes are additive only; old indexes without `chunkContentHash` are treated as
  node-hash-only and refreshed safely.

Acceptance:

- changing one chunk of a multi-chunk symbol re-embeds only that chunk;
- old indexes without chunk hashes still refresh successfully.
- zvec row digests include `chunkContentHash` when present and remain compatible with older mirror
  metadata that only recorded `contentHash`.

### Slice 3: Auto zvec When Fresh

Extend ADR 0097 backend selection with an `auto` mode:

```text
ONTOINDEX_VECTOR_BACKEND=auto
```

Rules:

- default remains LadybugDB until benchmarks justify changing it;
- `auto` uses zvec only when the mirror is fresh and dimensions/model hash match;
- any zvec error falls back to LadybugDB and trips the existing process-local circuit breaker;
- diagnostics report `requestedBackend: "auto"` and the actual backend used.

Acceptance:

- fresh zvec mirror is selected in `auto` mode;
- stale/missing zvec mirror falls back to LadybugDB;
- public semantic result shape is unchanged.

### Slice 4: Resumable Embedding Checkpoints

Write a small checkpoint under the existing repo storage root:

```text
.ontoindex/embedding-checkpoint.json
```

Checkpoint content:

```ts
{
  version: 1,
  embeddingTextVersion: string,
  modelHash: string,
  headCommit: string,
  currentLabel: string,
  lastCompletedNodeId: string | null,
  insertedRows: number,
  updatedAt: string
}
```

Rules:

- write checkpoint after successful embedding insert batches;
- remove checkpoint only after vector index or mirror update succeeds;
- ignore checkpoint when model hash, text version, or commit differs;
- never mark repo embeddings healthy from checkpoint alone.
- use `(currentLabel, lastCompletedNodeId)` as the resume cursor instead of a `SKIP` offset or a
  giant hash array;
- on resume, still consult existing `CodeEmbedding` rows and hashes as the authority for what is
  already durable.

Acceptance:

- interrupted embedding run resumes without re-embedding completed chunks;
- stale checkpoint is ignored safely;
- failed run remains visibly degraded in health checks.
- checkpoint file remains small on large repositories.

### Slice 5: Skip Unchanged Derived Vector Rebuild

Before rebuilding a LadybugDB vector index or zvec mirror, compute a deterministic digest over:

```text
(id, nodeId, chunkIndex, contentHash, chunkContentHash)
```

Rules:

- if digest matches the last successful vector-build metadata and the target index or mirror is
  present, skip rebuild;
- if digest differs, rebuild as today;
- if digest metadata is absent, rebuild as today;
- if existence cannot be verified cheaply, rebuild as today;
- zvec mirror metadata and LadybugDB vector metadata use the same digest source;
- store the LadybugDB vector-index digest in repo metadata or a small `.ontoindex/` metadata file,
  not in a new graph table.

Acceptance:

- second `analyze --embeddings` on an unchanged repo skips vector rebuild;
- changed embedding row triggers rebuild;
- diagnostics can explain "vector index unchanged; rebuild skipped".
- deleting the vector index or zvec mirror forces rebuild even when the digest matches.

## Non-Goals

- New embedding model selection policy.
- New vector storage engine.
- New hosted embedding service.
- GPU scheduling or distributed workers.
- Automatic MCP-triggered embedding refresh.
- New MCP tools.
- Rewriting semantic retrieval ranking.
- Treating a checkpoint as proof that embeddings are complete.

## Validation

Minimum validation for implementation:

```bash
cd ontoindex
npm test -- --run test/unit/*embedding*
npm test -- --run test/unit/*zvec*
npx tsc --noEmit
```

For release validation, also run a small repo smoke:

```bash
ONTOINDEX_EMBED_SUB_BATCH=16 node dist/cli/index.js analyze --force --embeddings
node dist/cli/index.js status
```

## Rollout

1. Land slice 1 first because it is the smallest safe throughput win.
2. Land slice 5 before slice 4 if digest metadata is easier to validate independently.
3. Land slice 2 after digest tests exist.
4. Land slice 3 only after ADR 0097 zvec diagnostics are stable.
5. Land slice 4 last because checkpoints can create false confidence if health reporting is weak.

Slice 1 may be implemented alone. Slices 2, 4, and 5 should be reviewed together because chunk
hashes, resume behavior, and rebuild skipping all depend on the same durability contract.

## Stop Conditions

Stop and re-review if implementation requires:

- changing the public search result shape;
- adding a new database dependency;
- marking an interrupted embedding run as healthy;
- loading zvec without freshness checks;
- rebuilding graph storage to support embeddings;
- making MCP auto-run embedding generation by default.
