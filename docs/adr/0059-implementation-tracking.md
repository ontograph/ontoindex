# ADR 0059 Implementation Tracking

ADR: [0059-deep-reasoning-inspired-native-discovery-hypothesis-and-evidence-to-logic-mapping.md](0059-deep-reasoning-inspired-native-discovery-hypothesis-and-evidence-to-logic-mapping.md)

## Manager Rules

- Scope is core hypothesis grounding and evidence gap mapping only: no graph schema, no MCP/CLI wrapper, no retrieval retry, no audit status transition, no recommendation policy.
- Workers must use `gpt-5.3-codex-spark` when the sub-agent surface can enforce the model.
- Workers are not alone in the codebase: preserve existing local edits and do not revert unrelated files.
- Update this file before each dispatch and after each result review.
- Validate each task with focused tests, then run integrated checks after all tasks land.

## OntoIndex Check

- Local CLI status checked from `/opt/demodb/_workfolder/OntoIndex`.
- Index is up to date at commit `1b0e8ce`.
- OntoIndex query found existing semantic-contract, evidence-diagnostic, recommendation, audit-verifier, and architecture-tour surfaces, but no existing hypothesis-grounding core module.
- Because this work adds a new core module, impact analysis is not a blocker for new symbols.
- If a worker edits an existing function/class/method, it must run local OntoIndex impact first or report why it could not.
- Manager-side MCP `gn_verify_diff` could not target this repo because the live MCP service exposed only repo label `codex`; local CLI status was used for this repo instead.

## Tasks

| Task | Owner | Status | Scope | Validation |
|------|-------|--------|-------|------------|
| T1 core model and report builder | sub-agent T1 | done | `ontoindex/src/core/reasoning/hypothesis-grounding.ts`, model/builder tests | `npm test -- --run test/unit/hypothesis-grounding.test.ts`; `npx tsc --noEmit --pretty false` |
| T2 semantic-contract and boundary coverage | sub-agent T2 | done | `hypothesis-grounding.ts`, gap/diagnostic tests | `npm test -- --run test/unit/hypothesis-grounding.test.ts`; `npx tsc --noEmit --pretty false` |
| T3 integration review | manager | done | integrated diff, tests, typecheck, tracker closeout, ADR status/index | focused tests, `npx tsc --noEmit`, `git diff --check`; local `ontoindex status` |

## Progress Log

- 2026-06-10: Tracker created before sub-agent dispatch.
- 2026-06-10: Dispatching T1 core model and report builder to a worker before semantic-boundary coverage.
- 2026-06-10: T1 completed with focused tests and TypeScript check passing; dispatching T2 semantic-contract and boundary coverage.
- 2026-06-10: T2 completed with focused tests and TypeScript check passing; manager validation confirmed no forbidden runtime dependencies or recommendation/audit lifecycle leakage in the core module.
- 2026-06-10: Integrated validation passed: focused unit suite, TypeScript check, scoped `git diff --check`, and local OntoIndex CLI status.
