# Replay Admission Contract

Date: 2026-10-24
Status: Closed
Authority: User proceed after EDGE-1 and admission follow-up.

## Goal

Make the independent admission prerequisite explicit and test realistic coverage at the planner boundary.

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
  CONTRACT-1:
    title: Real complete coverage cannot bypass unproven admission
    status: DONE
    classification: implementation-ready
    assurance_profile: lite
    complexity: simple
    depends_on: []
    type: code
    validation_tier: unit-fast
    impact_risk: low
    owner_files:
    - ontoindex/src/core/ingestion/pipeline-phases/scope-retention-replay-plan.ts
    - ontoindex/test/unit/scope-retention-replay-plan.test.ts
    allowed_write_set:
    - ontoindex/src/core/ingestion/pipeline-phases/scope-retention-replay-plan.ts
    - ontoindex/test/unit/scope-retention-replay-plan.test.ts
    non_goals:
    - Runtime behavior or API changes
    - Replay activation or admission implementation
    required_validation:
    - cd ontoindex && ONTOINDEX_TEST_WORKERS=1 ./node_modules/.bin/vitest run test/unit/scope-retention-replay-plan.test.ts test/unit/scope-retention-coverage.test.ts
    - cd ontoindex && ./node_modules/.bin/tsc --noEmit --incremental false
    expected_evidence:
    - Actual complete summaries with skipped or unparsed files cannot bypass unproven admission
    - Actual incomplete summaries require full analysis even with proven admission
    - Actual retained coverage and independent admission preserve whole-file union
    rollback:
    - Remove only new comments and regression cases
    stop_conditions:
    - Change requires production admission policy or activation
    known_blockers: []
    closeout:
      role_results:
        coder-worker: null
        coder-worker-test-challenger: null
      main_session_evidence:
        authorized_by: user
        authorization_ref: Current proceed instruction and standing four-agent authorization
        validation_summary: 43 focused tests passed exit 0 (session 62436 terminal 23dae0); TypeScript exit 0 (session 86178 terminal 368405); independent review no blocking findings; OntoIndex declared-file verify_diff PASS; whitespace exit 0.
    dod_status: pass
```

## Required Traceability

| Requirement ID | User requirement | Disposition | Task IDs | Validation |
| --- | --- | --- | --- | --- |
| ADMISSION-REQ | Challenge and continue replay prerequisites | implementation | CONTRACT-1 | Real-summary regressions |

## Decisions And Non-Goals

Compared twice: clarify/test independent admission; replace it with verified candidate; disable successful planning. Selected clarification and executable regression proof. Candidate verification deliberately accepts seedReady false and excludes semantic completeness, so replacing admission with it adds coupling without safety. Disabling planning removes a useful pure seam without a demonstrated production defect. Changing descriptive coverage would conflate inventory accounting and seed readiness.

Current planner has no production caller. A skipped changed path may be freshly parsed; it is not a valid counterexample to independently proven admission. Caller must establish semantic replay safety for the selected generation and post-edit context. Coverage and persisted-record integrity do not establish that fact. No new proof object, dependency, runtime overhead, security surface or public API. Rollback is local and compatibility unchanged.

OntoIndex index matches HEAD; symbol absent from committed graph. Impact UNKNOWN and safe-edit CAUTION; current source is authority. Four bounded agents: two discovery/review; two Sol-medium development packets with disjoint source comments/test writes. Parent owns validation. Budget one focused suite and one typecheck; no build or launch.

## Closeout

Added admission-contract comments and six regressions using actual coverage summaries; runtime/API behavior unchanged. Four agents participated with two Sol-medium developers. Independent source review passed. One focused suite and one typecheck consumed; no retries, build, deployment or activation. Rust formatting inapplicable to this TypeScript checkout. OntoIndex declared-file check passed; symbol impact unavailable for unindexed source.

The earlier skipped-file counterexample did not prove a runtime defect: it asserted admission without establishing its prerequisites, and a changed file may be freshly parsed. Production admission must eventually bind semantic evidence to the selected generation and post-edit context. Candidate integrity verification cannot be substituted for that missing owner. No production planner caller exists.
