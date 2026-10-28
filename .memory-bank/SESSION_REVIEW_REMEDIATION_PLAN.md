# Session review remediation

Date: 2026-10-21
Status: Closed (advice, safety and replay design)
Authority: User requested challenged consolidated plan and execution.

## Goal

Correct recovery advice and safety evidence, then implement bounded current-worktree relationships through complete resolution replay.

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
  ADVICE-1:
    title: Optional embeddings and dirty sources receive accurate recovery advice
    status: DONE
    classification: implementation-ready
    assurance_profile: full
    complexity: standard
    depends_on: []
    type: code
    validation_tier: unit-fast
    impact_risk: low
    owner_files:
    - ontoindex/src/mcp/super/ensure-fresh.ts
    - ontoindex/src/core/runtime/runtime-health.ts
    - ontoindex/src/mcp/super/diagnose.ts
    - ontoindex/src/mcp/super/help.ts
    - ontoindex/src/cli/status.ts
    - ontoindex/test/unit/super/ensure-fresh.test.ts
    - ontoindex/test/unit/ensure-fresh-embedding-prereqs.test.ts
    - ontoindex/test/unit/runtime-health.test.ts
    - ontoindex/test/unit/super/diagnose.test.ts
    - ontoindex/test/unit/super/help.test.ts
    - ontoindex/test/unit/status.test.ts
    allowed_write_set:
    - ontoindex/src/mcp/super/ensure-fresh.ts
    - ontoindex/src/core/runtime/runtime-health.ts
    - ontoindex/src/mcp/super/diagnose.ts
    - ontoindex/src/mcp/super/help.ts
    - ontoindex/src/cli/status.ts
    - ontoindex/test/unit/super/ensure-fresh.test.ts
    - ontoindex/test/unit/ensure-fresh-embedding-prereqs.test.ts
    - ontoindex/test/unit/runtime-health.test.ts
    - ontoindex/test/unit/super/diagnose.test.ts
    - ontoindex/test/unit/super/help.test.ts
    - ontoindex/test/unit/status.test.ts
    non_goals:
    - No analysis behavior or schema changes
    required_validation:
    - Focused Vitest suites and TypeScript and scoped whitespace
    expected_evidence:
    - Optional absence does not mandate repair; requested guards and unknown-source refusal preserved
    rollback:
    - Revert task-owned hunks
    stop_conditions:
    - Scope expansion
    known_blockers: []
    closeout:
      role_results:
        coder-manager: null
      main_session_evidence:
        authorized_by: user
        authorization_ref: Current challenged plan and execution request
        validation_summary: Seven files and 303 tests passed exit 0; TypeScript and scoped whitespace exit 0; twelve source hashes unchanged through validation. Agent safety_tests terminal receipts retained in conversation.
    dod_status: pass
  SAFE-1:
    title: Missing symbols retain CAUTION across legacy and envelope formats
    status: DONE
    classification: implementation-ready
    assurance_profile: full
    complexity: standard
    depends_on:
    - ADVICE-1
    type: test
    validation_tier: unit-fast
    impact_risk: low
    owner_files:
    - ontoindex/test/unit/super/safe-edit-check.test.ts
    allowed_write_set:
    - ontoindex/test/unit/super/safe-edit-check.test.ts
    non_goals:
    - No production safety changes
    required_validation:
    - Focused Vitest suite and TypeScript
    expected_evidence:
    - Omitted and explicit legacy and envelope responses retain failed symbol precheck and CAUTION
    rollback:
    - Revert task-owned test hunks
    stop_conditions:
    - Production behavior changes required
    known_blockers: []
    closeout:
      role_results:
        coder-manager: null
      main_session_evidence:
        authorized_by: user
        authorization_ref: Current challenged plan and execution request
        validation_summary: Included in seven files and 303 passing tests exit 0; TypeScript and scoped whitespace exit 0; source hashes unchanged through validation.
    dod_status: pass
  STATE-1:
    title: Specify bounded complete model and call replay implementation packet
    status: DONE
    classification: docs/design-only
    assurance_profile: full
    complexity: standard
    depends_on:
    - SAFE-1
    type: design-gate
    validation_tier: unit-fast
    impact_risk: low
    owner_files:
    - .memory-bank/ADR_AUTOMATIC_DIRTY_WORKSPACE.md
    allowed_write_set:
    - .memory-bank/ADR_AUTOMATIC_DIRTY_WORKSPACE.md
    non_goals:
    - No runtime activation before complete parity
    required_validation:
    - Independent owner and completeness review
    expected_evidence:
    - Exact implementation packets for registrations scopes heritage exports and unresolved calls in sequential worker and fallback paths with bounded retention
    rollback:
    - Revert task-owned ADR additions
    stop_conditions:
    - Unbounded retention or missing source identity
    known_blockers: []
    closeout:
      role_results:
        coder-manager: null
      main_session_evidence:
        authorized_by: user
        authorization_ref: User proceed on challenged consolidated remediation
        validation_summary: Frozen MODEL SCOPE CALLS SEED packets persisted in ADR; independent final review 01a16045-ba55-70e1-aa15-eb24e59275e8 found no required correction and verified 28 source/test references. Scoped git diff --check exit 0. Numeric retention and complete-language gates retained. This closes design only; engine implementation and activation remain outstanding.
    dod_status: pass
```

## Required Traceability

| Requirement ID | Requirement | Disposition | Task IDs | Validation |
| --- | --- | --- | --- | --- |
| R1 | Accurate optional and dirty advice | implementation | ADVICE-1 | Focused regressions |
| R2 | Missing evidence cannot imply safety | compatibility-test | SAFE-1 | Three response formats |
| R3 | Complete bounded workspace replay | architecture-gate | STATE-1 | Exact implementation packet |

## Decisions and second challenge

Advice alternatives: existing-owner gating; reclassifying missing state or rejecting dirty analysis; automatic repair. Select gating for accurate compatibility and zero additional analysis work. Second review preserves required embedding prerequisites, actual drift, unknown-status refusal and pinned audit cleanliness.

Safety alternatives: parameterize existing tests; add SDK fixtures; refactor correct production behavior. Select parameterization. Second review checks response shape before normalization and exact CAUTION with unavailable evidence.

Workspace alternatives: complete incremental seed; valid complete snapshot reuse; committed-only fallback. Select incremental seed for changed workspaces, retain existing reuse and explicit fallback. Second review rejects cap increases, unbounded call arrays, partial seeds and loss of clean incoming edges.

Done well: explicit fallback provenance, cold SDK regressions, typed refusal, import-map preservation. Weakest result: diagnostics improved while default large-workspace navigation stayed unavailable. Forgotten work: complete replay inputs, consistency of advice, response-envelope assertions, durable artifact identity and broader lifecycle coverage.

## Remaining sequence

STATE-1 must produce implementation-ready packets, not close the engine objective. Implement lossless model registrations and bounded unresolved call/scope/heritage/export retention in both parse paths. Then prove complete source/parser/config/generation-bound seed persistence through the existing publication owner. Implement source-owned replacement and dependency closure preserving clean incoming callers. Prove independent full-analysis parity for relationships and process/community/ranking outputs, cancellation and atomic publication before request activation. Keep all engine implementation outstanding until those tests pass.

Separate pending coverage: lexical-fallback embedding advice; lifecycle ingest/verify/tombstone/apply/rollback and budget/session operations; installed versus connected artifact identity; bounded privacy-aware nested-call correlation through existing orchestration. Existing closed predecessor plans remain closed.

## Evidence

Baseline ae351d4, source version rc.10; connected identity unverified. OntoIndex freshness returned Transport closed; source inspection is authority. Four read-only reviewers and three gpt-6.1-sol medium development agents used disjoint write sets. Validation consumed one suite and one typecheck of two allowed each, no builds/live launches/reindex. Twelve product files changed, seven test suites passed 303 tests. Knowledge handoff none: existing no-retry and provenance rules apply.

## Closeout

ADVICE-1, SAFE-1 and STATE-1 completed through the manager tools. Replay packets
are specified and independently reviewed; workspace engine implementation remains
outstanding. No build, installation or publication was performed for design closure.
