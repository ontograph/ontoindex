# Retained scope replay parity

Date: 2026-10-22
Status: Closed
Authority: User proceed; ADR_AUTOMATIC_DIRTY_WORKSPACE.md SCOPE and SEED ordering.

## Goal

Exercise retained ParsedFile replay through the existing finalizer and verify
input-evidence refusal without activating generation publication.

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
  PARITY-1:
    title: Retained scope fixtures preserve import resolution and reject invalid input evidence
    status: DONE
    classification: implementation-ready
    assurance_profile: full
    complexity: standard
    depends_on: []
    type: test
    validation_tier: unit-fast
    impact_risk: low
    owner_files:
    - ontoindex/test/unit/scope-resolution/finalize-orchestrator.test.ts
    - ontoindex/test/unit/scope-retention.test.ts
    allowed_write_set:
    - ontoindex/test/unit/scope-resolution/finalize-orchestrator.test.ts
    - ontoindex/test/unit/scope-retention.test.ts
    non_goals:
    - No product edits or generation publication
    - No provider completeness or bounded finalizer memory claim
    - No build install release or navigation activation
    required_validation:
    - cd ontoindex && ONTOINDEX_TEST_WORKERS=1 ./node_modules/.bin/vitest run test/unit/scope-resolution/finalize-orchestrator.test.ts test/unit/scope-retention.test.ts
    - git diff --check
    expected_evidence:
    - Retained and fresh fixtures agree with concrete expected resolution assertions
    - Invalid or unexpected parser identities refuse input completeness
    - All temporary retention handles disposed
    rollback:
    - Revert only PARITY-1 test hunks
    stop_conditions:
    - A production defect requires a separately scoped repair
    known_blockers: []
    closeout:
      main_session_evidence:
        authorized_by: user
        authorization_ref: User proceed with PARITY-1 implementation and closeout
        validation_summary: Parent reviewed both Sol development patches and receipts; final test hashes matched child receipts. Focused vitest session 85390 exited 0 with 56 tests across two files in 1.39 seconds. git diff --check passed. One of two suite invocations used; children ran no tests or builds. Three finalizer cases assert concrete cycle bindings, wildcard and thin reexport behavior, and collision buckets with current first-match selection. Nine input refusal cases cover unexpected sources, invalid UTF-8 identities, invalid configuration and configuration conflict. Synthetic fixtures do not prove provider completeness or bounded production finalization. OntoIndex transport closed; source inspection is authority. No production edits, build, install, release or navigation activation in this packet.
      role_results:
        coder-worker: null
        coder-worker-test-challenger: null
    dod_status: pass
```

## Required Traceability

| Requirement ID | Requirement | Disposition | Task IDs | Validation |
| --- | --- | --- | --- | --- |
| REPLAY | Ordered retained inputs preserve finalizer behavior | implementation | PARITY-1 | Focused finalizer suite |
| IDENTITY | Invalid input cannot certify completeness | implementation | PARITY-1 | Retention suite |
| SEED | Publish only after MODEL SCOPE CALLS | non-goal | PARITY-1 | ADR dependency gate |

## Decisions And Second Challenge

Three options reviewed: immediate generation publication, an independent diagnostic
sidecar, and run-local replay parity through existing owners. Publication requires
complete SCOPE/CALLS and changes lifetime ownership; it is premature. A sidecar adds
storage and rollback complexity without resolving replay. Select run-local parity:
compatible existing APIs, no new runtime cost or security surface, narrow rollback,
and deterministic tests. No incomplete evidence may authorize a seed.

Second challenge found retention is disposed after the awaited parse consumer and
full analysis stages its generation after pipeline completion. Persisting the
current handle would outlive its owner. TypeScript lacks scope hooks and requires
semantic design, not a module-only stub. Finalization materializes inputs; small
fixture parity cannot establish bounded production finalizer memory or complete
provider semantics. Use concrete resolution assertions as well as equality to
avoid two empty results passing.

## Execution Evidence

OntoIndex stale/degraded: Transport closed; source inspection is authority.
Four read-only reviewers completed on Sol/Luna. One reviewer considered diagnostic
persistence feasible; coordinator rejected it as unnecessary storage and scope.
Two Sol medium development packets own disjoint existing test files.
Parent budget: at most two focused test invocations, children zero tests/builds.
No production edits; TypeScript production check is unnecessary for this test-only
packet. Existing unrelated manager state remains untouched.

## Closeout

Added three retained/fresh finalizer parity cases and nine input-evidence refusal
cases. All 56 focused tests passed (exit 0); whitespace validation passed (exit 0).
Both development agent receipts were reviewed. The one-run validation used final
test inputs with SHA-256 values:

- finalize-orchestrator.test.ts: `c0f01d072d6a80eaf8f43e9544ca2bbe7af763fa54d7f3e74866a374d04acddb`
- scope-retention.test.ts: `bf381ac9ea05c2c18a70901923c7b3d66003ded66da8c7f63ea4701f3ad5bb37`

Provider scope capture and CALLS completeness remain prerequisites for generation
persistence. Thin reexports and first-match collision resolution are characterized
limitations. seedReady remains false; default workspace navigation is unresolved.
No Rust subtree exists here, so Rust formatting does not apply.
knowledge_handoff: none; existing rules already separate fixture parity from
provider completeness and require terminal validation evidence.

