# ADR 0021 Implementation Tracking

ADR: [0021-serena-inspired-agent-interface.md](0021-serena-inspired-agent-interface.md)

## Manager Rules

- Scope is core symbol-first agent workflow plan contract only: no MCP imports, no graph/Kuzu access, no LSP calls, no file reads, no sidecar, no LLM calls, no audit lifecycle schema changes, no dynamic tool exposure, no dependency additions.
- Workers must use `gpt-5.3-codex-spark` when the sub-agent surface can enforce the model.
- Workers are not alone in the codebase: preserve existing local edits and do not revert unrelated files.
- Update this file before each dispatch and after each result review.
- Validate each task with focused tests, then run integrated checks after all tasks land.

## OntoIndex Check

- Local CLI status checked from `/opt/demodb/_workfolder/OntoIndex`.
- Index is up to date at commit `1b0e8ce`.
- Source search found existing MCP mode registry/help and `gn_safe_edit_check` adapter surfaces.
- Source search found no existing `ontoindex/src/core/agent-workflow/`, `symbol-first-plan.ts`, or `buildSymbolFirstWorkflowPlan`.
- Because this work adds a new core module, impact analysis is not a blocker for new symbols.
- If a worker edits an existing function/class/method, it must run local OntoIndex impact first or report why it could not.
- Manager-side MCP search could not target this repo because the live MCP service exposed only repo label `codex`; local CLI status and workspace source search were used for this repo.

## Tasks

| Task | Owner | Status | Scope | Validation |
| --- | --- | --- | --- | --- |
| T1 core module and focused tests | sub-agent T1 | done | `ontoindex/src/core/agent-workflow/symbol-first-plan.ts`, `ontoindex/test/unit/symbol-first-workflow-plan.test.ts` | `npm test -- --run test/unit/symbol-first-workflow-plan.test.ts`; `npx tsc --noEmit --pretty false` |
| T2 integration review and hardening | sub-agent T2 | done | implementation diff, forbidden dependency checks, ADR/index status | focused test suite; `npx tsc --noEmit --pretty false`; `git diff --check`; local `ontoindex status` |
| T3 manager integration closeout | manager | done | final validation, ADR status/index, tracker closeout | focused test suite; `npx tsc --noEmit --pretty false`; `git diff --check`; local `ontoindex status` |

## Progress Log

- 2026-06-10: Tracker created before sub-agent dispatch.
- 2026-06-10: Dispatching T1 core module and focused tests to a worker.
- 2026-06-10: T1 completed with focused unit tests and TypeScript check passing; dispatching T2 integration review and hardening.
- 2026-06-10: T2 completed with focused unit tests, TypeScript check, and scoped diff check passing; manager hardening started for missing coverage normalization.
- 2026-06-10: Manager hardened missing coverage normalization to `UNKNOWN` while preserving weak-coverage safety behavior.
- 2026-06-10: Integrated validation passed: focused symbol-first workflow plan unit suite, TypeScript check, scoped `git diff --check`, forbidden dependency search, and local OntoIndex CLI status.
- 2026-06-10: ADR 0021 status and ADR index updated to `Implemented (core workflow plan contract)`.
