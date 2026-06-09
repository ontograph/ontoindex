# Understand-Anything-inspired guided architecture tours

**Status:** Proposed - implementation scope narrowed
**Source:** Understand-Anything architecture review, 2026-05-26
**External reference:** <https://github.com/Lum1104/Understand-Anything>

## Context

Understand-Anything is useful as a comparison architecture, but its main design choices do not map directly onto OntoIndex. OntoIndex should not clone a generated JSON graph, LLM-first analyzer, multi-agent extraction pipeline, or dashboard-first product surface.

The useful idea is narrower: users benefit from an ordered, cited walkthrough of architecture evidence that OntoIndex already owns.

This ADR keeps only functionality that can be implemented inside OntoIndex's natural core:

- native graph/index evidence;
- process and execution-flow evidence;
- diff-impact and review evidence;
- docs/ADR sidecar evidence;
- evidence diagnostics;
- CLI report/export surfaces;
- MCP attachment only after CLI/export behavior is proven.

## OntoIndex Review Evidence

OntoIndex was used for this challenge pass.

- `ontoindex status` reported the repository index is stale against current HEAD. Results below were treated as directional and cross-checked with current local source maps.
- `ontoindex query "CLI report builders export review bundle diagnostics MCP review diff docs knowledge report evidence diagnostics" -r OntoIndex` resolved relevant existing surfaces including `ontoindex/src/cli/report.ts`, `ontoindex/src/cli/export.ts`, `ontoindex/src/cli/review.ts`, MCP diff-impact code, docs MCP helpers, and evidence-read-ledger code.
- `ontoindex context registerReportCommands -r OntoIndex` found `registerReportCommands` in `ontoindex/src/cli/report.ts`, called by `ontoindex/src/cli/index.ts`.
- `ontoindex context exportReviewBundleCommand -r OntoIndex` found review-bundle export composition in `ontoindex/src/cli/export.ts`.
- `ontoindex context gnReviewDiff -r OntoIndex` found MCP review-diff flow in `ontoindex/src/mcp/super/diff-impact.ts`, called through `dispatchSuper`.
- Current local source maps confirm:
  - `ontoindex/src/cli/report.ts` exposes `buildHubReport`, `buildSurprisingConnectionsReport`, text formatters, and command registration.
  - `ontoindex/src/cli/export.ts` exposes `buildReviewBundleDiagnostics`, `formatReviewBundleMarkdown`, `exportReviewBundleCommand`, and review-bundle artifact helpers.
  - `ontoindex/src/mcp/super/diff-impact.ts` exposes `gnReviewDiff` and review-diff diagnostics.
  - `ontoindex/src/core/runtime/evidence-diagnostics.ts` exposes shared diagnostic normalization and rendering helpers.
  - `ontoindex/src/core/ingestion/enrichment/markdown-knowledge-report.ts` exposes docs/ADR knowledge report items and sidecar freshness.

Impact checks from the stale index still provide useful routing signals:

- `impact registerReportCommands`: LOW, direct caller `ontoindex/src/cli/index.ts`.
- `impact buildHubReport`: LOW, reaches `reportHubsCommand` and `registerReportCommands`.
- `impact formatReviewBundleMarkdown`: LOW, direct caller `exportReviewBundleCommand`, one affected CLI process.
- `impact gnReviewDiff`: HIGH, affects MCP dispatch, server MCP handling, facade, and super modules.
- `impact buildReviewBundleDiagnostics` and `impact createMarkdownKnowledgeReport`: UNKNOWN because the stale index did not resolve those newer symbols.

Before code implementation, rerun fresh OntoIndex impact checks for every edited symbol.

## Challenge Findings

1. **The earlier feature list was still too product-shaped.**
   UI graph highlighting, side panels, source previews, persona modes, broad semantic search, and generic chat are not natural OntoIndex core.

2. **The implementation should start with low-risk report/export paths.**
   OntoIndex impact points to CLI report and review-bundle formatting as lower-risk integration points than MCP review-diff.

3. **A shared pure model is required before adding surfaces.**
   Without a shared model, report, export, and MCP outputs would duplicate logic and drift.

4. **MCP integration must be an attachment, not a new frontier.**
   `gnReviewDiff` has HIGH impact in the stale index, so MCP work is retained only as a later optional attachment after CLI/export behavior is tested.

5. **Docs/ADR evidence is advisory unless linked to code evidence.**
   The docs knowledge report can enrich a tour, but it must not become architecture authority by itself.

## Decision

Implement a OntoIndex-native architecture tour as a small evidence-composition feature. It will not introduce a new analyzer, graph backend, dashboard, persistent generated graph artifact, or uncited LLM summary.

The tour is a bounded ordered report over existing evidence. Each step must cite at least one source of truth: graph node, file path, symbol, process, diff-review evidence, docs/ADR sidecar item, or diagnostic record.

## Integration Paths To Implement

### 1. Shared Tour Model And Renderer

Add a pure internal module for the tour data model and markdown rendering.

- File: `ontoindex/src/core/runtime/architecture-tour.ts`
- New exported types:
  - `ArchitectureTour`
  - `ArchitectureTourStep`
  - `ArchitectureTourCitation`
  - `ArchitectureTourDiagnostic`
  - `ArchitectureTourInput`
- New exported functions:
  - `buildArchitectureTour(input: ArchitectureTourInput): ArchitectureTour`
  - `formatArchitectureTourMarkdown(tour: ArchitectureTour): string`

Implementation rules:

- Accept already-collected evidence as input; do not query the graph inside the renderer.
- Require at least one citation per emitted step.
- Use `EvidenceDiagnosticRecord` and `EvidenceDiagnosticQualityKind` for unsupported, stale, ambiguous, degraded, inferred, or truncated evidence.
- Enforce bounded output with max-step and max-citation limits.
- Return diagnostics instead of emitting uncited prose.

Tests:

- `ontoindex/test/unit/architecture-tour.test.ts`
- Cover citation requirement, truncation diagnostics, docs-advisory handling, markdown rendering, and deterministic ordering.

### 2. CLI Report Integration

Add the first user-visible surface under the existing report command group.

- File: `ontoindex/src/cli/report.ts`
- Add command: `ontoindex report architecture-tour`
- New exported functions:
  - `buildArchitectureTourReport(...)`
  - `formatArchitectureTourText(...)`
  - `reportArchitectureTourCommand(...)`

Inputs to support in the first implementation:

- `--file <path>`
- `--symbol <name>`
- `--process <name-or-id>`
- `--top <n>`
- `--json`
- `--repo <path>`

Implementation rules:

- Follow existing `report hubs` and `report surprising-connections` patterns.
- Label the output as a bounded evidence tour, not complete impact analysis.
- Reuse current graph/process queries already available to report commands.
- Prefer deterministic graph/process evidence over docs evidence.
- Emit warnings when the graph index is stale or missing.

Why this route first:

- OntoIndex impact for `registerReportCommands` is LOW.
- OntoIndex impact for the existing report builder path is LOW.
- It keeps the first implementation outside MCP and review-bundle behavior.

Tests:

- Extend `ontoindex/test/unit/report-discovery.test.ts` or add `ontoindex/test/unit/report-architecture-tour.test.ts`.
- Cover text output, JSON output, stale/missing index warnings, bounds, and citation rendering.

### 3. Review Bundle Integration

Attach a tour artifact to review bundles after the CLI report model is stable.

- File: `ontoindex/src/cli/export.ts`
- Output artifact: `architecture-tour.md`
- Optional JSON section: `risk-summary.json.diagnostics.architectureTour` or equivalent bounded field.
- Existing integration symbols:
  - `exportReviewBundleCommand`
  - `formatReviewBundleMarkdown`
  - `buildReviewBundleDiagnostics`

Implementation rules:

- Build the tour from existing `DiffReviewResult`, sidecar status, docs knowledge report, and provenance data already collected by review-bundle export.
- Include a short "Architecture Tour" section in `REVIEW_REPORT.md` only when cited steps exist.
- Write `architecture-tour.md` as a disposable snapshot artifact, never canonical graph state.
- Preserve all existing diagnostics and freshness warnings.
- Treat docs/ADR evidence as advisory unless linked to changed files or changed symbols.

Why this route second:

- OntoIndex impact for `formatReviewBundleMarkdown` is LOW.
- It reuses the same tour model from the report command.
- It makes the feature useful for existing review-bundle workflows without broadening analyzer scope.

Tests:

- Extend `ontoindex/test/unit/export-review-bundle.test.ts`.
- Cover artifact generation, markdown insertion, risk-summary diagnostics, stale graph warnings, and docs-advisory filtering.

### 4. Review-Diff MCP Attachment

Expose the tour through MCP only after report/export output is stable.

- File: `ontoindex/src/mcp/super/diff-impact.ts`
- Existing symbol: `gnReviewDiff`
- Add optional result field under the existing response, not a new MCP tool.

Implementation rules:

- Gate behind an optional parameter such as `include_architecture_tour`.
- Reuse the shared tour builder and already-collected review-diff evidence.
- Do not change existing default `gn_review_diff` output.
- Keep `auditAuthority: false` or equivalent advisory labeling for tour diagnostics.
- Preserve existing budget and truncation behavior.

Why this route is later:

- OntoIndex impact for `gnReviewDiff` is HIGH.
- It touches MCP dispatch/server/facade paths.
- It should not be first implementation work.

Tests:

- Extend `ontoindex/test/unit/super/diff-impact.test.ts` and `ontoindex/test/integration/mcp-facades.test.ts`.
- Cover opt-in behavior, default output stability, diagnostic authority, and budget/truncation records.

## Implementation Order

1. Implement shared model and renderer.
2. Implement `ontoindex report architecture-tour`.
3. Attach the tour to review-bundle export.
4. Add opt-in `gn_review_diff` attachment only after fresh OntoIndex impact confirms the risk is acceptable.

## Acceptance Gates

- Every tour step has at least one citation.
- Stale, inferred, advisory, ambiguous, degraded, or truncated evidence is visible as diagnostics.
- No generated graph artifact is treated as canonical.
- No LLM text is required for correctness.
- No web UI/dashboard work is included.
- No new MCP tool is introduced in the first implementation.
- CLI report and export bundle tests pass before MCP work starts.
- Fresh OntoIndex impact checks are recorded before editing implementation symbols.

## Stop Conditions

- Stop if the shared tour model cannot enforce citations.
- Stop if report/export integration requires a new graph backend or analyzer.
- Stop if docs-only evidence starts being treated as authoritative architecture evidence.
- Stop before MCP integration if fresh impact remains HIGH and the maintainer does not explicitly accept that risk.
