# ADR 0090 Tracking: Response Budgets and Task Context Packs

**Plan:** `docs/guides/adr-0090-pre-junior-project-plan.md`
**ADR:** `docs/adr/0090-context-mode-inspired-response-budget-and-session-context-packs.md`
**Started:** 2026-06-17
**Mode:** Manager executed directly; no sub-agent dispatch tool is available in this session.

## Tasks

| Task                                    | Status | Notes                                                                                                                                      |
| --------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| T1 Structured guard metadata            | Done   | Added `responseBudget` metadata while preserving `truncated`, `hint`, and `preview`; focused test and `tsc --noEmit` passed.               |
| T2 Dispatch preservation test           | Done   | Added test-only oversized dispatch regression; `responseBudget` survives `LocalBackend.callTool`; focused tests and `tsc --noEmit` passed. |
| T3 `gn_explore` task-pack               | Done   | Added opt-in `profile: "task-pack"`; default output unchanged; focused test and `tsc --noEmit` passed.                                     |
| T4 `gn_diagnose` response-budget health | Done   | Added shared oversized telemetry reader and `responseBudgetHealth`; telemetry/diagnose tests and `tsc --noEmit` passed.                    |
| T5 `mcp-doctor` response-budget health  | Done   | Rendered diagnose `responseBudgetHealth`; no duplicate telemetry parser; focused validation and `tsc --noEmit` passed.                     |

## Validation Log

- T1: `cd ontoindex && npx vitest run test/unit/response-guard.test.ts && npx tsc --noEmit` passed.
- T2: `cd ontoindex && npx vitest run test/unit/response-guard.test.ts test/unit/calltool-dispatch.test.ts && npx tsc --noEmit` passed.
- T3: `cd ontoindex && npx vitest run test/unit/super/explore.test.ts && npx tsc --noEmit` passed.
- T4: `cd ontoindex && npx vitest run test/unit/tool-telemetry.test.ts test/unit/super/diagnose.test.ts && npx tsc --noEmit` passed.
- T5: `cd ontoindex && npx vitest run test/unit/response-guard.test.ts test/unit/tool-telemetry.test.ts test/unit/super/explore.test.ts test/unit/super/diagnose.test.ts test/unit/mcp-doctor.test.ts test/unit/calltool-dispatch.test.ts && npx tsc --noEmit` passed.
- Formatting: Markdown files formatted; TypeScript Prettier failed with `getPlugin() requires astFormat to be set` in this checkout, so functional validation remains the blocker.
