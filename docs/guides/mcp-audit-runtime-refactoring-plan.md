# MCP Audit Runtime Refactoring Plan

Last updated: 2026-06-14
Status: Implemented, challenged, and narrowed
Owner: OntoIndex maintainers

## Purpose

Fix the current MCP audit/runtime defects without adding a parallel subsystem, widening the public
surface, or mixing environment misconfiguration with product bugs.

This plan is based on the current issue report covering:

- `audit({action:"report"})` timing out on large dirty workspaces;
- `gn_audit_verify` crashing on partial inline findings;
- `gn_audit_session_start({persist:false})` contradicting its own contract;
- `gn_propose_location` failing for repo labels such as `codex`;
- `inspect({action:"ipc"})` mislabeling non-JS symbols;
- `impact({action:"diff"})` producing oversized results on dirty worktrees.

Code paths reviewed directly:

- `ontoindex/src/mcp/super/audit-session-tools.ts`
- `ontoindex/src/mcp/super/audit-verify.ts`
- `ontoindex/src/core/audit-lifecycle/finding-verify.ts`
- `ontoindex/src/mcp/super/propose-location.ts`
- `ontoindex/src/audit/ipc-trace.ts`
- `ontoindex/src/mcp/local/backend-audit-report.ts`
- `ontoindex/src/mcp/super/diff-impact.ts`
- `ontoindex/src/core/review/diff-review.ts`

## Architecture-Fit Gate

### Gate 1: Real New Functionality

Accepted work must add real runtime safety or usability:

- inline finding normalization that prevents verifier crashes;
- non-persistent audit session handling that actually works;
- repo-label-aware proposal location resolution;
- language-neutral IPC tracing;
- bounded audit/diff report contracts;
- explicit summary-first behavior for large outputs, with cursoring deferred unless later evidence proves it necessary.

Rejected work:

- renaming existing MCP tools without changing behavior;
- adding a second audit pipeline;
- replacing the current MCP facade;
- adding a background worker/report service for this plan;
- broad “performance rewrite” claims without targeted runtime controls.

### Gate 2: Core Extension Only

Accepted work must extend existing core seams:

- `ontoindex/src/mcp/super/audit-session-tools.ts`
- `ontoindex/src/mcp/super/audit-verify.ts`
- `ontoindex/src/core/audit-lifecycle/finding-verify.ts`
- `ontoindex/src/mcp/super/propose-location.ts`
- `ontoindex/src/audit/ipc-trace.ts`
- `ontoindex/src/mcp/local/backend-audit-report.ts`
- `ontoindex/src/mcp/super/diff-impact.ts`
- `ontoindex/src/core/review/diff-review.ts`

Do not introduce:

- a second repo resolver;
- a second audit event store;
- a new report service;
- a separate IPC tracing subsystem.

## Challenge Summary

The reported problems are not one class of work.

1. **Three items are correctness bugs and should be fixed first.**
   - `gn_audit_session_start({persist:false})`
   - inline `gn_audit_verify`
   - repo-label handling in `gn_propose_location`
2. **Two items are output-contract issues, not raw correctness failures.**
   - `audit({action:"report"})`
   - `impact({action:"diff"})`
3. **The MCP repo-scope blocker is mostly environment state for the current session.**
   - It matters operationally, but it should not be mixed into the product refactor stream below.
4. **`inspect({action:"ipc"})` needs semantic relabeling, not deeper graph changes.**
5. **Cursoring is not automatically justified.**
   - First prove that stronger summary-first limits and partial-result contracts are insufficient.
   - Do not widen the public surface unless the bounded summary still fails real agent workflows.

## Review Outcome

The current implementation matches the narrowed architecture cut:

- `persist:false` now skips store-backed lock creation and returns an explicit ephemeral response.
- inline `gn_audit_verify` now normalizes partial findings instead of crashing on missing arrays.
- `gn_propose_location` now resolves repo labels through the repo registry path instead of cwd-only guessing.
- IPC trace labeling now derives language-specific prefixes from the symbol file path instead of hardcoding JS wording.
- audit report fan-out now has bounded per-backend and total runtime budgets, surfacing partial-result state through the existing `warnings` contract.
- diff impact now ships bounded summary-first output with explicit truncation markers for file/symbol detail.

The following were explicitly not added:

- a second audit/report subsystem;
- a second repo resolver;
- cursor-based continuation for diff impact;
- any new MCP self-targeting lane beyond the separate ADR 0085 work.

## Current Findings

| Priority | Area | Main files | Problem | Decision |
| --- | --- | --- | --- | --- |
| P0 | Audit session lifecycle | `audit-session-tools.ts` | `persist:false` still creates a store-backed lock | Implemented |
| P0 | Audit verify | `audit-verify.ts`, `finding-verify.ts` | partial inline finding can crash on missing arrays | Implemented |
| P0 | Proposal location | `propose-location.ts` | repo labels do not resolve to repo roots | Implemented |
| P1 | IPC trace labeling | `ipc-trace.ts` | non-JS symbols are emitted as `JS Function`/similar | Implemented |
| P1 | Audit report runtime budget | `backend-audit-report.ts` | no internal budget or partial-result deadline | Implemented as bounded partial-result contract |
| P1 | Diff impact output budget | `diff-impact.ts`, `diff-review.ts` | large dirty worktrees still emit oversized review payloads | Implemented as summary-first bounded detail; cursor deferred |
| P2 | Operational self-targeting | MCP client config / docs | live session may point at wrong repo | Track separately under ADR 0085/runtime setup guidance |

## Workstreams

### M1. Non-Persistent Audit Session Contract Fix

Priority: P0

Problem:

- `gn_audit_session_start({persist:false})` still assumes a persisted store entry exists.

Plan:

- Make `persist:false` skip store-backed lock creation.
- Return an explicit session shape for ephemeral sessions.
- Keep persisted-session behavior unchanged.
- Add regression tests for both persisted and non-persisted starts.

Acceptance:

- `persist:false` returns a usable session response without store lookup failure.
- `persist:true` still produces the current lock semantics.
- No caller needs a second session-start tool.

Validation:

- `cd ontoindex && npm test -- --run test/integration/audit-lifecycle-mcp.test.ts`
- `cd ontoindex && npx tsc --noEmit --pretty false`

### M2. Inline Finding Normalization for Audit Verify

Priority: P0

Problem:

- inline findings can omit array fields that verification currently assumes exist.

Plan:

- Add a normalization layer in `audit-verify.ts` for inline findings.
- Fill missing arrays with safe defaults:
  - `reasonCodes`
  - `verifiedEvidence`
  - `claimedEvidence`
  - other verifier-required collection fields
- Reject structurally invalid inline findings with a bounded error instead of crashing.

Acceptance:

- partial inline findings no longer crash with `.includes` or `.some` on `undefined`.
- invalid inline payloads produce a structured error.
- stored-session verification behavior stays unchanged.

Validation:

- `cd ontoindex && npm test -- --run test/unit/audit-verify.test.ts`
- `cd ontoindex && npx tsc --noEmit --pretty false`

### M3. Repo-Label-Aware Proposal Location Resolution

Priority: P0

Problem:

- `gn_propose_location` derives repo root from the raw `repoId` string rather than the resolved repo handle.

Plan:

- Remove cwd-only repo-root guessing from the main path.
- Resolve repo root from the already-resolved repo handle.
- Keep safe-path containment checks for import-pattern sniffing.
- Add tests for:
  - repo label
  - absolute repo path
  - cwd-local repo

Acceptance:

- `repo:"codex"` no longer yields `target repo root is unknown` when the repo is resolvable.
- import pattern sniffing still stays inside the target repo root.

Validation:

- `cd ontoindex && npm test -- --run test/unit/super/propose-location.test.ts`
- `cd ontoindex && npx tsc --noEmit --pretty false`

### M4. Language-Neutral IPC Trace Labels

Priority: P1

Problem:

- `inspect({action:"ipc"})` treats all matched symbols as JavaScript-origin definitions.

Plan:

- Derive emitted step labels from graph labels and file language.
- Replace hardcoded `JS ${label}` / `JavaScript definition/export...` text with language-neutral wording.
- Preserve the bridge/C++ registration portions of the flow.

Acceptance:

- Rust, C++, and other non-JS symbols are not mislabeled as JS definitions.
- JS symbols still render clearly.

Validation:

- `cd ontoindex && npm test -- --run test/unit/ipc-trace.test.ts test/unit/ipc-trace-impl.test.ts`
- `cd ontoindex && npx tsc --noEmit --pretty false`

### M5. Audit Report Time Budget and Partial Result Contract

Priority: P1

Problem:

- `audit({action:"report"})` has no internal wall-clock budget and can exceed MCP caller timeouts.

Plan:

- Add an explicit internal report deadline/budget.
- Return partial results with warnings when the budget is hit.
- Keep the same backend fan-out set; do not add a second report mode.
- Make timeout state visible in the current response contract through bounded warning-based partial results, not a new top-level state field.

Acceptance:

- large dirty workspaces return bounded partial reports instead of hanging until external timeout.
- warnings clearly identify timed-out backends.
- no new async report subsystem is introduced.

Validation:

- `cd ontoindex && npm test -- --run test/unit/audit-report-shape.test.ts`
- `cd ontoindex && npx tsc --noEmit --pretty false`

### M6. Diff Impact Summary-First and Output Budgeting

Priority: P1

Problem:

- dirty worktrees can still produce review payloads that are too large for normal agent workflows.

Plan:

- Add summary-first output for `impact({action:"diff"})`.
- Add stronger record limits and bounded truncation markers for detailed file-symbol output.
- Keep current graph analysis logic; only refactor result shaping and bounded truncation.
- Only add a cursor/continuation contract if the tighter bounded summary still proves insufficient in focused review tests.

Acceptance:

- first response stays bounded on very dirty worktrees.
- callers can still distinguish summary vs truncated detail explicitly.
- existing small-diff behavior remains readable.
- no new diff-analysis engine is introduced.

Validation:

- `cd ontoindex && npm test -- --run test/unit/super/diff-impact.test.ts`
- `cd ontoindex && npx tsc --noEmit --pretty false`

## Not In Scope

- Changing the current live MCP service from `codex` to `ontoindex` as part of this refactor.
- Reworking session startup docs beyond the already-shipped ADR 0085 arg-first path (`ontoindex mcp --project <path>`).
- Replacing the MCP startup model again after ADR 0085.
- Rebuilding audit report fan-out as a separate background job system.
- Replacing LadybugDB or the graph query layer.

## Delivery Order

1. M1 Non-Persistent Audit Session Contract Fix
2. M2 Inline Finding Normalization for Audit Verify
3. M3 Repo-Label-Aware Proposal Location Resolution
4. M4 Language-Neutral IPC Trace Labels
5. M5 Audit Report Time Budget and Partial Result Contract
6. M6 Diff Impact Summary-First and Output Budgeting

## Tracking

Completed sequence. Keep this list as the execution record.

- M1 - Done - Owner: senior-local (sub-agent dispatch unavailable in current tool surface) - Validation: `npm test -- --run test/integration/audit-lifecycle-mcp.test.ts`; `npx tsc --noEmit --pretty false`
- M2 - Done - Owner: senior-local (sub-agent dispatch unavailable in current tool surface) - Validation: `npm test -- --run test/unit/audit-verify.test.ts`; `npx tsc --noEmit --pretty false`
- M3 - Done - Owner: senior-local (sub-agent dispatch unavailable in current tool surface) - Validation: `npm test -- --run test/unit/super/propose-location.test.ts`; `npx tsc --noEmit --pretty false`
- M4 - Done - Owner: senior-local (sub-agent dispatch unavailable in current tool surface) - Validation: `npm test -- --run test/unit/ipc-trace.test.ts test/unit/ipc-trace-impl.test.ts`; `npx tsc --noEmit --pretty false`
- M5 - Done - Owner: senior-local (sub-agent dispatch unavailable in current tool surface) - Validation: `npm test -- --run test/unit/audit-report-shape.test.ts`; `npx tsc --noEmit --pretty false`
- M6 - Done - Owner: senior-local (sub-agent dispatch unavailable in current tool surface) - Validation: `npm test -- --run test/unit/super/diff-impact.test.ts`; `npx tsc --noEmit --pretty false`

## Done Criteria

- `persist:false` audit sessions work without store-backed lock failures.
- inline `gn_audit_verify` no longer crashes on partial finding payloads.
- `gn_propose_location` resolves repo labels through the normal repo handle path.
- IPC trace labels are language-neutral and no longer default to JS for non-JS symbols.
- audit report runtime has an internal bounded partial-result contract without adding a second report subsystem.
- diff impact has a bounded summary-first response for large dirty worktrees, with cursoring deferred unless summary caps prove insufficient.
- focused tests pass for each touched workstream.

## Current Validation Snapshot

- OntoIndex repo status: `58dc127 -> 58dc127`, `up-to-date`.
- `detect-changes --repo ontoindex` currently reports `13 files`, `66 symbols`, `risk low`, `affected processes 0`.
- The current worktree still includes unrelated `AGENTS.md` and `CLAUDE.md` edits, so commit hygiene should split plan/code changes from instruction-file drift.
