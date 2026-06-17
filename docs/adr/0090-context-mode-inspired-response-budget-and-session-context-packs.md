# ADR 0090: Context Mode-Inspired Response Budgets and Task Context Packs

**Status:** Proposed - Challenged and Narrowed
**Date:** 2026-06-17
**Source:** `./tmp/context-mode` donor review, challenged with OntoIndex MCP against current
`LocalBackend.callTool`, `response-guard`, `tool-telemetry`, `gn_diagnose`, `mcp-doctor`,
`gn_explore`, `gn_diff_impact`, and wiki generation surfaces.

## Context

Context Mode is useful as a donor because it treats context as a runtime budget:

- large tool outputs should be summarized before they enter the agent context;
- repeated calls should be measured and redirected toward compact surfaces;
- doctor/stats commands should make setup and savings visible.

Most donor ideas are not new for OntoIndex or do not fit:

- OntoIndex already has `guardResponseSize`, `recordToolCall`, and `gn_diagnose` response-limit
  reporting;
- OntoIndex should not add a second sandboxed shell runtime;
- OntoIndex should not create a parallel SQLite session database while LadybugDB, sidecars, wiki
  cache, and response guards already exist;
- OntoIndex should not add Context Mode-compatible MCP aliases.

The useful delta is narrower than the first draft:

```text
OntoIndex already has hard response guarding and telemetry. The missing piece is a structured budget
contract and one compact task pack that agents can use instead of broad follow-up reads.
```

## Review and Challenge

Architecture-fit gate:

1. **Real new functionality gate:** pass only for structured response-budget metadata and one compact
   context pack not already exposed consistently.
2. **Core-extension gate:** pass only when implemented through existing MCP response guard,
   telemetry, diagnose/doctor, explore/context/impact, wiki, and runtime-health owners. Reject a
   separate sandbox runtime, separate FTS store, daemon, or donor-compatible tool family.

Challenge findings:

1. **Do not copy Context Mode's sandbox.**
   OntoIndex is a graph indexer. Shell-output virtualization is a different product.
2. **Do not add persistent session storage first.**
   Start with context packs computed from existing graph, git diff, runtime health, docs, and wiki
   metadata.
3. **Do not add many tools.**
   Add one profile to one existing super-function first.
4. **Do not make default calls heavier.**
   Budget metadata appears only when the existing response guard triggers or a caller opts into the
   pack profile.
5. **Do not rebrand existing limits as new work.**
   `guardResponseSize`, `recordToolCall`, and `buildResponseLimits` already exist. This ADR may only
   standardize metadata and expose it where agents can act on it.
6. **Do not approve four pack profiles at once.**
   `symbol`, `file`, `pr`, and `release` packs are too broad as a first cut. Prove `task-pack` on
   `gn_explore`, then copy the pattern only if it is useful.

## Decision

Approve one native capability:

**Structured response-budget metadata and one compact task context pack for agent workflows.**

Approved scope:

1. structured response-budget metadata for responses already touched by the response guard;
2. one compact `task-pack` profile on `gn_explore`;
3. `gn_diagnose`/doctor visibility for response guard configuration and oversized local telemetry;
4. optional wiki-page references inside `task-pack` only when generated wiki metadata already exists.

Not approved:

- sandboxed command execution;
- SQLite FTS replacement store;
- Context Mode-compatible MCP aliases;
- global hook framework;
- telemetry upload;
- background daemon;
- prose-style enforcement;
- release-pack, pr-pack, file-pack, and symbol-pack in the first implementation.

## What Is New

### 1. Guarded Response Budget Metadata

Extend existing `response-guard` ownership so guarded MCP responses can include:

```ts
type ResponseBudget = {
  mode: "guarded-preview";
  estimatedBytes: number;
  truncated: true;
  retryHint: string;
};
```

This is not a new cursor system. The first cut only adds machine-readable metadata to the existing
truncated preview response.

Initial consumer:

- `LocalBackend.callTool` guarded responses.

Default behavior stays compatible for unguarded responses.

### 2. `gn_explore` Task Pack

Add one compact profile to `gn_explore`:

```ts
gn_explore({ repo: "ontoindex", query: "...", profile: "task-pack" })
```

The pack includes only:

- target query and resolved intent;
- top relevant files/symbols already collected by `gn_explore`;
- direct graph neighbors already collected by `gn_explore`;
- linked tests when known;
- docs/wiki references when already available;
- runtime freshness and dirty-worktree warning;
- exact next OntoIndex call.

This extends ADR 0088 agent-ready context and ADR 0086 budget controls. It does not add a new store,
new MCP tool, or source summarizer.

### 3. Doctor and Diagnose Visibility

Extend existing `mcp-doctor` / `gn_diagnose` surfaces with compact local facts:

- response-guard byte limit;
- recent oversized tool names from local telemetry;
- whether guarded-preview metadata is available;
- exact repair command for MCP repo mismatch or stale index.

This is local-only. No usage upload.

### 4. Wiki Context Reuse

Reuse generated wiki metadata only when `task-pack` asks for it:

- return known generated wiki page path and related graph owner when already mapped;
- include wiki references only in requested context-pack profiles;
- never regenerate wiki during a normal MCP call.

Full wiki FTS/search remains deferred.

## Integration Points

| Need                  | Existing owner to extend                    |
| --------------------- | ------------------------------------------- |
| response size guard   | `ontoindex/src/mcp/local/response-guard.ts` |
| tool call telemetry   | `ontoindex/src/mcp/local/tool-telemetry.ts` |
| MCP dispatch envelope | `ontoindex/src/mcp/local/local-backend.ts`  |
| diagnostics           | `ontoindex/src/mcp/super/diagnose.ts`       |
| CLI doctor            | `ontoindex/src/cli/mcp-doctor.ts`           |
| task pack             | `ontoindex/src/mcp/super/explore.ts`        |
| wiki context          | `ontoindex/src/core/wiki/`                  |

## Implementation Slices

1. Add `ResponseBudget` metadata only to `guardResponseSize` output.
2. Extend `LocalBackend.callTool` tests so guarded responses preserve budget metadata.
3. Add `profile: "task-pack"` to `gn_explore` with a strict item limit and next-call hints.
4. Extend `gn_diagnose` and `mcp-doctor` to show response-guard and oversized local telemetry status.
5. Add optional wiki-page references to `task-pack` only when generated wiki metadata already exists.

## Acceptance Criteria

- Default MCP calls remain backward compatible.
- Guarded large outputs expose structured budget metadata.
- `gn_explore({ profile: "task-pack" })` can replace one broad file-read sequence in an agent
  workflow.
- No new storage engine or sandbox runtime is introduced.
- Tests cover guarded budget metadata, `task-pack`, and diagnose/doctor visibility.

## Deferred

- Persistent session replay.
- Cross-session event database.
- Hook installers for every agent.
- Sandboxed shell execution.
- External documentation TTL cache.
- Full wiki FTS index.
- `inspect` symbol-pack.
- `impact` pr-pack.
- release-pack.
- cursor pagination.
