# Search, Embeddings, And ANN Frontier

## Search Surface

OntoIndex search is exposed through the CLI, HTTP API, and MCP facade/super-function layers.

Main code areas:

| Path | Responsibility |
| --- | --- |
| `ontoindex/src/core/search/` | Query classification, retrieval composition, semantic cache, frontier search, replay gates. |
| `ontoindex/src/core/embeddings/` | Chunking, embedding pipeline, ANN neighbors, HTTP embedding client, structural extraction. |
| `ontoindex/src/mcp/local/backend-search.ts` | Local MCP search backend. |
| `ontoindex/src/mcp/super/explore.ts` | Agent-friendly concept exploration. |

## Retrieval Modes

The MCP `search` facade supports:

- `semantic`
- `cypher`
- `repomap`

Semantic search can opt into structured output, skeletons, Markdown context, passive related facts, and retrieval policies such as symbol, process, route, and requirement neighborhoods.

## Embeddings

The current self index reports zero embeddings in the repo listing. That means graph and lexical retrieval are available, but vector-backed lanes may degrade or skip unless embeddings are generated.

Embedding-related commands and APIs are available through:

- CLI analyze options
- `/api/embed`
- `ontoindex/src/core/embeddings/embedding-pipeline.ts`
- `ontoindex/src/core/embeddings/ann-neighbor-store.ts`

## ANN Neighbor Graph

Recent architecture work added a semantic ANN neighbor frontier. The core idea is to store bounded nearest-neighbor links for embedded code chunks and use them as a fast semantic expansion lane.

The relevant code lives under:

- `ontoindex/src/core/embeddings/ann-neighbor.ts`
- `ontoindex/src/core/embeddings/ann-neighbor-store.ts`
- `ontoindex/src/core/search/semantic-frontier-search.ts`
- `ontoindex/src/core/search/semantic-frontier-adapter.ts`

## Operational State

If semantic quality looks weak, first check:

```bash
node /opt/demodb/_workfolder/OntoIndex/ontoindex/dist/cli/index.js status
```

Then regenerate embeddings only when explicitly needed, because embedding work is heavier than graph-only indexing.
