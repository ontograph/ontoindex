# ADR 0016: Resource Lifecycle Graph and Systems Auditor Overlay

Status: Proposed

## Context

OntoIndex currently models code structure and execution mostly through symbols, files, routes, processes, and relationships such as `CALLS`, `ACCESSES`, `HANDLES_ROUTE`, and `STEP_IN_PROCESS`. This is enough for normal code navigation and blast-radius review, but it is not enough for systems audits where the risky object is not a function. The risky object may be a file descriptor, PID, signal mask, lock, global quota, state enum, WASM buffer, ABI field, tainted value, or swallowed error.

Recent systems-audit work exposed this gap:

- FD handoff through `sendmsg` / `SCM_RIGHTS` was invisible after the syscall boundary.
- Fork/exec safety, `O_CLOEXEC`, TOCTOU, zombie, and signal-mask bugs required manual forensic tracing.
- State-machine bypasses were spread across assignments and guard checks.
- WASM/IPC alignment and TypeScript/C++ numeric-boundary bugs were outside standard linting.
- Existing impact output showed code callers, not global resource pressure or starvation risk.
- MCP freshness checks remained manual through `gn_ensure_fresh`, so stale audit findings could be repeated after fixes.

The existing post-index sidecar architecture in ADR 0015 is the correct substrate for this work. These analyzers are deeper and more expensive than the main Tree-sitter analyze path, and many results are advisory until proven stable. They must not silently mutate trusted graph facts or appear as safety-critical truth without freshness, confidence, and source evidence.

ADR 0017 defines the Audit Lifecycle layer that consumes these systems-audit facts as evidence for findings, verification, tombstones, root-cause dedupe, implementation bundles, and dispatch governance. This ADR owns how evidence is extracted; ADR 0017 owns how audit findings are accepted, rejected, carried forward, or dispatched.

ADR 0018 defines the MCP audit trust contract that constrains how these analyzers are exposed to customers: target freshness, tool availability, capability readiness, result envelopes, and manager-level audit workflows. Systems-audit tools from this ADR must not be advertised as reliable forensic tools until they satisfy ADR 0018's freshness, capability, and evidence requirements.

## Challenge Review

This proposal is valuable, but the unsafe version of it would overfit one audit session and pollute the graph with speculative facts. The hard challenges are:

1. **Resource identity is not a variable name.** A file descriptor number is process-local and can be reused. `fd=4` in a parent and `fd=4` in a child are not the same identity by default. The stable model is an abstract resource instance plus per-process handle aliases.
2. **Cross-process handoff is rarely single-hop.** `SCM_RIGHTS`, `fork`, `exec`, `dup`, `fcntl`, pidfds, and wrapper helpers often split allocation, transfer, and ownership into separate functions. The analyzer must tolerate incomplete paths and report unresolved identity gaps.
3. **Rule output will be noisy unless scoped.** TOCTOU, fork-safety, lock, and zombie heuristics are useful only when every finding has why-fired evidence, why-it-may-be-false-positive notes, and suppression/waiver support.
4. **Nine new top-level MCP tools is too much for a first release.** The first implementation should prove one report envelope, one sidecar record family, one response limiter, and one freshness model before expanding the surface.
5. **Graph promotion is a compatibility event.** New node labels and relationship types affect storage, queries, web rendering, impact traversal, and package consumers. Sidecar-only facts must come first.
6. **Freshness latching must not become background indexing.** A watcher that scans a large repo continuously is a performance bug. The first version should use a cheap dirty flag from mtime/hash manifests and Git status checks, not broad file watching.
7. **Fault simulation is research-grade.** It should start as branch-slice explanation for a single return value, not as a general symbolic executor.

### 6. `AuditMetricLayers` (Geo-Enrichment)
- **Capability:** A framework for attaching external metadata "Layers" (e.g., production error rates, memory spikes, or ownership census) to specific file paths or symbols in the graph.
- **Native Surface:** `ontoindex/src/core/systems-audit/metric-layers.ts`.
- **Purpose:** Augment the static code map with "Live" systems data without modifying the source code, allowing for "Pressure-Aware" impact analysis.

## Decision

Introduce a Resource Lifecycle Graph as a post-index systems-audit overlay.

The overlay will extract resource, state, lock, ABI, taint, error, and constraint facts into versioned sidecar records first. Stable facts may later be promoted into first-class graph nodes and relationships after snapshot tests, false-positive review, migration review, and audit validation prove their precision. MCP super-functions will expose the overlay through bounded reports with explicit evidence, confidence, limits, stale-state metadata, and unresolved gaps.

This ADR does not approve a broad rewrite of the core call graph. It approves an additive analyzer architecture:

1. Keep the primary symbol graph deterministic and fast.
2. Store systems-audit facts in a sidecar keyed to `sourceIndexId`, `sourceCommitHash`, analyzer id, analyzer version, file hash, and graph schema version.
3. Promote only stable, low-noise facts into the primary graph schema.
4. Expose agent-facing systems-audit workflows through a minimal MCP surface first, then split into more `gn_*` super-functions only after response shapes stabilize.
5. Treat the LLM as the interpreter of evidence, not the source of mechanical dataflow truth.

## Algorithm/Technique

### 1. Fact ownership and storage

Create a new subsystem:

```text
ontoindex/src/core/systems-audit/
  resource-facts.ts
  resource-extractor-cpp.ts
  systems-rule-engine.ts
  fsm-extractor.ts
  taint-trace.ts
  lock-graph.ts
  abi-contracts.ts
  error-topology.ts
  fault-simulator.ts
  constraint-graph.ts
```

Each analyzer writes sidecar records shaped like:

```text
systems audit record:
  kind: systems-audit-*
  sourceIndexId
  sourceCommitHash
  analyzerId
  analyzerVersion
  filePath
  fileHash
  status
  confidence
  evidence[]
  records[]
  limits
  skipReasons
```

Readers must apply ADR 0015 sidecar rules:

- Reject records whose `sourceIndexId` or `sourceCommitHash` does not match the current primary index.
- Report stale, partial, failed, ambiguous, unsupported, and unresolved states explicitly.
- Keep primary graph facts separate from advisory systems-audit evidence.
- Apply deterministic response limits before returning through MCP.

### 2. Resource identity model

The resource model has three layers:

```text
ResourceInstance
  stable abstract resource: open file description, socket endpoint, pid, signal mask, WASM buffer, quota

ResourceHandle
  process-local alias: fd number, pidfd number, variable name, handle field, buffer view

ResourceEvent
  lifecycle event: allocate, duplicate, close, inherit, hand off, receive, escape, leak
```

Rules:

- Never identify a resource only by FD number.
- `fork` inherits handles that point to the same `ResourceInstance`, subject to later close/dup/exec rules.
- `exec` preserves only handles without close-on-exec.
- `SCM_RIGHTS` creates a receiver-side `ResourceHandle` that aliases the sender-side `ResourceInstance`; the edge evidence is the send/receive path, not equality of FD numbers.
- `pidfd_getfd` duplicates a remote process handle into a local handle; the target alias is local, but the resource instance is inherited from the remote handle if the lookup is resolved.
- Unknown or wrapper-hidden ownership must be represented as `unresolved`, not guessed.

The first implementation may store these as sidecar facts only:

```text
resourceInstanceId
handleId
processIdentity
symbolId
filePath
lineSpan
eventKind
mechanism
confidence
unresolved[]
```

### 3. Graph schema additions

Add graph nodes only after the sidecar facts prove stable.

Candidate node labels:

```text
Resource
Constraint
State
Lock
AuditFinding
AbiContract
```

Candidate relationship types:

```text
ALLOCATES_RESOURCE
DUPLICATES_RESOURCE
CLOSES_RESOURCE
HANDS_OFF_RESOURCE
INHERITS_RESOURCE
CONSTRAINS
TRANSITIONS_TO
GUARDS_STATE
TAINTS
SANITIZES
LOCKS
BLOCKS_ON
SERIALIZES_AS
PROPAGATES_ERROR
SWALLOWS_ERROR
```

`HANDS_OFF_RESOURCE` is the flagship cross-process edge, but it must not be emitted until both sides have resource identities. For `SCM_RIGHTS`, the edge links a sender-side `ResourceHandle` to a receiver-side `ResourceHandle` through the shared `ResourceInstance`. For `pidfd_getfd`, the edge links the remote process handle to the duplicated local handle through the resolved resource instance. Every edge must include:

- resource kind: `fd`, `pid`, `signal_mask`, `socket`, `buffer`, or `quota`
- source symbol and target symbol
- boundary mechanism: `SCM_RIGHTS`, `pidfd_getfd`, fork inheritance, exec inheritance, IPC payload, or WASM export
- confidence and reason
- file path and line span evidence
- unresolved participants, if identity is incomplete

Promotion gates before adding any candidate node or relationship to the primary graph:

- at least one sidecar-only release with stable JSON shape
- fixture coverage for stale, ambiguous, unsupported, and unresolved cases
- measured false-positive rate on at least one real systems repository
- migration note for `ontoindex-shared` graph type changes
- MCP response compatibility test
- web/consumer fallback for unknown labels and relationship types

### 4. Systems rule engine

Implement `systems-rule-engine.ts` as a deterministic pattern runner over AST facts, call graph edges, and sidecar facts. Initial rules:

- TOCTOU: `stat`, `lstat`, `access`, or `realpath` followed by `open`, `link`, `rename`, or privileged use without stable handle validation. The rule must recognize common mitigations such as `openat`, directory FDs, `O_NOFOLLOW`, inode revalidation, and same-handle use.
- CLOEXEC: FD-producing calls without `O_CLOEXEC`, `SOCK_CLOEXEC`, `pipe2`, `dup3`, or follow-up `fcntl(FD_CLOEXEC)`.
- Fork safety: child path between `fork` and `exec` calling unsafe functions such as allocation, `dprintf`, logging wrappers, mutex-taking functions, or non-async-signal-safe code.
- Zombie risk: `fork` without reachable `waitpid`, pidfd tracking, subreaper contract, or `PR_SET_PDEATHSIG`.
- Signal inheritance: `sigprocmask` changes before fork/exec without restoration or explicit child reset.
- Lock pressure: blocking calls, I/O, unbounded loops, large container mutation, or lock-order changes while a mutex is held.

Each finding must include:

- stable `auditId`
- category
- severity and confidence
- evidence path
- why the rule fired
- why the rule may be a false positive
- suggested next tools
- stable suppression key and suppression reason, when present
- language and platform scope

The first rule set is C/C++ and POSIX/Linux focused. JavaScript/TypeScript WASM, Rust, and cross-language ABI rules are later analyzers, not part of the first rule-engine acceptance gate.

### 5. MCP super-functions

Do not add all systems-audit tools as top-level MCP tools in the first release. Start with a narrow MCP surface:

- `gn_audit_logic({ path, category })`
- `gn_trace_boundary({ resource, start, end?, kind? })`

These two tools prove the report envelope, response limits, stale-state behavior, and sidecar read path. After that, add specialized tools only when they have their own tested report contract.

Candidate later tools:

- `gn_extract_fsm({ target })` (Finite State Machine Extraction)
  - Maps assignments to state variables as transitions and conditionals as guards.
  - Emits a transition matrix, missing-guard warnings, and unreachable states using bounded intra-procedural symbolic execution.

- `gn_taint_trace({ source, sink, sanitizers? })` (Source-to-Sink Taint Analysis)
  - Performs bounded heuristic data-flow tracing from untrusted sources (e.g., `recv`) to dangerous sinks (e.g., `system`).
  - Identifies `TAINTS` and `SANITIZES` edges, marking unresolved hops (e.g., library calls) explicitly.

- `gn_concurrency_audit({ symbol?, path? })`
  - Finds mutexes, lock scopes, blocking calls under lock, nested locks, and lock-order inversions.

- `gn_abi_diff({ source_struct, target_interface })` (Cross-Language ABI Checker)
  - Compares serialization contracts (e.g., C++ `struct` vs. TypeScript `interface`).
  - Flags field width, nullability, precision (e.g., `uint64_t` to JS `number`), and field-order mismatches in IPC/WASM boundaries.

- `gn_error_topology({ path?, symbol? })` (Error Sink Mapping)
  - Traces error origins (errno, exceptions) to logging, user-visible errors, or "Black Hole" swallowed states.

- `gn_simulate_fault({ target, return_value, trigger_path })` (Semantic Fault Injection)
  - Performs constrained symbolic branch replay for one injected return value (e.g., `NULL` from `malloc`).
  - Identifies unhandled error paths and cleanup bypasses without executing code.

- `gn_pressure_impact({ symbol })` (Systems Pressure Analysis)
  - Extends impact analysis with `Quota` nodes such as active process count, worker quota, or global pool capacity.
  - Reports a `pressureDelta` if a changed symbol interacts with a shared system limit.

- `gn_extract_morphology({ target })` (Symbol Morphology Analyzer)
  - Calculates structural anomalies like "Malignant" invasive call graphs (calling into >80% of distinct service cores) or abnormal nested complexity.
  - Flags structurally degenerate code that cannot be easily isolated or refactored.

- `gn_pathology_search({ query })` (Pathological Call Graph Discovery)
  - A specialized graph query that identifies "Invasive" symbols that bridge boundaries they structurally shouldn't, similar to metastasis.

All systems-audit MCP responses must include:

```text
version
tool
status
primaryGraphFacts[]
systemsEvidence[]
findings[]
limits
freshness
skipReasons[]
warnings[]
nextTools[]
```

### 6. Freshness latching

Add MCP dirty-state latching before shipping systems-audit results by default.

The MCP server should consume a lightweight mtime/hash manifest and Git status checks. Broad recursive file watching is not part of the first implementation. When the manifest or Git status indicates changes after the indexed snapshot, MCP marks the current graph state as `DIRTY`. Read tools may still return partial results, but responses must include:

```text
freshness:
  graphState: clean | dirty | stale | partial
  warning: STALE_WARNING | PARTIAL_GRAPH_WARNING
  indexedCommit
  workingTreeDirty
  changedSinceIndex[]
  recommendedAction: gn_ensure_fresh({ autoAnalyze: false }) or explicit sync
```

The watcher must not auto-run broad analyze work. Users or agents must explicitly request sync or analyze.

### 7. Implementation sequence

1. Add dirty-state response metadata using manifest/Git checks, not broad watchers.
2. Add systems-audit sidecar record types and storage.
3. Add C/C++ POSIX resource fact extraction for allocation, duplication, close, fork, exec, and CLOEXEC state.
4. Add `gn_audit_logic` with deterministic C/C++ rules and suppression keys.
5. Add FD lifecycle extraction and `gn_trace_boundary` for `SCM_RIGHTS` and `pidfd_getfd`.
6. Add `AuditMetricLayer` schema support for external JSON-based metric overlays.
7. Measure false-positive rate and response size before graph promotion.
7. Add `gn_extract_fsm` and `gn_error_topology`.
8. Add `gn_concurrency_audit`.
9. Add `gn_pressure_impact` after `Constraint` sidecar semantics are stable.
10. Add `gn_taint_trace`, `gn_abi_diff`, and `gn_simulate_fault` behind explicit experimental flags.

### 8. Validation protocol

Each analyzer must ship with focused fixtures:

- `SCM_RIGHTS` FD send/receive across parent and child.
- `pidfd_getfd` duplication.
- `stat` then `open` TOCTOU.
- child-after-fork unsafe call before exec.
- missing `O_CLOEXEC`.
- fork without wait or pidfd ownership.
- signal mask inherited into child.
- enum state missing a guard.
- tainted string reaching a sink without sanitizer.
- mutex scope with blocking operation.
- `uint64_t` serialized into TypeScript `number`.
- swallowed errno or `catch (...)`.
- injected syscall failure changing control flow.
- quota increment affecting global pressure.

Validation must include:

- unit tests for extractor facts
- integration tests for MCP report shape
- stale sidecar and dirty graph tests
- truncation tests
- false-positive suppression tests
- response-size limit tests
- schema migration tests before graph promotion
- unknown-label and unknown-edge consumer fallback tests

## Consequences

### Positive

- OntoIndex becomes useful for systems-level audits where risk flows through resources, not only through function calls.
- Agents can ask for concrete lifecycle, state, taint, lock, ABI, and error evidence instead of spending context on manual tracing.
- The sidecar-first design preserves main index performance and avoids silently treating experimental facts as graph truth.
- The MCP super-functions provide bounded, purpose-specific reports for audit workflows.

### Negative

- This introduces a new analyzer family with substantial test and fixture maintenance cost.
- Cross-process resource identity is inherently approximate in some C/C++ patterns, so every report needs confidence and unresolved-state metadata.
- Promoting too many advisory findings into primary graph edges would make `impact` noisy.
- Dirty-state latching adds operational complexity to long-running MCP sessions.
- The first release intentionally covers fewer tools than the vision, which delays some user-facing workflows but prevents premature schema commitments.

### Guardrails

- No analyzer may auto-fix code.
- No analyzer may auto-run broad indexing from MCP.
- No analyzer may claim safety-critical certainty without source evidence and freshness metadata.
- No systems-audit evidence may change impact risk scoring until a separate safety policy ADR accepts that behavior.
- Experimental tools must remain explicit and bounded until false-positive rates are measured.
- No primary graph schema addition may ship until sidecar-only facts have a measured precision baseline and compatibility tests.
