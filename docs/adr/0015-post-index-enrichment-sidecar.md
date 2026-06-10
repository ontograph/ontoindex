# ADR 0015: Post-Index Enrichment Sidecar

Status: Postponed

## Context

Large repositories need deeper semantic analysis than the default Tree-sitter hot path should perform. Type-aware resolution, security/dataflow invariants, LSP lookups, and other precision analyzers can be useful, but they are too heavy or too variable to block the main `analyze` command.

Running those analyzers after the main index finishes is attractive, but it creates a correctness risk if background work silently mutates the primary graph. Query, context, and impact results must not become confidently wrong because a sidecar is partial, stale, racing a new analyze run, or failed on a subset of files.

## Decision

Use a background sidecar only as a post-index enrichment system.

The sidecar must not directly mutate the trusted primary graph as if its facts were first-class analyze output. It writes versioned enrichment records keyed to a specific primary index snapshot. Read paths may use enrichment only when freshness, completeness, confidence, and policy checks pass, and they must be able to report that enrichment was used.

Main index completion and enrichment completion are separate states:

```text
primary index:
  indexComplete: true
  enrichmentComplete: false
```

## Algorithm/Technique

1. Main `analyze` completes first:
   - Build the broad deterministic graph from Tree-sitter and existing pipeline phases.
   - Persist primary index metadata: repo id, repo root, commit hash, file hashes, graph schema version, and index id.
   - Mark primary index complete independently from enrichment.

2. Sidecar consumes a snapshot manifest:
   - `sourceIndexId`
   - `sourceCommitHash`
   - graph schema version
   - analyzer id and analyzer version
   - file hashes for the bounded work set

3. Sidecar schedules bounded enrichment queues in this order:
   - unresolved call targets
   - public API and exported symbols
   - files changed since the last commit or last analyze
   - high-centrality files
   - files requested by recent queries
   - remaining files, only while budget permits

4. Sidecar work is submitted through a request pool:
   - The pool may accept multiple enrichment requests from analyze completion, query demand, or explicit user action.
   - Requests are deduplicated by `sourceIndexId`, analyzer id, analyzer version, purpose, and `scopeHash`.
   - `scopeHash` is a deterministic hash of sorted file hashes and/or normalized scope selectors; implementations must not compare large raw file-hash sets on every queue operation.
   - Requests are ordered by priority: user-requested scopes, unresolved calls, public APIs, changed files, high-centrality files, recent-query files, then background remainder.
   - Only one sidecar indexing process may execute at a time.
   - Additional requests stay queued, merge into compatible queued work, or are rejected with a stable `queued` / `already-running` status.
   - Starting a second concurrent sidecar process is a correctness bug, even if CPU budget is available.
   - Explicit user-requested work must be persisted until completed, cancelled, superseded, or expired.
   - Opportunistic background remainder may be volatile and can be dropped on restart.
   - Query-triggered requests must be rate-limited and coalesced per repo, session, analyzer, and scope to avoid filling the queue with repeated demand.
   - Fairness rule: after a bounded number of high-priority requests or a bounded time window, the scheduler must run one still-fresh lower-priority batch before accepting more background starvation.

5. Sidecar runs under a strict CPU budget:
   - Use at most 10% of host CPU capacity.
   - Use at most one logical worker.
   - One worker is a concurrency cap, not permission to consume a full core.
   - The sidecar process must self-throttle so aggregate host CPU stays at or below 10%, including on small hosts where one busy worker would exceed 10%.
   - On this 28-logical-CPU development host, the sidecar concurrency budget is one worker and the CPU budget is still capped at 10%.
   - The budget applies in addition to any analyzer-specific throttling, queue limits, or OS-level niceness.
   - If the sidecar cannot stay within this budget, it must pause or stop instead of competing with foreground OntoIndex commands.

6. Sidecar execution is protected by a durable single-flight lock:
   - The lock must be durable: lock file, SQLite/LadybugDB row, or equivalent local persistent record.
   - The lock record must include `ownerId`, `pid`, `startedAt`, `heartbeatAt`, `sourceIndexId`, analyzer id, and lease expiry.
   - A runner must refresh heartbeat while active.
   - A new runner may take over only when the prior process is gone or the lease is expired and the heartbeat is stale.
   - Stale-lock recovery must be explicit and logged.
   - An in-memory boolean is insufficient because it cannot survive process crashes or multiple CLI/MCP processes.

7. Sidecar writes to a separate enrichment store:

```text
enrichment record:
  sourceIndexId
  sourceCommitHash
  analyzerId
  analyzerVersion
  filePath
  fileHash
  status: queued | running | complete | partial | failed | cancelled | stale | superseded
  confidence?: number  # 0..1, analyzer-calibrated; omit if no calibration exists
  records[]
  failureReason?
```

8. Query/context/impact read paths treat enrichment as optional:
   - Primary graph facts are always available when the index is complete.
   - Enrichment is considered only if `sourceIndexId`, commit hash, schema version, and file hashes still match.
   - Partial enrichment must be visible in output metadata.
   - Low-confidence or stale enrichment must not affect safety-critical impact decisions unless explicitly requested.

9. New analyze invalidates enrichment:
   - If the index id or commit hash changes, old enrichment is stale by default.
   - File-level enrichment may be reused only when file hash and analyzer version still match.
   - Queued requests for an older index become `superseded` unless their scope can be proven hash-compatible with the new index.

## Consequences

Benefits:

- Main indexing remains fast, deterministic, and locally reliable.
- Heavy analyzers can run asynchronously without blocking CLI/MCP/query workflows.
- Failed or partial deep analysis does not corrupt the primary graph.
- Query and impact can explain when optional enrichment contributed to a result.

Costs:

- Requires a second metadata/read path for enrichment status.
- Query/context/impact code must handle primary facts and enrichment facts separately.
- Users may see primary index complete while enrichment is still partial.

Hard guardrails:

- Sidecar must be killable without corrupting primary index state.
- Sidecar CPU use must stay at or below 10% of host capacity and at or below one logical worker.
- Sidecar indexing must be single-flight: one executing sidecar process at a time, with additional work held in the request pool.
- Single-flight must be enforced by a durable lock with heartbeat and stale-lock recovery.
- Explicit user-requested enrichment must survive restart until completed, cancelled, superseded, or expired.
- Query-triggered sidecar requests must be rate-limited and coalesced.
- Queue scheduling must include starvation protection for lower-priority batches.
- Sidecar writes must be idempotent.
- Enrichment must be keyed by index id, file hash, analyzer id, and analyzer version.
- Query/impact must never hide partial or stale enrichment state.
- Heavy engines remain opt-in: TypeScript Compiler API, LSP, CodeQL, Joern, daemon analyzers, and external analyzer processes.

## Status

This ADR is partially accepted in production code. The implemented substrate is:

- Analyzer budget and timing contracts.
- Scoped precision policy.
- Optional precision phase slot with default behavior unchanged.
- Sidecar request-pool contract with deterministic dedupe, priority ordering, query coalescing/rate limiting, and fairness selection.
- Durable single-flight lock contract with heartbeat, lease expiry, owner-checked release, and stale-lock takeover decisions.
- Sidecar CPU throttle contract with one-worker concurrency and 10% aggregate host CPU decisions.
- Enrichment record contract with freshness and new-analyze invalidation decisions.
- Local sidecar store contract for versioned queue, lock, and enrichment persistence.
- Sidecar lifecycle decision contract for selected work, single-flight locks, and throttle outcomes.
- Enrichment read-policy contract for freshness, confidence, partial-state visibility, and safety-critical opt-in.
- Store update lock for cross-process read-modify-write safety.
- Sidecar runner scaffold with injected execution, heartbeat, status updates, and owner-checked lock release.
- Local runner callback adapter backed by the serialized store update API.
- Passive query/context/impact enrichment metadata that reports sidecar state without changing primary facts.
- Concrete injected analyzer adapter contract with deterministic local execution and per-file enrichment records.
- Opt-in enrichment fact consumption helper that keeps default reads metadata-only.
- Opt-in query/context/impact command wiring for enrichment facts under metadata only.
- Injectable sidecar process launcher with `nice`/optional `cpulimit` command construction and launch-time budget rejection.
- Production heavy analyzer selection: Axel codebase.
- Markdown document sidecar request type, queue decision, and runner executor.
- Opt-in `analyze --markdown-sidecar` request submission after the primary index completes.
- Explicit Markdown query opt-ins: `include_markdown_context` and bounded document-only `include_markdown_ppr`.

The remaining proposed part is operational execution: normal users can queue Markdown sidecar
work and the code has runner helpers, but there is not yet a documented CLI/MCP/daemon workflow
that drains queued Markdown sidecar requests after `analyze --markdown-sidecar`.

Implementation should proceed next by wiring queued sidecar execution as an explicit operator
workflow before adding another analyzer. Axel remains the selected heavy analyzer for architecture
enrichment, but the first gap to close is the generic execution path for queued sidecar work.

## Codebase Conformance Snapshot

As of 2026-05-14, the codebase matches the ADR on these points:

- Primary `analyze` remains deterministic and default-off for sidecar work.
- Sidecar requests are deduplicated, prioritized, persisted, and protected by durable lock/heartbeat
  contracts.
- Sidecar store writes are separate from the primary graph and use versioned enrichment records.
- Read paths expose enrichment only under explicit opt-ins and preserve primary query/context/impact
  behavior by default.
- Markdown document facts are passive evidence; they do not become code graph authority.
- `analyze --markdown-sidecar` queues a persistent Markdown request only. It does not execute the
  Markdown sidecar runner and does not guarantee queryable Markdown facts immediately.
- Markdown PPR is bounded to document evidence nodes and exposed only when
  `consume_enrichment_facts`, `include_passive_related_facts`, `include_markdown_context`, and
  `include_markdown_ppr` are all true.

Known gaps:

- No public command or daemon workflow currently drains queued Markdown sidecar requests in normal
  operation.
- Axel command, argument contract, output schema, timeout policy, and launcher integration remain
  unresolved.
- User-facing status should distinguish primary index completion, queued enrichment, running
  enrichment, partial enrichment, and query-visible enrichment.
- Documentation should avoid saying Markdown is "indexed" after `analyze --markdown-sidecar`; it is
  queued until a runner executes the request.

## Implementation Progress

### Cycle 1: Request Pool And Single-Flight Lock Contracts

Status: accepted after focused validation.

Dispatched slices:

- Worker G: sidecar request-pool contract and unit tests.
- Worker H: durable single-flight lock contract and unit tests.
- Manager: reviewed for ADR conformance and ran focused validation.

Accepted files:

- `ontoindex/src/core/ingestion/enrichment/sidecar-request-pool.ts`
- `ontoindex/src/core/ingestion/enrichment/sidecar-lock.ts`
- `ontoindex/src/core/ingestion/enrichment/index.ts`
- `ontoindex/test/unit/sidecar-request-pool.test.ts`
- `ontoindex/test/unit/sidecar-lock.test.ts`

Validation:

```bash
cd ontoindex
ONTOINDEX_MAX_WORKERS=7 npx vitest run test/unit/sidecar-request-pool.test.ts test/unit/sidecar-lock.test.ts --reporter=dot
ONTOINDEX_MAX_WORKERS=7 npx tsc --noEmit --pretty false
```

Result:

- Focused tests passed: 2 files, 15 tests.
- Typecheck passed.

Deferred:

- Persistent queue storage adapter.
- Real process spawning.
- Real CPU self-throttle wiring.
- Enrichment record persistence and read-path completeness.

### Cycle 2: Throttle And Enrichment Record Contracts

Status: accepted after manager self-review and focused validation.

Dispatched slices:

- Worker I: sidecar CPU throttle decision contract and unit tests.
- Worker J: enrichment record, freshness, and invalidation contract and unit tests.
- Manager: added runtime enum validation for persisted request and enrichment inputs, then ran focused validation.

Accepted files:

- `ontoindex/src/core/ingestion/enrichment/sidecar-throttle.ts`
- `ontoindex/src/core/ingestion/enrichment/enrichment-record.ts`
- `ontoindex/src/core/ingestion/enrichment/index.ts`
- `ontoindex/test/unit/sidecar-throttle.test.ts`
- `ontoindex/test/unit/enrichment-record.test.ts`
- updated request-pool tests for persisted enum validation.

Validation:

```bash
cd ontoindex
ONTOINDEX_MAX_WORKERS=7 npx vitest run test/unit/sidecar-request-pool.test.ts test/unit/sidecar-lock.test.ts test/unit/sidecar-throttle.test.ts test/unit/enrichment-record.test.ts --reporter=dot
ONTOINDEX_MAX_WORKERS=7 npx tsc --noEmit --pretty false
```

Result:

- Focused tests passed: 4 files, 34 tests.
- Typecheck passed.

Deferred:

- Storage adapter for queue, lock, and enrichment records.
- Sidecar process lifecycle and OS-level throttling.
- Query/context/impact read-path integration.

### Cycle 3: Local Sidecar Store Contract

Status: accepted after worker implementation, manager tightening, and focused validation.

Dispatched slices:

- Worker K: local JSON sidecar store and unit tests.
- Worker L: read-only acceptance checklist for storage semantics and ADR traps.
- Manager: added request-pool-backed submission, idempotent enrichment upsert, class adapter methods, formatting, and validation.

Accepted files:

- `ontoindex/src/core/ingestion/enrichment/sidecar-store.ts`
- `ontoindex/src/core/ingestion/enrichment/index.ts`
- `ontoindex/test/unit/sidecar-store.test.ts`

Accepted behavior:

- Missing state file loads as empty versioned state.
- Queue requests, current lock, and enrichment records persist in one schema-versioned JSON file.
- Saves write a same-directory temporary file and then rename it into place.
- Persisted requests and enrichment records are normalized through existing constructors.
- Malformed persisted enum, lock, and enrichment payloads are rejected.
- Request submission uses `SidecarRequestPool`, preserving dedupe and merge semantics after reload.
- Enrichment writes are idempotent by source index, analyzer id/version, and file path.

Validation:

```bash
cd ontoindex
ONTOINDEX_MAX_WORKERS=7 npx vitest run test/unit/sidecar-store.test.ts test/unit/sidecar-request-pool.test.ts test/unit/sidecar-lock.test.ts test/unit/sidecar-throttle.test.ts test/unit/enrichment-record.test.ts --reporter=dot
ONTOINDEX_MAX_WORKERS=7 npx tsc --noEmit --pretty false
```

Result:

- Focused tests passed: 5 files, 43 tests.
- Typecheck passed.

Deferred:

- Cross-process read-modify-write conflict handling beyond atomic file replacement.
- Sidecar process lifecycle and OS-level throttling.
- Query/context/impact read-path integration.

### Cycle 4: Lifecycle And Read-Policy Contracts

Status: accepted after two worker slices, manager review, one lifecycle correction, and focused validation.

Dispatched slices:

- Worker M: sidecar lifecycle decision contract and unit tests.
- Worker N: enrichment read-policy contract and unit tests.
- Manager: added lock-request mismatch protection so selected work cannot start under a lock for a different index or analyzer.

Accepted files:

- `ontoindex/src/core/ingestion/enrichment/sidecar-lifecycle.ts`
- `ontoindex/src/core/ingestion/enrichment/enrichment-read-policy.ts`
- `ontoindex/src/core/ingestion/enrichment/index.ts`
- `ontoindex/test/unit/sidecar-lifecycle.test.ts`
- `ontoindex/test/unit/enrichment-read-policy.test.ts`

Accepted behavior:

- Lifecycle idles without taking a lock when no queued work is fresh.
- Lifecycle waits when another active owner holds the durable lock.
- Lifecycle explicitly reports stale-lock takeover.
- Lifecycle pauses or stops when throttle decisions require it.
- Lifecycle starts only when selected work, lock request, acquired lock, and throttle all agree.
- Read policy always returns visible enrichment metadata, including status, freshness, confidence, and partial state.
- Stale, failed, low-confidence, and partial records are rejected or accepted according to explicit policy instead of being silently treated as complete facts.
- Safety-critical impact use requires explicit opt-in and complete high-confidence enrichment unless low-confidence use is also explicitly opted in.

Validation:

```bash
cd ontoindex
ONTOINDEX_MAX_WORKERS=7 npx vitest run test/unit/sidecar-lifecycle.test.ts test/unit/enrichment-read-policy.test.ts test/unit/sidecar-store.test.ts test/unit/sidecar-request-pool.test.ts test/unit/sidecar-lock.test.ts test/unit/sidecar-throttle.test.ts test/unit/enrichment-record.test.ts --reporter=dot
ONTOINDEX_MAX_WORKERS=7 npx tsc --noEmit --pretty false
npx prettier --check src/core/ingestion/enrichment/sidecar-lifecycle.ts src/core/ingestion/enrichment/enrichment-read-policy.ts test/unit/sidecar-lifecycle.test.ts test/unit/enrichment-read-policy.test.ts src/core/ingestion/enrichment/index.ts
```

Result:

- Focused tests passed: 7 files, 59 tests.
- Typecheck passed.
- Formatting check passed.

Deferred:

- Concrete process runner and heartbeat loop.
- Cross-process store update conflict handling.
- Query/context/impact command integration.

### Cycle 5: Store Update Lock And Runner Scaffold

Status: accepted after two worker slices, manager review, formatting, and focused validation.

Dispatched slices:

- Worker O: cross-process store update lock and unit tests.
- Worker P: sidecar runner scaffold and unit tests.
- Manager: reviewed runner/store compatibility and reran the combined sidecar suite.

Accepted files:

- `ontoindex/src/core/ingestion/enrichment/sidecar-store.ts`
- `ontoindex/src/core/ingestion/enrichment/sidecar-runner.ts`
- `ontoindex/src/core/ingestion/enrichment/index.ts`
- `ontoindex/test/unit/sidecar-store.test.ts`
- `ontoindex/test/unit/sidecar-runner.test.ts`

Accepted behavior:

- `LocalSidecarStore.update()` serializes read-modify-write with a same-directory exclusive update lock.
- The update lock has bounded retry, stale-lock removal, owner metadata, and cleanup after success or failure.
- Store submit, enrichment upsert, and lock mutation route through the update API.
- Runner execution is injected and executes at most one selected request per call.
- Runner marks request state as running then complete, partial, cancelled, or failed.
- Runner refreshes heartbeat through the owner-held lock and releases only owner-held locks.
- Runner does not execute when idle, lock-denied, paused, stopped, or over the no-real-throttle budget.

Validation:

```bash
cd ontoindex
ONTOINDEX_MAX_WORKERS=7 npx vitest run test/unit/sidecar-runner.test.ts test/unit/sidecar-store.test.ts test/unit/sidecar-lifecycle.test.ts test/unit/enrichment-read-policy.test.ts test/unit/sidecar-request-pool.test.ts test/unit/sidecar-lock.test.ts test/unit/sidecar-throttle.test.ts test/unit/enrichment-record.test.ts --reporter=dot
ONTOINDEX_MAX_WORKERS=7 npx tsc --noEmit --pretty false
npx prettier --check src/core/ingestion/enrichment/sidecar-store.ts src/core/ingestion/enrichment/sidecar-runner.ts test/unit/sidecar-store.test.ts test/unit/sidecar-runner.test.ts src/core/ingestion/enrichment/index.ts
```

Result:

- Focused tests passed: 8 files, 70 tests.
- Typecheck passed.
- Formatting check passed.

Deferred:

- Real process launch or OS-level throttling.
- Concrete analyzer adapter implementation.
- Query/context/impact command integration.

### Cycle 6: Local Runner Adapter And Passive Read Metadata

Status: accepted after two worker slices, manager path unification, and focused validation.

Dispatched slices:

- Worker Q: passive query/context/impact sidecar metadata.
- Worker R: local runner callback adapter over `LocalSidecarStore`.
- Manager: moved the sidecar store path helper into the enrichment store module so readers and writers share the same location.

Accepted files:

- `ontoindex/src/core/ingestion/enrichment/sidecar-store.ts`
- `ontoindex/src/core/ingestion/enrichment/sidecar-runner.ts`
- `ontoindex/src/mcp/local/local-backend.ts`
- `ontoindex/test/unit/sidecar-runner.test.ts`
- `ontoindex/test/unit/sidecar-local-backend-enrichment.test.ts`

Accepted behavior:

- `getSidecarStorePath(storagePath)` defines the shared local sidecar state path.
- `createLocalSidecarRunnerCallbacks()` adapts `LocalSidecarStore` to `runSidecarRunnerOnce()` and uses serialized `update()` mutations.
- Query, context, and impact object responses include top-level enrichment metadata when called through `LocalBackend`.
- Read-path metadata includes `used: false`, record status counts, queued/running request counts, and lock owner/heartbeat.
- Missing or corrupt sidecar stores report unavailable/error metadata without failing the primary read path.
- Enrichment still does not affect ranking, graph traversal, impact risk, symbol relationships, or primary graph facts.

Validation:

```bash
cd ontoindex
ONTOINDEX_MAX_WORKERS=7 npx vitest run test/unit/sidecar-local-backend-enrichment.test.ts test/unit/sidecar-runner.test.ts test/unit/sidecar-store.test.ts test/unit/sidecar-lifecycle.test.ts test/unit/enrichment-read-policy.test.ts test/unit/sidecar-request-pool.test.ts test/unit/sidecar-lock.test.ts test/unit/sidecar-throttle.test.ts test/unit/enrichment-record.test.ts --reporter=dot
ONTOINDEX_MAX_WORKERS=7 npx tsc --noEmit --pretty false
npx prettier --check src/core/ingestion/enrichment/sidecar-store.ts src/core/ingestion/enrichment/sidecar-runner.ts src/mcp/local/local-backend.ts test/unit/sidecar-runner.test.ts test/unit/sidecar-local-backend-enrichment.test.ts
```

Result:

- Focused tests passed: 9 files, 77 tests.
- Typecheck passed.
- Formatting check passed.

Deferred:

- Real process launch or OS-level throttling.
- Concrete analyzer adapter implementation.
- Opt-in enrichment fact consumption in query/context/impact.

### Cycle 7: Analyzer Adapter And Opt-In Fact Consumption

Status: accepted after two worker slices, manager review, formatting, and focused validation.

Dispatched slices:

- Worker S: concrete injected sidecar analyzer adapter and unit tests.
- Worker T: opt-in enrichment fact consumption helper and unit tests.
- Manager: reviewed both modules together, preserved pure/no-default-consumption boundaries, and ran the combined sidecar suite.

Accepted files:

- `ontoindex/src/core/ingestion/enrichment/sidecar-analyzer-adapter.ts`
- `ontoindex/src/core/ingestion/enrichment/enrichment-fact-consumption.ts`
- `ontoindex/src/core/ingestion/enrichment/index.ts`
- `ontoindex/test/unit/sidecar-analyzer-adapter.test.ts`
- `ontoindex/test/unit/enrichment-fact-consumption.test.ts`

Accepted behavior:

- Analyzer adapter enforces analyzer id/version, source index id, commit hash, schema version, file path, and file hash bindings.
- Analyzer adapter converts deterministic local analyzer callbacks into per-file enrichment records.
- Analyzer exceptions and explicit file failures become failed records with failure reasons.
- Runner-compatible analyzer executor upserts produced enrichment records and reports partial execution when any file is partial or failed.
- Fact consumption requires explicit `consumeFacts: true`; default behavior returns visible metadata with no facts used.
- Fact consumption reuses freshness, confidence, partial, and safety-critical policy decisions.
- Rejected records carry reasons and remain visible for stale, failed, low-confidence, partial, or non-opt-in cases.

Validation:

```bash
cd ontoindex
ONTOINDEX_MAX_WORKERS=7 npx vitest run test/unit/sidecar-analyzer-adapter.test.ts test/unit/enrichment-fact-consumption.test.ts test/unit/sidecar-runner.test.ts test/unit/sidecar-store.test.ts test/unit/sidecar-lifecycle.test.ts test/unit/enrichment-read-policy.test.ts test/unit/sidecar-request-pool.test.ts test/unit/sidecar-lock.test.ts test/unit/sidecar-throttle.test.ts test/unit/enrichment-record.test.ts --reporter=dot
ONTOINDEX_MAX_WORKERS=7 npx tsc --noEmit --pretty false
npx prettier --check src/core/ingestion/enrichment/sidecar-analyzer-adapter.ts src/core/ingestion/enrichment/enrichment-fact-consumption.ts test/unit/sidecar-analyzer-adapter.test.ts test/unit/enrichment-fact-consumption.test.ts src/core/ingestion/enrichment/index.ts
```

Result:

- Focused tests passed: 10 files, 88 tests.
- Typecheck passed.
- Formatting check passed.

Deferred:

- Real process launch or OS-level throttling.
- Concrete command wiring that opts query/context/impact into fact consumption.

### Cycle 8: Command Opt-In Wiring And Process Launcher

Status: accepted after two worker slices, manager review, and expanded focused validation.

Dispatched slices:

- Worker U: opt-in query/context/impact enrichment fact consumption under top-level metadata.
- Worker V: injectable sidecar process launcher and OS-throttle command construction.
- Manager: reviewed LocalBackend blast radius, verified metadata-only default behavior, and ran focused LocalBackend dispatch/security tests.

Accepted files:

- `ontoindex/src/mcp/local/local-backend.ts`
- `ontoindex/src/mcp/local/tool-params.ts`
- `ontoindex/src/mcp/tools.ts`
- `ontoindex/src/core/ingestion/enrichment/sidecar-process-launcher.ts`
- `ontoindex/src/core/ingestion/enrichment/index.ts`
- `ontoindex/test/unit/sidecar-local-backend-enrichment.test.ts`
- `ontoindex/test/unit/sidecar-process-launcher.test.ts`

Accepted behavior:

- Query, context, and impact default to metadata-only sidecar reporting.
- `consume_enrichment_facts` explicitly opts command responses into returning enrichment facts under `enrichment.facts`.
- Query/context allow low-confidence facts only with `allow_low_confidence`.
- Impact uses safety-critical policy and requires `allow_safety_critical_enrichment` before consuming enrichment facts.
- Primary result fields, ranking, graph traversal, and impact risk remain unchanged.
- Process launcher rejects worker counts above one and CPU budgets above 10%.
- Process launcher builds POSIX commands with `nice -n 19` and optional caller-provided `cpulimit`.
- Process launching is injectable and tests do not spawn real processes.

Validation:

```bash
cd ontoindex
ONTOINDEX_MAX_WORKERS=7 npx vitest run test/unit/sidecar-local-backend-enrichment.test.ts test/unit/sidecar-process-launcher.test.ts test/unit/calltool-dispatch.test.ts test/unit/write-verb-gating.test.ts test/unit/mcp-security-matrix.test.ts --reporter=dot
ONTOINDEX_MAX_WORKERS=7 npx vitest run test/unit/sidecar-analyzer-adapter.test.ts test/unit/enrichment-fact-consumption.test.ts test/unit/sidecar-runner.test.ts test/unit/sidecar-store.test.ts test/unit/sidecar-lifecycle.test.ts test/unit/enrichment-read-policy.test.ts test/unit/sidecar-request-pool.test.ts test/unit/sidecar-lock.test.ts test/unit/sidecar-throttle.test.ts test/unit/enrichment-record.test.ts --reporter=dot
ONTOINDEX_MAX_WORKERS=7 npx tsc --noEmit --pretty false
npx prettier --check src/core/ingestion/enrichment/sidecar-process-launcher.ts test/unit/sidecar-process-launcher.test.ts src/mcp/local/local-backend.ts src/mcp/local/tool-params.ts src/mcp/tools.ts test/unit/sidecar-local-backend-enrichment.test.ts src/core/ingestion/enrichment/index.ts
```

Result:

- LocalBackend-focused tests passed: 5 files, 92 tests.
- Sidecar-focused tests passed: 10 files, 88 tests.
- Typecheck passed.
- Formatting check passed.

Resolved:

- Production heavy analyzer selection: Axel codebase.

Deferred:

- Exact Axel CLI/MCP command, argument contract, output schema, and timeout policy that should be launched by the sidecar process launcher.
