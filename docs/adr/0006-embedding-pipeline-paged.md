# ADR-0006: Embedding pipeline paged batching

**Status:** Accepted (opt-in `--embeddings` flag)
**Date:** 2026-04-30 (perf-stability + F1)
**Source:** `ontoindex/src/core/embeddings/embedding-pipeline.ts`; gating in `ontoindex/src/core/run-analyze.ts`.

## Context

Embedding pipeline reads all embeddable nodes, generates dense vectors via a HuggingFace model, persists to LadybugDB. Pre-perf-stability implementation read all nodes into memory in one shot — fine for ≤10k nodes, OOM-prone above that. Hard-coded `EMBEDDING_NODE_LIMIT = 50_000` blocks vscode/kubernetes/react-native indexing entirely.

## Decision

**Page** node reads via `SKIP/LIMIT` with `ORDER BY n.id` for deterministic pagination. **Bound concurrency** for structural extraction (default 4 concurrent workers). Per-phase timing for observability. Default OFF (require `--embeddings` CLI flag). Default model `Snowflake/snowflake-arctic-embed-xs` (384d, no auth required).

## Algorithm / Technique

### Activation gate (`run-analyze.ts:404-410`, default OFF)

```
if (options.embeddings) {
  const { runEmbeddingPipeline } = await import('./embeddings/embedding-pipeline.js');
  await runEmbeddingPipeline(...);
}
```

Dynamic import avoids loading the model machinery for users who don't run with `--embeddings`. The MCP server logs a stderr warning recommending `ontoindex analyze --embeddings` when first started without embeddings.

### Hard size cap (`run-analyze.ts:98`)

```
const EMBEDDING_NODE_LIMIT = 50_000;
```

Auto-skips embedding phase when node count exceeds this. NOT configurable today (T-2 in forward plan).

Affected: vscode (~344k), kubernetes (~320k), react-native (~63k). Smaller corpora (axel ~45k, ontoindex ~22k) embedding-eligible.

### Pagination (F1 fix-1 + base perf-stability)

```
const NODE_PAGE_SIZE = 500;
let pageIndex = 0;
let processedNodes = 0;

for await (const pageNodes of queryEmbeddableNodesPaged(executeQuery)) {
  pageIndex++;
  // ... read content, extract structural names, embed, write ...
  processedNodes += pageNodes.length;
  onProgress({
    currentBatch: pageIndex,                          // F1 fix: pageIndex counter (was Math.floor(processedNodes / NODE_PAGE_SIZE) which off-by-one)
    totalBatches: Math.ceil(totalNodes / NODE_PAGE_SIZE),
    processedNodes,
    totalNodes,
  });
}
```

`queryEmbeddableNodesPaged` is an async generator yielding `EmbeddableNode[]` in pages. Each page query:

```cypher
MATCH (n)
WHERE n.label IN [Function, Class, Method, Interface, Struct, Enum, Trait, Impl, Macro, Namespace, Constructor, TypeAlias, Typedef, Const, Property, Record, Union, Static, Variable]
RETURN n
ORDER BY n.id
SKIP $skip
LIMIT $limit
```

`ORDER BY n.id` ensures deterministic paging. `n.id` is `STRING PRIMARY KEY` on every embeddable label table — unique by definition, so pagination cannot skip or duplicate.

### Total count (for progress denominator)

```
const totalNodes = await countEmbeddableNodes(executeQuery);
```

Single COUNT query before paging starts. Counts include nodes that will be skipped as fresh (incremental mode); progress thus reports "pages processed" not "nodes embedded" — a self-consistent denominator/numerator pair.

### Bounded structural extraction concurrency (perf-stability)

```
const EXTRACTION_CONCURRENCY = 4;  // hardcoded; not env-gated today
```

For each page, fan out `EXTRACTION_CONCURRENCY` concurrent calls to `extractStructuralNames(node)` (which reads file content + tree-sits to extract surrounding context strings). Larger fan-out OOMs; smaller wastes parallelism. 4 is empirical.

```
async function processPage(pageNodes) {
  const updates = await pMap(pageNodes, extractAndPrepare, { concurrency: 4 });
  await embedBatch(updates);  // batched HF inference
  await writeBatch(updates);  // LadybugDB MERGE
}
```

### Embed sub-batching (within page)

```
const EMBED_SUB_BATCH = 8;
for si in 0..allTexts.length step EMBED_SUB_BATCH:
  const subTexts = allTexts.slice(si, si + EMBED_SUB_BATCH);
  const subUpdates = allUpdates.slice(si, si + EMBED_SUB_BATCH);
  const vectors = await embedder.embed(subTexts);
  await writeVectors(subUpdates, vectors);
```

The `EMBED_SUB_BATCH=8` is separate from `NODE_PAGE_SIZE=500` — pages are I/O-bounded read units; sub-batches are GPU/CPU-bounded inference units.

### Stale embedding deletion (F1 fix-2: corruption-safety wrapper restored)

When a node's content hash changed since the last embed, delete the stale embedding row and re-embed. The DELETE may fail if the underlying vector table is in a partial state.

```
try {
  await executeQuery(`MATCH (n {id: $id})-[:HAS_EMBEDDING]->(e) DELETE e`, { id });
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes('does not exist')) {
    // benign: vector table not yet created (fresh repo); ignore
  } else {
    throw new Error(
      `[embed] stale-delete failed — vector-index may be inconsistent: ${msg}`,
      { cause: err },
    );
  }
}
```

The wrapped error preserves the `[embed]` prefix and explicit corruption-safety wording — operators see this in production logs / Sentry.

### AST chunking fallback (F1 fix-3: isDev-gated warn restored)

When a node's content is too large to embed in one shot, split via tree-sitter AST boundaries (functions split at scope; classes at method). On AST-chunking failure, fall back to character-based chunking:

```
let chunks: string[];
try {
  chunks = astChunk(node);
} catch (chunkErr) {
  if (isDev) {
    console.warn(
      `AST chunking failed for ${node.label} "${node.name}" (${node.filePath}); falling back to character chunking:`,
      chunkErr,
    );
  }
  chunks = characterChunk(node, MAX_CHUNK_LENGTH);
}
```

`isDev` from a top-of-file constant. Production runs stay quiet; dev runs surface systematic chunking failures (e.g., after a tree-sitter grammar update).

### Per-phase timings

```
const timings = { loadModel: 0, embedding: 0, indexing: 0, total: 0 };
```

Logged at completion. The `embedding` bucket conflates read+extract+embed+write+delete-stale per page — single stopwatch is sufficient for first-pass telemetry. Future work: separate buckets per phase.

### Vector index / rebuild

After all pages process, build/rebuild the LadybugDB vector index (HNSW or equivalent). The `indexing` timing covers this.

### Incremental mode

If `node.contentHash === existingEmbedding.contentHash` (via the `HAS_EMBEDDING` relationship's `hash` property), skip. The skipped count is included in progress denominator (total) but not in `processedNodes`'s incrementing — which means progress reports linearly toward 100% even when most nodes are skipped.

For a fully-fresh re-index: progress is "pages processed" not "nodes embedded"; user sees the bar move steadily. For a no-change re-index: progress jumps from 0 to 100% in seconds (only count + index-rebuild overhead).

### Dual-Store Synchronization (Consistency)

- **Capability:** A transaction-aware sync manager that ensures the Vector Store and the Graph Database (KuzuDB) stay aligned.
- **Enforcement:** If a `SymbolNode` is deleted from the graph, its associated chunks are automatically purged from the Vector DB.
- **Rollback:** Wrap Vector and Graph writes in a logical transaction that supports cleanup on failure, preventing "split-brain" retrieval where semantic search returns nodes that no longer exist structurally.

## Consequences

**Positive:**
- Memory-bounded by page size (500 nodes/page) instead of corpus size
- Deterministic pagination via `ORDER BY n.id` over PRIMARY KEY
- Bounded concurrency prevents OOM during structural extraction
- Explicit stale-delete error wrapper preserves debuggability
- AST chunking fallback warn is observable in dev

**Negative:**
- `EMBEDDING_NODE_LIMIT = 50_000` blocks Tier 3+ corpora entirely (T-2 in forward plan)
- `EXTRACTION_CONCURRENCY = 4` is hardcoded (no env override)
- Single embedding bucket conflates per-page sub-phases
- Default OFF means most users never index embeddings — vector retrieval leg is dormant by default

**Open issues for future work:**
- T-2 EMBEDDING_NODE_LIMIT removal or sharding (forward plan §1.2)
- Configurable extraction concurrency (env var)
- Per-phase timing buckets (read vs extract vs embed vs write vs delete)
- Default-on with auto-sharding for Tier 3+ corpora
