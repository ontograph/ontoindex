# Preserve module binding visibility

## Decision

Four independent source reviews found export extraction consistent with its
contract, but finalization promotes nested definitions to module bindings.
Pass existing module bindings to shared finalization. Post-processing in the
adapter duplicates import precedence; full lexical finalization expands scope.
Second review requires preserving explicit empty bindings, provider aliases,
hoisting, nested definitions and legacy standalone callers. No filtering of
localDefs, new dependency, persistent schema or provider activation is needed.
The additive field has local rollback and linear binding-copy cost. Reuse
existing bindings rather than reconstructing names or ownership. Trusted provider
objects retain their existing security boundary.

## Manager Tracking

```yaml
manager_loop:
  authority: true
  status: closed
  selection_policy: active_next_task-first
  active_next_task: null
  dispatch_mode: none
  reopen_gate: null
tasks:
  BIND-1:
    title: Preserve extracted module bindings through finalization
    status: DONE
    classification: implementation-ready
    assurance_profile: full
    complexity: complex
    depends_on: []
    type: code
    validation_tier: unit-fast
    impact_risk: medium
    owner_files:
    - ontoindex-shared/src/scope-resolution/finalize-algorithm.ts
    - ontoindex/src/core/ingestion/finalize-orchestrator.ts
    - ontoindex/test/unit/scope-resolution/finalize-algorithm.test.ts
    - ontoindex/test/unit/scope-resolution/finalize-orchestrator.test.ts
    allowed_write_set:
    - ontoindex-shared/src/scope-resolution/finalize-algorithm.ts
    - ontoindex/src/core/ingestion/finalize-orchestrator.ts
    - ontoindex/test/unit/scope-resolution/finalize-algorithm.test.ts
    - ontoindex/test/unit/scope-resolution/finalize-orchestrator.test.ts
    non_goals:
    - Provider activation lookup optimization generation publication and cap changes
    required_validation:
    - cd ontoindex-shared && ./node_modules/.bin/tsc
    - cd ontoindex && ./node_modules/.bin/tsc --noEmit
    - cd ontoindex && ONTOINDEX_TEST_WORKERS=1 ./node_modules/.bin/vitest run test/unit/scope-resolution/finalize-algorithm.test.ts test/unit/scope-resolution/finalize-orchestrator.test.ts test/unit/scope-retention.test.ts
    - git diff --check
    expected_evidence:
    - Nested declarations stay out of module bindings and remain indexed
    - Empty bindings aliases hoisting imports and retained replay preserve semantics
    - Absent optional bindings preserve standalone legacy behavior
    rollback:
    - Revert only BIND-1 hunks in declared files
    stop_conditions:
    - Requires provider activation or persisted codec changes
    known_blockers: []
    closeout:
      role_results:
        coder-worker: null
        coder-worker-test-challenger: null
      main_session_evidence:
        authorized_by: user
        authorization_ref: User requested review consolidation and implementation with Sol medium development agents
        validation_summary: Parent source review confirmed authoritative bindings and preserved definition indexes. Shared compile receipt 29e1c0 exit 0. Product typecheck session 76032 receipt 8d6394 exit 0. Focused suites session 83179 receipt 6e8fb8 exit 0 with 105 tests across three files. Four read-only reviewers and two Sol medium implementation helpers. OntoIndex Transport closed prevents graph verification. No runtime navigation claim.
    dod_status: pass
```

## Required Traceability

| Requirement ID | ADR/user requirement | Disposition | Task IDs | Validation |
| --- | --- | --- | --- | --- |
| BIND | Preserve lexical visibility through finalization | implementation | BIND-1 | Shadowing and retained replay regression |
| COMPAT | Preserve legacy callers and provider binding placement | compatibility-test | BIND-1 | Empty bindings aliases hoisting and import merge tests |

## Validation budget and evidence

Two shared compiles, two product typechecks and two focused suite runs maximum;
serial parent validation. Helpers run none. No release, install or runtime launch.
OntoIndex freshness returned Transport closed; source inspection is authority.
Transport retry and graph claims are unavailable this turn. Four Sol medium
reviewers completed; two disjoint Sol medium development packets follow.
Knowledge handoff: none; existing receipt and degradation rules cover findings.

## Consolidated sequence

1. BIND-1: repair demonstrated lexical visibility loss.
2. Index repeated finalizer lookups using invocation-local existing index owners;
   preserve first-wins semantics and prove operation-count bounds.
3. Complete TS/JS captures with real grammar and worker parity; activate only
   when declaration/import/export/reference semantics are complete.
4. Complete CALLS replay and generation publication, including clean caller
   recovery and dependency invalidation; integrate existing preparation owner.
5. Verify bounded current-worktree navigation on the reported large checkout,
   then authenticate the installed build and measure declared resource limits.

Only BIND-1 is implementation-ready. Remaining stages require their stated
evidence and scoped dispatch decisions; prerequisite completion is not runtime
navigation acceptance.

## Validation results

Shared compile and product typecheck exited zero. Three focused suites passed
105 tests (receipt 6e8fb8). Source review confirmed empty maps, alias/hoisting,
import precedence, nested definition retention and retained replay coverage.
One earlier test tool invocation returned no visible result; process inspection
found no remaining Vitest process. Its execution outcome is unknown, so its
budget slot remains consumed. The second invocation has terminal passing proof.
Budget: one of two shared compiles, one of two typechecks, two of two test slots
(one unknown, one passed), zero installs/releases/runtime launches. Initial plan
schema errors were corrected and deterministic validation passed before dispatch.
No provider activation or current-worktree performance acceptance is claimed.
