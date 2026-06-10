# ADR 0016 Implementation Tracking

ADR: [0016-resource-lifecycle-graph-systems-auditor.md](0016-resource-lifecycle-graph-systems-auditor.md)

## Manager Rules

- Scope is core systems-audit coverage manifest only: no analyzer execution, no MCP/CLI wrapper, no graph schema, no registry mutation, no audit lifecycle status transition, no recommendation policy.
- Workers must use `gpt-5.3-codex-spark` when the sub-agent surface can enforce the model.
- Workers are not alone in the codebase: preserve existing local edits and do not revert unrelated files.
- Update this file before each dispatch and after each result review.
- Validate each task with focused tests, then run integrated checks after all tasks land.

## OntoIndex Check

- Local CLI status checked from `/opt/demodb/_workfolder/OntoIndex`.
- Index is up to date at commit `1b0e8ce`.
- Source search found existing systems-audit analyzers and tests, but no `coverage-manifest.ts` or `SystemsAuditCoverage` implementation.
- Because this work adds a new core module, impact analysis is not a blocker for new symbols.
- If a worker edits an existing function/class/method, it must run local OntoIndex impact first or report why it could not.

## Tasks

| Task | Owner | Status | Scope | Validation |
| --- | --- | --- | --- | --- |
| T1 core model and builder | sub-agent T1 | done | `ontoindex/src/core/systems-audit/coverage-manifest.ts`, builder-focused tests | `npm test -- --run test/unit/systems-coverage-manifest.test.ts`; `npx tsc --noEmit --pretty false` |
| T2 boundary/export coverage | sub-agent T2 | done | `coverage-manifest.ts`, `systems-audit/index.ts`, edge-case tests | `npm test -- --run test/unit/systems-coverage-manifest.test.ts`; `npx tsc --noEmit --pretty false` |
| T3 integration review | manager | done | integrated diff, tests, typecheck, tracker closeout, ADR status/index | focused tests, `npx tsc --noEmit`, `git diff --check`; local `ontoindex status` |

## Progress Log

- 2026-06-10: Tracker created before sub-agent dispatch.
- 2026-06-10: Dispatching T1 core model and builder to a worker before export/boundary coverage.
- 2026-06-10: T1 completed with focused unit tests and TypeScript check passing; dispatching T2 boundary/export coverage.
- 2026-06-10: T2 completed with focused unit tests and TypeScript check passing; manager integration review started.
- 2026-06-10: Integrated validation passed: focused coverage-manifest unit suite, TypeScript check, scoped `git diff --check`, ASCII check, core purity search, and local OntoIndex CLI status.
- 2026-06-10: ADR 0016 status and ADR index updated to `Implemented (core coverage manifest)`.
