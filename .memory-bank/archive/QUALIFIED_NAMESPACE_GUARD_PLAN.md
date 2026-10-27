# Qualified namespace fallback admission

Date: 2026-10-24
Status: Closed
Authority: User proceed; ../ADR_TYPE_VALUE_NAMESPACES.md

## Goal

Prevent source-spelling canonical fallback from bypassing explicit namespace
bindings or module-only import restrictions until export-aware traversal exists.

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
  NS-3A:
    title: Tagged qualified prefixes cannot escape into canonical global fallback
    status: DONE
    classification: implementation-ready
    assurance_profile: full
    complexity: complex
    type: code
    depends_on: []
    validation_tier: unit-fast
    impact_risk: medium
    owner_files:
    - ontoindex-shared/src/scope-resolution/registries/lookup-qualified.ts
    - ontoindex-shared/src/scope-resolution/registries/lookup-core.ts
    - ontoindex-shared/src/scope-resolution/resolve-type-ref.ts
    - ontoindex/src/core/ingestion/finalize-orchestrator.ts
    - ontoindex/test/unit/scope-resolution/registries.test.ts
    - ontoindex/test/unit/scope-resolution/resolve-type-ref.test.ts
    - ontoindex/test/unit/scope-resolution/finalize-orchestrator.test.ts
    allowed_write_set:
    - ontoindex-shared/src/scope-resolution/registries/lookup-qualified.ts
    - ontoindex-shared/src/scope-resolution/registries/lookup-core.ts
    - ontoindex-shared/src/scope-resolution/resolve-type-ref.ts
    - ontoindex/src/core/ingestion/finalize-orchestrator.ts
    - ontoindex/test/unit/scope-resolution/registries.test.ts
    - ontoindex/test/unit/scope-resolution/resolve-type-ref.test.ts
    - ontoindex/test/unit/scope-resolution/finalize-orchestrator.test.ts
    non_goals:
    - Full export-aware alias traversal or provider activation
    - Receiver and owner resolution changes or global index changes
    - Preparation limit changes or runtime deployment
    required_validation:
    - cd ontoindex-shared && ../ontoindex/node_modules/.bin/tsc
    - cd ontoindex && ONTOINDEX_TEST_WORKERS=1 ./node_modules/.bin/vitest run test/unit/scope-resolution/registries.test.ts test/unit/scope-resolution/resolve-type-ref.test.ts test/unit/scope-resolution/finalize-orchestrator.test.ts test/unit/scope-resolution/finalize-algorithm.test.ts
    - cd ontoindex && ./node_modules/.bin/tsc --noEmit --incremental false
    expected_evidence:
    - Explicit tagged full spelling and segment prefixes block global fallback
    - Successful exact lexical resolution and untagged canonical behavior survive
    - Finalized module-only namespace imports reach the guard through adapter
    - Cyclic or missing scope chains fail closed in guarded paths
    rollback:
    - Reverse only NS-3A hunks preserving prior dirty work
    stop_conditions:
    - Requires export resolver activation or receiver semantic changes
    known_blockers: []
    closeout:
      role_results:
        coder-worker: null
        coder-worker-test-challenger: null
      main_session_evidence:
        authorized_by: user
        authorization_ref: Proceed with namespace prerequisite and two Sol-medium developers
        validation_summary: Four researchers compared alternatives and challenged boundaries; two Sol-medium developers implemented disjoint packets. Luna core and Sol adapter reviews found no blockers. Shared compilation exit 0 receipt 3a6441; four focused suites passed 192 tests exit 0 session 3732 terminal a7be8b; product typecheck exit 0 session 17849 terminal 8e98b3; seven-file whitespace exit 0 d44b3b. Declared-file OntoIndex verify_diff PASS with symbol scope skipped. Used one of two shared compilations one of two suites one of two typechecks; no retries child validation or runtime launches. See audit_session-2026-10-24-qualified-namespace-guard.md.
    dod_status: pass
```

## Required Traceability

| Requirement ID | Requirement | Disposition | Task IDs | Validation |
| --- | --- | --- | --- | --- |
| GUARD | Stop namespace restriction bypass | implementation | NS-3A | Registry and type regressions |
| EDGES | Preserve module-only finalized edges | implementation | NS-3A | Adapter integration |
| LEGACY | Canonical API and untagged compatibility | compatibility-test | NS-3A | Existing suites |
| RESOLVE | Full alias export traversal and receiver coverage | non-goal | NS-3A | Remains activation gate |

## Decisions And Non-Goals

Three solutions reviewed twice: kind inference cannot represent restricted class
imports; full export-aware traversal requires authoritative surfaces absent from
registry context; bounded fallback admission is selected as a safety prerequisite.
The guard conservatively refuses fallback even for matching tags, because the
global index does not establish member visibility. False-negative fallback is
explicitly accepted; this is not complete namespace resolution.

An internal helper in the existing qualified owner scans full dotted spelling
and dot-segment prefixes against explicitly tagged bindings and namespace-import
edges across a valid scope chain. Any match blocks fallback; missing or cyclic
chains fail closed. No kind inference, global cache or public barrel API. Exact
lexical success wins first. lookupCore invokes the guard only with an explicit
lexicalNamespace selector; resolveTypeRef guards its dotted fallback. Public
lookupQualified remains canonical and unchanged.

Adapter overlays finalized module imports alongside finalized bindings, preserving
original imports when no entry exists and respecting authoritative empty arrays.
Untagged edges remain legacy. Receiver and owner paths remain activation gates.

Correctness and privacy improve through refusal; compatibility stays opt-in for
generic lookup. Cost is a scope/prefix walk only on fallback, without definition
scans or new indexes. Local rollback and focused tests cover the seven-file patch.
Committed impact lookupCore MEDIUM; resolveTypeRef LOW; adapter symbol unindexed.
Current source is authority for dirty changes. Four researchers and two Sol-medium
developers are assigned. Parent budget: two shared compilations, two suite runs,
two typechecks; no child validation or runtime launch.

## Closeout

Implemented seven declared source/test files and preserved prior dirty work.
All 192 tests passed across four suites; shared compilation, product typecheck
and scoped whitespace exited 0. Declared-file verification passed; symbol scope
was not checked. Two independent source reviewers found no blockers.

Budget used: 1/2 shared compilations, 1/2 suite runs, 1/2 typechecks; zero retries,
child compiles/tests or runtime launches. No budget overrun. Full namespace alias,
receiver/owner and selector-free wrapper coverage remain activation gates.
