# ADR 0020: Graph-Aware Diff Review and Review Reports

Status: Implemented (v1 local review; follow-ups remain)

## Context

Graphify is useful as a reference because it packages a project graph into practical review
surfaces: static reports, call-flow exports, surprising connections, confidence labels, update
caches, graph queries, and PR-oriented impact views. OntoIndex already has the deeper substrate for
many of these ideas: a persistent LadybugDB graph, execution flows, communities, impact analysis,
sidecar enrichment, freshness policy, audit trust contracts, and MCP/CLI workflows.

The mistake would be to copy Graphify's artifact-first architecture into OntoIndex. OntoIndex is not a
single `graph.json` exporter with a generic graph query server. It is a safety-oriented code
intelligence system whose answers must remain tied to index freshness, provenance, policy, and
impact semantics.

This ADR proposes several OntoIndex-native implementation paths for the useful parts of the Graphify
review, without replacing the existing graph store or weakening audit trust constraints.

Related decisions:

- ADR 0015: Post-index enrichment sidecar
- ADR 0016: Resource Lifecycle Graph and Systems Auditor overlay
- ADR 0018: MCP Audit Trust Contract and Customer Readiness Gates
- ADR 0019: Query replay reports for retrieval changes

Reviewed reference:

- <https://github.com/safishamsi/graphify>

## Challenge Review

This ADR is directionally useful, but the unsafe version is too broad. It currently bundles PR
impact, review exports, confidence vocabulary, hub analysis, surprising connections, sidecar cache
policy, MCP surfaces, and future hosted PR integrations into one decision. OntoIndex review adds two
more constraints: `gn_diff_impact` already exists, and the current repository index may be stale
when a reviewer runs the command. That creates eight risks:

1. **The first deliverable is not crisp enough.** A proposal with five workstreams can be accepted in
   principle while no implementation has an obvious first acceptance gate. The first release should
   prove one user-visible workflow: local graph-aware diff review.
2. **ADR 0018 already owns trust envelopes.** This ADR should consume the target context, freshness
   gate, and evidence envelope from ADR 0018. It should not define a parallel trust contract.
3. **ADR 0015 already owns sidecar freshness and reuse.** A sidecar manifest cache is plausible, but
   it belongs as an ADR 0015 implementation detail unless it materially changes review reports.
4. **"PR impact" is too remote-sounding for v1.** Hosted pull-request lookup adds authentication,
   API-rate, fork, fetch, and stale-remote concerns. The organic OntoIndex primitive is local
   diff-impact over refs. The command may later grow PR adapters, but the kernel should not depend on
   remote hosting.
5. **Report ranking can be mistaken for safety analysis.** Hub suppression and surprising-connection
   scores are useful discovery views. They must never trim complete impact output or suppress
   safety-critical dependencies.
6. **Static bundles can create artifact sprawl.** A review bundle is useful only if it is explicitly
   generated, ignored by default, and treated as a disposable snapshot.
7. **There are already two partial implementations.** `gn_diff_impact` provides a PR-blast-radius
   MCP report, while `detectChanges` maps diff hunks to changed symbols and affected processes. A
   new CLI must reconcile these paths instead of adding a third diff-impact implementation.
8. **The existing `gn_diff_impact` path does not use the shared impact kernel.** It computes direct
   graph counts internally. ADR 0020 should not describe the impact kernel as already shared by this
   feature until the implementation actually routes through it.

The tightened decision is therefore: v1 approves only a local graph-aware diff review report built on
the existing diff-impact/detect-changes surfaces, the impact kernel where it is already authoritative,
and the ADR 0018 envelope. Review bundles, hub reports, surprising
connections, hosted PR lookup, MCP exposure, and sidecar cache improvements remain follow-up work
gated by the v1 report contract.

## Implementation Status

Implemented for the v1 local review contract. `ontoindex review diff`, shared review types/builders,
`gn_diff_impact`, and `gn_review_diff` now provide local graph-aware diff review with freshness and
provenance metadata. Hosted PR adapters and additional report exports remain follow-up work.

### OntoIndex Evidence Check

This ADR was challenged with the local OntoIndex CLI:

```bash
ONTOINDEX_MAX_WORKERS=7 node /home/er77/_wrk/OntoIndex/ontoindex/dist/cli/index.js status
ONTOINDEX_MAX_WORKERS=7 node /home/er77/_wrk/OntoIndex/ontoindex/dist/cli/index.js query "diff impact review report" --repo /home/er77/_wrk/OntoIndex --limit 5
ONTOINDEX_MAX_WORKERS=7 node /home/er77/_wrk/OntoIndex/ontoindex/dist/cli/index.js context gnDiffImpact --repo /home/er77/_wrk/OntoIndex
ONTOINDEX_MAX_WORKERS=7 node /home/er77/_wrk/OntoIndex/ontoindex/dist/cli/index.js detect-changes --scope all --repo /home/er77/_wrk/OntoIndex
```

Findings:

- The OntoIndex index was stale during review: indexed commit `83a0773`, current commit `17a9ef7`.
  Therefore graph-derived evidence from the review is useful for architecture direction, but not a
  fresh implementation acceptance signal.
- `ontoindex query "diff impact review report"` surfaced `gnDiffImpact`,
  `DiffImpactReport`, `detectChanges`, and related impact symbols as existing implementation
  anchors.
- `ontoindex context gnDiffImpact` showed an existing symbol and call context; this is a refactor of
  an existing capability, not a greenfield command.
- `ontoindex detect-changes --scope all` demonstrated that diff-hunk to symbol/process mapping
  already exists and should be part of the v1 design.

## Decision

Implement Graphify-inspired review capabilities as additive OntoIndex-native reports and commands,
starting with local graph-aware diff review.

The first accepted direction is not "build a second graph". The direction is:

1. Use OntoIndex' primary graph, process flows, communities, `detectChanges`, `gn_diff_impact`, and
   impact kernel as the existing authority surfaces to reconcile.
2. Add review/report surfaces over that authority.
3. Keep confidence, provenance, freshness, and sidecar state visible in every high-level output.
4. Treat exported files as snapshots, not canonical state.
5. Prefer local refs and deterministic graph facts before adding hosted PR integrations or LLM
   ranking.

This ADR approves one v1 implementation path and records four later extensions. The v1 path is a
local ref-based report that answers: "what changed, what graph/process/community surface does it
touch, and what freshness limits apply?"

Later workstreams may ship independently, but they must reuse the v1 report envelope and ADR 0018
target context instead of inventing incompatible response shapes.

## Algorithm/Technique

### 1. Graph-aware diff review

Add a local-first diff review command:

```bash
ontoindex review diff --base main --head HEAD
```

Later, after the local command is stable, add hosted PR lookup:

```bash
ontoindex pr impact 42
```

The first implementation should reuse the existing impact and diff-impact substrate instead of
adding a new graph walker.

Candidate ownership:

```text
ontoindex/src/core/impact/impact-kernel.ts
ontoindex/src/core/impact/diff-impact.ts
ontoindex/src/cli/review.ts
ontoindex/src/cli/pr.ts           # later hosted-PR adapter only
ontoindex/src/mcp/tools/gn-pr-impact.ts  # later, after CLI contract stabilizes
```

Output envelope:

```text
graph-aware diff review:
  target:
    baseRef
    headRef
    baseHead
    head
    indexedHead
    freshness
  changed:
    files[]
    symbols[]
    tests[]
  affected:
    upstreamSymbols[]
    downstreamSymbols[]
    processFlows[]
    communities[]
    publicApis[]
  risk:
    level
    reasons[]
    crossCommunityEdges[]
    missingCoverage[]
    staleOrPartialInputs[]
  provenance:
    primaryGraph
    filesystemDiff
    gitObjectDatabase
    sidecars[]
```

Rules:

- Local ref mode comes before GitHub/GitLab API integration.
- The command must not auto-fetch, auto-rebase, or auto-index.
- If `indexedHead` does not match the target, the report may return candidates, but action-oriented
  labels must be downgraded according to ADR 0018.
- Community and process-flow sections are ranking aids, not replacements for complete impact
  traversal.
- The first version must work without network access, hosted-provider credentials, or MCP.
- "PR impact" is a wrapper over this local report, not a separate implementation.

### 2. Static review bundle export

Later, add a deterministic export command:

```bash
ontoindex export review-bundle --target HEAD --out .ontoindex/review/HEAD
```

Possible output:

```text
review-bundle/
  REVIEW_REPORT.md
  graph-summary.json
  process-flows.md
  communities.json
  risk-summary.json
  freshness.json
  architecture.html
```

The bundle should be generated from the current OntoIndex index and target context. It is a disposable
snapshot for humans and agents, not a new graph database.

Rules:

- Exported data must include index id, schema version, target ref, target HEAD, indexed HEAD, dirty
  worktree state, and generation time.
- The export must clearly label stale, partial, sidecar-backed, and inferred sections.
- `architecture.html` may include call-flow or process-flow diagrams, but the JSON data is the
  compatibility contract.
- Generated bundles should be written under a gitignored location by default.
- A bundle must be reproducible from command inputs. If it is not reproducible, it is a temporary
  diagnostic artifact, not a review contract.

### 3. Shared confidence and provenance vocabulary

Use a shared vocabulary for reports, sidecars, audit envelopes, and MCP responses. This ADR does not
own a new trust model; it consumes ADR 0018 and proposes a compact vocabulary for report rendering.

Candidate type:

```ts
export type EvidenceConfidence =
  | 'deterministic'
  | 'inferred'
  | 'ambiguous'
  | 'partial'
  | 'stale'
  | 'unsupported';

export type EvidenceSource =
  | 'primary-graph'
  | 'filesystem'
  | 'git-object'
  | 'sidecar'
  | 'embedding'
  | 'mcp-runtime';
```

Initial integration should be response-side only and must not change sidecar storage semantics from
ADR 0015:

- graph-aware diff review report
- review bundle report
- audit trust envelope
- sidecar status output
- query/context/impact metadata

Do not migrate storage first. Storage migration should happen only after response shapes stabilize and
after existing numeric analyzer confidence remains representable.

### 4. Hub suppression and surprising connections

Graphify's "god nodes", hub suppression, and surprising connections are useful for review, but
dangerous if confused with complete impact analysis.

Later, add report-only ranking helpers:

```bash
ontoindex report hubs
ontoindex report surprising-connections
```

Candidate scoring inputs:

```text
hub score:
  degree
  betweenness approximation
  number of process flows
  number of communities touched
  public API weight

surprising connection score:
  crosses community boundary
  crosses directory/package boundary
  rare edge type
  appears in execution flow
  low shared-neighborhood overlap
  deterministic provenance
```

Rules:

- Hub suppression may affect ranking in discovery and review reports.
- Hub suppression must not hide nodes from safety-critical impact output unless the report explicitly
  says it is a ranked, lossy view.
- Surprising connections must include the exact edge, source file, target file, relationship type,
  and provenance.

### 5. Incremental sidecar manifest cache

Apply Graphify's changed-file cache idea to OntoIndex sidecars, especially Markdown and future audit
sidecars.

This is not part of the v1 review report. It is an ADR 0015 implementation improvement that becomes
relevant to this ADR only when review bundles include sidecar-backed document or audit sections.

Candidate manifest:

```text
sidecar manifest:
  sourceIndexId
  sourceCommitHash
  graphSchemaVersion
  analyzerId
  analyzerVersion
  inputSetHash
  files:
    path
    fileHash
    bodyHash
    frontmatterHash
    lastCompletedAt
    status
```

Rules:

- The cache is scoped to a sidecar analyzer and source index.
- File-level reuse is allowed only when analyzer version and relevant hashes match.
- Markdown frontmatter may be hashed separately from body content when the analyzer can prove which
  part affects extracted facts.
- Cache hits must still appear in sidecar status so users can distinguish fresh execution from
  reused records.

## Alternatives Considered

### Copy Graphify's artifact-first graph model

Rejected for OntoIndex.

OntoIndex already has LadybugDB as the graph authority. A second committed graph artifact would create
freshness conflicts, merge conflicts, and unclear ownership between primary graph, sidecars, exports,
and MCP responses.

### Add a generic Graphify-like MCP graph server

Rejected for the first implementation.

OntoIndex MCP tools are already organized around code-intelligence workflows: query, context, impact,
safe edit, audit, and governance. A generic graph server would be lower-level than the product
surface and would bypass ADR 0018 trust requirements unless heavily wrapped.

### Auto-rebuild reports on git hooks by default

Rejected for default behavior.

Hooks may be useful later, but OntoIndex agent instructions require explicit, resource-capped index
work. The first implementation should expose manual commands and honest stale-state reporting.

### Use LLM ranking for PR triage in v1

Rejected for v1.

Start with deterministic graph, diff, community, and freshness signals. LLM summarization can be an
optional presentation layer after the report contract is stable.

## Consequences

Benefits:

- Gives reviewers a compact architecture and PR-risk view without reading the whole repository.
- Makes existing OntoIndex communities and process flows more useful in day-to-day code review.
- Reuses the impact kernel and audit trust contract instead of creating competing safety logic.
- Adds Graphify-style usability while preserving OntoIndex freshness and provenance guarantees.
- Provides a clean path from CLI reports to MCP tools and later web UI surfaces.

Costs:

- Requires a shared report envelope and confidence vocabulary before multiple commands diverge.
- PR impact can become noisy unless the first version is strict about scope and ranking labels.
- Static exports introduce artifact hygiene risk if generated files are committed casually.
- Hosted PR support adds authentication, API-rate, and remote-state concerns; it should not be part
  of the first acceptance gate.
- The ADR deliberately postpones several attractive Graphify-inspired features until the local diff
  review contract proves useful.

Hard guardrails:

- Do not introduce a second canonical graph store.
- Do not let exported review bundles become freshness authority.
- Do not hide stale or partial graph state in review summaries.
- Do not use hub suppression to reduce complete impact results.
- Do not add default git hooks that auto-run broad indexing or report generation.
- Do not add hosted PR integrations before local ref-based reports are deterministic and tested.

## Rollout

Recommended order:

1. Define the minimal local diff review envelope by reusing ADR 0018 target context.
2. Implement `ontoindex review diff --base --head` as a CLI report over the existing impact kernel.
3. Add golden tests for fresh, stale, dirty-worktree, and missing-index cases.
4. Add `ontoindex pr impact 42` only as a hosted-provider adapter over the local report.
5. Add `ontoindex export review-bundle` using the same envelope.
6. Add hub and surprising-connection reports as ranking-only views.
7. Add sidecar manifest cache improvements only when sidecar-backed report sections need them.
8. Expose stable reports through MCP after the CLI contract stops changing.

Acceptance gates:

- Golden snapshot tests for local diff review output.
- Fixture coverage for fresh, stale, dirty-worktree, partial-sidecar, and missing-index states.
- Baseline-subtracted regression tests for any existing impact/query behavior touched by the change.
- ADR 0018 conformance for target context, freshness, evidence envelope, and response limits.
- Documentation that exported files are snapshots, not canonical state.

## Project Plan

### Goal

Ship a local, deterministic graph-aware diff review workflow that turns an implementation diff into a
reviewable report:

```bash
ontoindex review diff --base main --head HEAD
```

The report should explain what changed, which symbols/processes/communities are affected, which
parts of the answer are fresh or stale, and which risks need reviewer attention. It should reconcile
the existing `gn_diff_impact`, `detectChanges`, and impact-kernel paths rather than creating another
impact engine.

### Non-goals for v1

- No hosted PR lookup.
- No GitHub/GitLab authentication.
- No MCP-only feature as the first surface.
- No auto-fetch, auto-rebase, auto-index, or hook-triggered report generation.
- No committed review-bundle artifacts.
- No hub suppression in complete impact calculations.
- No sidecar storage migration.
- No LLM ranking or summary requirement.

### Phase 0: Baseline and Contract Audit

Purpose: confirm the existing diff-impact behavior and define the CLI contract before code changes.

Tasks:

- Inventory current `gn_diff_impact` behavior in `ontoindex/src/mcp/super/diff-impact.ts`.
- Inventory reusable changed-symbol detection from `ontoindex/src/mcp/local/backend-detect-changes.ts`.
- Inventory shared impact behavior from `ontoindex/src/core/impact/impact-kernel.ts`.
- Decide whether `gn_diff_impact` should be adapted over `detectChanges`, whether `detectChanges`
  should call the impact kernel, or whether both should feed a new shared report builder.
- Record the current gap: `gnDiffImpact` performs its own direct graph counts and does not yet call
  `runImpactKernel`.
- Define the stable JSON schema for `ontoindex review diff --json`.

Exit criteria:

- One written response schema exists in tests or docs.
- The plan identifies every existing function reused by v1.
- The implementation choice explicitly eliminates duplicate impact counting between
  `gn_diff_impact`, `detectChanges`, and the new CLI.
- No new graph traversal algorithm is introduced.

Validation:

```bash
cd ontoindex
npx tsc --noEmit
```

### Phase 1: Shared Report Builder

Purpose: separate graph-aware diff review logic from the MCP wrapper so CLI and MCP can share one
implementation. This phase must also remove the current split where `gn_diff_impact` does one
file-level symbol scan and count strategy while `detectChanges` does hunk-overlap and process-flow
mapping.

Candidate files:

```text
ontoindex/src/core/review/diff-review.ts
ontoindex/src/core/review/review-types.ts
ontoindex/src/mcp/local/backend-detect-changes.ts
ontoindex/src/mcp/super/diff-impact.ts
```

Tasks:

- Add a shared `buildDiffReviewReport` function.
- Preserve the current `gn_diff_impact` output through a backwards-compatible adapter.
- Use `detectChanges` or its extracted helper for hunk-overlap changed-symbol detection.
- Use `runImpactKernel` for blast-radius counts where the report needs authoritative impact counts.
- Keep direct Cypher count queries only when they are explicitly labeled as cheap heuristics.
- Normalize target fields: `baseRef`, `headRef`, `baseHead`, `head`, `indexedHead`, `graphIndexId`.
- Normalize changed fields: files, hunks/line counts, changed symbols, changed tests.
- Normalize affected fields: upstream symbols, downstream symbols, affected tests, process flows,
  communities if available.
- Add provenance fields for primary graph, git diff, filesystem overlay, and sidecars.
- Add explicit `limits` and `warnings` arrays.

Exit criteria:

- MCP `gn_diff_impact` and the future CLI can consume the same report builder.
- Existing MCP behavior remains compatible for current callers.
- Changed-symbol detection comes from one shared path.
- Impact/risk counts come from one shared path or are explicitly labeled heuristic.
- Report generation works without network access.

Validation:

```bash
cd ontoindex
npx tsc --noEmit
npm test -- --run test/unit/diff-impact.test.ts
```

### Phase 2: CLI Surface

Purpose: add the user-facing local command from this ADR.

Candidate files:

```text
ontoindex/src/cli/index.ts
ontoindex/src/cli/review.ts
```

Command shape:

```bash
ontoindex review diff --base main --head HEAD
ontoindex review diff --range main...HEAD
ontoindex review diff --staged
ontoindex review diff --json
```

Tasks:

- Register a `review` command group in the CLI.
- Add `review diff`.
- Resolve local repo root without requiring hosted-provider credentials.
- Support text output for humans and JSON output for agents/CI.
- Include stale-index and dirty-worktree warnings in the text output.
- Avoid auto-running `analyze`; suggest the local OntoIndex analyze command when freshness is stale.

Exit criteria:

- Users can run local graph-aware diff review without MCP.
- JSON output is deterministic enough for snapshot tests.
- Text output is compact and does not hide stale or partial inputs.

Validation:

```bash
cd ontoindex
npx tsc --noEmit
npm test -- --run test/unit/review-diff.test.ts
```

### Phase 3: Freshness and ADR 0018 Envelope

Purpose: make the report trustworthy enough for review workflows.

Candidate files:

```text
ontoindex/src/mcp/shared/target-context.ts
ontoindex/src/mcp/shared/freshness-policy.ts
ontoindex/src/core/review/diff-review.ts
```

Tasks:

- Reuse or adapt ADR 0018 target-context fields.
- Report `targetHead`, `currentHead`, `indexedHead`, dirty-worktree state, and snapshot mode.
- Downgrade action-oriented labels when graph-derived impact is stale.
- Label filesystem, git object, primary graph, sidecar, and embedding evidence separately.
- Include missing-index and missing-sidecar states without failing the whole report when candidates
  can still be computed.

Exit criteria:

- Fresh, stale, missing-index, dirty-worktree, and partial-sidecar cases have tested outputs.
- A stale graph never produces a fully actionable risk verdict without an explicit warning.
- The report explains which parts are candidates versus graph-backed facts.

Validation:

```bash
cd ontoindex
npx tsc --noEmit
npm test -- --run test/unit/freshness-policy.test.ts
npm test -- --run test/unit/review-diff.test.ts
```

### Phase 4: Process and Community Enrichment

Purpose: make the report genuinely graph-aware instead of only symbol-aware.

Tasks:

- Add affected execution flows where changed or impacted symbols participate.
- Add affected communities/clusters when community data exists.
- Add cross-community risk reasons as ranking signals.
- Add public API/exported symbol risk reasons when available.
- Keep process/community sections optional and clearly marked when unavailable.

Exit criteria:

- The report can identify at least files, symbols, tests, processes, and communities when indexed
  data contains them.
- Missing community/process data is reported as unavailable, not silently omitted.
- Complete impact counts are not reduced by process/community ranking.

Validation:

```bash
cd ontoindex
npx tsc --noEmit
npm test -- --run test/unit/review-diff.test.ts
```

### Phase 5: Compatibility and Documentation

Purpose: make the feature usable without destabilizing existing MCP and CLI workflows.

Tasks:

- Document `ontoindex review diff` in CLI help and user docs.
- Update `gn_help` wording only if MCP output semantics change.
- Add examples for fresh index, stale index, staged diff, branch diff, and JSON mode.
- Document that hosted `ontoindex pr impact 42` is a later adapter over the local report.
- Document that review bundles are later disposable exports, not canonical graph state.

Exit criteria:

- `ontoindex review diff --help` names local-only behavior clearly.
- Existing `gn_diff_impact` docs remain true.
- No docs imply automatic hosted PR integration.

Validation:

```bash
cd ontoindex
npx tsc --noEmit
npm test -- --run test/unit/diff-impact.test.ts test/unit/review-diff.test.ts
```

### Phase 6: Follow-up Features

These are explicitly after v1:

1. Hosted PR adapter:
   - `ontoindex pr impact 42`
   - Uses local report builder after fetching or resolving a local checked-out ref.
   - Requires explicit remote/auth behavior.
2. Review bundle export:
   - `ontoindex export review-bundle --target HEAD`
   - Writes disposable snapshots under a gitignored output path by default.
3. Hub and surprising-connection reports:
   - Ranking-only discovery views.
   - Never trim complete impact output.
4. Sidecar manifest cache:
   - ADR 0015 implementation improvement.
   - Needed only when sidecar-backed report sections become expensive.
5. MCP exposure:
   - Add or revise MCP wrappers only after the CLI JSON contract stabilizes.

### Work Breakdown

| ID | Work item | Primary files | Depends on |
|----|-----------|---------------|------------|
| R1 | Audit existing `gn_diff_impact` contract | `ontoindex/src/mcp/super/diff-impact.ts` | none |
| R2 | Define shared report types | `ontoindex/src/core/review/review-types.ts` | R1 |
| R3 | Extract shared changed-symbol and report builder paths | `ontoindex/src/core/review/diff-review.ts`, `ontoindex/src/mcp/local/backend-detect-changes.ts` | R1, R2 |
| R4 | Keep MCP compatibility adapter | `ontoindex/src/mcp/super/diff-impact.ts` | R3 |
| R5 | Add CLI command group | `ontoindex/src/cli/index.ts`, `ontoindex/src/cli/review.ts` | R3 |
| R6 | Route authoritative impact counts through shared kernel | `ontoindex/src/core/impact/impact-kernel.ts`, review builder | R3 |
| R7 | Add ADR 0018 freshness envelope | review builder + freshness helpers | R3, R6 |
| R8 | Add process/community sections | review builder + graph queries | R3, R6 |
| R9 | Add focused tests and snapshots | `ontoindex/test/unit/*review-diff*` | R3-R8 |
| R10 | Update docs/help | CLI docs, MCP help if needed | R5-R9 |

### Definition of Done

- `ontoindex review diff --base main --head HEAD` works locally.
- `ontoindex review diff --json` emits a stable schema.
- Existing `gn_diff_impact` remains compatible or has a documented migration.
- `gn_diff_impact`, `detectChanges`, and `ontoindex review diff` do not maintain three independent
  definitions of changed symbols and impact counts.
- Reports include target/freshness/provenance metadata from ADR 0018.
- Reports distinguish complete impact data from ranking-only process/community hints.
- No command auto-fetches, auto-indexes, or depends on hosted PR credentials.
- Focused tests cover fresh, stale, missing-index, dirty-worktree, staged, and branch-range cases.
- Baseline-subtracted validation is recorded before claiming regression tests pass.
