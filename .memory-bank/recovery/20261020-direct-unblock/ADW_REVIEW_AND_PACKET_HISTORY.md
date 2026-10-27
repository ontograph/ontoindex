## Review And Challenge — 2026-10-17

Four bounded read-only reviewers used two `gpt-6-luna` and two
`gpt-6.1-sol` agents. The original eight-task plan passed structural validation;
source review found the execution gaps below. No implementation was executed.

| Finding | Evidence at review baseline | Required correction |
| --- | --- | --- |
| Broad phases leave Luna to design and integrate several owners | Original ADW-2 through ADW-6 had 6–9 writable files and all eight tasks were complex | Split by one result and existing owner; manager settles architecture before dispatch |
| Design artifact and acceptance disagree | Original ADW-1 allowed only TS files but required schema fixtures | ADW-1 writes an ADR/plan; ADW-6b owns response fixtures |
| Default enablement has a semantic cycle | Original ADW-6 required ADW-7 proof, which depended on ADW-6; ADW-8 also required pre-enable readiness | Staged proof → performance → readiness/docs → default switch → no-override smoke |
| Read gate omits entry points | `server.ts:537` handles saved pages; `server.ts:547` lazy dispatch and `resources.ts:508` resource dispatch bypass backend callTool | Explicit lazy-route/resource packets; preserve immutable response replay |
| Generation retention does not pin a request | `backend-overlay.ts:229` resolves CURRENT per query; `pool-adapter.ts:1508` resolves mutable pool entry | Include pool owner and request-lifetime handle; source/cache/cursors use the same identity |
| Content/relationship completeness is unproven | `analyze-delta.ts:363` plans live files; `backend-overlay.ts:92` checks mtimes; `run-analyze.ts:825` builds changed-file symbols and rejects over 50 | Captured bytes, isolated full-graph path, escalation and incoming-edge parity |
| Existing assertions require behavior the plan prohibits | `overlay-query-merge.test.ts:326` permits unusable-snapshot cache hits; `overlay-context-impact.test.ts:253` preserves base fallback | Update automatic-current assertions explicitly; preserve any separately declared committed mode |
| Replay/performance proof has no adequate instrument | `overlay-cross-process.test.ts:50` explicitly invokes analyze; `overlay-benchmark.mjs:39` accepts only sizes 1–50 | Author/test instrument, run one pilot, then independent replay and repeated measurements |
| Lifecycle failure can be sticky | `watch.ts` refreshBase checks attemptedHead; stop sends SIGTERM without awaiting exit | Same-HEAD retry and owned-child drain regression |
| Test cost and success criteria are misleading | `vitest.config.ts:23` runs native setup; `tsconfig.json:18` covers source only; ignored unhandled errors can survive process exit | Serial focused tests; native setup stays unless proven unnecessary; inspect stderr and child termination |

Some OntoIndex method lookups were degraded: exact `buildOverlaySnapshot`
was not indexed and `callTool` inspection reported
`method-metadata-query-failed`. OntoIndex stale/degraded: those symbol lookups
could not establish method detail; source inspection is authority. Repository
freshness itself matched HEAD; no reindex was needed. The repository-referenced
`ONTOINDEX.md` is absent; supplied policy and `AGENTS.md` were available.

### Task-structure alternatives and second review

| Option | Correctness, robustness and compatibility | Complexity, performance and cost | Security, tests and rollback |
| --- | --- | --- | --- |
| Keep eight tasks with internal checklists | Preserves requirements but leaves unresolved contracts and cross-owner integration inside each worker | Few dispatches; large context and repeated broad validation | Large rollback; omissions and lifecycle gaps remain hard to localize |
| Broad vertical features: symbols, relations, lifecycle | Early end-to-end proof, but repeated shared-owner changes and temporary compatibility states | Less upfront contract work; repeated harness and graph builds | Rollback spans layers; must independently gate unsupported relationships |
| Owner-sized packets plus design and proof gates — selected | Freeze interfaces first, preserve requirements and explicitly order default activation | More small dispatches; narrow context and focused tests, expensive checks at checkpoints | Preserve security invariants; packet rollback and independent failure/resource proof |

Second review: file count alone cannot make capture, pool lifetime or scheduling
simple. Those packets retain full assurance/high risk, and must be split again
if ADW-1 cannot settle their contracts within the declared owner. A checklist
does not repair missing ownership; vertical slices do not remove cursor or
incoming-edge obligations. Selected packets reduce worker uncertainty without
reducing the requested behavior. No latency or token-cost savings are claimed
as measured results.

## Archived review rounds

Review rounds of 2026-10-17 (rounds 1 to 3, the first end-to-end route, the search design and the manager-loop status) are in `.memory-bank/archive/AUTOMATIC_DIRTY_WORKSPACE_REVIEW_HISTORY.md`.

## Luna Packet Contract

### Direct-session status (2026-10-17, outside the manager loop)

The user directed the remaining work to be done in the main session with
`gpt-6.1-sol` low subagents and no cdr workflow. The `manager_loop` block below
is unchanged: ADW-2 through ADW-3 stay OPEN because no authenticated PASS
receipt exists, and none may be marked DONE from this note.

Implemented in the working tree (162 focused tests, `tsc --noEmit` and
`git diff --check` clean): ADW-2 capture with ignore-file regular-file
rechecks; ADW-2a `capturedWorkspace` pipeline option; ADW-2b scoped capture in
`runDirtyOverlayAnalysis` with `manifestDigest`, `configurationDigest`,
`parserIdentity`, `includePaths` and per-file digests in `base.json`; ADW-2c
reuse by content and configuration identity with per-call re-verification of
cached usable snapshots; ADW-3 coalescing in `ensureRepoInitialized`.

Scope correction for ADW-3: the owner file has no build entry point, so the
implementation coalesces repository open/reopen, not analyze builds. Build
coalescing would belong to the analyze caller and is not covered.

Measured on this repository, one-file overlay capture: 1,311 ms, 1,728 files,
16.7 MiB before scoping; 47-64 ms, 9 files after; identity probe about 2 ms.
Nested-git-root search is now scoped to the include-path ancestor chain.

Also implemented since: `ignore-service.ts` nonblocking regular-file reads; capture
base identity via `readActiveGenerationMeta` (fails closed only when the pointer
moves mid-read); ancestor-symlink swap regression test (the narrow
check-then-open window is not isolated by a test); overlay queries bound to the
validated generation; ADW-3a automatic `refreshCallback` mode, token-bearing
`watch.lease`, idempotent async `stop()` with SIGKILL escalation and a 5 s cleanup
deadline, `owned` flag, and 1/2/4/8/16/30 s same-HEAD retry backoff (32 watch tests).
Challenger batch 1 found and I fixed: directory-scope nested-git exclusion, stale
usable cache after a newly dirty file, and sibling `.csproj` identity omission.

ADW-3b implemented: per-waiter `signal`/`deadline` (60 s cap) on
`ensureRepoInitialized` with typed `RepoPreparationWaitError`; shared work survives
a cancelled waiter; successors do not inherit a waiter's deadline. Challenger 2
confirmed and I fixed `stop()` releasing the lease while an automatic refresh
callback was still running (regression test fails without the fix). Product
question left open: a permanently failing callback retries forever at the 30 s cap.

ADW-4 implemented: `workspaceGraph` option builds an isolated complete graph from the
same full capture (full profile), publishes under overlay/<generation> with
capability/profile/coverage in base.json, re-verifies HEAD and base before
publication, never touches the committed index. ADW-4a implemented:
`backend-overlay.ts` reads workspace-graph generations (dirty-set equality, dirty-file
digests, config and parser identity, usable only when coverage is complete) and exports
`selectWorkspaceCapability` and `isResolverConfigPath`.

Parse-error coverage (REQ-008) now closed in code: `parse-worker.ts` and
`parsing-processor.ts` record files whose tree reports `rootNode.hasError`; `parse-impl.ts`
emits one `parse-error-files` event per chunk (`parseErrorCount`, first 100
`parseErrorFiles`), distinct from `parse-degraded-files`. `runWorkspaceAnalysis`
records `parseErrorFiles` (max 1000) and sets coverage `partial`; if the list is truncated
or other degradation fires, coverage is `degraded` and the graph is unusable.
`backend-overlay.ts` exposes `parseErrorPaths` and `isAuthoritativePath(snapshot, path)`;
a partial graph is usable but an empty caller/impact answer for a parse-error path must
not be presented as authoritative. Verified with a sequential probe and a worker-pool
probe on a freshly built `dist` worker (both report the syntax-error file and a NUL-byte
`.ts`, no degraded event). Output of the graph is unchanged: files are not dropped.
Callers of `isAuthoritativePath` do not exist yet; ADW-5 onward must use it.

ADW-5 implemented: `withPinnedGeneration(repoId, dbPath, fn)` in `pool-adapter.ts`
(real path resolved once, refcounted immutable entry, ALS-routed `executeQuery` /
`executeParameterized`, eviction exempt, last release closes via a narrow `closeLbug`
branch) and `withPinnedOverlay(repo, snapshot, fn)` in `backend-overlay.ts` (path from the
snapshot's validated generation, never re-reads CURRENT inside the scope). A subagent
reported its pool tests passing when two failed (fixture used a symlink outside storage and
a wrong field name); I rewrote the fixture to publish real generations. Not verified: that
two generations with different DATA stay isolated (the test compares the same template's
counts), and pruning beyond the reader marker.

ADW-5a implemented as a THIN gate in `dispatchRepoTool`: one `getOverlaySnapshot` per
outermost graph read, `withPinnedOverlay` when usable, `ReadRequestContext` /
`getReadRequestContext()` for downstream tasks, typed `workspace_preparation_failed`
error. No building (ADW-6). Bypass map (subagent): lazy super-tools and audit aliases
(`server.ts`, `facade/dispatch.ts`) -> ADW-5f; resource reads -> ADW-5g; `impactByUid`,
`mcp/super/*` direct pool reads and CLI audit/review/report/export/docs -> unpinned until
their tasks; mutation tools are exempt wholesale so their graph preflight reads are unpinned.

ADW-5b implemented (`resolveSymbolCandidates` takes `{ snapshot }`; a usable snapshot
whose overlay query fails now rejects instead of returning base-only identities; the old
"degrades query errors to base" context/impact test was split accordingly). ADW-5c
implemented (`snapshotIdentity` on semantic-cache key/entry/lookup; legacy keys byte-identical).

### Current implementation challenge and correction

On 2026-10-17 four new bounded reviewers inspected the existing capture and
plan. Two development reviewers used `gpt-6.1-sol` with requested low effort.
ADW-1 is accepted; ADW-2 code exists but has no accepted implementation result.
The remaining 34 tasks are unfinished. Prior 18-test results are historical,
not validation of a correction.

Good: capture reuses manifest hashing, retains legacy manifest shape by default,
and tests content changes, bounded retries and owned-tree cleanup. Weak: positive
configuration tests all specify baseUrl, hiding rejection of ordinary empty or
strict-only configs. The shared root calculation also incorrectly applies
baseUrl to extends/references, potentially accepting an external config path.
Forgotten: current status prose, malformed optional-field cases and distinct
resolution bases. File/byte preflight eligibility and active-generation identity
need targeted follow-up before ADW-2 acceptance; performance remains unmeasured.

Compared twice: dropping falsy/nullish values masks explicitly malformed inputs;
replacing the parser broadens scope and compatibility risk; validating supplied
fields in the existing checker preserves rejection and fixes both path-base
and omission defects. Select the third option. Validate object/string/array
shapes before constructing roots; resolve baseUrl, rootDirs, typeRoots, extends
and references from the configuration directory, and paths targets from baseUrl
when declared. Reject lexical escapes and absolute paths as before. Regressions
cover omitted fields, malformed supplied values, and baseUrl concealing an
external extends/reference. No added dependency or new configuration owner.

Resume evidence: the prior blocker was an interrupted worker, not an unavailable
architecture dependency. Current source confirms the exact correction above;
new bounded agents are available and the user explicitly requests execution.
The runtime's dependency_resume_authorized predicate requires
`dependency-cleared:<accepted result receipt ID>` for this accepted BLOCKED
dependency result. Use that supported transition, preserving its receipt and
attempt history. The selected correction stays inside ADW-2's existing scope.
After correction run focused capture tests, inspect full diagnostics, then the
authenticated challenger before ADW-2a. Preserve verification passes until
measurement supports changing them. Do not equate test success with acceptance.

knowledge_handoff: none — the installed manager-loop skill already requires
receipt-bound resume, bounded correction and final validation after edits.

ADW-1 is preserved as a completed design gate below. The active map contains 34
unfinished tasks with stable suffixed IDs. ADW-2 is selected; its implementation
is unaccepted. The accepted ADR and completed gate remain mandatory preconditions.

- Normal implementation packet: one observable change, one production file and
  one test; at most two tightly coupled production files plus one test.
  Test-authoring packets own at most two files. Shared files serialize.
- The validator requires complex classification for these high-risk/full-gate
  tasks. Affordability comes from scope and context bounds; classification does
  not promise a low-risk change or override the derived role sequence.
- ADW-1, proof, measurement, documentation and closeout remain with their
  derived manager/auditor/performance roles. Task sizing does not override fixed
  role/model bindings. Eligible bounded implementation can use Luna only through
  the authorized workflow; retain required challenger gates.
- An OPEN implementation-ready record is dependency-gated. ADW-1 must first
  freeze exact symbols, existing helper, signatures, capability matrix, fixtures
  and commands. These are planned packets, not authorization for unresolved
  architecture work. Any additional owner becomes a separately prepared task.
- Dispatch only that task, its accepted ADR clauses and direct dependency
  receipts, the exact source slices, one Given/When/Then scenario and stop rules.
  Do not send the entire tracker or ask Luna to rediscover the design.
- Each packet's expected_evidence is its Given/When/Then acceptance. Scope,
  commands and rollback are in YAML. No worker may silently widen them.
- Run the listed focused test after the final edit. TypeScript and broad replay
  run at ADW-7e and after the final switch at ADW-8b; use an earlier type check
  when a shared signature changes. Do not rerun the entire suite per packet.
- Keep max_in_flight at 1 for implementation. Independent read-only review can
  satisfy the four-agent repository policy without inventing writers or four
  implementations per small packet. Native validation stays serial.
- On the first unresolved architecture/scope decision stop for the manager.
  Permit one bounded correction of the same failed packet, then reassess scope
  rather than looping through unchanged tests.

### Required ADW-1 decisions

Accept `.memory-bank/ADR_AUTOMATIC_DIRTY_WORKSPACE.md` before code dispatch.
Specify the verified immutable input-set semantics; do not promise an atomic
filesystem snapshot from a sequence of file reads. The parser, resolver and
source enrichment must consume exactly that captured set. Define the capture
verification point, 60-second request deadline, at most two capture attempts,
numeric byte/file/retention/cleanup bounds and capability failure semantics.

Freeze an exhaustive route matrix for direct/facade/lazy tools, resources and
CLI, with diagnostics, repairs, mutations and saved-response continuations
classified explicitly. Define legacy field/cursor compatibility and request
pin lifetime. Logical pagination must stay on one generation or explicitly
require restart; immutable saved-response pagination replays its original bytes.

Choose the existing full-analysis seam that avoids committed-index publication,
registry/Git changes, skill generation and paid embeddings. Define parser/resolver
coverage and incomplete-negative behavior. Confirm watcher/refcount owner and
single-flight key without another daemon or lock implementation.

Freeze benchmark baseline/candidate runtime and input hashes, numeric resource
and latency acceptance limits, cold/warm meaning and cleanup limit before
measurement. Use 20 measured samples per workload and nearest-rank p95; the
pilot is instrument proof, not performance proof. Planned benchmark flags below
are implemented by ADW-7c, not capabilities claimed to exist today.

## Review round 4 and ADW-2 HOLD evidence (2026-10-18)

Archived in `.memory-bank/archive/AUTOMATIC_DIRTY_WORKSPACE_REVIEW_HISTORY.md`. The ADW-2 HOLD itself is unchanged and is recorded in the manager_loop block.

## Review round 5 (2026-10-18)

- Older round 5 bullets are archived in `.memory-bank/archive/AUTOMATIC_DIRTY_WORKSPACE_REVIEW_HISTORY.md` (sections "Review round 5 — earlier bullets archived 2026-10-18 (second pass)").
- **Dangling `MEMBER_OF` edges (commit 80ab602, unproven as the cause of the intermittent COPY abort).** `community-processor.ts` skips singleton communities when it creates Community nodes, but the `communities` phase wrote a `MEMBER_OF` edge for every membership, so edges pointed at nodes that do not exist. Nothing between the graph and the bulk COPY drops edges with missing endpoints (`csv-generator.ts` writes every relationship; `splitRelCsvByLabelPair` checks only labels). The phase now writes edges only for communities that got a node; `processes` still receives the full membership list. A unit test fails without the change and passes with it. Whether this removes the `std::get: wrong index for variant` abort is not yet shown: the baseline was 2 failures in 15 harness cold builds and 0 in 14 direct runs, and the supervised loop at `cb785c3` had 8 of 8 ok when stopped. The 20-repetition matrix at 80ab602 is the before/after check.
- **Matrix attempt at 80ab602 (aborted at sample 39 of 40, exploratory, not ADW-7f).** Sizes 1 and 50, compiled CLI, 20 repetitions requested, 1,725-file corpus, load average 7 to 13. Size 1 completed: cold median 48.0 s, max 57.6 s, peak RSS 2.38 GB, 20 builds; warm median 0.62 s, max 0.76 s, 0 builds. Size 50: 19 cold samples before the abort, median 56.9 s, max 58.6 s, so the 55 s dirty-cold p95 budget is not met at this size. Sample 20 of size 50 (`s50-cold-19`) waited 61 s and returned the retryable `workspace_timeout`: the admission deadline (`local-backend-repo-runtime.ts`, 60 s) sits within 3 s of a typical cold build, while the build's own deadline is 120 s. The harness correctly aborted and wrote no artifact; the raw samples are in `.ontoindex/adw-validation/matrix-1-50.json.raw`. Native COPY failures: 0 of 39 cold builds with the MEMBER_OF change, against 2 of 15 harness cold builds before it. That is suggestive only (Fisher exact one-sided p about 0.07 on those two groups) and does not prove the fix. Open decisions: raise the admission deadline above the build deadline or keep the retryable error, and decide whether the harness should record a retryable timeout as a failed cold sample instead of aborting.
- **Matrix 1/50 at 47b79ff (complete, exploratory, not ADW-7f).** 20 repetitions at sizes 1 and 50, compiled CLI, 1,730-file corpus, machine oversubscribed (load average 10 to 22 on 8 logical CPUs). 80 samples (40 cold, 40 warm), no native failures and no `workspace_timeout`; artifact `.ontoindex/adw-validation/matrix-1-50.json` (git-ignored). Cold: size 1 median 56.3 s / p95 62.8 s; size 50 median 60.4 s / p95 62.7 s; both exceed the 55 s dirty-cold p95 budget (the runner exits 2). Cold CPU median 66 to 70 s, peak RSS max 2.49 GB. Warm: size 1 median 0.69 s / p95 0.86 s; size 50 median 0.58 s / p95 0.71 s; 0 builds; both inside the 1 s budget. Cold times were about 50 s at the same corpus when load was lower, so the budget miss is confounded by load and is not yet attributable to the build. COPY abort: 0 failures in 79 cold builds after the MEMBER_OF change (39 at 80ab602 plus 40 here; the 40 warm samples run no build) against 2 in 15 before; one-sided Fisher p = 0.024. That is evidence for the fix, not proof of the native cause. The admission-deadline change (47b79ff) removed the 61 s timeout seen earlier.
- **Full suite at 1baf2ea, and the `super-functions` buffer failures (resolved).** The two `gnExplainModule` integration tests failed with "Buffer manager exception" at the default 64 MiB. They fail the same way on base `cb1d40c` when the live index is linked in, so the failure predates this branch. Cause: the exported-symbols query returned whole nodes (`RETURN s`), which materialises every property of each exported node on a large file; a probe on `backend-search.ts` showed that shape failing while a column projection (138 rows, 5.7 KB) and a `COUNT` both succeeded. The query now projects `name`, `label(s)`, `startLine` and `endLine` (commit 1baf2ea), with two unit tests (the query-shape test fails without the change). `super-functions` is 19 of 19 at the default buffer. A challenger found no persisted `signature`, `kind`, `type` or `symbolName` column in the schema, so nothing is lost, but it did not run a live query to compare `label(s)` with the old node label; the integration test accepts only the labels Function, Class, Const, Interface, TypeAlias and Variable and passes. Full suite: 12 files and 23 tests failed, 11,479 passed; the failing set is identical to the 25 entries in `/tmp/base.set` (no new failures, none from this branch). Those base failures are unrelated to this work (audit schema fixtures, dist packaging, parsing fixtures, analysis-coordinator, api-guards, repo-manager chmod, markdown-sidecar).
- **Config and two-client contention workloads added to the benchmark (7c9b475, 037296d); a real duplicate-build race found and fixed.** `--extras config,contention` (default on; `--extras none` and `--sizes none` select subsets). Config edits `ontoindex/tsconfig.json` with whitespace and also edits one source file, because the dirty planner counts source extensions only: a config-only edit is not a dirty path and the read answers from the committed index (verified with a probe: `allDirtyPaths` is empty for a tsconfig-only change). That is a finding about the feature, not the harness: a resolver-config edit alone does not trigger a working-tree graph. Contention starts two real stdio servers together on one dirty clone with no generation; each retries a retryable busy answer every 500 ms; the invariant is exactly one new generation per round, and the runner aborts and writes `contention-<n>.generations.json` otherwise. The first 20-round run aborted at round 11 with two generations: server B probed a dirty snapshot, server A built and released the lock, then B took the lock and built again. Fix (037296d): after acquiring the lock, evict and re-read the snapshot, and adopt a usable complete workspace graph instead of building; the lock is released in a `finally` that also covers the re-read (a challenger found the first version leaked the lock if the re-read threw; a test now covers it, and both new tests fail without their change). Result at 037296d: 20 of 20 rounds had exactly one writer, 40 clients all reported one build, median 106 busy retries per client (about 53 s of polling), cold latency median 63.3 s / p95 72.8 s with the machine at load 13 to 18, peak RSS max 2.26 GB. The invariant checked is one generation per round, not lock exclusivity. The 55 s dirty-cold budget is missed here as in the 1/50 matrix, and contention adds a second process competing for the same cores, so this workload is not a clean latency measurement.
- **A resolver-config-only edit never triggered a working-tree build; fixed (6358c9d).** The benchmark's config workload exposed it: `planDirtyOverlay` records source-extension files only, so a `tsconfig.json` edit alone gave an empty dirty set, `getOverlaySnapshot` returned the empty snapshot, and `configChanged` in `prepareWorkspaceRead` could never be true for a config-only change. The ADR says resolver and config changes select full analysis. Three fixes were weighed by two read-only sub-agents: (A) a separate `configPaths` field, (B) widening `allDirtyPaths`, (C) a live configuration digest compared on every read. (B) changes flag-off behaviour (symbol suppression, the 50-file bound, watch and status counts); (C) adds a configuration walk and hash to every clean read and rebuilds on a whitespace change either way. Chosen: (A). `DirtyOverlayPlan.configPaths` holds dirty files matching the existing capture pattern with ignore rules applied; `computeSnapshot` returns a non-empty snapshot carrying `configPaths` only when `ONTOINDEX_AUTO_WORKSPACE=1`, so flag-off behaviour is unchanged; `prepareWorkspaceRead` builds when `configPaths` is non-empty and keys the failed-build cooldown on it. A challenger traced the post-build snapshot: the build records source-only dirty paths, so the snapshot validates as usable and complete and a config-only tree does not rebuild on every read, and found no consumer of the old empty-snapshot identity. Residual: the capture pattern includes lockfiles, `.gitignore`, `go.sum` and similar, so one lockfile edit now costs one full build, then reuses it. Six tests (planner, snapshot flag gate, prepare); each of four reverts fails a test. Benchmark at 6358c9d, config edit only: a 3-repetition check at load about 8 had cold 45.7 to 49.2 s and passed every budget; the 20-repetition run at load 11 to 20 had cold median 55.3 s / p95 59.1 s / max 60.3 s (20 builds, peak RSS max 2.27 GB) and warm median 0.42 s / p95 0.51 s (0 builds). So the config path works and warm is well inside the budget, while cold p95 misses the 55 s limit by 4 s under load and meets it on a quiet machine.

## Consolidated Review And Execution Order — 2026-10-18

This review preserves the accepted design, task dependencies and active ADW-2
lease. Implementation evidence and accepted task completion remain separate.
Two `gpt-6.1-sol` reviewers at medium effort reviewed evidence and acceptance
gates. Two `gpt-6-luna` challenge packets were dispatched and cancelled
without accepted results; this consolidation uses the two completed reviews.

### What worked and what needs correction

- The benchmark rejects native errors and retains raw reference responses.
  The size-0/51 run completed with exit 0 and 20 samples per phase. Recorded
  p95 latency was 217.83/53.96 ms for clean cold/warm and
  52992.12/293.88 ms for size-51 cold/warm. All recorded budget checks passed.
- The parity run exited 1 before comparison. Its reference request for
  `buildDefIndex` returned a buffer-pool allocation error. This proves neither
  graph parity nor a workspace-specific regression. The saved base loop also
  reports 10 failures in 300 requests; a matched candidate result is still
  needed before comparative attribution.
- Performance acceptance remains incomplete: terminal warm CPU, successful
  same-input parity, matching frozen runtime/input identities across the full
  matrix and the remaining declared workloads need proof. Partial passing
  reports cannot be combined into an accepted matrix without those bindings.
- The memory router and its current/pending projections still describe early
  implementation progress. Refresh them from accepted evidence after the
  receipt gate is resolved; do not promote source presence to task completion.
- ADW-2 retains an active terminal-child lease with no integrated receipt.
  Later implementation and exploratory measurements have advanced beyond
  acceptance. Default activation remains downstream of correctness,
  performance, readiness and ordinary-process smoke gates.

### Alternatives and second challenge

| Issue | Alternatives | Selected path and second-review constraint |
| --- | --- | --- |
| Pending acceptance | Original parent harvests and integrates; preserve lease while conducting bounded review; reset lease or infer PASS from historical text | Recover through the original parent. Bounded review may proceed; reset and inferred PASS lack authenticated authority. No duplicate dispatch. |
| Native allocation error | Retry reference until it succeeds; increase the default pool; diagnose the exact query and use a focused regression | Diagnose first. Retrying masks instability; more memory adds per-process cost without establishing root cause. A base failure does not exclude a candidate regression. |
| Cold latency | Quiet-host rerun under the existing budget; relax the budget; optimize before measuring a stable reference | Retain 55 seconds, establish the reference pilot, then rerun missing proof with frozen identities. Change the budget only through explicit design adjudication. |
| Incomplete proof | Accept passing subsets; rerun everything immediately; preserve subsets and run the smallest missing prerequisite first | Preserve subsets, prove reference and parity first. Do not spend another full matrix on a failing instrument. |

These choices preserve public behavior, resource bounds and rollback scope.
Query changes require OntoIndex impact evidence and a minimal runnable
regression before implementation; no dependency or parallel runtime is needed.

### Ordered continuation within the existing tasks

1. ADW-2: original dispatching parent harvests the terminal child and integrates
   its authenticated receipt. If unavailable, retain the current lease and
   report the exact recovery capability required. Do not hand-edit lease state.
2. Follow dependency-ready correctness tasks in their existing order. Retain
   request pinning, configuration invalidation, capture isolation and lifecycle
   checks. Use at least two `gpt-6.1-sol` medium-effort development/review
   packets when development becomes eligible, with disjoint ownership and the
   plan's required authenticated role gates preserved.
3. Diagnose the reference allocation error before ADW-7e/7f proof: pin runtime
   and inputs, retain the raw request/response, identify its query owner with
   OntoIndex and compare three corrections before editing. Prepare any defect
   outside an existing write set through the manager; do not expand it silently.
4. Run one same-input parity pilot. Require a visible added caller and equal
   supported incoming/outgoing edges. A native error stops progression.
5. ADW-7f: run the declared repeated workloads against frozen candidate and
   reference identities, including terminal CPU evidence and all predeclared
   budgets. Keep failed samples and the original thresholds.
6. ADW-8 through ADW-8c: adjudicate readiness, update documentation and memory
   projections, then activate, smoke-test without overrides and close out only
   through the existing gates. Preserve RT-5 attribution and unresolved defects.

Evidence: `.ontoindex/adw-validation/matrix-0-51.json` SHA-256
`5731d7f3f1e685711defbd5f46588e5eb137d2e2079413e2ccef9669e6604c21`;
failed reference response
`.ontoindex/adw-validation/parity.json.raw/parity-reference.response.txt`
SHA-256 `59c6590b3659191a8bac36db9086e1ec63ab2ac48bc0bb3b695eb731cfc8c70f`.
These are exploratory evidence, not authenticated task closeout.

Execution this review: tracker validation passed for 34 tasks; the manager
returned `no_dispatch` for ADW-2's existing terminal-child lease. OntoIndex
refresh exited 0 and its indexed commit matches HEAD `a6c05e7`; dirty
documentation remains source-verified. `contextFingerprint` inspection was
partial (`method-metadata-query-failed`); no source change is justified by that
partial result. Knowledge handoff: none; the installed manager-loop skill
already requires original-parent receipt harvesting and forbids fabricated
integration or duplicate dispatch.

## Restart Validation Review And Bounded Repairs — 2026-10-18

This user-authorized repair review preserves every task, dependency and active
ADW-2 lease. It supplies implementation evidence, not authenticated acceptance.
Four initial reviewers used two `gpt-6.1-sol` medium-effort agents and two
`gpt-6-luna` agents. Four disjoint development packets used `gpt-6.1-sol` at
medium effort. OntoIndex freshness matched HEAD `acbcb638`; uncommitted changes
were checked directly.

What worked: live clean/1/50/51-file, configuration, reuse and contention cases
returned expected evidence; one same-input parity comparison had no differences.
What failed: the full suite recorded 11,533 passes, five failures and 313 skips;
four tests assumed the inherited feature flag was unset, and the benchmark
acceptance mixed format compatibility with historical performance. A passing
rerun did not establish that the benchmark failure was noise. Cold live reads
took 67.66–75.59 seconds against the unchanged 55-second budget.
Forgotten acceptance includes 20 repetitions, terminal warm CPU, complete frozen
runtime/input identities, a full-suite rerun after repairs and authenticated
task closeout. The earlier failed parity reference is historical; it does not
describe the latest successful single comparison.

| Issue | Compared solutions and second challenge | Selected action and outcome |
| --- | --- | --- |
| Environment-dependent tests | Explicit off-test values; suite-wide default; launcher-only clearing. Launcher clearing hides test assumptions; suite defaults broaden scope. | Two explicit off-test stubs, preserving on tests and environment restoration. |
| Benchmark format acceptance | Same-measurement format baseline; exclusive performance job; wider tolerance. Wider tolerance masks regression. Existing Linux benchmark CI already runs the historical gate. | Temporary format fixture uses measured ratio; checked-in baseline, regression fixtures and CI performance gate remain unchanged. |
| Metadata query failure | Diagnostics only; label-specific projections; return node and filter existing metadata keys. Hardcoded projections drift with schema; hiding the warning is rejected. | Native reproduction proved absent-property binder failure. Node projection plus fixed allowlist preserves false/zero, omits absent fields and retains real query-failure evidence. Returning one node materializes content internally; response excludes it unless requested. |
| Cold rebuild cost | Stage measurement then existing-owner optimization; reduced graph profile; incremental graph reuse. Reduced profiles and reuse need dependency/coverage proofs. | Added bounded workspace-only build timings through existing phase telemetry; preserved full semantics and budgets. |

Validation: native build exit 0; initial focused suite exit 1 (211 pass, three
new assertions used the wrong response path); corrected assertions use
`symbol.methodMetadata`; final six-file suite exit 0, 214/214 pass with
`ONTOINDEX_AUTO_WORKSPACE=1`. Diff check exit 0. Bounded OntoIndex verification
PASS for the six changed source/test files and reviewed impacted callers.
Live isolated profile exit 0; MCP context found `buildDefIndex` without
`method-metadata-query-failed`. The ad hoc stdin launcher initially failed when
workers inherited `--input-type=module`; a corrected `.mjs` launcher completed.

Profile evidence: build wall 54.05 s; capture/inventory 1.16 s; pipeline 45.42 s;
storage 4.21 s; FTS 1.79 s. Pipeline cross-file analysis took 30.19 s and parsing
14.23 s. This direct build timing is not the earlier end-to-end MCP latency or
repeated p95 qualification, and does not close the cold-read budget failure.

Consolidated continuation: preserve the validated repairs, then attribute
cross-file time before editing its shared call processor. Compare amortized
bounded event-loop yields, grammar-identity query reuse, and parse-artifact reuse.
Prefer the first measured, semantics-preserving improvement; reject parallel
file resolution or batching that changes sequential binding propagation. Require
graph equivalence and focused resolver tests before a live cold pilot, then run
the existing 20-repetition matrix and full suite. Restore authenticated ADW-2
integration through the original parent before downstream plan acceptance or
default activation. No lease or role result was rewritten.

Evidence under `.ontoindex/adw-validation/`: `restart-acbcb638-full.json`,
`restart-acbcb638-runtime.json`, `review-repairs-final.json`,
`review-profile.json`, and their logs. The profile used the current built dirty
candidate with a committed corpus; it is diagnostic evidence, not a frozen
release comparison. Knowledge handoff: none; existing validation and manager
rules already cover failed pilots and original-parent receipt harvesting.

## Next Development Iteration Handoff

Authority: user request to preserve the next steps for the next development
iteration. This handoff records continuation scope; the existing structured
manager tracking remains dispatch authority and its active lease is unchanged.

1. Resume with the strict manager-loop decision. ADW-2 requires its original
   parent to harvest and integrate the terminal child receipt. Preserve the
   lease and distinguish independent diagnostic work from accepted task work.
2. Measure cross-file analysis overhead in
   `ontoindex/src/core/ingestion/pipeline-phases/cross-file-impl.ts` and its
   `processCalls` helper in `ontoindex/src/core/ingestion/call-processor.ts`.
   Compare bounded yield amortization, compiled-query reuse and parse-artifact
   reuse; choose only after attribution. Preserve sequential binding propagation,
   cancellation responsiveness, parser lifetime and graph completeness.
3. Implement the smallest measured improvement in the existing owner. Use
   OntoIndex navigation and impact before edits and at least two
   `gpt-6.1-sol` medium-effort development packets with disjoint scopes.
4. Verify graph equivalence and focused cross-file/resolver regressions, then
   run the cold MCP pilot under the unchanged 55-second budget. Preserve failed
   samples; a single passing profile does not establish p95 qualification.
5. After a valid pilot, complete the existing 20-repetition performance matrix
   with frozen runtime/input identities and terminal warm-CPU evidence, then
   rerun the full suite against the final candidate. Keep historical benchmark
   CI thresholds unchanged.
6. Integrate required authenticated results before release acceptance or default
   activation. Report any remaining receipt, performance or coverage gate.

Resume evidence: `.ontoindex/adw-validation/review-repairs-final.json`
(214 passed, exit 0), `review-profile.json` (profile and live context, exit 0),
plus `restart-acbcb638-runtime.json` (single-round parity passed; cold latency
budgets failed). Current repairs are uncommitted. The broader full suite has
not been rerun after these repairs.

