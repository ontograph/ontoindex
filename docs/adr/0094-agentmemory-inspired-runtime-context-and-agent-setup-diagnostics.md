# ADR 0094: AgentMemory-Inspired Runtime Context And Agent Setup Diagnostics

**Status:** Proposed - Core Extension Only
**Date:** 2026-06-17
**Source:** `./tmp/agentmemory` donor review, challenged with OntoIndex MCP against current
`tool-telemetry`, `diagnose`, `ensure-fresh`, MCP resources, and setup owners.

## Context

AgentMemory is a persistent memory server for coding agents. Its useful ideas for OntoIndex are not
the memory server itself, but the operational discipline around agent setup, runtime context,
retention, tool telemetry, and health checks.

OntoIndex should not become a separate general-purpose memory product. OntoIndex already has a code
graph, embeddings, docs sidecar, MCP frontier, audit lifecycle, generated skills, wiki/export
surfaces, and runtime diagnostics. The useful donor delta is narrower: make OntoIndex's existing
agent-facing diagnostics and setup surfaces easier to trust.

## Review And Challenge

Architecture-fit gate:

1. **Real new functionality gate:** pass only for diagnostics that OntoIndex does not expose cleanly
   today: compact runtime context summary, telemetry rollups, agent setup health, and embedding
   repair guidance.
2. **Core-extension gate:** pass only when built on current `.ontoindex` runtime metadata, MCP
   telemetry, `gn_diagnose`, `gn_ensure_fresh`, `gn_review_diff`, `gn_docs`, generated skills, and
   existing config/setup flows.

Rejected:

- a standalone memory server;
- separate auth, REST, or viewer stack;
- image or multimodal memory search;
- generic "remember/forget" tools for arbitrary chat facts;
- new vector store or graph database;
- agent hooks that auto-run broad analyze without explicit user intent;
- importing raw private chat/session logs as graph authority;
- new `remember`, `forget`, `checkpoint`, or `restore` MCP tools.

## Decision

Approve one narrow capability:

**A richer `gn_diagnose` / `mcp-doctor` diagnostic layer that summarizes the current agent runtime
context without adding a separate memory subsystem.**

Approved sub-capabilities:

### 1. Runtime Context Summary

Add a compact runtime context summary to `gn_diagnose`:

- repo label and path;
- freshness and embeddings status;
- dirty diff summary;
- selected files/symbols/processes only when already known from the current diagnostic path;
- recent MCP tool calls from existing telemetry;
- next recommended OntoIndex commands.

This is not a saved checkpoint. It is a current-response summary over existing facts.

### 2. Tool Telemetry Summary

Extend `ontoindex/src/mcp/local/tool-telemetry.ts` consumers so diagnostics can report:

- recent oversized tools already recorded by `readRecentOversizedToolCalls`;
- failing tools by name/action only if failure telemetry is already recorded;
- oversized or truncated responses;

This is runtime diagnostic evidence only. It must not become audit authority.

### 3. Agent Setup Doctor

Extend `mcp-doctor` and setup resources to report per-agent MCP configuration health:

- expected local CLI path;
- target repo path;
- stale hardcoded paths;
- missing generated skills;
- conflicting old GitNexus/OntoIndex registrations;
- exact repair commands.

This should reuse current setup resources, `mcp-doctor`, and generated skill directories. No new
connector runtime.

### 4. Embedding Coverage Repair Plan

Extend `gn_ensure_fresh` / `gn_diagnose` to distinguish:

- graph stale;
- embeddings absent;
- embeddings partially populated;
- model hash mismatch;
- sidecar stale.

Return a minimal repair command. For this repo, that currently means:

```bash
ONTOINDEX_MAX_WORKERS=7 node /opt/demodb/_workfolder/OntoIndex/ontoindex/dist/cli/index.js analyze --force --embeddings
```

Do not auto-run embedding generation from MCP by default.

## Integration Points

| Need | Existing owner to extend |
| --- | --- |
| Runtime context summary | `ontoindex/src/mcp/super/diagnose.ts` |
| Tool telemetry summary | `ontoindex/src/mcp/local/tool-telemetry.ts`, `ontoindex/src/mcp/local/response-guard.ts` |
| Agent setup doctor | `ontoindex/src/mcp/resources.ts`, `ontoindex/src/cli/setup.ts`, `ontoindex/src/cli/mcp-doctor.ts` |
| Embedding coverage repair | `ontoindex/src/mcp/super/ensure-fresh.ts`, `ontoindex/src/mcp/super/diagnose.ts`, `ontoindex/src/core/run-analyze.ts` |
| Generated skills checks | `ontoindex/src/cli/ai-context.ts`, generated `.claude` / `.agents` / Cursor skill paths |

## Proposed First Slice

Keep the first implementation smaller than the donor idea:

1. add `runtimeContextSummary` metadata to `gn_diagnose`;
2. add `toolTelemetrySummary` to `gn_diagnose` using existing oversized-tool telemetry first;
3. improve embedding repair text when embeddings are absent but graph is fresh;
4. add setup-doctor checks for stale hardcoded repo paths and missing generated skills;
5. add focused unit tests for each summary shape.

## Non-Goals

- No new memory product.
- No new database.
- No new MCP tool family unless existing responses become too crowded.
- No saved context checkpoints in the first slice.
- No automatic background indexing.
- No raw session-log ingestion as authoritative evidence.
- No UI redesign.

## Success Criteria

- `gn_diagnose` can tell an agent what repo context it has, what is stale, and the exact smallest
  repair.
- Tool telemetry explains recent MCP pain without reading log files manually.
- Setup doctor catches wrong repo path and stale agent config before tools return misleading results.
- Embedding absence gets a direct repair command and no longer looks like vague degraded search.

## Validation

```bash
cd ontoindex
npm test -- --run test/unit/super/diagnose.test.ts test/unit/tool-telemetry.test.ts test/unit/mcp-doctor.test.ts
npx tsc --noEmit
```

## Notes

This ADR intentionally keeps AgentMemory's broad memory-server ideas out of OntoIndex. The value is
diagnostic continuity for code-graph agents, not persistent chat memory.
