# ADR 0079 Implementation Tracking

ADR: [0079-smart-composer-inspired-native-interactive-context-staging-and-hunk-editing.md](0079-smart-composer-inspired-native-interactive-context-staging-and-hunk-editing.md)

## Manager Rules

- Scope is pure core workspace contracts only: no UI, no MCP tools, no LLM calls, no recipe system,
  no patch application, no filesystem writes, no git commands, no database access.
- Workers must use `gpt-5.3-codex-spark` when the sub-agent surface can enforce the model.
- Workers are not alone in the codebase: preserve existing local edits and do not revert unrelated
  files.
- Update this file before each dispatch and after each result review.
- Validate each task with focused tests, then run integrated checks after all tasks land.

## OntoIndex Check

- Local CLI status checked from `/opt/demodb/_workfolder/OntoIndex`.
- Index is up to date at commit `1b0e8ce`.
- ADR 0079 adds new core modules under `ontoindex/src/core/workspace/`, so impact analysis is not a
  reliable blocker for new symbols.
- If a worker edits an existing function/class/method, it must run local OntoIndex impact first or
  report why it could not.

## Tasks

| Task | Owner | Status | Scope | Validation |
|------|-------|--------|-------|------------|
| T1 staged context | sub-agent T1 (`019eb1bc-cde0-7523-a9b7-938df51ac648`) | done | `ontoindex/src/core/workspace/context-staging.ts`, `ontoindex/test/unit/workspace-context-staging.test.ts` | focused vitest passed; T1 typecheck initially blocked by T2 in-progress file |
| T2 mention resolution | sub-agent T2 (`019eb1bd-280b-7991-ae91-129fd1180ef8`) | done | `ontoindex/src/core/workspace/mention-resolution.ts`, `ontoindex/test/unit/workspace-mention-resolution.test.ts` | focused vitest passed; TypeScript check passed |
| T3 virtual diff selection | sub-agent T3 (`019eb1bd-8251-7b62-84e6-b51b37266a9a`) | done | `ontoindex/src/core/workspace/virtual-diff-selection.ts`, `ontoindex/test/unit/workspace-virtual-diff-selection.test.ts` | focused vitest passed; TypeScript check passed |
| T4 integration review | manager | done | integrated diff, tests, ADR/index closeout | focused workspace vitest passed; `npx tsc --noEmit --pretty false` passed; `git diff --check` passed |

## Progress Log

- 2026-06-10: Tracker created before sub-agent dispatch.
- 2026-06-10: Dispatched T1 staged context to worker `019eb1bc-cde0-7523-a9b7-938df51ac648` (Pauli).
- 2026-06-10: Dispatched T2 mention resolution to worker `019eb1bd-280b-7991-ae91-129fd1180ef8` (Bohr).
- 2026-06-10: Dispatched T3 virtual diff selection to worker `019eb1bd-8251-7b62-84e6-b51b37266a9a` (Pascal).
- 2026-06-10: T1, T2, and T3 completed. Starting manager integration review.
- 2026-06-10: Manager tightened virtual diff object path diagnostics, ran integrated workspace tests
  (3 files, 24 tests), TypeScript check, and scoped `git diff --check`; all passed.
- 2026-06-10: ADR 0079 status and ADR index updated to `Implemented (core workspace contracts)`.
