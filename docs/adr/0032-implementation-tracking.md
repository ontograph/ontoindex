# ADR 0032 Implementation Tracking

ADR: [0032-understand-anything-inspired-guided-architecture-tours.md](0032-understand-anything-inspired-guided-architecture-tours.md)

## Manager Rules

- Scope is core architecture-tour composition only: no CLI command, no review-bundle artifact, no MCP attachment, no graph query layer.
- Workers must use `gpt-5.3-codex-spark` when the sub-agent surface can enforce the model.
- Workers are not alone in the codebase: preserve existing local edits and do not revert unrelated files.
- Update this file before each dispatch and after each result review.
- Validate each task with focused tests, then run integrated checks after all tasks land.

## OntoIndex Check

- Local CLI status checked from `/opt/demodb/_workfolder/OntoIndex`.
- Index is stale: indexed commit `e3b70fc`, current commit `1b0e8ce`.
- OntoIndex query found existing report/export/review/docs surfaces and existing diagnostic/semantic-contract utilities, but no existing architecture-tour core module.
- Because this work adds a new core module, stale impact analysis is not a blocker for new symbols.
- If a worker edits an existing function/class/method, it must run local OntoIndex impact first or report why it could not.

## Tasks

| Task | Owner | Status | Scope | Validation |
|------|-------|--------|-------|------------|
| T1 core model and builder | sub-agent T1 | done | `ontoindex/src/core/runtime/architecture-tour.ts`, builder-focused tests | `npm test -- --run test/unit/architecture-tour.test.ts`; `npx tsc --noEmit --pretty false` |
| T2 renderer and semantic-contract coverage | sub-agent T2 | done | `architecture-tour.ts`, renderer/diagnostic tests | `npm test -- --run test/unit/architecture-tour.test.ts`; `npx tsc --noEmit --pretty false` |
| T3 integration review | manager | done | integrated diff, tests, typecheck, tracker closeout | focused architecture-tour vitest passed; `npx tsc --noEmit --pretty false` passed; `git diff --check` passed |

## Progress Log

- 2026-06-10: Tracker created before sub-agent dispatch.
- 2026-06-10: Dispatching T1 core model and builder to a worker before renderer work.
- 2026-06-10: T1 completed with focused unit tests and TypeScript check passing; dispatching T2 renderer and semantic-contract coverage.
- 2026-06-10: T2 completed with focused unit tests and TypeScript check passing. Manager normalized new TypeScript formatting to ASCII and started integrated validation.
- 2026-06-10: Integrated validation passed: `npm test -- --run test/unit/architecture-tour.test.ts` passed 9 tests, `npx tsc --noEmit --pretty false` passed, and scoped `git diff --check` passed.
- 2026-06-10: ADR 0032 status and ADR index updated to `Implemented (core composition)`. OntoIndex `detect-changes --repo OntoIndex` reported low risk for tracked changes; the local index is stale and new untracked files are not fully represented in that graph report.
