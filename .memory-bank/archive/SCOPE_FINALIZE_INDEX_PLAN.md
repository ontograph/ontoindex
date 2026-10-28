# Indexed finalizer lookups

## Decision

INDEX-1 follows completed BIND-1. Compare eager indexing (simple but allocates
unused indexes), per-query memoization (distinct names still scan), and lazy
invocation-local indexing (selected). Reuse buildDefIndex for first-wins IDs;
legacy simple-name maps traverse original definitions without ID deduplication.
Second challenge preserves file-local export ownership, duplicate ordering,
empty maps, imported binding precedence and invocation isolation. No public
API, persistent state, dependencies or provider activation changes. Memory is
linear in indexed definitions; rollback affects only this packet's hunks.

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
  INDEX-1:
    title: Bound definition reads for distinct named and wildcard imports
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
    - ontoindex/test/unit/scope-resolution/finalize-algorithm.test.ts
    allowed_write_set:
    - ontoindex-shared/src/scope-resolution/finalize-algorithm.ts
    - ontoindex/test/unit/scope-resolution/finalize-algorithm.test.ts
    non_goals:
    - Provider activation graph publication navigation caps and timing benchmarks
    required_validation:
    - cd ontoindex-shared && ./node_modules/.bin/tsc
    - cd ontoindex && ./node_modules/.bin/tsc --noEmit
    - cd ontoindex && ONTOINDEX_TEST_WORKERS=1 ./node_modules/.bin/vitest run test/unit/scope-resolution/finalize-algorithm.test.ts test/unit/scope-resolution/finalize-orchestrator.test.ts test/unit/scope-retention.test.ts
    - git diff --check
    expected_evidence:
    - Definition reads scale linearly for distinct named and wildcard imports
    - Duplicate ID and simple-name first-wins and file-local ownership preserved
    - No cached state survives a finalize invocation
    rollback:
    - Revert only INDEX-1 hunks in the two declared files
    stop_conditions:
    - Requires public API or semantic resolution changes
    known_blockers: []
    closeout:
      role_results:
        coder-worker: null
        coder-worker-test-challenger: null
      main_session_evidence:
        authorized_by: user
        authorization_ref: User authorized proceed with Sol medium development helpers
        validation_summary: Parent reviewed lazy lookup semantics and 13 new regressions. Shared tsc exit 0 receipt 4eff0a; product tsc --noEmit exit 0 receipt 85dc36. Focused suites session 83388 receipt 4392f2 exit 0 with 118 tests across three files. Final whitespace-only EOF correction checked by git diff --check receipt 76bc15 exit 0. Two Sol medium reviewers and two Sol medium development helpers supplied results. OntoIndex Transport closed prevents graph verification. No runtime navigation or measured latency claim.
    dod_status: pass
```

## Required Traceability

| Requirement ID | ADR/user requirement | Disposition | Task IDs | Validation |
| --- | --- | --- | --- | --- |
| PERF | Remove repeated definition scans | implementation | INDEX-1 | Getter counts at 128 and 256 definitions |
| COMPAT | Preserve lookup and scope semantics | compatibility-test | INDEX-1 | Duplicate ownership isolation and existing scope suites |

## Evidence and budget

Two read-only Sol medium explorers and two Sol medium development helpers.
Parent validation only: two shared compiles, two product typechecks and two
focused suite runs maximum, serial. No installation, release or runtime launch.
OntoIndex freshness returned Transport closed; source inspection is authority.
No graph risk or runtime performance claim. Knowledge handoff: none; existing
transport and receipt rules apply. Later TS/JS, CALLS, generation and large
workspace acceptance remain separate gates.

## Closeout evidence

Lazy per-invocation indexes replace repeated export and workspace-ID scans.
Eight deterministic cases bound definition reads at 128 and 256 definitions;
five compatibility cases preserve duplicate ordering and invocation isolation.
Production SHA-256: 8bdac8717726d54b53b12fcd29d8e3b27f16416c9fa2d6d6b9cfc86fe651ad30.
Test SHA-256: 62b0857e80600679499323d907bc0caf04e988896b37e0838232816882882160.
Budget used: one of two shared compiles, one of two product typechecks,
two of two test attempts (first returned no receipt and no process remained;
second passed). One whitespace correction; no behavioral correction.
An initial hash command used a wrong relative path; corrected hash independently
matched the helper result. No install, release, provider activation or benchmark.
