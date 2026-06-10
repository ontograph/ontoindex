# ADR 0067: Core retrieval context composition and navigation provenance

**Status:** Implemented (core retrieval context composition)
**Source:** Awesome-GraphRAG review; RAPTOR, HiRAG, A-RAG, AgenticRAG, Microsoft GraphRAG, and LightRAG; narrowed 2026-06-10

## Context

Awesome-GraphRAG-style systems emphasize hierarchical retrieval, provenance, and graph navigation. Those ideas are useful for OntoIndex, but the original ADR bundled too many already-existing or non-core surfaces:

- community detection already exists in `ontoindex/src/core/ingestion/community-processor.ts`;
- deterministic community evidence-pack export already exists through `runCommunityEvidencePack`;
- raw graph query and subgraph context packaging are covered by ADR 0065;
- graph traversal and ranking already exist under `ontoindex/src/core/search/graph-traversal-rank.ts`;
- semantic/ANN frontier traversal already exists under `ontoindex/src/core/search/semantic-frontier-search.ts`;
- summary-tree graph nodes and `SUMMARIZES` relationships already exist in `ontoindex/src/core/ingestion/pipeline-phases/summary-tree.ts`;
- `gn_graph_walk` already exists as an experimental public super-tool;
- review/export code already carries freshness and provenance metadata;
- MCP navigation tools, `gn_help` capability advertising, and frontend maps are adapter/UI concerns.

The new core gap is narrower: OntoIndex lacks one pure contract that normalizes retrieval candidates from multiple lanes into tiered, provenance-bearing context composition reports. Today that summary logic is scattered across retrieval, review, export, diagnostics, and MCP response layers.

## Challenge Findings

1. `RecursiveSummaryTree`, `SummaryNode`, and `SUMMARIZES` are not new for this ADR; the summary-tree ingestion phase already exists.
2. LLM summary propagation policy is still outside this ADR because it requires enrichment/model governance beyond a pure core contract.
3. `CommunityEvidencePack` is not new; a backend/export path already exists.
4. `gn_graph_walk` is not new; it is already registered as an experimental public super-tool.
5. `NavigationCapability` advertisement is not new core; graph-walk tool metadata already exists.
6. Episodic retrieval lanes depend on session state and policy outside core retrieval composition.
7. Altitude routing from query intent is a retrieval adapter concern unless a pure enum/classifier contract exists first.
8. Dynamic traversal pruning over graph edges overlaps existing traversal/ranking logic and should not be bundled with context composition.

## Decision

Add one core extension: a pure retrieval context composition module that accepts materialized retrieval candidates and returns deterministic tier, provenance, neighborhood, and composition metadata.

This preserves the new OntoIndex-core value from ADR 0067:

- make retrieval granularity explicit;
- retain provenance breadcrumbs across lanes;
- summarize context composition deterministically;
- attach bounded relationship metadata to candidates;
- provide a reusable contract for later MCP, CLI, review, and docs surfaces.

## Core Functionality

Create a pure core module:

`ontoindex/src/core/search/retrieval-context-composition.ts`

The module should expose types similar to:

- `RetrievalTier = 0 | 1 | 2 | 3`
- `RetrievalAltitude = "local" | "bridge" | "global"`
- `NavigationStep`
- `RelatedRetrievalSymbol`
- `TieredRetrievalCandidate`
- `RetrievalContextCompositionInput`
- `RetrievalContextCompositionReport`
- `RetrievalCompositionLimits`
- `RetrievalCompositionFreshness`

The module should expose:

- `composeRetrievalContext(input): RetrievalContextCompositionReport`

## Required Behavior

The core implementation must:

1. Accept supplied candidates from existing retrieval lanes.
2. Normalize each candidate into an explicit tier:
   - `0 = repo/system`
   - `1 = file/module`
   - `2 = symbol`
   - `3 = fragment`
3. Preserve provenance breadcrumbs such as search lane, graph traversal step, related symbol source, and freshness.
4. Attach bounded `relatedSymbols` metadata without traversing the graph.
5. Compute deterministic counts by tier, kind, source lane, freshness, community id, and altitude.
6. Sort candidates deterministically by tier, score descending, id, and label.
7. Enforce explicit limits for candidates, related symbols per candidate, provenance steps per candidate, and warning count.
8. Return truncation metadata instead of silently dropping context.
9. Emit warnings for duplicate candidate ids, unknown tiers, invalid scores, and dangling related-symbol references when they can be detected from supplied data.
10. Avoid all database access, graph traversal, Cypher parsing, MCP/CLI registration, file reads, prompt injection, session reads, LLM calls, and graph storage changes.

## Algorithm/Technique

The implementation should use a pure data-normalization pipeline:

1. Normalize candidates into immutable records keyed by `id`.
2. Deduplicate by `id`, keeping the highest score and merging provenance/related metadata deterministically.
3. Normalize tier, kind, lane, freshness, community id, and altitude into small enums/strings.
4. Sort provenance steps by sequence when present, then by source/action/target.
5. Sort related symbols by relation type, score descending, id, and label.
6. Apply limits after sorting.
7. Build a report with:
   - emitted candidates;
   - observed counts before limits;
   - emitted counts after limits;
   - `byTier`, `byKind`, `bySource`, `byFreshness`, `byCommunity`, and `byAltitude`;
   - truncation flags;
   - warnings.

The module must not query existing graph/search backends. Existing search, graph traversal, semantic frontier, review, and MCP layers may later adapt their outputs into this module.

## Rejected From Core

- New `RecursiveSummaryTree`, `SummaryNode`, or `SUMMARIZES` implementation.
- LLM summary propagation policy.
- New community detection.
- New `CommunityEvidencePack` implementation.
- New `gn_graph_walk` MCP tool.
- `NavigationCapability` advertisement in `gn_help`.
- Automatic graph walking policy.
- Episodic/session-history retrieval lane.
- Altitude intent classifier backed by current query text.
- Dynamic graph traversal pruning.
- Frontend discovery maps.
- Direct Cypher, graph traversal, or database reads.

These can be proposed later as adapters or larger storage/enrichment ADRs after the pure composition contract exists.

## Later Adapter Opportunities

After the core module lands, later work may:

- adapt semantic/BM25/graph traversal results into `TieredRetrievalCandidate`;
- expose the composition report in MCP search responses;
- feed community evidence-pack rows into the composition report;
- add an altitude hint parameter to retrieval APIs;
- adapt existing `gn_graph_walk` responses into `NavigationStep` breadcrumbs;
- adapt existing summary-tree nodes into composition candidates.

## Acceptance Criteria

1. `ontoindex/src/core/search/retrieval-context-composition.ts` exists and exports the public types/function above.
2. The implementation is pure and deterministic.
3. Unit tests cover:
   - tier normalization;
   - deterministic sorting;
   - provenance preservation;
   - related-symbol limits;
   - duplicate candidate merging;
   - counts by tier/source/kind/freshness/community/altitude;
   - truncation flags;
   - empty input;
   - no DB/Cypher/MCP/session/LLM dependency.

## Validation Gates

- `cd ontoindex && npm test -- --run test/unit/retrieval-context-composition.test.ts`
- `cd ontoindex && npx tsc --noEmit --pretty false`

## Stop Conditions

Stop and re-review the ADR if implementation requires:

- adding graph storage schema;
- running clustering or summarization;
- adding a new MCP/CLI tool;
- querying the graph or filesystem from the core module;
- reading session history;
- adding LLM calls;
- changing existing retrieval adapters before the pure module exists.
