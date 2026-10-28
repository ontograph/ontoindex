# TS/JS import capture

Date: 2026-10-22
Status: In progress
Authority: User continuation of TS/JS scope capture and reviewed import contract.

## Goal

Detach ordinary static import bindings from one borrowed syntax node and interpret
them without losing unsupported syntax. Production providers remain unactivated.

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
  IMPORT-1:
    title: Ordinary static imports yield one detached record per binding and unsupported statements throw
    status: DONE
    classification: implementation-ready
    assurance_profile: lite
    complexity: simple
    depends_on: []
    type: code
    validation_tier: unit-fast
    impact_risk: low
    owner_files:
    - ontoindex/src/core/ingestion/languages/typescript-import-captures.ts
    - ontoindex/test/unit/scope-resolution/typescript-import-captures.test.ts
    allowed_write_set:
    - ontoindex/src/core/ingestion/languages/typescript-import-captures.ts
    - ontoindex/test/unit/scope-resolution/typescript-import-captures.test.ts
    non_goals:
    - Production activation or shared schema changes
    - Type-only side-effect attributed escaped-literal dynamic or CommonJS imports
    - Complete provider extraction or runtime navigation claims
    required_validation:
    - cd ontoindex && ONTOINDEX_TEST_WORKERS=1 ./node_modules/.bin/vitest run test/unit/scope-resolution/typescript-import-captures.test.ts test/unit/scope-resolution/typescript-scope-captures.test.ts
    - cd ontoindex && ./node_modules/.bin/tsc --noEmit
    - git diff --check
    expected_evidence:
    - Real TS TSX JS JSX grammars preserve named alias default namespace and combined bindings
    - Unsupported whole statements throw without returning partial captures
    - Detached captures survive JSON roundtrip and subsequent parsing and feed the existing extractor
    rollback:
    - Remove only the two newly introduced files
    stop_conditions:
    - Scope expansion or undecided shared import semantics
    - Exhausted validation budget
    known_blockers: []
    closeout:
      role_results:
        coder-worker: null
        coder-worker-test-challenger: null
      main_session_evidence:
        authorized_by: user
        authorization_ref: User proceed and standing delegation authorization
        validation_summary: Parent source review and integration accepted; 50 tests across two focused files passed exit 0 (9b97c4); product tsc --noEmit exit 0 (1474a1). Four discovery and two development Sol medium helpers used. Production activation excluded.
    dod_status: pass
```

## Required Traceability

| Requirement ID | ADR/user requirement | Disposition | Task IDs | Validation |
| --- | --- | --- | --- | --- |
| IMPORT-REQ-1 | Advance TS/JS capture while preserving evidence scope | implementation | IMPORT-1 | Real grammar and extractor tests |
| IMPORT-REQ-2 | Preserve unsupported semantics | implementation | IMPORT-1 | Whole-statement rejection tests |

## Decisions And Non-Goals

Three fixes compared twice: extend legacy named bindings (small but insufficient
representation); detached helper (selected, isolated and linear in import-node
size); expand shared schema/finalizer (necessary later for complete semantics,
but changes cross-language contracts). The second review challenged type-only,
side-effect, attributes, escaping, namespace resolution and combined clauses.
Explicit rejection is required for unsupported cases, with no provider activation.
Plain quoted names are supported; escapes are explicitly refused until an existing
complete decoder is selected. No eval, second parser, dependencies or AST retention.

API: emitTypeScriptImportCaptures(importNode) returns CaptureMatch[] and throws
on unsupported syntax. interpretTypeScriptImport(match) returns ParsedImport or
null for unrelated captures, throwing for malformed owned captures. Keys are
@import.binding (local identifier range/text), @import.source (unquoted target),
@import.name (imported name), @import.kind (named/alias/namespace). Default maps
to alias/default; namespace importedName equals targetRaw. All lines are one-based
and columns retain native positions. One match per binding, source order.

Four Sol medium discovery packets completed. Two Sol medium development helpers
own disjoint source/test files; parent owns integration and final validation.
Budget: two focused test invocations, two typechecks, no builds or launches.
OntoIndex transport closed earlier this turn; no retry; source is authority.
Knowledge handoff: none; existing navigation skill covers transport fallback.

Native tree-sitter Tree has no delete method; detached ownership is checked with
JSON roundtrip and a subsequent parse instead of claiming a deletion lifecycle.

## Closeout

Implemented ordinary named, alias, default, namespace and combined import captures.
All unsupported statements throw; interpreter validates detached capture structure.
Focused Vitest: 50 tests across two files passed, exit 0 (9b97c4).
Production TypeScript: exit 0 (1474a1). Budget consumed: tests 1/2;
typechecks 1/2; builds and launches 0. No runtime/release claim.
Source SHA-256: 204c1b0bfb6c134f483fa555fa5cf59c7141d7235354f406179eca92d6b42416.
Test SHA-256: c3e74318b4b22c5bf8f5dc4bbb6257f54fcce5e7e196c1a5242e28c4730554cc.
Native Rust formatter unavailable in this TypeScript checkout; whitespace checked.
One rejected 1000ms wait invocation started no work; the subsequent wait exposed
an unrelated historical plan_manager malformed receipt, which was not integrated.
No source scope expansion or validation retry occurred.
