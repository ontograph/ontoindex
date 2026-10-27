# Scope outcome propagation

Date: 2026-10-22
Status: Closed
Authority: User proceed; ADR_AUTOMATIC_DIRTY_WORKSPACE.md SCOPE packet.

## Goal

Preserve compact extraction outcomes through worker aggregation and sequential
fallback, with missing records explicitly treated as unavailable evidence.

## Manager Tracking

```yaml
manager_loop:
  authority: true
  status: closed
  selection_policy: active_next_task-first
  active_next_task: null
  max_in_flight: 1
  dispatch_mode: none
  reopen_gate: null
tasks:
  PROP-1:
    title: Worker and sequential paths preserve compact extraction status without duplicate artifacts
    status: DONE
    classification: implementation-ready
    assurance_profile: full
    complexity: standard
    depends_on: []
    type: code
    validation_tier: unit-fast
    impact_risk: medium
    owner_files:
    - ontoindex/src/core/ingestion/scope-extractor-bridge.ts
    - ontoindex/src/core/ingestion/workers/parse-types.ts
    - ontoindex/src/core/ingestion/workers/parse-worker.ts
    - ontoindex/src/core/ingestion/parsing-processor.ts
    - ontoindex/src/core/ingestion/pipeline-phases/parse-impl.ts
    - ontoindex/test/unit/parse-worker-protocol.test.ts
    - ontoindex/test/unit/scope-resolution/parse-worker-scope-integration.test.ts
    allowed_write_set:
    - ontoindex/src/core/ingestion/scope-extractor-bridge.ts
    - ontoindex/src/core/ingestion/workers/parse-types.ts
    - ontoindex/src/core/ingestion/workers/parse-worker.ts
    - ontoindex/src/core/ingestion/parsing-processor.ts
    - ontoindex/src/core/ingestion/pipeline-phases/parse-impl.ts
    - ontoindex/test/unit/parse-worker-protocol.test.ts
    - ontoindex/test/unit/scope-resolution/parse-worker-scope-integration.test.ts
    non_goals:
    - No durable retention completeness assertion protocol-version change or activation
    required_validation:
    - cd ontoindex && ONTOINDEX_TEST_WORKERS=1 ./node_modules/.bin/vitest run test/unit/scope-resolution/parse-worker-scope-integration.test.ts test/unit/parse-worker-protocol.test.ts test/unit/parse-impl-fallback.test.ts
    - cd ontoindex && ./node_modules/.bin/tsc --noEmit
    - git diff --check
    expected_evidence:
    - Status and reason survive ordered merges without duplicate ParsedFile payload
    - Old results without optional field remain accepted as unavailable evidence
    - Sequential and worker crash fallback expose outcomes and preserve legacy null return
    - Clearing transient source arrays does not erase transferred outcomes
    rollback:
    - Revert only PROP-1 hunks
    stop_conditions:
    - Incompatible protocol change or unrelated owner expansion
    known_blockers: []
    closeout:
      role_results:
        coder-worker: null
        coder-worker-test-challenger: null
      main_session_evidence:
        authorized_by: user
        authorization_ref: User proceed on reviewed scope propagation packet
        validation_summary: Two Sol medium development packets implemented disjoint source and tests; two read-only packets traced and challenged ownership. Final seven file hashes match the validation checkpoint. Retained Vitest log confirms 51 tests in three files passed in 4.83 seconds; prior terminal receipt session 64908 recorded exit 0. TypeScript noEmit terminal receipt session 58704 recorded exit 0. Prior git diff --check exit 0. First suite launch outcome is unknown and consumes its reserved slot; suite budget 2 of 2, typecheck budget 1 of 2. Optional compact outcomes survive merges and clearing; sequential and crash fallback preserve legacy null return. Worker success returns outcomes directly. No durable capture or current-worktree navigation completeness claim.
    dod_status: pass
```

## Required Traceability

| Requirement ID | Requirement | Disposition | Task IDs | Validation |
| --- | --- | --- | --- | --- |
| SCOPE-PROP | Preserve extraction evidence before retention | implementation | PROP-1 | Worker merge and sequential fallback regression |

## Decisions and challenge

Failure-only records save small status objects but require separate success
inference. Direct sink delivery avoids transport fields but couples parsing to
an unimplemented retention owner. Select additive optional compact outcomes in
existing result arrays: one path/status/reason record per attempted extraction,
no copied ParsedFile payload and no new dependency. Missing records never mean
success. Skipped, lightweight and quarantined files still require inventory
reconciliation before complete capture. Preserve protocol version and accept old
producers; optional evidence cannot certify completeness. Existing chunk bounds
limit transport; durable aggregate bounds remain a separate retention gate.

## Execution evidence

OntoIndex freshness returned Transport closed; source inspection is authority.
Two read-only research packets and two Sol medium development packets are used.
Parent owns serial validation: at most two focused suites and two typechecks;
no build, install, publication or reindex. Unrelated changes are preserved.

## Closeout

PROP-1 completed through the manager complete-local transition.
Bounded retention, inventory reconciliation, identity, CALLS, SEED and activation
remain open. Missing records remain unavailable evidence. OntoIndex transport
was closed during this slice; source inspection is authority.
Knowledge handoff: none; existing manager rules already require preserving
unknown launch budget accounting and matching validation to unchanged inputs.
