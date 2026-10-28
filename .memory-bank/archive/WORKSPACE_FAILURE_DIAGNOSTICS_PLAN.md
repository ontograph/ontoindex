# Workspace failure diagnostics

Date: 2026-10-24
Status: Closed
Authority: User proceed; ADR_WORKSPACE_FAILURE_DIAGNOSTICS.md

## Goal

Workspace build failures expose safe phase and cause classifications through MCP,
including cached responses, without changing preparation or retry policy.

## Manager Tracking

```yaml
manager_loop:
  authority: true
  status: closed
  selection_policy: active_next_task-first
  active_next_task: null
  max_in_flight: 1
  dispatch_mode: sub-agent
  dispatch_preflight:
    required_roles:
      coder-worker:
        agent_type_candidates:
        - coder-worker
        - cdr-worker
        model_candidates:
        - gpt-6-luna
        - gpt-6.1-sol
        reasoning_effort: high
      coder-worker-test-challenger:
        agent_type_candidates:
        - coder-worker-test-challenger
        - cdr-worker-test-challenger
        model: gpt-6.1-sol
        reasoning_effort: xhigh
      coder-manager:
        agent_type_candidates:
        - coder-manager
  last_decision: dispatched
  reopen_gate: null
tasks:
  DIAG-1:
    title: Build failures preserve safe phase and reason through cached MCP responses
    status: DONE
    classification: implementation-ready
    assurance_profile: full
    complexity: complex
    depends_on: []
    type: code
    validation_tier: unit-fast
    impact_risk: medium
    owner_files:
    - ontoindex/src/mcp/local/local-backend-repo-runtime.ts
    - ontoindex/src/mcp/local/local-backend.ts
    - ontoindex/src/mcp/server.ts
    - ontoindex/test/unit/local-backend-repo-runtime.test.ts
    - ontoindex/test/unit/calltool-dispatch.test.ts
    - ontoindex/test/unit/mcp-server-error-path.test.ts
    allowed_write_set:
    - ontoindex/src/mcp/local/local-backend-repo-runtime.ts
    - ontoindex/src/mcp/local/local-backend.ts
    - ontoindex/src/mcp/server.ts
    - ontoindex/test/unit/local-backend-repo-runtime.test.ts
    - ontoindex/test/unit/calltool-dispatch.test.ts
    - ontoindex/test/unit/mcp-server-error-path.test.ts
    non_goals:
    - Cache identity or cooldown changes; size limits; build supervisor edits; deployment; reindex
    - Changes to unrelated dirty files or global formatting
    required_validation:
    - ONTOINDEX_TEST_WORKERS=1 ./node_modules/.bin/vitest run test/unit/local-backend-repo-runtime.test.ts test/unit/calltool-dispatch.test.ts test/unit/mcp-server-error-path.test.ts test/integration/committed-navigation-sdk.test.ts
    - ./node_modules/.bin/tsc --noEmit --incremental false
    - git diff --check -- ontoindex/src/mcp/local/local-backend-repo-runtime.ts ontoindex/src/mcp/local/local-backend.ts ontoindex/src/mcp/server.ts ontoindex/test/unit/local-backend-repo-runtime.test.ts ontoindex/test/unit/calltool-dispatch.test.ts ontoindex/test/unit/mcp-server-error-path.test.ts
    expected_evidence:
    - 'Scenario: Given planning, lock, recheck, build, release or verification fails; when navigation returns or reuses a cached failure; then fixed allowlisted diagnostics survive backend and MCP serialization with no private text and retryable false.'
    - Implement the exact additive contract in ADR_WORKSPACE_FAILURE_DIAGNOSTICS.md; no new modules or dependencies
    - Initial and cached build diagnostics are equal; typed supervisor kind and immediate allowlisted errno survive while unknown text remains private
    - Existing size diagnostics and cooldown recovery tests pass; eligible build failures offer explicit committed fallback and unsupported operations do not
    - Preserve concurrent changes; you are not alone in this codebase; stop on conflicts
    - Parent already ran committed impact on prepareWorkspaceRead LOW, workspacePreparationError LOW, formatToolCallErrorMessage LOW and WorkspacePreparationError MEDIUM; graph HEAD matches but dirty source is authoritative
    - User approved one additional suite and one typecheck after reconciliation; consumed 5 suites and 3 typechecks; amended ceilings 6 suites and 4 typechecks; serial validation only
    - Run vitest and tsc with tool workdir /opt/d1/_wrk/ontoindex/ontoindex; record exact simple commands and terminal exits; no cd shell prefix
    - Review current input_refused additions and all six scoped files before validation; capture hashes before and after checks; preserve concurrent changes
    rollback:
    - Remove only this task's additive diagnostics and tests without reverting existing dirty changes
    stop_conditions:
    - Write scope expansion or concurrent conflict
    - Six total suite invocations or four total typechecks exhausted
    known_blockers: []
    dispatch:
      role: coder-worker-test-challenger
      attempts: 0
      dispatch_id: 567545cf-c4ae-4eb5-94cc-d900b74a93e1
      scope_sha256: 80d6d2f22b7e306c388aaefbe9cd3bbef7bd1c5958c7a85797785dcdaad8c4c1
      lease_state: result-accepted
      preflight_result: pass
      dispatched_at: '1792828734590'
      assigned_agent: 01a16ceb-7c3a-7610-b65b-2213b89b39f5
      agent_type_requested: cdr-worker-test-challenger
      model_requested: current-session
      model_effective: gpt-6-astra
      route_attempts: 1
      wait_state: null
      blocker_fingerprint: null
      terminal_classification: null
      last_progress_revision: 9515afb4b28585706eccb2ff12a4b517284e4fd2daa6c775c631000a58e15b3f
      result_receipt_id: null
      result_verdict: null
      result_blocker: null
    closeout:
      role_results:
      - role: cdr-worker
        agent_id: 01a16cd6-c27a-7302-ad7d-dcd4b0338d8f
        effective_model: gpt-6.1-sol
        receipt_id: role-result-b75ffafa572d9a8c885f21edf9609b05f6c62526a88ef4c5f059c8f3a4096b81
        verdict: PASS
      - role: cdr-worker-test-challenger
        agent_id: 01a16ceb-7c3a-7610-b65b-2213b89b39f5
        effective_model: gpt-6-astra
        receipt_id: role-result-a06f5ff07f68d3309c1e479a8060b1df8409c7f43280eae8c478f919f5fcdfcd
        verdict: PASS
    dod_status: pass
```

## Required Traceability

| Requirement ID | ADR/user requirement | Disposition | Task IDs | Validation |
| --- | --- | --- | --- | --- |
| REQ-001 | Safe actionable build diagnostics and cached parity | implementation | DIAG-1 | Runtime and MCP tests |
| REQ-002 | Explicit supported committed fallback and unchanged preparation policy | implementation | DIAG-1 | Dispatch and committed SDK tests |

## Decisions And Non-Goals

Two read-only discovery agents reviewed the existing owners before implementation.
The worker and independent challenger complete the four-agent requirement.
No historical cause attribution or corpus recount is included.

## Closeout

### Accepted completion

DIAG-1 completed through authenticated worker and challenger integration.
Challenger receipt `role-result-a06f5ff07f68d3309c1e479a8060b1df8409c7f43280eae8c478f919f5fcdfcd`
was accepted and integrated. All four test files passed (328 tests); TypeScript
and scoped diff checks exited 0. Thirteen input hashes were identical before
and after validation. No blocking semantic findings remained. The concurrent
`input_refused` behavior was reviewed and its compatibility note added to the ADR.
Final usage is 6 suite invocations and 4 typechecks, within amended ceilings;
the earlier 5-versus-4 suite overrun remains recorded below. No deployment or
commit was performed. Runtime manager status is closed with no active next task.

### Authorized reopening

The user's latest `proceed` approves option 1: review intervening changes and
run one additional focused suite and one typecheck through a fresh independent
challenger. Original limits remain 4 suites and 3 typechecks; observed usage is
5 and 3, including the recorded suite overrun. New ceilings are 6 and 4. This
single additional allocation belongs to the next challenger only. Commands now
use tool working-directory arguments, preserving their exact receipt identity.
No product edits, deployment, or automatic further retries are authorized by
this amendment.

### Historical validation reconciliation, superseded by accepted completion

At reconciliation, implementation remained open. The accepted worker receipt is recorded above;
the challenger receipt was rejected with `EXEC_EVIDENCE_NO_RECEIPT` after a
format-only correction. No additional correction or test execution was started.

Saved structured tool records establish five suite invocations against the
declared four-run budget: the initial Luna worker ran three (two failures, then
297 passing tests), the recovery worker ran one (326 passing tests), and the
challenger ran one (326 passing tests). All three agents ran one typecheck;
terminal outputs show exit 0. Usage is therefore 5/4 suites and 3/3 typechecks.
The suite budget was exceeded before this reconciliation.

Evidence: session files under `/opt/d2/.ontocode/sessions/2026/10/24/` ending in
`01a16ccc-f607-71c2-b254-9ee665133eb6.jsonl` (suite results at lines 187, 203,
232), `01a16cd6-c27a-7302-ad7d-dcd4b0338d8f.jsonl` (suite result at line 84,
typecheck exit at line 97), and `01a16cdd-e6f1-7902-8a8f-5b6ed982bac2.jsonl`
(suite result at line 56, typecheck exit and file hashes at line 67).
These saved outputs establish executions; they do not repair the rejected
authenticated challenger receipt.

At that reconciliation, SHA-256 checks differed from the challenger's recorded hashes for runtime,
server, runtime tests, and server error-path tests. Backend and dispatch-test
hashes match. Current source includes additional `input_refused` handling absent
from the reviewed snapshot. Authorship was not established; concurrent edits
were preserved. Earlier passing results cannot establish current-tree coverage.

At that point, reopening required an explicit validation-budget increase, review of intervening
changes, and runtime-supported challenger dispatch with commands recorded exactly
as executed (use tool working-directory arguments instead of `cd &&`). Accepted
completion above subsequently satisfied that gate with fresh validation.

### Review qualification

The final challenger receipt was accepted on gpt-6-astra despite the declared
gpt-6.1-sol preflight. Acceptance did not establish compliance with the intended
model route. The follow-up records explicit Sol-medium development and source
review. This plan completed diagnostics delivery, not historical incident
resolution or a measured preparation-performance improvement.

