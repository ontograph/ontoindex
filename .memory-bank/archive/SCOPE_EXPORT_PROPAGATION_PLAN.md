# Parsed export metadata propagation

Date: 2026-10-22
Status: Closed
Authority: User proceed on export metadata prerequisite

## Goal

Preserve explicit local export maps through parsed-file retention and finalization.

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
  EXPORT-2:
    title: Retained export maps preserve visibility and local definitions
    status: DONE
    classification: implementation-ready
    assurance_profile: full
    complexity: complex
    depends_on: []
    type: code
    validation_tier: unit-fast
    impact_risk: medium
    owner_files:
    - ontoindex-shared/src/scope-resolution/parsed-file.ts
    - ontoindex/src/core/ingestion/finalize-orchestrator.ts
    - ontoindex/src/core/ingestion/pipeline-phases/parse-scope-codec.ts
    - ontoindex/test/unit/scope-retention.test.ts
    - ontoindex/test/unit/scope-resolution/finalize-orchestrator.test.ts
    allowed_write_set:
    - ontoindex-shared/src/scope-resolution/parsed-file.ts
    - ontoindex/src/core/ingestion/finalize-orchestrator.ts
    - ontoindex/src/core/ingestion/pipeline-phases/parse-scope-codec.ts
    - ontoindex/test/unit/scope-retention.test.ts
    - ontoindex/test/unit/scope-resolution/finalize-orchestrator.test.ts
    non_goals:
    - Provider activation transitive exports persistence and runtime workspace navigation
    required_validation:
    - cd ontoindex-shared && ../ontoindex/node_modules/.bin/tsc
    - cd ontoindex && ONTOINDEX_TEST_WORKERS=1 ./node_modules/.bin/vitest run test/unit/scope-retention.test.ts test/unit/scope-resolution/finalize-orchestrator.test.ts test/unit/scope-resolution/finalize-algorithm.test.ts
    - cd ontoindex && ./node_modules/.bin/tsc --noEmit
    - git diff --check
    expected_evidence:
    - Absent empty undefined and populated export maps round trip distinctly
    - Invalid maps fail closed within existing byte limits
    - Replayed aliases resolve original IDs and private imports remain unresolved while local definitions survive
    rollback:
    - Revert only EXPORT-2 hunks in the five declared files
    stop_conditions:
    - Requires provider activation or cross-version persistent format migration
    known_blockers: []
    closeout:
      role_results:
        coder-worker: null
        coder-worker-test-challenger: null
      main_session_evidence:
        authorized_by: user
        authorization_ref: User proceed on export metadata prerequisite
        validation_summary: Parent reviewed five-file diff after two read-only Sol reviews and two Sol medium development helpers. Shared tsc receipt 15c693 exit 0. Product tsc session 18616 terminal receipt 2878b1 exit 0. Focused retention orchestrator and finalizer suites receipt 4c5e56 exit 0 with 99 tests in three files. Tests verify optional state preservation malformed-map rejection byte limits alias resolution private-import rejection local-definition retention and capture ownership isolation. Whitespace validation passed. No provider activation or runtime navigation claim.
    dod_status: pass
```

## Required Traceability

| Requirement ID | Requirement | Disposition | Task IDs | Validation |
| --- | --- | --- | --- | --- |
| PROP | Carry optional export surface without losing local definitions | implementation | EXPORT-2 | Retention and finalizer tests |
| COMPAT | Preserve omitted metadata legacy behavior and fail-closed validation | compatibility-test | EXPORT-2 | Codec regression tests |

## Decisions And Non-Goals

Three alternatives: extend the existing bounded tagged-map codec; introduce a
separate export record/version; defer propagation until provider activation.
Select codec reuse: one validation owner, existing byte/depth bounds, linear
serialization, no extra dependencies or side-channel cleanup. Separate records
add identity/join/rollback failure modes; deferral leaves finalization unable to
receive the already-supported surface. Filtering localDefs is rejected because
it destroys private local lookup and cannot express exported aliases.

Second review must confirm empty versus absent maps, explicit undefined, duplicate
keys, invalid values and byte accounting. The transient store uses the same
producer/consumer build. Version 1 remains; new readers accept old records, old
readers reject new fields. No cross-version persistence compatibility is claimed.
Rollback is confined to five files. Provider capture remains a separate gate.

## Evidence

OntoIndex Transport closed earlier in this turn; source inspection is authority.
No transport retry or reindex. Budget: at most two shared builds, two focused test
runs and two typechecks; children run none. No installs or releases. Two read-only
reviews precede two disjoint Sol medium development helpers. Parent owns acceptance.

## Closeout

Five declared code/test files changed. All 99 focused tests, shared compilation,
product typecheck and whitespace validation passed. Each validation category
consumed two reserved slots: one invocation returned no receipt and was confirmed
no longer running; the second retained terminal exit-zero evidence. Unknown first
outcomes are not claimed as passes. No budget remains for these categories.
No Rust formatting ran because this checkout has no ontocode-rs directory.
OntoIndex remained unavailable; no runtime, install or release proof claimed.
Knowledge handoff: none; existing manager-loop missing-receipt rules apply.
