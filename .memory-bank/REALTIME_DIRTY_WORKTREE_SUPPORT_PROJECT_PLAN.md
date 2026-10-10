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

  RT-6:
    title: When the overlay snapshot is usable, query results drop base symbols from dirty paths and include matching overlay symbols marked source overlay
    status: OPEN
    classification: implementation-ready
    assurance_profile: full
    complexity: complex
    depends_on: [RT-2]
    type: code
    validation_tier: unit-fast
    impact_risk: high
    owner_files:
      - ontoindex/src/mcp/local/backend-search.ts
      - ontoindex/test/unit/overlay-query-merge.test.ts
    allowed_write_set:
      - ontoindex/src/mcp/local/backend-search.ts
      - ontoindex/test/unit/overlay-query-merge.test.ts
    non_goals:
      - Editing backend-overlay.ts or any file outside this write set.
      - Treating overlay symbols as proof of zero callers or zero impact.
    required_validation:
      - cd ontoindex && npx vitest run test/unit/overlay-query-merge.test.ts
      - cd ontoindex && npx tsc --noEmit
    validation_workspace:
      root: ontoindex
      inputs:
        - src/mcp/local/backend-overlay.ts
      generated_outputs:
        - dist/
    expected_evidence:
      - A dirty path's stale base symbol is absent and the overlay symbol is present with source overlay.
      - With an unusable snapshot, results are byte-identical to today.
    rollback:
      - Revert the write-set files.
    stop_conditions:
      - The hook needs a file outside the write set.
    known_blockers: []

  RT-7:
    title: When the overlay snapshot is usable, symbol resolution for context and impact finds overlay symbols for dirty paths and never returns a stale base symbol for them
    status: OPEN
    classification: implementation-ready
    assurance_profile: full
    complexity: complex
    depends_on: [RT-2]
    type: code
    validation_tier: unit-fast
    impact_risk: high
    owner_files:
      - ontoindex/src/mcp/local/backend-symbol-resolution.ts
      - ontoindex/test/unit/overlay-symbol-resolution.test.ts
    allowed_write_set:
      - ontoindex/src/mcp/local/backend-symbol-resolution.ts
      - ontoindex/test/unit/overlay-symbol-resolution.test.ts
    non_goals:
      - Editing backend-overlay.ts or any file outside this write set.
      - Treating overlay symbols as proof of zero callers or zero impact.
    required_validation:
      - cd ontoindex && npx vitest run test/unit/overlay-symbol-resolution.test.ts
      - cd ontoindex && npx tsc --noEmit
    validation_workspace:
      root: ontoindex
      inputs:
        - src/mcp/local/backend-overlay.ts
      generated_outputs:
        - dist/
    expected_evidence:
      - Resolving a name defined only in a dirty file returns the overlay symbol, not not_found.
      - A symbol deleted from a dirty file resolves to not_found, not the stale base symbol.
      - With an unusable snapshot, behavior is unchanged.
    rollback:
      - Revert the write-set files.
    stop_conditions:
      - The hook needs a file outside the write set.
    known_blockers: []

  RT-8:
    title: When a context or impact target resolves from the overlay, the response is marked source overlay and impact reports risk UNKNOWN with graphImpactAvailable false
    status: OPEN
    classification: implementation-ready
    assurance_profile: full
    complexity: complex
    depends_on: [RT-7]
    type: code
    validation_tier: unit-fast
    impact_risk: high
    owner_files:
      - ontoindex/src/mcp/local/backend-context.ts
      - ontoindex/src/mcp/local/backend-impact.ts
      - ontoindex/test/unit/overlay-context-impact.test.ts
    allowed_write_set:
      - ontoindex/src/mcp/local/backend-context.ts
      - ontoindex/src/mcp/local/backend-impact.ts
      - ontoindex/test/unit/overlay-context-impact.test.ts
    non_goals:
      - Editing backend-overlay.ts or any file outside this write set.
      - Treating overlay symbols as proof of zero callers or zero impact.
    required_validation:
      - cd ontoindex && npx vitest run test/unit/overlay-context-impact.test.ts
      - cd ontoindex && npx tsc --noEmit
    validation_workspace:
      root: ontoindex
      inputs:
        - src/mcp/local/backend-overlay.ts
      generated_outputs:
        - dist/
    expected_evidence:
      - Impact for an overlay target returns risk UNKNOWN, never LOW or zero callers.
      - Context for an overlay target carries source overlay and no base process membership.
      - Non-overlay targets are unchanged.
    rollback:
      - Revert the write-set files.
    stop_conditions:
      - The hook needs a file outside the write set.
    known_blockers: []

  RT-9:
    title: When the overlay is built, initLbug opens its store with a bounded maxDBSize so the 8 TB default mmap cannot fail, and dirty-overlay-build.test.ts passes 30 of 30 consecutive runs
    status: OPEN
    classification: implementation-ready
    assurance_profile: full
    complexity: complex
    depends_on: []
    type: code
    validation_tier: unit-fast
    impact_risk: medium
    owner_files:
      - ontoindex/src/core/lbug/lbug-adapter.ts
      - ontoindex/src/core/run-analyze.ts
    allowed_write_set:
      - ontoindex/src/core/lbug/lbug-adapter.ts
      - ontoindex/src/core/run-analyze.ts
    non_goals:
      - Changing the default size for the active-generation build.
      - Editing pool-adapter.ts.
    required_validation:
      - cd ontoindex && for i in $(seq 1 30); do npx vitest run test/unit/dirty-overlay-build.test.ts || exit 1; done
      - cd ontoindex && npx tsc --noEmit
    validation_workspace:
      root: ontoindex
      inputs:
        - src/core/lbug/lbug-adapter.ts
      generated_outputs:
        - dist/
    expected_evidence:
      - initLbug accepts an optional maxDBSize; the default call path is unchanged and passes no new argument.
      - The overlay build passes a bounded power-of-two size; a database created that way is readable by the pool adapter.
      - dirty-overlay-build.test.ts passes 30 of 30 consecutive runs (it failed 1 of 10 before).
    rollback:
      - Revert the write-set files.
    stop_conditions:
      - lbug rejects the bounded size or cannot reopen the store.
      - Write set must grow.
    known_blockers: []

  RT-10:
    title: When a relative import ends in .js, .jsx, .mjs or .cjs and only the matching .ts, .tsx, .mts or .cts file exists, the import resolver links it to that file so IMPORTS and cross-file CALLS edges exist
    status: OPEN
    classification: implementation-ready
    assurance_profile: full
    complexity: complex
    depends_on: []
    type: code
    validation_tier: unit-fast
    impact_risk: high
    owner_files:
      - ontoindex/src/core/ingestion/import-resolvers/utils.ts
      - ontoindex/src/core/ingestion/import-resolvers/standard.ts
      - ontoindex/test/unit/import-resolver-js-extension.test.ts
    allowed_write_set:
      - ontoindex/src/core/ingestion/import-resolvers/utils.ts
      - ontoindex/src/core/ingestion/import-resolvers/standard.ts
      - ontoindex/test/unit/import-resolver-js-extension.test.ts
    non_goals:
      - Changing non-relative (package or alias) resolution: the .js-to-.ts fallback is opt-in per call and only standard.ts relative-import branch passes it.
      - Changing other languages' resolvers.
    required_validation:
      - cd ontoindex && npx vitest run test/unit/import-resolver-js-extension.test.ts
      - cd ontoindex && npx vitest run test/unit --reporter=dot -t resolver
      - cd ontoindex && npx tsc --noEmit
    validation_workspace:
      root: ontoindex
      inputs:
        - src/core/ingestion/import-resolvers/utils.ts
      generated_outputs:
        - dist/
    expected_evidence:
      - A fixture with import './a.js' where only a.ts exists yields an IMPORTS edge and a CALLS edge to the imported function (before: none; extensionless './a' already worked).
      - If a real a.js exists it still wins over a.ts.
      - Resolution adds only Set lookups, no extra IO; the existing resolver tests pass unchanged.
      - Re-analyzing this repo raises tsToTs IMPORTS well above 294 and gives runImpactKernel callers.
    rollback:
      - Revert the write-set files.
    stop_conditions:
      - Behavior change breaks an existing resolver test and the test cannot be explained by the fix.
      - Write set must grow.
    known_blockers: []

  RT-11:
    title: When the overlay store is rebuilt while the MCP server is running, the next overlay read opens the new store and never reads the deleted one, and concurrent calls share one dirty-file probe
    status: OPEN
    classification: implementation-ready
    assurance_profile: full
    complexity: complex
    depends_on: []
    type: code
    validation_tier: unit-fast
    impact_risk: high
    owner_files:
      - ontoindex/src/mcp/local/backend-overlay.ts
      - ontoindex/test/unit/backend-overlay.test.ts
    allowed_write_set:
      - ontoindex/src/mcp/local/backend-overlay.ts
      - ontoindex/test/unit/backend-overlay.test.ts
    non_goals:
      - Auto-spawning rebuilds from read tools (opt-in watcher only).
      - Editing pool-adapter.ts.
    required_validation:
      - cd ontoindex && npx vitest run test/unit/backend-overlay.test.ts
      - cd ontoindex && npx tsc --noEmit
    validation_workspace:
      root: ontoindex
      inputs:
        - src/mcp/local/backend-overlay.ts
      generated_outputs:
        - dist/
    expected_evidence:
      - A test builds an overlay, queries it through the real pool, rebuilds it with different symbols, queries again and sees the new symbols (the pool handle is closed and reopened when the store file identity changes).
      - Ten concurrent getOverlaySnapshot calls run one git probe (single-flight), and the cache TTL behavior is unchanged.
      - Overlay read failures still degrade to base-only.
    rollback:
      - Revert the write-set files.
    stop_conditions:
      - Closing the overlay handle requires editing pool-adapter.ts.
      - Write set must grow.
    known_blockers: []

  RT-12:
    title: When an upstream or downstream traversal from a clean target reaches a dirty file, that row is returned flagged dirty, is not expanded further, and the result is marked partial with a warning
    status: OPEN
    classification: implementation-ready
    assurance_profile: full
    complexity: complex
    depends_on: []
    type: code
    validation_tier: unit-fast
    impact_risk: high
    owner_files:
      - ontoindex/src/core/impact/impact-kernel.ts
      - ontoindex/src/mcp/local/backend-impact.ts
      - ontoindex/test/unit/impact-kernel-dirty.test.ts
    allowed_write_set:
      - ontoindex/src/core/impact/impact-kernel.ts
      - ontoindex/src/mcp/local/backend-impact.ts
      - ontoindex/test/unit/impact-kernel-dirty.test.ts
    non_goals:
      - Dropping dirty rows (that would understate risk).
      - Changing the shape of results for callers that pass no dirty set.
    required_validation:
      - cd ontoindex && npx vitest run test/unit/impact-kernel-dirty.test.ts
      - cd ontoindex && npx vitest run $(find test/unit -maxdepth 1 -name '*.test.ts' | grep -E 'impact|safe-edit' | sort)
      - cd ontoindex && npx tsc --noEmit
    validation_workspace:
      root: ontoindex
      inputs:
        - src/core/impact/impact-kernel.ts
      generated_outputs:
        - dist/
    expected_evidence:
      - A row whose filePath is in the dirty set is kept (never silently dropped), carries dirty true, and its id is not added to the next frontier.
      - traversalComplete is false and a warning names the dirty path.
      - With no dirty set supplied, results are byte-identical to today (existing impact tests unchanged).
    rollback:
      - Revert the write-set files.
    stop_conditions:
      - Existing impact-kernel tests need to change.
      - Write set must grow.
    known_blockers: []

  RT-13:
    title: When ontoindex watch is run, saving source files triggers one debounced child analyze --dirty-overlay and is skipped while analyze.lock is held
    status: OPEN
    classification: implementation-ready
    assurance_profile: full
    complexity: complex
    depends_on: []
    type: code
    validation_tier: unit-fast
    impact_risk: medium
    owner_files:
      - ontoindex/src/cli/watch.ts
      - ontoindex/src/cli/index.ts
      - ontoindex/test/unit/watch-command.test.ts
    allowed_write_set:
      - ontoindex/src/cli/watch.ts
      - ontoindex/src/cli/index.ts
      - ontoindex/test/unit/watch-command.test.ts
    non_goals:
      - Embeddings from the watcher.
      - A new npm dependency.
    required_validation:
      - cd ontoindex && npx vitest run test/unit/watch-command.test.ts test/unit/watch.test.ts
      - cd ontoindex && npx vitest run test/unit/cli-index-help.test.ts
      - cd ontoindex && npx tsc --noEmit
    validation_workspace:
      root: ontoindex
      inputs:
        - src/cli/watch.ts
      generated_outputs:
        - dist/
    expected_evidence:
      - The command is registered and listed in ontoindex --help.
      - A burst of saves spawns exactly one child overlay build; a save during an active build schedules at most one follow-up.
      - A held analyze.lock skips the refresh with a log line; a failing child is logged and the watcher keeps running; Ctrl-C stops the watcher and kills any child.
    rollback:
      - Revert the write-set files.
    stop_conditions:
      - The child cannot be spawned without editing run-analyze.ts or analyze.ts.
      - Write set must grow.
    known_blockers: []

  RT-14:
    title: When a fixture repo uses NodeNext .js import specifiers, the real analyze pipeline produces the exact IMPORTS and CALLS edges between its files, so a regression in the .js-to-.ts mapping fails a test
    status: OPEN
    classification: implementation-ready
    assurance_profile: full
    complexity: complex
    depends_on: []
    type: code
    validation_tier: unit-fast
    impact_risk: low
    owner_files:
      - ontoindex/test/integration/js-specifier-edges.test.ts
    allowed_write_set:
      - ontoindex/test/integration/js-specifier-edges.test.ts
    non_goals:
      - Editing production code.
      - Checking edge counts of this repo.
    required_validation:
      - cd ontoindex && npx vitest run test/integration/js-specifier-edges.test.ts
      - cd ontoindex && npx tsc --noEmit
    validation_workspace:
      root: ontoindex
      inputs:
        - test/integration/js-specifier-edges.test.ts
      generated_outputs:
        - dist/
    expected_evidence:
      - A fixture with a.ts, b.ts (import './a.js'), c.ts (import './a'), d.ts (import './sub/index.js' where only sub/index.ts exists) and e.ts (alias-free .mjs specifier to f.mts) yields IMPORTS b->a, c->a, d->sub/index, e->f and CALLS from each caller to the callee.
      - A file importing './missing.js' with no .ts or .js file yields no edge.
      - The test runs the real pipeline (not mocks) and finishes in under 30 s.
    rollback:
      - Revert the write-set files.
    stop_conditions:
      - The real pipeline cannot be run from a test without editing production code.
    known_blockers: []

  RT-15:
    title: When ontoindex watch starts it prints one line naming the watched root, the debounce, and whether the tree is clean or dirty, and when idle it stays silent
    status: OPEN
    classification: implementation-ready
    assurance_profile: full
    complexity: complex
    depends_on: []
    type: code
    validation_tier: unit-fast
    impact_risk: low
    owner_files:
      - ontoindex/src/cli/watch.ts
      - ontoindex/test/unit/watch-command.test.ts
    allowed_write_set:
      - ontoindex/src/cli/watch.ts
      - ontoindex/test/unit/watch-command.test.ts
    non_goals:
      - Changing refresh, lock, or spawn behavior.
      - Editing index.ts.
    required_validation:
      - cd ontoindex && npx vitest run test/unit/watch-command.test.ts test/unit/watch.test.ts
      - cd ontoindex && npx tsc --noEmit
    validation_workspace:
      root: ontoindex
      inputs:
        - src/cli/watch.ts
      generated_outputs:
        - dist/
    expected_evidence:
      - Startup logs exactly one line containing the root path and debounce milliseconds.
      - A clean tree logs a clean-tree note, a dirty tree logs the dirty file count before the first build.
      - No periodic output while idle.
      - The existing watch tests still pass.
    rollback:
      - Revert the write-set files.
    stop_conditions:
      - The change needs a file outside the write set.
    known_blockers: []

  RT-16:
    title: When the overlay is built for 1, 10, 25 and 50 dirty files on this repo, a benchmark script records wall time per size so later performance claims are backed by numbers
    status: OPEN
    classification: implementation-ready
    assurance_profile: full
    complexity: complex
    depends_on: []
    type: code
    validation_tier: unit-fast
    impact_risk: low
    owner_files:
      - ontoindex/scripts/overlay-benchmark.mjs
    allowed_write_set:
      - ontoindex/scripts/overlay-benchmark.mjs
    non_goals:
      - Changing any production code or adding a CI job.
    required_validation:
      - cd ontoindex && npm run build && node scripts/overlay-benchmark.mjs
    validation_workspace:
      root: ontoindex
      inputs:
        - scripts/overlay-benchmark.mjs
      generated_outputs:
        - dist/
    expected_evidence:
      - The script copies N tracked source files into a temp git clone with a one-line edit, runs the built CLI analyze --dirty-overlay once warm, and prints wall time and node and edge counts per N as JSON.
      - It prints a summary table and exits nonzero if any build fails.
      - Results for 1, 10, 25 and 50 files are reported in the closeout with the machine and commit.
    rollback:
      - Revert the write-set files.
    stop_conditions:
      - The script needs network access or the repo's live .ontoindex.
    known_blockers: []
```

## Required Traceability

| Requirement ID | ADR/user requirement | Disposition | Task IDs | Validation |
| --- | --- | --- | --- | --- |
| RT-REQ-1 | Tool results flag which returned files are dirty | implementation | RT-1 | target-context and envelope tests |
| RT-REQ-2 | Dirty files get a separate overlay graph that never mutates the active generation | implementation | RT-2, RT-3 | dirty-overlay build and plan tests |
| RT-REQ-3 | A debounced watcher keeps the overlay current | implementation | RT-4 | watch tests |
| RT-REQ-4 | Queries serve dirty paths from the overlay | proof-only | RT-5 | read-path spike |
| RT-REQ-5 | Embeddings are not refreshed for the overlay | non-goal | RT-2 | documented limit |
| RT-REQ-6 | Queries, symbol lookup, context and impact serve dirty paths from the overlay without claiming zero impact | implementation | RT-6, RT-7, RT-8 | overlay merge, resolution and context/impact tests |
| RT-REQ-7 | The overlay build does not flake on the default 8 TB mmap | implementation | RT-9 | 30 consecutive passing runs |
| RT-REQ-8 | NodeNext .js imports resolve to .ts so the graph has real cross-file edges | implementation | RT-10 | resolver fixture and re-analysis |
| RT-REQ-9 | A rebuilt overlay is picked up by a running server | implementation | RT-11 | rebuild-then-query test |
| RT-REQ-10 | Impact flags dirty rows instead of trusting stale ids | implementation | RT-12 | impact-kernel-dirty tests |
| RT-REQ-11 | A watch command keeps the overlay current | implementation | RT-13 | watch-command tests |
| RT-REQ-12 | A regression in .js-to-.ts mapping fails a real-pipeline test | implementation | RT-14 | js-specifier-edges integration test |
| RT-REQ-13 | The watcher says what it is doing at startup | implementation | RT-15 | watch-command tests |
| RT-REQ-14 | Overlay performance is measured, not assumed | proof-only | RT-16 | benchmark output |

## Decisions And Non-Goals

- 2026-10-10 finding: `--experimental-file-delta` replaces the active generation with only the changed files (32 nodes became 4 on a probe repo, status degraded). Allowing it on dirty trees would wipe the index, so the original RT-2 and RT-3 were dropped.
- Chosen design: overlay generation. The bounded pipeline writes to `<storage>/overlay` and is never activated; the base stays intact and the overlay is disposable.
- Rejected: in-place graph patching (writer-lock and lost cross-file edges), per-state snapshots (minutes per state), per-file parse cache with full relink (large refactor; revisit later).
- Vector search lags on edited files until a full `analyze --embeddings`.

- 2026-10-10 review findings: (1) the import resolver never maps .js to .ts, so most cross-file edges are missing for NodeNext TypeScript (2157 of 2163 relative imports in this repo end in .js; impact on runImpactKernel showed 0 callers); (2) the overlay pool handle is cached by id while the overlay directory is deleted and recreated on rebuild; (3) dirty-overlay-build.test.ts flaked 1 of 10 on an 8 TB mmap. Cherry-picked: RT-10, RT-9, RT-11 (single-flight probe plus handle invalidation), RT-12 (flag, do not drop), RT-13. Dropped A3 (lazy auto-spawn from read tools): the watcher already exists and a read tool spawning processes is a surprising side effect.

- 2026-10-10 CI review: PR 83 is based on the PR 82 branch, so ci.yml (branches: [master]) never ran against RT-1..RT-13; only benchmark and the broken check job run. Reproduced locally instead: prettier, eslint (0 errors), tsc, web tsc -b, unit tests. The check job fails on every PR in its history because ontoindex-check.yml lacks `permissions: pull-requests: write` (Comment PR gets `Resource not accessible by integration`); fixing it is a repo-permission change left to the owner. Merging 82 and retargeting 83 is also left to the owner.
- Chosen next: RT-14 (permanent regression test for the highest-risk change), RT-15 (watcher startup line), RT-16 (measure before tuning). Rejected: throwaway master PR (duplicates the diff), continue-on-error for the comment step (hides a signal), watcher status reporting in doctor (touches shared status code), .git/index-mtime snapshot cache (premature without RT-16 numbers).

## Closeout

RT-1 (2026-10-10), implemented locally in PR 83 without sub-agent role receipts, so it stays OPEN here until reviewed by the gates: `dirtyWorkspace.dirtyPaths` (cap 50, `dirtyPathsTruncated`) added in target-context.ts; `freshness.dirtyResultPaths` added in response-envelope.ts (bounded scan of filePath/path/file in results). 6 new tests pass; 41/41 in the two touched files; tsc clean. Full unit run: 6885 pass, 4 fail in mcp-doctor.test.ts, which fail identically on unmodified master. Per-result `stale` markers were not added; only the path list on freshness.

2026-10-10 sub-agent phase (parent verified diffs, ran tsc, prettier, and the full unit suite; 6899 pass, 4 pre-existing mcp-doctor failures):
- RT-2 (gpt-6.1-sol): `analyze --dirty-overlay` builds a disposable store at `.ontoindex/overlay` and never activates a generation. I added the CLI flag registration the agent was blocked on. Live check: 8 dirty files gave 442 nodes; the active `meta.json` md5 was identical before and after.
- RT-3 (gpt-6-luna): `planDirtyOverlay` in analyze-delta.ts (append-only); 7 tests including rename, delete, AD/DU, spaces, and the 50-file cap.
- RT-4 (gpt-6-luna): `createDebouncedWatcher` in src/cli/watch.ts, dependency-free, lock-aware, injected refresh. Not registered as a CLI command and not yet wired to the overlay build.
- RT-5 (gpt-6.1-sol): read-only spike, report in RT5_READ_PATH_SPIKE_REPORT.md. No single merge point exists; minimum is query merge in backend-search.ts, shared symbol resolution, context gating, impact pre-BFS. Overlay is symbols-only so impact must report UNKNOWN, not zero. A second read-only handle is feasible through the MCP pool, not the writer singleton.
- Note: the agents were told the "4 sub-agents" rule does not apply to leaf workers; the first Luna dispatch stopped on it and was re-dispatched.
- Statuses left OPEN: no authenticated role receipts exist (dispatch was not through the manager loop).

2026-10-10 query-path phase. I wrote backend-overlay.ts (snapshot, isDirtyPath, queryOverlay on a distinct pool id, 2s TTL cache; usable only when the overlay is newer than every dirty file) and its test; sub-agents did the hooks. Parent verified: tsc clean, prettier clean on touched files, 6930 unit tests pass with the same 4 pre-existing mcp-doctor failures.
- RT-6 (gpt-6.1-sol): backend-search.ts drops dirty base candidates and merges overlay symbols before ranking; bypasses the structured cache when usable.
- RT-7 (gpt-6-luna): shared resolver merges overlay candidates, drops dirty base candidates, tags source overlay. Activates only when the repo handle carries repoPath and storagePath.
- RT-8 (gpt-6.1-sol): context and impact pass those fields; overlay targets get source overlay, impact returns risk UNKNOWN with graphImpactAvailable false.
- Live end-to-end check on a scratch repo (real built CLI): a symbol that exists only in a dirty file is found by query, context, and impact with source overlay; impact says UNKNOWN; a clean symbol is unchanged (LOW); after touching the dirty file the overlay is treated as stale and results fall back to base only.
- Known gaps: impact-kernel.ts:344-364 does not filter dirty paths, so stale dirty IDs can still enter the BFS from a clean target (not changed). Callers backend-move-symbol, backend-extract-function, backend-symbol-mutations still omit storagePath, so mutations stay base-only (intended: do not edit from an overlay). Overlay has no embeddings. The watcher is not registered or wired to the overlay build. Statuses stay OPEN: no authenticated role receipts.

2026-10-10 hardening phase (5 sub-agents: gpt-6.1-sol on RT-10/11/12, gpt-6-luna on RT-9/13). Parent verified: tsc clean, prettier clean on every touched file, 7018 unit tests pass with the same 4 pre-existing mcp-doctor failures, overlay-build test 30/30 runs (was 1 failure in 10).
- RT-10: the import resolver now maps ./a.js to a.ts (opt-in per call, TS/JS relative imports only). Measured on this repo after `analyze --force`: ts-to-ts IMPORTS edges 294 -> 3578; cross-file CALLS 1419 -> 4239; `runImpactKernel` callers 0 -> 4 (diff-review, write-through-verification, safe-edit-check, backend-impact). This was a pre-existing indexer bug that made every impact/context answer about NodeNext TypeScript under-report callers.
- RT-9: initLbug takes an optional maxDBSize; only the overlay build passes 4 GiB (2**32; note 1<<32 is 0 in JS). Default path unchanged. A bounded store is readable by the pool adapter.
- RT-11: overlay pool handle is invalidated when the store file identity changes or disappears; failed snapshot computations are not cached; concurrent probes are single-flight.
- RT-12: impact traversal keeps dirty rows, flags them dirty, does not expand through them, and marks the result partial with one warning. No dirty set means identical output.
- RT-13: `ontoindex watch [path]` registered; spawns a child `analyze --dirty-overlay` per debounced burst, honors analyze.lock, strips embedding env from the child.
- Side effect to note: `analyze --force` without --embeddings drops the semantic index; embeddings are rebuilt separately.
- Statuses stay OPEN: no authenticated role receipts exist.

2026-10-10 verification phase (3 sub-agents: gpt-6.1-sol on RT-14 and RT-16, gpt-6-luna on RT-15). Parent re-ran: tsc clean, prettier clean, 20 tests in the touched suites, and the benchmark.
- Local CI reproduction on commit 61f0b6c: prettier (root) clean; eslint 0 errors (4622 pre-existing warnings); tsc (ontoindex) clean; tsc -b (ontoindex-web) clean; unit suite with the CI coverage flags: 7018 pass, 4 pre-existing mcp-doctor failures; coverage 70.2% statements, 59.5% branches, 78.2% functions, 72.7% lines against CI floors 26/23/28/27. Windows and macOS jobs were not reproduced locally.
- RT-14: js-specifier-edges integration test runs the real pipeline and asserts exact edges (b->a, c->a, d->sub/index, e->f, no edge for a missing target). It fails on c1767b5 (only c->a resolves) and passes 5/5 on the fixed tree.
- RT-15: `ontoindex watch` prints one startup line, e.g. `Watching <root> (debounce 750 ms); tree is clean`, and nothing while idle.
- RT-16: overlay-benchmark.mjs measured `analyze --dirty-overlay` (Ryzen 9 9950X, commit 61f0b6c, baseline full analyze about 38-39 s). Warm medians: 1 file 0.86 s, 10 files 2.3-2.4 s, 25 files 1.2 s, 50 files 1.4 s. Timing does NOT grow with file count because the benchmark picks files in sorted path order, so the 10-file set contains heavier files than the 25- and 50-file sets; the numbers show cost is dominated by which files are dirty, not how many, and an overlay build is 15-40x cheaper than a full analyze. They are not a scaling law. Warm medians come from 2 runs on a shared host.
- Statuses stay OPEN: no authenticated role receipts exist.

