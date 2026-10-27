# TS/JS lexical binding capture

Date: 2026-10-22
Status: Closed
Authority: User requested review and consolidated implementation.

## Goal

Capture ordinary identifier let/const lexical bindings through the existing extractor.

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
  BIND-1:
    title: Identifier let and const captures preserve lexical shadowing
    status: DONE
    classification: implementation-ready
    assurance_profile: lite
    complexity: simple
    depends_on: []
    type: code
    validation_tier: unit-fast
    impact_risk: low
    owner_files:
    - ontoindex/src/core/ingestion/languages/typescript-declaration-captures.ts
    - ontoindex/test/unit/scope-resolution/typescript-declaration-captures.test.ts
    allowed_write_set:
    - ontoindex/src/core/ingestion/languages/typescript-declaration-captures.ts
    - ontoindex/test/unit/scope-resolution/typescript-declaration-captures.test.ts
    non_goals:
    - Provider activation and shared extractor changes
    - Var parameters destructuring for-in direct bindings TDZ and type inference
    required_validation:
    - cd ontoindex && ONTOINDEX_TEST_WORKERS=1 ./node_modules/.bin/vitest run test/unit/scope-resolution/typescript-declaration-captures.test.ts test/unit/scope-resolution/typescript-import-captures.test.ts test/unit/scope-resolution/typescript-scope-captures.test.ts
    - cd ontoindex && ./node_modules/.bin/tsc --noEmit
    - git diff --check
    expected_evidence:
    - Four grammars preserve multiple lexical bindings and nested shadowing
    - Initializer expression scopes do not acquire the variable binding
    - Unsupported patterns refuse entire statements and captures remain detached
    rollback:
    - Revert only lexical binding addition and its tests
    stop_conditions:
    - Shared contract change required
    - Two test or typecheck invocations exhausted
    known_blockers: []
    closeout:
      main_session_evidence:
        authorized_by: user
        authorization_ref: User requested review and implementation with two Sol medium development helpers
        validation_summary: Parent reviewed source and test files; focused Vitest 89 tests passed exit 0; tsc --noEmit exit 0; git diff --check exit 0.
      role_results:
        coder-worker: null
        coder-worker-test-challenger: null
    dod_status: pass
```

## Required Traceability

| Requirement ID | ADR/user requirement | Disposition | Task IDs | Validation |
| --- | --- | --- | --- | --- |
| BIND-REQ-1 | Implement robust next prerequisite | implementation | BIND-1 | Composed grammar tests |
| BIND-REQ-2 | Preserve truthful scope evidence | implementation | BIND-1 | Refusal tests |

## Decisions And Non-Goals

Good: detached records, existing extractor reuse, separate structural and binding
ownership, four grammars and explicit refusal. Weak: helper completion has not
delivered production navigation. Missing activation gates: var/parameter
environments, destructuring, references, exports, class self-binding, full imports,
CALLS replay, seed persistence and generation acceptance.

Compared twice: ordinary lexical bindings (selected), combined var/parameters
(unsettled identity and environment contracts), immediate provider activation
(unsafe incomplete extraction success). Shared contract expansion is unnecessary.
Existing innermost binding supplies placement without new metadata. Add
emitTypeScriptLexicalBindingCaptures in the existing declaration owner accepting
one lexical_declaration; emit @declaration.variable and @declaration.name for
each identifier using name ranges, avoiding initializer scope ownership. Validate
all declarators; refuse patterns rather than returning partial facts. Classic for
initializers supported; direct for-in/of bindings deferred. Type annotations can
be present without inference. No recursive initializer scan or new dependency.

Review challenge: more disconnected helpers alone will not repair navigation.
After capture completeness, require real provider-to-ParsedFile integration,
complete seed persistence, deletion/rename invalidation, dependency closure,
derived parity and atomic publication before runtime acceptance. This bounded
slice closes the concrete missing lexical-shadowing prerequisite only.

Two Sol medium helpers own disjoint source and tests; parent owns integration.
Budget: focused tests 2; typechecks 2; builds/launches 0.
OntoIndex Transport closed; source inspection is authority.
Knowledge handoff: none; transport fallback already documented.

## Closeout

Implemented identifier-only let/const capture in existing declaration owner.
Parent reviewed final files and recomputed hashes matching both worker receipts.
Vitest: 3 files, 89 tests passed, exit 0, 2.74s
(call_37x8pYVndDqIufmZYsE7NIa3). TypeScript exit 0 and whitespace exit 0
(call_9RXGJN8dvzOnMIWzl781SeNR).
Earlier command submissions returned no tool receipt; their execution is unknown
and no result is claimed. No validation process remained at the process check.
No further test invocations are authorized in this slice.
Source SHA-256: 4e086beab7f0c5591160682b3b4a13c9f6a1e2b4384add48193e3905e23ac5b2.
Test SHA-256: 30e613f0bd1cdae818ec249b0e5b6dffc67ceb16625b2ad2e035dcd41daa1bd5.
No provider activation, release or default navigation acceptance is claimed.
