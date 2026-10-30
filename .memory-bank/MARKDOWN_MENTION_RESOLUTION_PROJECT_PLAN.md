# Markdown Mention Resolution Project Plan

Date: 2026-10-14
Status: Closed — shipped in PR #96 (c39d641)
Authority: Follow-up to MARKDOWN_GRAPH_RAG_RETRIEVAL_PROJECT_PLAN.md (PR #94, merged). User requirement of 2026-10-14: consolidate the best option for resolving Markdown code mentions and implement it, using sub-agents on gpt-6.1-sol and gpt-6-luna.

## Goal

Chunks returned by `query` with `include_markdown_context` carry the graph symbols that their backtick code mentions refer to, so a reader can jump from a document chunk to the code. Resolution is bounded, happens only for returned chunks, and never changes stored sidecar facts or chunk ranking.

## How To Use This Plan

Each task is self-contained and every design decision is made in the card. Edit only the files in the task's allowed write set. Run the validation commands from the worktree `ontoindex/` directory. If a stop condition occurs, stop and report it.

## Current State

Observed on `origin/master` at `1c2dcac`.

- Mentions are extracted by `extractCodeMentions` and stored as `markdown-code-mention` facts. All are `unresolved` with reason `no-resolver-configured` because `cli/docs.ts` passes `resolveCodeMention: () => undefined`.
- `toMarkdownDocsEvidenceFact` in `ontoindex/src/mcp/local/local-backend.ts` copies `resolutionStatus`, `resolutionReason` and `candidates` onto chunk evidence but not the mention text (`fact.evidence.text`) and not `target.id`.
- `LbugGraphIdentityProvider.findSymbols` (`markdown-graph-identity-provider.ts`) runs a parameterized name lookup over all node labels and returns candidates with `startLine` for code symbols; File and Route nodes have no `startLine`.
- Measured graph size: Function 6,520, Method 765, Constant 25,605, Interface 1,851.
- Options considered: build-time resolution (rewrites every stored fact and needs an asynchronous resolver in a synchronous producer), a persisted name lookup artifact (new publication artifact), and bounded query-time resolution of returned chunks only. The third is chosen.

## Manager Tracking

```yaml
manager_loop:
  authority: true
  status: closed
  selection_policy: active_next_task-first
  active_next_task: null
  max_in_flight: 1
  dispatch_mode: none
  reopen_gate: null

tasks:
  MR-1.0:
    title: Given chunks with unresolved code mention evidence and a graph identity provider, when resolveChunkMentions runs, then bounded unique symbol matches are attached and ambiguity, overflow, errors and timeouts are reported without throwing
    status: DONE
    classification: implementation-ready
    assurance_profile: full
    complexity: standard
    depends_on: []
    type: code
    validation_tier: unit-fast
    impact_risk: low
    owner_files:
      - ontoindex/src/core/ingestion/enrichment/markdown-mention-resolution.ts
      - ontoindex/test/unit/markdown-mention-resolution.test.ts
    allowed_write_set:
      - ontoindex/src/core/ingestion/enrichment/markdown-mention-resolution.ts
      - ontoindex/test/unit/markdown-mention-resolution.test.ts
    non_goals:
      - Editing local-backend.ts or any stored fact format.
      - Changing LbugGraphIdentityProvider.
    required_validation:
      - cd ontoindex && npx vitest run test/unit/markdown-mention-resolution.test.ts
      - cd ontoindex && npx tsc --noEmit -p tsconfig.json
    validation_workspace:
      root: ontoindex
      inputs:
        - src/core/ingestion/enrichment/markdown-graph-identity-provider.ts
      generated_outputs: []
    expected_evidence:
      - Both commands exit 0 and the test file reports MR1-A through MR1-F passing.
    rollback:
      - git rm --cached -f ontoindex/src/core/ingestion/enrichment/markdown-mention-resolution.ts ontoindex/test/unit/markdown-mention-resolution.test.ts
    stop_conditions:
      - The module needs a change to markdown-graph-identity-provider.ts.
    known_blockers: []
    closeout:
      role_results:
        coder-worker: null
      main_session_evidence:
        authorized_by: user
        authorization_ref: User proceed on 2026-10-30 to reconcile shipped plans
        validation_summary: Shipped in PR #96 (c39d641); closeout MR-1.0..MR-4.0. Modules present on master; 2026-10-30 vitest run of markdown-answer-verify, markdown-answer-grounding, markdown-mention-resolution and sidecar-local-backend-enrichment passed 67 tests in 4 files, exit 0.
    dod_status: pass

  MR-2.0:
    title: Given a query with Markdown context, when the backend builds the response, then returned chunk mention evidence carries mention text and graph resolution, ranking and stored facts are unchanged, and a graph failure leaves the response intact
    status: DONE
    classification: implementation-ready
    assurance_profile: full
    complexity: complex
    depends_on:
      - MR-1.0
    type: code
    validation_tier: unit-fast
    impact_risk: medium
    owner_files:
      - ontoindex/src/mcp/local/local-backend.ts
      - ontoindex/test/unit/sidecar-local-backend-enrichment.test.ts
    allowed_write_set:
      - ontoindex/src/mcp/local/local-backend.ts
      - ontoindex/test/unit/sidecar-local-backend-enrichment.test.ts
    non_goals:
      - Changing chunk ranking, chunk selection or the 5 document and 10 chunk limits.
      - Restoring the rejected mention-to-primary-result boost.
    required_validation:
      - cd ontoindex && npx vitest run test/unit/sidecar-local-backend-enrichment.test.ts test/unit/markdown-mention-resolution.test.ts
      - cd ontoindex && npx tsc --noEmit -p tsconfig.json
    validation_workspace:
      root: ontoindex
      inputs:
        - src/core/ingestion/enrichment/markdown-mention-resolution.ts
      generated_outputs: []
    expected_evidence:
      - Both commands exit 0 and tests MR2-A through MR2-D pass with every pre-existing test unchanged.
    rollback:
      - git checkout -- ontoindex/src/mcp/local/local-backend.ts ontoindex/test/unit/sidecar-local-backend-enrichment.test.ts
    stop_conditions:
      - A pre-existing test in the file fails.
      - Chunk order changes in any existing assertion.
    known_blockers: []
    closeout:
      role_results:
        coder-worker: null
      main_session_evidence:
        authorized_by: user
        authorization_ref: User proceed on 2026-10-30 to reconcile shipped plans
        validation_summary: Shipped in PR #96 (c39d641); closeout MR-1.0..MR-4.0. Modules present on master; 2026-10-30 vitest run of markdown-answer-verify, markdown-answer-grounding, markdown-mention-resolution and sidecar-local-backend-enrichment passed 67 tests in 4 files, exit 0.
    dod_status: pass

  MR-4.0:
    title: Given resolved mentions, when the backend builds the response, then results are returned once per distinct mention in a bounded mentionTargets map instead of on every evidence item, and the heavy recall query grows by less than 20 KB
    status: DONE
    classification: implementation-ready
    assurance_profile: full
    complexity: complex
    depends_on:
      - MR-2.0
    type: code
    validation_tier: unit-fast
    impact_risk: medium
    owner_files:
      - ontoindex/src/mcp/local/local-backend.ts
      - ontoindex/test/unit/sidecar-local-backend-enrichment.test.ts
    allowed_write_set:
      - ontoindex/src/mcp/local/local-backend.ts
      - ontoindex/test/unit/sidecar-local-backend-enrichment.test.ts
    non_goals:
      - Changing the resolution module, ranking or chunk selection.
    required_validation:
      - cd ontoindex && npx vitest run test/unit/sidecar-local-backend-enrichment.test.ts test/unit/markdown-mention-resolution.test.ts
      - cd ontoindex && npx tsc --noEmit -p tsconfig.json
    validation_workspace:
      root: ontoindex
      inputs:
        - src/core/ingestion/enrichment/markdown-mention-resolution.ts
      generated_outputs: []
    expected_evidence:
      - Both commands exit 0; tests MR4-A through MR4-C pass; MR2 tests are updated to the map shape.
    rollback:
      - git checkout -- ontoindex/src/mcp/local/local-backend.ts ontoindex/test/unit/sidecar-local-backend-enrichment.test.ts
    stop_conditions:
      - A chunk key order assertion changes.
    known_blockers: []
    closeout:
      role_results:
        coder-worker: null
      main_session_evidence:
        authorized_by: user
        authorization_ref: User proceed on 2026-10-30 to reconcile shipped plans
        validation_summary: Shipped in PR #96 (c39d641); closeout MR-1.0..MR-4.0. Modules present on master; 2026-10-30 vitest run of markdown-answer-verify, markdown-answer-grounding, markdown-mention-resolution and sidecar-local-backend-enrichment passed 67 tests in 4 files, exit 0.
    dod_status: pass

  MR-3.0:
    title: Given the built CLI and a rerun sidecar, when a live query runs, then mention resolution latency and response growth are measured and recorded
    status: DONE
    classification: implementation-ready
    assurance_profile: full
    complexity: complex
    depends_on:
      - MR-4.0
    type: measurement
    validation_tier: unit-fast
    impact_risk: low
    owner_files:
      - .memory-bank/audit_session-markdown-graph-rag-recall.md
    allowed_write_set:
      - .memory-bank/audit_session-markdown-graph-rag-recall.md
    non_goals:
      - Changing source.
    required_validation:
      - test -s .memory-bank/audit_session-markdown-graph-rag-recall.md
    validation_workspace:
      root: .
      inputs:
        - .memory-bank/audit_session-markdown-graph-rag-recall.md
      generated_outputs: []
    expected_evidence:
      - The audit-session file has a Mention resolution section with resolved count, added milliseconds and added bytes.
    rollback:
      - git checkout -- .memory-bank/audit_session-markdown-graph-rag-recall.md
    stop_conditions:
      - Added latency exceeds 150 ms at the median or response growth exceeds 20 KB.
    known_blockers: []
    closeout:
      role_results:
        coder-performance: null
      main_session_evidence:
        authorized_by: user
        authorization_ref: User proceed on 2026-10-30 to reconcile shipped plans
        validation_summary: Shipped in PR #96 (c39d641); closeout MR-1.0..MR-4.0. Measurement recorded in the plan closeout and audit-session file; 2026-10-30 vitest run of the four Markdown answer, mention and sidecar test files passed 67 tests, exit 0.
    dod_status: pass
```

## Task Cards

### MR-1.0: resolver module

Create `ontoindex/src/core/ingestion/enrichment/markdown-mention-resolution.ts` exporting exactly:

```ts
import type { GraphIdentityProvider } from './markdown-graph-identity-provider.js';

export const MARKDOWN_MENTION_MAX_DISTINCT = 40;
export const MARKDOWN_MENTION_MAX_CANDIDATES = 3;
export const MARKDOWN_MENTION_TIMEOUT_MS = 1500;

export interface ResolvedMentionTarget {
  id: string;
  name?: string;
  filePath?: string;
  startLine?: number;
}
export interface MentionResolution {
  status: 'resolved' | 'ambiguous' | 'unresolved';
  targets: ResolvedMentionTarget[];
  candidateCount?: number;
}
export interface MentionResolutionSummary {
  status: 'ok' | 'partial' | 'skipped';
  lookups: number;
  reason?: string;
}

export function mentionLookupName(text: string): string | undefined;
export async function resolveMentionTexts(
  texts: readonly string[],
  provider: Pick<GraphIdentityProvider, 'findSymbols'>,
  options?: { timeoutMs?: number },
): Promise<{ resolutions: Map<string, MentionResolution>; summary: MentionResolutionSummary }>;
```

Rules, all fixed:

1. `mentionLookupName(text)`: trim; return `undefined` unless it matches `/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/` and has at most 80 characters. For a dotted text return the last segment; otherwise return the text. Texts with spaces, slashes, flags, call parentheses or backticks are not symbols.
2. `resolveMentionTexts` maps each input text to its lookup name, drops `undefined`, de-duplicates by lookup name, keeps the first `MARKDOWN_MENTION_MAX_DISTINCT` names in input order, and runs one `findSymbols({ mention: name, maxCandidates: MARKDOWN_MENTION_MAX_CANDIDATES + 1 })` per name, sequentially. The returned map is keyed by the ORIGINAL text.
3. Keep only candidates that have a numeric `startLine` (code symbols; File and Route nodes have none). With zero kept candidates the status is `unresolved`; with exactly 1 it is `resolved` and `targets` holds that one target; with more than 1, or when the provider returned more than 3 raw candidates, it is `ambiguous`, `targets` is an empty array and `candidateCount` holds the kept candidate count (at most 4, meaning 4 or more). Never pick a first match for an ambiguous name. (Revised after the MR-3.0 measurement: ambiguous target lists were 75 percent of the added bytes and carry no actionable pick.)
4. The whole run has a deadline of `options.timeoutMs ?? MARKDOWN_MENTION_TIMEOUT_MS`. If it passes, stop looking up further names, mark every unresolved-by-lookup name as absent from the map, and return summary `{ status: 'partial', reason: 'timeout' }`. A provider error for one name marks `partial` with reason `provider-error` and continues; it never throws.
5. When all names finish normally the status is `ok`. With no usable names the status is `ok` and `lookups` is 0.

Tests (file `markdown-mention-resolution.test.ts`, fake provider):
- MR1-A: `mentionLookupName` accepts `foo`, `Foo.bar` (returns `bar`), `$x`; rejects `git status`, `src/a.ts`, `foo()`, `--flag`, an 81-character name.
- MR1-B: one candidate with `startLine` gives `resolved` with that target; a File-like candidate without `startLine` gives `unresolved`.
- MR1-C: two candidates give `ambiguous` with empty `targets` and `candidateCount` 2; four raw candidates give `ambiguous` with empty `targets` and `candidateCount` 4.
- MR1-D: 100 distinct names cause exactly 40 `findSymbols` calls; duplicate texts cause one call.
- MR1-E: a provider that throws for one name still resolves the others and the summary is `partial` with `provider-error`.
- MR1-F: a provider that never resolves within a 20 ms `timeoutMs` returns `partial` with `timeout` and does not hang.

### MR-2.0: backend wiring

In `ontoindex/src/mcp/local/local-backend.ts`:

1. Add optional fields to `MarkdownDocsEvidenceFact`: `mention?: string; graphResolution?: { status: 'resolved' | 'ambiguous' | 'unresolved'; targets: ResolvedMentionTarget[] }`.
2. In `toMarkdownDocsEvidenceFact`, for kind `markdown-code-mention` copy `fact.evidence.text` (when it is a string of at most 120 characters) to `mention`. Change nothing else there.
3. In `readLocalEnrichmentMetadata`, after `markdownContext` is built and only when it exists, collect the `mention` texts of chunk evidence in `markdownContext.relatedChunks` whose kind is `markdown-code-mention` and whose chunk has no `degradedReasons`. Call `resolveMentionTexts(texts, new LbugGraphIdentityProvider({ repoId: repo.id }))` inside a try/catch. Attach `graphResolution` to each matching evidence item (mutating the already-bounded chunk evidence objects) and add `mentionResolution: summary` to the returned enrichment metadata next to `factsBound`. On any thrown error attach nothing and set `mentionResolution: { status: 'skipped', lookups: 0, reason: 'error' }`.
4. Do not change chunk selection, ordering, `facts`, `visibleRecords` or PPR input.

Tests in `sidecar-local-backend-enrichment.test.ts` (mock the provider module the way existing tests mock lbug):
- MR2-A: a returned chunk with a mention `buildPhaseList` gets `graphResolution.status = 'resolved'` and the target id.
- MR2-B: the same query with a failing provider still returns identical chunk keys in identical order. A provider error on a name is reported by the module as `mentionResolution.status = 'partial'` with reason `provider-error`; `'skipped'` with reason `error` is only for an exception thrown outside the module (for example while building the provider). The test accepts either value and asserts the chunk order.
- MR2-C: a chunk that is not returned causes no lookup (assert the provider call count equals the number of distinct mentions in returned chunks only).
- MR2-D: a request without `include_markdown_context` makes no provider call.

### Docs step (not a tracked task; the validator does not accept product docs as task scope)

Add to the `## Markdown retrieval (docs sidecar)` section of `RUNBOOK.md` (repository root) a short paragraph: resolution runs per request on returned chunks only; fields `mention`, `graphResolution`, `mentionResolution`; limits 40 names, 3 candidates, 1,500 ms; stored facts stay `unresolved`; failures never fail the query. Add one `ontoindex/CHANGELOG.md` bullet under the current unreleased heading.

### MR-4.0: bounded mentionTargets map

Measured on the heavy recall query (75 mention items, 47 distinct): per-item attachment adds 19 KB; a per-response map keyed by mention text, with unresolved names omitted, adds 11 KB and is bounded by the 40-name limit. Pre-merge, so no external contract exists yet.

1. In `local-backend.ts` remove `graphResolution` from `MarkdownDocsEvidenceFact` and stop writing it on evidence items. Evidence items keep `mention`.
2. Return `mentionTargets` next to `mentionResolution` in the enrichment metadata (same spread as `factsBound`): an object keyed by the original mention text with value `{ status: 'resolved' | 'ambiguous', targets: ResolvedMentionTarget[], candidateCount?: number }`. Include only `resolved` and `ambiguous` entries. An absent key means unresolved or not looked up; `mentionResolution.status` says whether the run was `partial` or `skipped`.
3. Build it from the `resolutions` map returned by `resolveMentionTexts`, restricted to texts of mentions present on returned chunks. Add the field to the `LocalEnrichmentConsumptionMetadata` type. No other behavior changes.

Tests (update MR2-A and MR2-B to the new shape, add): MR4-A the map has exactly one entry per distinct resolved mention even when the mention appears on several chunks; MR4-B unresolved mentions are absent from the map; MR4-C a response with 60 distinct resolvable mentions has at most 40 map entries.

### MR-3.0: measurement

Rebuild the CLI, rerun `ontoindex docs sidecar run markdown`, run the eight recall queries from the audit-session file with `include_markdown_context`, and record in a new `## Mention resolution` section: resolved/ambiguous/unresolved counts, median and p95 added milliseconds compared with the same query before the change, and added bytes. Stop if the stop condition in the task holds.

## Required Traceability

| Requirement ID | ADR/user requirement | Disposition | Task IDs | Validation |
| --- | --- | --- | --- | --- |
| REQ-101 | Returned chunks expose resolved graph symbols for their code mentions | implementation | MR-1.0, MR-2.0 | MR1-A to MR1-F, MR2-A pass |
| REQ-102 | Resolution is bounded and cannot break a query | implementation | MR-1.0, MR-2.0 | MR1-D, MR1-E, MR1-F, MR2-B, MR2-C pass |
| REQ-103 | Ranking and stored facts are unchanged | implementation | MR-2.0 | MR2-B and pre-existing tests pass |
| REQ-104 | Behavior is documented | proof-only | MR-3.0 | Docs step prettier check, recorded in the audit session |
| REQ-105 | Latency and size cost is measured | proof-only | MR-3.0 | Audit session section |
| REQ-106 | Added response size has a hard bound | implementation | MR-4.0 | MR4-A to MR4-C pass |

## Decisions And Non-Goals

- Chosen: bounded query-time resolution after chunk selection, reusing `LbugGraphIdentityProvider.findSymbols`. Rejected: build-time resolution (async resolver in a synchronous producer, rewrites all stored facts, generation pinning), persisted name lookup artifact (new publication artifact without measured need).
- Ambiguous names stay ambiguous; the first match is never selected.
- Only candidates with a numeric `startLine` count as symbols.
- Stored `resolutionStatus` stays `unresolved`; live resolution is reported separately as `graphResolution`.
- Out of scope: ranking by mentions, changing `cli/docs.ts`, new graph queries or indexes.

## Closeout

Executed 2026-10-14 with workers `gpt-6.1-sol` x7 and `gpt-6-luna` x4 (task statuses in the YAML stay OPEN because the workers had no manager-loop lease). PR #96. MR-1.0 module, MR-2.0 backend wiring, the docs step and MR-4.0 (per-response `mentionTargets` map) done; 76 tests pass across the four touched test files; `tsc` 0 errors.

MR-3.0 measurement is in `audit_session-markdown-graph-rag-recall.md`. Per-item attachment with up to 3 targets added up to 50 KB; count-only ambiguity cut that to 24 KB on the heaviest query; the `mentionTargets` map brings it to 16 KB, median 3.7 KB, so the 20 KB stop condition holds for all eight queries.

Merged as PR #96 (`c39d641`); temporary worktrees removed. Sidecars do not need a rerun because stored facts are unchanged.

Later merged work: #96 query-time mention resolution; #98 analysis-coordinator test polling ceilings; #99/#100/#102 CI workflow hardening; #101 the 25-fact per-(chunk, fact kind) cap; #103 release 2.3.4; #104 integration test fixes. See the retrieval plan’s “Later merged work” closeout for commits and payload measurements.
