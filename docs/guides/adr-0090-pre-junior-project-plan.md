# ADR 0090 Pre-Junior Project Plan: Response Budgets and Task Context Packs

**Status:** Ready for implementation
**ADR:** `docs/adr/0090-context-mode-inspired-response-budget-and-session-context-packs.md`
**Date:** 2026-06-17

## Goal

Make large MCP responses easier for agents to consume without adding a new tool family or a second
storage system.

Build only the first useful slice:

- guarded large responses expose structured budget metadata;
- `gn_explore` has one compact `task-pack` profile;
- `gn_diagnose` and `mcp-doctor` report response-guard and oversized telemetry health.

## Architecture Gate

Before coding any task, check both gates:

1. **Real new functionality:** the change must add metadata or a compact pack that does not already
   exist.
2. **Core extension:** the change must extend existing response guard, telemetry, diagnose, doctor,
   or explore owners. Do not add a new MCP tool family, sandbox runtime, database, daemon, or hook
   framework.

If a task starts drifting into a new subsystem, stop and narrow it.

## Hard Scope

Allowed files:

- `ontoindex/src/mcp/local/response-guard.ts`
- `ontoindex/src/mcp/local/local-backend.ts`
- `ontoindex/src/mcp/local/tool-telemetry.ts`
- `ontoindex/src/mcp/super/explore.ts`
- `ontoindex/src/mcp/super/diagnose.ts`
- `ontoindex/src/cli/mcp-doctor.ts`
- existing nearby type/schema files only when required
- focused unit tests under `ontoindex/test/unit/`

Not allowed:

- new MCP tool names;
- cursor pagination;
- persistent session database;
- sandboxed command execution;
- telemetry upload;
- broad `symbol-pack`, `file-pack`, `pr-pack`, or `release-pack` profiles;
- wiki regeneration from MCP calls.

## Existing Owner Map

| Need                       | Existing owner      | What to extend                                             |
| -------------------------- | ------------------- | ---------------------------------------------------------- |
| guarded large response     | `response-guard.ts` | Add structured metadata to the existing truncated response |
| dispatch preservation      | `local-backend.ts`  | Ensure guarded JSON reaches callers unchanged              |
| local oversized-call facts | `tool-telemetry.ts` | Add a small reader/summary helper if needed                |
| task pack                  | `explore.ts`        | Add one `profile: "task-pack"` output mode                 |
| diagnostics                | `diagnose.ts`       | Report guard limit and oversized telemetry facts           |
| CLI doctor                 | `mcp-doctor.ts`     | Print the same compact response-budget health              |

## Task List

### T1: Add Structured Guard Metadata

**Owner files:**

- `ontoindex/src/mcp/local/response-guard.ts`
- `ontoindex/test/unit/response-guard.test.ts`

**Change:**

When `guardResponseSize` truncates a payload, return JSON with:

```ts
{
  truncated: true,
  responseBudget: {
    mode: "guarded-preview",
    estimatedBytes: number,
    truncated: true,
    retryHint: string
  },
  hint: string,
  preview: string
}
```

Keep existing `truncated`, `hint`, and `preview` keys for compatibility.

**Tests:**

- small payload returns unchanged text;
- large payload returns parseable JSON;
- JSON includes `responseBudget.mode === "guarded-preview"`;
- `estimatedBytes` is greater than the preview length.

**Done when:**

- no caller behavior changes for unguarded payloads.

### T2: Preserve Guarded JSON Through MCP Dispatch

**Owner files:**

- `ontoindex/src/mcp/local/local-backend.ts`
- `ontoindex/test/unit/calltool-dispatch.test.ts` or nearest existing dispatch test

**Change:**

Verify `LocalBackend.callTool` returns the guarded JSON from T1 without wrapping it in a way that
loses `responseBudget`.

Prefer a test-only change if the current code already preserves it.

**Tests:**

- mocked oversized tool response reaches caller with `responseBudget` present.

**Done when:**

- the test fails if `responseBudget` is stripped.

### T3: Add `gn_explore` Task Pack Profile

**Owner files:**

- `ontoindex/src/mcp/super/explore.ts`
- `ontoindex/test/unit/super/explore.test.ts`

**Change:**

Add optional params support:

```ts
profile?: "task-pack";
```

When `profile === "task-pack"`, return a compact field such as:

```ts
taskPack: {
  query: string;
  intent: string;
  topFiles: Array<{ filePath: string; reason: string }>;
  topSymbols: Array<{ nodeId: string; name: string; filePath: string }>;
  nextCalls: string[];
  warnings: string[];
}
```

Use data already collected by `gn_explore`. Do not add a new graph query unless a field cannot be
filled from existing results.

**Tests:**

- default `gn_explore` response is unchanged;
- `profile: "task-pack"` returns `taskPack`;
- `taskPack.nextCalls` contains one exact OntoIndex call using returned symbol or file data;
- output is bounded to a small number of files/symbols.

**Done when:**

- one compact pack can replace a broad follow-up file-read step.

### T4: Add Response-Budget Health To `gn_diagnose`

**Owner files:**

- `ontoindex/src/mcp/super/diagnose.ts`
- `ontoindex/src/mcp/local/tool-telemetry.ts`
- `ontoindex/test/unit/super/diagnose.test.ts`
- `ontoindex/test/unit/tool-telemetry.test.ts`

**Change:**

Expose compact local facts:

```ts
responseBudgetHealth?: {
  guardLimitBytes: number;
  recentOversizedTools: string[];
  guardedPreviewAvailable: true;
};
```

Add one tiny read helper to `tool-telemetry.ts`:

```ts
readRecentOversizedToolCalls(options?: { limit?: number }): Promise<string[]>
```

Keep it local and best-effort. Return `[]` if telemetry is missing or corrupt. Do not let diagnose fail because telemetry failed.

**Tests:**

- missing telemetry returns an empty recent list;
- fake telemetry with large response sizes returns tool names;
- diagnose includes guard limit and availability.

**Done when:**

- `gn_diagnose` can tell users which tools are producing oversized output.

### T5: Add Response-Budget Health To `mcp-doctor`

**Owner files:**

- `ontoindex/src/cli/mcp-doctor.ts`
- `ontoindex/test/unit/mcp-doctor.test.ts`

**Change:**

Print the same compact response-budget health in the existing doctor report. Reuse the helper from T4; do not add a second telemetry parser:

- guard limit bytes;
- recent oversized tool names when available;
- guarded-preview metadata availability.

Keep output text short. No new command.

**Tests:**

- doctor text includes response-budget health;
- missing telemetry does not fail doctor;
- the test proves doctor uses the shared T4 helper or a shared report builder, not duplicate parsing.

**Done when:**

- CLI and MCP diagnostics agree on the same response-budget facts.

## Validation Sequence

Run these after each task that changes code:

```bash
cd ontoindex
npx vitest run test/unit/response-guard.test.ts test/unit/tool-telemetry.test.ts test/unit/super/explore.test.ts test/unit/super/diagnose.test.ts test/unit/mcp-doctor.test.ts test/unit/calltool-dispatch.test.ts
npx tsc --noEmit
```

Run formatting only on changed files. If Prettier is broken for TypeScript in this checkout, record
that and keep the functional tests/typecheck as the blocker.

## Tracking

Before starting implementation, create or update:

`docs/adr/0090-tracking.md`

Use this table:

| Task                                    | Status  | Notes |
| --------------------------------------- | ------- | ----- |
| T1 Structured guard metadata            | Pending |       |
| T2 Dispatch preservation test           | Pending |       |
| T3 `gn_explore` task-pack               | Pending |       |
| T4 `gn_diagnose` response-budget health | Pending |       |
| T5 `mcp-doctor` response-budget health  | Pending |       |

Update the tracking file before starting each new task and after validation.

## Stop Conditions

Stop and ask for senior review if:

- the implementation needs a new database table or store;
- a task requires new MCP tool names;
- `gn_explore` would need broad new graph queries for `task-pack`;
- response-guard changes break existing unguarded outputs;
- telemetry reading becomes more than a small best-effort helper.
