# Explicit scope extraction outcomes

Date: 2026-10-22
Status: In progress
Authority: User proceed; ADR_AUTOMATIC_DIRTY_WORKSPACE.md SCOPE retention prerequisite.

## Goal

Distinguish unsupported and failed extraction before retained artifacts can be
used as completeness evidence, while preserving existing parsing callers.

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
  OUTCOME-1:
    title: Explicit extraction result distinguishes success unsupported hook and failed extraction
    status: DONE
    classification: implementation-ready
    assurance_profile: full
    complexity: standard
    depends_on: []
    type: code
    validation_tier: unit-fast
    impact_risk: medium
    owner_files:
    - ontoindex/src/core/ingestion/scope-extractor-bridge.ts
    - ontoindex/test/unit/scope-resolution/parse-worker-scope-integration.test.ts
    allowed_write_set:
    - ontoindex/src/core/ingestion/scope-extractor-bridge.ts
    - ontoindex/test/unit/scope-resolution/parse-worker-scope-integration.test.ts
    non_goals:
    - No retention publication worker protocol changes or runtime activation
    required_validation:
    - cd ontoindex && ONTOINDEX_TEST_WORKERS=1 ./node_modules/.bin/vitest run test/unit/scope-resolution/parse-worker-scope-integration.test.ts test/unit/parse-impl-fallback.test.ts
    - cd ontoindex && ./node_modules/.bin/tsc --noEmit
    - git diff --check
    expected_evidence:
    - Success preserves ParsedFile and invokes hook once
    - Unsupported hook and failed extraction are distinct
    - Silent C++ missing-module outcome remains a failure
    - Legacy wrapper preserves values warnings and warning-callback exceptions
    rollback:
    - Revert only OUTCOME-1 hunks
    stop_conditions:
    - Scope expansion or worker protocol modification
    known_blockers: []
    closeout:
      role_results:
        coder-worker: null
        coder-worker-test-challenger: null
      main_session_evidence:
        authorized_by: user
        authorization_ref: User proceed on reviewed SCOPE successor
        validation_summary: Two Sol medium development packets implemented source and tests separately; independent Luna review found no blocking gap. Parent reviewed final diffs and confirmed hashes. Focused Vitest passed 37 tests in two files exit 0 in 4.46 seconds; TypeScript noEmit exit 0; git diff --check exit 0. Explicit outcomes preserve legacy wrapper warnings and single extraction; silent C++ missing-module remains failed. No retention or runtime activation claim.
    dod_status: pass
```

## Required Traceability

| Requirement ID | Requirement | Disposition | Task IDs | Validation |
| --- | --- | --- | --- | --- |
| SCOPE-OUTCOME | Empty artifact lists cannot prove complete extraction | implementation | OUTCOME-1 | Explicit branch outcomes and wrapper compatibility |

## Decisions and second challenge

Changing the existing return type forces all callers to migrate and risks legacy
parsing. A status callback adds side-effect ordering and optional-delivery
ambiguity. Select a typed result in the existing bridge plus a legacy wrapper:
one extraction invocation and no new dependencies or metadata copies. A small
result object per extraction is the compatibility cost. Rollback stays local.

Second review requires silent C++ no-module cases to remain failed, preserves
warning callback exceptions, and avoids leaking arbitrary thrown values through
the new result. Unsupported means only missing hook. Neither successful scope
extraction nor this API proves complete file inventory, parser identity or MRO.

## Execution evidence

OntoIndex freshness failed with Transport closed; source inspection is authority.
Two independent explorers reviewed the bridge and callers. Two Sol medium
development packets own disjoint source and test files. Parent owns validation.
Budget: at most two focused suites and two typechecks; zero builds/installations.

## Remaining sequence

Next capture-aware callers must preserve per-file outcomes before chunk disposal,
including skipped and quarantined paths. Bounded immutable retention, effective
configuration identity, handle lifetime, CALLS and SEED remain outstanding.

## Closeout

Validation used one of two focused suites and one of two typechecks. Both exited
0; whitespace check exited 0. No build/install/reindex. Rust formatting is not
applicable to these TypeScript-only changes. Source SHA256:
33227e9349fe95f3e5ce01606a386a9478de93dfcb353457b384d1b31f1aa0c3.
Test SHA256: 6d5becc34bb6b5efb74884a4448db5cf0ffc3711851a716b444446cf51204aa0.
Knowledge handoff: none; existing validation and transport rules cover findings.
