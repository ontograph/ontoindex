# ADR 0089 Tracking: Indexing Lifecycle and File-Scope Explainability

**Plan:** `docs/guides/adr-0089-pre-junior-project-plan.md`
**ADR:** `docs/adr/0089-claude-context-inspired-indexing-lifecycle-and-file-scope-explainability.md`
**Started:** 2026-06-17
**Mode:** Manager executed directly; no sub-agent tool is available in this session.

## Tasks

| Task                                   | Status | Notes                                                                                                          |
| -------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------- |
| T1 Path scope explanation helper       | Done   | Added `explainPathScope`; `ignore-service.test.ts` and `tsc --noEmit` passed.                                  |
| T2 File scope preview collector        | Done   | Added `file-scope-preview.ts`; focused preview/ignore tests and `tsc --noEmit` passed.                         |
| T3 CLI dry-run/explain-file modes      | Done   | Added `analyze --dry-run` and `--explain-file`; CLI focused tests and `tsc --noEmit` passed.                   |
| T4 Runtime health in `gn_ensure_fresh` | Done   | Added runtime-health guard for untrusted/failed autoAnalyze; focused tests and `tsc --noEmit` passed.          |
| T5 Bounded file scope in `gn_diagnose` | Done   | Added opt-in preview/explain fields; focused tests and `tsc --noEmit` passed.                                  |
| T6 CLI status runtime-health honesty   | Done   | Moved runtime-health output ahead of freshness status; focused status/runtime tests and `tsc --noEmit` passed. |

## Validation Log

- T1: `cd ontoindex && npx vitest run test/unit/ignore-service.test.ts && npx tsc --noEmit` passed.
- T2: `cd ontoindex && npx vitest run test/unit/file-scope-preview.test.ts test/unit/ignore-service.test.ts && npx tsc --noEmit` passed.
- T3: `cd ontoindex && npx vitest run test/unit/cli-index-help.test.ts test/unit/file-scope-preview.test.ts test/unit/ignore-service.test.ts && npx tsc --noEmit` passed.
- T4: `cd ontoindex && npx vitest run test/unit/super/ensure-fresh.test.ts && npx tsc --noEmit` passed.
- T5: `cd ontoindex && npx vitest run test/unit/super/diagnose.test.ts test/unit/super/ensure-fresh.test.ts test/unit/file-scope-preview.test.ts && npx tsc --noEmit` passed.
- T6: `cd ontoindex && npx vitest run test/unit/status.test.ts test/unit/super/diagnose.test.ts test/unit/super/ensure-fresh.test.ts test/unit/cli-index-help.test.ts test/unit/file-scope-preview.test.ts test/unit/ignore-service.test.ts && npx tsc --noEmit` passed.
