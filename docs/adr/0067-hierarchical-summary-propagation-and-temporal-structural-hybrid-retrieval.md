# ADR 0067: Hierarchical Knowledge Management, Bridge-Aware Retrieval, and Agentic Navigation

**Status:** Proposed
**Source:** Awesome-GraphRAG (GitHub: DEEP-PolyU/Awesome-GraphRAG), RAPTOR (arXiv:2401.03514), HiRAG (arXiv:2501.07431), A-RAG (arXiv:2602.03442), AgenticRAG (arXiv:2605.05538), Microsoft GraphRAG (ADR 0044), and LightRAG (ADR 0046).

## Context

Current OntoIndex GraphRAG (ADR 0044, 0046, 0065) provides robust structural navigation and direct Cypher querying. However, it faces several limitations when scaling to massive codebases:
1. **Density Gap**: We lack a **Hierarchical Summary Propagation** (RAPTOR-style) mechanism to recursively distill knowledge from L5 (Symbols) up to L1 (System).
2. **Contractual Gap**: High-level summaries often miss the **Bridge Knowledge**—the intermediate contractual glue explaining *how* communities interact.
3. **Efficiency Gap**: Agents need **Hierarchical Retrieval Interfaces** (A-RAG) to autonomously scale test-time compute (corpus -> document -> fragment) and **Iterative Navigation** tools (AgenticRAG) to "walk" the graph structurally.
4. **Diagnostic Gap**: Retrieval answers need deterministic **Provenance** and **Context Composition** reports to explain which lanes and communities contributed to a result.

This ADR consolidates the "Hierarchy and Navigation" pillar, superseding ADR 0044, 0045, 0046, 0047, 0049, 0050, 0053, 0057, 0058, and 0068.

This ADR extends:
- [ADR 0005](0005-gitmining-co-changed-with.md), for temporal coupling;
- [ADR 0030](0030-falkordb-inspired-query-budgets-and-response-diagnostics.md), for response diagnostics;
- [ADR 0061](0061-ort-inspired-native-ontology-grounded-reverse-thinking-and-systems-pressure-diagnostics.md), for global diagnostics;
- [ADR 0063](0063-nouz-inspired-native-architectural-semiotics-and-meaning-profile-aggregation.md), for semiotic profiles.

## Decision

Define the **Hierarchical Knowledge and Agentic Navigation Contract** to enable architecture-first reasoning and structural walking. This ADR is contract-first: the named graph-walking and summary-tree symbols below are proposed targets, not current implementation.

### Consolidated Requirements:

1.  **`RecursiveSummaryTree` (RAPTOR Engine)**: A sidecar that recursively clusters symbols into a tree of summaries (L5 -> L4 -> L3 -> L2 -> L1).
2.  **`RetrievalTiers` (Granularity Control)**: Tag candidates with explicit tiers (`0=Repo`, `1=File`, `2=Symbol`, `3=Fragment`).
3.  **`CommunityEvidencePack`**: A deterministic JSON artifact grouping Symbols, Processes, and Concepts within a community, including citation density and deterministic scoring.
4.  **`gn_graph_walk` (Iterative Navigation)**: A tool to move from an "Active Anchor" to its structural neighbors while maintaining a **Discovery Frontier**.
5.  **`Discovery Provenance`**: Candidates carry breadcrumbs (e.g., `[SEARCH, WALK_CALLERS, PEEK]`) explaining how they were reached.
6.  **`Bounded Relationship Expansion`**: Attach related-symbol metadata (edge type, reason) directly to retrieval candidates to explain evidence context.
7.  **`RetrievalContextComposition`**: A summary report showing result counts by kind (Symbol/File), source (Lane), and freshness.
8.  **`Episodic Retrieval Lane`**: A retrieval lane that weights symbols based on their co-occurrence in the current session's history.
9.  **`Neighborhood-Aware Ranking`**: Boosts candidates based on proximity to the active anchor and "Information Gain" (unvisited connections).
10. **`Dynamic Traversal Pruning`**: Utility that prunes "Noise Edges" from traversals based on Lens and Altitude.

## Algorithm / Technique

### 1. `TieredRetrievalCandidate`
-   **Proposed Shape**: `{ id, label, tier: 0|1|2|3, navigationPath: NavigationStep[], communityId?, relatedSymbols?: Array<{ id, type, reason }> }`.

### 2. `RecursiveSummaryTree`
-   **Proposed Native Surface**: `ontoindex/src/core/graph/summary-tree.ts`.
-   **Logic**: Leiden clustering -> LLM Summarization -> Recursive Parent Creation.

### 3. `Context Composition`
-   **Logic**: `composition = { total, byKind: Record<Kind, Count>, bySource: Record<Lane, Count> }`. Computed from materialized candidates.

### 4. `GraphWalker` (Navigation State)
-   **Proposed Native Surface**: `ontoindex/src/core/search/graph-walker.ts`.
-   **State**: Tracks `activeAnchorId`, `visitedNodes: Set`, and `stepHistory: NavigationStep[]`.

### 5. `Altitude-Aware Router`
-   **Capability**: Analyzes query intent (ADR 0012) and assigns `altitude: 'local' | 'bridge' | 'global'`.

## Implementation Solution: Pure Contract First

1. **`SummaryNode`**: Register a new node kind `Summary` in native graph storage, linked via `SUMMARIZES`.
2. **`Tier` and `Provenance` Metadata**: Update the core candidate schema.
3. **`CommunityEvidencePack`**: Versioned JSON schema for community exports.
4. **`NavigationCapability`**: Advertise "Navigation" as a first-class capability in `gn_help`.
5. **`queryAltitude` Hint**: Standardize the `altitude` parameter in retrieval requests.

## Rejected From Core

-   **Dynamic Re-Summarization**: Summaries are pre-computed during enrichment (ADR 0015).
-   **Visual Discovery Maps**: 2D/3D map generation is a frontend concern.
-   **Automatic Navigation Policies**: Decisions on *which* link to follow belong in the Agent (LLM).

## Validation Gates

- Contract review must name the first target file and symbol before implementation.
- Initial implementation must add unit tests for whichever first surface lands: candidate tier metadata, community evidence pack export, or graph-walk state.
- `gn_graph_walk` tests are required only after a public navigation tool exists.
- `RecursiveSummaryTree` propagation tests are required only after `summary-tree.ts` or its chosen successor exists.
- Performance check: any altitude routing or navigation overhead must stay <50ms after those paths are implemented.
