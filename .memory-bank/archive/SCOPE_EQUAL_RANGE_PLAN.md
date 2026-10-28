# Whole-file scope ranges

Date: 2026-10-22
Status: Closed
Authority: User proceed; ADR_AUTOMATIC_DIRTY_WORKSPACE.md SCOPE prerequisite.

## Goal

Preserve genuine identical module and whole-file declaration ranges without
weakening other scope-tree invariants.

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
  RANGE-1:
    title: Root module accepts identical-range nonmodule child and lookup selects child
    status: DONE
    classification: implementation-ready
    assurance_profile: full
    complexity: complex
    depends_on: []
    type: code
    validation_tier: unit-fast
    impact_risk: medium
    owner_files:
    - ontoindex/src/core/ingestion/scope-extractor.ts
    - ontoindex-shared/src/scope-resolution/scope-tree.ts
    - ontoindex-shared/src/scope-resolution/position-index.ts
    - ontoindex/test/unit/scope-resolution/scope-tree.test.ts
    - ontoindex/test/unit/scope-resolution/position-index.test.ts
    - ontoindex/test/unit/scope-resolution/scope-extractor.test.ts
    allowed_write_set:
    - ontoindex/src/core/ingestion/scope-extractor.ts
    - ontoindex-shared/src/scope-resolution/scope-tree.ts
    - ontoindex-shared/src/scope-resolution/position-index.ts
    - ontoindex/test/unit/scope-resolution/scope-tree.test.ts
    - ontoindex/test/unit/scope-resolution/position-index.test.ts
    - ontoindex/test/unit/scope-resolution/scope-extractor.test.ts
    non_goals:
    - No provider migration CALLS retention persistence or runtime activation
    required_validation:
    - cd ontoindex-shared && ../ontoindex/node_modules/.bin/tsc
    - cd ontoindex && ONTOINDEX_TEST_WORKERS=1 ./node_modules/.bin/vitest run test/unit/scope-resolution/scope-tree.test.ts test/unit/scope-resolution/position-index.test.ts test/unit/scope-resolution/scope-extractor.test.ts
    - cd ontoindex && ./node_modules/.bin/tsc --noEmit
    - git diff --check
    expected_evidence:
    - Original equal ranges survive extraction and validation in either input order
    - Position lookup selects nonmodule child
    - Other equal nesting and sibling overlap remain rejected
    rollback:
    - Revert only RANGE-1 hunks
    stop_conditions:
    - Broader parent metadata or provider migration needed
    known_blockers: []
    closeout:
      role_results:
        coder-worker: null
        coder-worker-test-challenger: null
      main_session_evidence:
        authorized_by: user
        authorization_ref: User proceed on scope prerequisite
        validation_summary: Parent reviewed three production and three test diffs after two Sol medium development packets and independent read-only challenge. Zero-span sibling ambiguity corrected. Final focused suite session 81067 passed 74 tests in three files exit 0 in 1.87 seconds. Production TypeScript session 45602 exit 0. Shared-library compilations exit 0; final compilation after correction exit 0. git diff --check exit 0. Source hashes recorded in command receipt 57f5c4. No provider completeness or runtime availability claim.
    dod_status: pass
```

## Required Traceability

| Requirement ID | Requirement | Disposition | Task IDs | Validation |
| --- | --- | --- | --- | --- |
| RANGE | Whole-file declarations retain true ranges | implementation | RANGE-1 | Extractor tree and position regression suites |
| PROVIDER | Real provider captures and CALLS completeness | non-goal | RANGE-1 | Successor scope remains required |

## Decisions And Second Challenge

Range padding or body-only scopes distort locations and can exclude parameters;
reject this low-complexity symptom workaround. Explicit AST-parent capture
metadata supports arbitrary equal-span nesting but changes provider APIs and
requires cycle validation; defer until a demonstrated case needs it. Select a
narrow exception for a root Module and direct non-Module child, plus stable
module-first equal-range ordering. Existing sorting complexity is unchanged;
there are no dependencies or extra parsing passes. Compatibility expands only
this previously rejected valid structure. Rollback touches the three owners.

Second challenge: equality alone cannot authorize arbitrary nesting. Keep
nonmodule equal nesting, nested module equality, duplicate IDs and overlapping
siblings rejected. Position lookup must agree with extraction regardless of
input order. Successful synthetic capture tests do not certify real providers.

## Execution Evidence

OntoIndex transport closed earlier in this task; no retries or reindex permitted.
Source inspection is authority. Three read-only Sol reviewers identified missing
provider hooks and the strict-range prerequisite. Two Sol medium development
packets own disjoint source and test sets. Main session owns acceptance.
Budget: two focused suite invocations and two typechecks; children zero tests;
Two shared-library compilations are allowed because tests consume dist exports;
one completed before the zero-span review correction. Zero installs or releases. Tracker was created after development packet
dispatch; no authenticated role results are inferred from those packets.

## Closeout

Final focused validation passed 74 tests across three files. TypeScript and
whitespace validation passed. Budget used: two suites, one typecheck, two shared
compilations. First suite preceded final test edit and was superseded. Development
dispatch preceded tracker validation; final acceptance is main-session evidence.
Independent review identified and fixed identical zero-span sibling ambiguity.
Knowledge handoff: none; existing receipt and validation rules cover these cases.
Provider capture, CALLS, persistence and large-workspace navigation remain open.

