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
  active_next_task: RT-1
  max_in_flight: 1
  dispatch_mode: human

tasks:
  RT-1:
    title: When a tool result references files that are dirty or untracked, the response envelope lists those paths under dirtyWorkspace.dirtyPaths and marks them stale
    status: OPEN
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
    title: When analyze --dirty-overlay runs on a dirty tree, the bounded pipeline writes only to <storage>/overlay and the active generation, its meta, and its node and edge counts are unchanged
    status: OPEN
    classification: implementation-ready
    assurance_profile: full
    complexity: complex
    depends_on: []
    type: code
    validation_tier: unit-fast
    impact_risk: high
    owner_files:
      - ontoindex/src/core/run-analyze.ts
      - ontoindex/src/cli/analyze.ts
      - ontoindex/test/unit/dirty-overlay-build.test.ts
    allowed_write_set:
      - ontoindex/src/core/run-analyze.ts
      - ontoindex/src/cli/analyze.ts
      - ontoindex/test/unit/dirty-overlay-build.test.ts
    non_goals:
      - Changing the default analyze path or the existing --experimental-file-delta behavior.
      - Embeddings for the overlay.
      - Reading the overlay at query time (RT-5).
    required_validation:
      - cd ontoindex && npx vitest run test/unit/dirty-overlay-build.test.ts
      - cd ontoindex && npx tsc --noEmit
    validation_workspace:
      root: ontoindex
      inputs:
        - src/core/run-analyze.ts
      generated_outputs:
        - dist/
    expected_evidence:
      - After an overlay build the active generation id, meta.json, and node and edge counts equal their values before the build.
      - The overlay store exists and contains only the dirty files' symbols.
      - A failure during the overlay build leaves the active generation untouched and removes the partial overlay.
    rollback:
      - Revert the write-set files.
    stop_conditions:
      - Overlay output cannot be separated from activateIndexGeneration without changing the default path.
      - Write set must grow beyond the listed files.
    known_blockers: []

  RT-3:
    title: Given modified, added, untracked, or deleted files, planDirtyOverlay returns the eligible source paths and a tombstone list for deleted paths instead of reporting unsafe
    status: OPEN
    classification: implementation-ready
    assurance_profile: full
    complexity: complex
    depends_on: []
    type: code
    validation_tier: unit-fast
    impact_risk: medium
    owner_files:
      - ontoindex/src/core/analyze-delta.ts
      - ontoindex/test/unit/dirty-overlay-plan.test.ts
    allowed_write_set:
      - ontoindex/src/core/analyze-delta.ts
      - ontoindex/test/unit/dirty-overlay-plan.test.ts
    non_goals:
      - Changing planExperimentalFileDeltaRefresh behavior or its existing tests.
      - Running analyze.
    required_validation:
      - cd ontoindex && npx vitest run test/unit/dirty-overlay-plan.test.ts test/unit/experimental-file-delta.test.ts
      - cd ontoindex && npx tsc --noEmit
    validation_workspace:
      root: ontoindex
      inputs:
        - src/core/analyze-delta.ts
      generated_outputs:
        - dist/
    expected_evidence:
      - Modified, added, and untracked source files appear in includePaths.
      - Deleted and renamed-away paths appear in tombstones, not includePaths.
      - More than 50 dirty source files returns tooMany true with an empty includePaths.
      - Non-source files are ignored.
    rollback:
      - Revert analyze-delta.ts and the new test.
    stop_conditions:
      - Existing experimental-file-delta tests must change.
    known_blockers: []

  RT-4:
    title: When source files are saved, ontoindex watch runs one debounced overlay refresh and skips while analyze.lock is held
    status: OPEN
    classification: implementation-ready
    assurance_profile: full
    complexity: complex
    depends_on: [RT-2, RT-3]
    type: code
    validation_tier: unit-fast
    impact_risk: medium
    owner_files:
      - ontoindex/src/cli/watch.ts
      - ontoindex/test/unit/watch.test.ts
    allowed_write_set:
      - ontoindex/src/cli/watch.ts
      - ontoindex/test/unit/watch.test.ts
    non_goals:
      - A new npm dependency; use node:fs recursive watch.
      - Registering the command in cli/index.ts (done separately after review).
      - Embeddings from the watcher.
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
      - A save while the lock is held is skipped and logged, not queued twice.
      - node_modules, dist, and .git paths never trigger a refresh.
    rollback:
      - Delete watch.ts and its test.
    stop_conditions:
      - Watching needs a new npm dependency.
    known_blockers: []

  RT-5:
    title: A read-only spike lists the query and context code paths and the smallest merge point for serving dirty paths from the overlay
    status: OPEN
    classification: proof-only
    assurance_profile: full
    complexity: complex
    depends_on: [RT-2]
    type: diagnostic
    validation_tier: unit-fast
    impact_risk: high
    owner_files:
      - ontoindex/src/mcp/local/local-backend.ts
    allowed_write_set: []
    non_goals:
      - Starting before a read-path spike names the exact hook points.
    required_validation:
      - cd ontoindex && npx tsc --noEmit
    validation_workspace:
      root: ontoindex
      inputs:
        - src/mcp/local/local-backend.ts
      generated_outputs:
        - dist/
    expected_evidence:
      - A spike report lists the query and context code paths and the smallest merge point.
    rollback:
      - Not applicable until the spike decides.
    stop_conditions:
      - Merging needs changes to more than one tool family.
    known_blockers:
      - Needs the overlay store from RT-2.
```

## Required Traceability

| Requirement ID | ADR/user requirement | Disposition | Task IDs | Validation |
| --- | --- | --- | --- | --- |
| RT-REQ-1 | Tool results flag which returned files are dirty | implementation | RT-1 | target-context and envelope tests |
| RT-REQ-2 | Dirty files get a separate overlay graph that never mutates the active generation | implementation | RT-2, RT-3 | dirty-overlay build and plan tests |
| RT-REQ-3 | A debounced watcher keeps the overlay current | implementation | RT-4 | watch tests |
| RT-REQ-4 | Queries serve dirty paths from the overlay | proof-only | RT-5 | read-path spike |
| RT-REQ-5 | Embeddings are not refreshed for the overlay | non-goal | RT-2 | documented limit |

## Decisions And Non-Goals

- 2026-10-10 finding: `--experimental-file-delta` replaces the active generation with only the changed files (32 nodes became 4 on a probe repo, status degraded). Allowing it on dirty trees would wipe the index, so the original RT-2 and RT-3 were dropped.
- Chosen design: overlay generation. The bounded pipeline writes to `<storage>/overlay` and is never activated; the base stays intact and the overlay is disposable.
- Rejected: in-place graph patching (writer-lock and lost cross-file edges), per-state snapshots (minutes per state), per-file parse cache with full relink (large refactor; revisit later).
- Vector search lags on edited files until a full `analyze --embeddings`.

## Closeout

RT-1 (2026-10-10), implemented locally in PR 83 without sub-agent role receipts, so it stays OPEN here until reviewed by the gates: `dirtyWorkspace.dirtyPaths` (cap 50, `dirtyPathsTruncated`) added in target-context.ts; `freshness.dirtyResultPaths` added in response-envelope.ts (bounded scan of filePath/path/file in results). 6 new tests pass; 41/41 in the two touched files; tsc clean. Full unit run: 6885 pass, 4 fail in mcp-doctor.test.ts, which fail identically on unmodified master. Per-result `stale` markers were not added; only the path list on freshness.

2026-10-10 sub-agent phase (parent verified diffs, ran tsc, prettier, and the full unit suite; 6899 pass, 4 pre-existing mcp-doctor failures):
- RT-2 (gpt-6.1-sol): `analyze --dirty-overlay` builds a disposable store at `.ontoindex/overlay` and never activates a generation. I added the CLI flag registration the agent was blocked on. Live check: 8 dirty files gave 442 nodes; the active `meta.json` md5 was identical before and after.
- RT-3 (gpt-6-luna): `planDirtyOverlay` in analyze-delta.ts (append-only); 7 tests including rename, delete, AD/DU, spaces, and the 50-file cap.
- RT-4 (gpt-6-luna): `createDebouncedWatcher` in src/cli/watch.ts, dependency-free, lock-aware, injected refresh. Not registered as a CLI command and not yet wired to the overlay build.
- RT-5 (gpt-6.1-sol): read-only spike, report in RT5_READ_PATH_SPIKE_REPORT.md. No single merge point exists; minimum is query merge in backend-search.ts, shared symbol resolution, context gating, impact pre-BFS. Overlay is symbols-only so impact must report UNKNOWN, not zero. A second read-only handle is feasible through the MCP pool, not the writer singleton.
- Note: the agents were told the "4 sub-agents" rule does not apply to leaf workers; the first Luna dispatch stopped on it and was re-dispatched.
- Statuses left OPEN: no authenticated role receipts exist (dispatch was not through the manager loop).

