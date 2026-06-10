# ADR 0082 Implementation Tracking

ADR: [0082-semantic-ann-neighbor-graph-and-one-shot-retrieval-frontier.md](0082-semantic-ann-neighbor-graph-and-one-shot-retrieval-frontier.md)

## Manager Rules

- Scope is the remaining ADR 0082 gap: production opt-in ANN edge materialization, validation, and status/docs alignment.
- Keep `ANN_NEIGHBOR` retrieval-only: no impact/dependency/audit traversal inclusion and no default-on behavior.
- Sub-agents should use `gpt-5.3-codex-spark` when the sub-agent surface can enforce the model.
- Workers are not alone in the codebase: preserve existing local edits and do not revert unrelated files.
- Update this file before each dispatch and after each result review.
- Validate each task with focused tests, then run integrated checks after all tasks land.

## OntoIndex Check

- Local CLI status checked from `/opt/demodb/_workfolder/OntoIndex`.
- Index is stale: indexed commit `1b0e8ce`, current commit `21bc6b0`.
- Source review confirmed ADR 0082 core primitives already exist:
  - `ontoindex/src/core/embeddings/ann-neighbor.ts`
  - `ontoindex/src/core/embeddings/ann-neighbor-store.ts`
  - `ontoindex/src/core/search/semantic-frontier-search.ts`
  - `ontoindex/src/core/search/semantic-frontier-adapter.ts`
  - opt-in `retrieval_policy: "symbol-neighborhood"` path in backend search
  - `npm run bench:semantic-ann`
- Remaining gap: ANN edge builder/persist functions are not wired into production analyze/indexing; status/docs are inconsistent about whether ADR 0082 is fully implemented.

## Tasks

| Task | Owner | Status | Scope | Validation |
| --- | --- | --- | --- | --- |
| T1 opt-in analyze materialization | sub-agent T1-redo | done; manager reviewed | wire ANN edge materialization into analyze/indexing behind explicit opt-in only; focused tests | worker ran focused ADR 0082 suite, run-analyze snapshot test, and typecheck |
| T2 status/docs and benchmark gate review | sub-agent T2 | done; manager reviewed | ADR/index/docs/release status alignment; verify benchmark docs and non-default behavior | `git diff --check`; grep sanity for benchmark command, materialization call sites, and ADR status |
| T3 manager integration review | manager | done | integrate worker changes, rerun ADR 0082 suites, typecheck/build, update tracker | focused tests passed; typecheck passed; build passed; MCP diff verification blocked by wrong indexed repo label |

## Progress Log

- 2026-06-10: Tracker created before sub-agent dispatch.
- 2026-06-10: Focused ADR 0082 validation passed before remaining work dispatch: `6` test files, `54` tests.
- 2026-06-10: Dispatching T1 and T2 with disjoint primary write scopes.
- 2026-06-10: T2 completed and manager reviewed docs/status diff. ADR 0082 and ADR index now state that opt-in core primitives are implemented while analyze-time materialization is pending.
- 2026-06-10: T2 caveat for manager follow-up: root and package changelog wording may overstate ADR 0082 as fully accepted if T1 does not finish materialization.
- 2026-06-10: T1 failed with a sub-agent runtime stream disconnect before completion. Partial local diff only touched `ontoindex/src/cli/index.ts` by adding `--ann-neighbors`; no analyze materialization or tests were delivered.
- 2026-06-10: Dispatched T1-redo as sub-agent `019eb269-9412-72e2-b1f7-79e7b2b26963`.
- 2026-06-10: T1-redo completed production opt-in materialization: CLI `--ann-neighbors`, analyze option propagation, embedding-row loading, ANN edge build/persist, and focused tests.
- 2026-06-10: Manager review accepted T1-redo with minor fixes: CLI chain indentation, clearer error text, and ADR status update from pending to implemented.
- 2026-06-10: OntoIndex MCP contract check passed, but this MCP process is serving repo label `codex`; direct `runFullAnalysis` impact against `OntoIndex` could not run in MCP (`Repository "OntoIndex" not found`). Manager used local source review for this integration pass.
- 2026-06-10: Manager validation passed: focused ADR 0082/run-analyze tests (`7` files, `71` tests), `npx tsc --noEmit --pretty false`, `git diff --check`, and `npm run build`.
- 2026-06-10: `gn_verify_diff` was attempted but failed non-authoritatively because MCP scanned the `codex` repo instead of `/opt/demodb/_workfolder/OntoIndex`; do not use that result for this diff.
- 2026-06-10: Changelogs updated to record `ontoindex analyze --ann-neighbors` analyze-time materialization.
- 2026-06-10: Final diff hygiene passed with `git diff --check`.
