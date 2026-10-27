# Workspace repair follow-up

Date: 2026-10-24
Status: Closed
Authority: User review-and-proceed instruction; ADR_WORKSPACE_REPAIR_FOLLOWUP.md

## Goal

Concurrent unreadable-generation requests share a repair and lock contention
does not consume the repair allowance; safe cached diagnostics remain stable.

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
  REPAIR-1:
    title: Preserve shared repair and cached diagnostics after contention
    status: DONE
    classification: implementation-ready
    assurance_profile: full
    complexity: standard
    type: code
    validation_tier: unit-fast
    impact_risk: low
    depends_on: []
    owner_files:
    - ontoindex/src/mcp/local/local-backend-repo-runtime.ts
    - ontoindex/test/unit/local-backend-repo-runtime.test.ts
    - ontoindex/test/unit/calltool-dispatch.test.ts
    allowed_write_set:
    - ontoindex/src/mcp/local/local-backend-repo-runtime.ts
    - ontoindex/test/unit/local-backend-repo-runtime.test.ts
    - ontoindex/test/unit/calltool-dispatch.test.ts
    non_goals:
    - Size limits; cache identity redesign; new public schema; deployment; historical attribution
    required_validation:
    - ONTOINDEX_TEST_WORKERS=1 ./node_modules/.bin/vitest run test/unit/local-backend-repo-runtime.test.ts test/unit/calltool-dispatch.test.ts test/unit/mcp-server-error-path.test.ts test/integration/committed-navigation-sdk.test.ts
    - ./node_modules/.bin/tsc --noEmit --incremental false
    - git diff --check -- ontoindex/src/mcp/local/local-backend-repo-runtime.ts ontoindex/test/unit/local-backend-repo-runtime.test.ts ontoindex/test/unit/calltool-dispatch.test.ts
    expected_evidence:
    - Concurrent unreadable callers share one build; busy lock and adopted generation consume no attempt
    - Actual repair remains bounded and lock releases on all paths; cached safe diagnostics retain parity
    - Dispatch preserves input_refused through existing projection
    - Two development agents use gpt-6.1-sol at medium effort with disjoint writes; parent owns integration and validation
    rollback:
    - Revert only follow-up changes; preserve concurrent edits and previous diagnostics
    stop_conditions:
    - Unexpected concurrent edit conflict or expanded write scope
    known_blockers: []
    closeout:
      main_session_evidence:
        authorized_by: user
        authorization_ref: Review and challenge; consolidate one plan and proceed with two Sol-medium developers
        validation_summary: 'Focused Vitest suite session 56627 exit 0: 335 tests; TypeScript session 13168 exit 0; scoped diff check exit 0. Three source hashes rechecked unchanged. Independent source review found no blocker.'
    dod_status: pass
```

## Required Traceability

| Requirement ID | ADR/user requirement | Disposition | Task IDs | Validation |
| --- | --- | --- | --- | --- |
| R1 | Shared bounded repair and contention recovery | implementation | REPAIR-1 | Runtime regression checks |
| R2 | Safe cached parity and refusal dispatch | implementation | REPAIR-1 | Runtime and dispatch checks |
| R3 | Review prior plan and alternatives | implementation | REPAIR-1 | ADR and historical annotations |

## Execution

Parent owns local integration and validation. Four read-only reviewers covered
runtime, boundary, performance and plan evidence. Two Sol-medium development
packets own runtime implementation and regression tests respectively. They run
no tests concurrently. Parent executes one final suite and typecheck after edits;
at most one additional focused correction run only for a new concrete failure.
This is a new follow-up task; previous DIAG-1 usage stays archived unchanged.

## Closeout

Implementation and independent source review complete. Development agents
`develop_runtime` (01a16cfc-631c-7020-8a88-40e7a5edd304) and
`develop_regressions` (01a16cfc-9b35-7b13-9c2d-d344beade60f) used
gpt-6.1-sol at medium effort. Independent runtime reviewer reported no blocker.
Parent reviewed the final source and executed all three required commands.

Validation: focused suite session 56627 exited 0 with 335 passing tests in four
files (23.01s); typecheck session 13168 exited 0; scoped git diff check exited 0.
OntoIndex verify_diff passed file scope; symbol scope was not checked. Direct
impact was LOW (two callers), broader transitive impact CRITICAL; the exported
signature remains unchanged. Dirty source was authoritative.

One suite and one typecheck consumed for this follow-up; no correction run used.
Three edited input SHA-256 values matched before and after validation:

- Runtime: c910d8ec7f01af3690c29e84423e5c5f4c03a2a5b8ea5e2e66f1a22d9ef9eb28
- Runtime tests: f2cf00cb4e14fd1150e818b191df78927c7c11719fef5064939588894e21c2a0
- Dispatch tests: 00fab1bcb7db20b4968330644f8c970867339efb316d3bb388ce86afd1fa75c8

Changed product files are exactly the three declared files. Documentation adds
the decision and plan, corrects superseded historical prose and model-routing
qualification, and updates active memory routing. No dependency, size limit,
cache identity, public API, deployed binary, or historical cause attribution changed.
Performance evidence is deterministic reuse/build counts, not measured latency.
