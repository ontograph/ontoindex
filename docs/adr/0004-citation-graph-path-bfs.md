# ADR-0004: Citation graphPath BFS and Associative Retrieval

**Status:** Accepted for bounded citation BFS; Proposed for weighted associative retrieval and diagnostics
**Date:** 2026-04-30 (v11 W3a/b); Updated 2026-06-01 to consolidate HippoRAG (ADR 0070).
**Source:** `ontoindex/src/core/search/graph-path.ts`; usage in `ontoindex/src/mcp/local/backend-search.ts`.

## Context

Agents editing code via MCP tools need stable anchors and transitive context. Standard RAG misses "Multi-Hop Latent Dependencies"—where a query about `Component A` requires context from `Config C`, but they are only connected through a long chain of intermediate wrappers (`A -> B -> C`).

Simple BFS (depth 4) over all edges can lead to "Neighborhood Explosion" where highly connected util files drown out domain logic. HippoRAG (ADR 0070, superseded) proposed a Personalized PageRank (PPR) model. This ADR keeps the implemented bounded BFS as the accepted core and treats path weighting, passive related facts, and expansion diagnostics as gated follow-up work.

This ADR extends:
- [ADR 0022](0022-qmd-inspired-structured-retrieval.md), for structured retrieval lanes;
- global diagnostics for pressure and retrieval-quality reporting;
- [ADR 0065](0065-codexgraph-inspired-native-graph-query-and-subgraph-extraction.md), for subgraph extraction.

## Decision

Compute a **bounded BFS** from each top-result `nodeId`. The implemented API returns edges in BFS traversal order as `{ fromId, toId, type, depth }[]`.

### Proposed Extensions for Associative Retrieval:

1.  **Path-Weighted Associative Context**: Instead of full PPR, we apply a "Decay Weight" to edges based on their type. `CALLS` and `INHERITS` have high weights; `IMPORTS` and `CO_CHANGED_WITH` have lower weights. This prevents activation from "leaking" into generic utility code.
2.  **Passive Fact Discovery**: Nodes encountered during BFS that have a high "Path Score" but near-zero semantic (vector) similarity to the query are tagged as `isPassiveFact: true`. These represent hidden structural dependencies.
3.  **Associative Context Squeezing**: A token-optimization filter in `traversal-pruner.ts` (ADR 0067) that removes intermediate 1-hop nodes if a distant "Hub Node" accumulates high cumulative path weight.

## Algorithm / Technique

### Public API (`graph-path.ts:33-77`)

```typescript
async function computeGraphPath(
  repoId: string,
  startNodeId: string | null | undefined
): Promise<GraphPathEdge[]>
```

`GraphPathEdge` shape today: `{ fromId, toId, type, depth }`.

### Implemented BFS expansion

```typescript
const MAX_DEPTH = 4;
const MAX_NODES = 500;

let edges: GraphPathEdge[] = [];
let visited = new Set<string>([startNodeId]);
let frontier: string[] = [startNodeId];
let depth = 0;

while (frontier.length > 0 && depth < MAX_DEPTH && visited.size <= MAX_NODES) {
  const nextFrontier: string[] = [];
  for (const nodeId of frontier) {
    let rows = await executeParameterized(repoId, cypherQuery, { nodeId });
    for (const row of rows) {
      if (!row.toId || visited.has(row.toId)) continue;
      visited.add(row.toId);
      nextFrontier.push(row.toId);
      edges.push({ fromId: nodeId, toId: row.toId, type: row.type, depth: depth + 1 });
    }
  }
  frontier = nextFrontier;
  depth++;
}
```

### Edge type filter

Traverses `CodeRelation` edges WHERE `r.type IN ['IMPORTS', 'CALLS', 'REFERENCES', 'CO_CHANGED_WITH']`. `INHERITS` is a proposed extension and requires index coverage before it can be included in the accepted edge list.

## Proposed Graph Expansion Diagnostics

To explain the reach and rigor of a graph search, future `computeGraphPath` work should provide a summary of the traversal:

```ts
interface GraphExpansionDiagnostics {
  maxObservedDepth: number;     // Deepest hop reached
  nodesVisited: number;         // Total nodes processed
  byRelationshipType: Record<string, number>; // Edge count per type
  truncated: boolean;           // Whether the MAX_NODES cap was hit
  truncatedReasons: string[];
}
```

This would let agents distinguish "dependency absent" from "dependency beyond the search horizon."

## Consequences

**Positive:**
- Keeps the implemented citation path simple and performant.
- Avoids the overhead of real-time PageRank in the accepted path.
- Defines clear follow-up hooks for passive facts and traversal diagnostics.

**Negative:**
- Approximate weights are heuristic, not mathematically identical to PPR.
- Heuristic `isSemanticZero` check requires an efficient way to check node embedding proximity at query time.
