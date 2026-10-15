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

