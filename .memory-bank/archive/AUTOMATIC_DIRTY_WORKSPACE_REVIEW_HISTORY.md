# Automatic dirty workspace: archived review segments

Moved out of `AUTOMATIC_DIRTY_WORKSPACE_PROJECT_PLAN.md` on 2026-10-18 to keep the tracker under the parser size ceiling. Historical record; the tracker holds the current state.

## Review round 2026-10-17 (three read-only challengers, one disconnected and re-run)

Fixed in the working tree, each with a test that fails without the fix:
- HIGH: a workspace graph covers the whole captured tree but only git-dirty files were
  verified on reuse, so an `--assume-unchanged` tracked file edited after the build left a
  stale graph `usable`. `base.json` now records a full per-file inventory (size, mtime, ino,
  sha256; truncation degrades coverage); reuse compares the eligible path set and stats every
  file, hashing only changed ones (cap 200). Residual, accepted: an edit preserving size,
  mtime AND inode of a non-dirty file is undetectable by stat.
- HIGH: overlay pruning deleted `generations.slice(3)` with no pin check, and pool pins never
  protected overlay directories (`acquireIndexGenerationPin` ignores `overlay/`). Added
  `acquireOverlayGenerationPin` / `overlayGenerationIsPinned` (same publication lock), a
  pin-aware prune, and a 2 GiB per-repo admission check (`overlay_budget_exceeded`,
  override `ONTOINDEX_OVERLAY_BUDGET_BYTES`). `withPinnedOverlay` now holds the marker for the
  whole scope. The budget is measured after publish, so one build may overshoot once.

Measured (reviewer, 1,322-file copy of src+test): `runFullAnalysis({workspaceGraph:true})`
47.0 s, 1.89 GiB peak RSS, 48 MiB generation; capture 0.98 s / 14.3 MB. Scoped overlay
capture ~0.13 s; reuse inventory check 83 ms. A 10x tree is extrapolated at ~470 s and an
unreliable ~19 GiB RSS: the full-graph build is the cost risk, not capture.

Fixed 2026-10-17 after an independent challenge of the opt-in route (two reviewers; the gate,
coalescing, lock release and ALS handling had no defects): `closeLbug()` / `closeLbug(repoId)` now
defer closing a database that a live request pin references (the scope's final release closes it;
two integration tests fail without the fix), and the Class/Constructor preference query in
`resolveSymbolCandidates` reads the workspace generation instead of the base index. Still open:
an explicit shutdown no longer force-closes a pinned database until the scope ends. Measured 2026-10-17 on a 1,673-file TypeScript copy (8 cores): the first `context` call that builds the workspace graph took 39.8 s (the committed analysis of the same tree took 40.8 s), the published generation was 50 MiB, the process was 2.3 GiB at exit (it also ran the committed analysis, so this is not the build's own peak), and the next call took 0.36 s. Cost does not track file count cleanly (1,322 files took 47 s earlier on a busier machine). A repo near the 2,500-file limit would likely exceed the 60 s waiter deadline: that waiter gets retryable `workspace_timeout` while the build keeps running, and the next call succeeds. Not measured: peak RSS of the build alone, repos above 1.7k files, concurrent readers. Build-cost gate added: `prepareWorkspaceRead` refuses a workspace-graph build when the base index has more than 2500 files (`ONTOINDEX_WORKSPACE_MAX_FILES`, error `workspace_too_large`, derived from the 1.3k-file / 47 s / 1.9 GiB measurement), and a failed build for an unchanged snapshot is not retried for 30 s. ADW-5d: NOT done. A first attempt (89b00aa) made `query()` search every file of a workspace graph and drop all base rows; an independent review showed it regressed results (alphabetical LIMIT scan replaced ranked/exact hits, include_paths applied after the limit, all rows tagged overlay so process/content enrichment was skipped, skeleton read the base graph). It was reverted. Search keeps the dirty-file merge; a proper design must rank on the workspace graph with the same lanes and enrichment. `impactByUid` (group fan-out) now goes through the gated `impact` handler when `ONTOINDEX_AUTO_WORKSPACE=1`; a workspace error, an ambiguous result or a preparation failure returns null as before, and the flag-off path is unchanged (4 dispatch tests with mocked handlers; no test runs a real workspace graph through it). Mapped and NOT routed (bypass map 2026-10-17): lazy graph-backed super-tools `server.ts:548-577`, facade audit aliases `facade/dispatch.ts:63-72`, group ports `local-backend.ts:1512-1517`, `impactByUid` (now routed, see below), resource helpers ~3025-3071; `repomap` and the `explore` alias enter the gate but are missing from `RELATIONSHIP_TOOLS`. Correction: adding them to `RELATIONSHIP_TOOLS` is wrong on its own. The gate only builds and pins the workspace generation under the overlay pool id, so a handler sees workspace data only if it reads through `queryOverlay`/the snapshot (as `context`, `impact` and `search` now do). `repomap` (`backend-repomap.ts:168-324`) reads `executeParameterized(repo.id)`, which is the committed graph, so each such handler needs its own rewiring before it is listed. Interim measure (not a fix): with `ONTOINDEX_AUTO_WORKSPACE=1` and a dirty tree, the lazy graph-backed super-tools and the facade audit aliases append a warning that they read the committed index (`committedGraphNotice`, `LocalBackend.withCommittedGraphNotice`); the helper has a unit test, the two call sites are covered only by the existing suites staying green. Dead until wired: `isAuthoritativePath`, `selectWorkspaceCapability`,
`isAuthoritativePath`, `workspaceGraph` (no production caller), `snapshotIdentity` (no supplier),
`createWatchCommand` `refreshCallback` (no supplier). No `prepareWorkspaceRead`, so a user
today gets NO automatic dirty-workspace answer: `ontoindex context` still returns committed
results or a manual overlay. Missing entirely: eight-idle-repos / 60 s eviction, hard-link
rejection, nested-repo rejection in capture, CLI backend disposal.

## First end-to-end route (2026-10-17, branch feat/automatic-dirty-workspace)

Checkpoint commit `b4a1041` holds the program up to review round 2 (41 files; the three
pre-existing dirty files, `Makefile` and `justfile` were not staged). On top of it, an
opt-in route now exists, OFF by default:

- `prepareWorkspaceRead` (`local-backend-repo-runtime.ts`), active only when
  `ONTOINDEX_AUTO_WORKSPACE=1`: clean tree returns the plain snapshot; otherwise it uses
  `selectWorkspaceCapability`, and for relationship reads on a dirty tree builds ONE isolated
  workspace graph under the existing analyze lock (`workspace_busy` if held, never waits),
  coalesced per repo with one pending successor, per-waiter timeout/abort, then re-reads the
  snapshot and refuses to return an unusable one. Typed `WorkspacePreparationError` codes:
  `workspace_busy | workspace_build_failed | workspace_timeout | workspace_cancelled`.
- `dispatchRepoTool` calls it for graph reads; `RELATIONSHIP_TOOLS` need relationships.
- `resolveSymbolCandidates` treats a workspace-graph snapshot as the whole truth (base rows
  dropped, tombstones kept) and tags symbols `graph: 'workspace-graph'`; `context` and
  `impact` then run real relationship traversal through `queryOverlay` on the pinned
  generation (`impact-kernel.ts` takes an optional `query`, default unchanged). A symbol in a
  parse-error file reports `graphImpactAvailable:false` / UNKNOWN.

Measured end to end (tmp repo, committed index + dirty edit, `context`/`impact`):
flag unset: `freshlyAdded` NOT found, `impact callee` LOW/1 from the committed graph (the
dirty edit is invisible). Flag set: `freshlyAdded` found with `source: workspace-graph`,
`graphImpactAvailable:true`, callers of `callee` populated, ~2.5 s for the first call
(includes the build), ~1.3 s earlier on the symbols-only path. 139 test files, 1979 tests
passed / 13 skipped, `tsc` clean, eslint 0 errors.

Not done on this route: search (ADW-5d), lazy super-tools / facade aliases (5f), resources
(5g), pagination (5h), docs (5i), CLI disposal, idle eviction, a retry/backoff policy for
failed builds, a build-cost gate for large repos (47 s / 1.9 GiB measured on 1.3k files), and
default-on activation. A watch-driven background refresh is not connected either.

Open: independent challenger over the round-2 fixes and ADW-5b/5c;

## Search on a workspace graph — design (2026-10-17, not implemented)

Facts from source: `query()` (`backend-search.ts`) ranks with BM25 (`searchFTSFromLbug`, FTS indexes), a
vector lane (embeddings), a graph-traversal lane and typed candidates, then enriches rows from the base
graph. The workspace-graph build (`run-analyze.ts`, workspaceGraph branch) writes nodes and edges only:
no FTS index step, `embeddings: 0`, `embeddingLifecycle` off. Pool queries open the database read-only, so
`CREATE_FTS_INDEX` cannot run at query time. A reverted attempt (89b00aa) replaced ranking with an
alphabetical substring scan, which lost exact hits, applied `include_paths` after the limit, skipped
enrichment and read the base skeleton.

Options considered:
1. Substring scan on the workspace graph (the reverted attempt). Cheap, wrong ranking. Rejected.
2. Build FTS indexes inside the workspace build, then run the existing BM25 lane on the pinned
   generation. Correct lexical ranking for dirty and clean files, one extra build phase (cost on the
   order of the committed FTS phase), no vector lane. Needs `searchFTSFromLbug` to accept an executor
   bound to the pinned generation (it already has an executor seam) and the build to call the existing
   `createFTSIndex` before publish.
3. Keep base ranking and only re-rank/replace rows from the dirty set, adding new dirty symbols by the
   existing symbols-overlay merge (today's behavior). No new cost, but clean files whose resolution
   changed because of config or neighbouring edits keep stale rows.

Recommendation: option 3 stays the default for `query`. Option 2 is the only correct way to be
authoritative, so implement it in this order: (a) FTS phase in the workspace build, behind the existing
size gate, measured; (b) BM25 lane on the pinned generation with the same limit/`include_paths`
semantics as today; (c) rows tagged `workspace-graph`, enrichment (processes, content, skeleton) read
from the same generation; (d) vector lane reported as unavailable in `warnings` rather than served from
the base index; (e) a test with a real workspace generation that fails for: exact hit beyond the
alphabetical window, `include_paths`, deleted file, and parse-error file. Do not start (b) before (a)
is measured, because FTS may add a large share of the build time.

Step (a) done 2026-10-17: the workspace build now creates the standard FTS indexes before publishing and records `ftsIndexes` and `ftsDurationMs` in `base.json` (a missing FTS extension leaves an empty list; the generation stays valid). Measured on the 1,673-file copy: 1.4 s for five indexes, generation 50 MiB -> 82 MiB, first `context` call 43.3 s (39.8 s before; run-to-run noise is of similar size). One integration test builds a real workspace generation and runs `QUERY_FTS_INDEX` against it through `queryOverlay`; it fails without the change. Nothing reads the indexes yet (steps b-e).

Steps b-e done 2026-10-17 (commit follows 9eac7b9): `query()` in plain mode, when the request holds a pinned workspace generation whose `base.json` lists FTS indexes (`OverlaySnapshot.ftsIndexes`, `hasPinnedOverlay`), ranks with the existing BM25 lane against the `::overlay` pool id (which the pool resolves to the pinned generation), skips the dirty-file merge, skips the vector lane and `retrieval_policy: symbol-neighborhood` with warnings, and reads process/cohesion/content/citation/skeleton enrichment from the same generation. Typed queries, generations without FTS indexes, and the flag-off path keep the old behavior. Six integration tests run a real workspace generation through `LocalBackend.callTool('query')`: exact hit among 30 earlier-sorting matches, working-tree-only symbol, deleted file, `include_paths` (docs hit and src exclusion), vector warning, neighborhood-policy warning. The first attempt (89b00aa) failed review; this one was reviewed by an independent challenger, which found the neighborhood leak (fixed) and the `include_paths` limit below.
Known limits of this search lane: (1) fixed after review: on this lane `include_paths`/`exclude_paths` are pushed into the `QUERY_FTS_INDEX` query (`FTSPathScope`, `WITH node, score WHERE ...`), so 70 stronger matches under `src/` no longer hide a weak match under `docs/`; two tests cover include and exclude, and the include test fails without the change; the committed-graph lane still filters after the window; (2) files with parse errors (coverage `partial`) are returned like any other row; (3) no vector ranking; (4) the structured-result cache is bypassed; (5) the pre-existing fallback test for the lane uses a toy repo, not a large one.

## Review round 3 — what was done well, worst, forgotten (2026-10-17, HEAD a237ad1)

Done well: every shipped defect since the first route was found by an independent reviewer and fixed with a test that fails without the fix (closeLbug under a pin, class preference on the base graph, neighborhood leak, include_paths window); the reverted search attempt was recorded instead of hidden; measurements are tracked with their limits.

Done worst: (1) search was marked done before review (89b00aa) and its mocked tests could not see the regression; (2) the 2,500-file default rests on two measurements and the 60 s waiter deadline sits close to the measured build time; (3) `RELATIONSHIP_TOOLS` membership was nearly treated as routing; (4) the manager loop has no receipts for any of this work, so nothing is formally accepted.

Forgotten or contradicted (audit, source-verified by the auditor, not all re-checked by me): idle-repo eviction (8 repos / 60 s) is not implemented; the watcher `refreshCallback` and semantic-cache `snapshotIdentity` have no production supplier; the CLI `tool.ts` backend singleton is never disposed; capture does not reject input files with nlink>1 (the ADR forbids creating hard links, so this one is an interpretation); configuration traversal skips `.git` entries but still descends into nested repositories; the 2 GiB overlay budget is checked only before a build (a log line now reports an overshoot); an abandoned waiter does not stop `runFullAnalysis`, which keeps the analyze lock until it ends (`runFullAnalysis` takes no AbortSignal); lock-acquisition failures are not covered by the failed-build cooldown, so `workspace_busy` is not throttled; typed queries keep the dirty-file merge even after a full build; HTTP `statusFromError` maps unknown codes to 500 (no verified caller of the gated path, so unchanged); the flag was documented only in code (README now lists both variables).

Changes made this round: reads that need no relationships (search, overview and the like) degrade to the committed index plus dirty-file merge with a warning when the build is refused, in cooldown, busy or failing, instead of failing; `query` now requests the workspace build itself (it used to use the workspace graph only after a `context`/`impact` call had built it); README documents `ONTOINDEX_AUTO_WORKSPACE` and `ONTOINDEX_WORKSPACE_MAX_FILES`.

Challenger on these changes found two defects, both fixed with tests that fail without the fix: (1) a search whose build outlasted the 60 s waiter deadline still threw `workspace_timeout` (now answers from the committed index with a note; relationship reads still throw); (2) a degraded fallback could carry a usable old overlay generation that a concurrent build prunes before the request pins it, so dispatch failed with 'overlay generation no longer available' (a degraded snapshot is now marked unusable). My first test for (2) passed with the fix removed; the fixture had to be reset before it proved anything. Follow-up: aborting an abandoned build was rejected. On a repository whose build exceeds the 60 s waiter deadline, every search would abort and restart it and the graph would never finish. The build keeps running instead, and a test shows the next request joins it (one build, one lock, one release). A held analyze lock is now remembered for 5 s so requests stop re-probing it (test fails without it). Still true: an abandoned waiter's build holds the analyze lock until it ends, so `ontoindex analyze` started in that window reports the lock as held.

## Manager-loop status and proposed re-scope (2026-10-17, HEAD f50eb7c)

Loop state, read-only: `manager_loop_next` returns `no_dispatch` for ADW-2: the accepted terminal result is `blocked: dependency gate` (receipt `role-result-706e6872...`, verdict BLOCKED, blocker text "path error during source inspection") and "requires fresh evidence before redispatch". ADW-1 is DONE; every other task is OPEN; there are no PASS receipts.

Fresh evidence gathered outside the loop: ADW-2's own `required_validation` passes on the current tree (`workspace-input-capture.test.ts`, 67 tests, exit 0; `git diff --check` exit 0). The blocker named in the receipt (a missing ADW-1 contract and a path error from an absent `ONTOINDEX.md`) is an environment fault of that worker, and ADW-1 is now accepted. The code and tests for ADW-2 through roughly ADW-5 exist on this branch (commits b4a1041..f50eb7c) but were written in the main session, not under authenticated worker leases.

This is not acceptance. Options for the owner of the loop, none applied:
1. Reopen ADW-2 with the fresh evidence above and dispatch a `coder-worker` or challenger that verifies the existing diff and returns a PASS receipt; repeat per task. Honest, slow, one receipt per task.
2. Re-scope the tracker to the work actually done (collapse ADW-2..5 into verification-only packets whose write set is empty) so each can receive a PASS from a read-only challenger.
3. Leave the loop as is and treat this branch as unreviewed-by-loop work; merge only through the normal PR review.

Recommendation: option 1 for ADW-2 first, to learn whether the worker role can issue PASS for pre-existing work (it refused earlier), then decide between 1 and 2.

