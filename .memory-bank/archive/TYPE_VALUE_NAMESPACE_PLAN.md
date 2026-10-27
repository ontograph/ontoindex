# Type/value namespace prerequisite

Date: 2026-10-24
Status: Closed
Authority: User proceed; four-agent namespace review.

## Goal

Establish explicit lexical binding namespace semantics without changing existing
untagged callers or enabling incomplete TypeScript capture.

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
  NS-1:
    title: Explicit namespace bindings filter before lexical shadowing and survive strict retention
    status: DONE
    classification: implementation-ready
    assurance_profile: full
    complexity: complex
    depends_on: []
    type: code
    validation_tier: unit-fast
    impact_risk: medium
    owner_files:
    - ontoindex-shared/src/scope-resolution/types.ts
    - ontoindex-shared/src/scope-resolution/registries/lookup-core.ts
    - ontoindex-shared/src/scope-resolution/resolve-type-ref.ts
    - ontoindex/src/core/ingestion/pipeline-phases/parse-scope-codec.ts
    - ontoindex/test/unit/scope-resolution/registries.test.ts
    - ontoindex/test/unit/scope-resolution/resolve-type-ref.test.ts
    - ontoindex/test/unit/parse-worker-protocol.test.ts
    allowed_write_set:
    - ontoindex-shared/src/scope-resolution/types.ts
    - ontoindex-shared/src/scope-resolution/registries/lookup-core.ts
    - ontoindex-shared/src/scope-resolution/resolve-type-ref.ts
    - ontoindex/src/core/ingestion/pipeline-phases/parse-scope-codec.ts
    - ontoindex/test/unit/scope-resolution/registries.test.ts
    - ontoindex/test/unit/scope-resolution/resolve-type-ref.test.ts
    - ontoindex/test/unit/parse-worker-protocol.test.ts
    non_goals:
    - Capture activation or global qualified namespace resolution
    - Import or export namespace materialization
    - Replay activation or changing preparation limits
    required_validation:
    - cd ontoindex && ONTOINDEX_TEST_WORKERS=1 ./node_modules/.bin/vitest run test/unit/scope-resolution/registries.test.ts test/unit/scope-resolution/resolve-type-ref.test.ts test/unit/parse-worker-protocol.test.ts
    - cd ontoindex-shared && ../ontoindex/node_modules/.bin/tsc
    - cd ontoindex && ./node_modules/.bin/tsc --noEmit --incremental false
    expected_evidence:
    - Namespace mismatch does not shadow while same-namespace wrong-kind does
    - Untagged legacy behavior and omitted lookup option remain unchanged
    - Strict codec preserves each explicit namespace and refuses malformed values
    rollback:
    - Reverse only NS-1 hunks preserving preexisting edits
    stop_conditions:
    - Requires provider activation or imports and exports to claim lexical correctness
    known_blockers: []
    closeout:
      role_results:
        coder-worker: null
        coder-worker-test-challenger: null
      main_session_evidence:
        authorized_by: user
        authorization_ref: User proceed and explicit Sol-medium development authorization
        validation_summary: 88 tests passed exit 0 session 66219 terminal c3c840; shared compilation exit 0 session 78589 terminal 6f2ddc; product typecheck exit 0 session 2716 terminal 24ce06; independent review no blockers; OntoIndex declared-file verify_diff PASS with symbols not checked.
    dod_status: pass
```

## Required Traceability

| Requirement ID | User requirement | Disposition | Task IDs | Validation |
| --- | --- | --- | --- | --- |
| NS-LEX | Preserve value/type visibility and legacy behavior | implementation | NS-1 | Lexical shadow matrix |
| NS-CODEC | Preserve explicit restrictions through retention | compatibility-test | NS-1 | Strict roundtrip and malformed records |
| NS-ACTIVATE | Complete imports/exports before widening capture | non-goal | NS-1 | Capture remains unchanged |

## Decisions And Non-Goals

Compared twice: infer namespace from kind; separate binding maps/resolvers;
optional metadata in existing binding maps. Select optional metadata: kind
inference loses type-only class imports, while separate maps duplicate owners.
The additive contract keeps existing untagged behavior, constant per-binding
filter work, unchanged storage bounds and local rollback. Strict validation
rejects invalid metadata; new readers accept old records, old readers reject
new fields. Tests must use distinct type/value IDs as well as dual-space classes.

Second challenge: metadata alone does not fix finalization or qualified fallback.
This slice therefore exposes a lexicalNamespace option only; generic lookup
without it retains legacy behavior. resolveTypeRef filters explicit value-only
bindings before shadowing. Global qualified indexes retain their existing
contract; no namespace-aware capture or consumer activation is authorized here.

Follow-on design: imports must intersect requested and exported namespaces;
exports need distinct type/value maps with authoritative empty semantics.
Only after that flow and qualified access are tested may TS/TSX aliases enter
canonical bindings. Provider completeness, semantic admission and production
replay remain independent gates. These follow-ons require separately bounded
executable packets after NS-1 evidence, not edits under this task.

Four read-only reviews completed. Two Sol-medium development packets own
disjoint lookup versus codec files. Parent alone validates: allowance two
focused test invocations, two shared compilations and two product typechecks,
including a correction round if needed; zero runtime launches or deployments.
OntoIndex committed impact: lookupCore MEDIUM, resolveTypeRef and codec LOW.
Workspace safe-edit failed workspace_too_large (1832 > 1600); source is authority
for current edits. No reindex is warranted by dirtiness alone.

## Closeout

Implemented optional binding namespace, explicit lexical selector and filtering
before hard shadowing; strict parsed-file codec preserves and validates metadata.
Added 26 regression cases across three suites; all 88 tests passed. Shared
compilation and product typecheck exited 0. Six agents participated, including
two Sol-medium developers; two researchers independently reviewed the result.
Budget consumed one of two suites, one of two shared compilations, one of two
product typechecks; zero runtime launches or deployments. No correction run.
Rust formatting is inapplicable to this TypeScript checkout.

Declared-file OntoIndex verification passed; symbol expectations were not supplied
and no symbol-scope verification is claimed. Default safe-edit remains blocked
at 1832 indexed files versus limit 1600. Existing dirty edits were preserved.
No capture or consumer activation occurred; import/export namespace propagation,
qualified access, semantic admission and runtime navigation remain open.
