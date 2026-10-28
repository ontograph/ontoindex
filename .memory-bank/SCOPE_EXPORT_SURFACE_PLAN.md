# Explicit local export surface

Date: 2026-10-22
Status: Closed
Authority: User proceed on provider prerequisites

## Goal

Allow finalization callers to distinguish local definitions from importable names.

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
  EXPORT-1:
    title: Explicit exports reject private imports while preserving local bindings
    status: DONE
    classification: implementation-ready
    assurance_profile: full
    complexity: complex
    depends_on: []
    type: code
    validation_tier: unit-fast
    impact_risk: medium
    owner_files:
    - ontoindex-shared/src/scope-resolution/finalize-algorithm.ts
    - ontoindex/test/unit/scope-resolution/finalize-algorithm.test.ts
    allowed_write_set:
    - ontoindex-shared/src/scope-resolution/finalize-algorithm.ts
    - ontoindex/test/unit/scope-resolution/finalize-algorithm.test.ts
    non_goals:
    - No provider activation codec changes transitive export resolution or runtime navigation
    required_validation:
    - cd ontoindex-shared && ../ontoindex/node_modules/.bin/tsc
    - cd ontoindex && ONTOINDEX_TEST_WORKERS=1 ./node_modules/.bin/vitest run test/unit/scope-resolution/finalize-algorithm.test.ts test/unit/scope-resolution/finalize-orchestrator.test.ts
    - cd ontoindex && ./node_modules/.bin/tsc --noEmit
    - git diff --check
    expected_evidence:
    - Explicit empty exports prevent private imports without removing local bindings
    - Alias and default export names resolve original IDs and dangling IDs fail closed
    - Omitted metadata retains legacy behavior and wildcard lookup honors explicit surface
    rollback:
    - Revert EXPORT-1 hunks only
    stop_conditions:
    - Full reexport resolver or retained schema change required
    known_blockers: []
    closeout:
      role_results:
        coder-worker: null
        coder-worker-test-challenger: null
      main_session_evidence:
        authorized_by: user
        authorization_ref: User proceed on provider prerequisites
        validation_summary: Parent reviewed both diffs after four research packets and two Sol medium development packets. Shared compilation receipt f92a90 exit 0. Production typecheck session 94329 exit 0. Focused finalizer and orchestrator suite receipt ba9e12 passed 42 tests in two files exit 0. Whitespace validation passed. Seven new regressions cover private imports local preservation aliases default dangling IDs empty versus absent maps wildcard namespace and direct reexport limits. No provider or codec activation claimed.
    dod_status: pass
```

## Required Traceability

| Requirement ID | Requirement | Disposition | Task IDs | Validation |
| --- | --- | --- | --- | --- |
| EXPORT | Separate local and public names | implementation | EXPORT-1 | Finalizer regressions |
| CAPTURE | Capture codec and provider activation | non-goal | EXPORT-1 | Follow-up required |

## Decisions And Non-Goals

Filtering localDefs loses private lookup. Boolean export flags cannot represent
aliases or default names. A separate optional ReadonlyMap from exported name to
local DefId preserves identity and compatibility; select it. An empty map exports
nothing, absence preserves legacy name lookup. Dangling IDs never fall back to
name lookup. Second review requires keeping all local bindings and definitions.
Reexports and type/value namespaces require subsequent explicit contracts.
No extra resolver, persistence store, dependency or parse pass is introduced.
Lookup has the existing linear definition-scan bound plus constant-time map lookup.
Rollback is two files; existing fixtures prove legacy compatibility.

## Evidence

Four Sol medium read-only packets reviewed ownership, types, tests and design.
OntoIndex Transport closed; source inspection is authority. No retry or reindex.
Validation budget: two shared compilations, two focused runs, two typechecks.
Children run no validations. No installation or release.

## Closeout

One shared compilation and one typecheck ran. Two test invocation slots consumed:
the first returned no visible receipt and was confirmed no longer running; its
outcome is unknown. The second retained exit-zero receipt passed all 42 tests.
No source correction or build/install/release beyond shared test dependency
compilation. OntoIndex remained unavailable. Knowledge handoff: none; existing
manager-loop evidence rules already cover missing receipts.

