# Independent IQ Evidence Work

Date: 2026-10-18
Status: In progress
Authority: User instruction to challenge the IQ review, choose robust fixes and execute.

## Goal

Accept bounded static-input tests and prepare the independent route inventory.
Canonical IQ acceptance and real ABA proof remain governed by the original plan.

## Decisions And Non-Goals

The four independent review packets compared three approaches twice. Repeating
the proof lacks its fixture. Changing canonical dependencies risks ambiguous
selection and alters accepted tracking. This companion accepts the static-input artifact through worker and challenger
gates; canonical IQ-5 remains the containment qualification authority. No production behavior or runtime overhead changes.

Mock-only coverage is insufficient for real descriptor identity. A native
containment redesign changes compatibility and ownership without an established
remaining defect. Extend the existing test owner with real disposable fixtures;
retain all synthetic identity tests. Any discovered production failure requires
a separately reviewed correction, never a weakened acceptance assertion.

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
      coder-manager:
        agent_type_candidates:
        - coder-manager
        - cdr-manager
        model_candidates:
        - gpt-6.1-sol
        reasoning_effort: high
      coder-worker:
        agent_type_candidates:
        - coder-worker
        - cdr-worker
        model_candidates:
        - gpt-6.1-sol
        reasoning_effort: high
      coder-worker-test-challenger:
        agent_type_candidates:
        - coder-worker-test-challenger
        - cdr-worker-test-challenger
        model_candidates:
        - gpt-6.1-sol
        reasoning_effort: xhigh
  last_decision: dispatched
  reopen_gate: null
tasks:
  IQ-5F2:
    title: Static FIFO and socket inputs reject before content reads and preserve accepted captures
    status: DONE
    classification: implementation-ready
    assurance_profile: full
    complexity: complex
    depends_on: []
    type: test
    validation_tier: unit-fast
    impact_risk: high
    owner_files:
    - ontoindex/src/core/analyze-delta.ts
    - ontoindex/test/unit/workspace-capture-toctou.test.ts
    - ontoindex/test/unit/workspace-input-capture.test.ts
    - ontoindex/test/unit/workspace-capture-nested-repo.test.ts
    allowed_write_set:
    - ontoindex/test/unit/workspace-capture-toctou.test.ts
    non_goals:
    - No production edits, dependencies, provider execution, release or default activation.
    - No canonical IQ or ADW lease, status, receipt or qualification changes.
    - No arbitrary filesystem access, sensitive contents, race reproduction or new production hooks.
    required_validation:
    - ONTOINDEX_AUTO_WORKSPACE=0 ONTOINDEX_TEST_WORKERS=1 node node_modules/vitest/vitest.mjs run --maxWorkers=1 --no-file-parallelism test/unit/workspace-capture-toctou.test.ts test/unit/workspace-input-capture.test.ts test/unit/workspace-capture-nested-repo.test.ts
    - git diff --check
    expected_evidence:
    - Run Node validation with runner workdir /opt/d1/_wrk/ontoindex/ontoindex; git diff uses repository root.
    - Four native FIFO/socket cases across source and configuration readers verify fixture type before invoking readers and receive unsupported classification.
    - Assert zero content reads; the source FIFO case must acquire one descriptor and close it exactly once, while configuration and socket cases reject before acquiring a descriptor. Native FIFO open retains O_NONBLOCK.
    - Rejected static inputs create no accepted copy, preserve borrowed capture bytes, close socket servers, restore regular files on all paths and pass subsequent regular controls.
    - Preserve existing synthetic identity tests and the explicit unresolved real ABA and repeated-replacement proof in canonical IQ-5. No race reproduction in this task.
    - Independent challenger and final frozen input hashes support static acceptance only; no production edits, new dependencies or performance qualification claims.
    rollback:
    - Reverse only this task's test diff while preserving earlier dirty tests and all failure evidence.
    stop_conditions:
    - Stop on production failure and return exact red evidence for a separately scoped correction; do not weaken assertions.
    - Stop on write-scope expansion, unresolved design or conflicting validation owner.
    - Use one executable validation lane; research roles do not build or test concurrently.
    known_blockers: []
    dispatch:
      role: coder-worker-test-challenger
      max_attempts: 4
      attempts: 0
      dispatch_id: 6040b426-20a7-43ea-9eac-10c2ef9f7f6b
      scope_sha256: ca94d8ce80ebdc11fdd08b7c27800e03d31311bfd9579e38053d884a3ae198e1
      lease_state: result-accepted
      preflight_result: pass
      dispatched_at: '1792346657251'
      assigned_agent: 01a1502f-91bc-7c32-82fd-b89f4203c8dc
      agent_type_requested: cdr-worker-test-challenger
      model_requested: gpt-6.1-sol
      model_effective: gpt-6.1-sol
      route_attempts: 1
      wait_state: null
      blocker_fingerprint: null
      terminal_classification: null
      last_progress_revision: de70c8261472a9ed5e22afee891d72db847cb0b3c30cf66134c7ace978eb4892
      result_receipt_id: null
      result_verdict: null
      result_blocker: null
    closeout:
      role_results:
      - role: cdr-worker
        agent_id: 01a1502c-00f5-7961-9b1b-a9890c91b61d
        effective_model: gpt-6.1-sol
        receipt_id: role-result-2fcb15ae301eabc3f6d0d93c42e8098ab2993b93140539b47d0667d24f9b9438
        verdict: PASS
      - role: cdr-worker-test-challenger
        agent_id: 01a1502f-91bc-7c32-82fd-b89f4203c8dc
        effective_model: gpt-6.1-sol
        receipt_id: role-result-500ad44861bf50c28b8ae3fcfbfc3b8caff3def5341030bcb2be648f92e221dc
        verdict: PASS
    dod_status: pass
  IQ-8I:
    title: Map report priority rows to route behavior owners tests and canonical ADW gates
    status: DONE
    classification: architecture-paperwork
    assurance_profile: full
    complexity: complex
    depends_on: []
    type: inventory
    validation_tier: unit-fast
    impact_risk: medium
    owner_files:
    - .memory-bank/ADW_IQ_ROUTE_INVENTORY.md
    - .memory-bank/ADW_INDEPENDENT_REVIEW_IMPLEMENTATION_PLAN.md
    - .memory-bank/AUTOMATIC_DIRTY_WORKSPACE_PROJECT_PLAN.md
    - ontoindex/src/mcp/local/local-backend.ts
    - ontoindex/src/mcp/local/local-backend-repo-runtime.ts
    - ontoindex/src/mcp/server.ts
    - ontoindex/src/mcp/shared/target-context.ts
    - ontoindex/src/mcp/shared/response-envelope.ts
    - /tmp/ontoindex-adw-independent-psdzw0np/ONTOINDEX_TEAM_REPORT.md
    allowed_write_set:
    - .memory-bank/ADW_IQ_ROUTE_INVENTORY.md
    non_goals:
    - No product code, canonical task acceptance, leases, default activation or release changes.
    - No build, runtime qualification, provider calls or inference that missing proof means missing implementation.
    required_validation:
    - git diff --check
    expected_evidence:
    - Write a bounded evidence report with every report priority row mapped to actual symbol/schema, test and original ADW task ID or explicit unmapped reason.
    - Include direct/facade/lazy/resource and lexical/vector/neighborhood/group routes with flag-off/on supported, unsupported or unproven classifications and source citations.
    - Cover repository/base/digest/generation/coverage metadata, typed failures/retry, response-shaping cache keys, group provenance, pagination and pin release/cancellation.
    - Separate implemented-unqualified, missing and unknown; no source-only runtime or performance PASS claims.
    - Run diff check from repository root and report artifact SHA-256. Canonical IQ-8 still requires its own adjudication.
    rollback:
    - Remove only the newly authored inventory artifact; preserve canonical tracking and unrelated dirty work.
    stop_conditions:
    - Stop on source evidence conflict or missing report; record unknowns rather than inventing mappings.
    - No tracking state mutation, new index refresh, production edits or executable qualification.
    known_blockers: []
    dispatch:
      role: coder-manager
      attempts: 0
      dispatch_id: 80f7539a-a597-4d85-aa2d-7ba4736533f8
      scope_sha256: 8804c0ee81569f2b431d476084edcd2e732f12046af8a92549437e4eaa261b0e
      lease_state: result-accepted
      preflight_result: pass
      dispatched_at: '1792347154014'
      assigned_agent: 01a15037-2635-7ad1-b52d-cc06c36d6cbb
      agent_type_requested: cdr-manager
      model_requested: gpt-6.1-sol
      model_effective: gpt-6.1-sol
      route_attempts: 1
      wait_state: null
      blocker_fingerprint: null
      terminal_classification: null
      last_progress_revision: 71350cf5071ad42e8b5ad2cb1520a458953496fb6cf7270601c64314e8880d42
      result_receipt_id: null
      result_verdict: null
      result_blocker: null
    closeout:
      role_results:
      - role: cdr-manager
        agent_id: 01a15037-2635-7ad1-b52d-cc06c36d6cbb
        effective_model: gpt-6.1-sol
        receipt_id: role-result-5c4b07c7f2979bf2cadd8a1a592ad0f03a148b68021d6f0333096f742ede84a3
        verdict: PASS
    dod_status: pass
  IQ-6S:
    title: Recovery sentinel refusal preserves evidence and acquired sentinels clean up on success or archive failure
    status: DONE
    classification: implementation-ready
    assurance_profile: full
    complexity: complex
    depends_on: []
    type: test
    validation_tier: unit-fast
    impact_risk: medium
    owner_files:
    - ontoindex/src/cli/analyze.ts
    - ontoindex/test/unit/analyze-lock.test.ts
    allowed_write_set:
    - ontoindex/test/unit/analyze-lock.test.ts
    non_goals:
    - No production edits, process death or race reproduction, canonical task acceptance, release or default activation.
    required_validation:
    - ONTOINDEX_AUTO_WORKSPACE=0 ONTOINDEX_TEST_WORKERS=1 node node_modules/vitest/vitest.mjs run --maxWorkers=1 --no-file-parallelism test/unit/analyze-lock.test.ts test/unit/analysis-coordinator.test.ts
    - git diff --check
    expected_evidence:
    - Run focused Node command in /opt/d1/_wrk/ontoindex/ontoindex and diff check at repository root.
    - Preexisting empty and malformed sentinels reject while preserving exact main lock sentinel and checkpoint bytes with no recovery archive.
    - Successful stale-lock recovery removes its sentinel preserves the replacement owner against a second acquisition and allows reacquisition after release.
    - Inject archive-write failure only at the owned temporary recovery path; require injection occurred stale main and checkpoint preserved sentinel absent and retry succeeds after mock restoration.
    - Restore mocks before temporary directory cleanup; preserve all earlier dirty tests and retain failure evidence without weakening assertions.
    - Static evidence only; canonical IQ-6F and IQ-6 owned-process death and successor matrix remain unresolved.
    rollback:
    - Reverse only new IQ-6S test hunks preserving prior dirty test changes.
    stop_conditions:
    - Stop on production failure or unresolved contract; return exact evidence for separately reviewed correction.
    - One executable validation lane only; stop on conflicting validation owner or write scope expansion.
    known_blockers: []
    dispatch:
      role: coder-worker-test-challenger
      attempts: 0
      dispatch_id: 07214d12-a9f2-4757-af98-35e6fc9fbbc6
      scope_sha256: 3e24d2b6e97fa24788a8717286f2b310c9fc61ade83ffcf15910cc81367916b9
      lease_state: result-accepted
      preflight_result: pass
      dispatched_at: '1792348609276'
      assigned_agent: 01a1504d-5ad1-7181-b0b1-724d725542ba
      agent_type_requested: cdr-worker-test-challenger
      model_requested: gpt-6.1-sol
      model_effective: gpt-6.1-sol
      route_attempts: 1
      wait_state: null
      blocker_fingerprint: null
      terminal_classification: null
      last_progress_revision: 64565860787063548b9969bec3d403a9010c734c1eec1235d46981a55d98085a
      result_receipt_id: null
      result_verdict: null
      result_blocker: null
    closeout:
      role_results:
      - role: cdr-worker
        agent_id: 01a15044-c2e1-7c32-a288-c37d5df52d8e
        effective_model: gpt-6.1-sol
        receipt_id: role-result-01d2c85febcc2997b624beb16b4dd29835ea8d30f1fecc0ef7a42a6f10c52823
        verdict: PASS
      - role: cdr-worker-test-challenger
        agent_id: 01a1504d-5ad1-7181-b0b1-724d725542ba
        effective_model: gpt-6.1-sol
        receipt_id: role-result-8f7b651c88e045bf21cb8f7667c25d60620b5adb52f019990748e8a8eeebdc94
        verdict: PASS
    dod_status: pass
```

## Worker Scenario

```gherkin
Scenario: Static nonregular inputs reject before content reads
  Given existing static FIFO/socket fixtures for capture and configuration readers
  When the fixture rejection assertions are made explicit
  Then both readers reject with unsupported and perform zero content reads
  And the source FIFO descriptor closes exactly once while other static cases acquire no descriptors
  And borrowed captures survive and regular controls pass after restoration
  And the declared focused validation passes

Write set: ontoindex/test/unit/workspace-capture-toctou.test.ts
Non-goals: production code, race reproduction, unrelated dirty work and canonical qualification changes
Stop when: a production invariant fails or the write scope must expand
```

Reuse roots/captures cleanup and exact-target fs.open observation. Preserve
concurrent work: the worker is not alone in this checkout. Record the diff and
SHA-256 before final validation; no affected edits afterward. Canonical IQ-5
remains blocked until its separate real ABA and repeated-replacement evidence exists.

## Required Traceability

| Requirement ID | ADR/user requirement | Disposition | Task IDs | Validation |
| --- | --- | --- | --- | --- |
| IQ-ROUTE-INVENTORY | User requests progress on independent IQ work | implementation | IQ-8I | Source-cited report and diff check |
| IQ-RECOVERY-STATIC | Recovery sentinel preservation and cleanup | compatibility-test | IQ-6S | Focused lock/coordinator suites and challenger |
| IQ-H2-STATIC | Static FIFO/socket rejection and cleanup | compatibility-test | IQ-5F2 | Three focused capture suites and independent challenger |
| IQ-H2-ABA | Real ABA and repeated replacement evidence | non-goal | IQ-5F2 | Retained in canonical IQ-5; no acceptance credit here |
| IQ-H2-PROOF | Preserve canonical IQ-5 independent adjudication | non-goal | IQ-5F2 | Canonical receipt and task state remain unchanged |

## Closeout

knowledge_handoff: none; installed manager-loop rules already require concrete dependency evidence before resuming a blocked proof.


## Discovery correction for next attempt

User explicitly requested all open IQ tasks continue. The failed discovery path
ontoindex/justfile is unnecessary: ontoindex/package.json exists (test -f exit 0).
Fresh pgrep for Vitest/build/tsc returned exit 1 with no matches; available memory
was 77081860 kB. Run the declared focused Node command directly in the package
working directory; no Just discovery is required. Preserve the accepted blocked
receipt and use its dependency-cleared resume token. Existing acceptance criteria
remain authoritative; a partial fixture cannot close the independent proof.


## Reviewed contract correction

The current user review request authorizes this substantive scope split. Two
gpt-6.1-sol medium reviews and two Luna reviews challenged the workflow. Keeping
the broad companion gate blocks a completed static contribution; production
redesign adds unproved scope and cost. Accept the static fixture contribution
through normal worker/challenger gates and keep canonical IQ-5 unchanged.
Historical accepted NEEDS_REWORK and its scope hash remain immutable. Resume
with fresh-evidence bound to that receipt after validating this changed contract.
This task cannot clear IQ-5 or qualify release/default activation.


## Evidence correction

The zero-open assumption failed in the focused run: 86 of 87 tests passed.
The source reader intentionally opens a FIFO with O_NONBLOCK and checks its
descriptor type before reading; its finally closes the handle. The configuration
reader rejects earlier. Correct the test contract rather than changing production.
Compare refusing every open (incompatible with current owner), asserting zero
content reads plus exact closure (selected), or redesigning acquisition (unneeded).
Second review retains explicit per-case acquisition counts to avoid vacuity.

Reviewed retry budget: one additional attempt corrects the manager-authored zero-open contract contradicted by source and retained 86/87 test evidence. Attempts and accepted receipts are preserved. Stop if this correction fails.


## Scheduling recovery decision

Four bounded reviewers compared canonical reconciliation, missing dependency
insertion and reuse of this companion twice. Canonical reconciliation preserves
the pinned ready IQ-5; dependency insertion leaves multiple eligible successors.
Select one independent inventory task here, then reconcile its sole unfinished
selection through manager tools. Preserve all prior receipts and DONE state.
The artifact prepares canonical IQ-8 acceptance and does not complete it.
