# Effective configuration reuse

Date: 2026-10-22
Status: Closed
Authority: User proceed; ADR_AUTOMATIC_DIRTY_WORKSPACE.md SCOPE refinement.

## Goal

Keep effective import configuration consistent across parse chunks and recovery.

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
  CONFIG-1:
    title: One parse run reuses initial import configuration across both execution paths
    status: DONE
    classification: implementation-ready
    assurance_profile: full
    complexity: standard
    depends_on: []
    type: code
    validation_tier: unit-fast
    impact_risk: medium
    owner_files:
    - ontoindex/src/core/ingestion/import-processor.ts
    - ontoindex/src/core/ingestion/pipeline-phases/parse-impl.ts
    - ontoindex/test/unit/import-processor.test.ts
    - ontoindex/test/unit/parse-impl-fallback.test.ts
    allowed_write_set:
    - ontoindex/src/core/ingestion/import-processor.ts
    - ontoindex/src/core/ingestion/pipeline-phases/parse-impl.ts
    - ontoindex/test/unit/import-processor.test.ts
    - ontoindex/test/unit/parse-impl-fallback.test.ts
    non_goals:
    - No complete configuration observation or replay identity claim
    - No seed publication or navigation activation
    required_validation:
    - cd ontoindex && ONTOINDEX_TEST_WORKERS=1 ./node_modules/.bin/vitest run test/unit/import-processor.test.ts test/unit/parse-impl-fallback.test.ts
    - cd ontoindex && ./node_modules/.bin/tsc --noEmit
    - git diff --check
    expected_evidence:
    - Supplied configuration prevents reload and standalone callers retain existing behavior
    - Parse chunks and fallback share initial configuration despite file changes
    rollback:
    - Revert only CONFIG-1 hunks in the four owned files
    stop_conditions:
    - Changes outside import and parse owners required
    known_blockers: []
    closeout:
      role_results:
        coder-worker: null
        coder-worker-test-challenger: null
      main_session_evidence:
        authorized_by: user
        authorization_ref: User proceed with configuration reuse prerequisite
        validation_summary: Parent reviewed source and regression changes from two Sol medium development agents. Focused Vitest session 96041 exited 0 with 37 tests across two files. Production TypeScript session 83229 exited 0. git diff --check exited 0. One of two suite attempts and one of two typechecks used. Source hashes import-processor 2bc7d0fed223089b11a58e448dce5170f039c3c631e90a4fcd93decf61aad031 and parse-impl 79bf7beb3193c51d839ac04a8aac91f13880cb9b29942ed747e05f8254d6c734; test hashes e910a6ecd2a0eff2d1c768f0f760f66850d9736395f25f9762c916b44d36257f and dffc10214ec007d44671364ecb042324441de2c23b3792ada507c75b382234ce. Both paths reuse initial configuration across disk changes; standalone loading preserved. New awaited load is inside existing cleanup try. OntoIndex transport closed; source authority. No full observation identity or navigation activation claim.
    dod_status: pass
```

## Required Traceability

| Requirement ID | Requirement | Disposition | Task IDs | Validation |
| --- | --- | --- | --- | --- |
| REUSE | Preserve effective configuration across chunks | implementation | CONFIG-1 | Processor and parse regressions |
| IDENTITY | Complete actual-read observations and generation identity | non-goal | CONFIG-1 | Successor observation packet |

## Decisions And Second Challenge

After-read filename hashing misses negative reads, directory ordering and races.
A captured filesystem provides stronger isolation but requires larger lifecycle
changes. Actual loader observations plus run-local configuration reuse retain the
existing owner and avoid repeat reads. First correct reuse: a shared resolution
cache must not span differing configurations. Then capture actual reads, failures,
directory order and traversal limits. A reused object is not an immutable source
snapshot or complete identity. No global cache or new dependency is introduced.

## Execution Evidence

Four read-only agents inspected ownership, identity reuse, tests and design.
Two Sol medium development agents own disjoint source and test files.
OntoIndex stale/degraded: Transport closed; source inspection is authority.
Budget: two focused suites and two typechecks; children run neither.
Development dispatch preceded tracker creation; validation and acceptance remain
gated on this tracker. No authenticated lease was created or modified.

## Closeout

CONFIG-1 implementation and focused validation passed. No build, install or
publication performed. Actual-read observation capture remains successor work.
Knowledge handoff: none; existing manager-loop rules already require tracker
validation before dispatch and evidence-backed closeout. Dispatch ordering
deviation is recorded above.
