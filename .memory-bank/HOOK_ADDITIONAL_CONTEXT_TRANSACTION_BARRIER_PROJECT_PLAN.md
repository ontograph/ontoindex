# Hook additionalContext Transaction Barrier And Diagnostics Separation Project Plan
Date: 2026-07-23
Status: Open tracking plan
Audience: coder-manager and coder-* sub-agents (sub-agent dispatch mode)
Authority: This tracking file. No ADR required (see Planning Principles); reuses
existing active-call accounting and existing provider boundary rejection.

## Manager Tracking

```yaml
manager_loop:
  status: in-progress
  active_next_task: TASK-1
  selected_task: null
  no_selected_task_reason: null
  last_decision:
    outcome: null
    label: null
    reason: null
    planning_work_considered: false
    reopen_gate: null
  closeout_state: in-progress
  dispatch_mode: sub-agent
  selection_policy: active_next_task-first
  auto_continue: until-stop-condition
  dispatch_preflight:
    tool_surface: unchecked
    child_capability_probes: {}
    required_roles:
      coder-architector:
        agent_type_candidates: [coder-architector, worker]
        local_fallback_allowed: false
        required_for: [dor-dod-adr-gate, paperwork, readiness, closeout]
      coder-worker:
        agent_type_candidates: [coder-worker, worker]
        local_fallback_allowed: false
        required_for: [implementation]
      coder-worker-test:
        agent_type_candidates: [coder-worker-test, worker]
        local_fallback_allowed: false
        required_for: [verification]
      coder-worker-challenger:
        agent_type_candidates: [coder-worker-challenger, worker]
        local_fallback_allowed: false
        required_for: [challenge]
    fork_context: false
    unavailable_outcome: "blocked: model/capacity"
  ontoindex:
    required: true
    status: dirty
    unavailable_action: direct-source-fallback
    tools_used:
      - gn_ensure_fresh(repo=ontoindex)
    limitations:
      - OntoIndex indexes the OntoIndex repo (label `ontoindex`); the ontocode
        crate (PACKET-1/PACKET-2) is not covered, so ontocode owner boundaries
        were verified by direct source inspection.
      - OntoIndex worktree is dirty (24 files, scopeConfidence medium); index
        head matches commit but graph metadata for impacted symbols is treated
        as advisory. Each worker must rerun impact/inspection before edits.
    source_fallback:
      - ontocode-rs/core/src/hook_runtime.rs:598 (record_additional_contexts)
      - ontocode-rs/core/src/tools/parallel.rs:100 (terminal_outcome accounting)
      - ontocode-rs/core/src/client.rs:976 (adapt_responses_input_for_openai_compatible_provider)
      - ontocode-rs/core/src/client.rs:1123 (developer/user boundary rejection)
      - ontoindex/hooks/claude/ontoindex-hook.cjs:247 (stderr piped into result)
      - ontoindex/hooks/claude/ontoindex-hook.cjs:266 (result -> additionalContext)
    fallback_evidence:
      - "hook_runtime.rs:603 record_additional_contexts records developer messages immediately; no per-batch queue/flush barrier exists today."
      - "client.rs:1123-1139 already fail-closed rejects function-call-output boundary crossings; PACKET-2 must preserve this."
      - "ontoindex-hook.cjs:247 sets result = child.stderr; line 266 emits it as additionalContext, mixing diagnostics into provider-visible context."

tasks:
  TASK-1:
    title: Turn-scoped tool transaction barrier for hook additionalContext
    status: OPEN
    classification: implementation-ready
    dor_status: pass
    dod_status: pending
    depends_on: []
    owner: coder-worker
    reviewer: coder-worker-challenger
    type: code
    validation_tier: integration
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
    target_symbols:
      - record_additional_contexts
      - additional_context_messages
      - dispatch_any_with_terminal_outcome
      - dispatch_tool_call_with_terminal_outcome
    do_not_touch:
      - ontocode-rs/core/src/client.rs
      - provider request adapter (adapt_responses_input_for_openai_compatible_provider)
    non_goals:
      - Repairing legacy/persisted request history (PACKET-2 owns that).
      - Changing provider adapter behavior or wire shape.
      - Adding a new scheduler, queue service, or context pipeline abstraction.
    source_evidence:
      - ontocode-rs/core/src/hook_runtime.rs:598-618
      - ontocode-rs/core/src/tools/parallel.rs:86-160
      - ontocode-rs/core/tests/suite/hooks.rs
    readiness_gaps: []
    gap_resolution_task: null
    gap_disposition: not-applicable
    paperwork_kind: null
    test_surface_gap: null
    adr_gate:
      required: false
      reason: >-
        Bounded correctness repair over existing active-call accounting
        (terminal-outcome tracking) and existing additionalContext recording.
        No public API, persistence, security posture, provider, or cross-owner
        boundary change.
      adr_path: null
      status: not-needed
      decision_owner: coder-architector
      allowed_write_set: []
      unblocks: []
      promotion_rule: null
      missing_adr_outcome: create-planning-task
    dispatch:
      role: coder-worker
      assigned_agent: null
      model_requested: null
      model_effective: null
      preflight_result: not-run
      local_fallback_allowed: false
      local_fallback_scope: null
      attempts: 0
      max_attempts: 3
      required_capabilities: [repository-read, repository-write, shell-execute]
      dispatch_kind: implementation
      wait_state: null
      blocker_fingerprint: null
      last_progress_revision: null
    validation:
      required_commands:
        - "CARGO_BUILD_JOBS=4 just compiler-lane -- just test -p ontocode-core --test all suite::hooks"
      executed: []
      diff_scope: []
      unrelated_failures: []
    required_validation:
      - "CARGO_BUILD_JOBS=4 just compiler-lane -- just test -p ontocode-core --test all suite::hooks"
    expected_evidence:
      - Impact rerun on record_additional_contexts and dispatch terminal-outcome
        path recorded before edits (CRITICAL/HIGH radius noted).
      - New/updated tests in tests/suite/hooks.rs prove that contexts are queued
        per emitted tool batch, outputs persisted as calls terminate, contexts
        flushed only after all calls in the batch are terminal, emission-order
        preserved, out-of-order parallel completion covered, and
        failure/cancel/synthesized-output cases covered.
      - git diff --check clean on the write set.
    rollback:
      - Revert the five write-set files.
    stop_conditions:
      - Write set must expand beyond the five listed files.
      - Fix requires changing the provider adapter or client.rs.
      - Barrier cannot preserve emission order without a new side stack.
    closeout_evidence: []
    evidence: []
    known_blockers: []
    closeout:
      role_results:
        coder-architector: null
        coder-worker: null
        coder-worker-test: null
        coder-worker-challenger: null
        coder-auditor: null
      changed_files: []
      validation_summary: []
      evidence_refs: []
      final_outcome_label: null
      remaining_risk: null
    next_on_done: [TASK-2]

  TASK-2:
    title: Narrow legacy request-history repair for split hook developer messages
    status: OPEN
    classification: implementation-ready
    dor_status: pass
    dod_status: pending
    depends_on: [TASK-1]
    owner: coder-worker
    reviewer: coder-worker-challenger
    type: code
    validation_tier: unit-fast
    owner_files:
      - ontocode-rs/core/src/client.rs
      - ontocode-rs/core/src/client_tests.rs
    allowed_write_set:
      - ontocode-rs/core/src/client.rs
      - ontocode-rs/core/src/client_tests.rs
    target_symbols:
      - adapt_responses_input_for_openai_compatible_provider
    do_not_touch:
      - ontocode-rs/core/src/hook_runtime.rs
      - ontocode-rs/core/src/session/turn_context.rs
      - ontocode-rs/core/src/tools/parallel.rs
    non_goals:
      - Repairing arbitrary or ambiguous call/output boundary crossings.
      - Removing or weakening the existing fail-closed rejection.
      - Changing live (post-TASK-1) turn emission behavior.
    source_evidence:
      - ontocode-rs/core/src/client.rs:976 (adapter entry)
      - ontocode-rs/core/src/client.rs:1100-1140 (boundary rejection branches)
      - ontocode-rs/core/src/client_tests.rs
    readiness_gaps: []
    gap_resolution_task: null
    gap_disposition: not-applicable
    paperwork_kind: null
    test_surface_gap: null
    adr_gate:
      required: false
      reason: >-
        Repairs only unambiguous hook-generated developer messages that split a
        function call from its unique matching output; the existing fail-closed
        rejection for arbitrary/ambiguous boundaries is preserved. No API,
        persistence, security, or wire-contract change.
      adr_path: null
      status: not-needed
      decision_owner: coder-architector
      allowed_write_set: []
      unblocks: []
      promotion_rule: null
      missing_adr_outcome: create-planning-task
    dispatch:
      role: coder-worker
      assigned_agent: null
      model_requested: null
      model_effective: null
      preflight_result: not-run
      local_fallback_allowed: false
      local_fallback_scope: null
      attempts: 0
      max_attempts: 3
      required_capabilities: [repository-read, repository-write, shell-execute]
      dispatch_kind: implementation
      wait_state: null
      blocker_fingerprint: null
      last_progress_revision: null
    validation:
      required_commands:
        - "CARGO_BUILD_JOBS=4 just compiler-lane -- just test-fast -p ontocode-core --lib adapt_responses_input"
      executed: []
      diff_scope: []
      unrelated_failures: []
    required_validation:
      - "CARGO_BUILD_JOBS=4 just compiler-lane -- just test-fast -p ontocode-core --lib adapt_responses_input"
    expected_evidence:
      - Impact rerun on adapt_responses_input_for_openai_compatible_provider
        (CRITICAL, 28 upstream nodes) recorded before edits.
      - client_tests.rs proves repair of a single unambiguous split (legacy
        history and parallel history) and proves ambiguous/arbitrary boundaries
        still return the existing InvalidRequest fail-closed errors.
      - git diff --check clean on the write set.
    rollback:
      - Revert client.rs and client_tests.rs.
    stop_conditions:
      - Repair would need to accept ambiguous or arbitrary boundaries.
      - Existing fail-closed rejection would have to be removed or relaxed.
      - TASK-1 is not DONE (dependency gate).
    closeout_evidence: []
    evidence: []
    known_blockers:
      - Blocked until TASK-1 is DONE; unblock rule TASK-1.status == DONE with
        recorded validation and changed-file evidence.
    closeout:
      role_results:
        coder-architector: null
        coder-worker: null
        coder-worker-test: null
        coder-worker-challenger: null
        coder-auditor: null
      changed_files: []
      validation_summary: []
      evidence_refs: []
      final_outcome_label: null
      remaining_risk: null
    next_on_done: []
```

## Dispatch Authorization

Sub-agent dispatch is authorized for the four coder roles named in
`dispatch_preflight.required_roles`. `coder-architector` is the sole paperwork,
readiness, and closeout writer. `coder-worker` implements exactly one bounded
task and edits only that task's `allowed_write_set`. No local fallback is
allowed for any role.

## Dispatch Preflight

Before substantive sub-agent work, cache one non-mutating capability probe per
role/effective-model/tool-surface tuple. A successful parent spawn does not
prove child file-read, shell-execute, or OntoIndex callability. Missing child
capability is `blocked: capability unavailable`.

## Goal

Repair a confirmed correctness defect in the ontocode repo: hook-emitted
`additionalContext` and the provider request history can interleave incorrectly
with tool call/output accounting. This plan delivers the two dependent
ontocode-repo packets (TASK-1 turn-scoped barrier, TASK-2 legacy history
repair) as dispatch-ready tasks with explicit DoR, DoD, dependencies, allowed
write sets, validation tiers, stop conditions, and closeout fields. The
independent OntoIndex-repo hook packet (PACKET-3) is tracked in its own plan,
`ONTOINDEX_HOOK_AUGMENTATION_DIAGNOSTICS_SEPARATION_PROJECT_PLAN.md`.

## Planning Principles

No ADR is required for any task. Each packet reuses existing owners and existing
accounting rather than introducing new architecture:

- TASK-1 reuses the existing terminal-outcome accounting in
  `tools/parallel.rs` and the existing `record_additional_contexts` recording
  path in `hook_runtime.rs`; it adds a turn-scoped barrier, not a new pipeline.
- TASK-2 keeps the existing fail-closed boundary rejection in
  `adapt_responses_input_for_openai_compatible_provider` and only narrows repair
  to unambiguous hook-generated splits.

None of the packets change public API, persistence, security posture, provider
wire contract, MCP behavior, or cross-owner boundaries, so the ADR authority
condition is not triggered. If a worker finds the fix cannot be done without
such a change, it must stop and route back to `coder-architector` per each
task's stop conditions rather than expanding scope. Reject any parallel
implementation, registry, router, scheduler, or side stack: the existing owners
can accommodate all three repairs.

## Current Source Evidence

- record_additional_contexts is CRITICAL upstream (33 nodes / 6 direct callers /
  run_turn affected). Verified at hook_runtime.rs:598; it records developer
  messages immediately with no per-batch queue/flush barrier.
- dispatch_any_with_terminal_outcome is HIGH (56 upstream nodes); the
  terminal-outcome accounting lives at parallel.rs:100-160.
- adapt_responses_input_for_openai_compatible_provider is CRITICAL (28 upstream
  nodes) at client.rs:976; the fail-closed boundary rejection is at
  client.rs:1123-1139 and must be preserved.
- OntoIndex hook defect: ontoindex-hook.cjs:247 assigns `result = child.stderr`
  and line 266 emits it as `additionalContext`.
- ontocode was observed clean; OntoIndex worktree is dirty (24 files). PACKET-3
  (tracked separately) is unaffected; its write-set files are not among the
  dirty set.
- OntoIndex graph metadata is degraded/dirty; direct source inspection is
  authoritative and every worker must rerun impact before edits.

## Task Preparation Rules

All three task cards are normalized with owner files, allowed write set,
non-goals, validation, rollback, stop conditions, DoR, DoD, and evidence format.
No metadata gap, ADR gate, or proof gap remains, so no preparation sub-task is
created.

## Execution Rules

Edit only the selected task's `allowed_write_set`; implement exactly one bounded
task; use OntoIndex/impact before editing symbols and record blast radius; do
not add duplicate schedulers, routers, registries, or side stacks; if the write
set must expand, stop and update the task card first; run focused validation and
update tracking only after evidence exists.

## Validation Tier Policy

- TASK-1: `integration` — the barrier's ordering/terminal-flush behavior is
  proven by the cross-cutting suite test at `tests/suite/hooks.rs`, which the
  fast unit tier cannot prove.
- TASK-2: `unit-fast` — the repair is provable by crate-local behavior tests in
  `client_tests.rs` (a `#[path]`-included lib test module).

PACKET-3 (independent OntoIndex hook repair) is tracked in its own single-task
plan, `ONTOINDEX_HOOK_AUGMENTATION_DIAGNOSTICS_SEPARATION_PROJECT_PLAN.md`,
because it shares no dependency or write set with TASK-1/TASK-2 and lives in a
different repository.

## Evidence Protocol

Every task records changed files, exact validation commands, pass/fail results,
source references, OntoIndex limitations or fallback checks, and confirmation
that no generated binaries, logs, caches, archives, or temp files were added.
Code tasks additionally record impact/context for edited symbols (or why
unavailable), before/after behavior, rollback path, and reviewer result.

## Definition Of Ready

Each task names one bounded file group, an explicit type and output artifact,
exact validation commands, rollback, non-goals, target symbols, reviewer, stop
conditions, and verifiable expected evidence; `adr_gate.status` is `not-needed`
for all three; dispatch role and local-fallback policy are explicit. TASK-2 is
blocked behind its dependency with the exact unblock rule
`TASK-1.status == DONE`.

## Definition Of Done

Each task is done only when its artifact exists, work stayed inside the allowed
write set, the named validation command ran with recorded results, no generated
artifacts were added, the reviewer confirms no side architecture was added, the
result states whether the next task is unblocked, remaining risk is a concrete
follow-up, role closeout is recorded for every required role, and the final
outcome label matches the loop result.

## Fixtures And Test Data

Fixtures: not applicable. This plan does not use runtime fixtures. Tests use
in-test constructed histories/tool batches (Rust) and controlled stdin JSON to
spawned hook processes (vitest).

## Senior-Owned Work

Pre-junior contributors must not: change the provider wire contract or boundary
rejection semantics, change public API/config/persistence/security surfaces,
alter lifecycle/threading beyond the bounded barrier, delete active legacy
paths, or declare parity/runtime readiness. Any such need stops the task and
routes to `coder-architector`.

## Phase 1: Live Turn Barrier

### Task TASK-1: Turn-scoped tool transaction barrier

Type: code. Status: OPEN. Queue PreToolUse/PostToolUse additionalContext per
emitted tool batch, persist outputs as calls terminate, flush contexts only
after all calls in the batch are terminal, preserve emission-order contexts,
cover out-of-order parallel completion and failure/cancel/synthesized-output
cases, and preserve the provider adapter. Validation: the `tests/suite/hooks.rs`
integration test. See the `tasks.TASK-1` card for the dispatch-ready contract.

## Phase 2: Legacy History Repair

### Task TASK-2: Narrow legacy request-history repair

Type: code. Status: OPEN (blocked behind TASK-1). Repair only unambiguous
hook-generated developer messages that split a call from its unique matching
output; preserve fail-closed rejection for arbitrary/ambiguous boundaries; cover
legacy and parallel histories. Validation: crate-local `client_tests.rs`. See
the `tasks.TASK-2` card.

## Required Traceability

| Requirement ID | Requirement | Disposition | Task IDs | Validation | Status |
|---|---|---|---|---|---|
| HAB-001 | Queue PreToolUse/PostToolUse additionalContext per emitted tool batch | implementation | TASK-1 | `tests/suite/hooks.rs` batch-queue coverage | OPEN |
| HAB-002 | Persist tool outputs as calls terminate | implementation | TASK-1 | `tests/suite/hooks.rs` terminal-persist coverage | OPEN |
| HAB-003 | Flush contexts only after all calls in the batch are terminal | implementation | TASK-1 | `tests/suite/hooks.rs` terminal-flush barrier coverage | OPEN |
| HAB-004 | Preserve emission-order contexts and cover out-of-order parallel completion | implementation | TASK-1 | `tests/suite/hooks.rs` ordering and parallel coverage | OPEN |
| HAB-005 | Cover failure, cancel, and synthesized-output cases | implementation | TASK-1 | `tests/suite/hooks.rs` failure/cancel/synthesized coverage | OPEN |
| HAB-006 | Preserve the provider request adapter behavior | compatibility-test | TASK-1 | Adapter left untouched; TASK-2 owns adapter repair | OPEN |
| HAB-007 | Repair only unambiguous hook-generated developer-message splits | implementation | TASK-2 | `client_tests.rs` unambiguous-split repair | OPEN |
| HAB-008 | Preserve fail-closed rejection for arbitrary/ambiguous boundaries | compatibility-test | TASK-2 | `client_tests.rs` ambiguous/arbitrary still rejected | OPEN |
| HAB-009 | Cover legacy and parallel request histories | implementation | TASK-2 | `client_tests.rs` legacy and parallel coverage | OPEN |

## Quality Gate

```yaml
quality_gate:
  unmapped_requirements: 0
  missing_task_fields: 0
  missing_acceptance_fixtures: 0
  missing_failure_routes: 0
  branch_deadlocks: 0
  dependency_errors: 0
  write_scope_errors: 0
  prose_yaml_mismatches: 0
  challenger_findings: 0
```

## Final Closeout

The project closes only when TASK-1 and TASK-2 are DONE with recorded
validation and changed-file evidence, a final `coder-worker-challenger`
planned-vs-done challenge passes, and `manager_loop.closeout_state` is set to
`complete`. Closeout must state which checklist items were proven by tests and
which required a live spawn-capable session.

## Standard Validation Commands

- TASK-1: `CARGO_BUILD_JOBS=4 just compiler-lane -- just test -p ontocode-core --test all suite::hooks`
- TASK-2: `CARGO_BUILD_JOBS=4 just compiler-lane -- just test-fast -p ontocode-core --lib adapt_responses_input`
- All: `git diff --check` on the task's write set.
