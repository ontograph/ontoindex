# ADR 0094 Tracking

**ADR:** [0094 AgentMemory-Inspired Runtime Context And Agent Setup Diagnostics](./0094-agentmemory-inspired-runtime-context-and-agent-setup-diagnostics.md)
**Manager:** Codex
**Started:** 2026-06-17

## Tasks

| Task | Status | Owner | Notes |
| --- | --- | --- | --- |
| T1 runtime context summary in `gn_diagnose` | done | manager | Added compact summary from existing target/freshness data only |
| T2 tool telemetry summary in `gn_diagnose` | done | worker `019ed746-db00-7ce0-b78e-6425b0d37c6b` | Reused existing oversized-tool telemetry; focused tests passed |
| T3 embedding repair guidance | done | manager | Fresh graph + absent embeddings now recommends `analyze --force --embeddings` |
| T4 setup doctor stale path and skill checks | done | worker `019ed746-f4e5-77d1-ad26-d0fcb0dca6b7` | Extended `mcp-doctor`; focused test and typecheck passed |
| T5 tests and validation | done | manager | `diagnose`, `tool-telemetry`, `mcp-doctor` tests and `tsc --noEmit` passed |

## Rules

- No new memory server, DB, or MCP tool family.
- No background auto-indexing.
- Refresh OntoIndex index after each completed implementation slice.
- Keep all outputs diagnostic/advisory, not audit authority.
