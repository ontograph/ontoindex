# Explicit export extraction

Date: 2026-10-22
Status: Closed
Authority: User proceed on provider scope capture prerequisites

## Goal

Providers can supply explicit local export maps using completed extraction context.

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
  EXPORT-3:
    title: Export hooks preserve local identities and reject invalid targets
    status: DONE
    classification: implementation-ready
    assurance_profile: full
    complexity: complex
    depends_on: []
    type: code
    validation_tier: unit-fast
    impact_risk: medium
    owner_files:
    - ontoindex/src/core/ingestion/language-provider.ts
    - ontoindex/src/core/ingestion/scope-extractor.ts
    - ontoindex/test/unit/scope-resolution/scope-extractor.test.ts
    - ontoindex/test/unit/scope-resolution/parse-worker-scope-integration.test.ts
    allowed_write_set:
    - ontoindex/src/core/ingestion/language-provider.ts
    - ontoindex/src/core/ingestion/scope-extractor.ts
    - ontoindex/test/unit/scope-resolution/scope-extractor.test.ts
    - ontoindex/test/unit/scope-resolution/parse-worker-scope-integration.test.ts
    non_goals:
    - Provider activation reexports persistence and runtime navigation
    required_validation:
    - cd ontoindex && ONTOINDEX_TEST_WORKERS=1 ./node_modules/.bin/vitest run test/unit/scope-resolution/scope-extractor.test.ts test/unit/scope-resolution/parse-worker-scope-integration.test.ts test/unit/scope-retention.test.ts test/unit/scope-resolution/finalize-orchestrator.test.ts
    - cd ontoindex && ./node_modules/.bin/tsc --noEmit
    - git diff --check
    expected_evidence:
    - Absent hook omits exports and empty map remains explicit
    - Alias and default names map to existing local IDs without filtering private definitions
    - Hook receives completed module bindings including nested name disambiguation
    - Invalid results fail through existing bridge and output map is detached
    rollback:
    - Revert only EXPORT-3 hunks in the four declared files
    stop_conditions:
    - Requires provider activation or changes to shared export representation
    known_blockers: []
    closeout:
      role_results:
        coder-worker: null
        coder-worker-test-challenger: null
      main_session_evidence:
        authorized_by: user
        authorization_ref: User proceed on provider scope capture prerequisites
        validation_summary: Parent reviewed production and test changes after four Sol medium discovery reviews and two Sol medium development helpers. Typecheck session 73071 receipt f79f7c exited 0. Final focused run session 53353 receipt 294cf3 exited 0 with 150 tests across four files. Initial run found one test fixture error corrected before final run. Whitespace receipt 52da01 exited 0. Parent verified all four file hashes against helper receipts. No provider activation or runtime navigation claim.
    dod_status: pass
```

## Required Traceability

| Requirement ID | Requirement | Disposition | Task IDs | Validation |
| --- | --- | --- | --- | --- |
| EXPORT | Supply explicit local exports after extraction | implementation | EXPORT-3 | Extractor and bridge tests |
| COMPAT | Preserve legacy absence and fail closed on malformed maps | compatibility-test | EXPORT-3 | Focused tests and typecheck |

## Decisions And Non-Goals

Compared three alternatives: optional post-extraction hook; dedicated export
capture pass; derive export names from legacy boolean checks. Select the hook:
it reuses existing IDs and finalized scope bindings with linear validation and
no extra AST traversal. A dedicated pass adds vocabulary and central language
semantics prematurely. Boolean derivation loses aliases and nested visibility.
The additive optional hook preserves existing providers and keeps rollback local.

Second challenge: flattened definitions alone cannot disambiguate nested names.
Supply readonly filePath, moduleScope, scopes and localDefs. Call once after all
five passes. Require a native Map with string keys and IDs belonging to localDefs;
copy the result. Empty export names remain legal strings. Absence omits the
property; an implemented hook returning undefined fails. Throwing hooks use the
existing bridge failure outcome. Readonly context is a trusted provider contract,
not a hostile-plugin isolation boundary. Map copying isolates return ownership;
it does not claim deep runtime immutability. Reexports and TS namespaces remain
activation work. No new dependencies or persistent schema changes.

## Evidence

Four Sol medium explorers reviewed owner, bindings, challenge and validation.
OntoIndex transport closed during discovery; source inspection is authority.
No retry or reindex. Two disjoint Sol medium implementation helpers; parent
accepts source and validation. Budget: two focused test runs, two typechecks,
zero builds/installations/releases; helpers run no validation. Existing dirty
changes must survive. Knowledge handoff: none; existing receipt rules apply.

## Closeout

Production typecheck session 73071 exited 0 (f79f7c).
First focused run session 74892 exited 1 (59be0e): 149 passed and one fixture
failure. The explicit call.free capture bypasses classifyCallForm by contract;
change only that fixture to call to observe pass ordering. Correction round 1,
production code unchanged. Final focused run session 53353 exited 0 (294cf3):
150 tests across four suites passed. Final whitespace passed (52da01).
Budget consumed: two of two focused runs, one of two typechecks, no builds,
installs or releases. Four source/test files changed; parent verified hashes.
Rust formatting is inapplicable because this checkout has no ontocode-rs.
OntoIndex remained unavailable. Provider activation and workspace navigation
remain open. No loop budget overrun; knowledge handoff: none.
