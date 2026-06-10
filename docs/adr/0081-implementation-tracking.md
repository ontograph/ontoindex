# ADR 0081 Implementation Tracking

ADR: [0081-virtuoso-inspired-native-multi-model-virtual-views-and-anytime-queries.md](0081-virtuoso-inspired-native-multi-model-virtual-views-and-anytime-queries.md)

## Manager Rules

- Scope is pure core contracts only: no SQL/Cypher execution, no database connections, no network
  access, no MCP tools, no filesystem reads/writes, no wall-clock timers, no environment reads, no
  random values, and no LLM calls.
- Workers must use `gpt-5.3-codex-spark` when the sub-agent surface can enforce the model.
- Workers are not alone in the codebase: preserve existing local edits and do not revert unrelated
  files.
- Update this file before each dispatch and after each result review.
- Validate each task with focused tests, then run integrated checks after all tasks land.

## OntoIndex Check

- Local CLI status checked from `/opt/demodb/_workfolder/OntoIndex`.
- Index is up to date at commit `1b0e8ce`.
- ADR 0081 adds new pure modules, so impact analysis is not a reliable blocker for new symbols.
- If a worker edits an existing function/class/method, it must run local OntoIndex impact first or
  report why it could not.

## Tasks

| Task | Owner | Status | Scope | Validation |
|------|-------|--------|-------|------------|
| T1 virtual source mapping | sub-agent T1 (`019eb1f8-6106-7891-a778-d9b97b7c7d50`) | done | `ontoindex/src/core/search/virtual-source-mapping.ts`, `ontoindex/test/unit/virtual-source-mapping.test.ts` | focused vitest passed; TypeScript check passed |
| T2 anytime result envelope | sub-agent T2 (`019eb1f8-c25b-7043-89e1-3819e542942d`) | done | `ontoindex/src/core/runtime/anytime-result-envelope.ts`, `ontoindex/test/unit/anytime-result-envelope.test.ts` | focused vitest passed; TypeScript check passed |
| T3 integration review | manager | done | integrated diff, tests, ADR/index closeout | focused ADR 0081 vitest passed; `npx tsc --noEmit --pretty false` passed; `git diff --check` passed; OntoIndex detect-changes low risk |

## Progress Log

- 2026-06-10: Tracker created before sub-agent dispatch.
- 2026-06-10: Dispatched T1 virtual source mapping to worker `019eb1f8-6106-7891-a778-d9b97b7c7d50` (Poincare).
- 2026-06-10: Dispatched T2 anytime result envelope to worker `019eb1f8-c25b-7043-89e1-3819e542942d` (Avicenna).
- 2026-06-10: T1 completed with focused virtual source mapping tests and TypeScript check passing.
- 2026-06-10: T2 completed with focused anytime result envelope tests and TypeScript check passing.
- 2026-06-10: Starting manager integration review.
- 2026-06-10: Manager corrected explicit `unknown` exhausted-resource handling in the anytime
  envelope and added a focused regression test.
- 2026-06-10: Integrated ADR 0081 tests passed: 2 files, 18 tests. TypeScript check passed. Scoped
  `git diff --check` passed. OntoIndex `detect-changes --repo OntoIndex` reported low risk, though
  it sees the broader dirty ADR/release worktree.
- 2026-06-10: ADR 0081 status and ADR index updated to
  `Implemented (core virtual mapping and anytime envelope contracts)`.
