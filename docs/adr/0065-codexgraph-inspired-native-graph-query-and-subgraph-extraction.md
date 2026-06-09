# ADR 0065: CodexGraph-inspired native direct graph query logic and schema-aware context

**Status:** Proposed
**Source:** CodexGraph (Alibaba ModelScope-Agent) review, 2026-06-01
**External reference:** <https://arxiv.org/abs/2408.03910>

## Context

OntoIndex currently provides high-level discovery tools (`gn_explore`, `gn_find_related`) that wrap underlying graph traversals. While efficient, these tools are "pre-baked"—they follow fixed search patterns (e.g., BFS for citations in ADR 0004). As OntoIndex moves toward autonomous agentic reasoning (ADR 0056, 0059), agents require a more flexible, "Schema-First" way to navigate the graph that is not limited by existing tool interfaces.

CodexGraph introduces an architecture where the LLM agent is explicitly provided with the **Graph Schema** and uses it to construct and execute **Direct Graph Queries** (Cypher) to explore the repository. This enables multi-hop reasoning (e.g., "Find all subclasses of X that call method Y") that would otherwise require multiple tool calls and manual context stitching.

This ADR extends:
- [ADR 0022](0022-qmd-inspired-structured-retrieval.md), for structured retrieval;
- [ADR 0030](0030-falkordb-inspired-query-budgets-and-response-diagnostics.md), for query budgets;
- [ADR 0044](0044-graphrag-inspired-native-index-artifact-and-retrieval-provenance.md), for graph-native indexing;
- [ADR 0058](0058-agenticrag-inspired-native-graph-navigation-and-discovery-provenance.md), for navigation steps.

## OntoIndex Review Evidence

- OntoIndex uses KuzuDB as its primary graph store. While Kuzu supports Cypher, OntoIndex currently hides the raw query interface from agents.
- `gn_help` and `gn_tool_contract` expose tool schemas, but the **Graph Database Schema** (Node labels like `Function`, `File`; Edge types like `CALLS`, `INHERITS`) is not currently exposed in a format optimized for agentic reasoning.
- Existing retrieval results return a list of symbols/files. There is no native core utility to extract and package an arbitrary **Subgraph** as a single structured context object for an LLM prompt.

## Pruned Core Recommendations

### 1. `gn_graph_query` (Direct Cypher Interface)
-   **Capability**: A new MCP tool that allows authorized agents to execute direct Cypher queries against the KuzuDB graph.
-   **Native Surface**: `ontoindex/src/mcp/super/graph-query.ts`.
-   **Governance**: Queries are subject to `QueryBudget` (ADR 0030) and `TokenEconomy` (ADR 0062) enforcement.

### 2. `GraphSchemaManifest` (Contextual Schema Injection)
-   **Capability**: A native service that produces a compact, LLM-readable summary of the active graph schema (Node/Edge labels and their properties).
-   **Native Surface**: `ontoindex/src/core/graph/schema-manifest.ts`.
-   **Shaping**: Renders the schema in a compact, Shape-like format (e.g., `Function -> { name: string, calls: Function* }`) to minimize token overhead while preserving structural rules.
-   **Purpose**: Injected into the system prompt to enable agents to formulate valid `gn_graph_query` calls.

### 3. `SubgraphContextExtractor` (Neighborhood Packaging)
-   **Capability**: A utility that extracts an arbitrary subgraph (defined by a query or a node + k-hops) and serializes it as a highly compact format (e.g., N-Triples or JSON-LD) to minimize token consumption.
-   **Native Surface**: `ontoindex/src/core/graph/subgraph-extractor.ts`.
-   **Purpose**: Avoid the "Lost in the Middle" problem by providing structured, relational context instead of raw text chunks, ensuring massive token savings compared to deeply nested JSON.

### 4. `IterativeDiscoveryRefinement` (Missing Node Feedback)
-   **Capability**: A core feedback loop where if a `gn_graph_query` returns 0 results or a schema error, OntoIndex suggests "Near-Miss" symbols or schema-legal alternative paths using `QueryGuardReport` hints (ADR 0038).
-   **Native Surface**: Extension of `gn_graph_query` response logic.

### 5. `SemanticAmbiguityResolver`
-   **Capability**: A pre-query validation step where if an agent searches for a fuzzy term (e.g., "User"), the core forces the agent to disambiguate whether it means the `User` class (Node), the `users` table (Node), or a related edge, based on the Shape manifest.
-   **Native Surface**: Embedded within the `gn_graph_query` parameter validation.

### 6. `QueryTemplateGrounding` (Example RAG)
-   **Capability**: An advisory retrieval layer that fetches curated Cypher query examples from `ONTOINDEX.md` or a `.ontoindex/queries` folder when the agent invokes a query tool, grounding generation in verified patterns.
-   **Native Surface**: `ontoindex/src/core/search/query-template-provider.ts`.

### 7. `Graph-Path Logic Validation`
-   **Capability**: A pre-check during `gn_safe_refactor` that uses graph queries to verify if a proposed change violates a structural invariant (e.g., "Circular dependency detected via the INHERITS graph").
-   **Native Surface**: `ontoindex/src/core/refactor/graph-invariant-check.ts`.

## Decision

Implement the **Direct Graph Query and Subgraph Extraction Contract** to enable schema-first agentic navigation.

### Implementation Solution: Pure Contract First

1.  **`QueryResultEnvelope`**: Standardize the JSON response for direct Cypher queries, including `nodes`, `edges`, and `path` metadata.
2.  **`SchemaInjectionHook`**: Add a hook to the agent's startup turn to automatically provide the graph schema (using the compact Shape format).
3.  **`gn_get_subgraph`**: Register a dedicated MCP tool for structured neighborhood extraction, prioritizing compact N-Triples output.
4.  **`QueryRepairHint` Integration**: Enhance `gn_graph_query` to return `repairHints` from the `QueryGuardReport` (ADR 0038) when a query fails execution due to structural errors.

## Rejected From Core

-   **Autonomous Graph Editing via Cypher**: We do not allow agents to write `CREATE` or `DELETE` Cypher queries. The graph remains a read-only source of truth; updates are gated by the `Audit Lifecycle` (ADR 0017) and `Safe Refactor` (ADR 0064) layers.
-   **Natural Language to Cypher Translation (Standalone)**: While the agent generates the query, we do not provide a dedicated "NL2Cypher" black-box tool. We provide the *schema* and the *query tool*, allowing the LLM's natural reasoning to perform the mapping.
-   **Programmatic Graph ORM / Conjunctive Views**: We reject building a complex TypeScript Graph ORM or multi-context conjunctive viewing layer. Agents will continue to use standard Cypher strings and structured MCP queries to keep the execution layer decoupled and fast.

## Validation Gates

- `npm run build`
- Unit tests verifying that `gn_graph_query` correctly handles complex Cypher joins (e.g., finding all common ancestors of two classes).
- Assertion that the `SubgraphContextExtractor` produces a valid, compact JSON representation that can be parsed by a standard LLM.
- Performance check: Direct Cypher queries must respect the `TIMEOUT_MS` and `MAX_NODES_VISITED` guards of the `QueryBudget`.
