# Parse input evidence handoff

Date: 2026-10-22
Status: Closed
Authority: User proceed and ../ADR_AUTOMATIC_DIRTY_WORKSPACE.md SCOPE refinement.

## Goal

Transfer bounded configuration observations and actual consumed source-text identities through the existing parse-owned retention handle.

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
  INPUT-1:
    title: Retention consumer receives bounded configuration and parser-text identity with conflicting reads marked incomplete
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
    - ontoindex/src/core/ingestion/pipeline-phases/parse-impl.ts
    - ontoindex/test/unit/scope-retention.test.ts
    - ontoindex/test/unit/parse-impl-fallback.test.ts
    allowed_write_set:
    - ontoindex/src/core/ingestion/pipeline-phases/scope-retention-stage.ts
    - ontoindex/src/core/ingestion/pipeline-phases/parse-impl.ts
    - ontoindex/test/unit/scope-retention.test.ts
    - ontoindex/test/unit/parse-impl-fallback.test.ts
    non_goals:
    - No raw source byte or atomic filesystem identity claim
    - No generation seed publication or complete replay identity
    - No navigation activation or build install release
    required_validation:
    - cd ontoindex && ONTOINDEX_TEST_WORKERS=1 ./node_modules/.bin/vitest run test/unit/scope-retention.test.ts test/unit/parse-impl-fallback.test.ts test/unit/parse-phase-lifecycle.test.ts
    - cd ontoindex && ./node_modules/.bin/tsc --noEmit
    - git diff --check
    expected_evidence:
    - Consumer sees original bounded immutable configuration observations and source text identities
    - Conflicting missing and incomplete identity refuses identity completeness
    - Resource bounds cancellation and disposal preserve shared allowance
    rollback:
    - Revert only INPUT-1 hunks in declared write set
    stop_conditions:
    - Changes require new persistence owner or generation publication
    known_blockers: []
    closeout:
      main_session_evidence:
        authorized_by: user
        authorization_ref: User proceed with INPUT-1 implementation and closeout
        validation_summary: Parent validation retained across session handoff; suite 20806 exited 1 with 60 passed and two artifact-budget boundary failures. Parent corrected inventory accounting to preserve its separate ceiling. Final suite 22774 exited 0 with 62 tests across three files in 6.23 seconds; TypeScript session 2285 exited 0; git diff --check exited 0. Current four input hashes match the validated handoff hashes. Two Sol medium development receipts reviewed; children ran no tests or builds. Budget used two of two suites and one of two typechecks. No build install release or navigation activation. OntoIndex transport closed; source inspection is authority.
      role_results:
        coder-worker: null
        coder-worker-test-challenger: null
    dod_status: pass
```

## Required Traceability

| Requirement ID | Requirement | Disposition | Task IDs | Validation |
| --- | --- | --- | --- | --- |
| INPUT | Identify actual consumed source strings across rereads | implementation | INPUT-1 | Parse fallback tests |
| CONFIG | Transfer existing loader observations with bounded lifetime | implementation | INPUT-1 | Retention tests |
| SEED | Generation-bound persistence and complete replay | non-goal | INPUT-1 | Successor packet |

## Decisions And Second Challenge

Post-hoc filesystem hashing cannot identify consumed input and is rejected.
Adding identities to every parsed-file codec record duplicates configuration linkage and expands compatibility scope.
Extend the existing retention handle instead: one lifetime owner, no source reread, no new codec or dependency.
This keeps parser behavior compatible and confines rollback to additive evidence.

Second review found sequential heritage and call processing reread source files.
Observe all three read sites and retain conflicts as sticky incompleteness.
Hash explicitly identified decoded text, never label it original file bytes.
Configuration records are bounded owned copies; evidence uses the existing allowance,
deadline and disposal lifecycle. Missing identity cannot certify replay.
Keep artifact retention status separate from input-evidence completeness for compatibility.
Keep seedReady false. No executable hooks or raw contents are retained.

## Execution Evidence

OntoIndex stale/degraded: Transport closed; source inspection is authority.
Four bounded read-only packets dispatched on Sol/Luna; one Luna packet was blocked by host read policy and supplies no source findings.
Two Sol medium development packets completed production and tests separately; final receipts reviewed during closeout.
Parent validation budget: two focused suite invocations and two typechecks; children zero tests/builds.
Inherited unrelated manager receipt remains preserved and unmodified.

## Closeout

The existing retention handle now carries bounded immutable configuration observations
and consumed parser-text identities across all three parse read sites. Conflicts and
missing evidence prevent completeness. Inventory retains its separate byte ceiling;
artifacts and input evidence share the artifact allowance. Disposal refunds ownership.

Validated input SHA-256 values, rechecked during closeout:

- scope-retention-stage.ts: `3db2acb02fead8ef882c6f5845e5514b96045735d659b42108abb75f521a117b`
- parse-impl.ts: `a5514024e2e706b6bb51a011bef98fbfc7c4af8349a9b3e7e7528d1879b45dc1`
- scope-retention.test.ts: `194a806ba469b36215a860c90d8ad95301bba9bcd2977e9ca45f5c6f55ab93e8`
- parse-impl-fallback.test.ts: `75fd2dd0587a612b61ed4fb5c286d92a79ce5ae323aa4564ee54d97d8462f1ca`

Validation results above are retained parent execution evidence, not reruns during
closeout. Generation-bound persistence, provider support and large dirty-workspace
navigation remain successor work. seedReady remains false.
knowledge_handoff: none; existing manager-loop rules already require preserving
validation budgets and checking final inputs after parent corrections.

