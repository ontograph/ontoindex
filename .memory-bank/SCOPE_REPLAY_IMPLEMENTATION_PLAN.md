# Scope replay implementation

Date: 2026-10-22
Status: In progress
Authority: User request to challenge and execute consolidated plan; ADR_AUTOMATIC_DIRTY_WORKSPACE.md frozen SCOPE packet.

## Goal

Preserve complete scope extraction inputs across parse paths, then prove bounded
retention and identity before enabling replay. Large-workspace navigation remains
unresolved until complete seed and parity gates pass.

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
  SCOPE-1:
    title: Sequential parsing extracts scope artifacts and exposes them without changing its null sentinel
    status: DONE
    classification: implementation-ready
    assurance_profile: full
    complexity: standard
    depends_on: []
    type: code
    validation_tier: unit-fast
    impact_risk: medium
    owner_files:
    - ontoindex/src/core/ingestion/parsing-processor.ts
    - ontoindex/test/unit/scope-resolution/parse-worker-scope-integration.test.ts
    allowed_write_set:
    - ontoindex/src/core/ingestion/parsing-processor.ts
    - ontoindex/test/unit/scope-resolution/parse-worker-scope-integration.test.ts
    non_goals:
    - No durable retention or complete replay claim or activation
    required_validation:
    - cd ontoindex && ONTOINDEX_TEST_WORKERS=1 ./node_modules/.bin/vitest run test/unit/scope-resolution/parse-worker-scope-integration.test.ts test/unit/parse-impl-fallback.test.ts
    - cd ontoindex && ./node_modules/.bin/tsc --noEmit
    - git diff --check
    expected_evidence:
    - Sequential and worker-recovery fallback expose provider scope artifacts from prepared source in order
    - Missing or failing scope provider preserves legacy parsing and null result
    - Existing call signatures remain compatible
    rollback:
    - Revert only SCOPE-1 hunks
    stop_conditions:
    - Scope expansion or new public runtime configuration
    known_blockers: []
    closeout:
      role_results:
        coder-worker: null
        coder-worker-test-challenger: null
      main_session_evidence:
        authorized_by: user
        authorization_ref: User requested reviewed plan execution with two Sol medium development agents
        validation_summary: Parent reviewed production and test diffs. Sequential and crash-fallback scope artifacts preserve order and prepared Vue bytes; absent or throwing hooks preserve legacy definitions; callback exceptions propagate. Focused Vitest passed 28 tests in two files exit 0 in 4.72 seconds. TypeScript noEmit exit 0. Whitespace check exit 0. Transient callback does not imply complete or durable capture.
    dod_status: pass
  SCOPE-2:
    title: Freeze bounded immutable scope capture and identity packet against all disposal paths
    status: DONE
    classification: architecture-paperwork
    assurance_profile: full
    complexity: standard
    depends_on:
    - SCOPE-1
    type: design-gate
    validation_tier: unit-fast
    impact_risk: medium
    owner_files:
    - .memory-bank/ADR_AUTOMATIC_DIRTY_WORKSPACE.md
    allowed_write_set:
    - .memory-bank/ADR_AUTOMATIC_DIRTY_WORKSPACE.md
    non_goals:
    - No runtime activation or incomplete seed publication
    required_validation:
    - Independent source and test review of capture and identity packet
    - git diff --check
    expected_evidence:
    - Exact ownership for capture before chunk disposal and present versus missing config identity
    - Worker sequential recovery and incomplete extraction paths have explicit acceptance and refusal fixtures
    rollback:
    - Revert only new packet clarifications
    stop_conditions:
    - Identity owner unresolved
    known_blockers: []
    closeout:
      role_results:
        coder-manager: null
      main_session_evidence:
        authorized_by: user
        authorization_ref: User requested independent challenge and consolidated execution plan
        validation_summary: Independent Luna source review accepted final SCOPE refinement with no blocking gap for design scope. It names configuration observations, ordered complete capture before disposal, asynchronous handle lifetime, existing replay owners and identity refusal. Missing and failed hooks remain indistinguishable in the transient list and require explicit outcomes in the successor. Parent read back exact paragraph; whitespace and plan validator passed. This closes packet clarification only, not retention implementation.
    dod_status: pass
```

## Required Traceability

| Requirement ID | Requirement | Disposition | Task IDs | Validation |
| --- | --- | --- | --- | --- |
| SCOPE-PATHS | Sequential extraction parity | implementation | SCOPE-1 | Provider success failure and fallback cases |
| SCOPE-RETENTION | Complete bounded ordered retention and identity | architecture-gate | SCOPE-2 | Exact capture/disposal and configuration owner review |

## Decisions and challenge

Live ParsedFile retention preserves Maps cheaply but permits mutation and unbounded
memory. Reparse-on-replay avoids a codec but repeats parsing and cannot reproduce
unknown hooks without identity proof. Select immutable registration/input capture
using existing owners and fixed bounds. Preserve native structured-clone worker
transport; introduce durable encoding only at retention, with ordered Map entries.

Second challenge found sequential parsing never extracts ParsedFile, worker data
is cleared before durable retention, and finalizeScopeModel has no production
caller. Fix extraction first, preserving the null sentinel used for sequential
fallback. An optional trailing callback transfers artifacts to the upcoming
capture owner; it does not claim retention or completeness. Existing bridge
failure suppression must never be interpreted as complete scope evidence.

Done well: explicit committed provenance, fixed registration bounds and boundary
tests. Weakest result: completed prerequisites were mistaken for enough progress
while default workspace navigation remained blocked. Forgotten: sequential scope
extraction, config absent-versus-error identity and successor task routing.

## Execution evidence

OntoIndex freshness returned Transport closed; source inspection is authority.
Two read-only reviewers identified source and tests; two gpt-6.1-sol medium
development packets own disjoint production/test files. Parent validates serially.
Budget SCOPE-1: two focused suite runs and two typechecks; zero initially used.
No builds, installs, launches, reindex or publication in this slice.

## Remaining sequence

After SCOPE-2, implement bounded capture with exact/one-over limits and complete
ParsedFile nested facts, then bind inventory/config/provider/parser/hook identity.
CALLS retains unresolved calls before mutation; SEED publishes atomically through
the existing generation owner. Independent full-analysis parity, cancellation,
pruning and resource proof precede runtime activation. Preserve all ADR scope.

## Closeout

SCOPE-1 validation consumed one of two focused suite runs and one of two
typechecks. Both exited 0; whitespace check exited 0. No build or install.
Knowledge handoff: none; existing transport and validation rules cover findings.
