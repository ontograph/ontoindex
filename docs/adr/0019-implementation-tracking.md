# ADR 0019 Implementation Tracking

ADR: [0019-real-query-replay-gates.md](0019-real-query-replay-gates.md)

## Manager Rules

- Scope is core retrieval replay only: no MCP capture, no HTTP replay, no query-log export, no CI gate.
- Workers must use `gpt-5.3-codex-spark` when the sub-agent surface can enforce the model.
- Workers are not alone in the codebase: preserve existing local edits and do not revert unrelated files.
- Update this file before each dispatch and after each result review.
- Validate each task with focused tests, then run integrated checks after all tasks land.

## OntoIndex Check

- Local CLI status checked from `/opt/demodb/_workfolder/OntoIndex`.
- Index is stale: indexed commit `e3b70fc`, current commit `1b0e8ce`.
- Because the work adds new replay modules, impact analysis is not a reliable blocker for new symbols.
- If a worker edits an existing function/class/method, it must run local OntoIndex impact first or report why it could not.

## Tasks

| Task | Owner | Status | Scope | Validation |
|------|-------|--------|-------|------------|
| T1 schema and identity | sub-agent T1 | done | `ontoindex/src/core/search/replay/replay-case.ts`, `result-identity.ts`, related unit tests | `npx vitest run test/unit/retrieval-replay-case.test.ts test/unit/retrieval-replay-identity.test.ts`; `npx tsc --noEmit --pretty false` |
| T2 runner metrics gate | sub-agent T2 | done | `ontoindex/src/core/search/replay/replay-runner.ts`, `replay-metrics.ts`, `replay-gate.ts`, related unit tests | focused vitest; `npx tsc --noEmit --pretty false` |
| T3 fixtures and exports | sub-agent T3 | done | `ontoindex/test/fixtures/retrieval-replay/`, fixture validation tests, replay barrel export | focused fixture/T1 vitest |
| T4 integration review | manager | done | integrated diff, tests, typecheck, tracker closeout | focused replay vitest passed; `npx tsc --noEmit --pretty false` passed; `git diff --check` passed |

## Progress Log

- 2026-06-10: Tracker created before sub-agent dispatch.
- 2026-06-10: Dispatching T1 schema and identity to a worker before starting dependent tasks.
- 2026-06-10: T1 completed with focused vitest and TypeScript check passing; dispatching T2 runner, metrics, and gate.
- 2026-06-10: Dispatching T3 fixtures and exports in parallel with T2 using a disjoint write scope.
- 2026-06-10: T2 and T3 completed. Manager added T2 barrel exports and started integrated validation.
- 2026-06-10: Integrated replay suite passed: 6 test files, 31 tests. TypeScript check passed. `git diff --check` passed. OntoIndex `detect-changes --repo OntoIndex` reported low risk for tracked changes; new replay files are untracked and not included in that graph report.
- 2026-06-10: Untracked replay files checked for trailing whitespace. ADR 0019 implementation tasks are complete.
