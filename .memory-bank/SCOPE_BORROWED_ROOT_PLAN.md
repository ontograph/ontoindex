# Borrowed parse root for scope capture

Date: 2026-10-22
Status: Closed
Authority: User proceed; SCOPE provider prerequisite.

## Goal

Pass the existing AST root synchronously to scope hooks without parsing again.

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
  ROOT-1:
    title: Existing parse roots reach scope hooks with compatible legacy arguments
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
    - ontoindex/src/core/ingestion/scope-extractor-bridge.ts
    - ontoindex/src/core/ingestion/parsing-processor.ts
    - ontoindex/src/core/ingestion/workers/parse-worker.ts
    - ontoindex/test/unit/scope-resolution/parse-worker-scope-integration.test.ts
    allowed_write_set:
    - ontoindex/src/core/ingestion/language-provider.ts
    - ontoindex/src/core/ingestion/scope-extractor-bridge.ts
    - ontoindex/src/core/ingestion/parsing-processor.ts
    - ontoindex/src/core/ingestion/workers/parse-worker.ts
    - ontoindex/test/unit/scope-resolution/parse-worker-scope-integration.test.ts
    non_goals:
    - No provider activation export contract changes serialization or persistence
    required_validation:
    - cd ontoindex && ONTOINDEX_TEST_WORKERS=1 ./node_modules/.bin/vitest run test/unit/scope-resolution/parse-worker-scope-integration.test.ts test/unit/parse-impl-fallback.test.ts
    - cd ontoindex && ./node_modules/.bin/tsc --noEmit
    - git diff --check
    expected_evidence:
    - Bridge preserves root identity and legacy warning callback
    - Sequential and fallback hooks receive root matching transformed source
    - Existing failure and unsupported behavior remains intact
    rollback:
    - Revert ROOT-1 hunks only
    stop_conditions:
    - Borrowed root requires retention beyond synchronous hook
    known_blockers: []
    closeout:
      role_results:
        coder-worker: null
        coder-worker-test-challenger: null
      main_session_evidence:
        authorized_by: user
        authorization_ref: User proceed on scope prerequisite
        validation_summary: Parent inspected all five file diffs. First focused run failed two Vue fixture assertions because AST text excludes leading whitespace. Corrected assertions to compare source slice at AST offsets. Final session 55236 passed 60 tests across two files exit 0 in 4.30 seconds. TypeScript session 27781 exit 0. git diff --check exit 0. Five source hashes recorded in receipt 6fc46d. Two development helpers used disjoint source and test scopes; acceptance rests on parent inspection and execution. Compiled worker runtime not exercised; no provider activation or workspace navigation claim.
    dod_status: pass
```

## Required Traceability

| Requirement ID | Requirement | Disposition | Task IDs | Validation |
| --- | --- | --- | --- | --- |
| ROOT | Reuse parser output without second parse | implementation | ROOT-1 | Bridge and sequential regression tests |

## Decisions And Non-Goals

Optional borrowed root preserves existing providers with no extra parsing or
dependencies. A required root breaks source-only callers. Parsing inside each
hook duplicates resource work and grammar selection. Second challenge requires
root/source alignment for transformed Vue text, synchronous lifetime only and
no AST serialization. Provider export fidelity remains a separate prerequisite.

## Evidence

OntoIndex Transport closed; source inspection is authority. Four Sol medium
research packets reviewed parser ownership, capture fidelity, tests and lifetime.
Two Sol medium developers own disjoint source and tests. Main session validates.
Budget: two focused suites and two typechecks; no builds or installations.

## Closeout

Budget consumed: two focused suite invocations, one typecheck, zero builds or
installations. One fixture correction; no production correction required.
OntoIndex transport remained unavailable; no repeated transport call.
Knowledge handoff: none; existing validation-diagnosis rules cover fixture
failures and bounded retries. Export-surface fidelity remains prerequisite to
TS/JS provider activation.

