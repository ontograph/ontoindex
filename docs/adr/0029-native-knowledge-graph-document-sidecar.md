# ADR 0029: Native Knowledge Graph Document Sidecar and Conceptual Mapping

**Status:** Implemented (Core); Updated 2026-06-01 to consolidate ADR 0033, 0037, 0039, 0044, 0048, and 0054.

**Source:** MarkTechPost article on KG-Gen (2026-05-20), Semantic Ritual (Habr 974286), and ObsidianRAG (ADR 0048).

## Context

OntoIndex manages a high-rigor code graph, but many symbols remain "Undocumented" or "Ambiguous." We need a way to define and propagate **Architectural Concepts** (e.g., Security, Persistence, Logic vs. State) throughout the graph to enable intent-aligned navigation.

This ADR serves as the unified hub for the **Document Knowledge Overlay**, consolidating requirements for conceptual mapping, semantic contracts, property extraction, and link resolution.

This ADR extends:
- [ADR 0015](0015-post-index-enrichment-sidecar.md), for sidecar enrichment;
- [ADR 0026](0026-knowledge-discovery-evidence-classification.md), for evidence classification;
- [ADR 0067](0067-hierarchical-summary-propagation-and-temporal-structural-hybrid-retrieval.md), for hierarchical retrieval altitude.

## Decision

Adopt a native **document knowledge overlay** for deterministic concept extraction, conceptual mapping, and high-fidelity evidence grounding.

### Consolidated Requirements:

1.  **Implemented: Markdown Concept Clusters**: Derived concept clusters from headings, ADR titles, requirements, code mentions, and resolved doc-to-code links.
2.  **Implemented: Semantic Evidence Grounding**: Docs evidence is advisory unless linked to code/graph evidence and checked by semantic contracts.
3.  **Implemented: Evidence Identity Normalization**: Evidence links are normalized by source fact, file path, symbol name, and graph identity where available.
4.  **Implemented: Markdown Link Resolution Diagnostics**: Reports summarize resolved, ambiguous, and unresolved doc-to-code links.
5.  **Implemented: Read-Scope and Sidecar Safety**: Docs reports expose missing, stale, partial, and degraded sidecar state.
6.  **Proposed: Native `Concept` Nodes**: Persist derived concepts as native graph nodes instead of report-only concept clusters.
7.  **Proposed: Conceptual Profiles**: Store weighted `conceptualProfile` maps on Symbol and File nodes.
8.  **Proposed: Lateral Concept Propagation**: Allow undocumented symbols to inherit conceptual profile from public callers through graph edges.
9.  **Proposed: Multi-View Concept Fusing**: Fuse Code, Test, Doc, and Diagram views into a single high-fidelity meaning profile.
10. **Proposed: Perspective Lenses**: Add an `activeLens` parameter in search APIs after concept profiles exist.
11. **Proposed: Structural Material Extraction**: Identify material types such as `Logic`, `State`, and `Bridge` from AST shape.
12. **Proposed: Requirement-to-AST Mapping**: Promote linked requirement facts into graph-backed `(Symbol)-[implements]->(Requirement)` triples.
13. **Proposed: Ambiguity Diagnostics**: Identify "Conceptual Split" where a single name label maps to disconnected implementation subgraphs.

## Algorithm/Technique

### 1. Deterministic Markdown Concept Facts

| Fact kind                       | Meaning                                                                                         |
| ------------------------------- | ----------------------------------------------------------------------------------------------- |
| `markdown-concept`              | A stable concept from a heading, ADR title, or requirement.                                     |
| `property-fact`                 | Metadata extracted from JSDoc tags (@author, @deprecated) or YAML.                              |
| `material-fact`                 | Proposed heuristic "Material Type" (Logic, State, Bridge) based on AST shape.                   |

### 2. Native Concept Clustering and Propagation

- **Clustering**: Groups facts by normalized label, ADR id, or shared code symbol mention.
- **Propagation**: Proposed lateral diffusion pass during the enrichment phase. Undocumented symbols receive a weighted sum of their public callers' profiles after concept profiles exist.

### 3. Knowledge Neighborhood and Lenses

- **Retrieval Policy**: Proposed `knowledge-neighborhood` expansion from a concept to document facts and then to code symbols.
- **Perspective Lens**: Proposed filtering/ranking pass: `score = baseRelevance * profile[activeLens]`.

### 4. Semantic Contracts and Grounding

- **Contract Rules**:
  1. **Authority consistency**: `authority: authoritative` requires a code/graph link.
  2. **Freshness consistency**: Stale graph state downgrades claims to `advisory`.
  3. **Citation requirement**: Every user-facing claim must cite an evidence source.
- **Normalization**: Keys evidence by `(source, subject, filePath, symbolName)`.
- **Link Resolution**: Maps links to `CodeRelation` or `Symbol` identities. Emits a `MarkdownLinkResolutionReport`.

## Implementation Plan

### Phase 1: Derived Concept Model
- Add TypeScript derived concept helper. Identify `material-fact` markers from AST.
- Implement link resolution report for `MarkdownDocResolver`.

### Phase 2: Conservative Clustering and Propagation
- Implement lateral propagation pass during enrichment. Group by ADR/Requirement IDs.

### Phase 3: Knowledge Neighborhood and Lenses
- Add `activeLens` parameter to `search` and `gn_explore`.

### Phase 4: Reports and Diagnostics
- Add `ontoindex report ambiguity` and `vault-boundary-diagnostics`.

## Consequences

**Positive:**
- Unified "Knowledge Overlay" reduces redundancy between docs and code search.
- "Self-Healing" graph where architectural meaning flows to undocumented modules.
- Explicit link-resolution diagnostics improve the trust and reliability of documentation evidence.
- Lenses allow for persona-driven codebase exploration (e.g., Security Auditor vs. Performance Tuner).

**Negative:**
- Propagation can be noisy in highly coupled repositories.
- Heuristic material extraction depends on project-specific naming conventions.
