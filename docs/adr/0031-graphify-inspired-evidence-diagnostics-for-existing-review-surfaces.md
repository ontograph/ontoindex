# ADR 0031: Core Evidence Diagnostic Surface Profiles

Status: Implemented (core diagnostic profiles)

Source: `docs/guides/graphify-architecture-lessons-for-ontoindex.md`

## Context

Graphify's useful lesson for OntoIndex was evidence transparency: reports should say what evidence
was used, where it came from, whether it is authoritative or advisory, and whether it is ambiguous,
degraded, stale, inferred, extracted, or truncated.

That broad idea is now mostly implemented in OntoIndex. The old ADR mixed already-landed work with
later surface expansion. Treating the whole ADR as undone would duplicate code and widen the product
surface.

## Existing Functionality Excluded From This ADR

The following already exists and must not be recreated by this ADR:

- `ontoindex/src/core/runtime/evidence-diagnostics.ts`
  - `EvidenceDiagnosticRecord`
  - `summarizeEvidenceDiagnostics`
  - `normalizeEvidenceDiagnosticRecords`
  - Markdown rendering helpers
  - advisory/authoritative summary counts
  - ambiguity/degradation/truncation counts
- `ontoindex/src/core/runtime/semantic-contracts.ts`
  - quality-state placement checks
  - authority consistency checks
  - freshness consistency checks
  - docs authority boundary checks
  - truncation visibility checks
  - citation requirement checks
- `ontoindex/src/cli/export.ts`
  - `buildReviewBundleDiagnostics`
  - diagnostics embedded in review-bundle risk summaries and Markdown output
- Existing tests:
  - `ontoindex/test/unit/evidence-diagnostics.test.ts`
  - `ontoindex/test/unit/semantic-contracts.test.ts`
  - `ontoindex/test/unit/export-review-bundle.test.ts`
  - diagnostic coverage in architecture-tour and hypothesis-grounding tests

This ADR also does not approve a new graph store, new report framework, new ingestion domain, new MCP
tool, standalone `evidence-diagnostics.json`, broad media or remote-doc ingestion, LLM authority, or
automatic index rebuild hooks.

## OntoIndex Evidence Review

This challenge pass used the local OntoIndex CLI and source reads.

- `ontoindex status` reported the local index is up to date at commit `1b0e8ce`.
- Source search found `evidence-diagnostics.ts` and `semantic-contracts.ts` already implemented in
  core runtime.
- Source search found review-bundle diagnostics already implemented in `ontoindex/src/cli/export.ts`.
- Unit tests already cover diagnostic summarization, quality category separation, authority/advisory
  counts, truncation markers, semantic contracts, and review-bundle diagnostics.
- Search found no dedicated diagnostic profile or surface policy module such as
  `EvidenceDiagnosticProfile`, `EvidenceDiagnosticPolicy`, or diagnostic surface allowlists.

Conclusion: ADR 0031 should add only a pure core surface-profile policy for supplied diagnostic
records. It should not add more diagnostics builders, report output, docs extraction, or MCP wrappers.

## Challenge Findings

1. **The original helper is already implemented.** Re-adding `EvidenceDiagnosticRecord` or summary
   helpers would create duplicate contracts.
2. **Review-bundle diagnostics are already implemented.** This ADR should not keep asking for changes
   to `export review-bundle` as if that surface were still missing.
3. **Semantic contracts already enforce global safety rules.** The remaining gap is surface-specific:
   which categories, sources, authorities, and quality states each surface is allowed to emit.
4. **MCP exposure is not core functionality.** Any MCP response changes need separate tool-contract
   review after the core policy exists.
5. **A profile policy is not an authority engine.** It can flag diagnostics that do not match a
   surface contract, but it must not promote advisory evidence into audit authority.

## Decision

Add a pure core evidence diagnostic surface-profile policy.

The policy consumes caller-supplied diagnostic records and caller-supplied profile declarations. It
returns a deterministic validation report that identifies diagnostics that do not fit the target
surface contract.

Approved core shape:

```text
EvidenceDiagnosticProfileInput
  -> normalize profile declarations
  -> validate supplied EvidenceDiagnosticRecord values
  -> apply surface allowlists for category, source, authority, and quality kind
  -> enforce optional reason, freshness, and truncation requirements
  -> emit profile violations and summary counts
  -> EvidenceDiagnosticProfileReport
```

## Core Functionality

### 1. Surface Profile Model

Add:

```text
ontoindex/src/core/runtime/evidence-diagnostic-profiles.ts
```

Core types:

```ts
export interface EvidenceDiagnosticSurfaceProfile {
  id: string;
  allowedCategories?: readonly string[];
  allowedSources?: readonly string[];
  allowedAuthorities?: readonly EvidenceDiagnosticAuthority[];
  allowedKinds?: readonly EvidenceDiagnosticQualityKind[];
  requireReason?: boolean;
  requireFreshnessForAuthoritative?: boolean;
  requireTruncationDiagnosticWhenBounded?: boolean;
}

export interface EvidenceDiagnosticProfileInput {
  profile: EvidenceDiagnosticSurfaceProfile;
  diagnostics: readonly EvidenceDiagnosticRecord[];
  boundedOutput?: {
    evidenceOmitted?: boolean;
    omittedEvidenceCount?: number;
  };
}
```

Rules:

- Profiles are caller-supplied core data, not global registry mutations.
- The evaluator must validate only supplied diagnostics and supplied profile data.
- The evaluator may reuse existing `EvidenceDiagnosticRecord` and quality/authority types.
- The evaluator may reuse existing semantic-contract helpers conceptually, but must not duplicate
  those global checks unless a surface profile needs additional constraints.
- The evaluator is advisory and must not change audit lifecycle status.

### 2. Profile Evaluator

Add:

```ts
export function evaluateEvidenceDiagnosticProfile(
  input: EvidenceDiagnosticProfileInput,
): EvidenceDiagnosticProfileReport;
```

Evaluator rules:

- Pure deterministic function over supplied input.
- No filesystem, Git, LadybugDB, MCP, HTTP, embedding, LLM, graph query, docs sidecar query, or report
  execution.
- Unknown categories are allowed unless the profile has `allowedCategories`.
- Unknown sources are allowed unless the profile has `allowedSources`.
- Authority values must be either `authoritative` or `advisory`; invalid values or values outside
  `allowedAuthorities` produce `authority-not-allowed` violations.
- Diagnostic quality states must remain in `kind`, not in `category`; invalid kinds or values outside
  `allowedKinds` produce `kind-not-allowed` violations.
- If `requireReason` is true, blank reasons become profile violations.
- If `requireFreshnessForAuthoritative` is true, authoritative diagnostics without freshness become
  profile violations.
- If bounded output omits evidence and `requireTruncationDiagnosticWhenBounded` is true, at least one
  truncation diagnostic is required.
- Output order is deterministic by input order and violation kind.

### 3. Profile Violation Manifest

Violation kinds:

```ts
export type EvidenceDiagnosticProfileViolationKind =
  | 'category-not-allowed'
  | 'source-not-allowed'
  | 'authority-not-allowed'
  | 'kind-not-allowed'
  | 'missing-reason'
  | 'missing-authoritative-freshness'
  | 'missing-truncation-diagnostic';
```

Rules:

- Violations identify the profile id, diagnostic subject, source, category, and kind when available.
- Violations include a concise reason.
- The evaluator should catch existing diagnostic validation errors and return profile violations
  instead of throwing for ordinary bad diagnostic records.
- Violations do not include recommended tools or mutate audit lifecycle status.
- Later adapters may expose the report in existing review/docs/report surfaces, but this ADR does not
  add those adapters.

## Rejected From Core

- New diagnostics record type replacing `EvidenceDiagnosticRecord`.
- New review-bundle diagnostics implementation.
- New `evidence-diagnostics.json` artifact.
- New MCP tool or response field.
- New docs extraction, schema extraction, or knowledge clustering.
- New graph traversal or graph schema.
- New report framework.
- Recommendations or next-step policy.
- Audit lifecycle status transitions.
- LLM-generated authority.
- Remote URL, PDF, video, audio, Google Workspace, or chat-log ingestion.

## Later Adapters

After the core profile evaluator lands and tests prove the contract, later work may add thin adapters:

1. review-bundle adapter that checks its diagnostics against a review-bundle profile;
2. report adapter that checks ranked discovery diagnostics against a discovery profile;
3. docs adapter that checks sidecar-derived diagnostics against a docs-advisory profile;
4. optional MCP exposure through existing tools after tool-contract compatibility tests.

Those adapters must not change the core rules above.

## Implementation Status

Implemented in:

- `ontoindex/src/core/runtime/evidence-diagnostic-profiles.ts`
- `ontoindex/test/unit/evidence-diagnostic-profiles.test.ts`

The implementation landed only the approved core slice: caller-supplied diagnostic surface profiles,
supplied `EvidenceDiagnosticRecord` values, category/source/authority/kind allowlists, optional
reason/freshness/truncation requirements, deterministic profile violations, and summary counts.

No CLI/report/docs/MCP output change, diagnostic record replacement, graph traversal, docs extraction,
recommendation policy, LLM behavior, or audit lifecycle status transition was added.

## Acceptance Criteria

- `evidence-diagnostic-profiles.ts` exists under `ontoindex/src/core/runtime/`.
- The evaluator accepts explicit profile data and supplied diagnostics.
- The evaluator does not query graph, MCP, HTTP, Git, filesystem, docs sidecars, embeddings, LLMs, or
  reports.
- The evaluator does not mutate existing diagnostics, semantic contracts, CLI exports, or MCP
  registries.
- Allowed category/source/authority/kind checks work.
- Missing reason checks work when enabled.
- Missing authoritative freshness checks work when enabled.
- Bounded-output truncation checks work when enabled.
- Quality states in `category` produce profile violations through existing diagnostic validation.
- Invalid authority/kind values supplied from untyped data produce profile violations instead of
  uncaught exceptions.
- Output is deterministic.
- Unit tests cover pass, rejected category, rejected source, rejected authority, rejected kind, missing
  reason, missing authoritative freshness, missing truncation marker, and deterministic ordering.

## Validation

For implementation work, run focused tests first:

```bash
cd ontoindex && npm test -- --run test/unit/evidence-diagnostic-profiles.test.ts
cd ontoindex && npx tsc --noEmit --pretty false
```

Before editing any existing implementation symbol, rerun fresh OntoIndex impact checks for that
symbol. Adding the new core module does not require impact analysis on existing symbols.

## Consequences

Positive:

- Existing diagnostics gain a reusable surface-level policy without duplicating record builders.
- Review, report, docs, and future MCP adapters can share one profile contract.
- Advisory evidence remains advisory because profiles only validate allowed shapes.
- The design keeps Graphify-inspired transparency inside OntoIndex core contracts.

Negative:

- The first slice is not directly user-visible unless called by tests or later adapters.
- Profile quality depends on caller-supplied surface declarations.
- It does not improve evidence extraction; it only validates diagnostic readiness for a surface.

## Stop Conditions

- Stop if implementation requires a new diagnostic record type.
- Stop if implementation requires review-bundle, report, docs, or MCP output changes.
- Stop if implementation requires graph schema or graph traversal changes.
- Stop if the evaluator needs filesystem, Git, database, HTTP, embedding, docs sidecar, report, or LLM
  access.
- Stop if profile violations become audit lifecycle status transitions or recommendations.
