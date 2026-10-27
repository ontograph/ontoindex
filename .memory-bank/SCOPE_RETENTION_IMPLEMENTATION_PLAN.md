# Bounded scope retention

Date: 2026-10-22
Status: Closed
Authority: User proceed and ADR_AUTOMATIC_DIRTY_WORKSPACE.md SCOPE refinement.

## Goal

Retain ordered scope inputs before parse cleanup with bounded storage and explicit inventory gaps.

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
  RETAIN-1:
    title: Opt-in parse retention preserves inputs and refuses incomplete inventory
    status: DONE
    classification: implementation-ready
    assurance_profile: full
    complexity: complex
    depends_on: []
    type: code
    validation_tier: unit-fast
    impact_risk: medium
    owner_files:
    - ontoindex/src/core/ingestion/pipeline-phases/parse-impl.ts
    - ontoindex/src/core/ingestion/pipeline-phases/parse.ts
    - ontoindex/src/core/ingestion/pipeline-phases/structure.ts
    - ontoindex/src/core/ingestion/pipeline-phases/parse-scope-codec.ts
    - ontoindex/src/core/ingestion/pipeline-phases/scope-retention-stage.ts
    - ontoindex/src/core/ingestion/pipeline.ts
    - ontoindex/test/unit/scope-retention.test.ts
    - ontoindex/test/unit/parse-impl-fallback.test.ts
    - ontoindex/test/unit/parse-phase-lifecycle.test.ts
    allowed_write_set:
    - ontoindex/src/core/ingestion/pipeline-phases/parse-impl.ts
    - ontoindex/src/core/ingestion/pipeline-phases/parse.ts
    - ontoindex/src/core/ingestion/pipeline-phases/structure.ts
    - ontoindex/src/core/ingestion/pipeline-phases/parse-scope-codec.ts
    - ontoindex/src/core/ingestion/pipeline-phases/scope-retention-stage.ts
    - ontoindex/src/core/ingestion/pipeline.ts
    - ontoindex/test/unit/scope-retention.test.ts
    - ontoindex/test/unit/parse-impl-fallback.test.ts
    - ontoindex/test/unit/parse-phase-lifecycle.test.ts
    non_goals:
    - No generation publication or default workspace navigation activation
    - No complete seed or configuration identity claim
    - No worker protocol or existing legacy stage format changes
    required_validation:
    - cd ontoindex && ONTOINDEX_TEST_WORKERS=1 ./node_modules/.bin/vitest run test/unit/scope-retention.test.ts test/unit/parse-impl-fallback.test.ts test/unit/parse-phase-lifecycle.test.ts
    - cd ontoindex && ./node_modules/.bin/tsc --noEmit
    - git diff --check
    expected_evidence:
    - Ordered Maps and nested scope facts survive worker and sequential cleanup
    - Admission precedes unbounded allocation and enforces shared bytes and deadline
    - Missing and failed extraction outcomes remain incomplete
    - Owned artifact cleanup settles on success and failure
    rollback:
    - Revert only RETAIN-1 hunks and its new helper and test files
    stop_conditions:
    - Complete configuration identity or generation publication required
    known_blockers: []
    closeout:
      role_results:
        coder-worker: null
        coder-worker-test-challenger: null
      main_session_evidence:
        authorized_by: user
        authorization_ref: User proceed with bounded scope retention implementation
        validation_summary: Parent reviewed the two Sol medium development packets and current source. Final Vitest session 94745 exited 0 with 46 tests across three files. Production TypeScript session 2765 exited 0; tsconfig includes src only so final test assertion changes do not affect that check. git diff --check exited 0. Budget consumed three of three focused suite invocations and two of two typechecks. Earlier runs exposed fixture range and function-identity assertions plus codec narrowing errors, all corrected. Actual sequential TypeScript provider lacks scope capture hook and correctly reports unsupported; successful worker and recovery fixtures do not establish provider support. OntoIndex transport closed; source inspection is authority. No build install release or navigation activation claimed.
    dod_status: pass
```

## Required Traceability

| Requirement ID | Requirement | Disposition | Task IDs | Validation |
| --- | --- | --- | --- | --- |
| SCOPE-BOUNDS | Bounded ordered retention and cleanup | implementation | RETAIN-1 | Codec and stage limits and lifetime tests |
| SCOPE-INVENTORY | Missing outcomes cannot imply completeness | implementation | RETAIN-1 | Inventory gap regressions |
| SCOPE-SEED | Configuration identity and generation publication | non-goal | RETAIN-1 | Successor work |

## Decisions and second challenge

In-memory cloning adds allocation before admission and cannot bound retention.
Reparsing changes the observed inputs and repeats parser work. Choose bounded
streaming capture under the existing parse owner with schema validation and
ordered Map encoding. Rechecking this choice exposed two necessary controls:
synchronous sequential callbacks must detach immediately, and scan exclusions
must survive inventory forwarding. Retention status never certifies a complete
seed. Keep the feature opt-in and consume the handle within an awaited callback
before parse output disposal; do not return a disposed handle to pipeline callers.
No new dependency or worker wire format. Fixed inclusive limits are 64 MiB,
100000 records and 256 KiB per record; read chunks and replay batches are bounded.
Caller supplies an absolute deadline and shared remaining artifact allowance.
Cancellation and failure preserve original errors and settle I/O before cleanup.

## Execution evidence

Four read-only discovery agents completed bounded packets. Budget review was
partial; no test claim accepted. OntoIndex transport closed in inherited turn;
source inspection is authority. Parent budget: three focused suites and two
typechecks, serial only. Two gpt-6.1-sol medium development packets own source
and tests separately. No build, install, reindex or publication in this slice.

## Closeout

Implemented opt-in bounded scope retention with ordered Map encoding, shared byte
allowance, cancellation, inventory gaps and awaited cleanup. Final focused suite:
46 tests passed, exit 0; production typecheck and whitespace check passed.
Codec retains enumerable string-key semantic fields; nonenumerable and symbol
metadata are outside its representation. Retention never establishes seed readiness.
Actual TypeScript sequential extraction remains unsupported without a provider hook.
Configuration/source identity, call replay, seed publication and current-worktree
navigation remain successor work. Knowledge handoff: none; existing validation
rules already require comparing observable data rather than function identity.
