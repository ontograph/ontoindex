# ADR 0032: Core Architecture Tour Composition

**Status:** Implemented (core composition)
**Source:** Understand-Anything architecture review, 2026-05-26; narrowed 2026-06-10
**External reference:** <https://github.com/Lum1104/Understand-Anything>

## Context

Understand-Anything is useful as a comparison architecture, but its main product shape does not map
directly onto OntoIndex. OntoIndex should not clone a generated JSON graph, an LLM-first analyzer, a
multi-agent extraction pipeline, a dashboard-first experience, or a broad "explain the codebase" chat
surface.

The useful OntoIndex-native idea is narrower:

```text
Given already-collected OntoIndex evidence, build a bounded, ordered, citation-backed architecture
tour that explains how that evidence connects.
```

This ADR keeps only new core functionality. It must extend OntoIndex's core evidence infrastructure,
not repackage existing CLI reports, review bundles, MCP tools, docs reports, or graph queries.

## Existing Functionality Excluded From This ADR

The following already exist and are not the new feature:

- graph/index evidence;
- process and execution-flow evidence;
- diff-impact and review evidence;
- docs/ADR sidecar evidence;
- evidence diagnostics;
- semantic contracts for citation requirements, docs authority boundaries, freshness consistency, and
  truncation visibility;
- CLI report/export commands;
- MCP review-diff and facade surfaces.

Those surfaces may later feed or display a tour, but this ADR does not approve changing them as the
first implementation.

## OntoIndex Evidence Review

This challenge pass used the local OntoIndex CLI and source reads.

- `ontoindex status` reported the local index is stale: indexed commit `e3b70fc`, current commit
  `1b0e8ce`. OntoIndex query results were therefore treated as routing evidence and cross-checked
  against source.
- `ontoindex query "architecture tour evidence diagnostics report export review bundle MCP diff docs knowledge report" --repo OntoIndex --limit 12`
  resolved existing report/export/review/docs surfaces, but did not reveal an existing
  architecture-tour core module.
- Source search found no current `ArchitectureTour` or `architecture-tour` implementation.
- Source search confirmed existing reusable contracts:
  - `ontoindex/src/core/runtime/evidence-diagnostics.ts` defines `EvidenceDiagnosticRecord`,
    `EvidenceDiagnosticQualityKind`, normalization, bounded summaries, and markdown-friendly
    diagnostic rendering.
  - `ontoindex/src/core/runtime/semantic-contracts.ts` already validates quality-state placement,
    authority consistency, freshness consistency, docs authority boundaries, truncation visibility,
    and citation requirements.
  - `ontoindex/src/cli/report.ts`, `ontoindex/src/cli/export.ts`, and
    `ontoindex/src/mcp/super/diff-impact.ts` are existing product surfaces and are not the new core.

Conclusion: ADR 0032 should add only the missing composition kernel. It must reuse existing
diagnostic and semantic-contract infrastructure instead of inventing a parallel citation or authority
checker.

## Challenge Findings

1. **The previous scope was too product-shaped.**
   CLI report commands, review-bundle artifacts, MCP attachments, UI graph highlighting, source
   previews, persona modes, and generic chat are product surfaces, not core architecture.

2. **A tour must be new core behavior, not a wrapper.**
   Calling existing reports in sequence and formatting them differently would not extend OntoIndex
   core. The new part is a reusable composition kernel that validates citations, orders evidence, and
   reports confidence/diagnostic state.

3. **The core must not query the graph directly.**
   Querying belongs to existing retrieval/report/review paths. The architecture-tour kernel should
   accept already-collected evidence and make deterministic decisions over that input.

4. **Docs/ADR evidence is advisory.**
   A docs-only step can orient a reader, but it must not be presented as architecture authority unless
   linked to graph, symbol, process, review, or file evidence.

5. **MCP and CLI integration are later adapters.**
   They are useful after the core contract is stable, but they are not part of the first core
   deliverable.

6. **Do not duplicate existing semantic contracts.**
   Citation requirements, docs authority boundaries, stale/degraded diagnostics, and truncation
   visibility already have core support. The tour builder should produce evidence and diagnostics that
   satisfy those contracts, not define a second policy engine.

## Decision

Add a pure core architecture-tour composition subsystem.

The subsystem turns a bounded set of existing OntoIndex evidence records into an ordered tour with
mandatory citations and diagnostics. It does not collect evidence, mutate indexes, call LLMs, emit
audit authority, or introduce any public MCP/CLI surface.

Approved core shape:

```text
ArchitectureTourInput
  -> normalize evidence
  -> group related evidence
  -> rank ordered tour steps
  -> enforce citations and bounds
  -> attach diagnostics
  -> ArchitectureTour
```

## Implementation Status

Implemented for the core composition layer.

- Core module: `ontoindex/src/core/runtime/architecture-tour.ts`
- Tests: `ontoindex/test/unit/architecture-tour.test.ts`
- Public CLI, review-bundle, and MCP adapters remain rejected from the first core implementation and
  are still later-adapter work.

## Core Functionality

### 1. Shared Tour Model

Add:

```text
ontoindex/src/core/runtime/architecture-tour.ts
```

New exported types:

```ts
export interface ArchitectureTourInput {
  subject?: ArchitectureTourSubject;
  evidence: readonly ArchitectureTourEvidence[];
  maxSteps?: number;
  maxCitationsPerStep?: number;
}

export interface ArchitectureTour {
  subject?: ArchitectureTourSubject;
  steps: readonly ArchitectureTourStep[];
  diagnostics: readonly EvidenceDiagnosticRecord[];
  truncated: boolean;
}

export interface ArchitectureTourStep {
  id: string;
  title: string;
  summary: string;
  evidenceKind: ArchitectureTourEvidenceKind;
  citations: readonly ArchitectureTourCitation[];
  diagnostics: readonly EvidenceDiagnosticRecord[];
}
```

Rules:

- The model is internal core infrastructure, not an MCP/CLI response schema.
- Evidence records must be explicit typed data, not free-form prose.
- A step without citations is rejected or downgraded into a diagnostic.
- The model must preserve enough provenance for later wrappers to explain where each statement came
  from.
- Diagnostics use `EvidenceDiagnosticRecord`; this ADR does not add new diagnostic quality kinds.

### 2. Evidence Input Contract

Define a small input contract for evidence already collected by other systems:

```ts
export type ArchitectureTourEvidenceKind =
  | 'graph-node'
  | 'symbol'
  | 'process'
  | 'file'
  | 'diff-review'
  | 'docs-sidecar'
  | 'diagnostic';
```

Rules:

- Evidence must carry stable identity fields such as `repoPath`, `filePath`, `symbolName`,
  `processId`, `nodeId`, or `diagnosticId` where available.
- Docs-sidecar evidence is marked `advisory` unless paired with code evidence.
- Unknown or ambiguous evidence produces diagnostics instead of uncited tour steps.
- The core does not read files, query LadybugDB, call MCP, or inspect Git state.

### 3. Tour Builder

Add:

```ts
export function buildArchitectureTour(input: ArchitectureTourInput): ArchitectureTour;
```

Builder rules:

- Deterministic ordering for identical input.
- Prefer graph, symbol, process, and file evidence over docs-only evidence.
- Group related evidence into steps by stable subject keys.
- Enforce `maxSteps` and `maxCitationsPerStep`.
- Report truncation through diagnostics, not hidden omission.
- Use existing evidence diagnostic and semantic-contract utilities for stale, inferred, advisory,
  ambiguous, degraded, and truncated evidence.
- Do not implement a second docs-authority, freshness, citation, or truncation policy.

### 4. Pure Renderer

Add:

```ts
export function formatArchitectureTourMarkdown(tour: ArchitectureTour): string;
```

Renderer rules:

- Render only the supplied `ArchitectureTour`.
- Do not invent missing steps.
- Do not query graph/docs/review state.
- Include citation references for every emitted step.
- Include diagnostics when the tour is advisory, stale, inferred, ambiguous, degraded, or truncated.

## Rejected From Core

- New generated architecture graph artifacts.
- Dashboard, web UI, source-preview panel, or graph highlighting.
- LLM-generated architecture summaries.
- Multi-agent extraction pipeline.
- New graph backend or analyzer.
- New evidence-diagnostic quality taxonomy.
- Duplicate semantic-contract checker.
- New MCP tool.
- Changes to `gn_review_diff` default output.
- `ontoindex report architecture-tour` as part of the first core implementation.
- Review-bundle `architecture-tour.md` artifact as part of the first core implementation.
- Docs-only architecture authority.

## Later Adapters

After the core module lands and tests prove the contract, later ADRs or implementation notes may add
thin adapters:

1. CLI report adapter that gathers existing graph/process evidence and calls the core builder.
2. Review-bundle adapter that writes a disposable tour artifact.
3. Optional MCP attachment under an existing result field, gated by an explicit opt-in parameter.

Those adapters must not change the core rules above.

## Acceptance Criteria

- `architecture-tour.ts` exists under core runtime.
- The builder accepts already-collected evidence and does not query graph, MCP, HTTP, Git, or files.
- Every emitted step has at least one citation.
- Docs-only evidence is advisory and visibly marked.
- Truncation, stale, ambiguous, degraded, inferred, and unsupported states are diagnostics; unsupported
  evidence is represented through existing diagnostic fields such as `category`, `reason`,
  `advisory`, and an existing quality `kind`, not a new quality kind.
- Existing `EvidenceDiagnosticRecord` and semantic-contract utilities are reused instead of duplicated.
- Output is deterministic for identical input.
- Unit tests cover citation enforcement, deterministic ordering, docs-advisory handling, truncation,
  diagnostic propagation, and markdown rendering.
- No public CLI/MCP/export behavior changes in the first implementation.

## Validation

For implementation work, run focused tests first:

```bash
cd ontoindex && npm test -- --run test/unit/architecture-tour.test.ts
cd ontoindex && npx tsc --noEmit --pretty false
```

Before editing any existing implementation symbol, rerun fresh OntoIndex impact checks for that
symbol. Adding the new core module does not require impact analysis on existing symbols.

## Consequences

Positive:

- OntoIndex gains reusable core infrastructure for cited architecture walkthroughs.
- Later CLI/export/MCP surfaces can share one deterministic tour contract.
- The feature remains evidence-first and does not depend on LLM prose.

Negative:

- The first slice is not directly user-visible unless called by tests or later adapters.
- Evidence collection remains the responsibility of existing surfaces.
- Tour quality depends on the quality of supplied citations and diagnostics.

## Stop Conditions

- Stop if the core builder cannot enforce citations.
- Stop if implementation requires a new graph query layer or analyzer.
- Stop if docs-only evidence is treated as architecture authority.
- Stop if CLI/export/MCP changes become necessary to prove the core.
