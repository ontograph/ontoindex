# Model registration replay prerequisite

Date: 2026-10-22
Status: Completed prerequisite
Authority: ADR_AUTOMATIC_DIRTY_WORKSPACE.md frozen MODEL packet and user proceed.

## Goal

Capture and restore bounded ordered semantic-model registration mutations without
enabling workspace replay or changing default ingestion.

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
  MODEL-1:
    title: Opt-in bounded mutation replay preserves symbol and registry behavior
    status: DONE
    classification: implementation-ready
    assurance_profile: full
    complexity: standard
    depends_on: []
    type: code
    validation_tier: unit-fast
    impact_risk: medium
    owner_files:
    - ontoindex/src/core/ingestion/model/semantic-model.ts
    - ontoindex/test/unit/model/semantic-model.test.ts
    allowed_write_set:
    - ontoindex/src/core/ingestion/model/semantic-model.ts
    - ontoindex/test/unit/model/semantic-model.test.ts
    non_goals:
    - No scope replay or persistence or activation or new CLI configuration
    required_validation:
    - cd ontoindex && ONTOINDEX_TEST_WORKERS=1 ./node_modules/.bin/vitest run test/unit/model/semantic-model.test.ts test/unit/model/registration-table.test.ts
    - cd ontoindex && ./node_modules/.bin/tsc --noEmit
    - git diff --check
    expected_evidence:
    - Duplicate fan-out and direct mutations preserve ordering and clear semantics
    - Snapshot ownership is independent and malformed or over-limit input cannot return partially restored models
    - Default factory records nothing and existing behavior remains compatible
    rollback:
    - Revert only MODEL-1 source and test hunks
    stop_conditions:
    - Scope expansion or unresolved live-object mutation semantics
    known_blockers: []
    closeout:
      role_results:
        coder-worker: null
        coder-worker-test-challenger: null
      main_session_evidence:
        authorized_by: user
        authorization_ref: User proceed on MODEL prerequisite
        validation_summary: Opt-in chronological registration replay implemented and reviewed in declared two files. Final focused Vitest run passed 55 tests in two files exit 0; tsc --noEmit exit 0; git diff --check exit 0. Exact event and aggregate byte boundaries tested. Disabled capture preserves original add path. No runtime activation or complete seed claim.
    dod_status: pass
```

## Required Traceability

| Requirement ID | Requirement | Disposition | Task IDs | Validation |
| --- | --- | --- | --- | --- |
| MODEL-001 | Frozen MODEL registration prerequisite | implementation | MODEL-1 | Focused semantic round trips and malformed/boundary cases |

## Decisions and second challenge

Compared unique-definition serialization, symbols-only journal and chronological
mutation capture. Select chronological capture in the existing model owner:
the first loses duplicate fan-out and the second misses exposed registry writes.
Second review preserves original Function/owner metadata, nested-capture
suppression, individual/full clear, bounded pre-encoding admission and independent
metadata ownership. Live definition mutation requires explicit treatment; it must
not silently be represented as complete current model state.

## Execution evidence

New MODEL slice budget: at most two focused test invocations and two TypeScript
checks, initially zero used; no builds, installs, releases or live launches.
Earlier advice/safety validation remains separate and is not rerun.
OntoIndex freshness and createSemanticModel impact both returned Transport closed;
source inspection is authority. Source and test edits are delegated separately;
parent owns validation and integration. Prior closed trackers remain unchanged.

## Remaining sequence

SCOPE, CALLS and SEED retain the frozen ADR packets and require successor tracking
after this prerequisite. Complete source/generation identity, independent full
analysis parity and activation remain outstanding.

## Closeout

MODEL-1 completed through complete-local. Final manager decision: no-dispatch,
no eligible task. Workspace replay implementation remains outstanding.

Final validation consumed two focused suite invocations and two typechecks of
two allowed each. First suite passed 54 tests; final suite passed 55 tests after
descriptor-copy admission correction and exact-byte regression additions. Both
typechecks and final whitespace check exited 0. No build/install/live launch.
Own-key enumeration still uses JavaScript reflection; serialized event and total
payload limits do not claim a hard bound on reflection over arbitrary hostile
in-memory objects. Live definition edits remain outside registration replay.
Source SHA256: e41de1c1b0a7a218735dd6b273a1f1df1ccca527e5114b48c6a393921eb21c76.
Test SHA256: e89dc73b4342c93c1bb77a4d5ebd846f77d9688c3fb154f32fad2679ae5b010e.
Knowledge handoff: none; existing validation and transport rules cover findings.
