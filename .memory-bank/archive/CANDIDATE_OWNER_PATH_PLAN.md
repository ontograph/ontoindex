# Candidate owner-path admission

Date: 2026-10-24
Status: Closed
Authority: Resume session 01a15cbd-705c-7e61-83d8-baf9697ad5ee; user proceed instruction

## Goal

Retained candidates reject foreign registration owners and import callers while
incomplete candidates, clear events and external import targets remain compatible.

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
  OWNER-1:
    title: Reject foreign owner paths in retained candidates
    status: DONE
    classification: implementation-ready
    assurance_profile: lite
    complexity: simple
    type: code
    validation_tier: unit-fast
    impact_risk: low
    depends_on: []
    owner_files:
    - ontoindex/src/core/ingestion/pipeline-phases/scope-retention-candidate-reader.ts
    - ontoindex/test/unit/scope-retention-candidate-auxiliary-paths.test.ts
    allowed_write_set:
    - ontoindex/src/core/ingestion/pipeline-phases/scope-retention-candidate-reader.ts
    - ontoindex/test/unit/scope-retention-candidate-auxiliary-paths.test.ts
    non_goals:
    - Replay activation; schema changes; external-target membership; installation
    required_validation:
    - ONTOINDEX_TEST_WORKERS=1 ./node_modules/.bin/vitest run test/unit/scope-retention-candidate-reader.test.ts test/unit/scope-retention-candidate-auxiliary-paths.test.ts
    - ./node_modules/.bin/tsc --noEmit --incremental false
    expected_evidence:
    - All five path-bearing registration variants and four import maps reject foreign retained owners
    - Clear events and external targets accepted; incomplete ownership unchanged
    rollback:
    - Revert only this slice preserving pre-existing dirty files
    stop_conditions:
    - Valid producer counterexample or conflicting concurrent edits
    known_blockers: []
    closeout:
      role_results:
        coder-worker: null
        coder-worker-test-challenger: null
      main_session_evidence:
        authorized_by: user
        authorization_ref: Proceed open task from session 01a15cbd-705c-7e61-83d8-baf9697ad5ee
        validation_summary: 'Two Sol-medium developers and two explorers; independent source/test review PASS. Parent Vitest session 84125 terminal b325ed exit 0: 223 tests including 53 new cases. TypeScript session 58416 terminal 91bfc2 exit 0. Untracked source whitespace check exit 0. Both edited hashes unchanged across validation. OntoIndex declared-file verify_diff PASS with symbol scope skipped.'
    dod_status: pass
```

## Required Traceability

| Requirement ID | ADR/user requirement | Disposition | Task IDs | Validation |
| --- | --- | --- | --- | --- |
| OWNER | Resume registration/import ownership investigation | implementation | OWNER-1 | Focused semantic tampering regressions and typecheck |

## Decisions And Non-Goals

Two read-only producer reviews confirmed owner paths. Alternatives: reader-level
membership checks, inventory-aware reusable codecs, reconstructing the stage.
Reader checks preserve codec compatibility, reuse the existing inventory set,
require no schema migration or dependency and add linear bounded work. Codec
coupling and reconstruction add complexity without stronger ownership evidence.
Second challenge: check only retained candidates; do not check import targets or
clear events. No filtering of invalid records. Rollback is a local two-file diff.
Graph impact is UNKNOWN because the reader is unindexed; source callers show
candidate persistence verifies through this reader. No latency claim.

Parent owns validation: one suite and one typecheck, with at most one corrective
run justified by a new failure. Two Sol-medium developers own disjoint source/test
files; two explorers supply producer evidence. No build or installation.

## Closeout

OWNER-1 implementation complete. Development agents implement_owner_paths and
test_owner_paths both used gpt-6.1-sol medium with disjoint writes. Reader reuses
auxiliaryPaths and its retained-only membership check. No schema or API change.
Independent import_ownership source and test reviews found no blocker.

Parent validation: 223 tests in two suites passed (6.94 seconds), TypeScript
exit 0, whitespace exit 0. One suite and one typecheck used; no corrective run.
Hash before/after validation: reader
13237c0b3c12886b7609c4d3ec8dca1261fc008ff67fbb4ea96104fb24f8da9f;
tests 95258f9d8f3adc9297e427c19bb55742959b3abda41ef771a2f090079e56e68b.
No runtime activation, build/install or measured latency claim. Rust formatting
is inapplicable: this checkout has no ontocode-rs workspace and this slice is TypeScript.
