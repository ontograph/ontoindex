# ADR 0065 Implementation Tracking

ADR: [0065-codexgraph-inspired-native-graph-query-and-subgraph-extraction.md](0065-codexgraph-inspired-native-graph-query-and-subgraph-extraction.md)

## Manager Rules

- Scope is core graph schema manifest and subgraph context packaging only: no MCP/CLI wrapper, no Cypher execution, no database access, no prompt injection, no query repair engine, no refactor invariant checks, no graph writes.
- Workers must use `gpt-5.3-codex-spark` when the sub-agent surface can enforce the model.
- Workers are not alone in the codebase: preserve existing local edits and do not revert unrelated files.
- Update this file before each dispatch and after each result review.
- Validate each task with focused tests, then run integrated checks after all tasks land.

## OntoIndex Check

- Local CLI status checked from `/opt/demodb/_workfolder/OntoIndex`.
- Index is up to date at commit `1b0e8ce`.
- MCP repo path lookup for `/opt/demodb/_workfolder/OntoIndex` failed; exposed MCP label `codex` returned `codex-rs/...` paths, so manager uses local OntoIndex CLI for this repo.
- Local graph query requires `--repo ontoindex` because multiple labels are indexed.
- Source search found existing raw Cypher CLI/MCP/backend paths and tests, but no `ontoindex/src/core/graph/subgraph-context.ts`.
- Because this work adds a new core module, impact analysis is not a blocker for new symbols.
- If a worker edits an existing function/class/method, it must run local OntoIndex impact first or report why it could not.
- Worktree hygiene: the repository already has many unrelated modified/untracked files from prior ADR work; workers must not clean, revert, or restage unrelated files.

## Tasks

| Task | Owner | Status | Scope | Validation |
| --- | --- | --- | --- | --- |
| T1 core module and focused tests | sub-agent T1 | done | `ontoindex/src/core/graph/subgraph-context.ts`, `ontoindex/test/unit/graph-subgraph-context.test.ts` | `npm test -- --run test/unit/graph-subgraph-context.test.ts`; `npx tsc --noEmit --pretty false` |
| T2 edge hardening and semantic-contract review | sub-agent T2 | done | `subgraph-context.ts`, `graph-subgraph-context.test.ts` only | focused unit suite; TypeScript check |
| T3 manager integration review | manager | done | integrated diff, tests, typecheck, tracker closeout, ADR status/index | focused tests, `npx tsc --noEmit`, `git diff --check`; local `ontoindex status` |

## Progress Log

- 2026-06-10: Tracker created before sub-agent dispatch.
- 2026-06-10: Dispatching T1 core module and focused tests to a worker.
- 2026-06-10: T1 completed with focused unit tests and TypeScript check passing; dispatching T2 edge hardening and semantic-contract review.
- 2026-06-10: T2 completed with focused tests and TypeScript check passing; manager integration review started.
- 2026-06-10: Integrated validation passed: focused graph-subgraph-context unit suite, TypeScript check, scoped `git diff --check`, ASCII check, core purity search, and local OntoIndex CLI status.
- 2026-06-10: ADR 0065 status and ADR index updated to `Implemented (core subgraph context packaging)`.
