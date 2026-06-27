# Session-Log Usefulness Refactoring Plan

Status: No active dispatch; slices 1, 2, 4, 5, and 6 are implemented in the current worktree, Slice 3 v1 is implemented for explicit tracker-state facts, validation remains the commands listed below, and generic prose tracker extraction remains deferred
Owner: OntoIndex maintainers
Scope: OntoIndex MCP targeting, readiness reporting, docs extraction, diff/review scoping, tool-contract consistency, and support diagnostics
Created: 2026-06-27
Last reviewed: 2026-06-27

## Goal

Use repeated Ontocode and Codex session failures to make OntoIndex more useful in real agent loops without adding a new subsystem, a second tracker engine, or a parallel session runtime.

## Architecture Fit Gate

### Real new functionality

Accepted:

- make repo-target mismatch fail fast with one clear repair path;
- give one authoritative readiness verdict instead of fragmented partial signals;
- extract tracker-state facts from existing docs surfaces;
- make diff/review usable in dirty worktrees;
- make CLI, MCP, and skill docs agree from one contract source;
- expose minimal support/debug state for audit and local store troubleshooting.

Rejected:

- a separate session manager product;
- a new planning or tracking engine;
- a second diagnostics stack beside `gn_diagnose` / `mcp-doctor`;
- a replacement for current docs or review surfaces.

### Core-extension fit

This plan extends existing owners only:

- `ontoindex/src/mcp/shared/target-context.ts`
- `ontoindex/src/cli/mcp.ts`
- `ontoindex/src/cli/mcp-doctor.ts`
- `ontoindex/src/cli/status.ts`
- `ontoindex/src/cli/audit.ts`
- `ontoindex/src/mcp/super/diagnose.ts`
- `ontoindex/src/mcp/super/ensure-fresh.ts`
- `ontoindex/src/mcp/super/help.ts`
- `ontoindex/src/mcp/super/docs.ts`
- `ontoindex/src/mcp/super/tool-contract.ts`
- `ontoindex/src/mcp/local/backend-detect-changes.ts`
- `ontoindex/src/core/review/diff-review.ts`
- `ontoindex/src/core/lbug/lbug-adapter.ts`

No new subsystem is approved.

## Source Evidence

The plan is based on repeated session failures and operator friction observed in:

- repo-target mismatch during MCP use:
  - `/home/evrasyuk/.codex/sessions/2026/06/14/rollout-2026-06-14T08-52-13-019ec554-dcf3-7692-b083-065cfde0c599.jsonl`
- fragmented health/readiness reports and manual issue synthesis:
  - `/home/evrasyuk/.ontocode/sessions/2026/06/24/rollout-2026-06-24T17-49-15-019efac0-1e44-7420-91c3-b56541678ab7.jsonl`
- manager loops that still need manual tracker interpretation:
  - `/home/evrasyuk/.codex/sessions/2026/06/06/rollout-2026-06-06T04-12-15-019e9b21-ab76-7f02-a88a-7c4a7f5c8a97.jsonl`
  - `/home/evrasyuk/.codex/sessions/2026/06/18/rollout-2026-06-18T04-10-32-019ed8ec-6834-7d93-972e-a16221dac5a5.jsonl`
- command/skill contract drift:
  - `/home/evrasyuk/.codex/sessions/2026/06/14/rollout-2026-06-14T07-21-00-019ec501-57d4-7f81-a044-7ccbc89c6a68.jsonl`
  - `/home/evrasyuk/.agents/skills/ontoindex-guide/SKILL.md`
  - `ontoindex/src/mcp/resources.ts`
  - `ontoindex/src/mcp/server.ts`

## Refactoring Sequence

1. Slice 1: Repo targeting and startup trust
2. Slice 2: Unified readiness verdict
3. Slice 5: Tool-contract consistency
4. Slice 4: Dirty-worktree diff/review scoping
5. Slice 6: Minimal support/debug surfaces
6. Slice 3: Tracker-state extraction from docs

This order fixes trust and correctness first, then improves manager ergonomics.

## Slice 1: Repo Targeting And Startup Trust

### Problem

Wrong-scope MCP sessions still produce avoidable operator failure and repair-by-hand behavior.

### Owners

- `ontoindex/src/cli/mcp.ts`
- `ontoindex/src/mcp/shared/target-context.ts`
- `ontoindex/src/mcp/super/diagnose.ts`
- `ontoindex/src/cli/mcp-doctor.ts`
- `ontoindex/src/mcp/super/help.ts`

### Required delta

- make repo-scope mismatch a first-class status instead of a raw error blob;
- return one exact restart command for the requested repo;
- surface active repo label/path and scope confidence in one compact block.

### Acceptance

- wrong-scope MCP calls fail with one clear repair path;
- `gn_diagnose` and CLI doctor agree on the same scope verdict.

### Tests

- `ontoindex/test/unit/target-context.test.ts`
- `ontoindex/test/unit/super/diagnose.test.ts`
- `ontoindex/test/unit/mcp-doctor.test.ts`

## Slice 2: Unified Readiness Verdict

### Problem

The core readiness pieces already exist, but they are not consumed consistently across CLI and MCP surfaces. Users still reconcile graph freshness, embeddings, dirty worktree, audit state, and repo scope by hand.

### Owners

- `ontoindex/src/mcp/super/diagnose.ts`
- `ontoindex/src/mcp/super/ensure-fresh.ts`
- `ontoindex/src/mcp/shared/freshness-policy.ts`
- `ontoindex/src/cli/status.ts`

### Required delta

- reuse and tighten the existing readiness structures in `gn_diagnose`:
  - repo scope
  - graph freshness
  - dirty worktree
  - embeddings
  - audit freshness
  - docs/sidecar availability
- make CLI `status` and MCP `gn_diagnose` present the same underlying statuses and repair commands.

### Acceptance

- ambiguous combinations such as fresh graph plus degraded embeddings metadata get a precise reason without adding a second readiness schema;
- every degraded state includes one repair command.

### Tests

- `ontoindex/test/unit/super/diagnose.test.ts`
- `ontoindex/test/unit/super/ensure-fresh.test.ts`

## Slice 3: Tracker-State Extraction From Existing Docs Surfaces

### Problem

Manager loops still manually interpret some explicitly maintained docs artifacts to answer:

- what is left
- what is blocked
- why there is no dispatch
- what reopens the task

### Owners

- `ontoindex/src/mcp/super/docs.ts`
- `ontoindex/src/mcp/super/docs-evidence.ts`
- `ontoindex/src/core/ingestion/enrichment/docs-sidecar-status.ts`

### Required delta

Extend docs readiness/context outputs only for explicitly contracted tracker-style docs artifacts. Do not attempt generic markdown tracker parsing.

Implemented v1:

- an opted-in docs contract can now emit tracker-state facts from explicit frontmatter with `ontoindex.kind: tracker-state`;
- `gn_docs` readiness/context responses now expose bounded tracker fields when those explicit facts are present;
- generic markdown prose still does not produce tracker state.

Bounded fields:

- `openTasks`
- `blockedReasons`
- `noDispatchReason`
- `reopenCriteria`
- `nextAction`

Guardrails:

- only extract fields when the docs sidecar already has explicit anchors or facts supporting them;
- if a docs artifact does not follow the contract, return no structured tracker fields;
- no planner, workflow runtime, or free-form tracker interpretation is approved in this slice.

### Acceptance

- manager loops can query existing docs surfaces for structured reopen/blocker state when the source docs are explicitly contracted for it;
- non-contracted markdown remains advisory text, not machine-readable tracker state.

Current decision:

- keep the contract narrow: only explicit tracker-state facts emitted by the docs sidecar are authoritative;
- generic prose, headings, and checklists remain out of scope;
- broader tracker extraction stays deferred until there is a stronger docs-sidecar contract than free-form markdown text.

### Tests

- `ontoindex/test/unit/markdown-sidecar-producer.test.ts`
- `ontoindex/test/integration/mcp-docs-facades.test.ts`
- `ontoindex/test/integration/docs-trace.test.ts`
- `ontoindex/test/unit/docs-inline-context.test.ts`

## Slice 4: Dirty-Worktree Diff And Review Scoping

### Problem

Dirty worktrees dilute review and impact trust even when the user only wants a bounded slice.

### Owners

- `ontoindex/src/mcp/local/backend-detect-changes.ts`
- `ontoindex/src/core/review/diff-review.ts`
- `ontoindex/src/cli/review.ts`
- `ontoindex/src/mcp/super/pre-commit-audit.ts`

### Required delta

- add scoped diff filters by path set and optional tracker-owned file set;
- mark unrelated dirty files separately instead of polluting the main impact verdict.

Current narrowing:

- first ship `detect_changes` path-prefix scoping and omitted-file warnings;
- then extend the same bounded scoping shape to review surfaces only if user evidence still justifies it.

Implemented in this step:

- `gn_diff_impact`, `gn_review_diff`, and `ontoindex review diff` now accept path-prefix scoping;
- out-of-scope dirty files are reported as warnings instead of diluting the in-scope blast radius.

Implemented in this step:

- `gn_pre_commit_audit` now accepts path-prefix scoping;
- empty in-scope commit audits stay READY but explicitly report omitted ambient dirty files.

### Acceptance

- mixed worktrees still yield a trusted local blast-radius report for the intended slice;
- output clearly separates in-scope changes from ambient dirty state.

### Tests

- `ontoindex/test/unit/detect-changes-bounds.test.ts`
- `ontoindex/test/unit/review-diff.test.ts`
- `ontoindex/test/unit/file-scope-preview.test.ts`

## Slice 5: Tool-Contract Consistency

### Problem

CLI help, MCP tool names, and skill docs still drift. The current `list` versus `list_repos` mismatch is one concrete example.

### Owners

- `ontoindex/src/mcp/server.ts`
- `ontoindex/src/mcp/resources.ts`
- `ontoindex/src/mcp/tools.ts`
- `ontoindex/src/mcp/super/tool-definitions.ts`

### Required delta

- keep the intentional split explicit and tested:
  - CLI repo listing command: `ontoindex list`
  - MCP repo listing tool: `list_repos`
- encode that split in repo-owned MCP help/resources and tests so consumer docs can be synced from a stable source.

Downstream skills outside this repo, such as `/home/evrasyuk/.agents/skills/ontoindex-guide/SKILL.md`, should be treated as consumers to sync after the repo-owned source of truth is corrected. They are not primary implementation owners for this slice.

### Acceptance

- repo-owned help/resources explicitly distinguish CLI `ontoindex list` from MCP `list_repos`;
- drift is caught before release by repo-owned tests;
- downstream skill/docs consumers have one unambiguous repo-owned source to mirror.

Implemented in this step:

- repo-owned help/resources and next-step hints now call out the intentional split between CLI `ontoindex list` and MCP `list_repos`;
- repo-owned tests cover the contract through MCP hints, resource text, direct tool schema, and CLI help surfaces.

### Tests

- `ontoindex/test/unit/super/tool-contract.test.ts`
- `ontoindex/test/unit/super/tool-contract-policies.test.ts`
- `ontoindex/test/unit/tool-contract-schema.test.ts`
- `ontoindex/test/unit/mcp-hints.test.ts`
- `ontoindex/test/unit/resources.test.ts`
- `ontoindex/test/unit/tools.test.ts`
- `ontoindex/test/unit/tool-direct-cli.test.ts`
- `ontoindex/test/unit/cli-index-help.test.ts`

## Slice 6: Minimal Support And Debug Surfaces

### Problem

Support/debug work still requires raw file inspection for audit freshness and LadybugDB local-store state.

### Owners

- `ontoindex/src/cli/status.ts`
- `ontoindex/src/cli/audit.ts`
- `ontoindex/src/core/lbug/lbug-adapter.ts`
- `ontoindex/src/cli/mcp-doctor.ts`
- `ontoindex/src/mcp/super/diagnose.ts`

### Required delta

- add a tiny readable summary for:
  - audit projection freshness
  - `lbug` file metadata
  - extension availability
  - timeout hints where available

Keep it diagnostic only.

### Acceptance

- common support questions can be answered without manual binary/file spelunking;
- no internal storage redesign is introduced.

Implemented in this step:

- `ontoindex status` now prints a small Ladybug support block with:
  - local store presence, size, and modified time;
  - sidecar presence for `.wal` and `.lock`;
  - FTS/vector extension availability plus hint dir when missing;
  - native `getAll()` timeout;
  - audit replay hint when audit freshness already reports a repair command.
- `gn_diagnose` now exposes the same support facts as structured fields so CLI/UI callers can reuse one repo-owned diagnostic source instead of re-reading local storage ad hoc.
- `mcp-doctor` now reuses the same structured support diagnostics in text output instead of maintaining a separate local probe path.
- `ontoindex audit` now prints the same bounded support hints on report-generation failure, so LadybugDB timeout and extension issues surface a repair context immediately instead of forcing local storage inspection.

## Validation

Run the smallest checks that prove the landed worktree slices and keep Slice 3 deferred until a docs contract exists:

```bash
cd ontoindex && npx tsc --noEmit
cd ontoindex && npx vitest run test/unit/target-context.test.ts test/unit/super/diagnose.test.ts test/unit/super/ensure-fresh.test.ts test/unit/status.test.ts test/unit/mcp-doctor.test.ts test/unit/audit-command.test.ts
cd ontoindex && npx vitest run test/unit/super/tool-contract.test.ts test/unit/super/tool-contract-policies.test.ts test/unit/tool-contract-schema.test.ts test/unit/mcp-hints.test.ts test/unit/resources.test.ts test/unit/tools.test.ts test/unit/tool-direct-cli.test.ts test/unit/cli-index-help.test.ts
cd ontoindex && npx vitest run test/unit/detect-changes-bounds.test.ts test/unit/review-diff.test.ts test/unit/super/diff-impact.test.ts test/unit/super/pre-commit-audit.test.ts
cd ontoindex && npx vitest run test/unit/markdown-sidecar-producer.test.ts test/integration/mcp-docs-facades.test.ts
```

Do not expand Slice 3 beyond these explicit tracker-state facts until the docs sidecar carries a stronger tracker contract than free-form markdown text.

## Reopen Gate

Do not open a fresh implementation slice from this plan unless one of these conditions becomes true:

- another existing support or debug surface still forces manual file or binary inspection after the current Slice 6 support fields;
- the docs sidecar needs a broader tracker contract than the current explicit `tracker-state` frontmatter facts;
- new repo-owned evidence shows that CLI, MCP, and repo-owned help/resources have drifted again on the same contract family.

If none of those conditions is met, keep this plan closed for dispatch and do not rewrite tracking from prose alone.

## Remaining Work

- finish any remaining Slice 6 parity only if another existing support or debug surface still requires manual file or binary inspection;
- keep generic prose tracker extraction deferred unless the docs contract grows beyond explicit `tracker-state` facts;
- do not reopen tracking extraction work from prose alone;
- otherwise keep the plan in no-dispatch state.
