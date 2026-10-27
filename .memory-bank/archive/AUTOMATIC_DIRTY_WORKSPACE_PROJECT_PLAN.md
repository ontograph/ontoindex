# Automatic Dirty Workspace Implementation Plan

Date: 2026-10-17
Status: Closed — all 34 tasks accepted
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

## Reviewed contracts and prior evidence

[Review and packet contracts](../recovery/20261020-direct-unblock/ADW_REVIEW_AND_PACKET_HISTORY.md)
preserve the exact solution comparisons, packet seams, prior failures and historical
measurements. The completed design gate below and the ADR remain implementation
authority. Current routing uses direct-session acceptance under the recovery decision;
original-parent receipt gates are superseded. Current source requires fresh full-suite
and performance qualification before default activation. No publication is authorized.

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
  status: closed
  selection_policy: active_next_task-first
  active_next_task: null
  max_in_flight: 1
  dispatch_mode: none
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
    status: DONE
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
    closeout:
      role_results:
        coder-auditor: null
        coder-manager: null
      main_session_evidence:
        authorized_by: user
        authorization_ref: Explicit user instruction to break ceremony and unblock tasks; recovery/20261020-direct-unblock/DECISION.md preserves original dispatch history.
        validation_summary: Fresh serial workspace-input-capture, analyze-lock and analysis-coordinator suites pass112 tests in3 files, exit0 in7.11s. Independent source review supports content and configuration identity, rename/delete, symlink rejection, two attempts and owned cleanup. New direct acceptance does not authenticate the missing historical receipt.
    dod_status: pass
  ADW-2a:
    title: Run the pipeline entirely against captured inputs
    status: DONE
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
    closeout:
      role_results:
        coder-worker: null
        coder-worker-test-challenger: null
      main_session_evidence:
        authorized_by: user
        authorization_ref: Direct recovery decision and proceed all open tasks.
        validation_summary: Real full-profile captured parser/resolver fixture passes after live source and tsconfig alias mutations; captured symbol/import edge retained, live symbol excluded, canonical identity/relative paths verified. Serial3-file57-test run exit0 in7.57s; diff check0. Existing pipeline routing needs no change.
    dod_status: pass
  ADW-2b:
    title: Publish content-bound symbol generations without changing the committed index
    status: DONE
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
    closeout:
      role_results:
        coder-worker: null
        coder-worker-test-challenger: null
      main_session_evidence:
        authorized_by: user
        authorization_ref: Proceed all open tasks and direct recovery decision.
        validation_summary: Source run-analyze captured manifest/config/parser/base metadata and atomic CURRENT publication reviewed; successful build and injected failure preserve committed metadata/registry and prior generation. Serial5-file302-test run exit0 in20.62s includes dirty-overlay-build; diff check0.
    dod_status: pass
  ADW-2c:
    title: Require manifest identity when reusing a workspace generation
    status: DONE
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
    closeout:
      role_results:
        coder-worker: null
        coder-worker-test-challenger: null
      main_session_evidence:
        authorized_by: user
        authorization_ref: Proceed all open tasks and direct recovery decision.
        validation_summary: Removed stat-only reuse authority and200 touched-file cutoff. Full serial inventory hashes reject preserved-metadata changed bytes, unchanged touched201inputs reuse. Backend-overlay focused suites pass in302-test and292-test batches exit0; later shared pin changes also validated. Warm performance qualification remains downstream.
    dod_status: pass
  ADW-3:
    title: Coalesce repository preparation with one pending successor
    status: DONE
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
    closeout:
      role_results:
        coder-worker: null
        coder-worker-test-challenger: null
      main_session_evidence:
        authorized_by: user
        authorization_ref: Proceed all open tasks and direct recovery decision.
        validation_summary: Source workspaceBuild coalesces identical requests and stores one latest pending successor; lock recheck adopts another writer result. Runtime focused suites pass in302-test batch exit0 in20.62s, including concurrency and latest successor tests.
    dod_status: pass
  ADW-3a:
    title: Provide automatic refresh callbacks, retry same-HEAD failures and await owned stop
    status: DONE
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
    closeout:
      role_results:
        coder-worker: null
        coder-worker-test-challenger: null
      main_session_evidence:
        authorized_by: user
        authorization_ref: Proceed all open tasks and direct recovery decision.
        validation_summary: Existing watch callback branch bypasses analyze spawn, token leases and awaited stop preserved; bounded same-HEAD retries and reset tested. Serial5-file302-test run includes watch-command exit0 in20.62s.
    dod_status: pass
  ADW-3b:
    title: Bound each waiter without cancelling preparation needed by another
    status: DONE
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
    closeout:
      role_results:
        coder-worker: null
        coder-worker-test-challenger: null
      main_session_evidence:
        authorized_by: user
        authorization_ref: Proceed all open tasks and direct recovery decision.
        validation_summary: Caller deadline60000ms includes initial probe/queue/build; owner build lifetime separate120000ms. Both search/relationship required-preparation failures reject; short waiter timeout/cancellation does not cancel shared build. Runtime focused302-test batch exit0 in20.62s.
    dod_status: pass
  ADW-4:
    title: Build isolated complete workspace graphs from the same captured tree
    status: DONE
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
    closeout:
      role_results:
        coder-worker: null
        coder-worker-test-challenger: null
      main_session_evidence:
        authorized_by: user
        authorization_ref: Proceed all open tasks and direct recovery decision.
        validation_summary: Real isolated captured graph nodes/edges equal independent full analysis same bytes, including clean caller/changed/deleted callee, parse errors and failure rollback. Workspace-graph-snapshot integration in4-file136-test batch exit0 in8.57s; committed identity preserved.
    dod_status: pass
  ADW-4a:
    title: Escalate insufficient overlays instead of returning partial relationship success
    status: DONE
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
    closeout:
      role_results:
        coder-worker: null
        coder-worker-test-challenger: null
      main_session_evidence:
        authorized_by: user
        authorization_ref: Proceed all open tasks and direct recovery decision.
        validation_summary: Source selectWorkspaceCapability and backend-overlay tests exercise0/1/50/51/config escalation, uncovered paths, degraded/partial parse authority. Backend-overlay suite in292-test6-file batch exit0 in4.86s; graph parity integration136-test batch exit0.
    dod_status: pass
  ADW-5:
    title: Pin an exact database generation for the complete request
    status: DONE
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
    closeout:
      role_results:
        coder-worker: null
        coder-worker-test-challenger: null
      main_session_evidence:
        authorized_by: user
        authorization_ref: Proceed all open tasks; direct recovery decision.
        validation_summary: Native generation-swap fixture discriminates A/B sentinels through both query APIs; request retains A across publication, releases on failure/final reader, and pruning preserves live overlay pins. Fresh serial five-file133-test batch including eight native pin tests exits0 in3.30s; git diff --check exits0. Current admission corrections are separate downstream work.
    dod_status: pass
  ADW-5a:
    title: Gate backend reads once and pass one request context through completion
    status: DONE
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
    closeout:
      role_results:
        coder-worker: null
        coder-worker-test-challenger: null
      main_session_evidence:
        authorized_by: user
        authorization_ref: Proceed all open tasks; direct recovery decision.
        validation_summary: Prepared callback reuses one pinned context; deadline and signal include watcher acquisition; cancelled waiter cannot invoke handler or cancel survivor. Dispatch/runtime/retention and related suites pass286 tests in7 files exit0 in10.47s; complete SDK mutation and clean HEAD drift sequence passes. Diff check0.
    dod_status: pass
  ADW-5b:
    title: Resolve symbol identities from the pinned snapshot
    status: DONE
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
    closeout:
      role_results:
        coder-worker: null
        coder-worker-test-challenger: null
      main_session_evidence:
        authorized_by: user
        authorization_ref: Proceed all open tasks; direct recovery decision.
        validation_summary: Automatic full snapshot skips committed-pool symbol lookup; captured definitions resolve added/renamed IDs and exclude deleted IDs. Overlay symbol tests in286-test7-file run exit0; real SDK symbol and mutation sequence passes. Diff check0.
    dod_status: pass
  ADW-5c:
    title: Key semantic cache entries by snapshot and capability
    status: DONE
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
    - ontoindex/src/mcp/local/backend-search.ts
    - ontoindex/test/unit/overlay-query-merge.test.ts
    allowed_write_set:
    - ontoindex/src/core/search/semantic-cache.ts
    - ontoindex/test/unit/core/semantic-cache.test.ts
    - ontoindex/src/mcp/local/backend-search.ts
    - ontoindex/test/unit/overlay-query-merge.test.ts
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
    closeout:
      role_results:
        coder-worker: null
        coder-worker-test-challenger: null
      main_session_evidence:
        authorized_by: user
        authorization_ref: Proceed all open tasks; direct recovery decision.
        validation_summary: Existing bounded semantic cache is reused; search keys and lookup/set include generation/capability/coverage. Simple structured A/A hits and A/B misses; enriched results bypass unsafe candidate cache. Semantic-cache and overlay-query tests in286-test7-file run exit0. Diff check0.
    dod_status: pass
  ADW-5d:
    title: Search merges fresh lexical candidates and rejects stale fallback
    status: DONE
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
    closeout:
      role_results:
        coder-worker: null
        coder-worker-test-challenger: null
      main_session_evidence:
        authorized_by: user
        authorization_ref: Proceed all open tasks; direct recovery decision.
        validation_summary: Pinned lexical query generation and cache identity preserve current candidates; automatic snapshot/query failures reject. First dirty SDK search builds before context, mutation/deletion and full-analysis parity sequence passes. Focused overlay-query tests in286-test7-file run exit0. Diff check0.
    dod_status: pass
  ADW-5e:
    title: Context and impact use pinned relationships and captured source
    status: DONE
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
    closeout:
      role_results:
        coder-worker: null
        coder-worker-test-challenger: null
      main_session_evidence:
        authorized_by: user
        authorization_ref: Proceed all open tasks; direct recovery decision.
        validation_summary: Context/impact use admitted relationships and captured source; unusable automatic snapshots reject; live-source fallback skipped and partial parse authority retained. Overlay-context-impact tests in286-test7-file run exit0; SDK added-caller/deleted-edge parity passes. Diff check0.
    dod_status: pass
  ADW-5f:
    title: Gate lazy MCP tools through the same preparation owner
    status: DONE
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
    closeout:
      role_results:
        coder-worker: null
        coder-worker-test-challenger: null
      main_session_evidence:
        authorized_by: user
        authorization_ref: Proceed all open tasks; direct recovery decision.
        validation_summary: Lazy graph reads use callback preparation and both pinned aliases; diagnostics bypass and stored response replay precedes preparation. Server tests plus SDK routes in306-test13-file batch exit0 in33.58s; diff0.
    dod_status: pass
  ADW-5g:
    title: Apply snapshot readiness to graph resources
    status: DONE
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
    closeout:
      role_results:
        coder-worker: null
        coder-worker-test-challenger: null
      main_session_evidence:
        authorized_by: user
        authorization_ref: Proceed all open tasks; direct recovery decision.
        validation_summary: Graph resource data executes within prepared callback; explicit diagnostics retain notices. Resources/server and native SDK tests in306-test13-file batch exit0; diff0.
    dod_status: pass
  ADW-5h:
    title: Preserve immutable response replay and bind logical page cursors
    status: DONE
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
    - ontoindex/src/mcp/super/graph-walk.ts
    - ontoindex/test/unit/super/graph-walk.test.ts
    - ontoindex/test/unit/response-limits.test.ts
    allowed_write_set:
    - ontoindex/src/mcp/shared/response-pages.ts
    - ontoindex/src/mcp/shared/response-limits.ts
    - ontoindex/test/unit/response-pages.test.ts
    - ontoindex/src/mcp/super/graph-walk.ts
    - ontoindex/test/unit/super/graph-walk.test.ts
    - ontoindex/test/unit/response-limits.test.ts
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
    closeout:
      role_results:
        coder-worker: null
        coder-worker-test-challenger: null
      main_session_evidence:
        authorized_by: user
        authorization_ref: Proceed all open tasks; direct recovery decision.
        validation_summary: Immutable response replay preserves bytes and bindings; logical mismatch/legacy bindings return typed restart_required. Graph walk private generation binding checks queued steps before mutation. Cursor/page/walk/docs batch118 tests6files exit0 in6.57s; SDK docs/cancellation batch306 tests13files exit0; diff0.
    dod_status: pass
  ADW-5i:
    title: Keep docs pagination on one captured collection
    status: DONE
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
    closeout:
      role_results:
        coder-worker: null
        coder-worker-test-challenger: null
      main_session_evidence:
        authorized_by: user
        authorization_ref: Proceed all open tasks; direct recovery decision.
        validation_summary: Docs collection cursor binds admitted generation without CURRENT probe; changed generation/input returns restart_required. Docs unit/cursor and real SDK batches118 and306 tests exit0; legacy fields retained. Diff0.
    dod_status: pass
  ADW-6:
    title: Acquire and release one owned watcher per repository lifecycle
    status: DONE
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
    - ontoindex/src/cli/mcp.ts
    - ontoindex/test/unit/local-backend-state-retention.test.ts
    allowed_write_set:
    - ontoindex/src/mcp/local/local-backend-repo-runtime.ts
    - ontoindex/src/mcp/local/local-backend.ts
    - ontoindex/test/unit/local-backend-repo-runtime.test.ts
    - ontoindex/src/cli/mcp.ts
    - ontoindex/test/unit/local-backend-state-retention.test.ts
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
    closeout:
      role_results:
        coder-worker: null
        coder-worker-test-challenger: null
      main_session_evidence:
        authorized_by: user
        authorization_ref: Proceed all open tasks; direct recovery decision.
        validation_summary: One canonical watcher retains aliases; last release drains every known alias build before watcher stop; rejected cleanup fences reacquisition. Real runtime factory tests and backend shared/cancelled waiter tests in286-test7-file batch exit0; watch token/borrowed/idle behavior tests in306-test batch exit0; diff0.
    dod_status: pass
  ADW-6a:
    title: Drain automatic preparation and watchers during MCP shutdown
    status: DONE
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
    - ontoindex/src/mcp/local/workspace-build-supervisor.ts
    - ontoindex/test/unit/workspace-build-supervisor.test.ts
    allowed_write_set:
    - ontoindex/src/mcp/server.ts
    - ontoindex/test/unit/mcp-server-shutdown.test.ts
    - ontoindex/src/mcp/local/workspace-build-supervisor.ts
    - ontoindex/test/unit/workspace-build-supervisor.test.ts
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
    closeout:
      role_results:
        coder-worker: null
        coder-worker-test-challenger: null
      main_session_evidence:
        authorized_by: user
        authorization_ref: Proceed all open tasks; direct recovery decision.
        validation_summary: Shutdown synchronously fences admission then disposes/cancels concurrently with request drain; cleanup errors/timeouts exit1. Owner abort sends SIGTERM then SIGKILL after2s; cooperative/stubborn group tests and shutdown regression batch118 tests6files exit0. SDK cancellation/pin batch306 tests exit0; diff0.
    dod_status: pass
  ADW-6b:
    title: Expose readiness metadata without breaking legacy response fields
    status: DONE
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
    - ontoindex/src/mcp/local/backend-overlay.ts
    - ontoindex/test/unit/target-context.test.ts
    allowed_write_set:
    - ontoindex/src/mcp/shared/target-context.ts
    - ontoindex/src/mcp/shared/response-envelope.ts
    - ontoindex/test/unit/response-envelope.test.ts
    - ontoindex/src/mcp/local/backend-overlay.ts
    - ontoindex/test/unit/target-context.test.ts
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
    closeout:
      role_results:
        coder-worker: null
        coder-worker-test-challenger: null
      main_session_evidence:
        authorized_by: user
        authorization_ref: Proceed all open tasks; direct recovery decision.
        validation_summary: Admitted generation/manifest/base/capability and captured HEAD project through existing target-context. Complete current graph authoritative; partial/missing/different captured HEAD fail closed. Dirty-only ordinary advice suppressed; diagnostics/raw dirtiness retained. Final readiness91 tests3files exit0 in1.57s; TypeScript0; bounded OntoIndex file verification PASS with empty symbol extraction; diff0.
    dod_status: pass
  ADW-6c:
    title: Keep diagnostics actionable while suppressing prepared-read dirty advice
    status: DONE
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
    closeout:
      role_results:
        coder-worker: null
        coder-worker-test-challenger: null
      main_session_evidence:
        authorized_by: user
        authorization_ref: Proceed all open tasks; direct recovery decision.
        validation_summary: Runtime diagnostics keep dirty facts and repair advice; successful prepared ordinary envelope retains runtimeHealthState dirty without routine repair; errors/non-dirty failures/diagnostic tools keep advice. Runtime/envelope tests306 batch and final91-test batch exit0; no global diagnostic suppression; diff0.
    dod_status: pass
  ADW-7:
    title: Author a persistent MCP and CLI replay harness
    status: DONE
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
    closeout:
      role_results:
        coder-worker: null
        coder-worker-test-challenger: null
      main_session_evidence:
        authorized_by: user
        authorization_ref: Proceed all open tasks; direct recovery decision.
        validation_summary: Persistent real stdio MCP and six foreground CLI mutations record raw requests/responses/identities/stderr in qualification-20261020-r2/replay-source-accepted.json. Parser and include_content fixture mismatches corrected. Cross-process baseline passes; final eight-file403-test batch exit0. MCP exit0 and empty owned cgroup prove descendant cleanup within5s. Diff0; no native buffer-pool diagnostics.
    dod_status: pass
  ADW-7a:
    title: Author deterministic capture, publication and query race regressions
    status: DONE
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
    closeout:
      role_results:
        coder-worker: null
        coder-worker-test-challenger: null
      main_session_evidence:
        authorized_by: user
        authorization_ref: Proceed all open tasks; direct recovery decision.
        validation_summary: New real-file capture0/1/50/51 fixture uses afterCopy barrier and two concurrent writers changing source/config/HEAD; successful capture retries once and continuous changes reject after exactly two attempts with no leaked captures. Persistent replay preserved-size/mtime edit and old-symbol absence pass. Existing capture67/runtime65 tests cover postbuild identity/coalescing/pins; watcher13 and envelope42 pass separately. Eight-file403-test batch exit0; no sleep-only race assertion added; diff0.
    dod_status: pass
  ADW-7b:
    title: Author compatibility and no-side-effect acceptance checks
    status: DONE
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
    closeout:
      role_results:
        coder-worker: null
        coder-worker-test-challenger: null
      main_session_evidence:
        authorized_by: user
        authorization_ref: Proceed all open tasks; direct recovery decision.
        validation_summary: Real dirty stdio SDK rejects CREATE and verifies unchanged source/Git/HEAD/registry/meta/base/generation. Cgroup emptiness and GNU time exit0 prove bounded descendant cleanup; known buffer-manager/allocation/pool/segfault stderr rejects. Eight-file403-test batch includes resources121, pages13, docs-cursor SDK2, vector SDK2 provider guards, dispatch131, capture67/runtime65 and replay2; envelope42 previously passes. Diff0.
    dod_status: pass
  ADW-7c:
    title: Extend the existing benchmark to measure automatic request preparation
    status: DONE
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
    - ontoindex/test/unit/overlay-benchmark-automatic.test.ts
    - ontoindex/test/unit/overlay-benchmark-stats.test.ts
    - ontoindex/scripts/overlay-benchmark-automatic.mjs
    - ontoindex/scripts/overlay-benchmark-stats.mjs
    allowed_write_set:
    - ontoindex/scripts/overlay-benchmark.mjs
    - ontoindex/test/unit/overlay-benchmark-automatic.test.ts
    - ontoindex/test/unit/overlay-benchmark-stats.test.ts
    - ontoindex/scripts/overlay-benchmark-automatic.mjs
    - ontoindex/scripts/overlay-benchmark-stats.mjs
    non_goals:
    - No adjacent refactors, new runtime owner, dependencies, provider calls, user Git mutations or release publication.
    required_validation:
    - cd ontoindex && ONTOINDEX_TEST_WORKERS=1 node node_modules/vitest/vitest.mjs run --maxWorkers=1 --no-file-parallelism test/unit/overlay-benchmark-automatic.test.ts test/unit/overlay-benchmark-stats.test.ts
    - git diff --check
    expected_evidence:
    - Given the frozen protocol, the benchmark measures request latency/CPU/peak RSS/bytes/build count on 0/1/50/51/config workloads, retains raw samples and stderr, and self-tests missing/failed measurement rejection.
    rollback:
    - Revert only this packet; preserve unrelated work, committed graph and live reader pins.
    stop_conditions:
    - 'Missing accepted ADW-1 contract, required owner outside this write set, architecture choice or changed dependency: stop for manager preparation; do not widen scope.'
    - 'Missing capability, stale success, unbounded cleanup or failed validation: retain evidence and return the exact blocker.'
    known_blockers: []
    closeout:
      role_results:
        coder-worker: null
        coder-worker-test-challenger: null
      main_session_evidence:
        authorized_by: user
        authorization_ref: Proceed all open tasks; direct recovery decision.
        validation_summary: Existing automatic/stats benchmark measures0/1/50/51/config/contention/parity with retained raw output and validation guards. Native user-systemd execution inside existing delegation passes165/165 including four real cgroup CPU/cleanup tests, exit0 in15.90s. Earlier session-scope cgroup.procs EIO retained as capability failure; corrected service invocation proves placement without changing host delegation. No matrix/current performance claim; diff0.
    dod_status: pass
  ADW-7d:
    title: Prove the instrument records one real run before the performance matrix
    status: DONE
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
    allowed_write_set: []
    non_goals:
    - No adjacent refactors, new runtime owner, dependencies, provider calls, user Git mutations or release publication.
    required_validation:
    - cd ontoindex && ONTOINDEX_TEST_WORKERS=1 node node_modules/vitest/vitest.mjs run --maxWorkers=1 --no-file-parallelism test/unit/overlay-benchmark-automatic.test.ts test/unit/overlay-benchmark-stats.test.ts
    - cd ontoindex && node scripts/overlay-benchmark.mjs --automatic --pilot --cpu-cgroup-root /sys/fs/cgroup/user.slice/user-1000.slice/user@1000.service --output ../.ontoindex/adw-validation/qualification-20261020-r4/pilot.json
    - git diff --check
    expected_evidence:
    - Given one disposable fixed input, the pilot emits every required metric, runtime/input hash, raw request/response/stderr and cleanup result at the ADR-declared artifact path; deliberately missing data is rejected.
    rollback:
    - Revert only this packet; preserve unrelated work, committed graph and live reader pins.
    stop_conditions:
    - 'Missing accepted ADW-1 contract, required owner outside this write set, architecture choice or changed dependency: stop for manager preparation; do not widen scope.'
    - 'Missing capability, stale success, unbounded cleanup or failed validation: retain evidence and return the exact blocker.'
    known_blockers: []
    closeout:
      role_results:
        coder-auditor: null
        coder-manager: null
      main_session_evidence:
        authorized_by: user
        authorization_ref: Proceed all open tasks; direct recovery decision.
        validation_summary: Managed adw-iq12a-pilot-20261020-r4 exit0; one cold size1 read26034ms, sampled2410MiB,1build; all budgets pass. Independent artifact/raw/metric check0; frozen identities unchanged. Instrument41 and stats suites passed in both full qualifications; missing-data discrimination retained. Diff check0.
    dod_status: pass
  ADW-7e:
    title: Independently prove snapshot correctness and compatibility before enablement
    status: DONE
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
    allowed_write_set: []
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
    closeout:
      role_results:
        coder-auditor: null
        coder-manager: null
      main_session_evidence:
        authorized_by: user
        authorization_ref: Proceed all open tasks; direct recovery decision.
        validation_summary: Frozen r4 build/both full suites11973pass each; compiled SDK23tests4files and TypeScript exit0 under managed adw-iq11-sdk-20261020-r4. Raw replay SHA5ef653ce retains6mutations15SDK6CLI and83ms descendant cleanup. SDK reference proves same-byte added/deleted-edge parity,config/parse; route/group/vector/docs/resources/cancellation/pins reviewed. Freeze+diff0; unsupported limits retained.
    dod_status: pass
  ADW-7f:
    title: Measure fixed clean and dirty workloads against predeclared budgets
    status: DONE
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
    allowed_write_set: []
    non_goals:
    - No adjacent refactors, new runtime owner, dependencies, provider calls, user Git mutations or release publication.
    required_validation:
    - cd ontoindex && node scripts/overlay-benchmark.mjs --automatic --sizes 0,1,50,51 --extras config,contention,parity --repetitions 20 --cpu-cgroup-root /sys/fs/cgroup/user.slice/user-1000.slice/user@1000.service --output ../.ontoindex/adw-validation/qualification-20261020-r4/matrix.json
    - git diff --check
    expected_evidence:
    - Given the successful pilot artifact and fixed baseline/candidate inputs, repeated samples produce median/p95, CPU/peak RSS/bytes/build counts; all predeclared budgets pass, clean current inputs build zero times, contention has one writer and cleanup is bounded.
    rollback:
    - Revert only this packet; preserve unrelated work, committed graph and live reader pins.
    stop_conditions:
    - 'Missing accepted ADW-1 contract, required owner outside this write set, architecture choice or changed dependency: stop for manager preparation; do not widen scope.'
    - 'Missing capability, stale success, unbounded cleanup or failed validation: retain evidence and return the exact blocker.'
    known_blockers: []
    closeout:
      role_results:
        coder-performance: null
      main_session_evidence:
        authorized_by: user
        authorization_ref: Proceed all open tasks; direct recovery decision.
        validation_summary: Managed adw-iq12-matrix-20261020-r4 exit0,3332234ms;12groups300samples,independent checker and final freeze PASS. Matrix SHA4c39bb02; all budgets pass,warm p95max583ms,cold29286ms,RSS2608205824B,warmCPUmax0.677s,cleanup269ms;clean/warm0builds,20contention rounds1generation,parity0differences;diff0. RSS sampled;lock exclusivity unobserved.
    dod_status: pass
  ADW-8:
    title: Document verified automatic behavior and adjudicate readiness
    status: DONE
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
    closeout:
      role_results:
        coder-manager: null
      main_session_evidence:
        authorized_by: user
        authorization_ref: Proceed all open tasks; direct recovery decision.
        validation_summary: README/reference now state supported capture/pin/routes/errors/cursors/manual limits and accepted matrix12groups300samples SHA4c39bb02. Full11973/662 each,SDK23/4,tsc and matrix exit0;diff0. Readiness approved for shared uncached predicate absent/1 on,0/empty/other off; runtime-only/global-env alternatives rejected twice. RT5/bufferpool/publication excluded.
    dod_status: pass
  ADW-8a:
    title: Enable automatic-current behavior after readiness gates pass
    status: DONE
    classification: implementation-ready
    assurance_profile: full
    complexity: complex
    depends_on:
    - ADW-8
    type: code
    validation_tier: unit-fast
    impact_risk: high
    owner_files:
    - ontoindex/src/mcp/local/backend-overlay.ts
    - ontoindex/src/mcp/local/local-backend-repo-runtime.ts
    - ontoindex/src/mcp/local/local-backend.ts
    - ontoindex/src/mcp/local/backend-search.ts
    - ontoindex/src/mcp/local/backend-symbol-resolution.ts
    - ontoindex/src/mcp/local/backend-context.ts
    - ontoindex/src/mcp/local/backend-impact.ts
    - ontoindex/src/mcp/server.ts
    - ontoindex/src/mcp/resources.ts
    - ontoindex/src/mcp/super/docs.ts
    - ontoindex/src/mcp/super/graph-walk.ts
    - ontoindex/test/unit/backend-overlay.test.ts
    - ontoindex/test/unit/local-backend-repo-runtime.test.ts
    - ontoindex/test/unit/calltool-dispatch.test.ts
    - ontoindex/test/unit/server.test.ts
    - ontoindex/test/unit/resources.test.ts
    - ontoindex/test/unit/overlay-benchmark-automatic.test.ts
    - ontoindex/scripts/overlay-benchmark-automatic.mjs
    allowed_write_set:
    - ontoindex/src/mcp/local/backend-overlay.ts
    - ontoindex/src/mcp/local/local-backend-repo-runtime.ts
    - ontoindex/src/mcp/local/local-backend.ts
    - ontoindex/src/mcp/local/backend-search.ts
    - ontoindex/src/mcp/local/backend-symbol-resolution.ts
    - ontoindex/src/mcp/local/backend-context.ts
    - ontoindex/src/mcp/local/backend-impact.ts
    - ontoindex/src/mcp/server.ts
    - ontoindex/src/mcp/resources.ts
    - ontoindex/src/mcp/super/docs.ts
    - ontoindex/src/mcp/super/graph-walk.ts
    - ontoindex/test/unit/backend-overlay.test.ts
    - ontoindex/test/unit/local-backend-repo-runtime.test.ts
    - ontoindex/test/unit/calltool-dispatch.test.ts
    - ontoindex/test/unit/server.test.ts
    - ontoindex/test/unit/resources.test.ts
    - ontoindex/test/unit/overlay-benchmark-automatic.test.ts
    - ontoindex/scripts/overlay-benchmark-automatic.mjs
    non_goals:
    - No adjacent refactors, new runtime owner, dependencies, provider calls, user Git mutations or release publication.
    required_validation:
    - cd ontoindex && ONTOINDEX_TEST_WORKERS=1 node node_modules/vitest/vitest.mjs run --maxWorkers=1 --no-file-parallelism test/unit/backend-overlay.test.ts test/unit/local-backend-repo-runtime.test.ts test/unit/calltool-dispatch.test.ts test/unit/server.test.ts test/unit/resources.test.ts test/unit/overlay-benchmark-automatic.test.ts
    - git diff --check
    expected_evidence:
    - Given absent setting, every activation consumer uses one uncached predicate in existing backend-overlay owner; absent or1 enables while explicit0 and other prior-disabled values remain disabled. Benchmark flagOff explicitly assigns0. Ordinary reads, watcher/pins/cache/resources/cursors agree and mutation guards remain unchanged; rollback reverts the predicate default.
    rollback:
    - Revert only this packet; preserve unrelated work, committed graph and live reader pins.
    stop_conditions:
    - 'Missing accepted ADW-1 contract, required owner outside this write set, architecture choice or changed dependency: stop for manager preparation; do not widen scope.'
    - 'Missing capability, stale success, unbounded cleanup or failed validation: retain evidence and return the exact blocker.'
    known_blockers: []
    closeout:
      role_results:
        coder-worker: null
        coder-worker-test-challenger: null
      main_session_evidence:
        authorized_by: user
        authorization_ref: Proceed all open tasks; direct recovery decision.
        validation_summary: Managed adw-default-focused-20261020 terminal exit0,335706ms including lane wait; offline build0 and491tests6files pass25.83s with activation absent. Final freeze PASS; input SHAb29cb139 and build89894520. Shared uncached predicate covers27checks11consumers plus explicit0benchmark baseline; actual absent/1/0/empty/invalid config/runtime/resource/group tests pass. Diff0; signatures/mutation guards preserved.
    dod_status: pass
  ADW-8b:
    title: Verify ordinary MCP and CLI startup with the default enabled
    status: DONE
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
    allowed_write_set: []
    non_goals:
    - No adjacent refactors, new runtime owner, dependencies, provider calls, user Git mutations or release publication.
    required_validation:
    - cd ontoindex && ONTOINDEX_ADW_REPLAY_DEFAULT=1 ONTOINDEX_ADW_REPLAY_CLI=dist/cli/index.js ONTOINDEX_TEST_WORKERS=1 node node_modules/vitest/vitest.mjs run --maxWorkers=1 --no-file-parallelism test/integration/automatic-dirty-workspace.test.ts
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
    closeout:
      role_results:
        coder-auditor: null
        coder-manager: null
      main_session_evidence:
        authorized_by: user
        authorization_ref: Proceed all open tasks; direct recovery decision.
        validation_summary: Managed adw-default-startup-20261020 terminal exit0,26004ms; compiled ordinary-default replay2tests20.53s and tsc0,final freeze PASS. Activation unset,DEFAULT1,CLI dist. Saved SHA3c91eae6 has29records15SDK6CLI6mutation identities;CLI exits0/empty stderr,MCP exit0,no native errors,all-descendant cleanup94.585ms. Clean0build/dirty parity/reuse and write denial asserted;diff0.
    dod_status: pass
  ADW-8c:
    title: Record final evidence and release handoff without publishing
    status: DONE
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
    closeout:
      role_results:
        coder-manager: null
      main_session_evidence:
        authorized_by: user
        authorization_ref: Proceed all open tasks; direct recovery decision.
        validation_summary: Final handoff records exact managed commands and terminal exit0 for focused491/6 and compiled startup2/1 plus tsc; current frozen source/dependencies/build verified unchanged. Exact HEAD and three artifact hashes retained; r4 matrix12groups300samples and prior full-suite limitations preserved. Explicit17file gn_verify_diff PASS; git diff --check exit0; both plan parsers pass. ADW-8b accepted through complete-local. Routers updated; activation absent/1 on and explicit0 rollback documented. No additional runtime invocation or correction; prior2corrections retained. knowledge_handoff none because existing manager/build rules cover evidence reuse.
    dod_status: pass
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

All 34 tasks are DONE. Manager state is closed with no active task. ADW-8a,
ADW-8b and ADW-8c were accepted through complete-local using recorded evidence.
The independent review is closed, 49/49 tasks accepted. Publication is outside
this plan.

The default is enabled when `ONTOINDEX_AUTO_WORKSPACE` is absent or exactly `1`.
Explicit `0`, empty and other values disable it. One uncached predicate in
`ontoindex/src/mcp/local/backend-overlay.ts` serves eleven production consumers;
the benchmark's disabled baseline explicitly sets `0`. Five unit test files
changed; the unchanged server suite also ran. Public signatures and mutation
guards are preserved. Operational rollback sets `ONTOINDEX_AUTO_WORKSPACE=0`;
code rollback changes the existing predicate default and rebuilds the candidate.

### Accepted terminal commands

From `ontoindex/`, the managed focused wrapper ran one offline build and:

```sh
node node_modules/vitest/vitest.mjs run --maxWorkers=1 --no-file-parallelism test/unit/backend-overlay.test.ts test/unit/local-backend-repo-runtime.test.ts test/unit/calltool-dispatch.test.ts test/unit/server.test.ts test/unit/resources.test.ts test/unit/overlay-benchmark-automatic.test.ts
```

`adw-default-focused-20261020`: terminal exit 0, 335706 ms including shared
lane wait; build exit 0; 491 tests in six files pass in 25.83 seconds.
The wrapper unsets activation, uses the serial lock and delegated cgroup, and
checks the input/output freeze. The startup wrapper then ran, without rebuilding:

```sh
node node_modules/vitest/vitest.mjs run --maxWorkers=1 --no-file-parallelism test/integration/automatic-dirty-workspace.test.ts
node node_modules/typescript/bin/tsc --noEmit -p .
```

`adw-default-startup-20261020`: terminal exit 0, 26004 ms; two integration
tests pass in 20.53 seconds; TypeScript exit 0; final freeze PASS. Its environment
sets `ONTOINDEX_ADW_REPLAY_DEFAULT=1`, `ONTOINDEX_ADW_REPLAY_CLI=dist/cli/index.js`
and `ONTOINDEX_TEST_WORKERS=1`, and unsets `ONTOINDEX_AUTO_WORKSPACE`.
The saved replay has 29 records, 15 SDK requests, six compiled CLI calls and
six mutation identities. CLI exits are 0 with empty stderr; MCP exits 0 and
retains capability/startup notices without native errors. Owned descendant
cleanup is 94.585 ms. Clean reads build zero times; mutation parity, generation
reuse, write denial and source/Git/base/registry preservation are asserted.

Canonical terminal receipts are read with:

```sh
env ONTOCODE_COMPILER_ARTIFACT_ROOT=/opt/d2/.ontocode/artifacts/compiler-lane /home/er77/.cargo/bin/just --justfile /opt/d1/_wrk/ontocode/justfile lane-result adw-default-focused-20261020
env ONTOCODE_COMPILER_ARTIFACT_ROOT=/opt/d2/.ontocode/artifacts/compiler-lane /home/er77/.cargo/bin/just --justfile /opt/d1/_wrk/ontocode/justfile lane-result adw-default-startup-20261020
```

Both receipt reads return exit 0. Final `freeze.py verify` returns exit 0 without
rerunning validation. Bounded `gn_verify_diff` passes with the explicit seventeen
production/script/test paths and no unexpected files. Graph symbol attribution
does not cover dirty source; direct source and frozen runtime evidence govern it.

### Final identities and limits

HEAD: `acbcb63830cf51a8fc0537a76f4267e5be758167`.
Files under `.ontoindex/adw-validation/default-20261020/`:

| Artifact | SHA-256 |
| --- | --- |
| `candidate-inputs.json` | `b29cb13941e3cb36eb415a635c58146807a797fa134cdb43676ed4ecf7509242` |
| `build-outputs.json` | `898945209a99545202d7599038235807c109257bace1c545e373af0f99cf49d7` |
| `replay-default.json` | `3c91eae65e4115f8f6e10e21036a53c3cac87d5d1bb20093f017c653a1c5dfcd` |

Prior frozen full suites pass 11973 tests in 662 files each, with one expected
failure and 311 declared skips; compiled SDK passes 23 tests in four files.
The accepted r4 matrix has twelve workload groups and 300 samples, SHA-256
`4c39bb02fdb9606bc3641c47edc5f3f4b5eefb0fc0a40a103a6f2a63e38fad33`.
Maximum warm p95 is 583.290 ms; dirty cold p95 is 29285.484 ms; all declared
budgets pass. The default-only change uses focused validation and ordinary
compiled startup proof; it does not repeat the earlier full suite or matrix.

Limits remain explicit: on-disk captures use bounded verification; dynamic and
external resolver inputs, unsaved buffers, new vectors and atomic cross-repository
snapshots are outside coverage. RSS is sampled, OS caches are unflushed, the
matrix raises the corpus file gate, contention counts generations rather than
proving lock exclusion, and parity samples a selected probe. RT-5 and native
buffer-pool investigations retain their separate evidence and scope.

Default activation used the allocated one build, one focused suite, one replay
and one TypeScript invocation, all successful. Prior correction rounds remain
two consumed; this closeout adds none. No new worker, runtime launch, provider
call, commit, worktree or publication is needed. Unchanged evidence is reused;
there is no loop-protection violation in this closeout. Historical rejected
dispatches remain recorded and are not treated as passing receipts.
`knowledge_handoff: none`: the manager/build skills already cover terminal
receipt reuse, frozen inputs and preserving another owner's compiler lane.
