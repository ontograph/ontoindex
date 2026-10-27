# Capture review and execution

Date: 2026-10-22
Status: In progress
Authority: User request to review, consolidate robust proposals and proceed; ADR_AUTOMATIC_DIRTY_WORKSPACE.md

## Goal

Close the confirmed catch coverage gap and route remaining capture work without
duplicating completed work or overwriting another parent's active export lease.

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
  CATCH-COVERAGE:
    title: Malformed real parser catch nodes directly exercise capture refusal
    status: DONE
    classification: implementation-ready
    assurance_profile: lite
    complexity: simple
    type: code
    depends_on: []
    validation_tier: unit-fast
    impact_risk: low
    owner_files:
    - ontoindex/test/unit/scope-resolution/typescript-declaration-captures.test.ts
    allowed_write_set:
    - ontoindex/test/unit/scope-resolution/typescript-declaration-captures.test.ts
    non_goals:
    - Production changes or changing accepted catch semantics
    - Export lease recovery or provider activation
    required_validation:
    - ONTOINDEX_TEST_WORKERS=1 ./node_modules/.bin/vitest run test/unit/scope-resolution/typescript-declaration-captures.test.ts test/unit/scope-resolution/scope-extractor.test.ts
    - git diff --check
    expected_evidence:
    - Direct real catch clause fixtures refuse without relying on program kind or collector guard
    - Empty malformed catch explicitly asserts parser error and missing catch clause shape
    - Existing valid catch fixtures and var collision refusal stay intact
    - Production source hash remains 958a61079ed338323f4b1b783df6cf94f17dc3e8fb92a1a789e37d0919bfbf8b
    rollback:
    - Revert only added malformed node assertions
    stop_conditions:
    - Production behavior change or scope expansion required
    - Two focused invocations or one correction round exhausted
    known_blockers: []
    dispatch:
      role: coder-worker-test-challenger
      attempts: 0
      dispatch_id: 50ff7191-4b1a-443d-adfb-7fc3ba774e51
      scope_sha256: 6016e0d405ec6d6dada8630729629abf6badc9e1edce1a7915ccd6e5ad29c94a
      lease_state: result-accepted
      preflight_result: pass
      dispatched_at: '1792679349848'
      assigned_agent: 01a16404-0e02-7060-b155-9f60ac9434d1
      agent_type_requested: cdr-worker-test-challenger
      model_requested: gpt-6.1-sol
      model_effective: gpt-6.1-sol
      route_attempts: 1
      wait_state: null
      blocker_fingerprint: null
      terminal_classification: null
      last_progress_revision: 4a5e71c270bba32ac52e7b20d9b7882975c29d65a8d32726fefe39b931ee1e01
      result_receipt_id: null
      result_verdict: null
      result_blocker: null
    closeout:
      role_results:
      - role: cdr-worker
        agent_id: 01a16402-6a02-7e03-a8a5-e3c14c8f60f8
        effective_model: gpt-6-luna
        receipt_id: role-result-baee1e3e9b23aa7130249a5a3ed70838aafb55b561d75f74cdfe029855769c08
        verdict: PASS
      - role: cdr-worker-test-challenger
        agent_id: 01a16404-0e02-7060-b155-9f60ac9434d1
        effective_model: gpt-6.1-sol
        receipt_id: role-result-c783cac2486c0e2e94c561b073a5ba66f887aa53d13a0982182d07de8aae3f6e
        verdict: PASS
    dod_status: pass
```

## Review findings

- Good: native identifier ranges, detached captures, separate catch/body scopes,
  four grammars and canonical identity tests; previous 182 tests and TypeScript
  passed on the recorded hashes. Existing var refusal is preserved.
- Weak: malformed-root collector guards can hide missing direct helper coverage
  at typescript-declaration-captures.test.ts:826. This is a coverage gap, not a
  confirmed product defect.
- Forgotten: the workspace tracker still selects its OPEN CATCH-IMPL duplicate,
  despite authenticated completion in LUNA_CATCH_IMPLEMENTATION_PLAN.md. Its
  status must be reconciled through manager tools, not by rerunning implementation.
- Operational: named-export lease 9dd5ec64-f483-45d3-b431-fe858311db5d has a terminal
  result awaiting its original parent. This thread's observe returned
  manager_loop_observe_binding_mismatch at revision
  c9db85f941880f0e92c34c736d139eb099f0b458051fe4778b2d2039e89989e9.
  Preserve that lease; no overlapping export dispatch.

## Alternatives and second challenge

| Issue | Three alternatives | Second review and selected solution |
| --- | --- | --- |
| Catch coverage | Direct parser nodes; borrowed node doubles; remove collector guard | Select direct nodes and explicit no-node assertions. Native grammar proof, no runtime allocation or compatibility change; doubles add maintenance, guard removal conflates root and node contracts. |
| Named exports | Extend current emitter; synthetic clause lowering; shared extractor change | Select current emitter with declaration branch before clause scan. Native ranges and canonical IDs preserved; no reparsing or shared protocol. Type modifiers belong to wrapper checks; valid body type syntax must pass. |
| Tracker disagreement | Authenticated reconciliation; rerun completed code; hand-copy role PASS | Select manager-owned reconciliation using existing completion evidence. Reexecution wastes exhausted budget; copied PASS bypasses receipts. Stop if runtime lacks a supported reconciliation. |
| Catch allocation cost | Keep validated emitters; direct name scans; shared per-file binding index | Keep current bounded direct-child scan. No measured regression justifies semantic duplication or a new cache. Revisit only with a dedicated measured case and equivalence tests. |

Reviewed correctness, robustness, compatibility, security, performance,
testability, complexity and rollback twice. Test-only repair has no product
runtime cost. No measured speed claim is made. All changes remain reversible
within the existing owners.

## Execution and budget

New CATCH-COVERAGE task: at most two focused suite invocations and one correction;
no new typecheck because production is unchanged. This does not reset or amend
the exhausted original CATCH-IMPL budget (2/2 suites, 1/1 typecheck, 1/1 correction).
Worker edits/checks whitespace; challenger owns the suites. Suite cwd is
`/opt/d1/_wrk/ontoindex/ontoindex`; whitespace cwd is repository root. Record
commands individually with cwd, exit, truncation and input hashes. No builds,
installs, reindex or full suite. At least two development agents use
gpt-6.1-sol medium: a file-bounded repair helper and a separate development
verifier. Registered worker/challenger gates retain their fixed high/xhigh policy.

## Ordered handoff

1. CATCH-COVERAGE: repair and independently validate direct malformed-node coverage.
2. Reconcile workspace tracker to existing catch receipt evidence through supported
   manager tools; do not reopen DONE tasks or manufacture role results.
3. Named exports: original parent harvests the existing terminal result. Accepted
   implementation stays in typescript-export-captures.ts and its test file.
   Ordinary named function/class, native name fields, four grammars, duplicate
   exports and detached ranges; reject defaults, generators, abstract declarations,
   variables and reexports. Preserve type syntax in bodies. Existing export budget
   remains at most two suites/one typecheck/one correction across its roles.
4. Freeze remaining binding/import/export/reference syntax packets, then provider
   sequential/worker/fallback parity and bounded environment validation.
5. CALLS after SCOPE/provider; SEED after complete MODEL/SCOPE/CALLS; then graph
   replacement/dependency parity and large dirty-workspace acceptance. Deployment
   identity, cold backend and lifecycle acceptance remain independent open gates.

Stages 2-5 are gates and handoffs, not permission to overwrite active leases,
activate providers, create unreviewed broad write sets or exceed budgets.

## Required Traceability

| Requirement ID | Requirement | Disposition | Task IDs | Validation |
| --- | --- | --- | --- | --- |
| COVERAGE | Real malformed catch nodes directly refuse | implementation | CATCH-COVERAGE | Focused real-parser suites |
| PERF | Reuse existing owners and avoid speculative caches | architecture-gate | CATCH-COVERAGE | Two-pass alternatives review |
| REVIEW | Independent challenge and explicit evidence | proof-only | CATCH-COVERAGE | Worker/challenger receipts and medium verifier |
| ROADMAP | Preserve capture/provider/CALLS/SEED/runtime order | non-goal | CATCH-COVERAGE | Ordered handoff above |

## Decisions And Non-Goals

OntoIndex stale/degraded: indexed 1d6f107 differs from HEAD 2623820; new capture
symbols are absent in committed navigation. Source inspection is authority.
No reindex under capture budgets. Unrelated dirty work remains untouched.

## Closeout

Resume evidence, 2026-10-22: installed cdr-worker policy SHA-256
`93c01e0eb1eb6c2ebbfdfb8526aa0cec897b0e8d98385699a8398c6ad44fcff5`
now explicitly authorizes manager-assigned assessment of inherited implementation
within an exact write set, with provenance and current validation. The inherited
test artifact remains `6cd0a4803f01c82fc4c11b02a212f90607bd871abff0994c6a8398fadade5550`;
production source remains unchanged. Manager authorizes adoption of this exact
test repair from the prior medium helper, without new edits unless a demonstrated
defect requires them. Existing scope, two-suite budget and challenger gate apply.
Worker preflight model candidates now match installed policy; plan validation passes.

Review completed; CATCH-COVERAGE remains unfinished. Two development agents ran
on gpt-6.1-sol medium: the test editor and independent static verifier. The
editor added direct real catch-clause refusal assertions and a separate
empty-catch parser-shape test. The verifier found no blocking assertion issue.
Production helper hash remains unchanged. Final test SHA-256:
`6cd0a4803f01c82fc4c11b02a212f90607bd871abff0994c6a8398fadade5550`.

Bounded OntoIndex file-scope verification passed; `git diff --check` exited 0.
New suite budget consumed: 0/2; correction rounds: 0/1. No new typecheck,
build, install or reindex ran. Earlier passing test evidence belongs to the
earlier recorded inputs and does not validate these changed assertions.

The authenticated worker receipt
`role-result-6d4f70a65d3a68ade34075f9411c505d03caeafbc76d91fe79f66a775fe3ac29`
recorded BLOCKED: inherited implementation requires adoption authority unavailable
for CATCH-COVERAGE. Manager decision is no_dispatch and requires fresh evidence
before redispatch. Reconciliation preserved that decision. Installed
`/opt/d2/.ontocode/agents/cdr-worker.toml` admits inherited-work adoption only
for its named SC-1 and ASO exceptions; this task is not among them. The referenced
ontocode-subagent-recovery skill was absent at both installed skill roots.
Reopen only after a supported worker adoption path is demonstrably available
for this exact test artifact, then use the supported fresh-evidence resume.
Do not manufacture edits or bypass the worker/challenger gates.

The named-export original-parent lease remains intact. Workspace duplicate
catch tracking is recorded as pending reconciliation, not hand-edited DONE.
Knowledge handoff: preserve named-lease ownership and verify adoption admission
before assigning a helper to complete all edits; proposed workflow clarification
belongs to ontocode-luna-workflow, not a role-policy change in this task.
