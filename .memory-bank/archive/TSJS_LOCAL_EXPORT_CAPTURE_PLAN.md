# TS/JS local export clause capture

Date: 2026-10-22
Status: Closed
Authority: User proceed; ../ADR_AUTOMATIC_DIRTY_WORKSPACE.md

## Goal

Resolve ordinary module-local export clauses through completed canonical bindings.

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
  EXPORT-4:
    title: Local export clauses preserve module definition identity and refuse unsupported syntax
    status: DONE
    classification: implementation-ready
    assurance_profile: lite
    complexity: simple
    depends_on: []
    type: code
    validation_tier: unit-fast
    impact_risk: low
    owner_files:
    - ontoindex/src/core/ingestion/languages/typescript-export-captures.ts
    - ontoindex/test/unit/scope-resolution/typescript-export-captures.test.ts
    allowed_write_set:
    - ontoindex/src/core/ingestion/languages/typescript-export-captures.ts
    - ontoindex/test/unit/scope-resolution/typescript-export-captures.test.ts
    non_goals:
    - Provider activation declaration exports reexports type exports imported bindings and runtime navigation
    required_validation:
    - cd ontoindex && ONTOINDEX_TEST_WORKERS=1 ./node_modules/.bin/vitest run test/unit/scope-resolution/typescript-export-captures.test.ts test/unit/scope-resolution/scope-extractor.test.ts
    - cd ontoindex && ./node_modules/.bin/tsc --noEmit
    - git diff --check
    expected_evidence:
    - Real TS TSX JS JSX clauses preserve aliases and canonical module local IDs
    - Missing imported ambiguous duplicate and unsupported exports fail closed
    - Captures detach AST data and preserve definitions and scopes
    rollback:
    - Remove the two new helper and test files
    stop_conditions:
    - Shared schema or provider activation required
    known_blockers: []
    closeout:
      role_results:
        coder-worker: null
        coder-worker-test-challenger: null
      main_session_evidence:
        authorized_by: user
        authorization_ref: User review challenge consolidate and proceed on 2026-10-22
        validation_summary: Parent verified both hashes then ran authorized third focused suite. Receipt call_lAt9E1eb1vZAFvoOZZCPboo3 exit 0 reports 85 tests in two files. Production typecheck call_KgKfuF5KWLOy2pBodr0YAinc exit 0 applies to unchanged production source. Whitespace call_g9GSjjfyOfssVDMb0HFpUMF9 exit 0. Four reviewers found no demonstrated slice defect. Two Sol medium helpers authored source and tests during development. Provider activation excluded.
    dod_status: pass
```

## Required Traceability

| Requirement ID | Requirement | Disposition | Task IDs | Validation |
| --- | --- | --- | --- | --- |
| LOCAL | Preserve local export identities | implementation | EXPORT-4 | Real parser and extractor tests |
| SCOPE | Refuse unsupported export forms | implementation | EXPORT-4 | Negative tests |
| ACTIVATE | Complete provider activation | non-goal | EXPORT-4 | Remains gated |

## Decisions And Non-Goals

Compared twice: detached captures with existing completed export hook; direct AST
mapping; full provider activation. Select detached captures to reuse canonical
binding identity without dependencies or wire changes. Direct AST mapping
duplicates resolution; activation depends on missing reference/binding semantics.
Clause scanning is linear; interpreter indexes local IDs once and uses module
bindings. No speedup measurement claimed. Malformed and unsupported input throws.

## Evidence

Four Luna/Sol discovery packets; two Sol medium source/test helpers planned.
Parent owns validation. OntoIndex parent transport closed; source is authority.
Budget: two focused suites and two typechecks. Both suites consumed; one
typecheck consumed. No install or release.

Two suite runs each returned exit 1 with 84 passed and one parser-fixture failure.
Logs: /tmp/ontoindex-export4-tests-2.log and
/tmp/ontoindex-export4-tests-final.log. The attempted fixture patch before the
second run returned no receipt and did not land. Parent failed to reconcile the
patch before rerunning; this violated the missing-output reconciliation rule.
An earlier launch returned no receipt and created no redirected log; no execution
is established for it. Neither initial run passed.

The fixture now explicitly uses the JavaScript grammar for the ordinary `type`
identifier case; exact source was verified after correction. Production tsc
returned exit 0 (call_KgKfuF5KWLOy2pBodr0YAinc); git diff --check returned exit 0
(call_g9GSjjfyOfssVDMb0HFpUMF9). The subsequent authorized suite passed as recorded below.
Source SHA256: 382061a0b74e463e3d9daa2448982760d8f53b0232d1650643dcd6acf959f552.
Test SHA256: 214342faf911eed4026664635520b909899eea571991eed037de2f5e756dd0dd.
User review-and-proceed on 2026-10-22 authorizes the requested one additional
focused suite (total allowance three; two consumed before this continuation).
The corrected fixture and both source/test hashes were verified before launch.
Knowledge handoff: none; manager-loop already requires reconciliation of missing
patch receipts before dependent validation.

## Closeout

Corrected suite passed 85 tests in two files, exit 0, 1.03 seconds; log
/tmp/ontoindex-export4-authorized-final.log. Terminal session 86023 harvested.
Suite allowance 3/3 consumed; typecheck 1/2 consumed, unchanged source.
Four fresh reviewers found no demonstrated slice defect. Follow-up tests should
cover multi-statement accumulation, cross-statement duplicates and mixed supported
and unsupported clauses. Fix the JS fixture extractor filename in that packet.
No provider activation or runtime-navigation improvement is claimed.
