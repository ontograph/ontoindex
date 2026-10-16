# Archived real-time dirty-worktree support evidence

Verbatim evidence notes moved from the active plan to keep its tracking block below the parser size limit. Source plan: [REALTIME_DIRTY_WORKTREE_SUPPORT_PROJECT_PLAN.md](../REALTIME_DIRTY_WORKTREE_SUPPORT_PROJECT_PLAN.md).

## Evidence note: RT-25 immutability root cause and fix

Published generation files grew in-process (about 2.1 MB to 3.1 MB) because `lbug-adapter.ts` left native query results unclosed. The builder's writer lifetime was extended, so its final checkpoint ran later, on garbage collection, and wrote into the published file. Evidence (agent strace on Linux): 479 write and truncate calls on gen1 during forced GC. Closing builder results removed the growth.

A separate-process builder, as `ontoindex watch` uses, left gen N byte-identical (same sha256 before the build, after it and after the reader closed). The reader issued no writes.

Fix: the adapter now closes every native result. `getAllWithTimeout` closes in a `finally`, and a `runStatement` helper handles statements whose rows are discarded. Strict byte equality is restored in `overlay-generations` and `dirty-overlay-build`; both passed 12 of 12 repeat runs on Linux.

Windows: the CI probe PR #86 (commit `58e06d9`, before the adapter fix) failed 11 of 12 `overlay-generations` tests. Every failure was a native LadybugDB error, `IO exception: Cannot read from file ... Error 33: another process has locked a portion of the file`, raised when the reader opened a freshly published generation. It was not a Node `fs` error, and tests that never read bytes failed too. Working hypothesis, unproven: the builder's writer was still alive because of unclosed native results, so it held its byte-range lock when the reader opened the file. The adapter fix should remove that. Re-probe PR #87 (commit `a1182c8`, since closed) passed the Windows, macOS and Ubuntu test jobs, so `overlay-generations` is green on Windows after the fix. That is one CI run, not a stability measurement. The cause is still a hypothesis, and the three win32 test skips from earlier work have not been re-evaluated.

RT-28 re-run on overlay generations: base analyze 55,414 ms. Edit-to-answer: append 4,735 ms, rename 4,675 ms, new file 4,825 ms, delete 522 ms, atomic save 3,948 ms. Context and impact reported `source: overlay`, risk UNKNOWN.

## Evidence note: result-close follow-up (RT-29 to RT-31)

- RT-29: `pool-adapter.ts`, the MCP reader path, now closes native results too, including after a timeout once the pending native call settles. This was an audit-driven change and was not linked to a failing test. Verified by unit and integration pool tests (95 tests across 10 files, Linux).
- RT-30: `test/unit/lbug-result-close.test.ts` covers the adapter's close paths, including a rejected `getAll()`. The agent reported that a no-op `closeQueryResults` makes it fail.
- RT-31: `test/integration/overlay-cross-process.test.ts` has a separate CLI process publish gen2 while a reader holds gen1, then checks gen1's sha256 is unchanged. It is skipped on win32.
- `src/core/group/bridge-db.ts` now closes its schema, query and execute results. Closing waits for a timed-out `getAll()` to settle. Group unit tests pass (321 across 22 files). No new test was added for this path.
- None of this is verified on Windows or macOS until CI runs.

CI probe PR #88 (commit 0e4f4c4, since closed): Ubuntu, macOS and Windows test jobs, lint, format, typecheck and benchmark passed. Only `check` failed, the known bug fixed by PR #84. The Windows test skips from earlier rounds are unchanged.

## Evidence note: Windows skip removal attempt (RT-32 to RT-34)

- RT-33: `test/unit/group/bridge-db-close.test.ts` covers `bridge-db.ts` result closing. The agent reported a mutation check (no-op `closeResults`) failed both tests.
- RT-32 (analysis): the failing rename in `dirty-overlay-build.test.ts` is `repo-manager.ts` staging dir to `generations/baseline`, before any activation. Native results now close first. A swallowed Connection or Database close error is the one remaining plausible open handle. The analysis could not prove Windows safety.
- Change under test: the win32 skip on that test is removed. The win32 skip on `overlay-cross-process.test.ts` is also removed, but its in-flight byte hash is guarded to non-Windows, because Windows forbids reading a store file with an open native handle (RT-34 analysis).
- Not decided: if the probe fails on Windows, restore the skip with the failure text as the reason. Production close errors still propagate silently (`lbug-adapter.ts` swallows Connection and Database close failures); making publication-required closes fail loudly is a possible follow-up, not done.

Probe PR #89 result (since closed): the Windows unit job passed with 471 files passed and 1 skipped. `dirty-overlay-build.test.ts` ran both tests on Windows and passed (about 21 s), so that win32 skip is gone and was unnecessary after the result-closing fix. Evidence is one CI run. `overlay-cross-process.test.ts` is an integration test that the Windows job does not run, so its Windows behavior is unverified, and the byte-hash guard for win32 is untested. Only `check` failed, the known bug fixed by PR #84. Remaining win32 skips in the overlay tests: none in the unit suite.

## Evidence note: strict native close before generation publish (RT-35)

`closeLbug({ strict: true })` rethrows the first failed Connection or Database close, after always resetting the session state. `runFullAnalysis` uses it immediately before `activateIndexGeneration`, so a generation is never renamed into place while a native handle may still be open. Every other caller keeps the old best-effort behavior. `test/unit/lbug-strict-close.test.ts` injects a Connection close failure and asserts the rethrow; the agent-free mutation check (strict throw disabled) made it fail. Linux only until a probe runs. Consequence to watch: an analyze whose final close fails now fails instead of publishing a possibly-locked generation.

Probe PR #90 result for RT-35 (since closed): Windows, Ubuntu, lint, format and typecheck passed. macOS failed once in `test/unit/watch-save-patterns.test.ts` ("logs and stops when the root is deleted and not recreated": expected `[ { content: 'initial', ... } ]` to equal `[]`), then passed on a failed-job rerun with no code change. That test exercises `ontoindex watch` and real `fs.watch`, not the lbug close path, so I judge it a pre-existing timing flake. This is a judgement from one rerun, not a root-cause fix, and it is the second macOS watcher flake recorded in this plan. A deterministic fix for that test is still open. Only `check` failed otherwise, the known bug fixed by PR #84.

## Evidence note: status split and partial coverage (RT-36, RT-38, RT-39, RT-41)

Dispatch mode stays `human`: `sub-agent` mode needs exactly one dependency-ready task and this plan has about 27. Work ran through leaf sub-agents (gpt-6-luna xhigh, gpt-6.1-sol low) with disjoint write sets; the parent re-ran every check. No authenticated role receipts exist, so all four tasks stay OPEN.

- RT-36 (luna): `RuntimeHealthSnapshot` gains additive `committedFreshness`, `dirtyCoverage` (`none|coverable|over-cap|unknown`, cap 50) and `embeddingsAvailable`. A failed dirty scan reports `unknown`, never `none`. For a dirty tree whose indexed commit equals HEAD, `degradedReason` now reads "committed index is current, but uncommitted files are not represented in the graph"; `freshnessState` keeps the value `dirty`. Two other test files still contain the old text but pass because they supply the string themselves (`resources.test.ts`, `response-envelope.test.ts`).
- RT-38 (sol): each overlay writes `base.json` (`baseGenerationId`, `baseCommit`) before the CURRENT pointer is renamed. `computeSnapshot` rejects an overlay with no `base.json` or a different base, and the cache re-checks the active generation pointer on every probe. Existing overlays are unusable until rebuilt with `analyze --dirty-overlay`.
- RT-39 (luna): above 50 eligible files `planDirtyOverlay` returns the 50 newest in `includePaths`, the rest in `uncoveredPaths`, and every dirty path in `allDirtyPaths`; `tooMany` is kept. Snapshot `dirtyPaths` holds all dirty paths; `overlayPaths` holds covered ones only. Search and symbol resolution drop base rows only for covered or tombstoned paths (`isOverlayReplacedPath`), so uncovered files keep base rows. `analyze --dirty-overlay` and `watch` build the covered subset and log counts. The worker stopped once at its write-set limit; two test files that encoded the old all-or-nothing behavior were added to its set. Live check on this repo: 92 dirty source files, 50 covered, 42 uncovered.
- RT-41 (sol): `findDirtyMentions` scans at most 100 dirty files of at most 256 KiB for a whole-word match of the target name; a match sets `partial: true`, `traversalComplete: false` and a warning naming the file. Risk is unchanged, and the scan is skipped when there are no dirty files.
- Validation by the parent after the last edit: 14 test files, 211 passed and 1 existing expected failure; `tsc --noEmit` exit 0; Prettier clean on touched files; `gn_verify_diff` PASS with no unexpected files.
- Gaps: overlay eligibility is still extension-based (the analyze scan's ignore and size rules were not reused); uncovered rows are not marked `stale` beyond the existing dirty-path list; the RT-41 scan is a name match and can over-report. RT-37, RT-40, RT-42, RT-43 and RT-44 are not started.

## Evidence note: deleted files and watcher convergence (RT-40, RT-42)

Same method as the previous note: leaf sub-agents (gpt-6-luna xhigh on RT-40, gpt-6.1-sol low on RT-42), disjoint write sets, parent re-ran all checks. Statuses stay OPEN (no authenticated role receipts).

- RT-40: `resolveSymbolCandidates` removes base candidates in `snapshot.tombstones` whether or not the overlay is usable. If that removes every candidate the outcome is `not_found` with `warning: "Deleted source path(s): ..."`. A usable overlay resolves a renamed symbol only at its new path. Clean-file resolution is unchanged. Gap: the context and impact handlers do not yet display the new `warning` field, so callers see "not found" without the reason.
- RT-42: `ontoindex watch` fires a refresh at most 5 s (`maxWaitMs`) after the first event of a burst even if saves continue; a 30 s reconcile tick compares the current dirty and covered signature with the last requested one and requests a refresh when they differ; a lease file `<storage>/watch.lease` (pid and heartbeat) makes a second watcher on the same repository log that another watcher owns it and build nothing. Stale leases are taken over. The reconcile timer is unref'd and cleared on stop. Residual race: two watchers started in the same instant against a stale lease can both take over; `analyze.lock` serializes their builds, so the cost is one extra build.
- Parent found and fixed one regression: `createWatchCommand` now writes the lease under the repository storage path, and `windows-path-handling.test.ts` called it with `/repo` and failed with EACCES. The test now passes a temp lease path. Both workers had run with that file outside their write set and reported green.
- Validation by the parent after the last edit, twice in a row: 13 test files, 217 passed and 1 existing expected failure; `tsc --noEmit` exit 0; Prettier clean on touched files.
- Not started: RT-37, RT-43, RT-44. RT-43 depends on RT-38 and RT-42, both now implemented.

## Evidence note: pinned metadata, HEAD moves, warning display (RT-37, RT-43, RT-40 follow-up)

Leaf sub-agents: gpt-6-luna xhigh on RT-37, gpt-6.1-sol low on RT-43 and on the RT-40 follow-up; disjoint write sets; parent re-ran checks. Statuses stay OPEN (no authenticated role receipts).

- RT-37: reproduced. After a publish of N+1 while a pool reader held N, target context reported N+1 metadata beside N rows. `pool-adapter.ts` exports `getPinnedGenerationDir(repoId)`; `resolveTargetContext` reads the pinned generation's `meta.json` when it differs from the active one, reports `generationId`, and degrades authority when that metadata is missing or mismatched. A request opened after the publish reports N+1. Integration test added in `lbug-pool-generation-swap.test.ts`. `resolveTargetContext` has 40 upstream dependents (OntoIndex HIGH); the change is additive. Other tools that read `readActiveGenerationMeta` directly (`ensure-fresh.ts`) are unchanged and can still show the newer generation.
- RT-43: the 30 s reconcile tick and startup compare `git rev-parse HEAD` with the active base commit. A difference spawns one base `analyze` (no `--force`, no embeddings), once per HEAD value, only when `analyze.lock` is free, then requests one overlay build. Failure is logged once and not retried for the same HEAD. The base generation id is part of the reconcile signature, so a base rebuilt elsewhere refreshes the overlay without a base analyze. One child runs at a time. The worker saw four startup timing assertions fail in its first two runs and fixed the test harness (microtask waits).
- RT-40 follow-up: context returns `warning` and impact returns `warnings: [...]` with the deleted path when symbol resolution reports one; results without a warning are unchanged.
- Parent validation after the last edit: 18 test files, 262 passed, 1 existing expected failure, 1 failed; `tsc --noEmit` exit 0; Prettier clean after formatting `target-context.ts` and `target-context.test.ts`.
- Known failure, not caused by this work: `index-generation-retention.test.ts` "holds a native pool reader until its database closes" times out with "Pool initialization drain timed out after 10000ms". It passes on a clean checkout of HEAD and still fails with the RT-37 getter removed, so the cause is the roughly 500 lines of earlier uncommitted changes in `pool-adapter.ts` (connection and pin close tracking). Needs its own diagnosis task before merge.
- Also noted: `target-context.ts` carries an unrelated earlier edit removing `ONTOINDEX_MCP_REPO` resolution; `target-context.test.ts` still has a test named "ignores ONTOINDEX_MCP_REPO" that passes.
- Not started: RT-44 (retention measurement). It should run after the failing pool test is understood, because it exercises the same pin lifecycle.

# Moved from the plan on 2026-10-15 (second archive pass)

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

# Moved from the plan on 2026-10-15 (third archive pass)

## Evidence note: merged pull requests and overlay eligibility parity

PR #118 (`a4c4659`) and PR #119 (`364b5a4`) squash-merged to master with green CI. PR #120 (`feat/overlay-eligibility-parity`) adds the built-in ignore, size cap, and root `.gitignore`/`.ontoindexignore` rules to `planDirtyOverlay` through `loadIgnoreRules` and two root reads, without a tree walk. The full unit suite passed (8,520 tests). Task statuses remain OPEN until receipt gates exist; tracker closure needs a `depends_on` chain before `dispatch_mode` changes to sub-agent.

## Evidence note: merge status and tracker residual (2026-10-15)

PR #120 (`9cda700`) and PR #121 (`f516102`) are also squash-merged to master, so PRs #118 to #121 are all on master. PR #122 adds `.ontocode/` to `.gitignore`.

Dispatch mode stays `human` and all tasks stay OPEN. Implementation is present for RT-36 to RT-44 and the earlier closed work, but no authenticated role receipts exist, so closure is pending. Closing legitimately needs either `dispatch_mode: none` with `complete-local` and fresh main-session evidence per task, or real coder and auditor dispatch with receipts. Known acceptance gap: RT-1 has no per-result `stale` marker, only the `dirtyResultPaths` list on freshness. Audit each task's acceptance criteria against current source before any `complete-local` closure.

## Evidence note: audit of RT tasks against master (2026-10-15)

| Task | Verdict | Residual |
|---|---|---|
| RT-15, RT-17, RT-19, RT-25, RT-26, RT-38, RT-40 | MET | — |
| RT-3 | PARTIAL | Older “empty includePaths above 50” wording is superseded by RT-39, which covers the 50 newest eligible files and reports the rest as uncovered. |
| RT-9 | PARTIAL | 30/30 run claim has no retained artifact. |
| RT-10 | PARTIAL | Reanalysis metrics appear only in plan prose. |
| RT-16 | PARTIAL | No saved benchmark output. |
| RT-18 | PARTIAL | Fixture is not a temporary git repository. |
| RT-21 | PARTIAL | Dirty extract dry run threw; fixed in the branch following this note. |
| RT-22 | PARTIAL | Host-native paths tested; Windows-style absolute paths are covered by the windows-latest CI job, not on Linux. |
| RT-23 | PARTIAL | 20/20 Linux repetitions are not independently evidenced. |
| RT-24 | PARTIAL | Darwin watcher flake is recorded. |
| RT-27, RT-28 | PARTIAL | No scratch transcript. |
| RT-36 | PARTIAL | Fixed by PR #123 with `coveredFiles` and `uncoveredFiles`. |
| RT-37 | PARTIAL | Test ends at generation N. |
| RT-39 | PARTIAL | Uncovered base rows lack a per-row stale flag. |
| RT-41 | PARTIAL | No no-dirty timing regression. |
| RT-42 | PARTIAL | Fixed by PR #123 with per-file mtime/size signatures. |
| RT-43 | PARTIAL | No overlay-snapshot mismatch probe; generation change already rebuilds. |
| RT-44 | PARTIAL | No 10-publication overlay measurement. |
| RT-20 | NOT_MET | Guide rewritten by PR #123. |

RT-1’s earlier residual is outdated: per-result stale marking exists on master via `scanDirtyResults` in `response-envelope.ts`. PRs #120–#123 are merged to master; tasks remain OPEN and `dispatch_mode` remains `human`.

## Evidence note: RT-41, RT-43 and RT-44 test evidence (2026-10-15)

- RT-41: `impact-kernel-dirty.test.ts` now asserts that with no dirty source files the mention scan opens no file and matches the clean baseline, and that 50 dirty files cause at most 50 opens and reads, each no larger than `DIRTY_MENTION_MAX_BYTES`. No wall-clock threshold is asserted.
- RT-43: `watch-command.test.ts` now covers a base generation change between reconcile ticks (one overlay rebuild, no base analyze), a generation change during an overlay child (one further rebuild), and a base refresh that waits for `analyze.lock` and then runs once. The existing HEAD-change test covers one base analyze followed by one overlay build. The overlay snapshot's own base-mismatch reason is reached through the generation signature; the watcher does not read that reason directly.
- RT-44 overlay half: `overlay-generations.test.ts` publishes 10 overlay generations with one held and shows the retained directory count stays at the pruning limit of 3 plus the held one, with CURRENT naming the newest. Residual: overlay pruning (`generations.slice(3)` in `run-analyze.ts`) is not reader-aware. On Linux a held generation survives only if the OS refuses the delete, so the test models that refusal. A byte budget and a retained-generation count in status remain recommendations, not implemented.
- Tasks stay OPEN; `dispatch_mode` stays `human`.

## Evidence note: saved runs for RT-9, RT-10, RT-16 and RT-23 (2026-10-15)

`.memory-bank/evidence/rt-evidence-runs-2026-10-15.md` holds the commands, commit, machine and results.

- RT-9: `dirty-overlay-build.test.ts` passed 30 of 30 consecutive runs.
- RT-23: `dirty-overlay-build.test.ts` and `backend-overlay.test.ts` passed 20 of 20 consecutive runs on Linux.
- RT-16: `overlay-benchmark.mjs` exited 0; warm medians are 0.84 s for 1 file, 2.42 s for 10, 1.16 s for 25 and 1.38 s for 50, against a 41 s baseline analyze.
- RT-10: a clean clone analyzed with an isolated registry has 3,855 TS-to-TS IMPORTS edges (294 before the fix) and 8 direct callers of `runImpactKernel`. The original import specifier is not stored on the edge, so the `.js` specifier count cannot be reported.

Tracker route: the manager runtime accepts `complete-local` for `full` and auditor-gated tasks when `dispatch_mode` is `none`, the task is the active next task, its dependencies are DONE, no role results or dispatch binding exist, and `closeout.main_session_evidence` carries `authorized_by`, `authorization_ref` and `validation_summary`. Each task needs its own fresh evidence, so bulk closure is not justified.

