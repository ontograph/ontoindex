# TS/JS lexical scope capture

Date: 2026-10-22
Status: Closed
Authority: User proceed; ADR_AUTOMATIC_DIRTY_WORKSPACE.md SCOPE contract

## Goal

Extract detached lexical scope ranges from borrowed TS/JS parser roots and prove
their nesting with real grammars before provider activation.

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
  LEX-1:
    title: Borrowed TS/JS roots produce deterministic detached lexical scope captures
    status: DONE
    classification: implementation-ready
    assurance_profile: lite
    complexity: simple
    depends_on: []
    type: code
    validation_tier: unit-fast
    impact_risk: low
    owner_files:
    - ontoindex/src/core/ingestion/languages/typescript-scope-captures.ts
    - ontoindex/test/unit/scope-resolution/typescript-scope-captures.test.ts
    allowed_write_set:
    - ontoindex/src/core/ingestion/languages/typescript-scope-captures.ts
    - ontoindex/test/unit/scope-resolution/typescript-scope-captures.test.ts
    non_goals:
    - Provider activation or complete ParsedFile certification
    - Bindings imports exports references and CALLS replay
    required_validation:
    - cd ontoindex && ONTOINDEX_TEST_WORKERS=1 ./node_modules/.bin/vitest run test/unit/scope-resolution/typescript-scope-captures.test.ts test/unit/scope-resolution/scope-extractor.test.ts
    - cd ontoindex && ./node_modules/.bin/tsc --noEmit
    - git diff --check
    expected_evidence:
    - Real TS TSX JS JSX trees yield deterministic nested scopes through the existing extractor
    - Malformed roots refuse capture and production providers remain unsupported
    rollback:
    - Remove only the two new task files
    stop_conditions:
    - Changes require provider activation or shared extractor semantics
    known_blockers: []
    closeout:
      role_results:
        coder-worker: null
        coder-worker-test-challenger: null
      main_session_evidence:
        authorized_by: user
        authorization_ref: User proceed on TS/JS capture prerequisite
        validation_summary: Parent reviewed both new files and verified hashes. Focused Vitest exit 0 with 59 tests in 2 files (4d9559); production tsc exit 0 (204ff6); git diff --check exit 0 (c7dfaf). Named-node correction removes keyword scopes. Providers remain unactivated. Two Sol medium helpers; parent execution is acceptance evidence.
    dod_status: pass
```

## Required Traceability

| Requirement ID | ADR/user requirement | Disposition | Task IDs | Validation |
| --- | --- | --- | --- | --- |
| LEX-R1 | Borrow existing trees synchronously and detach facts | implementation | LEX-1 | Real grammar tests |
| LEX-R2 | Incomplete extraction cannot certify replay | compatibility-test | LEX-1 | Providers retain missing hook |

## Decisions And Non-Goals

Three approaches reviewed: activate minimal scopes now (reject false success),
complete all provider semantics at once (defer until identity and binding rules
are proven), and implement lexical capture as the first unactivated component
(selected). The component uses the existing CaptureMatch/extractor contract,
one linear cursor traversal, no new dependencies or persistent state. Activation
will consume it alongside declarations, imports, exports and references.

Second challenge: lexical scopes alone cannot prove resolution correctness.
This task establishes ranges only. Functions include parameters and body;
function body blocks remain distinct, enabling later parameter/body binding rules.
Classes and interfaces use whole declaration ranges. Statement blocks, for loops,
catch clauses and switch bodies create Block scopes. Internal modules create
Namespace scopes. Static blocks use their statement block. Ambient wrappers and
overload signatures introduce no runtime scope. Reject parse errors and missing
nodes. Capture text is empty because scope consumers need only ranges, avoiding
quadratic retained source text for deeply nested constructs. No AST is retained.

Four read-only Sol reviewers completed discovery. Two Sol medium helpers own
disjoint source/test files; parent owns acceptance. Test budget 2 runs, typecheck
budget 2 runs, no build/install/reindex. OntoIndex transport closed this turn;
source inspection is authority. No graph impact result available.

## Closeout

Validation attempt 1: focused Vitest exit 1, 51 passed and 8 failed. Class
fixtures each gained one extra scope because anonymous keyword tokens share
the class-expression node type. Correction round 1 filters emission to named
nodes; removing class support would lose expressions and changing expected
counts would preserve a false scope. Source helper owns the correction.
Test budget used 1/2; typecheck 0/2. No activation or graph claims.

Final validation: focused Vitest exit 0, 59/59 tests in two files (4d9559).
Production TypeScript exit 0 (204ff6). Test budget 2/2, typecheck 1/2.
Source SHA256: 434da73e9d70cc5d930beb80ce1e93aff2cb3b3454f6c9cb7201dfcd74e5e5b3.
Test SHA256: 590a8f8a272ea3020941415c44e78080e45acb0f0c5965fbf65caf9c52171dfc.
No install, build, reindex or runtime activation. The native TypeScript checkout
has no ontocode-rs formatter target; no unrelated Rust formatting was attempted.
Knowledge handoff: none; existing validation-diagnosis already requires tracing
failed assertions before changing expectations. Source correction receipt was
abbreviated; parent source review, hashes and executed tests are acceptance evidence.
