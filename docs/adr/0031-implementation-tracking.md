# ADR 0031 Implementation Tracking

ADR: [0031-graphify-inspired-evidence-diagnostics-for-existing-review-surfaces.md](0031-graphify-inspired-evidence-diagnostics-for-existing-review-surfaces.md)

## Manager Rules

- Scope is core evidence diagnostic surface profiles only: no CLI/report/docs/MCP output changes, no new diagnostic record type, no graph traversal, no registry mutation, no recommendations, no audit lifecycle status transition.
- Workers must use `gpt-5.3-codex-spark` when the sub-agent surface can enforce the model.
- Workers are not alone in the codebase: preserve existing local edits and do not revert unrelated files.
- Update this file before each dispatch and after each result review.
- Validate each task with focused tests, then run integrated checks after all tasks land.

## OntoIndex Check

- Local CLI status checked from `/opt/demodb/_workfolder/OntoIndex`.
- Index is up to date at commit `1b0e8ce`.
- Source search found existing evidence diagnostics, semantic contracts, and review-bundle diagnostics, but no `evidence-diagnostic-profiles.ts` or `evaluateEvidenceDiagnosticProfile` implementation.
- Because this work adds a new core module, impact analysis is not a blocker for new symbols.
- If a worker edits an existing function/class/method, it must run local OntoIndex impact first or report why it could not.

## Tasks

| Task | Owner | Status | Scope | Validation |
| --- | --- | --- | --- | --- |
| T1 core profile model and evaluator | sub-agent T1 | done | `ontoindex/src/core/runtime/evidence-diagnostic-profiles.ts`, profile-focused tests | `npm test -- --run test/unit/evidence-diagnostic-profiles.test.ts`; `npx tsc --noEmit --pretty false` |
| T2 boundary/export coverage | sub-agent T2 | done | `evidence-diagnostic-profiles.ts`, edge-case tests; no runtime barrel exists | `npm test -- --run test/unit/evidence-diagnostic-profiles.test.ts`; `npx tsc --noEmit --pretty false` |
| T3 integration review | manager | done | integrated diff, tests, typecheck, tracker closeout, ADR status/index | focused tests, `npx tsc --noEmit`, `git diff --check`; local `ontoindex status` |

## Progress Log

- 2026-06-10: Tracker created before sub-agent dispatch.
- 2026-06-10: Dispatching T1 core profile model and evaluator before boundary/export coverage.
- 2026-06-10: T1 completed with focused unit tests and TypeScript check passing; dispatching T2 boundary coverage.
- 2026-06-10: T2 completed with focused unit tests and TypeScript check passing; manager integration review started.
- 2026-06-10: Integrated validation passed: focused profile unit suite, TypeScript check, scoped `git diff --check`, ASCII check, core purity search, and local OntoIndex CLI status.
- 2026-06-10: ADR 0031 status and ADR index updated to `Implemented (core diagnostic profiles)`.
