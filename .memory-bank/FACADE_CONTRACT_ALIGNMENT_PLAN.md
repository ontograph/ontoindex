# Facade contract alignment

Date: 2026-10-22
Status: In progress
Authority: User authorized issue repairs and continuation; current facade contract review

## Goal

Expanded facade actions agree across dispatch, advertised schemas, registry metadata and the stable snapshot.

## Manager Tracking

```yaml
manager_loop:
  authority: true
  status: closed
  selection_policy: active_next_task-first
  active_next_task: null
  max_in_flight: 1
  dispatch_mode: sub-agent
  dispatch_preflight:
    required_roles:
      coder-worker:
        agent_type_candidates:
        - coder-worker
        model_candidates:
        - gpt-6-luna
        - gpt-6.1-sol
        reasoning_effort: high
      coder-worker-test-challenger:
        agent_type_candidates:
        - coder-worker-test-challenger
        model: gpt-6.1-sol
        reasoning_effort: xhigh
  last_decision: dispatched
  reopen_gate: null
tasks:
  ALIGN-1:
    title: Expanded facade actions produce no registry drift and match the reviewed snapshot
    status: DONE
    classification: implementation-ready
    assurance_profile: lite
    complexity: simple
    type: code
    validation_tier: unit-fast
    impact_risk: low
    depends_on: []
    owner_files:
    - ontoindex/src/mcp/shared/tool-registry.ts
    - ontoindex/test/unit/super/tool-contract.test.ts
    - ontoindex/fixtures/mcp-tool-contract/stable-tools.snapshot.json
    allowed_write_set:
    - ontoindex/src/mcp/shared/tool-registry.ts
    - ontoindex/test/unit/super/tool-contract.test.ts
    - ontoindex/fixtures/mcp-tool-contract/stable-tools.snapshot.json
    non_goals:
    - Dispatch behavior changes or unrelated facade implementation
    - Editing existing schema or export trackers or resetting their budgets
    - Builds installs releases reindexing or workspace graph activation
    required_validation:
    - UPDATE_SNAPSHOTS=1 ONTOINDEX_TEST_WORKERS=1 ./node_modules/.bin/vitest run test/unit/tool-contract-schema.test.ts
    - ONTOINDEX_TEST_WORKERS=1 ./node_modules/.bin/vitest run test/unit/tool-contract-schema.test.ts test/unit/super/tool-contract.test.ts test/unit/facade-operation-mapping.test.ts test/unit/facade-completeness.test.ts test/unit/facade-arg-enforcement.test.ts
    - ./node_modules/.bin/tsc --noEmit --incremental false
    - git diff --check
    expected_evidence:
    - 'Scenario: Given the expanded discover inspect audit and manage facade schemas and existing dispatch routes; when their registry actions match those routes and the stable snapshot is regenerated; then gnToolContract with includeFacades true reports no facadeActionDrift and regression assertions cover the added actions.'
    - Worker assesses manager-authorized inherited action metadata and snapshot against actual handlers; parent completed generation and worker must not regenerate
    - Challenger reviews exact semantic fixture diff and runs one independent combined focused suite and one typecheck serially from ontoindex subdirectory
    - Preserve concurrent edits and record consumed source input hashes before and after validation
    - Parsed snapshot comparison preserves every other entry and field; explicit assertions name added actions and structured-output metadata
    rollback:
    - Revert only this task's metadata regression and snapshot changes
    stop_conditions:
    - Concurrent consumed input mutation or semantic snapshot changes outside discover inspect audit manage and the search limit description and gn_verify_diff expectedSymbols description
    - Scope expansion beyond the reviewed semantic whitelist or unresolved handler metadata
    - One generation invocation one independent focused suite or one typecheck exhausted
    known_blockers: []
    dispatch:
      role: coder-worker-test-challenger
      attempts: 0
      max_attempts: 4
      dispatch_id: f4cc1b38-69bf-44bd-86e4-d96b7bf55967
      scope_sha256: ceba175f4c02f29bb19a5fee610569a960211965ba71ab7253a63a0df36d278c
      lease_state: result-accepted
      preflight_result: pass
      dispatched_at: '1792680863025'
      assigned_agent: 01a1641b-24df-7c93-9f56-d59cdf0ab1b8
      agent_type_requested: cdr-worker-test-challenger
      model_requested: gpt-6.1-sol
      model_effective: gpt-6.1-sol
      route_attempts: 1
      wait_state: null
      blocker_fingerprint: null
      terminal_classification: null
      last_progress_revision: ae3fd46aaf9304bd557ad135777270f0255981b0d127cbf89cec4e2af04fde06
      result_receipt_id: null
      result_verdict: null
      result_blocker: null
    closeout:
      role_results:
      - role: cdr-worker
        agent_id: 01a1640b-e557-7421-b9ca-6b2ba880bfec
        effective_model: gpt-6-luna
        receipt_id: role-result-981d3f9222dc55e3119d30bea3defaaebe586723b455ba1933ff02e17474b987
        verdict: PASS
      - role: cdr-worker-test-challenger
        agent_id: 01a1641b-24df-7c93-9f56-d59cdf0ab1b8
        effective_model: gpt-6.1-sol
        receipt_id: role-result-a80168c8dfee7d8f0d81be9068a5b177a2e2d795a676726f56e7eba19f1df159
        verdict: PASS
    dod_status: pass
```

## Required Traceability

| Requirement ID | User requirement | Disposition | Task IDs | Validation |
| --- | --- | --- | --- | --- |
| ALIGN | Repair actual facade contract drift before accepting snapshot | implementation | ALIGN-1 | Runtime contract regression and stable snapshot |

## Decisions And Non-Goals

Two reviews compared reverting facade additions, regenerating only the snapshot,
and aligning registry metadata before regeneration. Reverting removes intended
capabilities. Snapshot-only retains a runtime drift report. Selected metadata
alignment preserves behavior, compatibility and resource use with no new owner.
Existing registry and serializer remain authoritative. Match actual handlers;
do not mark unsupported actions stable by inference.

This separately scoped correction is an operational prerequisite for SCHEMA-1.
Its accepted failure receipt and spent validation allowance remain unchanged.
Budget: worker one generation invocation; challenger one combined focused suite
and one typecheck. No builds. OntoIndex parent transport is closed and child
freshness reports an older commit; source inspection is authority.

## Consolidated continuation decision

Fresh review authorized 2026-10-22 used four read-only reviewers: two Sol medium
and two Luna. Their findings do not replace worker/challenger acceptance.
Good: 25 added facade actions agree across schema, registry, dispatch and
snapshot. Weak: repeated dispatch recovery and broad textual snapshot review
delayed acceptance. Forgotten: explicit action assertions, duplicate catch
tracking and deployed artifact proof remain open.

Two-pass comparison selects exact semantic acceptance over reverting accurate
descriptions or accepting an unrestricted snapshot. Whitelist four facade
records plus search.inputSchema.properties.limit.description and
gn_verify_diff.inputSchema.properties.expectedSymbols.description. Other parsed
JSON must equal baseline. Formatting alone is not a semantic change. Accepted
BLOCKED receipts remain intact; this amendment governs future acceptance only.

Consolidated order, using existing task authorities:

1. Restore supported resume-to-dispatch behavior. Next accepts a dependency
   token while dispatch rejects both the missing approval and a supplied token.
   Require an accepted atomic dispatch with its bound lease. Reject unchanged
   retries, manual spawn, copied PASS and duplicate tasks as substitutes.
2. Resume ALIGN-1 adoption on stable inputs; add explicit action/metadata
   assertions within its existing test scope. Generation remains spent 1/1;
   independent combined suite and typecheck remain 0/1 each. Earlier validation
   does not cover subsequently changed source.
3. Close SCHEMA-1 and DECL-EXPORT through original gates and budgets; review
   any validation reuse explicitly. Reconcile duplicate CATCH-IMPL through
   supported manager tools and independently accept CATCH-COVERAGE.
4. Freeze remaining capture syntax packets; prove provider sequential/worker/
   fallback parity and bounded environments, then CALLS, generation-bound SEED,
   graph replacement/dependency parity and large dirty-workspace acceptance.
5. Prove cold backend, controlled dirty isolation, resource continuation scope
   and lifecycle ordering/refusal/rollback in disposable fixtures.
6. Freeze release inputs, validate native Linux build and installed package,
   bind package digest to source and connected MCP identity, then push the
   feature branch. Current rc.12 metadata is not proof of a new release.

Supported runtime owner repair is preferred over repeating refused dispatch
or bypassing leases. Validated native packaging is preferred over installing
the mutable checkout or container CI. These choices minimize duplicate work
and retain compatibility, rollback and provenance. No measured speed claim.

OntoIndex stale/degraded: parent transport closed; child reports indexed
1d6f107 versus HEAD 2623820. Source inspection is authority. No reindex ran.
Runtime dispatch incompatibility remains an external capability blocker;
the plan amendment does not repair that runtime or authorize bypassing it.

## Closeout

Open.

2026-10-22 prospective amendment: user replied "proceed" to the requested
dispatch-limit increase. Permit one additional ALIGN-1 worker attempt by raising
the limit from three to four. Preserve all three consumed attempts, accepted
receipts and validation budgets. The reviewed semantic snapshot whitelist is
the corrected precondition; no snapshot regeneration is authorized. Normal
token-bearing dispatch is supported; the remaining refusal was the attempt cap.

## Reconciliation evidence

2026-10-22: User authorized items 1-6. The accepted BLOCKED receipt remains
preserved. Read-only review found all eight facade action sets consistent across
schema, registry and snapshot, with dispatch covering the added actions.
Two observations found registry e9e57476178ffbd1bbede3c16b33a70fe3e1fbb566521543d434cde5bf8d1125
and snapshot 4cec3c65db01744d040aad44fec718d0491b5193a728c7d078b8525c483a54d5
stable. Definitions hash is 223716e99194c96b3e242d6eaaea6081e45734b548a02da3e496a61738d17894;
dispatch hash is 27ff4559488230810da82329eb142efbe4f7d55d8487f8dd3382d4eb00013af2.
The coordinator authorizes inherited-work adoption inside the existing write
set. Current installed worker policy permits that route. Prior producer
validation is unknown. Parent generation subsequently completed as recorded below.
Stop on renewed mutation. Independent validation remains required.

Parent execution evidence: UPDATE_SNAPSHOTS=1 ONTOINDEX_TEST_WORKERS=1
./node_modules/.bin/vitest run test/unit/tool-contract-schema.test.ts ran from
ontoindex, session 35769, terminal call call_0PJnQo4NLaMZCj3vJ5npUBK9:
exit 0, seven tests passed, 1.57 seconds. The five consumed file hashes were
unchanged before and after execution; scoped git diff --check exited 0.
Continuation confirmed those hashes against current files, including test hash
b5f8c4032b08d2b6b99614577f8120af5f2eacc932274ae45f83a52943aba1e1.
Generation allowance is consumed 1/1; independent combined suite remains 0/1
and typecheck remains 0/1. Worker adoption assesses these existing artifacts;
parent execution must not be represented as child execution. Both accepted
BLOCKED receipts remain preserved. Independent challenger acceptance is required.
