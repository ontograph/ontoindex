# TS/JS declaration capture

Date: 2026-10-22
Status: Closed
Authority: User proceed after import capture completion.

## Goal

Named function and class captures populate definitions and correctly placed lexical
bindings through the existing extractor; production providers remain inactive.

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
  DECL-1:
    title: Named declarations bind in parent and named expressions bind internally
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
    - Provider activation and generic extractor changes
    - Variables parameters interfaces overloads TDZ Annex B and complete type semantics
    required_validation:
    - cd ontoindex && ONTOINDEX_TEST_WORKERS=1 ./node_modules/.bin/vitest run test/unit/scope-resolution/typescript-declaration-captures.test.ts test/unit/scope-resolution/typescript-import-captures.test.ts test/unit/scope-resolution/typescript-scope-captures.test.ts
    - cd ontoindex && ./node_modules/.bin/tsc --noEmit
    - git diff --check
    expected_evidence:
    - Four real grammars preserve named declaration and expression binding hosts and structural ownership
    - Composed lexical import and declaration extraction populates definitions and bindings
    - Missing or incompatible lexical scope throws and unrelated captures delegate
    rollback:
    - Remove only the two new helper and test files
    stop_conditions:
    - Shared contract expansion required
    - Validation budget exhausted
    known_blockers: []
    closeout:
      main_session_evidence:
        authorized_by: user
        authorization_ref: User proceed; parent local execution for DECL-1
        validation_summary: Focused Vitest 71/71 passed exit 0; production tsc --noEmit exit 0; git diff --check exit 0. Parent inspected both files and corrected named-node fixture traversal.
      role_results:
        coder-worker: null
        coder-worker-test-challenger: null
    dod_status: pass
```

## Required Traceability

| Requirement ID | ADR/user requirement | Disposition | Task IDs | Validation |
| --- | --- | --- | --- | --- |
| DECL-REQ-1 | Continue TS/JS capture | implementation | DECL-1 | Real grammar composed extraction |
| DECL-REQ-2 | Preserve correct placement | implementation | DECL-1 | Parent/self and refusal tests |

## Decisions And Non-Goals

Compared twice: existing pure placement hook (selected), fabricated ranges
(breaks identity), generic language-specific reparenting (unnecessary shared
compatibility risk). Selected option preserves ownership and source positions,
adds constant-time parent lookup, no dependency or execution surface, and rolls
back by removing two files. Four bounded reviewers examined contract and grammar.
Two Sol medium helpers own source and tests; parent performs integration.

API: emitTypeScriptDeclarationCaptures(node) accepts one named syntax node among
function_declaration, generator_function_declaration, function_expression,
generator_function, class_declaration, abstract_class_declaration, class.
Anonymous expressions return []; unsupported nodes/error syntax/escaped names
throw. Emit @declaration.function or @declaration.class with whole-node range
and empty text; @declaration.name with native name range/text; metadata
@typescript.binding_scope with parent/self and name range. No AST retention.
typeScriptDeclarationBindingScope(match, innermost, tree) returns null without
metadata; otherwise validates metadata, anchor kind and exact lexical range,
returning immediate parent for declarations and self for expressions. Missing
scope/parent is a failure. Names can be identifier or TS type_identifier.
Class declaration placement models lexical visibility only; type namespace,
inner immutable class self-binding and temporal semantics remain activation gates.

Validation budget: focused tests 2; typechecks 2; builds/launches 0.
OntoIndex transport closed; source inspection is authority. Child stale-index
observation is not graph evidence and triggered no refresh.
Knowledge handoff: none; existing navigation rules cover transport fallback.

## Closeout

Validation attempt 1: focused Vitest exit 1, 10 failed / 61 passed. Class
fixtures pass anonymous `class` keyword tokens from descendantsOfType into the
named-node emitter (test helper line 32; emitter line 55). Fixture-owner
correction: filter named nodes consistently in declaration traversals; retain
production rejection. One focused test invocation remains; typechecks 0/2.
Correction scope remains the declared test file; no production expansion.

Corrected final validation: 3 files / 71 tests passed, exit 0, 2.44s
(receipt call_KtUVLmgbwuaTiqlEvPSYeQO9). Production tsc --noEmit exit 0
in the same receipt. git diff --check exit 0 (call_uow42c85hJNRWjSTyGCeYsRs).
Budgets consumed: tests 2/2; typechecks 1/2; builds/launches 0.
Source SHA-256: da9c25fa3e583d1580ee99289549900262655f2fe880da8a866b26c3008044c2.
Test SHA-256: c817a19a4745bc72d382624ae5c6ce15a0d020e264c8c70aedd743cdaacb0eab.
Test fixture traversal now excludes anonymous keyword tokens at all four sites;
production rejection remains unchanged. Source avoids repeated recursive subtree
scans and uses propagated parser error state. Provider activation remains open.
