# TS/JS export composition regressions

Date: 2026-10-22
Status: Closed
Authority: User proceed after EXPORT-4 closeout

## Goal

Prove ordinary export clauses compose across statements and reject duplicate names.

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
  EXPORT-5:
    title: Multiple export statements preserve identities and reject duplicate exported names
    status: DONE
    classification: implementation-ready
    assurance_profile: lite
    complexity: simple
    depends_on: []
    type: code
    validation_tier: unit-fast
    impact_risk: low
    owner_files:
    - ontoindex/test/unit/scope-resolution/typescript-export-captures.test.ts
    allowed_write_set:
    - ontoindex/test/unit/scope-resolution/typescript-export-captures.test.ts
    non_goals:
    - Production changes provider activation or runtime navigation claims
    required_validation:
    - cd ontoindex && ONTOINDEX_TEST_WORKERS=1 ./node_modules/.bin/vitest run test/unit/scope-resolution/typescript-export-captures.test.ts test/unit/scope-resolution/scope-extractor.test.ts
    - git diff --check
    expected_evidence:
    - Real grammar fixtures preserve both export identities across statements
    - Duplicate exported names across statements throw
    - JavaScript fixture identity and exact type alias remain supported
    rollback:
    - Revert only this packet's test additions
    stop_conditions:
    - Production changes required
    known_blockers: []
    closeout:
      role_results:
        coder-worker: null
        coder-worker-test-challenger: null
      main_session_evidence:
        authorized_by: user
        authorization_ref: User proceed on 2026-10-22 after EXPORT-4 closeout
        validation_summary: Two Sol medium development helpers authored and independently reviewed tests. Parent suite receipt call_rYwYQTbaGfbeAoRv28fybKft exit 0 reports 94 tests in two files. Test SHA256 bed579278966925216041e4638f6e2fb49a0bcf9dfdb439087c18d99e6a0973e. Production unchanged. No actionable reviewer defect.
    dod_status: pass
```

## Required Traceability

| Requirement ID | Requirement | Disposition | Task IDs | Validation |
| --- | --- | --- | --- | --- |
| COMPOSE | Preserve multi-statement identities | compatibility-test | EXPORT-5 | Real parser tests |
| DUPLICATE | Reject duplicate names across statements | compatibility-test | EXPORT-5 | Negative extractor tests |

## Decisions And Non-Goals

Compared regression coverage, declaration-export expansion and provider activation.
Selected focused coverage: no runtime cost or compatibility change; declaration
exports need separate semantics and activation lacks complete captures. Second
review distinguishes caller composition from production whole-file rollback:
these fixtures cannot establish an unwired provider's atomicity. No production
defect is inferred. Existing shared owners remain unchanged.

## Evidence

OntoIndex freshness failed with Transport closed; source inspection is authority.
Four read-only Luna/Sol packets; two Sol medium development helpers own test
authoring and independent challenge. Parent owns validation: at most two focused
suite invocations, no build or install. No production typecheck needed for test-only
changes. Knowledge handoff: none; existing receipt reconciliation rules apply.

## Closeout

Focused suite passed 94 tests in two files, exit 0, 1.28 seconds.
One of two allowed suite invocations used. Production code unchanged; no build,
install or runtime navigation claim. Independent Sol medium review found no
actionable assertion defect. OntoIndex transport remains unavailable.
