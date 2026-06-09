# ADR 0081: Virtuoso-inspired native multi-model virtual views and anytime queries

**Status:** Proposed
**Source:** OpenLink Virtuoso (GitHub: openlink/virtuoso-opensource) review, 2026-06-01
**External reference:** <https://github.com/openlink/virtuoso-opensource>

## Context

OntoIndex maintains an increasingly dense Knowledge Graph (KuzuDB) combining AST facts, temporal coupling (ADR 0005), and spatial-temporal topography (ADR 0073). However, as OntoIndex scales into enterprise environments, two major bottlenecks emerge:

1. **The Silo Problem**: Critical codebase context lives outside the code (e.g., Jira tickets in external SQL DBs, CI/CD logs in ClickHouse). Currently, integrating this requires full ETL replication (ADR 0077), duplicating massive amounts of data into KuzuDB.
2. **The "Queries from Hell" Problem**: When agents write direct Cypher (ADR 0065) or utilize Federated Joins (ADR 0080), multi-hop queries over a 10-million node monorepo can cause execution timeouts. Currently, hitting a `TimeoutError` causes the agent's entire turn to crash, wasting token budgets and destroying context.

OpenLink Virtuoso, a "Universal Server," solves these through **Linked Data Views** (mapping SQL transparently to RDF without duplicating data), the **Sponger Middleware** (Just-In-Time extraction of raw web data), and **Anytime Query Processing** (returning mathematically sound partial results if a timeout is reached).

By adapting these, OntoIndex can seamlessly unify external project management databases into the code graph and guarantee responsive agentic loops even under extreme graph complexity.

This ADR extends:
- [ADR 0030](0030-falkordb-inspired-query-budgets-and-response-diagnostics.md), for query budgets;
- [ADR 0065](0065-codexgraph-inspired-native-graph-query-and-subgraph-extraction.md), for direct graph queries;
- [ADR 0073](0073-knowwheregraph-inspired-native-spatial-temporal-codebase-topography-and-geo-enriched-intelligence.md), for geo-enrichment;
- [ADR 0077](0077-cognee-inspired-native-declarative-ingestion-pipelines-and-dual-store-synchronization.md), for ETL pipelines.

## OntoIndex Review Evidence

- External data ingestion (ADR 0077) assumes data is fetched, parsed, and persistently written into KuzuDB. We lack a **Virtual View** primitive to query a local SQLite database *as if* it were part of the KuzuDB graph.
- When an agent searches for an un-indexed log snippet or a URL, OntoIndex cannot dynamically parse it mid-query. There is no **JIT Sponging** middleware.
- `QueryBudget` (ADR 0030) tracks and enforces timeouts. However, when the limit is breached, the execution halts and throws. It does not return the subset of the graph that *was* successfully computed before the clock ran out.

## Pruned Core Recommendations

### 1. `LinkedDataVirtualView` (Zero-Copy Integration)
- **Capability:** A native mapping layer that translates specific Cypher graph queries into SQL statements aimed at an attached external database (e.g., an SQLite file containing GitHub Issues).
- **Native Surface:** `ontoindex/src/core/storage/virtual-view-mapper.ts`.
- **Purpose:** Allow agents to query `(File)-[:MENTIONED_IN]->(Issue)` natively in Cypher, while the core pushes the `Issue` lookup down to the SQL engine without ever duplicating the issue data into KuzuDB.

### 2. `AnytimeQueryEngine` (Partial Subgraph Returns)
- **Capability:** An execution wrapper for KuzuDB. When a query hits its assigned time budget (e.g., 2000ms), instead of throwing an error, the engine halts the search and returns a `PartialStructuredResult` containing whatever nodes and paths were discovered up to that millisecond.
- **Native Surface:** `ontoindex/src/core/runtime/anytime-query.ts`.
- **Purpose:** Guarantee that agents always receive usable context, even if the graph traversal was too ambitious, preventing expensive session crashes.

### 3. `CodebaseSpongerMiddleware` (JIT Extraction)
- **Capability:** A middleware layer in the retrieval pipeline. If a query requests a specific external entity (e.g., a Sentry Error URL or a live API docs link) that is not in the graph, the Sponger fetches the raw text, runs a lightweight SPIRES extraction (ADR 0076) on the fly, and injects it as a transient node into the query session.
- **Native Surface:** `ontoindex/src/core/search/sponger-middleware.ts`.

### 4. `PolyglotQueryRouter` (Multi-Model Dispatch)
- **Capability:** An AST-level query parser that splits a federated request: routing graph traversal components to KuzuDB and relational filters (e.g., "Where issue.status = 'OPEN'") to the underlying Virtual SQL views.
- **Native Surface:** `ontoindex/src/core/search/polyglot-router.ts`.

### 5. `StatisticalIncompleteAggregations`
- **Capability:** When an `AnytimeQuery` is halted during an aggregation (e.g., counting total callers across a monorepo), the engine returns an estimated count based on the processed slice, flagged with `is_approximate: true`.
- **Native Surface:** Extension of `query-budget.ts`.

## Decision

Implement the **Virtual Views and Anytime Query Contract** to optimize enterprise-scale monorepo retrieval.

### Implementation Solution: Pure Contract First

1. **`VirtualMappingSchema`**: Define a schema format (`.vview.yaml`) to map SQL tables to Graph Nodes/Edges (e.g., `IssueTable.id -> Node:Issue`).
2. **`PartialResultEnvelope`**: Update the `RetrievalCandidate` and `StructuredRetrievalResult` envelopes to include `isPartial: boolean` and `exhaustedResource: 'time' | 'nodes'`.
3. **`gn_sponger_fetch`**: A specialized internal capability that triggers JIT entity extraction during search evaluation.

## Rejected From Core

- **Full Universal Database Engine**: OntoIndex is not building a bespoke C++ hybrid database engine from scratch. We rely on KuzuDB for graphs and DuckDB/SQLite for tabular data, using a TypeScript middleware layer (`PolyglotQueryRouter`) to orchestrate the "Universal Server" illusion.
- **Unbounded JIT Sponging**: The Sponger is strictly time-boxed. If an external URL takes too long to fetch or parse, the Anytime Engine halts it and returns the base graph context.

## Validation Gates

- `npm run build`
- Unit tests verifying that querying a `VirtualView` successfully translates a Cypher `MATCH` into a `SELECT` against an attached SQLite DB.
- Assertion that a highly recursive Cypher query configured with a 500ms timeout returns a valid, well-formed `PartialResultEnvelope` containing 500ms worth of nodes, rather than a crash stack trace.
- Performance check: The Polyglot Query Router must add <10ms overhead when dispatching a split query.
