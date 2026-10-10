# Hook additionalContext Transaction Barrier Project Plan

Date: 2026-10-10
Status: Closed (moved out: targets the ontocode repo, not ontoindex; tasks never started)
Authority: Confirmed correctness defect; no ADR needed (reuses existing active-call accounting and the existing provider boundary rejection).

## Goal

Hook-emitted `additionalContext` never splits a tool call from its output in the provider request history.

## Manager Tracking

```yaml
manager_loop:
  authority: true
  status: closed
  selection_policy: active_next_task-first
  active_next_task: TASK-1
  max_in_flight: 1
  dispatch_mode: human

tasks:
  TASK-1:
    title: When a tool batch has parallel calls, additionalContext is flushed in emission order only after every call in the batch is terminal
    status: OPEN
    classification: implementation-ready
    assurance_profile: full
    complexity: complex
    depends_on: []
    type: code
    validation_tier: integration
    impact_risk: high
    owner_files:
      - ontocode-rs/core/src/hook_runtime.rs
      - ontocode-rs/core/src/session/turn_context.rs
      - ontocode-rs/core/src/tools/parallel.rs
      - ontocode-rs/core/src/tools/registry.rs
      - ontocode-rs/core/tests/suite/hooks.rs
    allowed_write_set:
      - ontocode-rs/core/src/hook_runtime.rs
      - ontocode-rs/core/src/session/turn_context.rs
      - ontocode-rs/core/src/tools/parallel.rs
      - ontocode-rs/core/src/tools/registry.rs
      - ontocode-rs/core/tests/suite/hooks.rs
    non_goals:
      - Repairing legacy or persisted request history (TASK-2).
      - Changing client.rs, the provider adapter, or the wire shape.
      - Adding a new scheduler, queue service, or context pipeline.
    required_validation:
      - CARGO_BUILD_JOBS=4 just compiler-lane -- just test -p ontocode-core --test all suite::hooks
      - git diff --check on the write set
    expected_evidence:
      - Impact on record_additional_contexts and the dispatch terminal-outcome path recorded before edits.
      - hooks.rs tests prove per-batch queueing, output persisted as each call terminates, flush only after the whole batch is terminal, emission order kept under out-of-order completion, and failure/cancel/synthesized-output cases.
    rollback:
      - Revert the write-set files.
    stop_conditions:
      - Write set must grow beyond the listed files.
      - Fix requires changing client.rs or the provider adapter.
      - Emission order cannot be kept without a new side stack.
    known_blockers: []

  TASK-2:
    title: When history has a hook developer message splitting a call from its unique output, the adapter repairs it, and ambiguous boundaries still fail closed with InvalidRequest
    status: OPEN
    classification: implementation-ready
    assurance_profile: full
    complexity: complex
    depends_on: [TASK-1]
    type: code
    validation_tier: unit-fast
    impact_risk: high
    owner_files:
      - ontocode-rs/core/src/client.rs
      - ontocode-rs/core/src/client_tests.rs
    allowed_write_set:
      - ontocode-rs/core/src/client.rs
      - ontocode-rs/core/src/client_tests.rs
    non_goals:
      - Repairing arbitrary or ambiguous boundary crossings.
      - Weakening the existing fail-closed rejection.
      - Changing live turn emission (TASK-1).
    required_validation:
      - CARGO_BUILD_JOBS=4 just compiler-lane -- just test-fast -p ontocode-core --lib adapt_responses_input
      - git diff --check on the write set
    expected_evidence:
      - Impact on adapt_responses_input_for_openai_compatible_provider recorded before edits.
      - client_tests.rs proves repair for legacy and parallel histories and unchanged InvalidRequest errors for ambiguous or arbitrary boundaries.
    rollback:
      - Revert client.rs and client_tests.rs.
    stop_conditions:
      - Repair would need to accept ambiguous or arbitrary boundaries.
      - The fail-closed rejection would have to be relaxed.
    known_blockers: []
```

## Required Traceability

| Requirement ID | ADR/user requirement | Disposition | Task IDs | Validation |
| --- | --- | --- | --- | --- |
| HAB-001 | Queue additionalContext per emitted tool batch | implementation | TASK-1 | hooks.rs batch queue |
| HAB-002 | Persist tool outputs as calls terminate | implementation | TASK-1 | hooks.rs terminal persist |
| HAB-003 | Flush contexts only after the batch is terminal | implementation | TASK-1 | hooks.rs flush barrier |
| HAB-004 | Keep emission order under out-of-order parallel completion | implementation | TASK-1 | hooks.rs ordering |
| HAB-005 | Cover failure, cancel, synthesized-output cases | implementation | TASK-1 | hooks.rs failure/cancel |
| HAB-006 | Leave provider adapter behavior unchanged in TASK-1 | compatibility-test | TASK-1 | client.rs untouched |
| HAB-007 | Repair only unambiguous hook-generated splits | implementation | TASK-2 | client_tests.rs repair |
| HAB-008 | Keep fail-closed rejection for ambiguous boundaries | compatibility-test | TASK-2 | client_tests.rs rejection |
| HAB-009 | Cover legacy and parallel histories | implementation | TASK-2 | client_tests.rs histories |

## Decisions And Non-Goals

- No parallel scheduler, registry, router, or side stack; existing owners suffice.
- No change to public API, persistence, security posture, or provider wire contract.

## Closeout

