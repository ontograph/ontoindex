# Real-Time Dirty-Worktree Support Project Plan

Date: 2026-10-10
Status: In progress
Authority: User request ("4 1"): option 4 (freshness flags in tool results), then option 1 (bounded refresh on dirty trees plus a watcher).

## Goal

An agent editing uncommitted code gets graph answers that say which returned files are dirty (stale in the graph), and the graph for those files can be refreshed within seconds without a full analyze.

## Manager Tracking

```yaml
manager_loop:
  authority: true
  status: in-progress
  selection_policy: active_next_task-first
  active_next_task: RT-2
  max_in_flight: 1
  dispatch_mode: human

tasks:
  RT-1:
    title: When a tool result references files that are dirty or untracked, the response envelope lists those paths under dirtyWorkspace.dirtyPaths and marks them stale
    status: DONE
    classification: implementation-ready
    assurance_profile: full
    complexity: complex
    depends_on: []
    type: code
    validation_tier: unit-fast
    impact_risk: medium
    owner_files:
      - ontoindex/src/mcp/shared/target-context.ts
      - ontoindex/src/mcp/shared/response-envelope.ts
      - ontoindex/test/unit/target-context.test.ts
      - ontoindex/test/unit/response-envelope.test.ts
    allowed_write_set:
      - ontoindex/src/mcp/shared/target-context.ts
      - ontoindex/src/mcp/shared/response-envelope.ts
      - ontoindex/test/unit/target-context.test.ts
      - ontoindex/test/unit/response-envelope.test.ts
    non_goals:
      - Changing indexing, analyze, or the database.
      - Fetching or embedding live source for dirty files (a later step).
      - Renaming existing envelope fields; only add dirtyPaths (capped list).
    required_validation:
      - cd ontoindex && npx vitest run test/unit/target-context.test.ts test/unit/response-envelope.test.ts
      - cd ontoindex && npx tsc --noEmit
    validation_workspace:
      root: ontoindex
      inputs:
        - src/mcp/shared/target-context.ts
        - src/mcp/shared/response-envelope.ts
      generated_outputs:
        - dist/
    expected_evidence:
      - A fixture with two dirty files yields dirtyWorkspace.dirtyPaths of exactly those two paths, capped at 50 with a truncated flag.
      - A clean worktree yields no dirtyPaths and unchanged envelopes (existing tests still pass).
      - Result entries whose filePath is dirty carry stale true; others do not.
    rollback:
      - Revert the write-set files.
    stop_conditions:
      - Envelope change breaks the public response schema or needs a version bump.
      - Per-result marking needs changes outside the write set.
    known_blockers: []

  RT-2:
    title: When the dirty files are all eligible source files (at most 50, no deletes or renames), analyze --experimental-file-delta bounds the refresh to them instead of forcing a full analyze
    status: OPEN
    classification: implementation-ready
    assurance_profile: full
    complexity: complex
    depends_on: [RT-1]
    type: code
    validation_tier: unit-fast
    impact_risk: high
    owner_files:
      - ontoindex/src/core/analyze-delta.ts
      - ontoindex/test/unit/analyze-delta.test.ts
    allowed_write_set:
      - ontoindex/src/core/analyze-delta.ts
      - ontoindex/test/unit/analyze-delta.test.ts
    non_goals:
      - Embedding refresh for bounded runs (stays disabled; vectors lag until a full run).
      - Changing delete, rename, import/export, or too-many-files safety rules.
      - Making the bounded path the default.
    required_validation:
      - cd ontoindex && npx vitest run test/unit/analyze-delta.test.ts
      - cd ontoindex && npx tsc --noEmit
    validation_workspace:
      root: ontoindex
      inputs:
        - src/core/analyze-delta.ts
      generated_outputs:
        - dist/
    expected_evidence:
      - Dirty tree with only modified .ts files returns safeToBound true and boundedIncludePaths equal to them.
      - Dirty tree with a deleted, renamed, or import/export-changing file still returns safeToBound false with its reason.
      - More than 50 dirty files still returns the too-many-files reason.
      - Graph coverage stays reported as partial.
    rollback:
      - Revert analyze-delta.ts and its test.
    stop_conditions:
      - Bounded refresh corrupts edges to unchanged files (verify with a before/after node and edge count on a fixture).
      - analyze.lock cannot be honoured on this path.
    known_blockers: []

  RT-3:
    title: When a watched source file is saved, ontoindex watch runs one debounced bounded refresh under analyze.lock and skips if a run is active
    status: OPEN
    classification: implementation-ready
    assurance_profile: full
    complexity: complex
    depends_on: [RT-2]
    type: code
    validation_tier: unit-fast
    impact_risk: medium
    owner_files:
      - ontoindex/src/cli/watch.ts
      - ontoindex/src/cli/index.ts
      - ontoindex/test/unit/watch.test.ts
    allowed_write_set:
      - ontoindex/src/cli/watch.ts
      - ontoindex/src/cli/index.ts
      - ontoindex/test/unit/watch.test.ts
    non_goals:
      - A new dependency; use node:fs recursive watch with ignore rules from .ontoindexignore.
      - Watching while an MCP server holds the database in a way that breaks single-writer rules.
      - Running embeddings from the watcher.
    required_validation:
      - cd ontoindex && npx vitest run test/unit/watch.test.ts
      - cd ontoindex && npx tsc --noEmit
    validation_workspace:
      root: ontoindex
      inputs:
        - src/cli/watch.ts
      generated_outputs:
        - dist/
    expected_evidence:
      - Ten rapid saves trigger exactly one refresh after the debounce window.
      - A save while analyze.lock is active is skipped and logged, not queued twice.
      - Ignored paths (node_modules, dist, .git) never trigger a refresh.
    rollback:
      - Delete watch.ts and its registration.
    stop_conditions:
      - Watching needs a new npm dependency.
      - The bounded refresh cannot run while the MCP server is connected.
    known_blockers: []
```

## Required Traceability

| Requirement ID | ADR/user requirement | Disposition | Task IDs | Validation |
| --- | --- | --- | --- | --- |
| RT-REQ-1 | Tool results flag which returned files are dirty (option 4) | implementation | RT-1 | target-context and envelope tests |
| RT-REQ-2 | Bounded refresh works on a dirty tree (option 1) | implementation | RT-2 | analyze-delta tests |
| RT-REQ-3 | Debounced watcher triggers the refresh (option 1) | implementation | RT-3 | watch tests |
| RT-REQ-4 | Embeddings are not refreshed by bounded runs | non-goal | RT-2 | documented limit |

## Decisions And Non-Goals

- Option 4 ships first because it removes false confidence without touching the index.
- Options 2 (query-time overlay), 3 (per-state snapshots) and 5 (warm-start incremental) are deferred.
- Vector search lags on edited files until a full `analyze --embeddings`; this is stated, not hidden.

## Closeout

RT-1 (2026-10-10): `dirtyWorkspace.dirtyPaths` (cap 50, `dirtyPathsTruncated`) added in target-context.ts; `freshness.dirtyResultPaths` added in response-envelope.ts (bounded scan of filePath/path/file in results). 6 new tests pass; 41/41 in the two touched files; tsc clean. Full unit run: 6885 pass, 4 fail in mcp-doctor.test.ts, which fail identically on unmodified master. Per-result `stale` markers were not added; only the path list on freshness.
