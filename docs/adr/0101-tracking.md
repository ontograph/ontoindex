# ADR 0101 Tracking

Status: done
Date: 2026-06-21

## Task Ledger

| Task                                              | Status | Notes                                                                                                                                                              |
| ------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| T1 ADR challenge                                  | Done   | ADR narrowed to extending `gn_test_gap` / `gn_test_suggestions`; no `gn_test_finder`.                                                                              |
| T2 `gn_test_gap` target mode                      | Done   | Added target mode for `symbol`, `filePath`, `query`; focused unit test passes.                                                                                     |
| T3 shared test evidence helpers                   | Done   | Added bounded heuristic test discovery and package test-command inference.                                                                                         |
| T4 `gn_test_suggestions` missing-test guard       | Done   | Worker patch reviewed; reuses targeted tests instead of inferring a new file.                                                                                      |
| T5 docs, snapshots, and tests                     | Done   | Tool schema/docs updated; focused unit/integration tests and typecheck pass.                                                                                       |
| T6 validation and index refresh                   | Done   | Focused tests, typecheck, snapshot, formatting, and index refresh passed; detect-changes remains critical due broader dirty worktree.                              |
| T7 graph-backed target resolution                 | Done   | Target mode now resolves symbol/file/query targets to graph records before linked-test collection.                                                                 |
| T8 query-mode contract                            | Done   | Query mode uses existing semantic search when available and ADR now states heuristic fallback.                                                                     |
| T9 `gn_test_gap` to `gn_test_suggestions` handoff | Done   | Accepts top-level target report shape and nested legacy object shape.                                                                                              |
| T10 graph/handoff tests and final validation      | Done   | Snapshot refresh, focused tests, typecheck, formatting, index refresh, and schema contract fix passed; detect-changes remains critical due broader dirty worktree. |
| T11 scope-leak challenge                          | Done   | `format: "files"` / read-first contract changes are ADR 0100-owned; ADR 0101 now records its narrower ownership.                                                   |
| T12 query fallback test                           | Done   | Worker added the focused semantic-search-unavailable fallback test; no implementation change was needed.                                                           |
| T13 close tracking status                         | Done   | Final focused validation passed; ADR 0101 tracking is closed.                                                                                                      |
| T14 ADR status sync                               | Done   | Align ADR 0101 status with completed tracking status.                                                                                                              |
| T15 unknown fallback contract sync                | Done   | Update ADR next-tools text to match implementation for `unknown` query fallback.                                                                                   |
| T16 final docs validation                         | Done   | Formatting, focused tests, typecheck, and OntoIndex index refresh passed; detect-changes remains critical due broader dirty worktree.                              |

## Dispatch Log

- 2026-06-21: Started implementation loop. Model policy: requested sub-agent order includes unavailable models; available override from requested set is `gpt-5.4-mini`.
- 2026-06-21: T2/T3 dispatched to `019eead5-4e2f-7a32-a1cf-a7249388605b`; T4 dispatched to `019eead5-7ec4-7c40-bfaf-25bc6ffdf63d`.
- 2026-06-21: T2/T3 implemented locally after worker overlap; `npm test -- --run test/unit/audit-dispatch.test.ts` passed.
- 2026-06-21: T4/T5 validated with `npm test -- --run test/integration/systems-audit-mcp.test.ts`, `npm test -- --run test/unit/audit-dispatch.test.ts`, and `npx tsc --noEmit --pretty false`.
- 2026-06-21: Tool contract snapshot refreshed with `UPDATE_SNAPSHOTS=1 npm test -- --run test/unit/tool-contract-schema.test.ts`, then passed without update mode.
- 2026-06-21: Final `analyze` reported already up to date. Final `detect-changes --repo ontoindex` reported critical because the pre-existing dirty worktree spans 52 files and 389 symbols.
- 2026-06-21: Reopened after senior challenge. Remaining gaps: graph-backed target IDs, query-mode contract, and direct target-report handoff.
- 2026-06-21: T7/T8 implemented; `npm test -- --run test/unit/super/test-gap-target.test.ts` passed.
- 2026-06-21: T9 validated; `npm test -- --run test/integration/systems-audit-mcp.test.ts` passed.
- 2026-06-21: T10 final validation passed: `UPDATE_SNAPSHOTS=1 npm test -- --run test/unit/tool-contract-schema.test.ts`; `npm test -- --run test/unit/tool-contract-schema.test.ts`; `npm test -- --run test/unit/super/test-gap-target.test.ts test/unit/audit-dispatch.test.ts test/integration/systems-audit-mcp.test.ts test/unit/tools.test.ts test/unit/super/help.test.ts`; `npx tsc --noEmit --pretty false`.
- 2026-06-21: Senior challenge found the handoff schema advertised `targetedCoverage` as object-only while the implementation accepts the real target-report status string. Fixed MCP tool schema typing and reran focused tests/typecheck.
- 2026-06-21: Final index refresh with `ONTOINDEX_MAX_WORKERS=7 node /home/evrasyuk/_workfolder/OntoIndex/ontoindex/dist/cli/index.js analyze` reported already up to date. `detect-changes --repo ontoindex` remains critical because the pre-existing dirty worktree spans 52 files and 393 symbols.
- 2026-06-21: Senior follow-up opened T11-T13 before new work. Scope challenge found `format: "files"` / read-first contract changes belong to ADR 0100 (`docs/adr/0100-*.md`), not ADR 0101; do not revert them as part of 0101.
- 2026-06-21: T11 closed by adding ADR 0101 follow-up challenge resolution: ADR 0101 owns only test-gap target evidence, test-suggestions handoff, their schema, and their tests.
- 2026-06-21: T12 dispatched to worker `019eeaf3-e2ca-78e3-b249-6f0080fae21c` on available requested model `gpt-5.4-mini`; worker added the query fallback test and reported `npm test -- --run test/unit/super/test-gap-target.test.ts` passed.
- 2026-06-21: T13 closed after final validation: `npm test -- --run test/unit/super/test-gap-target.test.ts test/integration/systems-audit-mcp.test.ts test/unit/tool-contract-schema.test.ts`; `npx tsc --noEmit --pretty false`.
- 2026-06-21: Senior follow-up opened T14-T16 before new work. Requested worker model order was `gemini-pro-agent`, `gpt-5.3-codex-spark`, `gpt-5.4-mini`; available requested override is `gpt-5.4-mini`.
- 2026-06-21: T14/T15 dispatched to worker `019eeafb-39ab-70f0-9b7f-6cda78ffcb42` on available requested model `gpt-5.4-mini`; worker updated ADR status and `unknown` next-tools contract text, then ran Prettier.
- 2026-06-21: T16 closed after final validation: `npm test -- --run test/unit/super/test-gap-target.test.ts test/integration/systems-audit-mcp.test.ts test/unit/tool-contract-schema.test.ts`; `npx tsc --noEmit --pretty false`; `ONTOINDEX_MAX_WORKERS=7 node /home/evrasyuk/_workfolder/OntoIndex/ontoindex/dist/cli/index.js analyze`. Final `detect-changes --repo ontoindex` remains critical because the broader dirty checkout spans 52 files and 393 symbols.
