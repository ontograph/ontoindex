# ADR 0097 Tracking

Status: Completed
Updated: 2026-06-19

## Dispatch Policy

Sub-agent model order from `AGENTS.md`: `gemini-3.5-flash-low`, `gemini-3-flash-agent`,
`gemini-pro-agent`, `claude-sonnet-4-6`, `gpt-5.3-codex-spark`, `gpt-5.4-mini`.

Current sub-agent surface exposes only `gpt-5.4-mini` from that ordered list, so workers are
dispatched with `gpt-5.4-mini`. If a model fails on 2026-06-19 UTC, it must not be retried until
2026-06-20 UTC.

## Tasks

| Task                                                            | Status    | Owner                     | Notes                                                                                                                                                                                                                   |
| --------------------------------------------------------------- | --------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T1: zvec mirror adapter and metadata freshness                  | Completed | Rawls + manager review    | Added mirror metadata/freshness helpers and focused tests; `zvec-mirror.test.ts` and `tsc --noEmit` passed.                                                                                                             |
| T2: semanticSearch backend routing and fallback circuit breaker | Completed | Kant + manager review     | Added opt-in zvec routing with LadybugDB fallback and circuit breaker; manager patched runtime open/index params; focused tests and `tsc --noEmit` passed. CRITICAL hot-path risk noted for `semanticSearch`.           |
| T3: diagnostics/status integration                              | Completed | Feynman + manager review  | Added opt-in vector backend status to `gn_diagnose` and retrieval diagnostics; focused tests and `tsc --noEmit` passed.                                                                                                 |
| T4: replay/benchmark gate and documentation cleanup             | Completed | Avicenna + manager review | Added optional vector-backend comparison to existing replay gate and updated ADR; focused replay tests and `tsc --noEmit` passed.                                                                                       |
| T5: manager verification, index refresh, and cleanup            | Completed | manager                   | Combined focused tests passed: 6 files, 74 tests. `tsc --noEmit` passed. CLI `detect-changes --repo ontoindex` passed with HIGH risk from `semanticSearch` execution-flow impact. Index refreshed after T3, T4, and T5. |
