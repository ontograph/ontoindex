# MCP session and test suggestion contracts

Date: 2026-10-22
Status: Closed
Authority: User review, challenge, consolidate and proceed instruction.

## Goal

Advertise the existing session-key listing contract and stop inventing C++ test paths for unknown targets.

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
  CONTRACT-1:
    title: Session facade exposes required fields and unsupported test paths remain explicitly advisory
    status: DONE
    classification: implementation-ready
    assurance_profile: full
    complexity: standard
    depends_on: []
    type: code
    validation_tier: unit-fast
    impact_risk: medium
    owner_files:
    - ontoindex/src/mcp/facade/tool-definitions.ts
    - ontoindex/src/mcp/super/systems-public.ts
    - ontoindex/test/unit/facade-operation-mapping.test.ts
    - ontoindex/test/integration/systems-audit-mcp.test.ts
    allowed_write_set:
    - ontoindex/src/mcp/facade/tool-definitions.ts
    - ontoindex/src/mcp/super/systems-public.ts
    - ontoindex/test/unit/facade-operation-mapping.test.ts
    - ontoindex/test/integration/systems-audit-mcp.test.ts
    non_goals:
    - Global session enumeration or new graph discovery
    - Workspace replay activation and deployment
    required_validation:
    - cd ontoindex && ONTOINDEX_TEST_WORKERS=1 ./node_modules/.bin/vitest run test/unit/facade-operation-mapping.test.ts test/integration/session-tool.test.ts test/integration/systems-audit-mcp.test.ts
    - cd ontoindex && ./node_modules/.bin/tsc --noEmit
    - git diff --check
    expected_evidence:
    - List remains session-scoped and route_map does not require session fields
    - Bare Rust symbol produces no invented filename and explicitly advisory output
    - Supplied test evidence and explicit test paths retain precedence
    - Legacy and envelope responses retain uncertainty
    rollback:
    - Revert only this task's hunks in declared files
    stop_conditions:
    - Required new public input or filesystem discovery
    - Conflicting edits in assigned files
    known_blockers: []
    closeout:
      role_results:
        coder-worker: null
        coder-worker-test-challenger: null
      main_session_evidence:
        authorized_by: user
        authorization_ref: User requested review comparison and implementation with two Sol medium development agents
        validation_summary: Parent reviewed patches from two Sol medium developers after three read-only reviewers. First focused suite exited 1 with 40 passing tests and one fixture supplying explicit undefined path. Parent corrected fixture to omit the property. Final suite session 80066 exited 0 with 41 tests across three files. TypeScript session 1119 exited 0. git diff --check exited 0. Source and test SHA256 recorded in conversation receipt 603c3a. Budget used two of two suite runs and one of two typechecks. No builds installs reindex or release. OntoIndex Transport closed so source inspection is authority. No ontocode-rs directory exists for Rust formatting. Main-session acceptance only; no authenticated coder-role PASS claimed.
    dod_status: pass
```

## Required Traceability

| Requirement ID | User requirement | Disposition | Task IDs | Validation |
| --- | --- | --- | --- | --- |
| SESSION | Resolve list discoverability mismatch | implementation | CONTRACT-1 | Facade and session tests |
| SUGGEST | Avoid language-mismatched authoritative guesses | implementation | CONTRACT-1 | Systems audit tests |
| NAV | Large workspace navigation | architecture-gate | CONTRACT-1 | Existing automatic workspace ADR sequence |

## Decisions And Second Challenge

Session alternatives: expose existing session_id/key/value/repo fields; add global
enumeration; remove list. Select existing contract exposure: no storage scans,
new authorization surface or compatibility break. Keep required action only at
the facade root so route_map remains valid. Backend validation stays authoritative.

Suggestion alternatives: explicit language parameter and extension map; graph
and repository convention discovery; abstain from unsupported path inference.
Select abstention with advisory case/assertion text, null file, required false,
and an actionable warning when no path is supplied. Existing evidence paths keep
precedence, and supplied paths keep their spelling. All suggestions are advisory;
caller evidence is not independently verified. No new inputs or dependencies.
Second challenge: punctuation and bare names cannot prove language; path denotes
a test path, never source. Empty paths must not suppress the missing-path warning.
Preserve envelope uncertainty and avoid manufacturing a successful coverage gate.

Workspace alternatives: bounded incremental replay; reuse a verified ready
workspace snapshot; explicit committed operation. Committed mode is useful now;
ready snapshot reuse requires exact source identity. Incremental replay remains
the selected full solution under the existing ADR: provider scopes, complete
CALLS replay, generation-bound seeds, source-owned invalidation, then atomic
request activation. Resource limits remain enforced throughout.

## Execution Evidence

OntoIndex stale/degraded: Transport closed; source inspection is authority.
Source HEAD is 1d6f107 and package version is rc.11; rc.10 report is historical.
Three read-only Sol reviews precede two Sol medium development packets with
disjoint files. Parent owns validation and acceptance. Budget: two focused suite
runs and two TypeScript checks; children run no tests or builds. No release work.

## Closeout

Implemented the existing session contract exposure and advisory test suggestions.
All 41 focused tests and TypeScript passed after correcting one test fixture.
Workspace navigation, cold backend proof, resource continuation scope, lifecycle
coverage and deployed artifact identity remain open. Knowledge handoff: none;
existing rules already distinguish omitted inputs and terminal test receipts.
