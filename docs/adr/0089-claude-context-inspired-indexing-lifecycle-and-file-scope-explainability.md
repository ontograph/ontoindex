# ADR 0089: Claude Context-Inspired Indexing Lifecycle and File-Scope Explainability

**Status:** Proposed - Narrowed After Review
**Date:** 2026-06-17
**Source:** `./tmp/claude-context` donor review, challenged with OntoIndex MCP against current
`analyze`, `status`, `mcp-doctor`, `ignore-service`, ADR 0086, ADR 0088, and MCP local backend
surfaces.
**Review update:** tightened after owner review with OntoIndex MCP. `runtime-health.ts` already owns
lock/checkpoint/stale/untrusted states, so this ADR no longer proposes a second lifecycle type.

## Context

Claude Context is useful as a donor because it treats indexing as an agent-facing lifecycle:

- indexing can be requested, monitored, and diagnosed;
- file inclusion rules are explainable;
- MCP configuration is documented for multiple clients;
- snapshot and remote collection state are validated instead of trusted blindly.

Most donor ideas are not new for OntoIndex:

- semantic search, graph context, impact, docs, wiki, and MCP tools already exist;
- ADR 0086 already owns runtime freshness, recoverable states, and output budgets;
- ADR 0088 already owns agent-ready symbol identity and compact context ergonomics;
- OntoIndex must remain local graph-first, not a Milvus/Zilliz vector-store clone.

The remaining useful delta is narrower:

```text
Agents need to know what will be indexed and why a file was skipped, while existing runtime-health
state must be applied consistently before status/diagnose/ensure-fresh claim an index is usable.
```

## Review and Challenge

Architecture-fit gate:

1. **Real new functionality gate:** pass only for file-scope preview/explainability and explicit
   index lifecycle health. Reject generic semantic search, hosted vector storage, and duplicate MCP
   tools already covered by OntoIndex.
2. **Core-extension gate:** pass only when implemented through current `analyze`, `status`,
   `mcp-doctor`, `ignore-service`, runtime-health, and MCP response metadata paths. Reject a new
   background daemon, external vector database, separate snapshot system, or client-specific fork.

Challenge findings:

1. **Do not add 50 tools.**
   Use existing CLI/MCP families and add small modes/fields.
2. **Do not copy background indexing.**
   ADR 0086 already rejected automatic background analyze for phase 1. OntoIndex should keep one
   writer and explicit analyze commands.
3. **Do not add a second file-rule engine.**
   `ontoindex/src/config/ignore-service.ts` already owns `.gitignore`, `.ontoindexignore`, built-in
   directory ignores, and glob-compatible filtering. Extend it with explanation, not replacement.
4. **Do not add cloud collection concepts.**
   OntoIndex has local `.ontoindex` state and registry metadata. Validate those instead.
5. **Do not hide partial indexes.**
   `runtime-health.ts` already models `failed-after-partial-run`, `untrusted`, stale locks, and
   checkpoints. The fix is to wire that existing state through every relevant surface, not invent a
   second state machine.

## Decision

Approve one native capability:

**Index lifecycle and file-scope explainability for agent workflows.**

Approved scope:

1. file inclusion preview before analyze;
2. per-file exclusion explanation;
3. consistent use of existing runtime-health metadata in CLI status and MCP diagnostics;
4. compact MCP/CLI repair hints that reuse existing runtime-health commands.

Not approved:

- hosted/vector database backend;
- Claude Context-compatible MCP tool names;
- always-on watcher sync;
- automatic background analyze;
- new daemon registry;
- new semantic search store;
- client-specific installers beyond existing setup/doctor checks;
- telemetry.

## What Is New

### 1. File Scope Preview

Add a dry-run file scope surface:

- CLI: `ontoindex analyze --dry-run`
- MCP: extend `gn_diagnose` with `includeFileScopePreview: true`

Behavior:

- return counts by included extension;
- return top skipped directories by reason;
- return largest included files;
- return total candidate, included, and skipped counts;
- return warnings for suspicious includes such as `dist`, `build`, `node_modules`, `.env`, generated
  bundles, and huge lockfiles;
- never write `.ontoindex`.

This extends current analyze and ignore-service code. It does not add indexing state.

### 2. File Exclusion Explanation

Add one resolver for "why is this file indexed or skipped?":

- CLI: `ontoindex analyze --explain-file <path>`
- MCP: `gn_diagnose({ explainFile: "relative/path" })`

Return:

```ts
type FileScopeExplanation = {
  repoPath: string;
  filePath: string;
  included: boolean;
  reason:
    | "included-extension"
    | "builtin-ignore"
    | "gitignore"
    | "ontoindexignore"
    | "unsupported-extension"
    | "generated"
    | "missing";
  matchedPattern?: string;
  source?: ".gitignore" | ".ontoindexignore" | "builtin" | "extension";
  suggestedFix?: string;
};
```

The first implementation can be simple: expose the first decisive rule. Do not build a full rule
trace unless users need it.

### 3. Runtime Health Wiring

Do not add a new lifecycle model. Reuse `RuntimeHealthSnapshot` from
`ontoindex/src/core/runtime/runtime-health.ts`, which already includes:

- `freshnessState`;
- `degradedReason`;
- `repairCommand`;
- `analyzeLock`;
- `analysisCheckpoint`;
- `indexedCommit`;
- `currentCommit`;
- `dirtyWorktree`.

Required behavior:

- `status` must show runtime health before freshness wording;
- `gn_diagnose` and `gn_ensure_fresh` must expose the same `freshnessState` and repair command;
- `gn_ensure_fresh` must not auto-analyze when runtime health is `untrusted` or
  `failed-after-partial-run` until the repair command is acknowledged by the caller;
- current large-repo crash reports must not result in an MCP answer that looks "healthy" just
  because `meta.json` has a matching commit.

### 4. Repair Hints

Every unhealthy lifecycle state should include one exact repair command:

```bash
ONTOINDEX_MAX_WORKERS=7 node /opt/demodb/_workfolder/OntoIndex/ontoindex/dist/cli/index.js analyze --force
```

If repair requires cleanup, show it explicitly:

```bash
rm -f .ontoindex/analyze.lock
ONTOINDEX_MAX_WORKERS=7 node /opt/demodb/_workfolder/OntoIndex/ontoindex/dist/cli/index.js analyze --force
```

The command is only a hint. Tools must not auto-run cleanup unless the user explicitly asks. Do not
duplicate repair hint construction outside `runtime-health.ts`; format it near the display layer
only when an absolute local command is needed.

## Integration Points

- `ontoindex/src/config/ignore-service.ts` - add rule-source/explanation helpers beside
  `shouldIgnorePath`, `loadIgnoreRules`, and `createIgnoreFilter`.
- `ontoindex/src/cli/analyze.ts` - add preview mode using the same file discovery path.
- `ontoindex/src/cli/status.ts` - show lifecycle health before freshness.
- `ontoindex/src/core/runtime/runtime-health.ts` - source of truth for health and repair state.
- `ontoindex/src/mcp/super/diagnose.ts` - include bounded file preview/explain-file and existing
  runtime-health repair hints.
- `ontoindex/src/mcp/super/ensure-fresh.ts` - consume runtime health before deciding auto-analyze.

## Minimal Implementation Plan

1. Add `explainPathScope(repoPath, filePath)` to `ignore-service.ts`.
2. Add `collectFileScopePreview(repoPath, limit)` using existing analyze file discovery.
3. Add CLI `analyze --dry-run` and `analyze --explain-file <path>`.
4. Wire existing `RuntimeHealthSnapshot` into `gn_diagnose` and `gn_ensure_fresh` responses where
   missing.
5. Add bounded MCP fields to `gn_diagnose`; keep default responses compact.
6. Add unit tests for `.gitignore`, `.ontoindexignore`, built-in ignores, unsupported extensions,
   generated-file skips, stale lock, and failed checkpoint states.

## Acceptance Criteria

- A user can run a dry preview and see which files will be indexed without writing `.ontoindex`.
- A user can ask why one file is skipped and get the exact decisive rule.
- `status` refuses to show a crashed or lock-leftover index as simply up-to-date.
- MCP diagnostics include the same repo path, lifecycle status, and repair hint as CLI status.
- No new store, daemon, watcher, or duplicate MCP frontier is added.

## Postponed

- automatic background indexing;
- partial search during indexing;
- file watcher sync;
- multi-client installer expansion;
- cloud/vector collection reconciliation;
- full rule-trace debugging UI.

## Related ADRs

- ADR 0086: agent runtime freshness and budget controls
- ADR 0088: agent-ready context and symbol ergonomics
