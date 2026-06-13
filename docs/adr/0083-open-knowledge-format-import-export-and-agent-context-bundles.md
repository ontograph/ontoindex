# ADR 0083: Open Knowledge Format Import/Export and Agent Context Bundles

**Status:** Postponed
**Date:** 2026-06-13
**Source:** Google Cloud Open Knowledge Format review; narrowed against current OntoIndex wiki, docs-sidecar, export, and web surfaces.

## Context

Open Knowledge Format (OKF) is useful to OntoIndex only where it extends existing core surfaces:

- generated markdown wiki output;
- imported markdown knowledge and sidecar diagnostics;
- portable export bundles;
- markdown rendering in the web UI and static wiki viewer.

It is not useful as a replacement for the native graph, embeddings, processes, clusters, or MCP query
runtime.

Current code already provides the foundations:

- wiki generation writes markdown pages, `meta.json`, and `module_tree.json` in
  `ontoindex/src/core/wiki/generator.ts`;
- the static wiki viewer renders markdown pages and relative `.md` links from that bundle in
  `ontoindex/src/core/wiki/html-viewer.ts`;
- docs-sidecar commands already ingest and diagnose advisory markdown knowledge in
  `ontoindex/src/cli/docs.ts`;
- advisory markdown concepts already carry freshness, authority, rationale, schema evidence, and
  linked graph identities in
  `ontoindex/src/core/ingestion/enrichment/markdown-knowledge-report.ts`;
- the web UI already renders markdown content and navigable links through
  `ontoindex-web/src/components/MarkdownRenderer.tsx`.

So the right question is not "Should OntoIndex add a docs format?" The right question is:

```text
How should OntoIndex expose its current wiki/docs knowledge as a portable OKF bundle,
and how should it re-ingest OKF bundles through the existing docs/wiki/web surfaces?
```

## Review and Challenge

The first draft was still too broad.

It proposed:

- a new standalone concept model;
- a new public OKF subsystem;
- a new bundle layout with its own worldview;
- import/export semantics that were not tied tightly enough to current wiki and docs-sidecar code.

Challenge findings:

1. **The new functionality is export/import interoperability, not knowledge modeling.**
   OntoIndex already has markdown concept and provenance machinery.
2. **The current wiki pipeline is the natural export base.**
   `generator.ts` already emits structured markdown pages plus metadata and navigation data.
3. **The current docs-sidecar is the natural import base.**
   `docs.ts` and markdown-knowledge reporting already handle advisory markdown knowledge with
   freshness and authority semantics.
4. **The current web surfaces already know how to render markdown.**
   `MarkdownRenderer.tsx` and the static wiki viewer are enough for the first OKF integration.
5. **A separate OKF product surface would duplicate current docs/wiki/web behavior.**
   The ADR should only add capabilities that plug into the existing surfaces.

## Decision

Add only the following new OntoIndex core functionality:

1. **OKF export adapter** on top of the current wiki/export surfaces.
2. **OKF import adapter** on top of the current docs-sidecar/markdown-knowledge surfaces.
3. **OKF-aware web/wiki consumption** using the existing markdown renderers and current navigation
   metadata patterns.

This ADR does **not** approve:

- replacing the graph with OKF files;
- a new standalone OKF store;
- a new public MCP frontier before export/import semantics settle;
- symbol-by-symbol OKF publication by default.

## New Functionality Only

### 1. OKF Export Adapter

New capability:

- export existing OntoIndex markdown/wiki knowledge into an OKF-compatible bundle.

This extends current core solutions instead of replacing them:

- source pages come from current wiki generation and other markdown knowledge outputs;
- bundle metadata extends current `meta.json` / `module_tree.json` style metadata;
- portable export should reuse the current `export` command family rather than invent a separate
  product lane.

Preferred CLI shape:

```bash
ontoindex export okf --repo <name> --out <dir>
```

Not approved for the first phase:

- `ontoindex okf ...` as a new top-level command group;
- direct export from raw graph nodes without passing through existing documentation summarization
  surfaces.

### 2. OKF Import Adapter

New capability:

- ingest an OKF bundle as advisory markdown knowledge through the current docs-sidecar pipeline.

This extends current core solutions:

- imported OKF markdown becomes sidecar-visible documents;
- concept extraction, freshness, authority, rationale, and graph-link reporting continue to use the
  current markdown knowledge machinery;
- imported content remains advisory and separate from graph-authoritative facts.

Preferred CLI shape:

```bash
ontoindex docs import okf --repo <path> --from <dir>
```

Alternative acceptable shape:

```bash
ontoindex docs sidecar run okf --repo <path> --from <dir>
```

Not approved for the first phase:

- importing OKF directly into graph truth;
- bypassing sidecar provenance rules.

### 3. OKF-Aware Wiki/Web Consumption

New capability:

- consume exported or imported OKF markdown through the existing wiki and web renderers.

This extends current surfaces:

- static wiki viewer already handles markdown pages and `.md` link rewriting;
- web chat/right-panel renderer already handles markdown and links;
- current wiki metadata patterns (`meta.json`, `module_tree.json`) can be extended with OKF manifest
  fields instead of replaced.

Not approved for the first phase:

- a dedicated OKF web app;
- a separate OKF navigation stack parallel to wiki/web markdown navigation.

## Integration with Current Wiki Tools

### Current fit

The current wiki system is already close to an OKF export substrate:

- markdown page-per-module output;
- deterministic `overview.md` plus module pages;
- navigation metadata in `module_tree.json`;
- bundle metadata in `meta.json`;
- static offline HTML viewer over markdown pages.

### Required integration changes

1. Add an OKF manifest writer beside current wiki metadata.
2. Add YAML frontmatter to exported markdown pages where missing.
3. Preserve existing markdown page bodies; do not regenerate content into a second format.
4. Reuse relative markdown links so the current HTML viewer keeps working.
5. Map current wiki concepts into OKF-compatible types such as:
   - repository
   - module/package
   - process
   - cluster
   - ADR
   - release note

### Explicit constraint

Because `ontoindex wiki` is already deprecated at the CLI surface, OKF must integrate with the
underlying wiki generation/export internals, not depend on the deprecated command as the long-term
product entrypoint.

## Integration with Current Web Tools

### Current fit

The current web UI already renders markdown and linkable grounded content:

- `MarkdownRenderer.tsx` renders markdown blocks;
- the right panel already displays assistant/docs markdown;
- the static wiki viewer already supports offline markdown navigation.

### Required integration changes

1. Allow web/wiki surfaces to display OKF frontmatter-derived metadata such as:
   - type
   - source kind
   - repo
   - timestamp
   - commit
2. Teach the static wiki viewer to read the OKF manifest in addition to current `meta.json`.
3. Keep relative `.md` links as the primary navigation mechanism.
4. Keep OKF content renderable by the current markdown renderer without introducing custom syntax.

### Explicit constraint

The first implementation must work with the current markdown rendering stack. If OKF requires a new
client model, the ADR is over-designed.

## Algorithm / Technique

### Export Path

1. Generate or collect the current markdown knowledge surface:
   - wiki pages;
   - ADR markdown;
   - release markdown;
   - process/cluster summaries where available.
2. Normalize each page into OKF-compatible markdown with YAML frontmatter.
3. Emit:
   - `index.md`;
   - markdown concept files;
   - OKF manifest;
   - current-compatible metadata for wiki/web navigation.
4. Preserve current relative markdown link structure.
5. Mark producer, freshness, repo identity, and authority explicitly.

### Import Path

1. Scan an OKF bundle directory.
2. Validate required files and frontmatter.
3. Feed markdown documents into the docs-sidecar ingestion lane.
4. Reuse current markdown knowledge extraction and clustering.
5. Surface imported concepts through current docs knowledge reports and web/wiki markdown views.

### Provenance Rules

Imported/exported OKF records must carry:

- producer;
- repo name;
- repo path when local;
- commit when known;
- generated/imported timestamp;
- authority class (`authoritative` vs `advisory`);
- freshness/degraded warnings when source quality is weak.

## Implementation Plan

### Phase 1: Export Through Existing Surfaces

- add `export okf` under the current export command family;
- write OKF manifest + frontmatter over current wiki/exported markdown artifacts;
- add tests for deterministic file layout and manifest/provenance fields.

### Phase 2: Import Through Docs Sidecar

- add OKF bundle validation;
- ingest OKF markdown through current docs-sidecar collection/report machinery;
- add tests for malformed bundles, stale bundles, and authority labeling.

### Phase 3: Wiki/Web Consumption

- extend static wiki viewer to read OKF manifest fields;
- expose frontmatter metadata in current markdown rendering flows where useful;
- keep the rendering path markdown-first and backwards-compatible with current wiki bundles.

## Rejected Alternatives

### Replace OntoIndex Storage with OKF

Rejected. The current graph/runtime is the source of truth for code analysis.

### New Standalone OKF Command Family First

Rejected. Current `export` and `docs` command families are already the right extension points.

### New Dedicated OKF Web UI

Rejected. Current markdown/wiki/web renderers are enough for the first implementation.

### Bypass the Docs Sidecar for Import

Rejected. That would duplicate provenance and knowledge-report logic already present in the markdown
sidecar flow.

### Export Every Symbol by Default

Rejected. That would create low-signal bundle sprawl and does not match current wiki/documentation
surfaces.

## Consequences

Positive:

- gives OntoIndex a portable knowledge-bundle export format;
- reuses the current wiki and markdown sidecar investments;
- enables external knowledge ingestion without weakening graph authority;
- fits current web/wiki markdown rendering with minimal new client complexity.

Negative:

- adds another derived export surface to validate;
- requires careful mapping between current wiki metadata and OKF metadata;
- risks duplicated content if imported bundles and local docs diverge.

Mitigations:

- keep OKF as an adapter layer over current surfaces;
- preserve authority and freshness labels;
- route imports through the current docs-sidecar machinery;
- avoid adding a second rendering/navigation system.

## Guardrails

- No replacement of graph-native analysis with OKF files.
- No direct import of OKF content as authoritative dependency/impact truth.
- No new web app for OKF in phase 1.
- No new standalone OKF subsystem before current export/docs/wiki surfaces are extended first.
- No bundle without provenance, freshness, and authority metadata.

## Acceptance Criteria

- `export okf` emits an OKF-compatible bundle from current wiki/exported markdown surfaces.
- Exported files remain navigable in the current static wiki viewer with minimal adaptation.
- Imported OKF bundles flow through the current docs-sidecar path and appear in markdown knowledge
  reporting.
- Imported/exported bundle items preserve provenance, authority, and freshness metadata.
- Web/wiki markdown rendering can display OKF content without a separate rendering engine.

## Validation

For implementation work, run focused tests for touched modules plus:

```bash
cd ontoindex && npx tsc --noEmit --pretty false
cd ontoindex && npm test -- --run test/unit/export-okf.test.ts test/unit/docs-okf-import.test.ts test/unit/okf-manifest.test.ts test/unit/wiki-html-viewer-okf.test.ts
```

If implementation changes current markdown knowledge reports, add coverage proving imported OKF
content stays advisory and does not override graph-authoritative facts.
