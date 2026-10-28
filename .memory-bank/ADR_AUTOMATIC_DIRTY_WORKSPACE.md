# ADR: Automatic dirty-workspace read preparation

Status: Accepted for implementation; runtime acceptance remains gated
Date: 2026-10-17
Authority: User instruction to execute AUTOMATIC_DIRTY_WORKSPACE_PROJECT_PLAN.md

## Decision and alternatives

Use content-verified materialized input trees, existing analysis and immutable
workspace generations, and one capability-aware request preparation boundary.
Existing symbol overlays are an optimization only where their declared coverage
suffices. Relationship reads require the complete supported graph of that input set.

Compared twice: watcher-only preparation leaves missed-event and debounce gaps;
rebuilding a full graph per request wastes work and still needs capture/pins;
the selected request gate reuses matching generations and coalesces builds.
A fully incremental relationship engine proceeds through staged engineering gates.
The first gate persists a versioned resolution seed with imports, exported bindings,
model inputs and unresolved callsites, bound to source, parser, configuration and
base-generation identities. Request integration remains gated on source-owned edge
replacement, complete dependency closure, derived-data parity, coherent captured
inputs and cancellation-safe publication. Unsupported inputs and budget overflow
retain typed refusal. All options retain existing mutation guards.
Rollback restores the previous activation seam and preserves pinned generations.

## Input contract

Extend core/analyze-delta.ts with captureWorkspaceInputs(repoPath, options) and
WorkspaceInputCapture. Return canonicalRepoPath, captureRoot, manifest, manifestDigest,
baseGenerationId, baseCommit, head, parserIdentity, configurationDigest, capturedPaths,
tombstones, totalBytes and idempotent async dispose(). Options include AbortSignal,
a monotonic deadline and injectable filesystem/barrier hooks for deterministic tests.

Reuse core/indexing/source-manifest.ts IndexSourceManifest and
computeSourceManifest/manifestsMatch/sourceManifestDigest. Add only capture-specific
entry metadata and config/parser identity there; do not replace the v1 persisted
contract or reinterpret an old manifest as capture proof. A capture manifest records
the exact ordered path/byte/executable-bit inputs. Config identity is additive to
the existing source digest. Compare HEAD/base identity explicitly.

Materialize regular eligible files and relevant configuration/ignore files under an
owner-only tree below .ontoindex/workspace-inputs/<owned-id>/; no Git clone/worktree,
hard links, source writes or embedded .git. Include the complete eligible universe,
not the first 50 dirty files. Staged/unstaged/untracked selection describes current
working-file bytes. Reject symlinks, path traversal, unreadable required input,
unsupported external/absolute resolver roots and input-limit overflow explicitly.
Use the existing walker/ignore policy and source-manifest framing.

Capture limits: 100,000 files, 512 MiB total input, existing per-file scan cap,
two attempts, 60-second request deadline including capture. Captured directories
are 0700 and files owner-readable/writable only; preserve executable intent as
manifest metadata. Enumerate and hash the live eligible set, copy bytes to the
owned tree, then re-enumerate/re-hash live and copied inputs. Publish only if the
sets, hashes, config, HEAD and base agree. The verification point is the completed
matching verification pass. This proves a verified captured input set, not an
atomic filesystem snapshot. Hash equality ignores mtime/size as authority.

The captured tree is the pipeline filesystem root. Existing parser/resolver reads
remain inside it. PipelineOptions gains capturedWorkspace carrying captureRoot,
canonicalRepoPath, manifestDigest and parser/config identities. runPipelineFromRepo
uses captureRoot for I/O and returns canonicalRepoPath for provenance; graph paths
remain repository-relative. No live-source fallback, external dependency download,
paid embedding or external analyzer is allowed. A resolver requiring uncaptured
external inputs returns incomplete/unsupported capability evidence. A new owner
needed to enforce this rule requires a separately prepared packet before dispatch.

## Generation and capability contract

Extend runDirtyOverlayAnalysis through an internal runWorkspaceAnalysis(capture,
capability, callbacks, dependencies) seam in run-analyze.ts. It invokes
runAnalysisPipeline on captured input with symbols/full profile, loads the graph
under the existing overlay generation directory, writes capture/capability metadata,
closes the writer, verifies base/HEAD before publication and atomically replaces
overlay/CURRENT. Never call the committed runFullAnalysis lifecycle from automatic
reads. No committed metadata/registry/skills/Git/embedding publication.

Generation identity includes base identity, captured input digest, parser/config
identity, profile and supported capabilities. 0 eligible changes with matching base
reuse the committed generation; missing base or changed HEAD can build an isolated
workspace full graph without publishing a committed index. More than 50 eligible
changes, resolver/config changes or relationship/process requirements select full
analysis. Parse/resolution degradation propagates and cannot authorize authoritative
empty callers/impact. Unsupported dynamic behavior stays outside completeness claims.

Retain current plus two unpinned prior generations and at most 2 GiB workspace
artifacts per repo. Live pins prevent deletion regardless of age; if the bound cannot
be met without deleting a pin, refuse new build admission. Failed unpublished owned
trees/generations are removed. Do not delete borrowed artifacts.

## Request context and pool contract

Existing local-backend-repo-runtime.ts owns prepareWorkspaceRead(repo, capability,
options) -> PreparedWorkspaceRead: repo identity, generationId, databasePath,
manifestDigest, capabilities, coverage, captureRoot, deadline, signal,
readSource(relativePath), and async release(). The accepted request snapshot is
fixed after preparation; later edits schedule a successor rather than restart the
running request. Nested calls reuse their context. release is idempotent.

Extend the existing pool-adapter owner with withPinnedGeneration(repoId, databasePath,
fn) using an immutable generation-specific entry and request-local async context.
executeParameterized/executeQuery resolve that entry inside the scope instead of
the mutable repo alias. queryOverlay receives/reuses the prepared handle and cannot
resolve CURRENT again. Release on success/error/cancellation; storage reader markers
and physical connection lifetime both participate. Existing pins are preserved.
No second pool or generation registry.

LocalBackend.callTool wraps ordinary direct/facade reads; createMCPServer wraps
lazy and resource reads through the same backend preparation method. Existing
withOperation remains shutdown admission/drain ownership. Snapshot context includes
source enrichment, symbols, graph queries, cache, provenance and pagination. Semantic
cache key adds manifest/generation/capability; fresh lexical candidates remain
required, without promising exhaustive semantic recall or automatic paid embeddings.

## Route policy

| Route | Preparation and evidence |
| --- | --- |
| CLI query / MCP query / search facade | symbols plus supported search dependencies; fresh lexical candidates and pinned cache |
| CLI context / inspect context or evidence | complete supported relationship graph and captured source |
| CLI impact / impact facade | complete supported relationship graph; incomplete negatives explicit |
| Read-only cypher / graph walks / repomap / processes / clusters / super-functions | complete graph for the selected repo and declared capability |
| ReadResource graph context/clusters/processes/details | same prepared backend context as corresponding tools |
| Docs trace/context/readiness/drift reading code facts | graph preparation plus existing docs evidence limits |
| list tools/resources/prompts/repos and setup/status/diagnose/freshness/repair metadata | no automatic preparation requirement; remain available to diagnose failure |
| analyze/index/clean/watch and mutating/refactor/apply/audit lifecycle operations | existing mutation/freshness/approval guards; no read gate authorizes a write |
| diff/history/commit-scoped inspection | preserve explicitly selected reference; never label it current workspace |
| Saved response_cursor continuation | validate stored request/integrity/TTL and replay original result bytes without preparation |
| Logical item continuation | bind manifest/generation or fail restart-required; never reuse offsets on a changed collection |

Tool aliases/facades classify by resolved operation, not spelling. Mixed operations
must preserve their existing write checks and gate only code-reading suboperations.
Unclassified operations fail the route-matrix acceptance test; they do not silently
get read permission. CLI tool.ts already reaches LocalBackend.callTool and must
dispose its backend at completion without starting a persistent watcher. Multi-repo
operations prepare each repo independently and serialize/cap admission.

Preserve legacy response field types and existing reserved invocation-error marker;
add workspace identity/capability/coverage/preparation metadata. Prepared dirty
success suppresses routine clean/stash/commit advice. Diagnostics retain truthful
dirty status and actual failures. Preparation errors use explicit codes for timeout,
cancelled, changed-input, limit, busy, unsupported and build/parse failure; no base
success fallback.

Saved gn-result-v1 pages retain exact result, integrity and existing TTL. Logical
gn-page-v1 lacks identity: allow it only under the explicit committed-reference
compatibility path; automatic-current returns restart-required and issues the new
identity-bound cursor. Expired/unavailable generation fails instead of refreshing.
Cursor limits and byte budgets remain existing-owner responsibilities.

## Coordination and watcher lifecycle

One active writer per canonical repo using existing analyze lock; one in-process
preparation promise and one latest pending successor. Waiter cancellation does not
cancel work still needed by another waiter. Monotonic request deadline 60 seconds,
at most two captures. Preparation failures are never cached as permanent same-HEAD
success. Retry background failures at 1/2/4/8/16/30 seconds capped; reset on success
or changed content identity.

Extend createWatchCommand in its existing owner with an explicit automatic refresh
callback mode, preserving ordinary CLI behavior. Automatic mode invokes only the
runtime preparation callback and cannot enter ordinary analyze child branches.
Reuse watch.lease with an acquisition token as well as PID and legacy compatibility.
Return an idempotent async stop and an owned/borrowed result. Debounce 750ms,
reconcile 30s. Runtime holds per-backend/repo ownership references, acquired before
yield and released once on eviction/removal/dispose. Requests own separate pins.
Short-lived CLI requests use foreground gate and never acquire background ownership.

Shutdown rejects admission, stops timers, cancels owned work, sends SIGTERM to owned
children, SIGKILL after 2 seconds if needed, observes exit and releases only matching
token leases within 5 seconds. Unproven exit is cleanup failure; borrowed watcher
is never killed. Max eight idle runtime repos per backend, 60-second idle eviction;
busy/pinned repos cannot be evicted. Existing backend caches share this eviction.

## Validation and measurement contract

Each YAML packet names its exact source/test scope and installed Vitest command.
New test files are deliberate packet outputs. Run focused tests serially after final
edits; keep required native setup. TypeScript gates occur on shared signature changes,
ADW-7e and ADW-8b. Native stderr errors, allocation failures and unreaped children
fail acceptance even if Vitest/process exit is zero.

Extend the existing overlay-benchmark.mjs owner; no parallel benchmark runtime.
--automatic measures normal read preparation, --pilot means one cold size-1 read,
--output writes an owned artifact plus raw references, --repetitions 20 records
20 samples per workload/phase. Matrix sizes 0/1/50/51 additionally includes config
and two-client contention. Cold: fresh process/no matching workspace generation,
prepared base permitted. Warm: untimed preparation followed by unchanged read in
the same process. No OS-cache-flush claim. Median averages positions 10/11; nearest
rank p95 is position 19 of 20.

Freeze baseline/candidate source and consumed JS/native/package hashes, identical
corpus path/byte/config/parser manifest, machine/Node/load, protocol/budget hash and
phase. Record raw requests/responses, separate bounded stdout/stderr (16 MiB each;
overflow fails), ordered build events, process/exit/signal and lease/pin cleanup.
Old dirty committed answers are not a correctness or speedup baseline. Compare
matching supported operations to same-input full-graph reference.

Use Linux /proc task/process-tree sampling every 20ms for observed aggregate RSS.
Use available /usr/bin/time (GNU Time verified locally) around each owned runtime
process tree for terminal user+system CPU; require children to be reaped before
runtime exit. Missing terminal CPU accounting invalidates the sample; sampled CPU
alone cannot prove the CPU ceiling. Never inspect process environments.
Call the result sampled peak process-tree RSS; never claim exact native peak.
A failed/missing sample invalidates measurement. This is local process accounting,
not credential inspection. Pilot must prove artifact recording; deterministic
self-check rejects missing metrics/artifacts, identity mismatch, stale response,
native error, two simultaneous writers and cleanup leak.

Predeclared unmeasured shipping limits: clean and unchanged-dirty warm p95 <=1s;
added clean-gate overhead <=max(100ms,25% compatible baseline p95); dirty-cold p95
<=55s; sampled process-tree RSS <=4GiB; cold CPU <=300 CPU-seconds, warm <=1
CPU-second; workspace artifact bytes <=2GiB/repo; cleanup <=5s. Clean current and
unchanged-warm build count is zero; contention has one writer. These are acceptance
policy, not claims of current performance; failures require diagnosis, not silently
raising limits. No provider calls or user Git/base/registry mutations.

## Packet ownership and activation

### Frozen target symbols

Paths and focused test commands are in the YAML packet. Names marked new are
decided additions to that existing owner; they are not assumed existing APIs.

| Task | Exact target seam and dependency contract |
| --- | --- |
| ADW-2 | planDirtyOverlay; new captureWorkspaceInputs/WorkspaceInputCapture; computeSourceManifest/sourceManifestDigest capture-aware options |
| ADW-2a | PipelineOptions/runPipelineFromRepo: capturedWorkspace root for I/O, canonical root for provenance |
| ADW-2b | runDirtyOverlayAnalysis/runAnalysisPipeline: consume capture and publish symbols manifest |
| ADW-2c | computeSnapshot/getOverlaySnapshot: manifest/config/base match replaces timestamp authority |
| ADW-3 | ensureRepoInitialized adjacent new prepareWorkspaceRead: single-flight keyed canonical repo+input+capability |
| ADW-3a | createWatchCommand/refreshBase/stop: callback automatic mode, token lease, Promise stop |
| ADW-3b | prepareWorkspaceRead waiter scope: monotonic deadline/signal, shared-work lifetime |
| ADW-4 | new runWorkspaceAnalysis beside runDirtyOverlayAnalysis: isolated full profile, capture-only root |
| ADW-4a | computeSnapshot/getOverlaySnapshot capability selection and 51/config escalation |
| ADW-5 | new withPinnedGeneration in pool-adapter; executeParameterized/executeQuery/queryOverlay pin context |
| ADW-5a | LocalBackend.callTool/withOperation: one prepared context, nested reuse, route classification |
| ADW-5b | resolveSymbolCandidates/readOverlayRows: prepared handle and identity filtering |
| ADW-5c | SemanticRetrievalCache.get/lookup/set: generation+manifest+capability cache identity |
| ADW-5d | backend-search query implementation and semantic-cache calls: pinned candidates and no stale success |
| ADW-5e | context/runImpact/runImpactBFS/findDirtyMentions: pinned graph and readSource instead of live enrichment |
| ADW-5f | createMCPServer CallTool handler/trackRequest: lazy resolved routes use backend prepared scope |
| ADW-5g | readResource graph resource branches: reuse backend prepared scope |
| ADW-5h | pageMcpResponse/paginateMcpItems/parseCursor/encodeCursor: immutable replay vs identity-bound logical cursor |
| ADW-5i | docs paginateMcpItems consumer: pass prepared identity or fail restart-required |
| ADW-6 | runtime prepareWorkspaceRead/lifecycle refs; LocalBackend.dispose and eviction hooks: acquire callback watcher only for persistent backend |
| ADW-6a | createMCPServer/startMCPServer shutdown: await backend disposal with cleanup contract |
| ADW-6b | TargetContextGraphAuthority/createCapabilityResponseEnvelope/deriveEnvelopeFreshness: additive workspace state |
| ADW-6c | runtime-health dirty classification/repair advice: suppress only prepared success |
| ADW-7 | overlay-cross-process fixture/process helpers; new automatic-dirty-workspace integration scenarios |
| ADW-7a | automatic-dirty-workspace barriers and watch-save-patterns deterministic races |
| ADW-7b | automatic-dirty-workspace acceptance plus response-envelope compatibility assertions |
| ADW-7c | overlay-benchmark parseArgs/analyze/main measurement loop; new instrument self-check test |
| ADW-7d | execute declared pilot command; validate artifact/discrimination, no production writes |
| ADW-7e | declared integration+TypeScript commands; independent graph/source/route proof |
| ADW-7f | declared matrix command; terminal CPU+sampled RSS and frozen protocol comparisons |
| ADW-8 | named README/dirty-worktree docs and manager readiness record |
| ADW-8a | shared uncached backend-overlay activation predicate across existing consumers; absent/1 enables, 0/empty/other disables; no new setting |
| ADW-8b | automatic-dirty-workspace ordinary-process/no-override proof and TypeScript |
| ADW-8c | manager closeout and active routers through authenticated state tools |

ADW-5a's calltool-dispatch test enumerates the actual registered direct/facade
operation set and rejects unclassified code operations. ADW-5f/g cover the separate
lazy/resource registries; ADW-7b cross-checks the full matrix and CLI query/context/
impact/cypher routes. Registry growth therefore requires explicit classification.

The YAML plan is authoritative for dependencies/write sets. ADW-1 freezes these
interfaces; workers do not discover architecture. Existing helper names above are
source-verified; newly named interfaces are decided additions. Each task's
expected_evidence and focused test is its runnable scenario.

Add source-manifest.ts to ADW-2's capture owner set. ADW-2a materializes pipeline
root/provenance behavior without introducing a source-provider stack. ADW-3a owns
the automatic watcher callback/token/async stop extension before ADW-6. Any extra
parser/resolver/storage/CLI owner needed to enforce isolation is prepared as a
bounded prerequisite rather than silently added to a worker packet.

Staged implementation/proof precedes performance, documentation/readiness, default
switch and ordinary no-override MCP/CLI smoke. Preserve unresolved real-time RT-5
and buffer-pool evidence. No release publication is authorized by this ADR.

## Complete resolution replay gate (2026-10-21)

The accepted four-map import snapshot is a prerequisite, not a complete seed.
Compare three choices: graph-node reconstruction loses unresolved inputs and
registration metadata; serialization of live objects captures closures and caches;
ordered plain input replay through existing owners preserves resolution semantics.
Select input replay. A second challenge requires sequential, worker and recovery
parity, original receiver inputs before mutation, scope finalization, exported
bindings, global ambiguity and explicit source identity.

Implement in this order:

1. Model replay: extend `semantic-model.ts:createSemanticModel`,
   `symbol-table.ts:SymbolTableWriter.add`, `registration-table.ts`, and
   `resolution-context.ts` in the existing ingestion model. Preserve ordered
   complete registration metadata and restore through `model.symbols.add`.
   Rebuild caches; preserve deep ownership and import-map order. Capture
   `ParsedFile` inputs for `finalize-orchestrator.ts:finalizeScopeModel`, rather
   than serializing partially attached scope indexes. Extend existing model,
   registration, import-resolution and scope-finalizer tests with semantic
   round trips, overloads, owners, aliases and malformed-input rejection.
2. Parse retention: extend `pipeline-phases/parse-impl.ts:runChunkedParseAndResolve`
   and its `JsonlStage`, `parsing-processor.ts`, `workers/parse-types.ts`,
   `workers/parse-worker.ts`, `call-processor.ts`, `pipeline-phases/parse.ts`
   and cross-file propagation owners. Retain unresolved calls, assignments,
   constructor/file bindings, heritage, exports and scope inputs before disposal
   or receiver-type mutation. Worker, sequential and recovery paths must emit
   equivalent file-owned records. Existing JSONL drain loads the whole file;
   bounded record iteration is required before complete replay uses that owner.
   Transfer an immutable replay handle before phase cleanup, preserving cleanup
   on success, error and cancellation. Extend worker protocol, fallback, phase
   lifecycle and cross-file tests with a clean unresolved caller that resolves
   after a target is added, chunk-order parity and forced fallback.
3. Seed publication: extend `types/pipeline.ts:PipelineResult`, ingestion
   pipeline, `core/run-analyze.ts` and existing `storage/repo-manager.ts`
   generation publication. Bind versioned complete records to source manifest,
   parser/configuration, base generation/commit and content hashes. Reject
   incomplete, corrupt or mismatched seeds. Preserve atomic publication, pins,
   pruning and the previous generation on failure; do not add another store.
4. Edge parity and activation: prepare a separate packet in existing graph and
   runtime owners for source-owned replacement and complete dependency closure.
   Preserve clean incoming callers and deletion/rename behavior. Compare edges,
   processes, communities and ranking against independent full analysis of the
   same captured bytes. Unproven closure uses existing bounded full analysis or
   typed refusal. Activate only after parity and cancellation/publication proof.

Retention admission policy: inclusive 64 MiB serialized UTF-8 including delimiters,
100,000 records, and 256 KiB per record. Charge against the remaining shared
artifact allowance; these are refusal thresholds, not measured capacity for
7,001 files. Read chunks are at most 1 MiB; replay batches at most 1,000 records
or 1 MiB. Bound fields before encoding or use a bounded encoder; checking after
JSON.stringify does not bound allocation. Reader buffers do not bound model or
graph memory. Enforce the absolute request deadline, cancellation and shared
artifact ceiling before claiming resource bounds. Overflow yields typed incomplete
evidence and cannot publish a complete seed. Test exact and one-over limits,
multibyte records, malformed input, cancellation and cleanup of outstanding I/O.

Compared fixed, configurable and input-proportional ceilings: select fixed internal
ceilings for the initial refusal contract. Configuration adds public surface;
input proportionality alone lacks a hard limit. Revisit only with measurements.
Independent review requires a direct-registry mutation audit and complete
ParsedFile/finalizer input retention before an add-event journal claims completeness.
Preserve duplicate registration events, original Function plus ownerId metadata,
array ownership and clear semantics. Capture worker calls before receiver seeding
mutates them and sequential unresolved calls before they are discarded.

### Frozen implementation packets

MODEL owns `ontoindex/src/core/ingestion/model/semantic-model.ts` and
`ontoindex/test/unit/model/semantic-model.test.ts`. Choose opt-in chronological
mutation capture over unique-definition serialization (which loses duplicate
registration semantics) or a symbols-only journal (which misses exposed direct
registry writes). Wrap registry registration and individual clear operations
before constructing the dispatch table. Capture top-level symbol additions and
full clear, suppressing nested capture during fan-out and cascade clear. Preserve
original Function/ownerId metadata, order, duplicates and deep-owned mutable
metadata; replay into a fresh non-recording model. Disabled capture must allocate
no journal or metadata copies. Full and individual clears retain their distinct
effects. Scope attachment is outside this registration prerequisite. Cross-index
JavaScript reference identity is not a replay guarantee. Test duplicate fan-out,
direct writes, clear order, mutation isolation and malformed/overflow refusal.

SCOPE owns `ontoindex/src/core/ingestion/parsing-processor.ts`,
`ontoindex/src/core/ingestion/workers/parse-worker.ts`,
`ontoindex/src/core/ingestion/workers/parse-types.ts`,
`ontoindex/src/core/ingestion/pipeline-phases/parse-impl.ts` and
`ontoindex/src/core/ingestion/finalize-orchestrator.ts`. Retain ordered complete
ParsedFile inputs: filePath, moduleScope, scopes, parsedImports, localDefs and
referenceSites including optional nested facts. Encode bindings/typeBindings Maps
as ordered entries and reconstruct them. Bind workspace inventory, effective
ImportConfigs and missing/present configuration state to source hashes, provider,
parser/hook identities and base generation. Rebuild path indexes and caches using
existing resolvers. Unknown executable hooks, missing providers, extraction errors,
quarantine or lightweight modes must refuse complete replay. Retained scopes do
not establish method-dispatch or MRO completeness.

SCOPE validation targets are
`ontoindex/test/unit/scope-resolution/finalize-orchestrator.test.ts`,
`ontoindex/test/unit/scope-resolution/import-target-adapter.test.ts`,
`ontoindex/test/unit/scope-resolution/parse-worker-scope-integration.test.ts`,
`ontoindex/test/unit/parse-worker-protocol.test.ts` and
`ontoindex/test/unit/parse-impl-fallback.test.ts`. Require worker, sequential and
recovery equivalence before disposal, Map/order preservation, cycles, wildcard
imports, reexports and inventory/config invalidation. Preserve existing resolver
ambiguity behavior without claiming exhaustive resolution.

#### SCOPE execution refinement (2026-10-22)

Capture configuration observations in the existing language-config and import
processor owners, at the same loader I/O that supplies effective ImportConfigs.
Retain present, absent and failed reads separately, content hashes, directory
membership and iteration order, and traversal errors and limits. CSharp directory
search and Swift Sources discovery mean a configuration-file hash alone is
insufficient. Preserve effective configurations reused across parse chunks.

Capture complete ParsedFile inputs before parse-impl clears chunk worker data;
use the existing parse-stage owner, without a second store or worker codec.
Sequential parsing now exposes a synchronous transient callback; the retention
sink must detach nested Maps and objects and record explicit per-file extraction
outcomes. Empty artifacts cannot certify complete extraction. Apply the frozen
aggregate, record, read and batch limits before accepting a complete capture.

Freeze asynchronous lifetime ownership in parse.ts and parse-impl before durable
implementation: transfer each handle once, await cleanup on success, failure and
cancellation, and preserve the primary error when cleanup also fails. Include
pipeline.ts and analyze-delta explicitly in a successor write set if plumbing is
needed; a callback alone does not establish this lifetime contract.

Replay through finalize-orchestrator and import-target-adapter, reconstructing
ordered Maps, path indexes and existing resolvers. Test cycles, wildcard imports,
reexports and ambiguity against fresh analysis. Bind source-manifest/configuration
digests, parser/provider/hook contracts and base generation/commit. Unknown
identity or extraction state refuses completeness. Scope retention does not prove
method dispatch or MRO coverage; SEED retains generation-publication ownership.

#### TS/JS local binding identity refinement

Preserve every declaration in localDefs and structural ownedDefs. Add an optional
post-collection local-binding selector to the existing provider/extractor owners.
It receives all detached declaration candidates for one host/name and may return
only a nonempty unique subset of those candidates; invalid selections throw.
Providers without the hook preserve existing append semantics. Shared BindingRef,
lookup, finalization and retained formats remain unchanged.

For supported identifier var declarations, detach the exact variable-environment
range from the AST: function, program, namespace body or class static-block body.
Validate that range against the extracted scope chain. Preserve nested function
boundaries. Mark simple parameters explicitly; a matching parameter is canonical,
otherwise choose the earliest var declaration by numeric source position.
Unsupported patterns, non-simple parameter environments, catch-name collisions,
function-name collisions and conflicting lexical declarations must refuse the
bounded helper rather than invent identity. Provider activation remains gated.

Compared twice: append-and-hoist leaves duplicate candidates; dropping captures
loses declaration facts; post-collection selection preserves evidence and existing
wire formats. Grouping is linear in declarations; selection scans each group once.
Tests must cover capture-order independence, parameter overlap, isolated scopes,
invalid selections and preserved defaults. Rollback removes the optional hook
and TS/JS helper together without changing persisted data.

CALLS follows SCOPE because they share parse ownership. It owns
`ontoindex/src/core/ingestion/pipeline-phases/parse-impl.ts`,
`ontoindex/src/core/ingestion/pipeline-phases/parse.ts`,
`ontoindex/src/core/ingestion/pipeline-phases/cross-file-impl.ts` and
`ontoindex/src/core/ingestion/call-processor.ts`. Capture canonical unresolved
calls before receiver seeding, together with heritage, exports, assignments and
constructor bindings in every parse path. Replace whole-file JSONL hydration and
whole-batch encoding with bounded admission and iteration under the policy above.
Await outstanding I/O before cleanup and preserve the primary failure. Validation
targets are `ontoindex/test/unit/parse-impl-fallback.test.ts`,
`ontoindex/test/unit/parse-phase-lifecycle.test.ts`,
`ontoindex/test/unit/call-processor.test.ts` and
`ontoindex/test/unit/cross-file-impl.test.ts`; require pre-mutation fidelity,
fallback parity, exact/one-over limits, cancellation and cleanup.

SEED follows MODEL, SCOPE and CALLS. It owns
`ontoindex/src/types/pipeline.ts`, `ontoindex/src/core/ingestion/pipeline.ts`,
`ontoindex/src/core/run-analyze.ts` and `ontoindex/src/storage/repo-manager.ts`.
Carry the complete replay handle through the existing immutable generation owner;
publish only after identity and completeness validation. Existing diagnostic
checkpoints are not replay seeds. Validate corrupt/incomplete rejection, source
identity, atomic publication, pins/pruning and preservation of the previous
generation in `ontoindex/test/unit/run-analyze-snapshot.test.ts`,
`ontoindex/test/unit/dirty-overlay-build.test.ts`,
`ontoindex/test/unit/overlay-generations.test.ts` and
`ontoindex/test/unit/source-manifest.test.ts`.

These packets are sequential where write sets overlap. Each requires an executable
tracking packet and source/test verification before dispatch. Complete capability
requires every supported language path to retain all required facts; unsupported
or unknown extraction paths remain explicitly incomplete. Independent review must
check the final packet against the production mutation and disposal paths. No
truncated seed may advertise complete capability.
Existing tests above are validation targets, not executed replay tests. No cap
increase or runtime activation is authorized by completion of an early packet.

## ADW-7 disposition: cgroup terminal-window CPU accounting (2026-10-19)

For warm samples, use an owned cgroup v2 leaf scope entered before the measured
request executes. Take the CPU baseline after preparation and charge terminal
user+system CPU from that baseline through the final empty-scope snapshot, which
includes shutdown work. A sample qualifies for the warm CPU gate only when the
final snapshot, teardown, scope removal, and transport close all succeed. If any
part is missing, sampled CPU or GNU time is fallback evidence and does not pass
the warm gate. Cold samples continue to use GNU time.

Keep the budgets unchanged: 55 seconds dirty-cold, 1 CPU-second warm, and 4 GiB
sampled process-tree RSS. Each contention client has its own scope. Scope identity
is checked at kill time only; hostile same-user replacement is outside the scope
of this measurement contract. One warm-terminal sample records an observation but
does not establish percentile performance.
