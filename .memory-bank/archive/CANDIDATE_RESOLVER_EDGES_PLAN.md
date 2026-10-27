# Candidate Resolver Edge Admission

Date: 2026-10-24
Status: Closed
Authority: User authorized continuation of recovered workspace recovery task.

## Goal

Reject resolver-owned retained graph edges at candidate admission, matching capture.

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
  EDGE-1:
    title: Candidate admission rejects CALLS and write ACCESSES while preserving structural edges
    status: DONE
    classification: implementation-ready
    assurance_profile: lite
    complexity: simple
    depends_on: []
    type: code
    validation_tier: unit-fast
    impact_risk: low
    owner_files:
    - ontoindex/src/core/ingestion/pipeline-phases/scope-retention-candidate-reader.ts
    - ontoindex/test/unit/scope-retention-candidate-reader.test.ts
    allowed_write_set:
    - ontoindex/src/core/ingestion/pipeline-phases/scope-retention-candidate-reader.ts
    - ontoindex/test/unit/scope-retention-candidate-reader.test.ts
    non_goals:
    - Replay activation or deployment
    - Codec restrictions or endpoint completeness requirements
    required_validation:
    - cd ontoindex && ONTOINDEX_TEST_WORKERS=1 ./node_modules/.bin/vitest run test/unit/scope-retention-candidate-reader.test.ts test/unit/scope-retention.test.ts
    - cd ontoindex && ./node_modules/.bin/tsc --noEmit --incremental false
    expected_evidence:
    - Correctly rehashed CALLS and write ACCESSES records are rejected
    - Read ACCESSES and structural edges remain accepted including absent endpoints
    rollback:
    - Revert only the admission predicate and its new regression cases
    stop_conditions:
    - Producer semantics disagree or change requires replay activation
    known_blockers: []
    closeout:
      role_results:
        coder-worker: null
        coder-worker-test-challenger: null
      main_session_evidence:
        authorized_by: user
        authorization_ref: User proceed and four-agent development authorization in current session
        validation_summary: 416 tests in two files passed exit 0 (session 35360 terminal 765049); TypeScript passed exit 0 (session 57614 terminal 3072ec); independent source review PASS; declared-file OntoIndex verify_diff PASS; whitespace exit 0.
    dod_status: pass
```

## Required Traceability

| Requirement ID | User requirement | Disposition | Task IDs | Validation |
| --- | --- | --- | --- | --- |
| EDGE-REQ | Continue robust workspace recovery prerequisites | implementation | EDGE-1 | Rehashed admission regressions and TypeScript |

## Decisions And Non-Goals

Three alternatives reviewed twice before editing:

- Admission guard: selected. Matches producer contract, constant cost per edge, no format/API change, rejects semantically invalid content before consumers. Local rollback and focused tests suffice.
- Generic codec restriction: rejected. Codec deliberately supports resolver output; restriction breaks valid callers and codec tests.
- Replay filtering: rejected. Leaves admission unsound, duplicates protection across consumers, and silently discards bad input.

Second challenge: missing endpoints are already accepted and are insufficient proof of corruption. Preserve them. Reject forbidden edge types in incomplete candidates too, because capture never admits them. No new diagnostics expose record contents. Do not infer deployed impact from helper tests.

OntoIndex committed HEAD is current; target absent from graph. Impact UNKNOWN and safe-edit CAUTION. Direct source confirms candidate persistence calls the verifier. Source inspection is authority for dirty code.

Agents: next_replay_gap (Luna), next_graph_gap (Sol medium), followed by disjoint Sol-medium source and test packets. Parent owns validation and tracking. Budget: one focused test invocation and one typecheck; one correction run only for new failing evidence. No build or application launch.

## Closeout

Reader rejects resolver-owned edges after codec validation. Six new tests cover forbidden and allowed relationships across retained and incomplete candidates. Four agents participated; both developers used gpt-6.1-sol medium. Source reviewer independently passed.

Budget used: one focused suite, one typecheck; no correction run, build or app launch. Plan validation required one correction to include the test in owner_files. No rejected receipts or execution retries. Rust formatting is inapplicable to this TypeScript checkout. No deployment or replay activation claimed. OntoIndex declared-file verification passed; symbol scope unavailable for unindexed code.

Follow-up: define the planner admission proof before wiring replay. Descriptive coverage can be complete for skipped files; caller-supplied admission proven currently carries an implicit stronger contract. No production planner caller was found, so this is a pre-activation contract concern, not a demonstrated runtime defect.
