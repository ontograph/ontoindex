# Resolution state implementation
Date: 2026-10-21
Status: Closed (import-map prerequisite)
Authority: User proceed after staged resolution prerequisite review

## Goal

Preserve lossless import-resolution map state before complete seed persistence.

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
  MAP-1:
    title: Lossless import-resolution map snapshot and validated restoration
    status: DONE
    classification: implementation-ready
    assurance_profile: full
    complexity: standard
    depends_on: []
    type: code
    validation_tier: unit-fast
    impact_risk: low
    owner_files:
    - ontoindex/src/core/ingestion/model/resolution-context.ts
    - ontoindex/test/unit/model/import-resolution-state.test.ts
    allowed_write_set:
    - ontoindex/src/core/ingestion/model/resolution-context.ts
    - ontoindex/test/unit/model/import-resolution-state.test.ts
    non_goals:
    - No complete seed claim or filesystem publication or runtime activation
    required_validation:
    - cd ontoindex && ONTOINDEX_TEST_WORKERS=1 ./node_modules/.bin/vitest run test/unit/model/import-resolution-state.test.ts test/unit/model/resolution-context.test.ts
    expected_evidence:
    - Four map round trip preserves insertion order and deep ownership
    - Real named resolution unchanged after map restoration with same model
    - Malformed versions and duplicate keys rejected
    rollback:
    - Revert only snapshot helper and focused test additions
    stop_conditions:
    - Snapshot requires model or unresolved callsite completeness
    known_blockers: []
    closeout:
      role_results:
        coder-manager: null
      main_session_evidence:
        authorized_by: user
        authorization_ref: User proceed for staged resolution prerequisite
        validation_summary: 71 tests in two files passed, TypeScript and git diff --check exit 0; map round trip, independent ownership, ordering, malformed input and semantic parity verified. No complete seed or runtime activation claim.
    dod_status: pass
```

## Required Traceability

| Requirement ID | Requirement | Disposition | Task IDs | Validation |
| --- | --- | --- | --- | --- |
| STATE-001 | Preserve resolver import inputs | implementation | MAP-1 | JSON round trip and semantic test |

## Decisions and limitations

Compared twice: node-only persistence loses unresolved callers; whole live context serialization loses closures and unretained callsites; isolated plain-map snapshots preserve known inputs without claiming completeness. Selected the third as the first prerequisite. No filesystem reader or publication is added before the complete supported seed exists.

Source discovery identified missing symbol registration enumeration, scope/heritage replay inputs, and unresolved callsite retention across sequential and worker pipelines. Complete seed publication must bind those plus export/model data to source, parser, configuration and generation identities. Existing generation publication remains the only storage owner.

Next production packets: retain lossless model registrations and callsite inputs, prove supported seed completeness, persist under the existing staged generation, then implement source-owned relationship replacement and derived-data parity before request activation. These remain unimplemented; MAP-1 completion cannot close workspace recovery.

## Evidence

Four read-only reviewers and two gpt-6.1-sol medium development agents; source and tests have disjoint write sets. OntoIndex freshness Transport closed and child impact workspace_too_large; source inspection is authority. Budget: two focused test invocations and one typecheck, no builds/live launches/reindex.


Validation consumed one confirmed focused invocation of two permitted, one typecheck; no build or live launch. Source and test hashes recorded in conversation receipts. Knowledge handoff: none; existing navigation and anti-loop rules cover transport failure and uncertain writes.
