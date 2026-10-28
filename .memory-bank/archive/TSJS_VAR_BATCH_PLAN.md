# TS/JS file-batch var validation

Date: 2026-10-22
Status: Closed
Authority: User proceed on consolidated follow-up; ADR_AUTOMATIC_DIRTY_WORKSPACE.md

## Goal

Share repeated sibling and signature validation within one borrowed-root var
capture call while preserving supported captures and fail-closed semantics.

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
  BATCH-1:
    title: File-batch var capture validates each shared sibling environment and signature once
    status: DONE
    classification: implementation-ready
    assurance_profile: full
    complexity: complex
    depends_on: []
    type: code
    validation_tier: unit-fast
    impact_risk: medium
    owner_files:
    - ontoindex/src/core/ingestion/languages/typescript-declaration-captures.ts
    - ontoindex/test/unit/scope-resolution/typescript-declaration-captures.test.ts
    allowed_write_set:
    - ontoindex/src/core/ingestion/languages/typescript-declaration-captures.ts
    - ontoindex/test/unit/scope-resolution/typescript-declaration-captures.test.ts
    non_goals:
    - Provider activation and shared schema changes
    - Elimination of per-var ancestor walks or measured runtime speedup claims
    required_validation:
    - cd ontoindex && ONTOINDEX_TEST_WORKERS=1 ./node_modules/.bin/vitest run test/unit/scope-resolution/typescript-declaration-captures.test.ts test/unit/scope-resolution/scope-extractor.test.ts test/unit/scope-resolution/typescript-scope-captures.test.ts
    - cd ontoindex && ./node_modules/.bin/tsc --noEmit
    expected_evidence:
    - Batch captures equal individual captures in TS TSX JS JSX
    - Shared ancestor scans and signature validation stay constant as sibling var count grows
    - Unsupported visited environments refuse and separate calls share no cache
    rollback:
    - Remove additive batch API and cache changes while preserving prior VAR-1 work
    stop_conditions:
    - Semantic expansion or production provider wiring required
    known_blockers: []
    closeout:
      role_results:
        coder-worker: null
        coder-worker-test-challenger: null
      main_session_evidence:
        authorized_by: user
        authorization_ref: User proceed on consolidated follow-up
        validation_summary: Parent reviewed source and test changes from two Sol medium helpers. Focused Vitest passed 179 tests across three files exit 0 in 2.58 seconds; production tsc noEmit exit 0; git diff --check exit 0. Structural counters prove one shared block scan and signature validation for 16 and64 vars and fresh validation per invocation. Parent verified source and test hashes. Source helper reviewed tests with no blocking finding. Test helper was closed while completing receipts; no completed child validation is claimed.
    dod_status: pass
```

## Required Traceability

| Requirement ID | Requirement | Disposition | Task IDs | Validation |
| --- | --- | --- | --- | --- |
| BATCH-COST | Remove repeated sibling and signature scans | implementation | BATCH-1 | Structural access-count regression |
| BATCH-PARITY | Preserve captures and refusals | compatibility-test | BATCH-1 | Real grammar parity and failure cases |

## Decisions And Non-Goals

Compared twice: per-node cache cannot amortize separate var calls; root-batch
lazy caches share existing validators with minimal compatibility risk; full
environment-stack traversal changes more semantics and is deferred. Select the
batch API in the existing owner. Use no global cache, new dependency, or setting.
Invocation-local caches release all borrowed AST state at return. Work is unique
sibling/signature scanning plus per-var ancestor walks and emitted output; deep
nesting can still be quadratic. No full linear-time or runtime speedup claim.
Rollback is local and changes no stored data. Unsupported syntax must still fail.

Four research packets informed this comparison; parent source verification is
authority where child receipts are incomplete. Two Sol medium development helpers
own source and tests separately; parent owns validation and integration.
Budget: two focused suite runs and two typechecks; zero used at creation.
OntoIndex freshness failed with Transport closed. A child separately reported a
stale index; no graph-backed impact claim is made and no refresh is launched.

## Closeout

Added a file-batch API sharing lazy collision-name and signature caches within
one call. Existing single-node behavior and refusal checks remain intact.
Source SHA-256: ad35418fda5337c4cd03248a9dc43488dd1327ff5d360239a1830cff807e3c0e.
Test SHA-256: a12078a4b4b48ec8b1df868128b0da26b3d5f894feceb6f55e7099b9e1e9e251.
Budget used: one of two suite runs and one of two typechecks. Suite receipt:
call_QzAKVpFctoBGyS066SHYLBwu; typecheck and whitespace receipt:
call_R4xbiMuGH7RPv7KaJak5v8jY. Logs: /tmp/ontoindex-batch1-tests.log and
/tmp/ontoindex-batch1-typecheck.log. No build, install, release or reindex.
Provider activation and per-var ancestor cost remain outstanding.

