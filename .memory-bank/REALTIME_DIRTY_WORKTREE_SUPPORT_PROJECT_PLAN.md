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

  RT-17:
    title: When a TS or JS file imports ./dir.js and only dir/index.ts exists, the resolver links the import to dir/index.ts, and a real a.js or dir.ts still wins
    status: OPEN
    classification: implementation-ready
    assurance_profile: full
    complexity: complex
    depends_on: []
    type: code
    validation_tier: unit-fast
    impact_risk: low
    owner_files:
      - ontoindex/src/core/ingestion/import-resolvers/utils.ts
      - ontoindex/test/unit/import-resolver-js-extension.test.ts
    allowed_write_set:
      - ontoindex/src/core/ingestion/import-resolvers/utils.ts
      - ontoindex/test/unit/import-resolver-js-extension.test.ts
    non_goals:
      - Changing the opt-in rule: still only the relative TS/JS branch of standard.ts.
      - Editing standard.ts.
    required_validation:
      - cd ontoindex && npx vitest run test/unit/import-resolver-js-extension.test.ts test/integration/js-specifier-edges.test.ts
      - cd ontoindex && npx tsc --noEmit
    validation_workspace:
      root: ontoindex
      inputs:
        - src/core/ingestion/import-resolvers/utils.ts
      generated_outputs:
        - dist/
    expected_evidence:
      - ./dir.js resolves to dir/index.ts when neither dir.js nor dir.ts exists (found on a scratch repo: before, u1.ts had no IMPORTS edge).
      - ./dir.js still resolves to dir.ts when both dir.ts and dir/index.ts exist.
      - ./dir.mjs resolves to dir/index.mts and ./dir.jsx to dir/index.tsx; aliases and other languages are still not remapped.
      - All 66 existing resolver tests pass unchanged.
    rollback:
      - Revert the write-set files.
    stop_conditions:
      - The fix needs standard.ts or another file.
    known_blockers: []

  RT-18:
    title: When an editor saves by writing a temp file and renaming it over the original, by delete-then-create, or by in-place truncate, the watcher triggers exactly one overlay refresh per save and the new content is queryable
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
      - ontoindex/test/unit/watch-save-patterns.test.ts
    allowed_write_set:
      - ontoindex/src/cli/watch.ts
      - ontoindex/test/unit/watch-save-patterns.test.ts
    non_goals:
      - Adding a dependency.
      - Changing refresh, lock, or spawn behavior beyond what the save patterns need.
    required_validation:
      - cd ontoindex && npx vitest run test/unit/watch-save-patterns.test.ts test/unit/watch.test.ts test/unit/watch-command.test.ts
      - cd ontoindex && npx tsc --noEmit
    validation_workspace:
      root: ontoindex
      inputs:
        - src/cli/watch.ts
      generated_outputs:
        - dist/
    expected_evidence:
      - A test with real files in a temp git repo and the real createDebouncedWatcher (no watchImpl mock) performs each save pattern and observes exactly one refresh after the debounce.
      - A backup-suffix file (a.ts~, .a.ts.swp, a.ts.tmp) never triggers a refresh by itself, but the rename onto a.ts does.
      - A watcher whose root is deleted and recreated does not crash the process; the failure is logged.
      - Existing watch tests still pass.
    rollback:
      - Revert the write-set files.
    stop_conditions:
      - Node fs.watch cannot deliver the rename event on this platform (report which pattern and why).
      - The fix needs a file outside the write set.
    known_blockers: []

  RT-19:
    title: When dirty paths, overlay snapshots, the watcher ignore filter, and the planner receive backslash or mixed-separator paths as Windows produces them, they behave identically to forward-slash paths
    status: OPEN
    classification: implementation-ready
    assurance_profile: full
    complexity: complex
    depends_on: []
    type: code
    validation_tier: unit-fast
    impact_risk: low
    owner_files:
      - ontoindex/test/unit/windows-path-handling.test.ts
    allowed_write_set:
      - ontoindex/test/unit/windows-path-handling.test.ts
    non_goals:
      - Editing production code (report defects instead).
      - Running on Windows.
    required_validation:
      - cd ontoindex && npx vitest run test/unit/windows-path-handling.test.ts
      - cd ontoindex && npx tsc --noEmit
    validation_workspace:
      root: ontoindex
      inputs:
        - test/unit/windows-path-handling.test.ts
      generated_outputs:
        - dist/
    expected_evidence:
      - Tests feed backslash and mixed-separator paths through isDirtyPath, findDirtyResultPaths, the watcher ignore function, and the planDirtyOverlay porcelain parser (use forward-slash porcelain output, since git emits those on Windows too).
      - Each case asserts the same result as the forward-slash form; a case that exposes a real defect is reported with the failing input (do not fix production code in this task).
      - No test depends on the host OS.
    rollback:
      - Revert the write-set files.
    stop_conditions:
      - Testing requires exporting a private function from production code.
    known_blockers: []

  RT-20:
    title: A reader of the docs can find what --dirty-overlay, ontoindex watch, freshness.dirtyResultPaths, and source overlay mean, when to use them, and their limits
    status: OPEN
    classification: implementation-ready
    assurance_profile: full
    complexity: complex
    depends_on: []
    type: documentation
    validation_tier: unit-fast
    impact_risk: low
    owner_files:
      - .memory-bank/knowledge-hub/dirty-worktree.md
    allowed_write_set:
      - .memory-bank/knowledge-hub/dirty-worktree.md
    non_goals:
      - Editing code or README.
      - Claiming behavior that was not verified.
    required_validation:
      - npx prettier --check .memory-bank/knowledge-hub/dirty-worktree.md
    validation_workspace:
      root: .
      inputs:
        - .memory-bank/knowledge-hub/dirty-worktree.md
      generated_outputs:
        - dist/
    expected_evidence:
      - The page states: how to build an overlay, how to run watch, the 50-file limit, that the overlay has symbols only (no edges, no embeddings), that impact on an overlay symbol returns UNKNOWN, what dirtyWorkspace.dirtyPaths and freshness.dirtyResultPaths contain, and that the overlay is treated as stale once a dirty file is saved after the build.
      - Every command and field name on the page was checked against the code (cite the file for each).
      - It lists measured build times from the benchmark with the caveat that they are not a scaling law.
    rollback:
      - Revert the write-set files.
    stop_conditions:
      - A claimed behavior cannot be confirmed in the code.
    known_blockers: []

  RT-21:
    title: When move_symbol, extract_function, or a symbol mutation targets a symbol in a file with uncommitted changes and its line range did not come from a usable overlay, a real write is refused before any file is touched and a dry run carries a stale-lines warning
    status: OPEN
    classification: implementation-ready
    assurance_profile: full
    complexity: complex
    depends_on: []
    type: code
    validation_tier: unit-fast
    impact_risk: high
    owner_files:
      - ontoindex/src/mcp/local/backend-move-symbol.ts
      - ontoindex/src/mcp/local/backend-extract-function.ts
      - ontoindex/src/mcp/local/backend-symbol-mutations.ts
      - ontoindex/test/unit/mutation-dirty-guard.test.ts
    allowed_write_set:
      - ontoindex/src/mcp/local/backend-move-symbol.ts
      - ontoindex/src/mcp/local/backend-extract-function.ts
      - ontoindex/src/mcp/local/backend-symbol-mutations.ts
      - ontoindex/test/unit/mutation-dirty-guard.test.ts
    non_goals:
      - Changing the resolver or overlay code.
      - Blocking mutations on clean files.
      - Enabling writes on the MCP server.
    required_validation:
      - cd ontoindex && npx vitest run test/unit/mutation-dirty-guard.test.ts
      - cd ontoindex && npx tsc --noEmit
    validation_workspace:
      root: ontoindex
      inputs:
        - src/mcp/local/backend-move-symbol.ts
      generated_outputs:
        - dist/
    expected_evidence:
      - A reproduction on a temp copy shows the defect first - a dirty file whose lines shifted makes the real write cut the wrong lines.
      - With the same setup after the fix, the real write throws before any file changes and the file content is byte-identical.
      - A dry run on that file returns success with a warning naming the dirty file.
      - Clean files and overlay-sourced symbols behave as before.
    rollback:
      - Revert the write-set files.
    stop_conditions:
      - The guard needs a file outside the write set.
      - The dirty probe cannot be called from the mutation modules without changing the resolver.
    known_blockers: []

  RT-22:
    title: When mutation-dirty-guard tests assert error and warning text containing a file path, they match both separators, and pass on Linux and on a Windows path form
    status: OPEN
    classification: implementation-ready
    assurance_profile: full
    complexity: complex
    depends_on: []
    type: code
    validation_tier: unit-fast
    impact_risk: low
    owner_files:
      - ontoindex/test/unit/mutation-dirty-guard.test.ts
    allowed_write_set:
      - ontoindex/test/unit/mutation-dirty-guard.test.ts
    non_goals:
      - Editing production code.
    required_validation:
      - cd ontoindex && npx vitest run test/unit/mutation-dirty-guard.test.ts
      - cd ontoindex && npx tsc --noEmit
    validation_workspace:
      root: ontoindex
      inputs:
        - test/unit/mutation-dirty-guard.test.ts
      generated_outputs:
        - dist/
    expected_evidence:
      - The four failing assertions (regexes with src\\/a\\.ts) match a message containing C:\\Users\\...\\src\\a.ts and one containing src/a.ts.
      - A direct unit test calls the production message builder (or guardMutationRange with a Windows-style absolute symbol.filePath and a repo path) and asserts the guard still detects the dirty file when the path is absolute with backslashes.
      - Passes on Linux; the fix to the production relative-path logic, if one is needed, is reported rather than made.
    rollback:
      - Revert the write-set files.
    stop_conditions:
      - guardMutationRange mis-detects dirty files for Windows absolute paths (report it).
    known_blockers: []

  RT-23:
    title: When the overlay build and overlay pool tests run on Windows, every LadybugDB handle on a store is closed before the test deletes, renames, or rebuilds that store
    status: OPEN
    classification: implementation-ready
    assurance_profile: full
    complexity: complex
    depends_on: []
    type: code
    validation_tier: unit-fast
    impact_risk: medium
    owner_files:
      - ontoindex/test/unit/dirty-overlay-build.test.ts
      - ontoindex/test/unit/backend-overlay.test.ts
    allowed_write_set:
      - ontoindex/test/unit/dirty-overlay-build.test.ts
      - ontoindex/test/unit/backend-overlay.test.ts
    non_goals:
      - Editing production code (report instead).
      - Changing the overlay design.
    required_validation:
      - cd ontoindex && npx vitest run test/unit/dirty-overlay-build.test.ts test/unit/backend-overlay.test.ts
      - cd ontoindex && npx tsc --noEmit
    validation_workspace:
      root: ontoindex
      inputs:
        - test/unit/dirty-overlay-build.test.ts
      generated_outputs:
        - dist/
    expected_evidence:
      - Read the Windows CI log in /tmp/win.clean: EPERM on rename of .ontoindex/generations/.staging-baseline-... in dirty-overlay-build.test.ts line 70 (activateIndexGeneration while a handle may still be open), and 'Cannot read from file ... locked a portion of the file' reading a rebuilt overlay in backend-overlay.test.ts.
      - For each, classify as test ordering (handle still open) or a production defect (overlay pool or builder keeps a handle). Test-ordering causes are fixed in the test; production causes are reported with the exact lines.
      - On Linux the tests still pass 20 of 20 runs.
      - Where a close really cannot be guaranteed on Windows, the test is skipped with it.skipIf(process.platform === 'win32') plus a comment naming the lock and a plan reference, never silently.
    rollback:
      - Revert the write-set files.
    stop_conditions:
      - The cause is a production handle leak (report it with file and line).
    known_blockers: []

  RT-24:
    title: When the real fs.watch save-pattern tests run on macOS, each is either proven to pass there or explicitly skipped on darwin with the reason recorded, because the failure could not be reproduced locally
    status: OPEN
    classification: implementation-ready
    assurance_profile: full
    complexity: complex
    depends_on: []
    type: code
    validation_tier: unit-fast
    impact_risk: low
    owner_files:
      - ontoindex/test/unit/watch-save-patterns.test.ts
    allowed_write_set:
      - ontoindex/test/unit/watch-save-patterns.test.ts
    non_goals:
      - Editing watch.ts without a reproduced cause.
    required_validation:
      - cd ontoindex && npx vitest run test/unit/watch-save-patterns.test.ts
      - cd ontoindex && npx tsc --noEmit
    validation_workspace:
      root: ontoindex
      inputs:
        - test/unit/watch-save-patterns.test.ts
      generated_outputs:
        - dist/
    expected_evidence:
      - Read the macOS CI log in /tmp/mac.clean: all 10 real-fs.watch tests observed 0 refreshes, including an in-place write.
      - Use fs.realpathSync on the temp root before creating the watcher and the files (macOS temp dirs live under a symlinked /var and /tmp), and widen SETTLE_MS on darwin; if that is not enough to explain it the test is skipped on darwin with a comment naming the observed symptom.
      - No production change in this task. Production watcher behavior on macOS stays unverified and is recorded as such.
      - On Linux the file still passes 15 of 15 runs.
    rollback:
      - Revert the write-set files.
    stop_conditions:
      - The cause appears to be in watch.ts itself rather than the test setup (report it).
    known_blockers: []

  RT-25:
    title: When an overlay is rebuilt while a reader has the previous one open, the builder publishes a new overlay generation and never deletes or rewrites a store that is open, so the reader keeps working on any OS and picks up the new generation on its next query
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
      - ontoindex/src/mcp/local/backend-overlay.ts
      - ontoindex/test/unit/overlay-generations.test.ts
      - ontoindex/src/cli/analyze.ts
      - ontoindex/scripts/overlay-benchmark.mjs
    allowed_write_set:
      - ontoindex/src/core/run-analyze.ts
      - ontoindex/src/mcp/local/backend-overlay.ts
      - ontoindex/test/unit/overlay-generations.test.ts
      - ontoindex/src/cli/analyze.ts
      - ontoindex/scripts/overlay-benchmark.mjs
    non_goals:
      - Changing the main index generation code in repo-manager.ts.
      - Cross-process locks or notifications.
      - Changing what the overlay contains.
    required_validation:
      - cd ontoindex && npx vitest run test/unit/overlay-generations.test.ts test/unit/backend-overlay.test.ts test/unit/dirty-overlay-build.test.ts test/unit/overlay-query-merge.test.ts test/unit/overlay-context-impact.test.ts
      - cd ontoindex && npx tsc --noEmit
    validation_workspace:
      root: ontoindex
      inputs:
        - src/core/run-analyze.ts
      generated_outputs:
        - dist/
    expected_evidence:
      - The builder writes <storage>/overlay/<generation>/lbug and then atomically replaces <storage>/overlay/CURRENT (write temp file, rename); it never removes a generation directory before publishing the new one.
      - After publishing, previous generations are removed best-effort; a removal that fails (a reader holds it) is ignored, logged at most once, and retried on the next build. At most 3 old generations are kept.
      - The reader resolves the path through CURRENT on every query; when CURRENT names a different generation it closes the old pool handle and opens the new one; a missing or unreadable CURRENT means no overlay (base-only), never an error.
      - 'A test with a real open reader on generation 1 builds generation 2 and asserts: the build succeeds, the open reader still answers from generation 1 until its next query, and the next query returns generation 2 symbols.'
      - A failed build leaves CURRENT and the previous generation untouched and removes only its own partial directory.
      - The three overlay tests skipped on win32 in RT-23 are re-enabled (no skipIf) because the delete-while-open path no longer exists; if one still cannot pass on Windows it stays skipped with the exact reason.
    rollback:
      - Revert the write-set files.
    stop_conditions:
      - The reader cannot be changed without editing pool-adapter.ts.
      - overlayDbPath is imported by files outside the write set and cannot stay backward compatible (check with ontoindex and grep first).
    known_blockers: []

  RT-26:
    title: When ontoindex status runs in a repo, it prints one overlay line saying whether an overlay exists, how many files it covers, when it was built, and whether it is usable or stale and why
    status: OPEN
    classification: implementation-ready
    assurance_profile: full
    complexity: complex
    depends_on: ['RT-25']
    type: code
    validation_tier: unit-fast
    impact_risk: low
    owner_files:
      - ontoindex/src/cli/status.ts
      - ontoindex/test/unit/status.test.ts
    allowed_write_set:
      - ontoindex/src/cli/status.ts
      - ontoindex/test/unit/status.test.ts
    non_goals:
      - Changing getOverlaySnapshot or the staleness rule.
      - JSON output changes beyond one additive field.
    required_validation:
      - cd ontoindex && npx vitest run test/unit/status.test.ts
      - cd ontoindex && npx tsc --noEmit
    validation_workspace:
      root: ontoindex
      inputs:
        - src/cli/status.ts
      generated_outputs:
        - dist/
    expected_evidence:
      - 'No overlay: no extra line, or a single neutral line when the tree is dirty and suggests ontoindex analyze --dirty-overlay.'
      - "Usable overlay: 'Overlay: usable, N file(s), built <relative time>'."
      - 'Stale overlay: names the reason (older than a dirty file, more than 50 dirty files, unreadable) using the same reason strings getOverlaySnapshot returns; no new staleness logic.'
      - Existing status tests pass unchanged.
    rollback:
      - Revert the write-set files.
    stop_conditions:
      - Reading the overlay needs files outside the write set.
    known_blockers: []

  RT-27:
    title: Before merge, the branch diff against master contains no machine-specific files and no leftover debris, and the findings are recorded
    status: OPEN
    classification: proof-only
    assurance_profile: full
    complexity: complex
    depends_on: []
    type: diagnostic
    validation_tier: unit-fast
    impact_risk: low
    owner_files:
      - .memory-bank/REALTIME_DIRTY_WORKTREE_SUPPORT_PROJECT_PLAN.md
    allowed_write_set: []
    non_goals:
      - Fixing findings inside this task.
    required_validation:
      - git diff origin/master...HEAD --name-status
    validation_workspace:
      root: .
      inputs:
        - .memory-bank/REALTIME_DIRTY_WORKTREE_SUPPORT_PROJECT_PLAN.md
      generated_outputs:
        - dist/
    expected_evidence:
      - The diff was listed and each non-source file justified; machine paths, TODO or debugger additions and temporary files were searched for.
      - The shared .mcp.json edit that pointed at this machine was found and reverted in commit 7759d27.
    rollback:
      - Not applicable.
    stop_conditions:
      - A finding cannot be resolved without editing outside the branch.
    known_blockers: []

  RT-28:
    title: With the built MCP server connected and ontoindex watch running on this repo, a real edit session keeps query and context answers current for the edited file and the run is recorded with timings and any failures
    status: OPEN
    classification: proof-only
    assurance_profile: full
    complexity: complex
    depends_on: [RT-25]
    type: diagnostic
    validation_tier: unit-fast
    impact_risk: low
    owner_files:
      - .memory-bank/REALTIME_DIRTY_WORKTREE_SUPPORT_PROJECT_PLAN.md
    allowed_write_set: []
    non_goals:
      - Fixing defects inside this task; each defect becomes its own task.
    required_validation:
      - node ontoindex/dist/cli/index.js watch
    validation_workspace:
      root: .
      inputs:
        - .memory-bank/REALTIME_DIRTY_WORKTREE_SUPPORT_PROJECT_PLAN.md
      generated_outputs:
        - dist/
    expected_evidence:
      - A scratch clone of this repo is edited by a script in at least five ways while a real MCP client session queries it, and for each edit the time until the new symbol is returned with source overlay is recorded.
      - Any stale answer, error, hang, or CPU spike is recorded with the exact step.
    rollback:
      - Delete the scratch clone.
    stop_conditions:
      - The live session cannot be driven without editing production code.
    known_blockers: []

  RT-36:
    title: When the indexed commit equals HEAD and the worktree is dirty, runtime health reports committed freshness, dirty-file overlay coverage, and embeddings as separate fields, and the overall state is not degraded unless the database itself is unusable
    status: OPEN
    classification: implementation-ready
    assurance_profile: full
    complexity: complex
    depends_on: []
    type: code
    validation_tier: unit-fast
    impact_risk: medium
    owner_files:
      - ontoindex/src/core/runtime/runtime-health.ts
      - ontoindex/test/unit/runtime-health.test.ts
    allowed_write_set:
      - ontoindex/src/core/runtime/runtime-health.ts
      - ontoindex/test/unit/runtime-health.test.ts
    non_goals:
      - Removing or renaming existing runtimeHealth fields; new fields are additive.
      - Changing the overlay staleness rule or getOverlaySnapshot.
      - Changing ontoindex status output (RT-26 owns it).
    required_validation:
      - cd ontoindex && npx vitest run test/unit/runtime-health.test.ts
      - cd ontoindex && npx tsc --noEmit
    validation_workspace:
      root: ontoindex
      inputs:
        - src/core/runtime/runtime-health.ts
      generated_outputs:
        - dist/
    expected_evidence:
      - 'Indexed commit equals HEAD with dirty files: committedFreshness is fresh, dirtyCoverage reports covered, uncovered, and overlay state, and degradedReason no longer says the whole index is degraded.'
      - 'Indexed commit differs from HEAD: state is stale, as before.'
      - 'Missing optional embeddings are reported in their own field and do not change freshnessState.'
      - 'A failed dirty-file scan reports dirtyCoverage unknown, never zero dirty files.'
      - Existing runtime-health tests pass unchanged or change only where the degraded label for a dirty-only tree is replaced.
    rollback:
      - Revert the write-set files.
    stop_conditions:
      - Consumers outside the write set break on the changed freshnessState value for a dirty-only tree.
      - Reading overlay coverage needs changes outside the write set.
    known_blockers: []

  RT-37:
    title: When a new base generation is published between a request's database pin and its metadata read, the request reports the metadata of the generation it actually queried and returns that generation id
    status: OPEN
    classification: implementation-ready
    assurance_profile: full
    complexity: complex
    depends_on: []
    type: code
    validation_tier: unit-fast
    impact_risk: high
    owner_files:
      - ontoindex/src/storage/repo-manager.ts
      - ontoindex/src/core/lbug/pool-adapter.ts
      - ontoindex/src/mcp/shared/target-context.ts
      - ontoindex/test/integration/lbug-pool-generation-swap.test.ts
    allowed_write_set:
      - ontoindex/src/storage/repo-manager.ts
      - ontoindex/src/core/lbug/pool-adapter.ts
      - ontoindex/src/mcp/shared/target-context.ts
      - ontoindex/test/integration/lbug-pool-generation-swap.test.ts
    non_goals:
      - Changing the publication lock, pointer swap, or retention policy.
      - A second metadata store.
    required_validation:
      - cd ontoindex && npx vitest run test/integration/lbug-pool-generation-swap.test.ts test/unit/target-context.test.ts test/unit/index-generation-retention.test.ts
      - cd ontoindex && npx tsc --noEmit
    validation_workspace:
      root: ontoindex
      inputs:
        - src/storage/repo-manager.ts
        - src/core/lbug/pool-adapter.ts
      generated_outputs:
        - dist/
    expected_evidence:
      - A test that pins generation N, publishes N+1, then reads metadata fails before the change by reporting N+1, and passes after it by reporting N.
      - The response carries the queried generation id.
      - A request opened after publication reports N+1.
    rollback:
      - Revert the write-set files.
    stop_conditions:
      - The reproduction test passes before any change (the mismatch is not real); record that and close as proof-only.
      - Binding metadata to the pin needs changes in local-backend-repo-runtime.ts or other files outside the write set.
    known_blockers: []

  RT-38:
    title: When the base generation or HEAD changes after an overlay is built, the overlay snapshot is unusable with a reason naming the base mismatch, so an old overlay is never served on top of a newer base
    status: OPEN
    classification: implementation-ready
    assurance_profile: full
    complexity: complex
    depends_on: []
    type: code
    validation_tier: unit-fast
    impact_risk: medium
    owner_files:
      - ontoindex/src/core/run-analyze.ts
      - ontoindex/src/mcp/local/backend-overlay.ts
      - ontoindex/test/unit/backend-overlay.test.ts
      - ontoindex/test/unit/dirty-overlay-build.test.ts
    allowed_write_set:
      - ontoindex/src/core/run-analyze.ts
      - ontoindex/src/mcp/local/backend-overlay.ts
      - ontoindex/test/unit/backend-overlay.test.ts
      - ontoindex/test/unit/dirty-overlay-build.test.ts
    non_goals:
      - Rebuilding the overlay automatically (RT-42 and RT-43 schedule rebuilds).
      - Changing the file-mtime staleness rule.
    required_validation:
      - cd ontoindex && npx vitest run test/unit/backend-overlay.test.ts test/unit/dirty-overlay-build.test.ts test/unit/overlay-generations.test.ts
      - cd ontoindex && npx tsc --noEmit
    validation_workspace:
      root: ontoindex
      inputs:
        - src/core/run-analyze.ts
        - src/mcp/local/backend-overlay.ts
      generated_outputs:
        - dist/
    expected_evidence:
      - Each overlay generation records the base generation id and base commit it was built against.
      - An overlay whose recorded base differs from the active base is unusable with a base-mismatch reason.
      - An overlay without recorded base data (built before this change) is unusable with a rebuild hint.
      - The snapshot cache is keyed by repository and base generation, so a base swap is seen within one probe.
    rollback:
      - Revert the write-set files; old overlays are rebuilt by the next analyze --dirty-overlay.
    stop_conditions:
      - Reading the active base generation needs files outside the write set.
    known_blockers: []

  RT-39:
    title: When more than 50 dirty source files exist, the overlay covers up to 50 of them, newest first, reports the rest as uncovered, and stays usable for the covered files instead of turning off for the whole repo
    status: OPEN
    classification: implementation-ready
    assurance_profile: full
    complexity: complex
    depends_on: [RT-38]
    type: code
    validation_tier: unit-fast
    impact_risk: high
    owner_files:
      - ontoindex/src/core/analyze-delta.ts
      - ontoindex/src/mcp/local/backend-overlay.ts
      - ontoindex/src/mcp/local/backend-search.ts
      - ontoindex/src/mcp/local/backend-symbol-resolution.ts
      - ontoindex/src/cli/analyze.ts
      - ontoindex/src/cli/watch.ts
      - ontoindex/test/unit/dirty-overlay-plan.test.ts
      - ontoindex/test/unit/backend-overlay.test.ts
    allowed_write_set:
      - ontoindex/src/core/analyze-delta.ts
      - ontoindex/src/mcp/local/backend-overlay.ts
      - ontoindex/src/mcp/local/backend-search.ts
      - ontoindex/src/mcp/local/backend-symbol-resolution.ts
      - ontoindex/src/cli/analyze.ts
      - ontoindex/src/cli/watch.ts
      - ontoindex/test/unit/dirty-overlay-plan.test.ts
      - ontoindex/test/unit/backend-overlay.test.ts
    non_goals:
      - Raising the 50-file cap.
      - Changing planExperimentalFileDeltaRefresh.
    required_validation:
      - cd ontoindex && npx vitest run test/unit/dirty-overlay-plan.test.ts test/unit/backend-overlay.test.ts test/unit/experimental-file-delta.test.ts test/unit/watch.test.ts
      - cd ontoindex && npx tsc --noEmit
    validation_workspace:
      root: ontoindex
      inputs:
        - src/core/analyze-delta.ts
        - src/mcp/local/backend-overlay.ts
      generated_outputs:
        - dist/
    expected_evidence:
      - 'With 75 dirty source files the plan returns 50 includePaths ordered by newest mtime and 25 uncoveredPaths; tombstones are always included.'
      - 'The snapshot keeps dirtyPaths as every dirty source path, so isDirtyPath, impact traversal, and the mutation guard still treat uncovered files as dirty.'
      - 'Search and symbol resolution drop base rows only for paths the overlay replaces (covered or tombstoned); uncovered paths keep their base rows, flagged stale.'
      - 'Source eligibility uses the same ignore and file-size rules as full analyze, so generated, vendored, and over-cap files are never overlay candidates.'
      - analyze --dirty-overlay and watch build the covered subset instead of refusing above the cap.
    rollback:
      - Revert the write-set files.
    stop_conditions:
      - Reusing the analyze ignore and size rules needs changes in the scan owner outside the write set.
      - A caller of tooMany outside the write set changes behavior.
    known_blockers: []

  RT-40:
    title: When a file is deleted or renamed away and no usable overlay exists, context, impact, and symbol resolution never return that file's base symbols as current; they are omitted or flagged deleted
    status: OPEN
    classification: implementation-ready
    assurance_profile: full
    complexity: complex
    depends_on: [RT-39]
    type: code
    validation_tier: unit-fast
    impact_risk: medium
    owner_files:
      - ontoindex/src/mcp/local/backend-symbol-resolution.ts
      - ontoindex/test/unit/backend-overlay.test.ts
    allowed_write_set:
      - ontoindex/src/mcp/local/backend-symbol-resolution.ts
      - ontoindex/test/unit/backend-overlay.test.ts
    non_goals:
      - Changing search ranking.
      - Serving deleted content from git history.
    required_validation:
      - cd ontoindex && npx vitest run test/unit/backend-overlay.test.ts
      - cd ontoindex && npx tsc --noEmit
    validation_workspace:
      root: ontoindex
      inputs:
        - src/mcp/local/backend-symbol-resolution.ts
      generated_outputs:
        - dist/
    expected_evidence:
      - With an unusable overlay, resolving a symbol from a deleted file returns no current candidate and a warning naming the deleted path.
      - With a usable overlay, a renamed symbol resolves only at its new path.
      - Clean-file resolution is unchanged.
    rollback:
      - Revert the write-set files.
    stop_conditions:
      - Context or impact handlers outside the write set must change to show the warning.
    known_blockers: []

  RT-41:
    title: When impact runs on a clean target and a dirty source file mentions the target's name, the result is marked partial and names those files, because calls added in dirty files are not in the graph
    status: OPEN
    classification: implementation-ready
    assurance_profile: full
    complexity: complex
    depends_on: []
    type: code
    validation_tier: unit-fast
    impact_risk: medium
    owner_files:
      - ontoindex/src/mcp/local/backend-impact.ts
      - ontoindex/test/unit/impact-kernel-dirty.test.ts
    allowed_write_set:
      - ontoindex/src/mcp/local/backend-impact.ts
      - ontoindex/test/unit/impact-kernel-dirty.test.ts
    non_goals:
      - Parsing dirty files or adding CALLS edges to the overlay.
      - Changing the risk score of clean results when no dirty file mentions the target.
    required_validation:
      - cd ontoindex && npx vitest run test/unit/impact-kernel-dirty.test.ts test/unit/backend-impact-identity.test.ts
      - cd ontoindex && npx tsc --noEmit
    validation_workspace:
      root: ontoindex
      inputs:
        - src/mcp/local/backend-impact.ts
      generated_outputs:
        - dist/
    expected_evidence:
      - A dirty file that newly calls a clean target yields traversalComplete false and a warning naming that file.
      - The scan reads at most the dirty source files in the snapshot and a bounded number of bytes per file.
      - With no dirty source files, results and timings are unchanged.
    rollback:
      - Revert the write-set files.
    stop_conditions:
      - The name scan adds more than 100 ms at 50 dirty files on this repo.
    known_blockers: []

  RT-42:
    title: When source files change continuously, ontoindex watch starts a refresh within a maximum wait, catches missed events with a periodic git-status check, and only one watcher per repository builds overlays
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
      - ontoindex/test/unit/watch.test.ts
    allowed_write_set:
      - ontoindex/src/cli/watch.ts
      - ontoindex/test/unit/watch.test.ts
    non_goals:
      - A new npm dependency.
      - Changing the 750 ms debounce default.
    required_validation:
      - cd ontoindex && npx vitest run test/unit/watch.test.ts test/unit/watch-command.test.ts test/unit/watch-save-patterns.test.ts
      - cd ontoindex && npx tsc --noEmit
    validation_workspace:
      root: ontoindex
      inputs:
        - src/cli/watch.ts
      generated_outputs:
        - dist/
    expected_evidence:
      - A save every 200 ms for 20 s starts a refresh within the maximum wait (default 5 s) and at least once per maximum-wait window.
      - A change made with no filesystem event (simulated) is refreshed after the next periodic check (default 30 s), which compares the git-status dirty set with the last built set.
      - A second watcher on the same repository sees the live lease (pid and heartbeat), logs that another watcher owns the repository, and builds nothing; a stale lease is taken over.
    rollback:
      - Revert the write-set files.
    stop_conditions:
      - The lease needs a cross-process lock primitive outside node:fs.
    known_blockers: []

  RT-43:
    title: When HEAD moves or the overlay is unusable because of a base mismatch, ontoindex watch runs one base analyze before the next overlay build, and skips it while analyze.lock is held
    status: OPEN
    classification: implementation-ready
    assurance_profile: full
    complexity: complex
    depends_on: [RT-38, RT-42]
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
      - Running analyze --embeddings from the watcher.
      - Triggering a base analyze only because many files are uncovered.
    required_validation:
      - cd ontoindex && npx vitest run test/unit/watch.test.ts test/unit/watch-command.test.ts
      - cd ontoindex && npx tsc --noEmit
    validation_workspace:
      root: ontoindex
      inputs:
        - src/cli/watch.ts
      generated_outputs:
        - dist/
    expected_evidence:
      - A HEAD change produces exactly one base analyze, then one overlay build.
      - A base mismatch reported by the overlay snapshot produces the same sequence.
      - A held analyze.lock skips the base analyze and retries it, as the overlay refresh already does.
    rollback:
      - Revert the write-set files.
    stop_conditions:
      - Detecting a HEAD change needs a new watcher on .git internals that makes the save-pattern tests flaky.
    known_blockers: []

  RT-44:
    title: A read-only diagnostic measures, with a long-lived MCP reader and repeated publications, how many base and overlay generations stay on disk, when the reader re-pins, and what state remains after a process is killed between pointer swap and job completion
    status: OPEN
    classification: proof-only
    assurance_profile: full
    complexity: complex
    depends_on: []
    type: diagnostic
    validation_tier: unit-fast
    impact_risk: low
    owner_files:
      - ontoindex/src/storage/repo-manager.ts
      - ontoindex/src/mcp/local/local-backend-repo-runtime.ts
    allowed_write_set: []
    non_goals:
      - Fixing defects inside this task; each confirmed defect becomes its own task.
    required_validation:
      - cd ontoindex && npx vitest run test/unit/index-generation-retention.test.ts test/integration/lbug-pool-generation-swap.test.ts
    expected_evidence:
      - 'Recorded counts and bytes of retained base and overlay generations after 10 publications with one reader held open.'
      - 'Whether and when a busy reader re-pins to the newest generation, with file:line evidence.'
      - 'The pointer, generation, and job state after a kill between pointer swap and job completion, and whether the next start recovers it.'
      - A recommendation for a byte budget and whether retained-generation counts belong in status.
    rollback:
      - None; read-only.
    stop_conditions:
      - The diagnostic cannot run without editing production code.
    known_blockers: []
```

## Required Traceability

| Requirement ID | ADR/user requirement                                                                                       | Disposition    | Task IDs         | Validation                                         |
| -------------- | ---------------------------------------------------------------------------------------------------------- | -------------- | ---------------- | -------------------------------------------------- |
| RT-REQ-1       | Tool results flag which returned files are dirty                                                           | implementation | RT-1             | target-context and envelope tests                  |
| RT-REQ-2       | Dirty files get a separate overlay graph that never mutates the active generation                          | implementation | RT-2, RT-3       | dirty-overlay build and plan tests                 |
| RT-REQ-3       | A debounced watcher keeps the overlay current                                                              | implementation | RT-4             | watch tests                                        |
| RT-REQ-4       | Queries serve dirty paths from the overlay                                                                 | proof-only     | RT-5             | read-path spike                                    |
| RT-REQ-5       | Embeddings are not refreshed for the overlay                                                               | non-goal       | RT-2             | documented limit                                   |
| RT-REQ-6       | Queries, symbol lookup, context and impact serve dirty paths from the overlay without claiming zero impact | implementation | RT-6, RT-7, RT-8 | overlay merge, resolution and context/impact tests |
| RT-REQ-7       | The overlay build does not flake on the default 8 TB mmap                                                  | implementation | RT-9             | 30 consecutive passing runs                        |
| RT-REQ-8       | NodeNext .js imports resolve to .ts so the graph has real cross-file edges                                 | implementation | RT-10            | resolver fixture and re-analysis                   |
| RT-REQ-9       | A rebuilt overlay is picked up by a running server                                                         | implementation | RT-11            | rebuild-then-query test                            |
| RT-REQ-10      | Impact flags dirty rows instead of trusting stale ids                                                      | implementation | RT-12            | impact-kernel-dirty tests                          |
| RT-REQ-11      | A watch command keeps the overlay current                                                                  | implementation | RT-13            | watch-command tests                                |
| RT-REQ-12      | A regression in .js-to-.ts mapping fails a real-pipeline test                                              | implementation | RT-14            | js-specifier-edges integration test                |
| RT-REQ-13      | The watcher says what it is doing at startup                                                               | implementation | RT-15            | watch-command tests                                |
| RT-REQ-14      | Overlay performance is measured, not assumed                                                               | proof-only     | RT-16            | benchmark output                                   |
| RT-REQ-15      | ./dir.js resolves to dir/index.ts                                                                          | implementation | RT-17            | resolver unit and integration tests                |
| RT-REQ-16      | The watcher survives real editor save patterns                                                             | implementation | RT-18            | real-file watcher tests                            |
| RT-REQ-17      | Windows-style paths behave like POSIX paths                                                                | proof-only     | RT-19            | host-independent path tests                        |
| RT-REQ-18      | The feature is documented and discoverable                                                                 | implementation | RT-20            | doc claims checked against code                    |
| RT-REQ-19      | Mutation tools never apply graph line numbers to a file that changed since indexing                        | implementation | RT-21            | mutation-dirty-guard tests                         |
| RT-REQ-20      | Windows test assertions are separator-agnostic                                                             | implementation | RT-22            | mutation-dirty-guard tests                         |
| RT-REQ-21      | Overlay tests release file handles before deleting or renaming on Windows                                  | implementation | RT-23            | overlay tests                                      |
| RT-REQ-22      | macOS watcher tests pass or are skipped with a recorded reason                                             | implementation | RT-24            | watch-save-patterns tests                          |
| RT-REQ-23      | An overlay rebuild never deletes or rewrites an open store                                                 | implementation | RT-25            | overlay-generations tests with a real open reader  |
| RT-REQ-24      | A user can see the overlay's state                                                                         | implementation | RT-26            | status tests                                       |
| RT-REQ-25      | Machine-specific files stay out of the repo                                                                | proof-only     | RT-27            | audit recorded in the closeout                     |
| RT-REQ-26      | The watcher, MCP server and overlay work together on a real repo                                           | proof-only     | RT-28            | live session record                                |
| RT-REQ-27      | Health separates committed freshness, dirty coverage, and embeddings; a dirty tree alone is not degraded   | implementation | RT-36            | runtime-health tests                               |
| RT-REQ-28      | A request's metadata comes from the generation it queried                                                  | implementation | RT-37            | generation-swap reproduction test                  |
| RT-REQ-29      | An overlay is served only on the base it was built against                                                 | implementation | RT-38            | backend-overlay and overlay-build tests            |
| RT-REQ-30      | More than 50 dirty source files gives partial coverage, not zero                                           | implementation | RT-39            | dirty-overlay-plan and backend-overlay tests       |
| RT-REQ-31      | Deleted and renamed-away files never resolve as current                                                    | implementation | RT-40            | backend-overlay tests                              |
| RT-REQ-32      | Impact on a clean target is partial when dirty files may add callers                                       | implementation | RT-41            | impact-kernel-dirty tests                          |
| RT-REQ-33      | The watcher converges under continuous edits and missed events, with one watcher per repository            | implementation | RT-42            | watch tests                                        |
| RT-REQ-34      | A HEAD move or base mismatch rebuilds the base before the overlay                                          | implementation | RT-43            | watch tests                                        |
| RT-REQ-35      | Generation retention, re-pinning, and crash state are measured before a disk budget is set                 | proof-only     | RT-44            | diagnostic record                                  |

## Decisions And Non-Goals

- 2026-10-10 finding: `--experimental-file-delta` replaces the active generation with only the changed files (32 nodes became 4 on a probe repo, status degraded). Allowing it on dirty trees would wipe the index, so the original RT-2 and RT-3 were dropped.
- Chosen design: overlay generation. The bounded pipeline writes to `<storage>/overlay` and is never activated; the base stays intact and the overlay is disposable.
- Rejected: in-place graph patching (writer-lock and lost cross-file edges), per-state snapshots (minutes per state), per-file parse cache with full relink (large refactor; revisit later).
- Vector search lags on edited files until a full `analyze --embeddings`.

- 2026-10-10 review findings: (1) the import resolver never maps .js to .ts, so most cross-file edges are missing for NodeNext TypeScript (2157 of 2163 relative imports in this repo end in .js; impact on runImpactKernel showed 0 callers); (2) the overlay pool handle is cached by id while the overlay directory is deleted and recreated on rebuild; (3) dirty-overlay-build.test.ts flaked 1 of 10 on an 8 TB mmap. Cherry-picked: RT-10, RT-9, RT-11 (single-flight probe plus handle invalidation), RT-12 (flag, do not drop), RT-13. Dropped A3 (lazy auto-spawn from read tools): the watcher already exists and a read tool spawning processes is a surprising side effect.

- 2026-10-10 CI review: PR 83 is based on the PR 82 branch, so ci.yml (branches: [master]) never ran against RT-1..RT-13; only benchmark and the broken check job run. Reproduced locally instead: prettier, eslint (0 errors), tsc, web tsc -b, unit tests. The check job fails on every PR in its history because ontoindex-check.yml lacks `permissions: pull-requests: write` (Comment PR gets `Resource not accessible by integration`); fixing it is a repo-permission change left to the owner. Merging 82 and retargeting 83 is also left to the owner.
- Chosen next: RT-14 (permanent regression test for the highest-risk change), RT-15 (watcher startup line), RT-16 (measure before tuning). Rejected: throwaway master PR (duplicates the diff), continue-on-error for the comment step (hides a signal), watcher status reporting in doctor (touches shared status code), .git/index-mtime snapshot cache (premature without RT-16 numbers).

- 2026-10-10 scratch-repo verification (edit + rename + untracked + dir-index import): overlay serves edited, renamed, and untracked symbols with source overlay; impact is UNKNOWN. Found one resolver gap (./dir.js to dir/index.ts) -> RT-17. Chosen: RT-17, RT-18, RT-19, RT-20. Rejected: git-diff-based impact for overlay targets (hot-path cost), recursive-watch fallback for old Linux (not testable here), waiting for Windows/macOS CI (blocked on the owner merging PR 82).

- 2026-10-10 mutation check: the resolver returned startLine 1 for a symbol that sits on line 5 of a dirty file (three comment lines added above it); move_symbol slices those graph lines from the live file, and its dry run reported success with no warning. Existing behavior, not caused by the RT work, but now preventable with the dirty-path machinery -> RT-21. The real write failed closed in my check only because the server had writes disabled.

- 2026-10-10 first cross-platform CI (draft PR 85, full stack on master): Linux jobs pass; macOS fails 10 watcher tests; Windows fails 7 tests across 3 files (separator-sensitive assertions, file locks on rename and reopen). Local Linux runs could not show any of these. Fixes limited to tests where the cause is understood (RT-22, RT-23); the macOS cause is unreproduced, so RT-24 either fixes the test setup (realpath, settle time) or skips on darwin and records production behavior there as unverified.

- 2026-10-10 next-step selection after the cross-platform CI pass: chose versioned overlay generations (RT-25) over cross-process close notifications (new machinery) and over delete retries (masks the problem for long-lived readers), status visibility (RT-26), the pre-merge audit (RT-27, done), and a live end-to-end session (RT-28). Rejected a broad ESLint warning cleanup (out of scope) and skipping the live session (every test so far covered pieces).

- 2026-10-14 review of "index is degraded" on a continuously changing tree. Observed: indexed commit equals HEAD (`7b1494c`), 115 dirty paths (75 source files by extension), optional embeddings missing, 2 files over the scan size cap. Two causes, neither a database fault: `runtime-health.ts` labels any dirty tree degraded, and the overlay is all-or-nothing above 50 dirty source files (`analyze-delta.ts:399-401`, `backend-overlay.ts:91-93`), so it is off for this whole repo.
- Chosen design, three parts used together:
  1. Truthful status: separate committed freshness, dirty coverage, and embeddings (RT-36); report metadata from the generation actually queried (RT-37).
  2. Correct, converging overlay: bind each overlay to its base (RT-38); partial coverage above the cap (RT-39); deleted files never resolve (RT-40); impact is partial when dirty files may add callers (RT-41); maximum wait, periodic git-status catch-up, and a one-watcher lease (RT-42).
  3. Snapshot fallback through the existing generation publication and pins: a HEAD move or base mismatch triggers one base analyze before the next overlay (RT-43); retention and re-pinning are measured before choosing a disk budget (RT-44).
- Order: RT-36 and RT-38 first (RT-38 plus RT-39 restores the overlay on this repo), then RT-40, RT-41, RT-37, then RT-42, RT-43, RT-44. RT-37 starts with a reproduction test, because the mixed-version read was reported by review and is not yet shown by a test.
- Rejected: raising the 50-file cap (does not fix base mismatch or deleted files, and makes each build slower); in-place transactional graph updates (the generation and overlay owners already provide isolation; no measurement shows they are too slow); a new store, lock daemon, or watcher dependency.
- Covered by later work, statuses unchanged pending gate review: RT-4's watcher core is the one RT-13 registers and wires; RT-5's merge points are implemented by RT-6, RT-7, and RT-8. Watcher saves during a refresh already get one follow-up, and a held analyze.lock already retries (`watch.ts:151-180`).
- Vector search for dirty files still lags until `analyze --embeddings`; RT-36 reports that instead of hiding it.

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
- RT-9: initLbug takes an optional maxDBSize; only the overlay build passes 4 GiB (2\*\*32; note 1<<32 is 0 in JS). Default path unchanged. A bounded store is readable by the pool adapter.
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

2026-10-10 robustness phase (5 sub-agents: gpt-6-luna on RT-17 and RT-19, gpt-6.1-sol on RT-18, RT-20 and RT-21). Parent re-ran: tsc clean, prettier clean, watcher suites 10/10 runs green.

- RT-17: `./dir.js` now resolves to `dir/index.ts` (real file > dir.ts > dir/index.ts); 72 resolver tests, 205 with integration; verified end to end on a scratch repo (u1.ts -> dir/index.ts).
- RT-18: real `fs.watch` with real file operations: in-place write, temp+rename, delete+create, vim backup rename, 20-write burst, nested create each yield exactly 1 refresh; backup/swap/4913-only yields 0. Defects found and fixed in watch.ts: backup suffix `~` and Vim `4913` were not ignored; stale-inode watch after a rename was not re-armed (re-armed after each debounce); watcher errors and root replacement are now logged and stop cleanly (restart needs a new watcher). The new suite failed 9 of 15 runs before the final fix, 0 of 15 after. Linux/Node 24 only; re-arming rescans the tree and large-tree cost is unmeasured.
- RT-19: 8 host-independent Windows-path tests pass plus 1 documented expected failure: tryResolveWithExtensions called directly with a backslash path does not normalize it. Not a live defect: filesystem-walker.ts normalizes to forward slashes before the resolver runs. Real windows-latest CI has still not run on this work.
- RT-20: .memory-bank/knowledge-hub/dirty-worktree.md. Parent review found one claim to correct: it says mutation tools may use the overlay; see RT-21.
- RT-21: reproduced a real defect (mocked stale range, committed temp repo): the graph keeps index-time line ranges, so on a file with uncommitted edits move_symbol cut the three added comment lines instead of the function. The pre-existing code had this for any dirty file; writes are additionally gated by confirm:true and a server flag. Fix: a shared guard refuses a real write before touching any file when the symbol's file is dirty and its range did not come from a usable overlay; dry runs succeed with a warning. 35 tests. The reproduction used a mocked resolver range rather than a full index.
- Statuses stay OPEN: no authenticated role receipts exist.

2026-10-10 cross-platform fixes (3 sub-agents: gpt-6-luna on RT-22 and RT-24, gpt-6.1-sol on RT-23). Parent ran the four touched test files 5 times on Linux (63/63 each), tsc clean, whole-repo prettier clean. NONE of these fixes has been run on Windows or macOS; the draft PR 85 rerun is the only evidence.

- RT-22: mutation-dirty-guard assertions now match both path separators (Windows CI failure: absolute backslash path in the message). Two guard cases added (host-native absolute path, backslash-relative path). The agent did not run its own tests (another validation was active), so the parent ran them.
- RT-23: the Windows file-lock failures were NOT fixed, only isolated. Three tests are skipped on win32 with a comment naming RT-23: the overlay-build rename (EPERM on generations/.staging-baseline) and two backend-overlay lifecycle tests (reading a rebuilt or deleted overlay while a pooled reader is open). The agent classified all three as production lifecycle issues, unproven: run-analyze.ts:784 removes the overlay directory without telling MCP readers; backend-overlay.ts:125-138 closes a reader only after it sees the file disappear, which is too late for Windows to allow the delete; closeActiveLbugHandles (lbug-adapter.ts:531-542) swallows close failures. On Windows a running MCP server plus `ontoindex watch` rebuilding the overlay can therefore fail. This is a real open risk, not covered by any passing test there.
- RT-24: macOS watcher tests now use realpath'd temp roots, a 2 s settle on darwin, a 300 ms warm-up, and each "artifact alone" test also performs a real save so it can no longer pass vacuously. No darwin skip. Unverified until macOS CI runs; if it still fails the next step is skipIf(darwin) and a production investigation.

2026-10-10 second CI round on draft PR 85: Windows tests PASS now (the three file-lock tests are skipped on win32 by design, see above). macOS still failed all real-fs.watch tests. Two temporary diagnostic tests on the probe branch showed the cause: on macOS the root-parent watcher receives a replayed `rename:root` event for the root's own creation right after it is armed (events seen: `rename:root`, then `rename:a.ts`), and watch.ts treated every parent `rename` of the root name as a replacement and stopped the watcher (`Watcher stopped: Watched root was removed or replaced`) before any file event. So this was a production defect, not a test-setup problem: on macOS `ontoindex watch` would have stopped itself at startup.

- Fix (watch.ts): a parent `rename` of the root is now ambiguous on both platforms (macOS replays creation; Linux reuses inode and birthtime on an instant delete and recreate). The watcher re-stats the root: if it is gone it stops and logs; if a directory exists it adopts the new identity and re-arms the recursive watch. Behavior change: an instant delete-and-recreate of the root now keeps the watcher alive instead of stopping it; the old test expecting a stop was replaced by one that expects it to keep watching and still refresh after a save, plus a test that a root that stays deleted stops with a log. A first attempt using a 250 ms replay window made Linux worse (8 of 25 runs failed) and was reverted; the stat-then-rearm version passed 25 of 25 Linux runs of all three watcher suites.
- Not yet verified on macOS: the fix is validated on Linux only; the macOS CI rerun is the evidence.

2026-10-10 third CI round on draft PR 85: macOS PASSES (all 13 watcher tests; the one remaining failure, bench-gate, is a timing-based benchmark check that passed in two earlier macOS runs and on rerun). Windows failed only the rewritten "recreated at once" watcher test: `Watcher stopped: Watched root was replaced`. Cause: the second code path, checkRoot(), still treated a replaced-but-present root as fatal while the parent-rename path now re-armed. Fix: checkRoot() now adopts the new root identity and re-arms; only a root that is gone stops the watcher. The 20-writes test also had a flaky wall-clock assertion on the write loop itself (231 ms against a 100 ms bound in 1 of 25 local runs); removed, since it measured the machine and not the watcher. Linux: 24 of 25 runs clean before removing it, 32 of 32 tests after. Windows and macOS need the CI rerun as evidence.

2026-10-10 pre-merge audit (RT-27, done in the main session): the branch carried an edit to the tracked, shared `.mcp.json` that replaced three upstream paths with this machine's `/opt/d1/_wrk/ontoindex`. That fixed this checkout and would break it for every other contributor (the file also lists other developers' absolute paths). Reverted to master's version; local MCP wiring for this machine lives in `~/.ontocode/config.toml`, which is not part of the repo. No TODO, FIXME, or debugger statements were added; added console.log calls are CLI user output (overlay summary, watch lines, benchmark usage). No machine paths appear in shipped source or scripts.

## Evidence archive

Older evidence notes are preserved verbatim in [.memory-bank/archive/REALTIME_DIRTY_WORKTREE_SUPPORT_EVIDENCE_ARCHIVE.md](archive/REALTIME_DIRTY_WORKTREE_SUPPORT_EVIDENCE_ARCHIVE.md): RT-25; RT-29 to RT-31; RT-32 to RT-34; RT-35; status split and partial coverage; deleted files and watcher convergence; pinned metadata, HEAD moves, and warning display.

## Evidence note: pool test diagnosis and RT-44 measurements

Two read-only investigators (gpt-6-luna xhigh by code trace, gpt-6.1-sol low by bisecting a scratch copy) diagnosed the failing pool test; two measurement workers (same models) produced RT-44 data in scratch copies. Scratch copies are deleted. Statuses stay OPEN.

- Failing test `index-generation-retention.test.ts` "holds a native pool reader until its database closes": both investigators reached the same cause. The uncommitted `closeLbug(repoId)` in `pool-adapter.ts` fences the whole shared native database and then waits for every in-flight initialization. The test held an alias initialization open until `closeLbug` returned, so the drain could not finish (10 s timeout), and the resumed alias then hit "LadybugDB database is closing". The bisect confirmed that removing the two `requestSharedClose` calls and the drain makes the test pass.
- Decision: close-all semantics are deliberate. `pool-lifecycle-regressions.test.ts` ("closes all aliases of the same native database before resolving") asserts them, and that file already contains the uncommitted pool rewrite. I therefore changed the older test and not the pool: it now finishes the alias initialization, checks that generation `native-a` is retained and queryable, then closes. The `closeLbug` doc comment said "close only that repo's connections"; it now describes closing the repo and every alias that shares its database. This test change removes coverage of "alias initialization in flight while another alias is closed"; that case now rejects with "database is closing" by design. If per-repo close is wanted instead, the option is to revert the two `requestSharedClose` calls and the drain, and replace the alias regression test.
- RT-44 retention (fixture: about 1.02 MB per generation, 11 publications, one reader): the reader stays pinned to generation 1 for all 11 publications. Disk holds the pinned generation plus the active and two prior ones, so it plateaus at 4 generations (4.08 MB) instead of 3 (3.06 MB). Re-pin happens only when `local-backend-repo-runtime.ts:229-249` reinitializes (checked at most every 5 s, when `indexedAt` or the active database path changes) or when `initLbug` is called again for the repo id (`pool-adapter.ts:745-776`); after that the pin moved to generation 11 and disk returned to 3 generations. Releasing the reader reclaimed the pinned generation on the next publish. Recommended rule: keep active + 2 prior + live pins; budget about 3 generation sizes per repo plus one per live pin outside that set plus staging headroom. A hard byte cap is not recommended, because pins must not be deleted. Cost is bounded by one extra generation per long-lived idle reader.
- RT-44 crash (SIGKILL between the pointer swap and the end of the commit callback, scratch run): `current` points to the new generation B, its `meta.json` is consistent, readers work, and the dead-PID `current.mutation.lock` is reclaimed on the first pin acquisition, so later publishes succeed immediately. Not recovered: B lacks the `.retention-managed` marker (written only after the callback, `repo-manager.ts:526`), so B is never pruned; a pre-swap kill leaves a staging directory that is removed only after 24 h (`repo-manager.ts:623`); the analysis job stays `publishing`, becomes `failed` once the runner is dead (`analysis-coordinator.ts:310`), and `gn_analyze_job` reports `ANALYSIS_FAILED` for an index that is active. The pointer lock checks PID liveness only, so a reused PID could block reclaim for the 10 s acquisition timeout (inferred from source, not run). Limit: the kill point was after the swap and inside the callback, not at every instruction inside activation.
- Follow-up candidates, not started: reconcile an interrupted publication under the pointer lock at start (mark B managed and reconcile the job when the receipt matches, else restore the previous generation); add process-start identity to the pointer lock; make `ensure-fresh.ts` report the pinned generation like target context now does.
- Parent validation after the last edit: 19 test files, 290 passed and 1 existing expected failure; `tsc --noEmit` exit 0; Prettier clean on every file changed this session. 11 other modified files (`mcp-doctor`, `server`, `diagnose` and related tests) were already unformatted before this session and were not touched.

## Evidence note: crash-recovery follow-ups from RT-44

Options compared before dispatch. Interrupted publication: (1) write a publication-intent file before the swap and reconcile it at start, (2) adopt the active generation when it is consistent but unmarked, (3) restore the previous generation. Picked (2): idempotent, one `stat` per process and generation, no new durable format, cannot discard a valid newer index. Pid reuse: (1) record the process start identity in the lock owner, (2) heartbeat and stale age, (3) leave. Picked (1): deterministic, backward compatible. Executed by leaf sub-agents (gpt-6-luna xhigh, gpt-6.1-sol low) editing disjoint hunks of `repo-manager.ts`; statuses stay OPEN.

- Adoption: `adoptActiveGenerationLocked` runs under the pointer lock at the start of `publishIndexGenerationTransaction` and `acquireIndexGenerationPin`. It writes `.retention-managed` for the active generation only when `meta.json` parses and names the directory, the lbug store is a real file or directory (not a symlink), and the generations root is a real directory. Legacy root layouts are untouched. Failures are swallowed. Each generation is checked once per process. Tests cover the crash case, retention after adoption, a mismatched `meta.json`, and legacy layout.
- Pid reuse: the exclusive lock owner file records `pidStart` (Linux, field 22 of `/proc/<pid>/stat`); reclaim also fires when the live pid's start identity is readable and differs, and removal re-checks it. Absent field, unreadable identity, and non-Linux hosts behave as before. The registry lock's own acquisition and reclaim code is unchanged, but it calls the same `acquireExclusiveFile`, so it also writes `pidStart`. Tests cover identity read, a reused pid, a matching live owner, and a legacy lock.
- Dropped: making `ensure-fresh.ts` report a pinned generation. The pool pin exists only inside the MCP server process; a CLI call has no pin, so the mismatch cannot occur there.
- Still open: reconcile the analysis job (`publishing` becomes `failed` for an index that is active). It needs the analysis-coordinator owner and a receipt match, so it is a separate task.
- Parent validation after the last edit: 20 test files, 350 passed and 1 existing expected failure; `tsc --noEmit` exit 0; Prettier clean on files changed in this session (`repo-manager.ts` needed one formatting fix inside the adoption helper).

## Evidence note: analysis job state after a crashed publication

Problem: after a SIGKILL between the pointer swap and `commitManagedAnalysisPublication`, the job is `failed` with `publicationState: publishing`, while the active generation holds a valid publication receipt for it. `gn_analyze_job` reported `ANALYSIS_FAILED` for an index that is active and fresh.

Options compared: (1) change `getAnalysisJob` or the coordinator to rewrite the job record on recovery, (2) reconcile at start under the pointer lock, (3) make the read-side `observeRecovery` verify the receipt and post-conditions for failed jobs that were publishing and report success only when everything checks out. Picked (3): it writes nothing, uses the existing receipt and post-check code, and cannot turn a failure into a success without proof. (1) and (2) mutate the authoritative job record from a reader or add a new startup path in the coordinator.

Executed by leaf sub-agents (gpt-6-luna xhigh on the source, gpt-6.1-sol low on tests); statuses stay OPEN.

- `observeRecovery` in `src/mcp/super/analyze-job.ts` now runs the shared receipt and post-condition check (extracted as `verifyPublishedJob`) for a failed job whose `publicationState` is `publishing`. Success returns `REFRESHED` with reason `PUBLICATION_VERIFIED_AFTER_RUNNER_EXIT`; any other outcome, including a thrown check, returns today's `FAILED` / `ANALYSIS_FAILED` result. Failed jobs with `published` or no publication state, and every non-failed job, behave as before. No job record is written.
- Tests: seven cases in `test/unit/super/analyze-job.test.ts` (verified success with receipt attached and the job object unchanged; no receipt; wrong generation; dirty post-check; unavailable post-check; `published` and undefined states do not read receipts). The test worker changed the shared `beforeEach` from `clearAllMocks` to `resetAllMocks` so unused one-shot mock values cannot leak between cases; every default is re-staged right after, and all 30 earlier cases still pass.
- Limits: the stored job record still says `failed`; only the status report changes. A repository that is dirty or has moved past the job's target commit still gets `FAILED`, because the existing post-check requires a clean worktree at the target commit. In this repository, with uncommitted changes, the new path therefore reports success only after a clean build at the target.
- Parent validation after the last edit: 40 test files, 1007 passed and 1 existing expected failure; `tsc --noEmit` exit 0; Prettier clean on both changed files.

## Evidence note: full-suite verification of the uncommitted tree

Until now only targeted test subsets had been run. Two verification workers (gpt-6-luna xhigh on the full unit suite, gpt-6.1-sol low on lint, formatting, integration and type checks) ran against the real tree, with baselines from a clean `HEAD` archive. Two fix workers (same models) repaired the failures. Statuses stay OPEN.

- First full unit run: 504 files, 8124 tests, 11 failed in two files, `overlay-context-impact.test.ts` (6) and `overlay-symbol-resolution.test.ts` (5). Both pass at `HEAD`, so all 11 were caused by uncommitted changes. Cause: the tests mock `backend-overlay.js` and build snapshot fixtures from before this work. They lack the new `isOverlayReplacedPath` export and the `tombstones`, `overlayPaths` and `uncoveredPaths` fields that `backend-symbol-resolution.ts` now reads. Production code was correct; the fix changed test fixtures and the mock only, with the production semantics copied into the mock. One regression test was added per file: uncovered dirty base rows are kept while covered ones are dropped; an unusable snapshot whose tombstones hold the only candidate gives `not_found` with a warning naming the path.
- Second full unit run after the fixes: 504 files passed, 8060 tests passed, 1 expected fail, 65 skipped, exit 0. Earlier targeted subsets had missed these two files because their names do not mention the symbols that changed.
- Integration tests related to overlay, watch, dirty, generation, pool, analyze and mcp: 19 files passed and 1 skipped (208 tests passed, 1 skipped). `tsc --noEmit` exit 0.
- ESLint on the 101 modified or untracked source and test files: 0 errors. New warnings against `HEAD` appear in session-owned files (`pool-adapter.ts` +3, `target-context.ts` +1, `pool-lifecycle-regressions.test.ts` +4, `lbug-pool-generation-swap.test.ts` +1, `super/analyze-job.test.ts` +8) and in files from earlier uncommitted work. Warnings are non-blocking.
- Prettier flags 11 files, none touched this session: `mcp-doctor.ts`, `server.ts`, `diagnose.ts` and their tests, plus two untracked tests. Nine of them pass at `HEAD`, so the unformatted state came from earlier uncommitted work.

## Evidence note: merged pull requests and overlay eligibility parity

PR #118 (`a4c4659`) and PR #119 (`364b5a4`) squash-merged to master with green CI. PR #120 (`feat/overlay-eligibility-parity`) adds the built-in ignore, size cap, and root `.gitignore`/`.ontoindexignore` rules to `planDirtyOverlay` through `loadIgnoreRules` and two root reads, without a tree walk. The full unit suite passed (8,520 tests). Task statuses remain OPEN until receipt gates exist; tracker closure needs a `depends_on` chain before `dispatch_mode` changes to sub-agent.
