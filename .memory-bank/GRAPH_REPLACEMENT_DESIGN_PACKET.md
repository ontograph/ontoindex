# Source-owned graph replacement design

Date: 2026-10-24
Status: Design recommendation; implementation and runtime acceptance gated
Authority: ADR_AUTOMATIC_DIRTY_WORKSPACE.md; LUNA_WORKSPACE_COMPLETION_PLAN.md

## Problem and verified owners

Replacing a callee file must update its definitions and emitted relationships,
then resolve affected clean callers against the new definitions. Preserving an
old incoming edge blindly can preserve a nonexistent target or stale binding.

- `createKnowledgeGraph`, `removeNode`, `removeNodesByFile` and
  `removeRelationship` in `ontoindex/src/core/graph/graph.ts:4` provide mutation.
  File removal repeatedly scans relationships and deletes incoming edges too.
  `addNode` and `addRelationship` retain the first value for a duplicate ID;
  replacement must remove superseded records before insertion.
- `KnowledgeGraph` in `ontoindex/src/core/graph/types.ts:12` exposes no source
  ownership index or transactional replacement operation.
- `planDirtyOverlay` in `ontoindex/src/core/analyze-delta.ts:382` distinguishes
  include paths and tombstones; renames produce an old-path tombstone plus a
  new include path. A bounded include list can leave uncovered dirty paths.
- `runWorkspaceAnalysis` in `ontoindex/src/core/run-analyze.ts:847` creates an
  isolated generation, runs full or symbols analysis over captured inputs,
  closes storage, verifies base/HEAD, then renames the temporary CURRENT pointer.
  Its catch/finally removes unpublished artifacts and disposes capture. This is
  the existing publication seam; it does not currently replace retained edges.
- `persistScopeRetentionCandidate` in
  `ontoindex/src/core/ingestion/pipeline-phases/scope-retention-candidate.ts:53`
  writes eleven bounded, hashed families, verifies the candidate and refunds
  charged bytes after cleanup on failure. The manifest remains version 2,
  `status: candidate`, `seedReady: false` and observed-parser-input evidence.
- `verifyScopeRetentionCandidate` in the adjacent
  `scope-retention-candidate-reader.ts:49` validates persisted candidate bytes.
  Integrity verification does not establish replay completeness.
- `prepareWorkspaceRead` in
  `ontoindex/src/mcp/local/local-backend-repo-runtime.ts:335` refuses a full
  graph build when the indexed base file count exceeds `workspaceMaxFiles`;
  `DEFAULT_MAX_WORKSPACE_FILES` at line 113 is 1600. This is a base-file cap,
  independent of the dirty-path count and the overlay's 50-path entry guard.

Committed-mode OntoIndex search succeeded at indexed commit 2623820; it excludes
dirty source. Current source above governs this recommendation. No graph-backed
claim is made about the uncommitted implementation.

## Three designs, first review

| Design | Correctness and root-cause coverage | Cost and failure modes |
| --- | --- | --- |
| A. Replace source-owned output, replay conservative dependency closure | Save retained caller inputs before deleting incident edges; remove changed/deleted producer output, replay changed files and clean dependent callers against one candidate model. Include unresolved observations and transitive import/export/type dependencies. | Requires proven ownership and complete dependency evidence. A one-pass removal avoids repeated relationship scans; closure can approach the whole repo. Missing evidence refuses admission. |
| B. Tombstones plus called-name invalidation | Keep a logical deleted-symbol set and re-resolve callers whose retained calledName matches old/new symbol names; filter tombstones at read time. | Cheap for small name sets, but aliases, overloads, member dispatch, wildcard exports and previously unresolved calls defeat name-only closure. Adds filtering to readers and risks stale derived data. |
| C. Typed refusal with bounded captured full analysis | For any unproven incremental case, rebuild the entire supported graph from the same verified capture within existing limits; refuse when the limits cannot be met. | Reuses current semantics/publication and is simple to roll back. Full parse/resolution cost remains; the 1600 default cannot establish service for a 7001-file base. Refusal is truthful but does not satisfy large-workspace availability. |

All three retain captured input identity, mutation guards and generation pins.
A and C preserve existing result schemas and resolver semantics; B requires
every reader to honor tombstones, increasing compatibility risk. None needs a
new dependency. A's provenance admission and C's capture bounds preserve the
security boundary; B must also prevent stale targets leaking through bypasses.
All require same-input reference tests and unpublished-generation rollback.

## Second review and recommendation

An existing incoming-edge list is insufficient: newly exported names can resolve
previously unresolved clean calls, and removal can change overload selection.
SourceId alone also cannot prove producer ownership for every edge family;
file containment, cross-file output and globally derived edges need explicit
ownership rules. Never infer all ownership from the source endpoint's filePath.

Reject B as the production completeness rule. Name matching may select extra
work, but cannot certify that no other callers are affected. Reject C as the
only large-workspace solution because it preserves the full-build bottleneck.

Recommend A with C as a bounded refusal/fallback policy. Begin conservatively:
replay all retained clean resolution inputs whenever dependency closure cannot
be proven narrower. If seed completeness itself is unproven, use captured full
analysis or typed refusal. This addresses stale output without adding a second
resolver. Optimize closure only after independent all-file replay parity passes.

Before mutation, construct a candidate replacement plan with removed paths,
producer-owned edge IDs, affected caller records, new outputs and identity.
Validate it against the pinned base; execute only on an unpublished graph.
Delete changed/deleted nodes and incident edges in one pass, replace output
owned by affected clean producers, then replay their original observations.
An unchanged surviving binding must regain the same semantic CALLS edge;
deleted or renamed targets must disappear or resolve to the correct replacement.
Recompute globally derived data through existing full-profile analysis until
incremental parity is independently established. Do not copy stale aggregates.

## Owner changes and disjoint developer split

This packet freezes design direction; exact replay entry points remain dependent
on the separate replay-parity packet. No implementation dispatch is admitted
until that packet and complete seed persistence have passed their gates.

| Developer | Allowed source/test files | Symbol scope and deliverable |
| --- | --- | --- |
| A: graph mutation | `ontoindex/src/core/graph/graph.ts`; `ontoindex/src/core/graph/types.ts`; `ontoindex/test/unit/graph.test.ts` | Extend `createKnowledgeGraph` and `KnowledgeGraph` with a proposed batch replacement primitive. Preserve existing `removeNode`/`removeNodesByFile` contracts; validate the whole plan before mutation, remove incident edges in one pass, return affected clean source IDs for replay. Test duplicate IDs, missing endpoints, empty batches and surviving incoming-edge evidence. |
| B: orchestration and runtime proof | `ontoindex/src/core/run-analyze.ts`; `ontoindex/src/mcp/local/local-backend-repo-runtime.ts`; `ontoindex/test/integration/automatic-dirty-workspace.test.ts`; `ontoindex/test/integration/workspace-graph-snapshot.test.ts`; `ontoindex/scripts/overlay-benchmark-automatic.mjs` | Extend `runWorkspaceAnalysis` and `prepareWorkspaceRead` to admit only verified replacement/replay, preserve unpublished rollback, and gate incremental admission separately from full-build limits. Extend existing integration fixtures and automatic benchmark owner. Never raise the default cap to create a passing result. |

B consumes A's reviewed interface and the accepted replay entry point; source
edits may proceed independently only after that contract is frozen. Candidate
writer/reader, pipeline resolver and storage pin owners remain prerequisites;
changes there require separate bounded packets rather than extending this split.
The replacement primitive's new name is deliberately unspecified until contract
review; every existing symbol named above was verified directly in source.

## Smallest reference fixtures and acceptance gates

Use three tiny source files: callee, clean importing caller and unrelated caller.
For every case compare canonical nodes, relationships, resolution outcomes and
supported derived outputs with independent full analysis of identical captured
bytes. Ignore only documented nondeterministic generation metadata.

| Trigger | Required observation |
| --- | --- |
| Add file exporting a formerly missing name | Retained unresolved clean call resolves when eligible; unrelated output stays equal. |
| Edit callee with stable identity | Clean incoming caller remains correct; superseded callee-owned edges vanish. |
| Delete callee | No dangling CALLS; clean caller becomes unresolved unless a valid alternative exists. |
| Rename callee/file | Old path and obsolete IDs disappear; unchanged imports refuse or remain unresolved, updated imports bind to new target. |
| Preserve clean incoming caller | Its observation is replayed despite untouched bytes; unchanged binding matches reference confidence/evidence. |
| Cancel during replacement/replay | Published CURRENT and pinned base remain usable; candidate output is discarded and leases released. |
| Fail before pointer rename | Inject storage/metadata/rename failure; old CURRENT survives and owned temporary generation is removed. |
| Fail housekeeping after publication | Published generation remains usable; pruning failure does not roll back successful publication. |

Additional admission fixtures: stale/corrupt/partial seed, changed parser/config,
base/HEAD changes, unsupported syntax, missing ownership, budget overflow and a
closure exceeding budget must return typed evidence without committed fallback.
Pin one prior generation while publishing and pruning; prove the pin survives.
An injected callback failure must never leave CURRENT pointing at deleted data.

## Large-workspace measurement contract

Extend the existing automatic benchmark module; its main entry is
`ontoindex/scripts/overlay-benchmark.mjs --automatic`. Run nothing for this design.
Freeze candidate/baseline artifacts, native hashes, Node/machine identity and
source/config/parser manifests before the later measurement run.

Prepare a disposable 7001-eligible-file base and record actual eligible capture,
indexed-base and dirty file counts separately. First exercise current admission
at cap 1600: record `workspace_too_large` and elapsed refusal time, with no
navigation speed claim. Then test the accepted incremental path at the same cap
and corpus; a supported incremental success must not imply full-build admission.
If product admission still refuses, large-workspace availability remains failed.

Use normal eight-tool requests from the existing integration matrix; include
dirty sizes 0/1/50/51, edit/delete/rename, config and two-client contention.
First prove one cold size-1 artifact; only then run 20 cold/warm samples per
workload. Cold uses a fresh process without a matching workspace generation;
warm uses untimed preparation then an unchanged read in the same process.
Record monotonic request wall time, phase timings, builds, raw responses,
bounded stderr/stdout, exits/signals, pin/lease cleanup and manifest identities.

Measure sampled aggregate process-tree peak RSS using Linux /proc every 20ms;
record missed/transient sampling limitations. GNU time supplies cold terminal
CPU; warm CPU requires the ADR's delegated cgroup scope. Do not call sampled
RSS an exact native peak. Compare against full analysis of the same captured
bytes for correctness; a fast refusal or old committed answer is not a baseline.

Apply existing ADR limits without inventing measurements: warm p95 <=1s,
dirty-cold p95 <=55s, sampled process-tree RSS <=4GiB, cold CPU <=300 CPU-seconds,
warm CPU <=1 CPU-second; also retain all remaining ADR overhead/cleanup limits.
Report median from samples 10/11 and p95 from sample 19 of 20; unchanged warm
build count must be zero and contention must use one writer. Preserve failures.

## Non-goals and unproven state

No product edits, test/build execution, cap changes, reindex, provider activation,
installation, release or new transport are authorized by this design artifact.
No all-language replay completeness, seed promotion, dependency-closure proof,
atomic cancellation, publication safety or performance result is established.
Full-profile derived parity, connected installed artifact identity and disposable
lifecycle acceptance remain required before runtime readiness can be claimed.
