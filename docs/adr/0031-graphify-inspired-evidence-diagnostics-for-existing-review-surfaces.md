# ADR 0031: Graphify-Inspired Evidence Diagnostics for Existing Review Surfaces

Status: Accepted - Implemented with Phase 4 follow-ups

Source: `docs/guides/graphify-architecture-lessons-for-ontoindex.md`

## Context

Graphify's useful lesson for OntoIndex is not its Python runtime, NetworkX graph, broad artifact
ingestion, assistant installation flow, or export-first product shape. OntoIndex already has native
code indexing, LadybugDB graph storage, Markdown sidecars, review reports, deterministic review
bundles, ranked discovery reports, MCP tools, evidence classes, response envelopes, freshness
metadata, and query-budget diagnostics.

The remaining OntoIndex-native gap is narrower: existing review, export, report, and docs surfaces
can expose better evidence diagnostics without creating new authority or new product surface.

Current overlapping OntoIndex surfaces:

- `ontoindex review diff` for local graph-aware review.
- `ontoindex export review-bundle` for disposable deterministic snapshots under `.ontoindex/review/`.
- `ontoindex report hubs` and `ontoindex report surprising-connections` for ranked, lossy discovery.
- `ontoindex docs sidecar` and `ontoindex docs knowledge` for advisory document evidence.
- MCP/frontier tools that already wrap review, docs, impact, freshness, and contract behavior.

This ADR must therefore refine those surfaces. It must not add a parallel graph store, another
MCP frontier tool, a new ingestion domain, or a second report framework.

## OntoIndex Review and Challenge

Reviewed against OntoIndex on 2026-05-25.

OntoIndex evidence:

- `ontoindex status` reported a stale index: indexed `01b7977`, current `aa29508`. Graph-derived
  evidence from the local index is therefore advisory for this ADR review.
- `ontoindex export review-bundle --help` shows an existing bundle contract:
  `freshness.json`, `graph-summary.json`, `risk-summary.json`, `sidecar-status.json`, and
  `REVIEW_REPORT.md`.
- `ontoindex report --help` and `ontoindex/src/cli/report.ts` show that `report hubs` and
  `report surprising-connections` already label their output as ranked/lossy discovery, not
  complete impact analysis.
- `ontoindex docs sidecar status --repo OntoIndex` reported `missing`, so any docs-derived
  diagnostic must expose degraded sidecar state rather than silently omitting docs evidence.
- Direct source review found focused tests for the relevant surfaces in
  `ontoindex/test/unit/export-review-bundle.test.ts`, `ontoindex/test/unit/report-discovery.test.ts`,
  and `ontoindex/test/unit/review-diff.test.ts`.

Challenge findings:

1. **A new `evidence-diagnostics.json` file is probably extra surface.** The first slice should add
   a `diagnostics` section to existing `risk-summary.json` and `REVIEW_REPORT.md`. A separate file is
   justified only after the existing files become hard to consume.
2. **Report explanations already exist.** Hub and surprising-connection reports already expose score
   inputs and lossy/discovery disclaimers. The ADR should add only missing machine-readable
   explanation fields, not a second recommendation layer.
3. **A shared helper is premature.** Start with local pure helpers in export/report code. Extract a
   shared helper only after duplication appears in at least two implemented surfaces.
4. **Docs rationale overlaps ADR 0029.** This ADR may consume sidecar status and advisory docs
   evidence, but it must not add new docs extraction, schema extraction, or knowledge clustering.
5. **Diagnostic kinds are not evidence classes.** Labels such as `ambiguous`, `degraded`, and
   `truncated` describe quality/state. They must not become a parallel evidence taxonomy beside ADR
   0026 evidence classes.
6. **MCP exposure is later than the ADR currently implies.** Existing CLI/report behavior must prove
   stable before any MCP-facing response shape changes.

## Decision

Adopt a small **evidence diagnostics layer** for existing OntoIndex review/export/report/docs
surfaces.

The accepted direction is additive:

```text
existing evidence -> diagnostic classification -> bounded report section -> existing surface
```

Diagnostics must explain:

- which symbols, relationships, docs, or schema facts were used;
- whether each item is extracted, inferred, ambiguous, degraded, stale, or truncated;
- which source, span, sidecar record, or graph query produced it;
- whether the item is authoritative graph/code evidence or advisory docs evidence;
- which explicit limit or freshness condition affected the result.

Diagnostics must not change audit authority. Ambiguous, inferred, docs-derived, or degraded records
remain advisory unless separately verified through existing graph/code/audit gates.

## Implementation Solutions

### Solution A: Existing Review-Bundle Diagnostics

Extend `ontoindex export review-bundle` first.

Add diagnostics to the existing bundle files before creating any new artifact:

```text
.ontoindex/review/<target>/risk-summary.json
.ontoindex/review/<target>/REVIEW_REPORT.md
```

The existing JSON artifact should include compact diagnostics for:

- extraction contract snapshots;
- ambiguous relationships;
- degraded/truncated evidence;
- hub-risk summaries;
- surprising-connection explanations;
- docs sidecar status and advisory docs evidence.

This is the safest first slice because review bundles are disposable snapshots and already carry
freshness, provenance, graph summary, risk summary, and sidecar status.

A separate `evidence-diagnostics.json` file is postponed. It is justified only if diagnostics become
too large or too independently useful for `risk-summary.json`.

Tradeoff: diagnostics are useful for release/review workflows, but they do not yet improve live
`review diff`, `report`, or MCP responses.

### Solution B: Shared Evidence Diagnostics Helper

Create a small internal helper that formats diagnostics consistently across surfaces.

Possible later location:

- `ontoindex/src/core/runtime/evidence-diagnostics.ts`

Candidate shape:

```ts
type EvidenceDiagnosticKind =
  | 'inferred'
  | 'ambiguous'
  | 'degraded'
  | 'truncated'
  | 'stale';

interface EvidenceDiagnosticRecord {
  kind: EvidenceDiagnosticKind;
  evidenceClass: string;
  source: 'graph' | 'code' | 'docs-sidecar' | 'review' | 'report' | 'runtime';
  subject: string;
  relation?: string;
  path?: string;
  span?: { startLine?: number; endLine?: number };
  provenance: string[];
  freshness?: string;
  confidence?: 'high' | 'medium' | 'low';
  advisory: boolean;
  reason?: string;
}
```

This helper should only normalize and summarize records. It must not query the graph, classify audit
status, schedule retries, or decide recommendations.

Tradeoff: shared formatting prevents report drift, but it can become a dumping ground if it grows
into a generic evidence engine. Keep it passive and do not add it before two surfaces need it.

### Solution C: Report Surface Enrichment

Extend existing ranked discovery reports:

- `ontoindex report hubs`;
- `ontoindex report surprising-connections`.

Add optional explanation fields to JSON output and short Markdown/plaintext sections only where the
current score inputs are insufficient:

- why a symbol is hub-like;
- which communities, paths, or flows caused the score;
- which edge made a connection surprising;
- whether the result is ranked/lossy rather than complete impact analysis;
- which verifying command already exists, usually `ontoindex impact <symbol>`.

Tradeoff: this improves discovery quality, but the report wording must avoid implying complete
blast-radius analysis.

### Solution D: Docs-Sidecar Rationale and Schema Evidence

Reuse existing docs sidecar and knowledge-report infrastructure to attach rationale snippets and
code-adjacent schema facts to review diagnostics.

Allowed sources:

- Markdown and ADR sidecars;
- route/API docs;
- SQL/schema facts when repo-local and linked to code;
- test and audit evidence already represented in native OntoIndex reports.

Rejected sources for this ADR:

- remote URLs;
- PDFs;
- video or audio transcripts;
- Google Workspace documents;
- assistant chat logs;
- memory records as authority.

Tradeoff: docs evidence can explain code relationships, but it must remain advisory and must expose
skip reasons when the sidecar is missing, stale, partial, or disabled.

## Chosen Implementation Path

Use Solution A first, then extract Solution B only when at least two implemented surfaces need the
same diagnostic formatting.

Recommended sequence:

1. Add review-bundle diagnostics metadata to existing artifacts.
2. Add a Markdown diagnostics section to `REVIEW_REPORT.md`.
3. Add focused tests for advisory/authoritative labels, truncation reasons, and stale sidecar state.
4. Reuse the same diagnostic records in `report hubs` or `report surprising-connections`.
5. Consider a shared helper only after duplication appears.
6. Defer docs-sidecar rationale/schema enrichment until review-bundle and report diagnostics are stable.

No new MCP tool is approved by this ADR. MCP/frontier exposure may only happen through existing
surfaces after the CLI/report contract is stable and tool-contract tests prove compatibility.

## Algorithm/Technique

### 1. Diagnostic Record Construction

Build diagnostics from evidence that existing surfaces already read:

- changed files, changed symbols, affected processes, and risk summaries in `ontoindex/src/cli/review.ts`;
- review-bundle freshness, graph summary, risk summary, and sidecar status in `ontoindex/src/cli/export.ts`;
- hub and surprising-edge report rows in `ontoindex/src/cli/report.ts`;
- Markdown sidecar status and knowledge evidence under `ontoindex/src/core/ingestion/enrichment/`;
- response envelope and budget metadata under existing MCP/shared runtime helpers.

Do not add new graph traversal for the first slice unless the existing surface already performs it.

### 2. Evidence Authority Mapping

Every diagnostic record must map to existing OntoIndex evidence authority:

| Source | Authority |
|--------|-----------|
| deterministic parser/code graph | can be authoritative when index is fresh |
| impact/review graph result | authoritative only within existing freshness and target-context gates |
| docs sidecar and knowledge reports | advisory |
| inferred or ambiguous relationship | advisory |
| ranked reports | discovery only, not complete impact |
| runtime budget/freshness status | diagnostic only |

### 3. Review Bundle Diagnostics

Add a `diagnostics` section to the existing `risk-summary.json` artifact in `export review-bundle`.

Required shape:

```json
{
  "_note": "Snapshot artifact — not canonical graph state",
  "provenance": {},
  "diagnostics": {
    "schemaVersion": 1,
    "summary": {
      "total": 0,
      "authoritative": 0,
      "advisory": 0,
      "ambiguous": 0,
      "degraded": 0,
      "truncated": 0
    },
    "records": []
  }
}
```

Do not add `evidence-diagnostics.json` in the first implementation slice. If a later slice needs a
standalone artifact, it must duplicate the same `_note`, provenance, freshness, and advisory flags
used by the existing bundle files.

The existing `REVIEW_REPORT.md` should summarize these records with clear sections:

- authoritative code/graph evidence;
- advisory docs evidence;
- ambiguous relationships;
- degraded or truncated evidence;
- ranked discovery notes.

### 4. Report Integration

For `report hubs` and `report surprising-connections`, add diagnostics only as optional JSON fields
and concise text explanations.

Reports must keep the current warning that ranked discovery is not complete impact analysis.
Diagnostic additions must point to verifying commands instead of presenting recommendations as final.

### 5. Docs Evidence Integration

Docs evidence may enrich diagnostics only when the sidecar status is explicit.

Allowed sidecar states:

- `complete`;
- `partial`;
- `stale`;
- `missing`.

Missing or stale sidecars must produce degraded diagnostic records instead of silently omitting docs
context.

## Rejected Alternatives

### New Graph Storage or Export Format

Rejected. LadybugDB remains the source of truth. Review-bundle artifacts are disposable snapshots,
not a second graph database.

### New MCP Frontier Tool

Rejected. Existing `review`, `export`, `report`, `docs`, `query`, `context`, and `impact` surfaces
cover the user workflow. A new tool would widen startup surface and duplicate ADR 0025/0027 concerns.

### Broad Artifact Ingestion

Rejected. URLs, PDFs, video/audio, Google Workspace, and assistant conversations do not naturally
extend OntoIndex core functionality. Repository Markdown, ADRs, route/API docs, SQL/schema facts,
tests, and audit evidence are enough.

### LLM-Inferred Code Authority

Rejected. Inferred relationships may help discovery, but deterministic parser/code graph evidence
remains the authority for code behavior.

### Automatic Git Hooks

Rejected. OntoIndex should not surprise agents or users with automatic index rebuilds during startup
or commit workflows. Explicit commands and existing freshness diagnostics are preferred.

## Consequences

Positive:

- Review bundles become easier to audit because evidence quality is visible.
- Ranked reports explain why an item is interesting without overstating completeness.
- Docs sidecar evidence can support rationale without becoming audit authority.
- Existing OntoIndex surfaces improve without expanding MCP frontier size.

Negative:

- Adds another metadata section to review-bundle output.
- Diagnostics can become noisy if every low-value relationship is emitted.
- Shared helpers may grow too broad if they start owning retrieval or recommendations.

Mitigations:

- Keep diagnostics bounded and summarized.
- Mark every advisory or ambiguous record clearly.
- Preserve existing freshness, target-context, response-envelope, and budget metadata.
- Add compatibility tests before exposing diagnostics through MCP-facing surfaces.

## Implementation Plan

### Phase 1: Review-Bundle Diagnostics

- Add an internal diagnostics builder local to `ontoindex/src/cli/export.ts` or a small adjacent module.
- Add `diagnostics` to `risk-summary.json`.
- Add a compact diagnostics section to `REVIEW_REPORT.md`.
- Include stale/missing sidecar state as degraded diagnostics.
- Add focused tests in `ontoindex/test/unit/export-review-bundle.test.ts` for the existing artifact
  shape.

### Phase 2: Ranked Report Explanations

- Extend `report hubs` JSON output with score explanation fields only if current score components
  are insufficient for consumers.
- Extend `report surprising-connections` JSON output with edge explanation fields only if current
  flags are insufficient for consumers.
- Keep existing lossy/ranked warning text.
- Add tests in `ontoindex/test/unit/report-discovery.test.ts` proving report output does not claim
  complete impact authority.

### Phase 3: Shared Helper Extraction

- Extract a shared `evidence-diagnostics` helper only after Phase 1 and Phase 2 produce duplicate
  formatting logic.
- Keep the helper passive: normalize, count, summarize, and render only.
- Add unit tests for authority mapping, advisory flags, truncation reasons, and deduplication.

### Phase 4: Docs Rationale and Schema Evidence

- Reuse existing docs sidecar facts and knowledge reports.
- Attach rationale snippets only with provenance and sidecar freshness.
- Add repo-local schema/API facts only when ADR 0029 surfaces them through existing docs sidecar
  records and they connect to code impact.
- Keep all docs-derived records advisory by default.

### Phase 5: Existing MCP Surface Exposure

- If useful, expose diagnostics through existing review/docs/report MCP responses.
- Do not add a new public tool.
- Run tool-contract and response-envelope compatibility tests before release.

## Guardrails

- No new graph database.
- No NetworkX/Python runtime dependency.
- No new MCP frontier tool.
- No broad media, URL, remote-doc, or Google Workspace ingestion.
- No assistant-skill installer or query-first hook generator.
- No automatic index rebuild hooks.
- No audit authority from ambiguous, inferred, docs-derived, or degraded evidence.
- No unbounded all-repo diagnostic payloads.
- No LLM-generated code facts as authoritative evidence.

## Acceptance Criteria

- `export review-bundle` emits bounded evidence diagnostics with `_note`, schema version, freshness,
  summary counts, and records through existing bundle artifacts.
- `REVIEW_REPORT.md` separates authoritative, advisory, ambiguous, degraded, and ranked discovery
  evidence.
- Missing/stale docs sidecars are explicit degraded diagnostics.
- Ranked reports keep their lossy/discovery warnings.
- No new MCP tool is added.
- No standalone diagnostics artifact is added in the first implementation slice.
- Existing review/export/report/docs behavior remains backward-compatible.
- Tests prove advisory evidence cannot be treated as audit evidence.

## Validation

For implementation work, run focused tests for touched modules plus:

```bash
cd ontoindex && npx tsc --noEmit --pretty false
cd ontoindex && npx vitest run test/unit/export-review-bundle.test.ts test/unit/report-discovery.test.ts test/unit/review-diff.test.ts test/unit/query-budget.test.ts
```

If `export review-bundle` is changed, also run or add focused tests covering
`ontoindex/src/cli/export.ts`.

If implementation adds new authority mapping logic, add focused tests proving advisory evidence
cannot become audit evidence.

If MCP-facing output is changed, also run the affected tool-contract and response-envelope tests.
