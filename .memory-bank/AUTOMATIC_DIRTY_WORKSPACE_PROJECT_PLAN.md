# Automatic Dirty Workspace Implementation Plan

Date: 2026-10-17
Status: In progress — capture implementation unaccepted; bounded correction prepared
Authority: User request for automatic, correct dirty-workspace answers without routine warnings.

## Goal

OntoIndex automatically prepares the evidence required for a read request and
answers from one consistent workspace snapshot. A successful supported request
requires no manual analyze, commit, stash or watcher startup and emits no routine
dirty-workspace warning. Preparation failures remain explicit errors.

Correctness means consistency with captured on-disk inputs and the supported
static-analysis capabilities. It does not imply complete knowledge of dynamic
runtime behavior or that files cannot change after capture.

## Current Evidence And Existing Owners

Baseline HEAD and indexed commit: `cb1d40c731a071b12ceaa874da2503622bb3f20d`,
confirmed by OntoIndex freshness on 2026-10-17. Existing uncommitted documentation
is preserved. Baseline observations are implementation evidence, not completion
evidence for this plan.

| Existing owner | Current behavior |
| --- | --- |
| `ontoindex/src/core/analyze-delta.ts` | Dirty path planning, tombstones and bounded source coverage |
| `ontoindex/src/core/run-analyze.ts` | Symbol overlay analysis and immutable generation publication |
| `ontoindex/src/cli/watch.ts` | Debounce, reconcile, child analysis and watcher lease |
| `ontoindex/src/mcp/local/backend-overlay.ts` | Overlay usability checks and read access |
| `ontoindex/src/mcp/local/local-backend.ts` | Query, context and impact request dispatch |
| `ontoindex/src/mcp/local/local-backend-repo-runtime.ts` | Repository runtime lifecycle integration point |
| `ontoindex/src/core/runtime/runtime-health.ts` | Dirty status and current commit/stash/clean repair advice |
| `ontoindex/src/mcp/shared/target-context.ts`, `response-envelope.ts` | Evidence identity, capabilities and response metadata |

Current symbol overlays do not expose current relationship evidence through
context/impact. Existing timestamp checks and two-second caching do not establish
content identity. These are gaps addressed below.

## Solution Review

| Option | Correctness and coverage | Robustness, compatibility and complexity | Performance, security and validation |
| --- | --- | --- | --- |
| Auto-start watcher only | Leaves debounce and missed-event gaps; cannot supply missing relationships | Small existing-owner change, insufficient root-cause coverage | Low foreground cost; validate lifecycle, but cannot prove current answers |
| Full graph before every request | Can provide consistent supported relationships with immutable capture | Straightforward model, expensive broad default; preserve public schema | Repeated CPU/RAM/I/O, bounded input capture and deadlines required |
| Hybrid background preparation plus request gate | Capability-specific readiness; complete workspace graph fallback | Selected; reuse locks, pipeline and publication; additive metadata | Reuse valid generations, coalesce work; validate races and isolation |
| Fully incremental relationship graph | Potential broad fresh coverage with correct dependency invalidation | High initial complexity and resolver/config invalidation risk | Strong potential steady-state speed; defer until hybrid correctness proven |

Second review: watcher events are hints, symbol overlays cannot prove caller
absence, and a full graph is still limited by parser/resolver support. Snapshot
capture must cover the actual bytes read, incoming edges must be refreshed, and
continuous edits must not create infinite retries. The hybrid addresses these
without a second indexing or process-management system.

## Decisions And Non-Goals

- Default read requests prepare current evidence automatically; no user Git
  mutation and no requirement to start a separate watcher.
- Reuse existing analysis, lock, lease, pool, snapshot and publication owners.
  ADW-1 establishes exact helper ownership and accepts the ADR; later workers receive bounded write
  sets and symbols with OntoIndex impact evidence before editing.
- Base committed graph and workspace generations have separate identities.
  Captured content is local, ignored by Git, owner-readable, bounded and pruned
  only after reader release. Never follow symlinks outside the repository.
- Workspace means current on-disk bytes. Unsaved editor buffers and an
  independently queryable staged-only tree are outside scope.
- Unsupported languages, external dependencies, dynamic behavior and parser
  limitations remain explicit capability limits. No false completeness or
  zero-impact claim is permitted.
- No automatic network embedding/provider calls, new service, container,
  cross-platform build, release publication or dependency addition is planned.
- Incremental relationship optimization is deferred. Complete workspace graph
  fallback is required before claiming current relationship answers.
- Preserve mutation approval/freshness/concurrency guards. This is read
  preparation, not authorization to mutate source.
- Existing real-time tracker remains authoritative for its own work; its RT-5
  status and saved buffer-pool issues are not changed by this plan.

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

## Review round 4 and ADW-2 HOLD evidence (2026-10-18)

ADW-2 auditor HOLD (receipt `role-result-cdf8ddb9...`): "transient ancestor-symlink containment is not established" for the interval between `checkCapturePath` and `fs.open` in `captureWorkspaceInputs`. Integration into the loop was rejected twice: first `capability_unavailable: tracking_write` (workspace was read-only), then `needs-rework: plan/task contract requires dispatch.role coder-manager`. The lease stays `running`; no state was hand-edited. A `coder-manager` must adjudicate.

Evidence for that adjudication: `test/unit/workspace-capture-toctou.test.ts` intercepts the first `fs.open` of the target and swaps the `src` ancestor for a symlink to an outside tree immediately before the real open. Capture throws `unsupported` and no capture directory contains outside bytes. The same probe was run with `O_NOFOLLOW` removed, and with both `O_NOFOLLOW` and the post-read `checkCapturePath` removed: each still throws `unsupported` (the remaining layers catch it). So the window is covered by at least two independent checks today; the test pins the outcome. Not proven: a swap of a deeper ancestor while bytes are being read, or races outside Node's async open path.

Also done this round (two gpt-6.1-sol low sub-agents, verified by me):
- Configuration traversal no longer descends into nested repositories (a child directory containing `.git` is skipped); `workspace-capture-nested-repo.test.ts` fails without the change (2 tests).
- The CLI `tool.ts` backend is disposed after every command (`disposeBackend()`, try/finally; the `impact` error path disposes before `process.exit(1)`); two tests in `tool-direct-cli.test.ts` fail without the change. Exit codes and stdout are unchanged.

Follow-up (same day): `repomap` now reads the pinned working-tree graph through `workspaceGraphPoolId` (opt-in flag, workspace-graph capability only; a symbols-only overlay is never read as the whole graph) and requests the build like `query` (degrades on refusal); a real-generation integration test fails without it. A challenger found that a working-tree graph left on disk changed flag-off behavior (reproduced: flag-off `repomap` returned nothing for a dirty-only symbol before my change and found it after). Fixed in both `workspaceGraphPoolId` and the search lane with an `ONTOINDEX_AUTO_WORKSPACE === '1'` guard; the new test fails when either guard is removed. `explore` is a handler alias of `context`, which is already routed, and was not changed; I did not test it end to end. Loop: `observe` shows the ADW-2 auditor completed; `abandon-stale-binding` refused (needs a result-rejected lease); `reconcile` changed nothing.

Still open after this round: idle-repo eviction; watcher `refreshCallback` and cache `snapshotIdentity` suppliers; hard-link (nlink>1) rejection, which the ADR does not clearly require; routes not on the workspace path (`repomap`, `explore`, resources, pagination, docs); a timed-out build holds the analyze lock until it ends; the ADW-2a..ADW-5c verification re-scope; ADW-7/8 acceptance evidence.

## Review round 5 (2026-10-18)

- A probe showed flag-off `context`, `explore` and `impact` still read a persisted working-tree graph (the same leak fixed earlier for `repomap` and search). Fixed once in `getOverlaySnapshot`: a workspace-graph generation is unusable unless `ONTOINDEX_AUTO_WORKSPACE=1`. The `impact` leg of the regression test fails without the fix. Visible side effect: `ontoindex status` prints "Overlay: stale (workspace graph ignored ...)" for such a repo when the flag is off.
- The snapshot cache is now keyed on the flag, so toggling it cannot serve a stale answer inside the 2 s TTL (test fails without the key).
- Group-service `impact`, `query` and `context` ports route through `dispatchRepoTool` when the flag is on (test fails without it, 3 cases). `impactByUid` was already routed.
- Measured peak RSS on a 1,717-file copy of this repo: full base analyze 2.47 GB (55 s), workspace-graph build 2.72 GB (48 s). One run each, 8 cores. Capture already caps inputs at 512 MiB and 512 KiB per file; nothing bounds the build's memory or time after capture, and the build runs in the server process. A tighter capture byte budget lowers the admitted workload but cannot guarantee RSS. Hard enforcement needs a child process with a deadline (larger change, not started).
- Resource handlers (`resources.ts`: context, clusters, processes, cluster and process detail) read the committed graph directly and show no notice; fixing needs `committedGraphNotice` applied to resource text, because `withCommittedGraphNotice` ignores strings. Not done.
- Build bound (after round 5 measurements): the working-tree build now runs in a supervised child process group (`workspace-build-supervisor.ts`, entry `core/workspace-build-child.ts`) with a hard deadline (`ONTOINDEX_WORKSPACE_BUILD_TIMEOUT_MS`, default 120 s). The parent keeps the analyze lock until the group is reaped, then removes only artifacts created during the build and never the generation that became current. Chosen over a cooperative AbortSignal (cannot interrupt native work, leaves 2.7 GB in the server) and worker_threads (heap limits exclude native memory). Default file gate lowered to 2000. Tests use real child processes; three sabotages (group kill, cleanup, current-generation guard) each fail a test. Verified end to end from sources with a 1.5 s kill (no leftover overlay or capture directories) and a full build whose snapshot was usable. Not verified: the compiled `dist` path, which needs `npm run build`; a crashed server still leaves orphaned `.CURRENT-*.tmp` files that no cleanup removes.

## Completed Design Gate

ADW-1 was completed with manager_loop complete-local on 2026-10-17 at revision
`402c12f612b62f96bf84a705666eb331272a1c21c12cb0ffaf5e8bf67db00436`.
Its exact accepted task record is preserved below as immutable history. The active
34-task map requires the accepted ADR as an external precondition; ADW-2's former
ADW-1 dependency is satisfied by this record. No role result or receipt is invented.

The runtime validates local completion only under a global local dispatch mode.
Compared twice: keeping this record inside the active map blocks sub-agent routing;
a second executor duplicates authority and task mirrors; runtime repair expands
scope. Preserve the completed gate outside the active map and retain all unfinished
stable IDs and authenticated worker/challenger gates. This is a structural migration
before implementation dispatch; it changes no accepted task evidence.

```yaml
  ADW-1:
    title: Approve the snapshot ADR and freeze implementation contracts before Luna dispatch
    status: DONE
    classification: architecture-paperwork
    assurance_profile: full
    complexity: complex
    depends_on: []
    type: design-gate
    validation_tier: unit-fast
    impact_risk: low
    owner_files:
    - .memory-bank/ADR_AUTOMATIC_DIRTY_WORKSPACE.md
    - .memory-bank/AUTOMATIC_DIRTY_WORKSPACE_PROJECT_PLAN.md
    allowed_write_set:
    - .memory-bank/ADR_AUTOMATIC_DIRTY_WORKSPACE.md
    - .memory-bank/AUTOMATIC_DIRTY_WORKSPACE_PROJECT_PLAN.md
    non_goals:
    - No adjacent refactors, new runtime owner, dependencies, provider calls, user Git mutations or release publication.
    required_validation:
    - git diff --check
    expected_evidence:
    - Given the reviewed source, when the manager accepts the ADR, then every packet has exact symbols, input/output contracts, fixtures and a confirmed command; route coverage, snapshot semantics and performance thresholds have no unresolved decisions.
    rollback:
    - Revert only this packet; preserve unrelated work, committed graph and live reader pins.
    stop_conditions:
    - 'An architecture decision cannot be settled from current evidence: record the exact missing evidence and prepare a bounded discovery packet; do not dispatch dependent implementation.'
    - 'Missing capability, stale success, unbounded cleanup or failed validation: retain evidence and return the exact blocker.'
    known_blockers: []
    closeout:
      role_results:
        coder-manager: null
      main_session_evidence:
        authorized_by: user
        authorization_ref: 'current-thread instruction: proceed tasks from .memory-bank/AUTOMATIC_DIRTY_WORKSPACE_PROJECT_PLAN.md'
        validation_summary: 'ADR and exact packet seams reviewed and accepted by persistent coder-manager; project_plan_validate PASS 35 tasks; git diff --check exit 0; installed Vitest, TypeScript and GNU time confirmed; product behavior not yet tested. knowledge_handoff: none; existing manager-loop local-completion rules apply.'
    dod_status: pass
```

## Manager Tracking

```yaml
manager_loop:
  authority: true
  status: in-progress
  selection_policy: active_next_task-first
  active_next_task: ADW-2
  max_in_flight: 1
  dispatch_mode: sub-agent
  dispatch_preflight:
    required_roles:
      coder-worker:
        agent_type_candidates:
        - coder-worker
        model_candidates:
        - gpt-6.1-sol
        reasoning_effort: high
      coder-worker-test-challenger:
        agent_type_candidates:
        - coder-worker-test-challenger
        model_candidates:
        - gpt-6.1-sol
        reasoning_effort: xhigh
      coder-manager:
        agent_type_candidates:
        - coder-manager
        model_candidates:
        - gpt-6.1-sol
        reasoning_effort: high
      coder-auditor:
        agent_type_candidates:
        - coder-auditor
        model_candidates:
        - gpt-6.1-sol
        reasoning_effort: high
      coder-performance:
        agent_type_candidates:
        - coder-performance
        model_candidates:
        - gpt-6.1-sol
        reasoning_effort: high
  reopen_gate: null
  last_decision: dispatched
tasks:
  ADW-2:
    title: Verify the existing bounded capture with content identity (verification-only)
    status: OPEN
    classification: proof-only
    assurance_profile: full
    complexity: complex
    depends_on: []
    type: proof
    validation_tier: unit-fast
    impact_risk: high
    owner_files:
    - .memory-bank/AUTOMATIC_DIRTY_WORKSPACE_PROJECT_PLAN.md
    allowed_write_set: []
    non_goals:
    - No source or test edits; the capture code in ontoindex/src/core/analyze-delta.ts, ontoindex/src/core/indexing/source-manifest.ts and ontoindex/test/unit/workspace-input-capture.test.ts already exists on branch feat/automatic-dirty-workspace and is reviewed here, not rewritten.
    - No adjacent refactors, new runtime owner, dependencies, provider calls, user Git mutations or release publication.
    required_validation:
    - cd ontoindex && ONTOINDEX_TEST_WORKERS=1 node node_modules/vitest/vitest.mjs run --maxWorkers=1 --no-file-parallelism test/unit/workspace-input-capture.test.ts
    - git diff --check
    expected_evidence:
    - Read the existing capture diff against the accepted ADW-1 contract (the 'Completed Design Gate' section of this file and .memory-bank/ADR_AUTOMATIC_DIRTY_WORKSPACE.md) and return PASS only if equal-size/equal-mtime edits, rename/delete, config changes and symlink escape change the manifest or are rejected, at most two attempts occur and owned failed captures are removed; otherwise NEEDS_REWORK with the exact defect. The author of the code is the main session; this reviewer did not write it.
    rollback:
    - Revert only this packet; preserve unrelated work, committed graph and live reader pins.
    stop_conditions:
    - 'The accepted ADW-1 contract is the immutable record under ## Completed Design Gate (manager_loop complete-local revision 402c12f612b62f96bf84a705666eb331272a1c21c12cb0ffaf5e8bf67db00436) plus the ADR; it is present, so do not stop for its absence. Stop only if it is genuinely unreadable.'
    - 'Missing capability, stale success, unbounded cleanup or failed validation: retain evidence and return the exact blocker.'
    known_blockers: []
    dispatch:
      role: coder-auditor
      attempts: 4
      max_attempts: 8
      dispatch_id: e0611a22-e180-4d27-8be1-0cb040cf1485
      scope_sha256: ab8600cd176f2d64cb4052a2e4235e23152ddc2530c122fe8e3b36ef8208ce61
      lease_state: running
      preflight_result: pass
      dispatched_at: '1792269170883'
      assigned_agent: 01a14b91-389a-7702-a1f4-1a9ca4f302b5
      agent_type_requested: cdr-auditor
      model_requested: gpt-6.1-sol
      model_effective: gpt-6.1-sol
      route_attempts: 1
      wait_state: child-terminal-result
      blocker_fingerprint: null
      terminal_classification: null
      last_progress_revision: b3f273405cfb07eb275ed3d67bca7f4218f4ed07ab75b8fe482850a1a87dc7fd
      result_receipt_id: null
      result_verdict: null
      result_blocker: null
    closeout:
      role_results: []
  ADW-2a:
    title: Run the pipeline entirely against captured inputs
    status: OPEN
    classification: implementation-ready
    assurance_profile: full
    complexity: complex
    depends_on:
    - ADW-2
    type: code
    validation_tier: unit-fast
    impact_risk: high
    owner_files:
    - ontoindex/src/core/ingestion/pipeline.ts
    - ontoindex/test/unit/ingestion-profiles.test.ts
    allowed_write_set:
    - ontoindex/src/core/ingestion/pipeline.ts
    - ontoindex/test/unit/ingestion-profiles.test.ts
    non_goals:
    - No adjacent refactors, new runtime owner, dependencies, provider calls, user Git mutations or release publication.
    required_validation:
    - cd ontoindex && ONTOINDEX_TEST_WORKERS=1 node node_modules/vitest/vitest.mjs run --maxWorkers=1 --no-file-parallelism test/unit/ingestion-profiles.test.ts
    - git diff --check
    expected_evidence:
    - Given a captured tree and later live-file edits, parser/resolver reads use captured bytes and canonical repository-relative paths; dependency/config lookup cannot escape to the live tree.
    rollback:
    - Revert only this packet; preserve unrelated work, committed graph and live reader pins.
    stop_conditions:
    - 'Missing accepted ADW-1 contract, required owner outside this write set, architecture choice or changed dependency: stop for manager preparation; do not widen scope.'
    - 'Missing capability, stale success, unbounded cleanup or failed validation: retain evidence and return the exact blocker.'
    known_blockers: []
  ADW-2b:
    title: Publish content-bound symbol generations without changing the committed index
    status: OPEN
    classification: implementation-ready
    assurance_profile: full
    complexity: complex
    depends_on:
    - ADW-2a
    type: code
    validation_tier: unit-fast
    impact_risk: high
    owner_files:
    - ontoindex/src/core/run-analyze.ts
    - ontoindex/test/unit/dirty-overlay-build.test.ts
    allowed_write_set:
    - ontoindex/src/core/run-analyze.ts
    - ontoindex/test/unit/dirty-overlay-build.test.ts
    non_goals:
    - No adjacent refactors, new runtime owner, dependencies, provider calls, user Git mutations or release publication.
    required_validation:
    - cd ontoindex && ONTOINDEX_TEST_WORKERS=1 node node_modules/vitest/vitest.mjs run --maxWorkers=1 --no-file-parallelism test/unit/dirty-overlay-build.test.ts
    - git diff --check
    expected_evidence:
    - Given successful or failed capture/build, runDirtyOverlayAnalysis publishes a manifest-bound generation atomically or preserves the prior generation; committed metadata and registry identity are unchanged.
    rollback:
    - Revert only this packet; preserve unrelated work, committed graph and live reader pins.
    stop_conditions:
    - 'Missing accepted ADW-1 contract, required owner outside this write set, architecture choice or changed dependency: stop for manager preparation; do not widen scope.'
    - 'Missing capability, stale success, unbounded cleanup or failed validation: retain evidence and return the exact blocker.'
    known_blockers: []
  ADW-2c:
    title: Require manifest identity when reusing a workspace generation
    status: OPEN
    classification: implementation-ready
    assurance_profile: full
    complexity: complex
    depends_on:
    - ADW-2b
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
    - No adjacent refactors, new runtime owner, dependencies, provider calls, user Git mutations or release publication.
    required_validation:
    - cd ontoindex && ONTOINDEX_TEST_WORKERS=1 node node_modules/vitest/vitest.mjs run --maxWorkers=1 --no-file-parallelism test/unit/backend-overlay.test.ts
    - git diff --check
    expected_evidence:
    - Given reused timestamps, changed config or changed base generation, computeSnapshot refuses obsolete evidence; a matching manifest can be reused without rebuilding.
    rollback:
    - Revert only this packet; preserve unrelated work, committed graph and live reader pins.
    stop_conditions:
    - 'Missing accepted ADW-1 contract, required owner outside this write set, architecture choice or changed dependency: stop for manager preparation; do not widen scope.'
    - 'Missing capability, stale success, unbounded cleanup or failed validation: retain evidence and return the exact blocker.'
    known_blockers: []
  ADW-3:
    title: Coalesce repository preparation with one pending successor
    status: OPEN
    classification: implementation-ready
    assurance_profile: full
    complexity: complex
    depends_on:
    - ADW-2c
    type: code
    validation_tier: unit-fast
    impact_risk: high
    owner_files:
    - ontoindex/src/mcp/local/local-backend-repo-runtime.ts
    - ontoindex/test/unit/local-backend-repo-runtime.test.ts
    allowed_write_set:
    - ontoindex/src/mcp/local/local-backend-repo-runtime.ts
    - ontoindex/test/unit/local-backend-repo-runtime.test.ts
    non_goals:
    - No adjacent refactors, new runtime owner, dependencies, provider calls, user Git mutations or release publication.
    required_validation:
    - cd ontoindex && ONTOINDEX_TEST_WORKERS=1 node node_modules/vitest/vitest.mjs run --maxWorkers=1 --no-file-parallelism test/unit/local-backend-repo-runtime.test.ts
    - git diff --check
    expected_evidence:
    - Given overlapping requests for the same repository/snapshot, ensureRepoInitialized-adjacent preparation shares one build and one latest pending successor; process contention uses the existing analyze lock.
    rollback:
    - Revert only this packet; preserve unrelated work, committed graph and live reader pins.
    stop_conditions:
    - 'Missing accepted ADW-1 contract, required owner outside this write set, architecture choice or changed dependency: stop for manager preparation; do not widen scope.'
    - 'Missing capability, stale success, unbounded cleanup or failed validation: retain evidence and return the exact blocker.'
    known_blockers: []
  ADW-3a:
    title: Provide automatic refresh callbacks, retry same-HEAD failures and await owned stop
    status: OPEN
    classification: implementation-ready
    assurance_profile: full
    complexity: complex
    depends_on:
    - ADW-3
    type: code
    validation_tier: unit-fast
    impact_risk: high
    owner_files:
    - ontoindex/src/cli/watch.ts
    - ontoindex/test/unit/watch-command.test.ts
    allowed_write_set:
    - ontoindex/src/cli/watch.ts
    - ontoindex/test/unit/watch-command.test.ts
    non_goals:
    - No adjacent refactors, new runtime owner, dependencies, provider calls, user Git mutations or release publication.
    required_validation:
    - cd ontoindex && ONTOINDEX_TEST_WORKERS=1 node node_modules/vitest/vitest.mjs run --maxWorkers=1 --no-file-parallelism test/unit/watch-command.test.ts
    - git diff --check
    expected_evidence:
    - Given automatic callback mode, createWatchCommand never launches ordinary analyze; token leases distinguish ownership, async stop observes child exit, failed same-HEAD refresh retries with bounded backoff and successful work is not repeated.
    rollback:
    - Revert only this packet; preserve unrelated work, committed graph and live reader pins.
    stop_conditions:
    - 'Missing accepted ADW-1 contract, required owner outside this write set, architecture choice or changed dependency: stop for manager preparation; do not widen scope.'
    - 'Missing capability, stale success, unbounded cleanup or failed validation: retain evidence and return the exact blocker.'
    known_blockers: []
  ADW-3b:
    title: Bound each waiter without cancelling preparation needed by another
    status: OPEN
    classification: implementation-ready
    assurance_profile: full
    complexity: complex
    depends_on:
    - ADW-3
    type: code
    validation_tier: unit-fast
    impact_risk: high
    owner_files:
    - ontoindex/src/mcp/local/local-backend-repo-runtime.ts
    - ontoindex/test/unit/local-backend-repo-runtime.test.ts
    allowed_write_set:
    - ontoindex/src/mcp/local/local-backend-repo-runtime.ts
    - ontoindex/test/unit/local-backend-repo-runtime.test.ts
    non_goals:
    - No adjacent refactors, new runtime owner, dependencies, provider calls, user Git mutations or release publication.
    required_validation:
    - cd ontoindex && ONTOINDEX_TEST_WORKERS=1 node node_modules/vitest/vitest.mjs run --maxWorkers=1 --no-file-parallelism test/unit/local-backend-repo-runtime.test.ts
    - git diff --check
    expected_evidence:
    - Given two waiters and cancellation/timeout of one, the other completes; the request uses one monotonic 60-second deadline including queue/capture/build, with bounded cleanup and no infinite continuous-save retry.
    rollback:
    - Revert only this packet; preserve unrelated work, committed graph and live reader pins.
    stop_conditions:
    - 'Missing accepted ADW-1 contract, required owner outside this write set, architecture choice or changed dependency: stop for manager preparation; do not widen scope.'
    - 'Missing capability, stale success, unbounded cleanup or failed validation: retain evidence and return the exact blocker.'
    known_blockers: []
  ADW-4:
    title: Build isolated complete workspace graphs from the same captured tree
    status: OPEN
    classification: implementation-ready
    assurance_profile: full
    complexity: complex
    depends_on:
    - ADW-2b
    - ADW-3b
    type: code
    validation_tier: integration
    impact_risk: high
    owner_files:
    - ontoindex/src/core/run-analyze.ts
    - ontoindex/test/integration/workspace-graph-snapshot.test.ts
    allowed_write_set:
    - ontoindex/src/core/run-analyze.ts
    - ontoindex/test/integration/workspace-graph-snapshot.test.ts
    non_goals:
    - No adjacent refactors, new runtime owner, dependencies, provider calls, user Git mutations or release publication.
    required_validation:
    - cd ontoindex && ONTOINDEX_TEST_WORKERS=1 node node_modules/vitest/vitest.mjs run --maxWorkers=1 --no-file-parallelism test/integration/workspace-graph-snapshot.test.ts
    - git diff --check
    expected_evidence:
    - Given a clean caller and changed/deleted callee, the isolated full graph matches an independent full analysis of the same captured bytes; base index, registry, Git and embeddings are unchanged.
    rollback:
    - Revert only this packet; preserve unrelated work, committed graph and live reader pins.
    stop_conditions:
    - 'Missing accepted ADW-1 contract, required owner outside this write set, architecture choice or changed dependency: stop for manager preparation; do not widen scope.'
    - 'Missing capability, stale success, unbounded cleanup or failed validation: retain evidence and return the exact blocker.'
    known_blockers: []
  ADW-4a:
    title: Escalate insufficient overlays instead of returning partial relationship success
    status: OPEN
    classification: implementation-ready
    assurance_profile: full
    complexity: complex
    depends_on:
    - ADW-4
    - ADW-2c
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
    - No adjacent refactors, new runtime owner, dependencies, provider calls, user Git mutations or release publication.
    required_validation:
    - cd ontoindex && ONTOINDEX_TEST_WORKERS=1 node node_modules/vitest/vitest.mjs run --maxWorkers=1 --no-file-parallelism test/unit/backend-overlay.test.ts
    - git diff --check
    expected_evidence:
    - Given 0/1/50/51 eligible changes or resolver/config changes, capability selection reuses sufficient evidence or requests complete analysis; no changed path is silently omitted and parse failures remain explicit.
    rollback:
    - Revert only this packet; preserve unrelated work, committed graph and live reader pins.
    stop_conditions:
    - 'Missing accepted ADW-1 contract, required owner outside this write set, architecture choice or changed dependency: stop for manager preparation; do not widen scope.'
    - 'Missing capability, stale success, unbounded cleanup or failed validation: retain evidence and return the exact blocker.'
    known_blockers: []
  ADW-5:
    title: Pin an exact database generation for the complete request
    status: OPEN
    classification: implementation-ready
    assurance_profile: full
    complexity: complex
    depends_on:
    - ADW-4a
    type: code
    validation_tier: integration
    impact_risk: high
    owner_files:
    - ontoindex/src/core/lbug/pool-adapter.ts
    - ontoindex/src/mcp/local/backend-overlay.ts
    - ontoindex/test/integration/lbug-pool-generation-swap.test.ts
    allowed_write_set:
    - ontoindex/src/core/lbug/pool-adapter.ts
    - ontoindex/src/mcp/local/backend-overlay.ts
    - ontoindex/test/integration/lbug-pool-generation-swap.test.ts
    non_goals:
    - No adjacent refactors, new runtime owner, dependencies, provider calls, user Git mutations or release publication.
    required_validation:
    - cd ontoindex && ONTOINDEX_TEST_WORKERS=1 node node_modules/vitest/vitest.mjs run --maxWorkers=1 --no-file-parallelism test/integration/lbug-pool-generation-swap.test.ts
    - git diff --check
    expected_evidence:
    - Given publication between two reads, both execute against the pinned generation; timeout/error releases it and pruning preserves live reader pins.
    rollback:
    - Revert only this packet; preserve unrelated work, committed graph and live reader pins.
    stop_conditions:
    - 'Missing accepted ADW-1 contract, required owner outside this write set, architecture choice or changed dependency: stop for manager preparation; do not widen scope.'
    - 'Missing capability, stale success, unbounded cleanup or failed validation: retain evidence and return the exact blocker.'
    known_blockers: []
  ADW-5a:
    title: Gate backend reads once and pass one request context through completion
    status: OPEN
    classification: implementation-ready
    assurance_profile: full
    complexity: complex
    depends_on:
    - ADW-5
    - ADW-3b
    type: code
    validation_tier: unit-fast
    impact_risk: high
    owner_files:
    - ontoindex/src/mcp/local/local-backend.ts
    - ontoindex/test/unit/calltool-dispatch.test.ts
    allowed_write_set:
    - ontoindex/src/mcp/local/local-backend.ts
    - ontoindex/test/unit/calltool-dispatch.test.ts
    non_goals:
    - No adjacent refactors, new runtime owner, dependencies, provider calls, user Git mutations or release publication.
    required_validation:
    - cd ontoindex && ONTOINDEX_TEST_WORKERS=1 node node_modules/vitest/vitest.mjs run --maxWorkers=1 --no-file-parallelism test/unit/calltool-dispatch.test.ts
    - git diff --check
    expected_evidence:
    - Given direct or facade reads, LocalBackend.callTool applies the capability/deadline contract once and propagates the pinned context; genuine preparation failure returns the existing typed invocation error and never stale success.
    rollback:
    - Revert only this packet; preserve unrelated work, committed graph and live reader pins.
    stop_conditions:
    - 'Missing accepted ADW-1 contract, required owner outside this write set, architecture choice or changed dependency: stop for manager preparation; do not widen scope.'
    - 'Missing capability, stale success, unbounded cleanup or failed validation: retain evidence and return the exact blocker.'
    known_blockers: []
  ADW-5b:
    title: Resolve symbol identities from the pinned snapshot
    status: OPEN
    classification: implementation-ready
    assurance_profile: full
    complexity: complex
    depends_on:
    - ADW-5a
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
    - No adjacent refactors, new runtime owner, dependencies, provider calls, user Git mutations or release publication.
    required_validation:
    - cd ontoindex && ONTOINDEX_TEST_WORKERS=1 node node_modules/vitest/vitest.mjs run --maxWorkers=1 --no-file-parallelism test/unit/overlay-symbol-resolution.test.ts
    - git diff --check
    expected_evidence:
    - Given added/deleted/renamed symbols during publication, resolution returns only identities valid in the pinned snapshot and never re-resolves CURRENT.
    rollback:
    - Revert only this packet; preserve unrelated work, committed graph and live reader pins.
    stop_conditions:
    - 'Missing accepted ADW-1 contract, required owner outside this write set, architecture choice or changed dependency: stop for manager preparation; do not widen scope.'
    - 'Missing capability, stale success, unbounded cleanup or failed validation: retain evidence and return the exact blocker.'
    known_blockers: []
  ADW-5c:
    title: Key semantic cache entries by snapshot and capability
    status: OPEN
    classification: implementation-ready
    assurance_profile: full
    complexity: complex
    depends_on:
    - ADW-5a
    type: code
    validation_tier: unit-fast
    impact_risk: high
    owner_files:
    - ontoindex/src/core/search/semantic-cache.ts
    - ontoindex/test/unit/core/semantic-cache.test.ts
    allowed_write_set:
    - ontoindex/src/core/search/semantic-cache.ts
    - ontoindex/test/unit/core/semantic-cache.test.ts
    non_goals:
    - No adjacent refactors, new runtime owner, dependencies, provider calls, user Git mutations or release publication.
    required_validation:
    - cd ontoindex && ONTOINDEX_TEST_WORKERS=1 node node_modules/vitest/vitest.mjs run --maxWorkers=1 --no-file-parallelism test/unit/core/semantic-cache.test.ts
    - git diff --check
    expected_evidence:
    - Given equal HEAD but different captured bytes, cached results cannot cross snapshots; matching identity can reuse results within existing size/TTL bounds.
    rollback:
    - Revert only this packet; preserve unrelated work, committed graph and live reader pins.
    stop_conditions:
    - 'Missing accepted ADW-1 contract, required owner outside this write set, architecture choice or changed dependency: stop for manager preparation; do not widen scope.'
    - 'Missing capability, stale success, unbounded cleanup or failed validation: retain evidence and return the exact blocker.'
    known_blockers: []
  ADW-5d:
    title: Search merges fresh lexical candidates and rejects stale fallback
    status: OPEN
    classification: implementation-ready
    assurance_profile: full
    complexity: complex
    depends_on:
    - ADW-5b
    - ADW-5c
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
    - No adjacent refactors, new runtime owner, dependencies, provider calls, user Git mutations or release publication.
    required_validation:
    - cd ontoindex && ONTOINDEX_TEST_WORKERS=1 node node_modules/vitest/vitest.mjs run --maxWorkers=1 --no-file-parallelism test/unit/overlay-query-merge.test.ts
    - git diff --check
    expected_evidence:
    - Given dirty new or removed symbols and unusable preparation, search uses valid snapshot candidates or errors; stale cache/base fallback fixtures change only for automatic-current requests and no provider call occurs.
    rollback:
    - Revert only this packet; preserve unrelated work, committed graph and live reader pins.
    stop_conditions:
    - 'Missing accepted ADW-1 contract, required owner outside this write set, architecture choice or changed dependency: stop for manager preparation; do not widen scope.'
    - 'Missing capability, stale success, unbounded cleanup or failed validation: retain evidence and return the exact blocker.'
    known_blockers: []
  ADW-5e:
    title: Context and impact use pinned relationships and captured source
    status: OPEN
    classification: implementation-ready
    assurance_profile: full
    complexity: complex
    depends_on:
    - ADW-5d
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
    - No adjacent refactors, new runtime owner, dependencies, provider calls, user Git mutations or release publication.
    required_validation:
    - cd ontoindex && ONTOINDEX_TEST_WORKERS=1 node node_modules/vitest/vitest.mjs run --maxWorkers=1 --no-file-parallelism test/unit/overlay-context-impact.test.ts
    - git diff --check
    expected_evidence:
    - Given edits after request pinning, context and impact use matching definitions, edges and source bytes; incomplete parsing cannot yield authoritative zero impact.
    rollback:
    - Revert only this packet; preserve unrelated work, committed graph and live reader pins.
    stop_conditions:
    - 'Missing accepted ADW-1 contract, required owner outside this write set, architecture choice or changed dependency: stop for manager preparation; do not widen scope.'
    - 'Missing capability, stale success, unbounded cleanup or failed validation: retain evidence and return the exact blocker.'
    known_blockers: []
  ADW-5f:
    title: Gate lazy MCP tools through the same preparation owner
    status: OPEN
    classification: implementation-ready
    assurance_profile: full
    complexity: complex
    depends_on:
    - ADW-5e
    type: code
    validation_tier: unit-fast
    impact_risk: high
    owner_files:
    - ontoindex/src/mcp/server.ts
    - ontoindex/test/unit/mcp-server-graph-walk-init.test.ts
    allowed_write_set:
    - ontoindex/src/mcp/server.ts
    - ontoindex/test/unit/mcp-server-graph-walk-init.test.ts
    non_goals:
    - No adjacent refactors, new runtime owner, dependencies, provider calls, user Git mutations or release publication.
    required_validation:
    - cd ontoindex && ONTOINDEX_TEST_WORKERS=1 node node_modules/vitest/vitest.mjs run --maxWorkers=1 --no-file-parallelism test/unit/mcp-server-graph-walk-init.test.ts
    - git diff --check
    expected_evidence:
    - Given lazy super-tool dispatch, preparation and pin release match backend reads; diagnostic/repair tools remain usable during preparation failure and stored response continuation does not trigger a new build.
    rollback:
    - Revert only this packet; preserve unrelated work, committed graph and live reader pins.
    stop_conditions:
    - 'Missing accepted ADW-1 contract, required owner outside this write set, architecture choice or changed dependency: stop for manager preparation; do not widen scope.'
    - 'Missing capability, stale success, unbounded cleanup or failed validation: retain evidence and return the exact blocker.'
    known_blockers: []
  ADW-5g:
    title: Apply snapshot readiness to graph resources
    status: OPEN
    classification: implementation-ready
    assurance_profile: full
    complexity: complex
    depends_on:
    - ADW-5f
    type: code
    validation_tier: unit-fast
    impact_risk: high
    owner_files:
    - ontoindex/src/mcp/resources.ts
    - ontoindex/test/unit/resources.test.ts
    allowed_write_set:
    - ontoindex/src/mcp/resources.ts
    - ontoindex/test/unit/resources.test.ts
    non_goals:
    - No adjacent refactors, new runtime owner, dependencies, provider calls, user Git mutations or release publication.
    required_validation:
    - cd ontoindex && ONTOINDEX_TEST_WORKERS=1 node node_modules/vitest/vitest.mjs run --maxWorkers=1 --no-file-parallelism test/unit/resources.test.ts
    - git diff --check
    expected_evidence:
    - Given cluster/process/detail resource reads, data and identity use the same pinned graph; explicit diagnostic resources preserve their diagnostic semantics.
    rollback:
    - Revert only this packet; preserve unrelated work, committed graph and live reader pins.
    stop_conditions:
    - 'Missing accepted ADW-1 contract, required owner outside this write set, architecture choice or changed dependency: stop for manager preparation; do not widen scope.'
    - 'Missing capability, stale success, unbounded cleanup or failed validation: retain evidence and return the exact blocker.'
    known_blockers: []
  ADW-5h:
    title: Preserve immutable response replay and bind logical page cursors
    status: OPEN
    classification: implementation-ready
    assurance_profile: full
    complexity: complex
    depends_on:
    - ADW-5g
    type: code
    validation_tier: unit-fast
    impact_risk: high
    owner_files:
    - ontoindex/src/mcp/shared/response-pages.ts
    - ontoindex/src/mcp/shared/response-limits.ts
    - ontoindex/test/unit/response-pages.test.ts
    allowed_write_set:
    - ontoindex/src/mcp/shared/response-pages.ts
    - ontoindex/src/mcp/shared/response-limits.ts
    - ontoindex/test/unit/response-pages.test.ts
    non_goals:
    - No adjacent refactors, new runtime owner, dependencies, provider calls, user Git mutations or release publication.
    required_validation:
    - cd ontoindex && ONTOINDEX_TEST_WORKERS=1 node node_modules/vitest/vitest.mjs run --maxWorkers=1 --no-file-parallelism test/unit/response-pages.test.ts
    - git diff --check
    expected_evidence:
    - Given publication between pages, stored response_cursor replays its original bytes; logical cursors bind the original generation or fail explicitly, with a tested legacy-token rule.
    rollback:
    - Revert only this packet; preserve unrelated work, committed graph and live reader pins.
    stop_conditions:
    - 'Missing accepted ADW-1 contract, required owner outside this write set, architecture choice or changed dependency: stop for manager preparation; do not widen scope.'
    - 'Missing capability, stale success, unbounded cleanup or failed validation: retain evidence and return the exact blocker.'
    known_blockers: []
  ADW-5i:
    title: Keep docs pagination on one captured collection
    status: OPEN
    classification: implementation-ready
    assurance_profile: full
    complexity: complex
    depends_on:
    - ADW-5h
    type: code
    validation_tier: unit-fast
    impact_risk: high
    owner_files:
    - ontoindex/src/mcp/super/docs.ts
    - ontoindex/test/unit/super/docs-evidence.test.ts
    allowed_write_set:
    - ontoindex/src/mcp/super/docs.ts
    - ontoindex/test/unit/super/docs-evidence.test.ts
    non_goals:
    - No adjacent refactors, new runtime owner, dependencies, provider calls, user Git mutations or release publication.
    required_validation:
    - cd ontoindex && ONTOINDEX_TEST_WORKERS=1 node node_modules/vitest/vitest.mjs run --maxWorkers=1 --no-file-parallelism test/unit/super/docs-evidence.test.ts
    - git diff --check
    expected_evidence:
    - Given docs continuation after publication or token expiry, the consumer preserves the declared generation or returns a typed restart-required outcome; legacy fields retain their types.
    rollback:
    - Revert only this packet; preserve unrelated work, committed graph and live reader pins.
    stop_conditions:
    - 'Missing accepted ADW-1 contract, required owner outside this write set, architecture choice or changed dependency: stop for manager preparation; do not widen scope.'
    - 'Missing capability, stale success, unbounded cleanup or failed validation: retain evidence and return the exact blocker.'
    known_blockers: []
  ADW-6:
    title: Acquire and release one owned watcher per repository lifecycle
    status: OPEN
    classification: implementation-ready
    assurance_profile: full
    complexity: complex
    depends_on:
    - ADW-5i
    - ADW-3a
    type: code
    validation_tier: unit-fast
    impact_risk: high
    owner_files:
    - ontoindex/src/mcp/local/local-backend-repo-runtime.ts
    - ontoindex/src/mcp/local/local-backend.ts
    - ontoindex/test/unit/local-backend-repo-runtime.test.ts
    allowed_write_set:
    - ontoindex/src/mcp/local/local-backend-repo-runtime.ts
    - ontoindex/src/mcp/local/local-backend.ts
    - ontoindex/test/unit/local-backend-repo-runtime.test.ts
    non_goals:
    - No adjacent refactors, new runtime owner, dependencies, provider calls, user Git mutations or release publication.
    required_validation:
    - cd ontoindex && ONTOINDEX_TEST_WORKERS=1 node node_modules/vitest/vitest.mjs run --maxWorkers=1 --no-file-parallelism test/unit/local-backend-repo-runtime.test.ts
    - git diff --check
    expected_evidence:
    - Given multiple clients, repeated init and repository eviction, one watcher lease is reused; the last owner drains its watcher/children and per-repo caches, without stopping an external watcher.
    rollback:
    - Revert only this packet; preserve unrelated work, committed graph and live reader pins.
    stop_conditions:
    - 'Missing accepted ADW-1 contract, required owner outside this write set, architecture choice or changed dependency: stop for manager preparation; do not widen scope.'
    - 'Missing capability, stale success, unbounded cleanup or failed validation: retain evidence and return the exact blocker.'
    known_blockers: []
  ADW-6a:
    title: Drain automatic preparation and watchers during MCP shutdown
    status: OPEN
    classification: implementation-ready
    assurance_profile: full
    complexity: complex
    depends_on:
    - ADW-6
    - ADW-5f
    type: code
    validation_tier: unit-fast
    impact_risk: high
    owner_files:
    - ontoindex/src/mcp/server.ts
    - ontoindex/test/unit/mcp-server-shutdown.test.ts
    allowed_write_set:
    - ontoindex/src/mcp/server.ts
    - ontoindex/test/unit/mcp-server-shutdown.test.ts
    non_goals:
    - No adjacent refactors, new runtime owner, dependencies, provider calls, user Git mutations or release publication.
    required_validation:
    - cd ontoindex && ONTOINDEX_TEST_WORKERS=1 node node_modules/vitest/vitest.mjs run --maxWorkers=1 --no-file-parallelism test/unit/mcp-server-shutdown.test.ts
    - git diff --check
    expected_evidence:
    - Given SIGTERM/startup failure during preparation, the server drains owned work within the cleanup budget, releases readers and leaves no owned child or lease.
    rollback:
    - Revert only this packet; preserve unrelated work, committed graph and live reader pins.
    stop_conditions:
    - 'Missing accepted ADW-1 contract, required owner outside this write set, architecture choice or changed dependency: stop for manager preparation; do not widen scope.'
    - 'Missing capability, stale success, unbounded cleanup or failed validation: retain evidence and return the exact blocker.'
    known_blockers: []
  ADW-6b:
    title: Expose readiness metadata without breaking legacy response fields
    status: OPEN
    classification: implementation-ready
    assurance_profile: full
    complexity: complex
    depends_on:
    - ADW-6a
    type: code
    validation_tier: unit-fast
    impact_risk: high
    owner_files:
    - ontoindex/src/mcp/shared/target-context.ts
    - ontoindex/src/mcp/shared/response-envelope.ts
    - ontoindex/test/unit/response-envelope.test.ts
    allowed_write_set:
    - ontoindex/src/mcp/shared/target-context.ts
    - ontoindex/src/mcp/shared/response-envelope.ts
    - ontoindex/test/unit/response-envelope.test.ts
    non_goals:
    - No adjacent refactors, new runtime owner, dependencies, provider calls, user Git mutations or release publication.
    required_validation:
    - cd ontoindex && ONTOINDEX_TEST_WORKERS=1 node node_modules/vitest/vitest.mjs run --maxWorkers=1 --no-file-parallelism test/unit/response-envelope.test.ts
    - git diff --check
    expected_evidence:
    - Given prepared dirty success or genuine preparation failure, responses expose additive snapshot/capability/completeness state, preserve legacy field types and typed errors, and remove routine dirty advice only for prepared success.
    rollback:
    - Revert only this packet; preserve unrelated work, committed graph and live reader pins.
    stop_conditions:
    - 'Missing accepted ADW-1 contract, required owner outside this write set, architecture choice or changed dependency: stop for manager preparation; do not widen scope.'
    - 'Missing capability, stale success, unbounded cleanup or failed validation: retain evidence and return the exact blocker.'
    known_blockers: []
  ADW-6c:
    title: Keep diagnostics actionable while suppressing prepared-read dirty advice
    status: OPEN
    classification: implementation-ready
    assurance_profile: full
    complexity: complex
    depends_on:
    - ADW-6b
    type: code
    validation_tier: unit-fast
    impact_risk: high
    owner_files:
    - ontoindex/src/core/runtime/runtime-health.ts
    - ontoindex/test/unit/runtime-health.test.ts
    allowed_write_set:
    - ontoindex/src/core/runtime/runtime-health.ts
    - ontoindex/test/unit/runtime-health.test.ts
    non_goals:
    - No adjacent refactors, new runtime owner, dependencies, provider calls, user Git mutations or release publication.
    required_validation:
    - cd ontoindex && ONTOINDEX_TEST_WORKERS=1 node node_modules/vitest/vitest.mjs run --maxWorkers=1 --no-file-parallelism test/unit/runtime-health.test.ts
    - git diff --check
    expected_evidence:
    - Given ready dirty reads, generic clean/stash/commit advice is absent; unavailable/failed preparation and diagnostic calls retain truthful failure state rather than globally hiding dirtiness.
    rollback:
    - Revert only this packet; preserve unrelated work, committed graph and live reader pins.
    stop_conditions:
    - 'Missing accepted ADW-1 contract, required owner outside this write set, architecture choice or changed dependency: stop for manager preparation; do not widen scope.'
    - 'Missing capability, stale success, unbounded cleanup or failed validation: retain evidence and return the exact blocker.'
    known_blockers: []
  ADW-7:
    title: Author a persistent MCP and CLI replay harness
    status: OPEN
    classification: implementation-ready
    assurance_profile: full
    complexity: complex
    depends_on:
    - ADW-6c
    type: test
    validation_tier: integration
    impact_risk: high
    owner_files:
    - ontoindex/test/integration/overlay-cross-process.test.ts
    - ontoindex/test/integration/automatic-dirty-workspace.test.ts
    allowed_write_set:
    - ontoindex/test/integration/overlay-cross-process.test.ts
    - ontoindex/test/integration/automatic-dirty-workspace.test.ts
    non_goals:
    - No adjacent refactors, new runtime owner, dependencies, provider calls, user Git mutations or release publication.
    required_validation:
    - cd ontoindex && ONTOINDEX_TEST_WORKERS=1 node node_modules/vitest/vitest.mjs run --maxWorkers=1 --no-file-parallelism test/integration/overlay-cross-process.test.ts test/integration/automatic-dirty-workspace.test.ts
    - git diff --check
    expected_evidence:
    - Given append/create/rename/delete/atomic-save sequences, the harness issues real persistent MCP and foreground CLI requests, records identities and raw responses/stderr, and fails on lost evidence or unreaped children.
    rollback:
    - Revert only this packet; preserve unrelated work, committed graph and live reader pins.
    stop_conditions:
    - 'Missing accepted ADW-1 contract, required owner outside this write set, architecture choice or changed dependency: stop for manager preparation; do not widen scope.'
    - 'Missing capability, stale success, unbounded cleanup or failed validation: retain evidence and return the exact blocker.'
    known_blockers: []
  ADW-7a:
    title: Author deterministic capture, publication and query race regressions
    status: OPEN
    classification: implementation-ready
    assurance_profile: full
    complexity: complex
    depends_on:
    - ADW-7
    type: test
    validation_tier: integration
    impact_risk: high
    owner_files:
    - ontoindex/test/integration/automatic-dirty-workspace.test.ts
    - ontoindex/test/unit/watch-save-patterns.test.ts
    allowed_write_set:
    - ontoindex/test/integration/automatic-dirty-workspace.test.ts
    - ontoindex/test/unit/watch-save-patterns.test.ts
    non_goals:
    - No adjacent refactors, new runtime owner, dependencies, provider calls, user Git mutations or release publication.
    required_validation:
    - cd ontoindex && ONTOINDEX_TEST_WORKERS=1 node node_modules/vitest/vitest.mjs run --maxWorkers=1 --no-file-parallelism test/integration/automatic-dirty-workspace.test.ts test/unit/watch-save-patterns.test.ts
    - git diff --check
    expected_evidence:
    - Given missed events, preserved timestamps, HEAD/config changes, 0/1/50/51 changes, continuous saves and two writers, barrier-driven tests prove bounded work and one snapshot per response; no timing-only sleep assertions.
    rollback:
    - Revert only this packet; preserve unrelated work, committed graph and live reader pins.
    stop_conditions:
    - 'Missing accepted ADW-1 contract, required owner outside this write set, architecture choice or changed dependency: stop for manager preparation; do not widen scope.'
    - 'Missing capability, stale success, unbounded cleanup or failed validation: retain evidence and return the exact blocker.'
    known_blockers: []
  ADW-7b:
    title: Author compatibility and no-side-effect acceptance checks
    status: OPEN
    classification: implementation-ready
    assurance_profile: full
    complexity: complex
    depends_on:
    - ADW-7a
    type: test
    validation_tier: integration
    impact_risk: high
    owner_files:
    - ontoindex/test/integration/automatic-dirty-workspace.test.ts
    - ontoindex/test/unit/response-envelope.test.ts
    allowed_write_set:
    - ontoindex/test/integration/automatic-dirty-workspace.test.ts
    - ontoindex/test/unit/response-envelope.test.ts
    non_goals:
    - No adjacent refactors, new runtime owner, dependencies, provider calls, user Git mutations or release publication.
    required_validation:
    - cd ontoindex && ONTOINDEX_TEST_WORKERS=1 node node_modules/vitest/vitest.mjs run --maxWorkers=1 --no-file-parallelism test/integration/automatic-dirty-workspace.test.ts test/unit/response-envelope.test.ts
    - git diff --check
    expected_evidence:
    - Given automatic reads and denied mutations, tests assert legacy fields, resources/cursors, no provider invocation, unchanged source/Git/registry/base identity and zero owned children after completion; recorded buffer-pool errors fail acceptance.
    rollback:
    - Revert only this packet; preserve unrelated work, committed graph and live reader pins.
    stop_conditions:
    - 'Missing accepted ADW-1 contract, required owner outside this write set, architecture choice or changed dependency: stop for manager preparation; do not widen scope.'
    - 'Missing capability, stale success, unbounded cleanup or failed validation: retain evidence and return the exact blocker.'
    known_blockers: []
  ADW-7c:
    title: Extend the existing benchmark to measure automatic request preparation
    status: OPEN
    classification: implementation-ready
    assurance_profile: full
    complexity: complex
    depends_on:
    - ADW-7b
    type: test
    validation_tier: unit-fast
    impact_risk: high
    owner_files:
    - ontoindex/scripts/overlay-benchmark.mjs
    - ontoindex/test/unit/overlay-benchmark.test.ts
    allowed_write_set:
    - ontoindex/scripts/overlay-benchmark.mjs
    - ontoindex/test/unit/overlay-benchmark.test.ts
    non_goals:
    - No adjacent refactors, new runtime owner, dependencies, provider calls, user Git mutations or release publication.
    required_validation:
    - cd ontoindex && ONTOINDEX_TEST_WORKERS=1 node node_modules/vitest/vitest.mjs run --maxWorkers=1 --no-file-parallelism test/unit/overlay-benchmark.test.ts
    - git diff --check
    expected_evidence:
    - Given the frozen protocol, the benchmark measures request latency/CPU/peak RSS/bytes/build count on 0/1/50/51/config workloads, retains raw samples and stderr, and self-tests missing/failed measurement rejection.
    rollback:
    - Revert only this packet; preserve unrelated work, committed graph and live reader pins.
    stop_conditions:
    - 'Missing accepted ADW-1 contract, required owner outside this write set, architecture choice or changed dependency: stop for manager preparation; do not widen scope.'
    - 'Missing capability, stale success, unbounded cleanup or failed validation: retain evidence and return the exact blocker.'
    known_blockers: []
  ADW-7d:
    title: Prove the instrument records one real run before the performance matrix
    status: OPEN
    classification: proof-only
    assurance_profile: full
    complexity: complex
    depends_on:
    - ADW-7c
    type: proof
    validation_tier: integration
    impact_risk: high
    owner_files:
    - .memory-bank/AUTOMATIC_DIRTY_WORKSPACE_PROJECT_PLAN.md
    allowed_write_set:
    - .memory-bank/AUTOMATIC_DIRTY_WORKSPACE_PROJECT_PLAN.md
    non_goals:
    - No adjacent refactors, new runtime owner, dependencies, provider calls, user Git mutations or release publication.
    required_validation:
    - cd ontoindex && ONTOINDEX_TEST_WORKERS=1 node node_modules/vitest/vitest.mjs run --maxWorkers=1 --no-file-parallelism test/unit/overlay-benchmark.test.ts
    - cd ontoindex && node scripts/overlay-benchmark.mjs --automatic --pilot --output ../.ontoindex/adw-validation/pilot.json
    - git diff --check
    expected_evidence:
    - Given one disposable fixed input, the pilot emits every required metric, runtime/input hash, raw request/response/stderr and cleanup result at the ADR-declared artifact path; deliberately missing data is rejected.
    rollback:
    - Revert only this packet; preserve unrelated work, committed graph and live reader pins.
    stop_conditions:
    - 'Missing accepted ADW-1 contract, required owner outside this write set, architecture choice or changed dependency: stop for manager preparation; do not widen scope.'
    - 'Missing capability, stale success, unbounded cleanup or failed validation: retain evidence and return the exact blocker.'
    known_blockers: []
  ADW-7e:
    title: Independently prove snapshot correctness and compatibility before enablement
    status: OPEN
    classification: proof-only
    assurance_profile: full
    complexity: complex
    depends_on:
    - ADW-7b
    - ADW-7d
    type: proof
    validation_tier: integration
    impact_risk: high
    owner_files:
    - .memory-bank/AUTOMATIC_DIRTY_WORKSPACE_PROJECT_PLAN.md
    allowed_write_set:
    - .memory-bank/AUTOMATIC_DIRTY_WORKSPACE_PROJECT_PLAN.md
    non_goals:
    - No adjacent refactors, new runtime owner, dependencies, provider calls, user Git mutations or release publication.
    required_validation:
    - cd ontoindex && ONTOINDEX_TEST_WORKERS=1 node node_modules/vitest/vitest.mjs run --maxWorkers=1 --no-file-parallelism test/integration/automatic-dirty-workspace.test.ts test/integration/workspace-graph-snapshot.test.ts test/integration/lbug-pool-generation-swap.test.ts
    - cd ontoindex && node node_modules/typescript/bin/tsc --noEmit -p .
    - git diff --check
    expected_evidence:
    - Given the candidate runtime under an internal staging gate, all deterministic/replay/side-effect checks pass with frozen inputs, exact runtime identity and inspected stderr; TypeScript passes and all route-matrix entries have evidence.
    rollback:
    - Revert only this packet; preserve unrelated work, committed graph and live reader pins.
    stop_conditions:
    - 'Missing accepted ADW-1 contract, required owner outside this write set, architecture choice or changed dependency: stop for manager preparation; do not widen scope.'
    - 'Missing capability, stale success, unbounded cleanup or failed validation: retain evidence and return the exact blocker.'
    known_blockers: []
  ADW-7f:
    title: Measure fixed clean and dirty workloads against predeclared budgets
    status: OPEN
    classification: implementation-ready
    assurance_profile: full
    complexity: complex
    depends_on:
    - ADW-7e
    type: measurement
    validation_tier: integration
    impact_risk: high
    owner_files:
    - .memory-bank/AUTOMATIC_DIRTY_WORKSPACE_PROJECT_PLAN.md
    allowed_write_set:
    - .memory-bank/AUTOMATIC_DIRTY_WORKSPACE_PROJECT_PLAN.md
    non_goals:
    - No adjacent refactors, new runtime owner, dependencies, provider calls, user Git mutations or release publication.
    required_validation:
    - cd ontoindex && node scripts/overlay-benchmark.mjs --automatic --sizes 0,1,50,51 --repetitions 20 --output ../.ontoindex/adw-validation/matrix.json
    - git diff --check
    expected_evidence:
    - Given the successful pilot artifact and fixed baseline/candidate inputs, repeated samples produce median/p95, CPU/peak RSS/bytes/build counts; all predeclared budgets pass, clean current inputs build zero times, contention has one writer and cleanup is bounded.
    rollback:
    - Revert only this packet; preserve unrelated work, committed graph and live reader pins.
    stop_conditions:
    - 'Missing accepted ADW-1 contract, required owner outside this write set, architecture choice or changed dependency: stop for manager preparation; do not widen scope.'
    - 'Missing capability, stale success, unbounded cleanup or failed validation: retain evidence and return the exact blocker.'
    known_blockers: []
  ADW-8:
    title: Document verified automatic behavior and adjudicate readiness
    status: OPEN
    classification: architecture-paperwork
    assurance_profile: full
    complexity: complex
    depends_on:
    - ADW-7f
    type: documentation
    validation_tier: unit-fast
    impact_risk: low
    owner_files:
    - .memory-bank/knowledge-hub/dirty-worktree.md
    - ontoindex/README.md
    - .memory-bank/AUTOMATIC_DIRTY_WORKSPACE_PROJECT_PLAN.md
    allowed_write_set:
    - .memory-bank/knowledge-hub/dirty-worktree.md
    - ontoindex/README.md
    - .memory-bank/AUTOMATIC_DIRTY_WORKSPACE_PROJECT_PLAN.md
    non_goals:
    - No adjacent refactors, new runtime owner, dependencies, provider calls, user Git mutations or release publication.
    required_validation:
    - git diff --check
    expected_evidence:
    - Given accepted correctness/performance evidence, docs state snapshot semantics, support limits, true failure recovery and resource costs; manager approves the default switch without claiming RT-5 or buffer-pool defects resolved.
    rollback:
    - Revert only this packet; preserve unrelated work, committed graph and live reader pins.
    stop_conditions:
    - 'Missing accepted ADW-1 contract, required owner outside this write set, architecture choice or changed dependency: stop for manager preparation; do not widen scope.'
    - 'Missing capability, stale success, unbounded cleanup or failed validation: retain evidence and return the exact blocker.'
    known_blockers: []
  ADW-8a:
    title: Enable automatic-current behavior after readiness gates pass
    status: OPEN
    classification: implementation-ready
    assurance_profile: full
    complexity: complex
    depends_on:
    - ADW-8
    type: code
    validation_tier: unit-fast
    impact_risk: high
    owner_files:
    - ontoindex/src/mcp/local/local-backend-repo-runtime.ts
    - ontoindex/test/unit/local-backend-repo-runtime.test.ts
    allowed_write_set:
    - ontoindex/src/mcp/local/local-backend-repo-runtime.ts
    - ontoindex/test/unit/local-backend-repo-runtime.test.ts
    non_goals:
    - No adjacent refactors, new runtime owner, dependencies, provider calls, user Git mutations or release publication.
    required_validation:
    - cd ontoindex && ONTOINDEX_TEST_WORKERS=1 node node_modules/vitest/vitest.mjs run --maxWorkers=1 --no-file-parallelism test/unit/local-backend-repo-runtime.test.ts
    - git diff --check
    expected_evidence:
    - Given ordinary startup with no opt-in setting, read requests use automatic preparation; rollback restores the previous default and mutation protections remain unchanged.
    rollback:
    - Revert only this packet; preserve unrelated work, committed graph and live reader pins.
    stop_conditions:
    - 'Missing accepted ADW-1 contract, required owner outside this write set, architecture choice or changed dependency: stop for manager preparation; do not widen scope.'
    - 'Missing capability, stale success, unbounded cleanup or failed validation: retain evidence and return the exact blocker.'
    known_blockers: []
  ADW-8b:
    title: Verify ordinary MCP and CLI startup with the default enabled
    status: OPEN
    classification: proof-only
    assurance_profile: full
    complexity: complex
    depends_on:
    - ADW-8a
    type: proof
    validation_tier: integration
    impact_risk: high
    owner_files:
    - .memory-bank/AUTOMATIC_DIRTY_WORKSPACE_PROJECT_PLAN.md
    allowed_write_set:
    - .memory-bank/AUTOMATIC_DIRTY_WORKSPACE_PROJECT_PLAN.md
    non_goals:
    - No adjacent refactors, new runtime owner, dependencies, provider calls, user Git mutations or release publication.
    required_validation:
    - cd ontoindex && ONTOINDEX_TEST_WORKERS=1 node node_modules/vitest/vitest.mjs run --maxWorkers=1 --no-file-parallelism test/integration/automatic-dirty-workspace.test.ts
    - cd ontoindex && node node_modules/typescript/bin/tsc --noEmit -p .
    - git diff --check
    expected_evidence:
    - Given a fresh process with no internal override/manual watcher/analyze, dirty reads succeed automatically and clean current reads build zero times; failures are typed and full stderr/cleanup is checked.
    rollback:
    - Revert only this packet; preserve unrelated work, committed graph and live reader pins.
    stop_conditions:
    - 'Missing accepted ADW-1 contract, required owner outside this write set, architecture choice or changed dependency: stop for manager preparation; do not widen scope.'
    - 'Missing capability, stale success, unbounded cleanup or failed validation: retain evidence and return the exact blocker.'
    known_blockers: []
  ADW-8c:
    title: Record final evidence and release handoff without publishing
    status: OPEN
    classification: architecture-paperwork
    assurance_profile: full
    complexity: complex
    depends_on:
    - ADW-8b
    type: closeout
    validation_tier: unit-fast
    impact_risk: low
    owner_files:
    - .memory-bank/AUTOMATIC_DIRTY_WORKSPACE_PROJECT_PLAN.md
    - .memory-bank/MEMORY.md
    - .memory-bank/project_plan-current.md
    - .memory-bank/project_pending-tasks.md
    allowed_write_set:
    - .memory-bank/AUTOMATIC_DIRTY_WORKSPACE_PROJECT_PLAN.md
    - .memory-bank/MEMORY.md
    - .memory-bank/project_plan-current.md
    - .memory-bank/project_pending-tasks.md
    non_goals:
    - No adjacent refactors, new runtime owner, dependencies, provider calls, user Git mutations or release publication.
    required_validation:
    - git diff --check
    expected_evidence:
    - Given final default smoke and authenticated role results, the manager records exact commands/exits, final source/runtime identities, limitations and rollback, updates routers and closes only this plan.
    rollback:
    - Revert only this packet; preserve unrelated work, committed graph and live reader pins.
    stop_conditions:
    - 'Missing accepted ADW-1 contract, required owner outside this write set, architecture choice or changed dependency: stop for manager preparation; do not widen scope.'
    - 'Missing capability, stale success, unbounded cleanup or failed validation: retain evidence and return the exact blocker.'
    known_blockers: []
```

## Packet Notes

### ADW-1

Record an accepted ADR at .memory-bank/ADR_AUTOMATIC_DIRTY_WORKSPACE.md. Set the route/capability matrix including diagnostic and mutation exclusions, immutable response replay, logical pagination, source enrichment, cache keys, pin lifetime, capture limits, retry policy, timeout and cleanup budgets. Decide isolated full-pipeline entry and watcher ownership without a second runtime. Prepare the measurement protocol and numeric limits before any measurements. Confirm each proposed new test path and scope; split a packet here if it still requires architecture discovery.

### ADW-2

Extend planDirtyOverlay-adjacent capture ownership. Preserve working-file semantics for staged/unstaged/untracked inputs; hash eligible bytes, paths, ignore/config and parser identity. Retain the complete eligible universe rather than the bounded overlay candidate list. New test file is explicitly planned.

### ADW-2a

Extend PipelineOptions/runPipelineFromRepo at the ADR-selected seam. Cover all parser/resolver input reads; if another owner must change, stop for scope preparation rather than falling back to live reads.

### ADW-3

Use the existing runtime/lock owners and ADR-defined capability key. Do not create a second lock service. Different repository identities remain isolated.

### ADW-4

Reuse runAnalysisPipeline/full profile through the ADR-selected isolated publication seam, not runFullAnalysis side effects. New fixture covers incoming edges, deletion/rename, ambiguous resolution and partial parsing. A degraded graph must not report authoritative zero impact.

### ADW-5

Extend existing pool/generation ownership and queryOverlay; retention markers alone do not bind pool.get(repoId). Freeze the handle API in ADW-1; if storage/repo-manager.ts needs changes, prepare a separate prerequisite before dispatch.

### ADW-5d

Use the accepted cache key and pinned source/skeleton contract. Do not promise exhaustive semantic recall. Existing read-cache fallback tests must distinguish explicit committed mode, if retained, from automatic-current.

### ADW-5e

Replace current live source enrichment at the existing boundary with the accepted snapshot reader. No hidden base-only fallback. Split context/impact before dispatch if their settled contracts require independent work.

### ADW-5h

The two cursor formats have different contracts. Do not refresh immutable response replay or silently bind gn-page-v1 offsets to changed collections. Existing helper API callers must remain type-compatible until their consumer packet.

### ADW-6

Wire the accepted lifecycle into the existing runtime and dispose path. CLI reads use foreground preparation and create no detached watcher.

### ADW-7

Extend existing fixture/process helpers; current overlay-cross-process only runs explicit analyze --dirty-overlay. New integration file is authorized as a future packet. Add a harness self-test that deliberately corrupts/misses evidence and proves failure; no manual analyze or watcher startup inside automatic scenarios.

### ADW-7c

Replace the old 1..50 explicit-overlay-only measurement limitation in the existing owner. Preserve its standalone legacy mode if required by the ADR. Bind exact CLI flags and artifact paths in ADW-1; new unit test is planned. Do not raise memory defaults or install dependencies. Implement --automatic, --pilot, --output, --repetitions and size 0/51 support used below; automatic mode includes config-change and contention fixtures. Verify exact semantics in ADW-1.

### ADW-7d

ADW-7c implements these planned flags; the ordinary unit command proves only the instrument self-check. Require ../.ontoindex/adw-validation/pilot.json plus referenced raw artifacts from the actual one-run pilot. Artifacts are local ignored outputs, not task-owned source.

### ADW-7f

ADW-1 freezes numeric budgets, baseline runtime/input identities and cold/warm convention; ADW-7c implements the declared flags and includes config-change and contention scenarios in automatic mode. Use 20 measured samples per workload and nearest-rank p95; retain all samples. Stop before the matrix if the pilot artifact, budget, or matching runtime is missing. No paid calls.

### ADW-8a

ADW-1 fixes the single internal activation seam in the existing runtime owner. This packet changes the default only after prior proofs; no permanent opt-in flag.

### ADW-8b

Run the focused default-mode smoke against the final candidate identity. Ensure the harness has a no-override mode; an internal-on test cannot substitute for this evidence. Rerun impacted checks if default wiring changes more than the accepted seam.

## Required Traceability

| Requirement ID | User requirement or decision | Disposition | Task IDs | Validation |
| --- | --- | --- | --- | --- |
| REQ-001 | Automatic preparation without manual cleanup | implementation | ADW-3, ADW-5a, ADW-5f, ADW-5g, ADW-6, ADW-8a, ADW-8b | Default MCP/CLI smoke and route matrix |
| REQ-002 | Captured source/graph consistency; accepted ADW-1 gate above | implementation | ADW-2, ADW-2a, ADW-2b, ADW-2c, ADW-4, ADW-5, ADW-5b, ADW-5c, ADW-5d, ADW-5e, ADW-7a | Content/race fixtures and pinned source/cache identities |
| REQ-003 | No routine dirty warnings on success | implementation | ADW-6b, ADW-6c, ADW-7b, ADW-8b | Ready/error response fixtures and replay |
| REQ-004 | Correct callers/impact within supported analysis | implementation | ADW-4, ADW-4a, ADW-5e, ADW-7e | Same-input full-analysis parity and clean-caller fixture |
| REQ-005 | Over 50 files and config changes | implementation | ADW-2, ADW-4a, ADW-7a | 0/1/50/51 and config escalation cases |
| REQ-006 | Bounded work, cancellation and concurrency | implementation | ADW-3, ADW-3a, ADW-3b, ADW-5, ADW-6, ADW-6a, ADW-7a, ADW-7f | Deadlines, single writer, reader pins, child drain and resource budgets |
| REQ-007 | Schema compatibility and mutation protections; accepted ADW-1 gate above | compatibility-test | ADW-5a, ADW-5h, ADW-5i, ADW-6b, ADW-7b | Legacy fields, both cursor kinds, resources and mutation-denial checks |
| REQ-008 | Explicit real failures; no stale success | implementation | ADW-2c, ADW-3b, ADW-4a, ADW-5d, ADW-5e, ADW-6b, ADW-6c, ADW-7e | Parse/build/lock/timeout failures, no authoritative false-zero result |
| REQ-009 | No automatic provider spend or user Git changes | non-goal | ADW-2b, ADW-4, ADW-5d, ADW-7b | Provider spies and frozen Git/source/base/registry identity |
| REQ-010 | Incremental relationship optimization later; accepted ADW-1 decision above | rejected | ADW-4 | Deferred; isolated full graph remains required |
| REQ-011 | Affordable Luna work without weakening gates; accepted ADW-1 gate above | architecture-gate | ADW-2 | Bounded owner/fixture packets, settled contracts and scoped correction limit |
| REQ-012 | Evidence before default activation | proof-only | ADW-7, ADW-7c, ADW-7d, ADW-7e, ADW-7f, ADW-8, ADW-8a, ADW-8b, ADW-8c | Instrument self-check, pilot, independent proof, performance, readiness, switch, smoke |

## Execution And Validation

User-authorized execution started on 2026-10-17. ADW-1 uses the validated local
manager route and predeclared null role scaffold; its accepted ADR freezes the
contracts below. Restore authenticated sub-agent routing before implementation.
Packet sizing does not change the derived role gates.

All commands are root-relative and use installed native tools. Vitest commands
explicitly enter `ontoindex/`, limit workers and file parallelism, and retain
required global setup. Never use `npm test` merely to reach Vitest: its pretest
build adds unrelated work. TypeScript covers production source; the focused
Vitest test must actually execute the new test files. No test/build result is
claimed by this planning revision.

ADW-1 must confirm commands and fixtures before dispatch. New test files listed
in YAML are deliberate future scope. Benchmark flags are a declared ADW-7c
deliverable. Source edits stay within the task write set; ignored generated
capture/measurement outputs under `.ontoindex/` are separate artifacts. Proof
and performance roles do not edit the tracker; the manager records their
authenticated evidence within its declared authority.

A successful exit alone is insufficient: retain raw requests/responses and
complete bounded stderr, runtime/input identities, assertions, child exit and
lease cleanup evidence. Vitest's configured ignored-unhandled-error behavior
does not excuse native crashes or allocation errors. Do not disable global
setup until an exact fixture is proven independent of it. Build a native Linux
candidate only where end-to-end identity requires it; a source-run fixture does
not certify a different installed binary.

### Default activation and rollback

ADW-6 through ADW-7f exercise the candidate through an internal staging seam.
ADW-8 reviews the proof and documents the intended behavior; ADW-8a enables the
default; ADW-8b starts ordinary processes with no internal override and proves it.
ADW-8c closes only after that result. A failed default smoke blocks closeout and
rolls back the activation seam; it never justifies retaining stale-success fallback.

### Buffer-pool investigation branches

- reproduced: retain exact input, raw error and query/pool identity; prepare a
  separate bounded defect task and block default enablement until its regression
  passes. No memory-default increase without repeated evidence.
- not-reproduced: retain exact attempts, versions and inputs; preserve the
  unresolved defect in the real-time tracker and make no claim this plan fixed
  it. This plan may pass its own successful recorded scenarios.

The real-time tracker remains authoritative for RT-5 and its existing evidence.
No worktree, runtime artifact, installed package or release is changed here.
Release publication is excluded from every task.

## Closeout

ADW-1 design gate is complete and preserved above. ADW-2 capture code exists but
remains unaccepted. ADW-2 is the next executable task; later acceptance is unproven.
