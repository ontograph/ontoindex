# ADR 0084: HTML Graph Export with Functional Slice Filters

**Status:** Proposed - Challenged/Core Extension Only
**Date:** 2026-06-13
**Source:** `plannotator/effective-html` review; narrowed against current OntoIndex graph, wiki export, static HTML viewer, and web filtering surfaces.

## Context

OntoIndex already has:

- a graph-backed repo model;
- process and community/cluster information;
- a static HTML wiki viewer;
- a live web graph canvas with filtering behavior.

So generic "HTML-first wiki" is not real new functionality.

The real missing capability is narrower and more concrete:

```text
OntoIndex core graph/process/community evidence
  -> self-contained exported HTML graph artifact
  -> evidence-backed visual graph view
  -> functional slice filters over the exported graph
```

This matters because the current web graph is interactive only inside the running app, while the
current static wiki viewer is markdown-first and does not export a graph-centric architecture view.

## Review and Challenge

The earlier ADR draft still mixed several different ideas:

1. richer HTML styling;
2. visual pages in general;
3. wiki linkage;
4. possible web integration.

That was too broad.

Challenge findings:

1. **The real new functionality is static HTML graph export.**
   OntoIndex already renders HTML and already has live graph UI. The missing piece is a portable,
   evidence-backed exported graph artifact.
2. **Functional slices are the real differentiator.**
   A useful exported graph must let users isolate architecture by process, cluster, module, or other
   functional slices.
3. **The export must come from OntoIndex core data, not from markdown summaries alone.**
   The source of truth is the graph, process, and community data already produced by the core.
4. **This should extend current export/wiki surfaces, not replace the web app.**
   The exported artifact is a derived static view, not a second graph product.
5. **Web integration should remain secondary.**
   The live app already has filtering; phase 1 value is portable export.

## Decision

Add only one new OntoIndex core capability:

1. **self-contained HTML graph export** generated from current OntoIndex core data, with
   **functional slice filters**.

This ADR does **not** approve:

- a new generic HTML docs subsystem;
- replacing the live web graph;
- manually authored architecture diagrams;
- a markdown-only implementation that ignores current graph/process/community evidence.

## New Functionality Only

### HTML Graph Export

New capability:

- export an interactive static HTML graph view from current OntoIndex core data.

Required source data:

- graph nodes and relationships;
- process nodes and process membership/steps where available;
- community/cluster membership;
- file/module identity where available;
- repo/provenance metadata.

Required output properties:

- self-contained HTML artifact;
- graph visualization rendered from exported structured data;
- no server dependency after export;
- deterministic output for the same repo state;
- provenance metadata in the artifact.

### Functional Slice Filters

New capability:

- the exported HTML graph must let users filter to functional slices derived from OntoIndex core
  evidence.

Approved first slice dimensions:

- by process;
- by cluster/community;
- by module/package/file area;
- by node/relationship type;
- by depth relative to a selected anchor node.

Optional later slice dimensions:

- by risk or review scope;
- by changed-symbol subset;
- by test coverage hints.

## Integration with Current Core Solutions

### Core graph source

This feature must pull from OntoIndex core graph/process/community outputs, not from ad hoc markdown
pages.

Relevant current substrate already exists in:

- graph/core analysis outputs in the CLI/core pipeline;
- process and community information exposed across the current graph and web UI;
- filtering behavior already present in the live web graph experience.

### Export/wiki integration

The new capability should extend the current export/wiki path:

1. generate HTML graph artifacts under the current export or wiki pipeline;
2. link those artifacts from wiki output when appropriate;
3. keep markdown wiki pages as textual companion context, not as the source of graph rendering.

Preferred command shape:

```bash
ontoindex export graph-html --repo <name> --out <dir>
```

Acceptable alternative:

```bash
ontoindex wiki --graph-html
```

Architecture-fit preference:

- use existing export/wiki families;
- avoid a new top-level command family.

### Existing web alignment

The exported graph should align with the current web graph model and filter vocabulary where
reasonable, so users do not learn two different systems.

This means:

- reuse process/community/module naming;
- reuse existing filter concepts where possible;
- do not fork semantics between the static export and the live graph UI.

## Algorithm / Technique

### Export pipeline

1. Read current repo graph data from OntoIndex core outputs.
2. Build an export graph payload containing:
   - nodes;
   - edges;
   - process memberships;
   - community memberships;
   - module/file grouping hints;
   - provenance metadata.
3. Derive slice indexes for:
   - processes;
   - communities/clusters;
   - modules/areas;
   - node labels/types.
4. Emit a self-contained HTML file with:
   - embedded graph payload;
   - graph renderer;
   - filter controls;
   - bounded textual context and provenance.

### Filter behavior

The first exported artifact must support:

1. selecting one or more processes;
2. selecting one or more communities/clusters;
3. selecting one or more modules/areas;
4. hiding unrelated node labels/types;
5. depth-filtering around an anchor node.

The exported slice semantics must remain evidence-backed:

- no synthetic slice categories detached from core data;
- no manual tagging required for phase 1.

### Output shape

Approved first artifact:

- `graph-overview.html`

Approved optional supporting artifacts:

- `graph-process-<slug>.html`
- `graph-cluster-<slug>.html`

But phase 1 only requires one exported graph overview artifact with working filters.

## Implementation Plan

### Phase 1: Exported Graph Artifact

- add `graph-html` export under current export/wiki internals;
- export a self-contained HTML graph view from core data;
- include process/community/module/type/depth filters;
- add deterministic output tests for payload structure and metadata.

### Phase 2: Wiki Linkage

- link the exported graph artifact from current wiki output;
- preserve markdown-only compatibility;
- add tests proving wiki bundles remain valid when graph HTML is absent or present.

### Phase 3: Optional semantic alignment with web UI

- align filter vocabulary and display conventions with the live graph UI where useful;
- avoid duplicating the live app’s full feature set.

## Rejected Alternatives

### Generic HTML Visual Pages Without Graph Export

Rejected. The real delta is graph export plus slice filtering.

### Markdown-Derived Visuals as Primary Input

Rejected. Current OntoIndex core graph data is the correct source of truth.

### Standalone HTML Graph Product

Rejected. This must extend the current export/wiki surfaces.

### Manual Architecture Diagrams

Rejected. Visuals must remain derived from core evidence.

### Full Web-App Parity in the Static Export

Rejected. The export should be useful and portable, not a clone of the running application.

## Consequences

Positive:

- gives OntoIndex a portable graph-centric architecture artifact;
- lets users inspect functional slices without a running server;
- reuses OntoIndex core graph/process/community data;
- complements the markdown wiki with a stronger visual architecture surface.

Negative:

- adds another derived artifact to maintain;
- creates pressure to keep static-export semantics aligned with the live graph UI;
- can drift into a second graph product if scope is not controlled.

Mitigations:

- keep the export derived from the same core data as the live graph;
- keep slice dimensions limited to current OntoIndex evidence;
- avoid full UI parity goals.

## Guardrails

- No new standalone HTML subsystem.
- No export built primarily from markdown summaries.
- No manual diagrams or manual slice tagging for phase 1.
- No attempt to reproduce the full live web app in static HTML.
- No filter dimension that is not backed by current OntoIndex core data.

## Acceptance Criteria

- OntoIndex can export a self-contained `graph-overview.html` artifact from current core graph data.
- The artifact supports functional slice filters for process, cluster/community, module/area,
  node/relationship type, and depth around an anchor node.
- The artifact includes provenance metadata and remains clearly derived/non-authoritative.
- The current wiki/export pipeline can link to the artifact without breaking existing markdown-only
  behavior.

## Validation

For implementation work, run focused tests for touched modules plus:

```bash
cd ontoindex && npx tsc --noEmit --pretty false
cd ontoindex && npm test -- --run test/unit/graph-html-export.test.ts test/unit/graph-html-slices.test.ts test/unit/wiki-graph-html-linkage.test.ts
```

If later work aligns with the live web graph UI, add focused tests for shared filter semantics rather
than duplicating full UI test coverage.
