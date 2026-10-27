# Scope retention lifecycle hardening

Date: 2026-10-22
Status: Closed
Authority: User requested independent challenge and implementation; scope retention ADR.

## Goal

Bound concurrent replay and settle reader acquisition before releasing retained storage.

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
  HARDEN-1:
    title: Disposal releases inventory and waits for reader acquisition with one active replay
    status: DONE
    classification: implementation-ready
    assurance_profile: full
    complexity: standard
    depends_on: []
    type: code
    validation_tier: unit-fast
    impact_risk: medium
    owner_files:
    - ontoindex/src/core/ingestion/pipeline-phases/scope-retention-stage.ts
    - ontoindex/test/unit/scope-retention.test.ts
    allowed_write_set:
    - ontoindex/src/core/ingestion/pipeline-phases/scope-retention-stage.ts
    - ontoindex/test/unit/scope-retention.test.ts
    non_goals:
    - No provider hook implementation or runtime navigation activation
    - No new dependency or changed codec schema
    required_validation:
    - cd ontoindex && ONTOINDEX_TEST_WORKERS=1 ./node_modules/.bin/vitest run test/unit/scope-retention.test.ts test/unit/parse-phase-lifecycle.test.ts
    - cd ontoindex && ./node_modules/.bin/tsc --noEmit
    - git diff --check
    expected_evidence:
    - Disposal releases inventory and awaits pending open without waiting for a suspended generator
    - Concurrent replay is explicitly refused and sequential replay remains available
    - Failed writes and unreconciled inventories cannot report retained
    rollback:
    - Revert only hardening hunks in the two owned files
    stop_conditions:
    - Provider or publication changes needed
    known_blockers: []
    closeout:
      role_results:
        coder-worker: null
        coder-worker-test-challenger: null
      main_session_evidence:
        authorized_by: user
        authorization_ref: User requested review, consolidation and implementation with two Sol medium development agents
        validation_summary: Parent reviewed persisted source and six deterministic regressions. Vitest session 28259 exited 0 with 33 tests in two files; production tsc session 48942 exited 0; git diff --check exited 0. One of two suite and typecheck attempts used. Source SHA256 205ec90b56ac8d904f8df282059806c9406d90e8e2278bac67959369066f9e9f; tests SHA256 e95c7b1bad8406ff8e7df93a7d89afc5884c6bfa3a12597c965ee32eb2920532. Concurrent replay is refused, pending open and close settle before removal, suspended consumers do not block disposal, inventory is cleared, and failed writes or unreconciled state remain incomplete. OntoIndex transport closed; source inspection is authority. No navigation activation or performance claim.
    dod_status: pass
```

## Required Traceability

| Requirement ID | Requirement | Disposition | Task IDs | Validation |
| --- | --- | --- | --- | --- |
| LIFE | Settle reader acquisition and release owned inventory | implementation | HARDEN-1 | Deferred-open and disposal tests |
| BOUNDS | One active replay and truthful retention status | implementation | HARDEN-1 | Concurrent-reader and status regressions |
| REPLAY | Provider hooks, configuration identity, call replay and seed publication | non-goal | HARDEN-1 | Successor packets under existing ADR |

## Decisions And Second Challenge

Retain ordered encoding, fixed ceilings, explicit unsupported outcomes and awaited
consumer cleanup. The earlier 46 passing tests omitted concurrent readers and
pending-open disposal; completion did not establish those guarantees.

Compare three fixes: targeted guards in the existing stage; a full operation state
machine; a single-use cursor API. Select targeted guards for compatibility, small
rollback scope and bounded resource use. The state machine adds unnecessary state;
the cursor changes callers. Second review requires tracking only pending acquisition,
never awaiting a generator suspended at yield. Clear inventory on disposal, keep
diagnostic counters, reject a second active reader, preserve sequential reuse, and
mark failed writes or unreconciled inventories incomplete. These checks need no
cap increases, dependencies or new public configuration.

Follow-up order: source/configuration identity; complete provider scope support; unresolved
call retention; immutable seed publication; dependency closure and parity; navigation
activation. Each needs its own verified owner packet. No performance improvement is
claimed without measurements.

## Execution Evidence

OntoIndex stale/degraded: Transport closed; source inspection is authority.
Four read-only reviewers dispatched; inventory review interrupted accidentally and
no findings accepted from it. Source and test development use Sol medium separately.
Validation budget: two focused suite invocations and two production typechecks.

## Closeout

Implementation and focused validation passed. Manager closeout follows the recorded
main-session evidence. Broader navigation remains successor work.
