# ADR 0087: Graphify-Inspired Core Provenance and Agent Wiki Navigation

**Status:** Proposed - Narrowed After Review
**Date:** 2026-06-17
**Source:** `./tmp/graphify` donor review, challenged against current OntoIndex source and ADRs
0020, 0026, 0084, and 0086.

## Context

Graphify contributes useful product ideas: graph freshness hints, edge confidence labels, god-node
reports, community wiki pages, token-reduction estimates, static HTML export, and git/watch helper
flows.

OntoIndex already has most of the underlying core:

- `analyze`, `status`, runtime-health, `mcp-doctor`, and response budgets from ADR 0086;
- graph-aware review reports, confidence/provenance discussion, hub/surprising-connection follow-ups
  from ADR 0020;
- HTML graph/wiki export direction from ADR 0084;
- evidence class and advisory-memory trust boundaries from ADR 0026;
- numeric confidence on graph, ingestion, systems-audit, sidecar, and recommendation records.

The initial ADR was too broad. It re-approved hooks/watchers and cost budgets that ADR 0086 already
bounded, and it risked creating another provenance vocabulary beside ADR 0020/0026.

## Review and Challenge

Architecture-fit gate:

1. **Real new functionality gate:** pass only for a small delta. Freshness, budgets, wiki export,
   graph HTML, confidence fields, and memory already exist. New work must be limited to user-visible
   provenance normalization and wiki navigation that current surfaces do not expose consistently.
2. **Core-extension gate:** pass only if implemented inside existing `status`, response-envelope,
   review/query output, wiki/export, and graph HTML paths. Reject new graph stores, new MCP tools,
   Claude-only flows, or hidden background indexing.

Challenge findings:

1. **Hooks/watchers are not a first deliverable.**
   ADR 0086 explicitly postponed file watcher sync and rejected automatic background index writes.
   ADR 0020 also rejects hook-triggered report generation by default. This ADR may define marker
   semantics only; hook/watch commands remain postponed unless a later ADR narrows them.
2. **Provenance must not fork evidence classification.**
   ADR 0026 already owns authoritative evidence classes. `extracted | inferred | ambiguous` can only
   be a graph-fact provenance overlay, not an audit authority model.
3. **Cost estimates belong to ADR 0086.**
   This ADR should not create a new budget system. It can require wiki/export/query surfaces to
   display existing truncation/budget metadata when available.
4. **Wiki navigation must extend ADR 0084.**
   Community/god-node pages and filters are useful only if they reuse current graph export/wiki data.
   No LLM wiki generator, no Graphify-style separate graph artifact.
5. **MCP evidence is currently unavailable for this repo.**
   The live MCP session is scoped to `codex`, while local CLI status for this checkout reports a stale
   self-index. Implementation must not assume MCP is correctly scoped.

## Decision

Approve one narrow capability:

**Expose graph-fact provenance and agent navigation metadata through existing OntoIndex outputs.**

Approved scope:

1. a shared graph-fact provenance overlay for agent-facing output;
2. wiki/community/god-node navigation pages generated from existing graph data;
3. graph HTML/wiki filters and counts for provenance, community, and truncation state;
4. optional `.ontoindex/needs_update` marker reporting in `status` only, if implemented as a passive
   diagnostic.

Not approved:

- `ontoindex watch`;
- `ontoindex hook install|status|uninstall`;
- automatic analyze on save or commit;
- new MCP query tools;
- new graph database/runtime;
- NetworkX dependency;
- multimodal PDF/image extraction;
- Obsidian/Neo4j push paths;
- query memory as authoritative evidence;
- marketing token-reduction claims.

## What Is New

### 1. Graph-Fact Provenance Overlay

Add a small shared type for display:

```ts
type GraphFactProvenance = 'extracted' | 'inferred' | 'ambiguous';
```

Rules:

- It is derived from existing relation type, extractor origin, sidecar state, or numeric confidence.
- It does not replace numeric confidence.
- It does not replace ADR 0026 evidence classes.
- `ambiguous` facts are exploration-only unless separately verified by existing audit gates.

First render targets:

- review/diff outputs;
- impact/query evidence rows;
- wiki pages;
- graph HTML details panels.

### 2. Agent Wiki Navigation

Extend ADR 0084's wiki/export path with markdown pages that require no LLM:

- `index.md` as agent entrypoint;
- one community page per significant community;
- one god-node page for selected high-centrality symbols/modules;
- cross-community bridge summaries;
- provenance/confidence counts;
- truncation notices for shortened lists.

This should reuse current graph export data and current wiki output directories.

### 3. Passive Freshness Marker Reporting

If `.ontoindex/needs_update` exists, `status` may report:

- marker reason;
- marker creation time if available;
- exact repair command.

This ADR does not approve creating that marker via a new watcher or hook. Marker writers can be
added later only if they satisfy ADR 0086 runtime-health constraints.

### 4. Budget Metadata Reuse

When wiki/export/query output is shortened, reuse ADR 0086 truncation metadata:

- `truncated`;
- omitted count;
- retry/cursor guidance where available.

Do not add a second token-budget model.

## Implementation Plan

### Phase 1: Provenance Display Kernel

1. Add a graph-fact provenance helper near existing confidence/evidence helpers.
2. Map known high-confidence structural relations to `extracted`.
3. Map heuristic/fuzzy/sidecar-low-confidence facts to `inferred` or `ambiguous`.
4. Add tests proving `ambiguous` is not audit-verifying evidence.

### Phase 2: Wiki Navigation

1. Extend current wiki/export code to emit community and god-node markdown pages.
2. Add provenance and confidence breakdowns.
3. Add truncation notices.
4. Link generated pages from the current wiki entrypoint.

### Phase 3: Visual Filters

1. Add provenance/community/truncation metadata to graph HTML export if already available.
2. Add lightweight filters in the existing static artifact.
3. Do not add a server dependency.

### Phase 4: Passive Status Marker

1. Add a read-only `.ontoindex/needs_update` parser.
2. Surface it from `status` and runtime-health metadata.
3. Do not add marker writers in this ADR.

## Acceptance Criteria

- Agent-facing graph facts can show provenance without changing graph storage.
- `ambiguous` facts remain non-authoritative for audit status.
- Wiki export includes an agent-readable entrypoint plus community/god-node pages.
- Wiki/HTML outputs expose provenance counts and truncation notices.
- `status` can report an existing `.ontoindex/needs_update` marker.
- No watcher, hook installer, new MCP frontier, new graph store, or hidden auto-index is added.

## Current Evidence

MCP evidence is not authoritative for this checkout in the current session:

```text
MCP gn_diagnose repo: ontoindex -> resolves codex
repoPath: /opt/demodb/_workfolder/ontocode
```

Local CLI evidence for this checkout:

```text
Repository: /opt/demodb/_workfolder/OntoIndex
Indexed commit: 4cfc172
Current commit: 861549f
Runtime health: stale
Repair: ontoindex analyze
```

This ADR therefore uses source review and local CLI evidence, not MCP calls against `repo:
"ontoindex"`.

## Related Decisions

- ADR 0020: graph-aware review reports
- ADR 0026: evidence classification
- ADR 0084: HTML-first visual wiki and architecture export surfaces
- ADR 0086: runtime freshness and budget controls

