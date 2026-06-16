# ADR 0086 Tracking

**ADR:** [0086-codegraph-inspired-agent-runtime-freshness-and-budget-controls.md](0086-codegraph-inspired-agent-runtime-freshness-and-budget-controls.md)
**Started:** 2026-06-16
**Manager:** current Codex session

## Scope Guard

- Extend current OntoIndex core paths only.
- No SQLite replacement.
- No file watcher service.
- No new daemon command family.
- No copied CodeGraph MCP frontier.
- Use existing analyze/status, MCP response envelope, `mcp-doctor`, setup, and target-context paths.

## Tasks

| Task                                                        | Owner        | Status         | Write Scope                                                            | Validation            |
| ----------------------------------------------------------- | ------------ | -------------- | ---------------------------------------------------------------------- | --------------------- |
| T1 runtime health contract and status integration           | sub-agent T1 | completed | `ontoindex/src/core/**`, `ontoindex/src/cli/**`, unit tests            | targeted tests, build |
| T2 MCP response budget and recoverable envelope integration | sub-agent T2 | completed | `ontoindex/src/mcp/**`, `ontoindex/src/core/review/**`, unit tests     | targeted tests, build |
| T3 doctor/setup client validation and liveness diagnostics  | sub-agent T3 | completed | `ontoindex/src/cli/mcp-doctor.ts`, setup-related CLI files, unit tests | targeted tests, build |
| T4 runtime health in MCP response metadata                  | sub-agent T4 | completed | `ontoindex/src/mcp/shared/**`, focused unit tests                      | targeted tests, build |
| T5 general recoverable runtime envelopes                    | sub-agent T5 | completed | `ontoindex/src/mcp/shared/**`, targeted MCP/super tests                | targeted tests, build |
| T6 setup-side client validation                             | sub-agent T6 | completed | `ontoindex/src/cli/setup.ts`, setup tests                              | targeted tests, build |

## Log

- 2026-06-16: Tracking file created before dispatch.
- 2026-06-16: T1 marked in progress before dispatch.
- 2026-06-16: T2 marked in progress before dispatch.
- 2026-06-16: T3 marked in progress before dispatch.
- 2026-06-16: All sub-agents completed; manager review started.
- 2026-06-16: Manager verification passed focused tests and build; OntoIndex index refreshed.
- 2026-06-16: Follow-up review found ADR 0086 partially implemented; T4-T6 added.
- 2026-06-16: T4 marked in progress before dispatch.
- 2026-06-16: T4 completed, tested, built, and indexed.
- 2026-06-16: T5 marked in progress before dispatch.
- 2026-06-16: T5 completed, tested, built, and indexed.
- 2026-06-16: T6 marked in progress before dispatch.
- 2026-06-16: T6 completed and setup tests passed.
- 2026-06-16: Final focused ADR 0086 suite passed, build passed, diff whitespace check passed.
