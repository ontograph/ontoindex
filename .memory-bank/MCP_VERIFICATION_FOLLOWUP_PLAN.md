# MCP verification and workspace implementation follow-up

Date: 2026-10-21
Status: Closed (SDK verification and ADR scope)
Authority: User requested challenged consolidated plan and execution

## Goal

Prove public MCP contracts in disposable fixtures and retain an executable successor for bounded workspace relationships.

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
  API-1:
    title: Public MCP analyzer and suggestion contracts
    status: DONE
    classification: implementation-ready
    assurance_profile: full
    complexity: standard
    depends_on: []
    type: test
    validation_tier: unit-fast
    impact_risk: low
    owner_files:
    - ontoindex/test/integration/mcp-resource-errors-sdk.test.ts
    allowed_write_set:
    - ontoindex/test/integration/mcp-resource-errors-sdk.test.ts
    non_goals:
    - No cap increases or silent stale graph fallback
    required_validation:
    - cd ontoindex && ONTOINDEX_TEST_WORKERS=1 ./node_modules/.bin/vitest run test/integration/mcp-resource-errors-sdk.test.ts
    expected_evidence:
    - Real SDK response assertions and deterministic fixture cleanup
    rollback:
    - Revert only this task's new hunks
    stop_conditions:
    - Production behavior or write set must expand
    known_blockers: []
    closeout:
      role_results:
        coder-manager: null
      main_session_evidence:
        authorized_by: user
        authorization_ref: User requested reviewed consolidated plan and execution
        validation_summary: SDK fault aliases, empty boundary evidence and evidence-derived test suggestions passed. Combined 17 tests and TypeScript passed exit 0.
    dod_status: pass
  LIFE-1:
    title: Disposable public MCP lifecycle success and stale refusal
    status: DONE
    classification: implementation-ready
    assurance_profile: full
    complexity: standard
    depends_on: []
    type: test
    validation_tier: unit-fast
    impact_risk: low
    owner_files:
    - ontoindex/test/integration/audit-lifecycle-mcp.test.ts
    allowed_write_set:
    - ontoindex/test/integration/audit-lifecycle-mcp.test.ts
    non_goals:
    - No cap increases or silent stale graph fallback
    required_validation:
    - cd ontoindex && ONTOINDEX_TEST_WORKERS=1 ./node_modules/.bin/vitest run test/integration/audit-lifecycle-mcp.test.ts
    expected_evidence:
    - Real SDK response assertions and deterministic fixture cleanup
    rollback:
    - Revert only this task's new hunks
    stop_conditions:
    - Production behavior or write set must expand
    known_blockers: []
    closeout:
      role_results:
        coder-manager: null
      main_session_evidence:
        authorized_by: user
        authorization_ref: User requested reviewed consolidated plan and execution
        validation_summary: Disposable cold lifecycle bundle and dispatch succeeded; HEAD drift refused with unchanged dispatch events. Combined 17 tests and TypeScript passed exit 0.
    dod_status: pass
  SEED-1:
    title: Resolution seed implementation packet and ADR amendment
    status: DONE
    classification: docs/design-only
    assurance_profile: full
    complexity: standard
    depends_on: []
    type: design-gate
    validation_tier: unit-fast
    impact_risk: low
    owner_files:
    - .memory-bank/ADR_AUTOMATIC_DIRTY_WORKSPACE.md
    allowed_write_set:
    - .memory-bank/ADR_AUTOMATIC_DIRTY_WORKSPACE.md
    non_goals:
    - No cap increases or silent stale graph fallback
    required_validation:
    - project_plan_validate .memory-bank/MCP_VERIFICATION_FOLLOWUP_PLAN.md
    expected_evidence:
    - Versioned complete seed and coherent snapshot acceptance before runtime activation
    rollback:
    - Revert only this task's new hunks
    stop_conditions:
    - Production behavior or write set must expand
    known_blockers: []
    closeout:
      role_results:
        coder-manager: null
      main_session_evidence:
        authorized_by: user
        authorization_ref: User requested reviewed consolidated plan and execution
        validation_summary: ADR amended to stage complete seed ownership and preserve runtime correctness gates. Combined 17 tests and TypeScript passed exit 0.
    dod_status: pass
```

## Decisions and review

Retain rc.9 test-gap repair as a bounded reachability result. Missing docs evidence remains explicit. Three alternatives were reviewed twice: repeat live inventory, disposable public MCP regressions, or immediate relationship engine implementation. Select reusable disposable fixtures for public execution coverage and a staged seed contract for the engine. Repeated live calls add weak coverage; immediate engine work lacks persisted resolution ownership. Preserve full dependency correctness, resource bounds and committed provenance.

## Required Traceability

| Requirement ID | Requirement | Disposition | Task IDs | Validation |
| --- | --- | --- | --- | --- |
| MCP-001 | Corrected analyzer invocations | implementation | API-1 | SDK assertions |
| MCP-002 | Lifecycle refusal does not dispatch | implementation | LIFE-1 | Disposable stale-session assertion |
| MCP-003 | Executable engine successor | architecture-gate | SEED-1 | Reviewed seed contract |

## Evidence

Development agents develop_contract_sdk and develop_audit_sdk use gpt-6.1-sol medium with disjoint test files. Parent owns validation: tests 2/2, one typecheck, no builds or live launches. OntoIndex freshness failed Transport closed; source inspection is authority. No automatic refresh or unchanged retries.


Final validation: first analyzer SDK run passed 8 tests; combined run passed 17 tests across two files. TypeScript exit 0. No production runtime files changed; no builds, installs, reindexing or live requests. Resource-budget refusal, session listing and broader lifecycle coverage remain untested. Engine implementation remains a separate production deliverable.
