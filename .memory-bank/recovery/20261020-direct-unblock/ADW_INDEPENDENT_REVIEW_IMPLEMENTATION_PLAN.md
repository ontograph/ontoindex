# Automatic Workspace Independent Review Implementation Plan

Date: 2026-10-18
Status: Independent qualification and handoff complete; original authenticated acceptance remains gated
Authority: User request to review the Ontocode report and create an implementation plan.

## Goal

Produce a trustworthy, reproducible qualification and bounded corrective work for
automatic workspace reads before Ontocode adoption. Keep the feature opt-in until
correctness, lifecycle, compatibility and repeated performance gates pass.

## Evidence And Authority

Source report: `/tmp/ontoindex-adw-independent-psdzw0np/ONTOINDEX_TEAM_REPORT.md`.
SHA-256: `c238923de23c727316f27b0f66cdafa8cc9dd192232eef540ec33ad49b000e44`.
Review baseline: `acbcb63830cf51a8fc0537a76f4267e5be758167`.
The report's build receipt records exit 0 for dirty inputs; it supplies no new
unit/integration/runtime/performance qualification. Historical counts remain
attributed to their original evidence.

[Review and solution comparison](ADW_INDEPENDENT_REVIEW_AUDIT.md) preserves the
findings and decisions. The existing [ADW plan](AUTOMATIC_DIRTY_WORKSPACE_PROJECT_PLAN.md)
owns its task acceptance and default switch. This plan owns report follow-up
only. Its tasks do not satisfy or rewrite ADW task gates. The active ADW-2
lease is preserved. IQ-13 cannot declare default-on readiness without original
authenticated acceptance.

## Decisions And Non-Goals

- User instruction on 2026-10-18 authorizes execution of all open IQ tasks through
  the declared dependencies and acceptance gates. No provider calls or publication
  are authorized by this plan.
- IQ-0 establishes the validation owner; preparation checks and lane acquisition
  must gate execution, rather than merely print another process.
- Confirmed source defects are F1 and F2. H1–H4 require behavioral evidence.
  H4 also exposes an unconditional network install in test setup.
- Reuse existing supervisor, capture, analysis coordinator, generation pins,
  capability envelopes, error types and MCP lifecycle. No new index gateway,
  credential resolver, daemon, native dependency or durable snapshot protocol.
- Owner files are preparation scope. A worker receives exact symbols, OntoIndex
  impact, decided behavior and focused validation before dispatch. Proof tasks
  may record a failing reproduction; they cannot label it successful qualification.
- IQ-7, IQ-9 and IQ-10 must materialize corrective packets and update downstream
  dependencies when evidence calls for work. An unresolved unsafe condition blocks
  qualification; closing a design task does not waive a defect.
- Readiness fields remain additive; absent metadata means unknown. Workspace
  vectors and cross-repository atomic snapshots remain unsupported unless proved.
- Native Linux only, one executable validation job at a time. Independent source
  review can run in parallel. Later implementation uses at least four bounded
  agents across gpt-6-luna and gpt-6.1-sol, preserving registered role gates.
- Retain temporary report evidence into the normal bounded evidence store during
  IQ-0 before relying on its long-term availability; no bulk source or secrets.

## Completed Preparation Gate

IQ-0 completed through manager_loop complete-local on 2026-10-18 at revision
`082fa59b2e97f7f0e58d2fbf5d25465ec5bc5463d31fe6fcb9ca65070b613ab3`.
The exact accepted record follows. Its acceptance is an external precondition
for IQ-1, IQ-2 and IQ-8. Global local/subagent routing requires preserving
completed local acceptance outside the active dispatch map.

```yaml
  IQ-0:
    title: Freeze the report and current candidate identities and establish one validation owner
    status: DONE
    classification: architecture-paperwork
    assurance_profile: full
    complexity: complex
    depends_on: []
    type: inventory
    validation_tier: unit-fast
    impact_risk: medium
    owner_files:
    - /tmp/ontoindex-adw-independent-psdzw0np/ONTOINDEX_TEAM_REPORT.md
    - .memory-bank/AUTOMATIC_DIRTY_WORKSPACE_PROJECT_PLAN.md
    - ontoindex/package.json
    - .memory-bank/ADW_INDEPENDENT_REVIEW_IMPLEMENTATION_PLAN.md
    - .memory-bank/ADW_INDEPENDENT_REVIEW_AUDIT.md
    allowed_write_set:
    - .memory-bank/ADW_INDEPENDENT_REVIEW_IMPLEMENTATION_PLAN.md
    - .memory-bank/ADW_INDEPENDENT_REVIEW_AUDIT.md
    non_goals:
    - No ADW lease/status edits, default activation, release, provider calls, new service or unrelated changes.
    required_validation:
    - git rev-parse HEAD
    - git status --short
    - git diff --check
    expected_evidence:
    - Retain report SHA-256, clean baseline and dirty candidate input manifests, lockfile/native/runtime identities and build output identities separately.
    - Locate the historical suite owner and receipts; record actual terminal outcome or unavailable evidence without adopting PID 2899319 as current liveness.
    - Record a scoped no-overlap validation-lane owner and preflight process/lock/resource evidence before any build or test; preserve the original ADW-2 binding.
    rollback:
    - Revert only this packet; preserve pre-existing dirty changes, live owners and retained failure evidence.
    stop_conditions:
    - Acquire the single validation lane before executable checks; stop on conflicting ownership or changing frozen inputs.
    - Obtain OntoIndex impact before source edits; stop for a bounded manager decision when scope or contract is unresolved.
    known_blockers: []
    closeout:
      role_results:
        coder-manager: null
      main_session_evidence:
        authorized_by: user
        authorization_ref: Current-thread instruction to proceed all open IQ tasks on 2026-10-18.
        validation_summary: Audit IQ-0 section records baseline and candidate identities, native/runtime output digests, historical failed-suite receipt and root serial validation ownership. Required git rev-parse HEAD, git status --short and git diff --check exit 0. No build/test started; ADW-2 unchanged.
    dod_status: pass
```

## Manager Tracking

[Task tracking view](ADW_INDEPENDENT_REVIEW_TASK_TRACKER.md) presents the task
board, acceptance checklists and evidence ledger. The structured block below
remains the single dispatch and task-state authority.

```yaml
manager_loop:
  authority: true
  status: in-progress
  selection_policy: active_next_task-first
  active_next_task: IQ-6F
  max_in_flight: 1
  dispatch_mode: none
  dispatch_preflight:
    required_roles:
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
      coder-manager:
        agent_type_candidates:
        - coder-manager
        - cdr-manager
        model_candidates:
        - gpt-6.1-sol
        reasoning_effort: high
      coder-debug:
        agent_type_candidates:
        - coder-debug
        - cdr-debug
        model_candidates:
        - gpt-6.1-sol
        reasoning_effort: xhigh
      coder-auditor:
        agent_type_candidates:
        - coder-auditor
        - cdr-auditor
        model_candidates:
        - gpt-6.1-sol
        reasoning_effort: high
      coder-performance:
        agent_type_candidates:
        - coder-performance
        - cdr-performance
        model_candidates:
        - gpt-6.1-sol
        reasoning_effort: high
  reopen_gate: null
  last_decision: dispatch
tasks:
  IQ-1:
    title: Inherited Node preload reaches the existing cross-process fixture without losing stderr
    status: DONE
    classification: proof-only
    assurance_profile: full
    complexity: complex
    depends_on: []
    type: test
    validation_tier: unit-fast
    impact_risk: medium
    owner_files:
    - ontoindex/test/integration/overlay-cross-process.test.ts
    allowed_write_set: []
    non_goals:
    - No ADW lease/status edits, default activation, release, provider calls, new service or unrelated changes.
    required_validation:
    - ONTOINDEX_AUTO_WORKSPACE=0 ONTOINDEX_TEST_WORKERS=1 node node_modules/vitest/vitest.mjs run --maxWorkers=1 --no-file-parallelism test/integration/overlay-cross-process.test.ts
    - git diff --check
    expected_evidence:
    - Run Node validation with runner workdir /opt/d1/_wrk/ontoindex/ontoindex; no cd or shell chaining.
    - Demonstrate an inherited preload marker from the actual fixture child in retained stderr and successful exit; restore test environment afterward.
    - Move an evidenced necessary heap option to Node argv; remove the fixture override only if its lack of need is established. Do not concatenate option strings or filter the environment.
    rollback:
    - Revert only this packet; preserve pre-existing dirty changes, live owners and retained failure evidence.
    stop_conditions:
    - Acquire the single validation lane before executable checks; stop on conflicting ownership or changing frozen inputs.
    - Obtain OntoIndex impact before source edits; stop for a bounded manager decision when scope or contract is unresolved.
    known_blockers: []
    dispatch:
      role: coder-manager
      attempts: 0
      max_attempts: 5
      dispatch_id: ae2f3ac6-97c9-4656-88b3-0f2b5fae83e9
      scope_sha256: 1382edaca7552d7d341bf068a61530683c74b486df9cb01e3523d2d2d657bb83
      lease_state: result-accepted
      preflight_result: pass
      dispatched_at: '1792330292078'
      assigned_agent: 01a14f35-db3d-72e1-9c7e-437615f9fed4
      agent_type_requested: cdr-manager
      model_requested: gpt-6.1-sol
      model_effective: gpt-6.1-sol
      route_attempts: 1
      wait_state: null
      blocker_fingerprint: null
      terminal_classification: null
      last_progress_revision: d4bb658cea6aaa257e54fd3d95d21bd2d6eaffd1b1da09727129953e7644e527
      result_receipt_id: null
      result_verdict: null
      result_blocker: null
    closeout:
      role_results:
      - role: cdr-auditor
        agent_id: 01a14f32-5a27-7250-adaa-3a12d6d85dd7
        effective_model: gpt-6.1-sol
        receipt_id: role-result-ce081a1549fbe452bbcc5060d810cab6f0532a6d09c9d62d7aab20e8e3723de0
        verdict: PASS
      - role: cdr-manager
        agent_id: 01a14f35-db3d-72e1-9c7e-437615f9fed4
        effective_model: gpt-6.1-sol
        receipt_id: role-result-23c99b6176972de7fa18e9d98cd3f59fea839019ef0a4c67a975971a7422f6a2
        verdict: PASS
    dod_status: pass
  IQ-2:
    title: Linux Vitest fails an injected unhandled rejection and preserves native failure evidence
    status: DONE
    classification: implementation-ready
    assurance_profile: full
    complexity: complex
    depends_on: []
    type: test
    validation_tier: unit-fast
    impact_risk: medium
    owner_files:
    - ontoindex/vitest.config.ts
    - ontoindex/package.json
    - ontoindex/test/unit/vitest-unhandled-errors.test.ts
    allowed_write_set:
    - ontoindex/vitest.config.ts
    - ontoindex/test/unit/vitest-unhandled-errors.test.ts
    non_goals:
    - No ADW lease/status edits, default activation, release, provider calls, new service or unrelated changes.
    required_validation:
    - ONTOINDEX_AUTO_WORKSPACE=0 ONTOINDEX_TEST_WORKERS=1 node node_modules/vitest/vitest.mjs run --maxWorkers=1 --no-file-parallelism test/unit/vitest-unhandled-errors.test.ts
    - git diff --check
    expected_evidence:
    - Source discovery uses absolute existing paths /opt/d1/_wrk/ontoindex/ontoindex/vitest.config.ts and /opt/d1/_wrk/ontoindex/ontoindex/test/unit/bench-gate.test.ts; the new regression file is expected absent and must be created.
    - Execute Node validation with runner workdir /opt/d1/_wrk/ontoindex/ontoindex and no shell chaining.
    - An isolated deliberately failing fixture returns nonzero for an unhandled rejection while its enclosing regression passes; bounded stderr retains the diagnostic.
    - Root Linux configuration is strict. Preserve existing non-Linux configuration without extending or running non-Linux validation; any compatibility exception needs reproduced evidence and a separate decision.
    rollback:
    - Revert only this packet; preserve pre-existing dirty changes, live owners and retained failure evidence.
    stop_conditions:
    - Acquire the single validation lane before executable checks; stop on conflicting ownership or changing frozen inputs.
    - Obtain OntoIndex impact before source edits; stop for a bounded manager decision when scope or contract is unresolved.
    known_blockers: []
    dispatch:
      role: coder-worker-test-challenger
      attempts: 0
      dispatch_id: f4e449b1-ca3e-4691-ae84-030c62549423
      scope_sha256: 60e8d773ffcf2fc840b3ecf2561f3b8a17ed7b81317677609b053c6c959982a4
      lease_state: result-accepted
      preflight_result: pass
      dispatched_at: '1792331260443'
      assigned_agent: 01a14f44-a1ed-7753-a46b-eb777733c655
      agent_type_requested: cdr-worker-test-challenger
      model_requested: gpt-6.1-sol
      model_effective: gpt-6.1-sol
      route_attempts: 1
      wait_state: null
      blocker_fingerprint: null
      terminal_classification: null
      last_progress_revision: adcca37bfede9c3009add0ac2e36c0b753eecd31040168e1cc493078d463dffe
      result_receipt_id: null
      result_verdict: null
      result_blocker: null
    closeout:
      role_results:
      - role: cdr-worker
        agent_id: 01a14f3e-5234-7641-a406-cabce6a84e7a
        effective_model: gpt-6.1-sol
        receipt_id: role-result-4b71ef96d9cacd21a2daf9e93bd7610166cf0df0187bc0eec13c324e72a57612
        verdict: PASS
      - role: cdr-worker-test-challenger
        agent_id: 01a14f44-a1ed-7753-a46b-eb777733c655
        effective_model: gpt-6.1-sol
        receipt_id: role-result-5056b80c00c3eb3236edce62df04d9f0ac47fd5e7b37afae4288d8ce390c9fcd
        verdict: PASS
    dod_status: pass
  IQ-3:
    title: Native global setup uses existing offline FTS resolution and proves bounded settlement
    status: DONE
    classification: implementation-ready
    assurance_profile: full
    complexity: complex
    depends_on:
    - IQ-1
    - IQ-2
    type: test
    validation_tier: unit-fast
    impact_risk: medium
    owner_files:
    - ontoindex/test/global-setup.ts
    - ontoindex/src/core/lbug/lbug-adapter.ts
    - ontoindex/scripts/ladybug-extensions.mjs
    - ontoindex/test/unit/global-setup-lifecycle.test.ts
    allowed_write_set:
    - ontoindex/test/global-setup.ts
    - ontoindex/test/unit/global-setup-lifecycle.test.ts
    non_goals:
    - No ADW lease/status edits, default activation, release, provider calls, new service or unrelated changes.
    required_validation:
    - ONTOINDEX_AUTO_WORKSPACE=0 ONTOINDEX_TEST_WORKERS=1 node node_modules/vitest/vitest.mjs run --maxWorkers=1 --no-file-parallelism test/unit/global-setup-lifecycle.test.ts test/unit/ladybug-extensions-fetch.test.ts test/unit/lbug-fts-loading.test.ts test/unit/pool-extension-loading.test.ts
    - git diff --check
    expected_evidence:
    - Use runner workdir /opt/d1/_wrk/ontoindex/ontoindex for package commands; new global-setup-lifecycle.test.ts is expected absent and must be created.
    - Linux native child probe must await a real query timeout rejection then connection and database close and natural exit; outer timeout or signal is failure. Scope evidence to installed runtime, never universal native guarantees.
    - Reuse exported local FTS path resolution; default qualification setup never INSTALLs over the network. Explicitly classify missing optional FTS versus FTS-required acceptance.
    - Use supported native query timeout only with evidence that the operation settles; delayed-operation and close fixtures prove bounded teardown and preserve underlying errors.
    - Keep global setup enabled. If native timeout/close cannot be bounded in this owner, stop for design rather than adding a second setup supervisor.
    rollback:
    - Revert only this packet; preserve pre-existing dirty changes, live owners and retained failure evidence.
    stop_conditions:
    - Acquire the single validation lane before executable checks; stop on conflicting ownership or changing frozen inputs.
    - Obtain OntoIndex impact before source edits; stop for a bounded manager decision when scope or contract is unresolved.
    known_blockers: []
    dispatch:
      role: coder-worker-test-challenger
      attempts: 0
      dispatch_id: e8077aea-f311-4b10-8992-9287e4ea25c1
      scope_sha256: 161a76ac0e2cae5db35cbbaf96092ccd9a44e339a68b20187f4fcbdfb925ba80
      lease_state: result-accepted
      preflight_result: pass
      dispatched_at: '1792332401306'
      assigned_agent: 01a14f56-0a71-7f71-a5f3-2fb8b2ec054c
      agent_type_requested: cdr-worker-test-challenger
      model_requested: gpt-6.1-sol
      model_effective: gpt-6.1-sol
      route_attempts: 1
      wait_state: null
      blocker_fingerprint: null
      terminal_classification: null
      last_progress_revision: 5aa1e251c259afb3a3f03d83757fd10aa8b5e90f373da6400717b7c1bb5588d6
      result_receipt_id: null
      result_verdict: null
      result_blocker: null
    closeout:
      role_results:
      - role: cdr-worker
        agent_id: 01a14f4e-66a9-71d0-a270-28023a5f4466
        effective_model: gpt-6.1-sol
        receipt_id: role-result-631c706f8758a9e80d92fa095cb7d929488b77613943ca5bcfc96336358aa4fd
        verdict: PASS
      - role: cdr-worker-test-challenger
        agent_id: 01a14f56-0a71-7f71-a5f3-2fb8b2ec054c
        effective_model: gpt-6.1-sol
        receipt_id: role-result-febeae0f4349f31c1b1062f9d79a31ee91d367fc1ebf8e5e401bbb2476540d7f
        verdict: PASS
    dod_status: pass
  IQ-4F:
    title: Complete admission fixtures and repair durable unresolved-owner exclusion before independent proof
    status: DONE
    classification: implementation-ready
    assurance_profile: full
    complexity: complex
    depends_on:
    - IQ-3
    type: code
    validation_tier: unit-fast
    impact_risk: high
    owner_files:
    - ontoindex/src/mcp/local/workspace-build-supervisor.ts
    - ontoindex/src/cli/analyze.ts
    - ontoindex/test/unit/workspace-build-supervisor.test.ts
    - ontoindex/test/unit/analyze-lock.test.ts
    - ontoindex/test/unit/local-backend-repo-runtime.test.ts
    allowed_write_set:
    - ontoindex/src/mcp/local/workspace-build-supervisor.ts
    - ontoindex/src/cli/analyze.ts
    - ontoindex/test/unit/workspace-build-supervisor.test.ts
    - ontoindex/test/unit/analyze-lock.test.ts
    - ontoindex/test/unit/local-backend-repo-runtime.test.ts
    non_goals:
    - No ADW lease edits or defaults or publication or provider calls or new lock system.
    required_validation:
    - node scripts/build.js
    - ONTOINDEX_AUTO_WORKSPACE=0 ONTOINDEX_TEST_WORKERS=1 node node_modules/vitest/vitest.mjs run --maxWorkers=1 --no-file-parallelism test/unit/workspace-build-supervisor.test.ts test/unit/analyze-lock.test.ts test/unit/local-backend-repo-runtime.test.ts
    - git diff --check
    expected_evidence:
    - Preserve unresolved owner marker and live artifacts; refuse successor before spawning through supervisor and shared lock admission.
    - Validate ownership evidence and fail closed on malformed or unreadable markers; never clean with incomplete artifact snapshot.
    - Quarantined stopped groups recover while original server lives; active owners remain protected; provisional lock released on admission refusal.
    - Rebuild production artifacts and pass existing compiled child and independent CLI MCP API regressions; wire protocol coverage remains separately unproved.
    rollback:
    - Revert only repair changes and preserve red reproduction and unrelated work.
    stop_conditions:
    - Stop for unresolved ownership design or scope expansion; use one native validation lane.
    known_blockers: []
    dispatch:
      role: coder-worker-test-challenger
      attempts: 0
      dispatch_id: ccd894e9-6403-4ef6-89b4-c8b96cb99c3b
      scope_sha256: e08ec33e1cf48f6670dd81c7aae01a2851dd6b64119d2e2f038d4393a303a9e3
      lease_state: result-accepted
      preflight_result: pass
      dispatched_at: '1792335622072'
      assigned_agent: 01a14f87-2f7f-77e3-9be6-4fa89ec7f8c4
      agent_type_requested: cdr-worker-test-challenger
      model_requested: gpt-6.1-sol
      model_effective: gpt-6.1-sol
      route_attempts: 1
      wait_state: null
      blocker_fingerprint: null
      terminal_classification: null
      last_progress_revision: 820842a8805465aee7d8cf4eecba90676c5f741675361cda5e5a6b7561986132
      result_receipt_id: null
      result_verdict: null
      result_blocker: null
    closeout:
      role_results:
      - role: cdr-worker
        agent_id: 01a14f7a-b16b-7d62-95df-d4052a3577a3
        effective_model: gpt-6.1-sol
        receipt_id: role-result-312293114e8f28497485c18d73cbdeb86749ad9915ec4401b5ec100e895a0903
        verdict: PASS
      - role: cdr-worker-test-challenger
        agent_id: 01a14f87-2f7f-77e3-9be6-4fa89ec7f8c4
        effective_model: gpt-6.1-sol
        receipt_id: role-result-5440b654c18d70cdbff0a2dd4c2fee000a0f885e9392194899a646edb08009db
        verdict: PASS
    dod_status: pass
  IQ-4:
    title: Reproduce or refute surviving-build admission through both supervisor and runtime
    status: DONE
    classification: proof-only
    assurance_profile: full
    complexity: complex
    depends_on:
    - IQ-3
    - IQ-4F
    type: debug
    validation_tier: unit-fast
    impact_risk: high
    owner_files:
    - ontoindex/src/mcp/local/workspace-build-supervisor.ts
    - ontoindex/src/mcp/local/local-backend-repo-runtime.ts
    - ontoindex/test/unit/workspace-build-supervisor.test.ts
    - ontoindex/test/unit/local-backend-repo-runtime.test.ts
    - .memory-bank/ADW_INDEPENDENT_REVIEW_AUDIT.md
    allowed_write_set: []
    non_goals:
    - No ADW lease/status edits, default activation, release, provider calls, new service or unrelated changes.
    required_validation:
    - ONTOINDEX_AUTO_WORKSPACE=0 ONTOINDEX_TEST_WORKERS=1 node node_modules/vitest/vitest.mjs run --maxWorkers=1 --no-file-parallelism test/unit/workspace-build-supervisor.test.ts test/unit/local-backend-repo-runtime.test.ts
    - git diff --check
    expected_evidence:
    - Deterministically inject surviving sweep and unstoppable outcomes; invoke the next writer and record whether it spawns, releases ownership, overwrites marker or removes live artifacts.
    - Exercise the compiled production child path and independent CLI/MCP admission; source-mode in-process fallback is insufficient.
    - Record a failing reproduction as defect evidence rather than passing qualification; distinguish absent owner, safely reaped owner and unresolved owner. Kill only fixture-owned children.
    rollback:
    - Revert only this packet; preserve pre-existing dirty changes, live owners and retained failure evidence.
    stop_conditions:
    - Acquire the single validation lane before executable checks; stop on conflicting ownership or changing frozen inputs.
    - Obtain OntoIndex impact before source edits; stop for a bounded manager decision when scope or contract is unresolved.
    known_blockers: []
    dispatch:
      role: coder-manager
      attempts: 0
      dispatch_id: 2065c9a0-33fa-4e24-b4bd-e808682487f2
      scope_sha256: ffefbe976213851241c9ccb1c79d3cb5d15b4472d89a78e0d9d98496f3103530
      lease_state: result-accepted
      preflight_result: pass
      dispatched_at: '1792337157087'
      assigned_agent: 01a14f9e-9bb4-7672-b94b-1b0bb619ee26
      agent_type_requested: cdr-manager
      model_requested: gpt-6.1-sol
      model_effective: gpt-6.1-sol
      route_attempts: 1
      wait_state: null
      blocker_fingerprint: null
      terminal_classification: null
      last_progress_revision: 7ed9becffed67ee305c482a581e08ff26b2000b55c9ba834d93ccedacd71daa2
      result_receipt_id: null
      result_verdict: null
      result_blocker: null
    closeout:
      role_results:
      - role: cdr-debug
        agent_id: 01a14f92-9d70-7362-a2a6-598a02ef0914
        effective_model: gpt-6.1-sol
        receipt_id: role-result-8837e2b4f53b73eb2533e137fe61f0d7efff53d67f7a69cc68caa236dee474dd
        verdict: PASS
      - role: cdr-manager
        agent_id: 01a14f9e-9bb4-7672-b94b-1b0bb619ee26
        effective_model: gpt-6.1-sol
        receipt_id: role-result-8f4822d89f4d466db151d5b5a653c83bf9cbbf009d2b1f4794934ab5af1f55d5
        verdict: PASS
    dod_status: pass
  IQ-5F:
    title: Add capture descriptor identity checks and deterministic containment regressions
    status: DONE
    classification: implementation-ready
    assurance_profile: full
    complexity: complex
    depends_on:
    - IQ-3
    type: test
    validation_tier: unit-fast
    impact_risk: high
    owner_files:
    - ontoindex/src/core/analyze-delta.ts
    - ontoindex/test/unit/workspace-capture-toctou.test.ts
    allowed_write_set:
    - ontoindex/src/core/analyze-delta.ts
    - ontoindex/test/unit/workspace-capture-toctou.test.ts
    non_goals:
    - No ADW lease/status edits, default activation, release, provider calls, new service or unrelated changes.
    required_validation:
    - ONTOINDEX_AUTO_WORKSPACE=0 ONTOINDEX_TEST_WORKERS=1 node node_modules/vitest/vitest.mjs run --maxWorkers=1 --no-file-parallelism test/unit/workspace-capture-toctou.test.ts test/unit/workspace-input-capture.test.ts test/unit/workspace-capture-nested-repo.test.ts
    - git diff --check
    expected_evidence:
    - Compare leaf device inode identity before open against descriptor before content reads and against pathname after reads; identity changes use existing bounded retry and cleanup. Cover configuration reader in same owner.
    - Synthetic mismatch tests prove no reads before identity acceptance and no retained capture after persistent change; observational identity checks do not prove universal ancestor containment.
    - Use synthetic pathname descriptor identity mismatches and owned regular-file controls; assert rejection before reads and before copy acceptance. Leave real ancestor ABA reproduction unresolved in IQ-5.
    - Equal content with mismatched synthetic device inode identity must still reject; do not treat manifest equality as object identity.
    - Cover persistent mismatch, unsupported input type, bounded retry, continuous ordinary mutation and owned cleanup; do not construct an outside-read exploit.
    rollback:
    - Revert only this packet; preserve pre-existing dirty changes, live owners and retained failure evidence.
    stop_conditions:
    - Acquire the single validation lane before executable checks; stop on conflicting ownership or changing frozen inputs.
    - Obtain OntoIndex impact before source edits; stop for a bounded manager decision when scope or contract is unresolved.
    known_blockers: []
    dispatch:
      role: coder-worker-test-challenger
      attempts: 0
      dispatch_id: b4b5925d-6103-474e-a713-4e1ff775f05f
      scope_sha256: b519be96e2b3f0d81a8cc2278e185dee973f8a9ee7e54a8ade70e79130ee4aab
      lease_state: result-accepted
      preflight_result: pass
      dispatched_at: '1792338593979'
      assigned_agent: 01a14fb4-8890-7e93-a1d4-5718b416a6aa
      agent_type_requested: cdr-worker-test-challenger
      model_requested: gpt-6.1-sol
      model_effective: gpt-6.1-sol
      route_attempts: 1
      wait_state: null
      blocker_fingerprint: null
      terminal_classification: null
      last_progress_revision: 9237a70226366f88e42276acdb03138903e81d5f603f75576aaa14fd3d4a4340
      result_receipt_id: null
      result_verdict: null
      result_blocker: null
    closeout:
      role_results:
      - role: cdr-worker
        agent_id: 01a14fa9-fb59-74f2-8b6a-b2de5561e898
        effective_model: gpt-6.1-sol
        receipt_id: role-result-7b4bb2248a07acaf271fef5c38ee606e4b17629660494852005e04c4b36a0589
        verdict: PASS
      - role: cdr-worker-test-challenger
        agent_id: 01a14fb4-8890-7e93-a1d4-5718b416a6aa
        effective_model: gpt-6.1-sol
        receipt_id: role-result-1b53979f609acf7f39bed364e33c53d81e5e78b8249194aff31826ac00517a30
        verdict: PASS
    dod_status: pass
  IQ-5:
    title: Deterministic ancestor-symlink ABA fixture establishes capture containment
    status: DONE
    classification: proof-only
    assurance_profile: full
    complexity: complex
    depends_on:
    - IQ-3
    - IQ-5F
    type: debug
    validation_tier: unit-fast
    impact_risk: high
    owner_files:
    - ontoindex/src/core/analyze-delta.ts
    - ontoindex/test/unit/workspace-capture-toctou.test.ts
    - .memory-bank/ADW_INDEPENDENT_REVIEW_AUDIT.md
    allowed_write_set: []
    non_goals:
    - No ADW lease/status edits, default activation, release, provider calls, new service or unrelated changes.
    required_validation:
    - ONTOINDEX_AUTO_WORKSPACE=0 ONTOINDEX_TEST_WORKERS=1 node node_modules/vitest/vitest.mjs run --maxWorkers=1 --no-file-parallelism test/unit/workspace-capture-toctou.test.ts test/unit/workspace-input-capture.test.ts test/unit/workspace-capture-nested-repo.test.ts
    - git diff --check
    expected_evidence:
    - Swap ancestor to a disposable outside symlink, perform real leaf open, restore ancestor before returning the descriptor; record rejection/acceptance and any outside-byte read or retained capture.
    - 'Use matching outside/repository bytes with distinct descriptor/inode identity as well as secret-distinct bytes: three-manifest equality can reject the latter while failing to prove containment.'
    - Cover persistent swap, FIFO/socket replacements, repeated schedules, continuous mutation, and safe cleanup without leaking outside content in logs.
    rollback:
    - Revert only this packet; preserve pre-existing dirty changes, live owners and retained failure evidence.
    stop_conditions:
    - Acquire the single validation lane before executable checks; stop on conflicting ownership or changing frozen inputs.
    - Obtain OntoIndex impact before source edits; stop for a bounded manager decision when scope or contract is unresolved.
    known_blockers: []
    evidence:
    - Direct-session acceptance authorized by user ceremony-removal instruction; real-descriptor capture matrix passes 95/95 across three files, exit 0, 1.74s.
    - Persistent/transient ancestor swap and restore, equal-content distinct inode, differing harmless bytes, FIFO/socket, repeated schedules and mutation on both attempts reject safely; borrowed captures preserved.
    - Independent read-only review confirms all finite enumerated dimensions; no universal adversarial-schedule guarantee. Historical blocked receipt remains immutable evidence.
    closeout:
      role_results:
        coder-debug: null
        coder-manager: null
      main_session_evidence:
        authorized_by: user
        authorization_ref: Explicit request to remove CDR ceremony and execute directly.
        validation_summary: Finite containment schedules pass 95/95 tests in three files; independent review confirms coverage; exit 0.
    dod_status: pass
    dispatch:
      role: coder-debug
      attempts: 0
      dispatch_id: 902ab630-e840-4ef5-a8ae-c4fd68f0af7c
      scope_sha256: 151ef2ea8f3c02f3503b8845f082dd0d0fa88fa350c1263150304d2c2649046e
      lease_state: result-accepted
      preflight_result: pass
      dispatched_at: '1792339116738'
      assigned_agent: null
      agent_type_requested: cdr-debug
      model_requested: gpt-6.1-sol
      model_effective: gpt-6.1-sol
      route_attempts: 1
      wait_state: null
      blocker_fingerprint: null
      terminal_classification: 'blocked: dependency gate'
      last_progress_revision: accepted-receipt:role-result-db2e04ce0db61deeb1f13c91837b2d57375ab58ceb2d291518e5efe76b83a027
      result_receipt_id: role-result-db2e04ce0db61deeb1f13c91837b2d57375ab58ceb2d291518e5efe76b83a027
      result_verdict: BLOCKED
      result_blocker: 'IQ-5 containment proof is incomplete: the real ancestor-swap/open/restore fixture and its required schedule matrix are absent.'
  IQ-6F:
    title: Author deterministic fixture - Owned recovery-process death cannot strand successors or admit two writers
    status: OPEN
    classification: implementation-ready
    assurance_profile: full
    complexity: complex
    depends_on:
    - IQ-3
    - IQ-6R
    type: test
    validation_tier: unit-fast
    impact_risk: high
    owner_files:
    - ontoindex/src/cli/analyze.ts
    - ontoindex/src/core/analysis/analysis-coordinator.ts
    - ontoindex/test/unit/analyze-lock.test.ts
    - ontoindex/test/unit/analysis-coordinator.test.ts
    allowed_write_set:
    - ontoindex/test/unit/analyze-lock.test.ts
    non_goals:
    - No ADW lease/status edits, default activation, release, provider calls, new service or unrelated changes.
    required_validation:
    - ONTOINDEX_AUTO_WORKSPACE=0 ONTOINDEX_TEST_WORKERS=1 node node_modules/vitest/vitest.mjs run --maxWorkers=1 --no-file-parallelism test/unit/analyze-lock.test.ts test/unit/analysis-coordinator.test.ts
    - git diff --check
    expected_evidence:
    - Pause an owned fixture after lifetime kernel acquisition during recovery and before public identity publication; terminate it, then race two independent successor processes. Retain the stale-main diagnostic setup and archived evidence.
    - Record exactly-one-writer behavior, bounded recovery, no live-owner displacement and cleanup/reacquisition; cover death before identity write, PID reuse, legacy empty and malformed sentinels.
    - An orphan sentinel with no main lock does not prove the stale-main-lock recovery failure.
    rollback:
    - Revert only this packet; preserve pre-existing dirty changes, live owners and retained failure evidence.
    stop_conditions:
    - Acquire the single validation lane before executable checks; stop on conflicting ownership or changing frozen inputs.
    - Obtain OntoIndex impact before source edits; stop for a bounded manager decision when scope or contract is unresolved.
    known_blockers: []
    blocker_resolution: IQ-6D design and IQ-6R implementation accepted; current user authorization permits owned crash and successor fixture. Historical accepted receipt preserved.
    dispatch:
      role: coder-worker
      attempts: 1
      dispatch_id: a729bd14-d307-4295-9ffd-843e74a5958e
      scope_sha256: 61063b8c38e4a8ac63189a13ff33137c90586091737e232a0e79b8ce6a58d617
      lease_state: result-accepted
      preflight_result: pass
      dispatched_at: '1792349470307'
      assigned_agent: null
      agent_type_requested: cdr-worker
      model_requested: gpt-6.1-sol
      model_effective: gpt-6.1-sol
      route_attempts: 1
      wait_state: null
      blocker_fingerprint: null
      terminal_classification: 'blocked: dependency gate'
      last_progress_revision: accepted-receipt:role-result-86740d1a4373e0c57f9d3fc6ac950540bceb296e2a72dd39324136db29406bab
      result_receipt_id: role-result-86740d1a4373e0c57f9d3fc6ac950540bceb296e2a72dd39324136db29406bab
      result_verdict: BLOCKED
      result_blocker: 'blocked: scope/contract: Parent instruction prohibits the process-death and successor-race fixture required by unchanged IQ-6F acceptance. No edits or executable checks performed.'
    closeout:
      role_results:
        coder-worker: null
        coder-worker-test-challenger: null
      main_session_evidence:
        authorized_by: user
        authorization_ref: Proceed open tasks; dependency-cleared receipt token accepted after IQ-6R.
        validation_summary: Unfiltered analyze-lock and coordinator suites45/45 exit0 in6.62s; git diff --check0; bounded OntoIndex verify PASS. Actual owned process SIGKILL before public identity publication admits exactly one retained successor; release and reacquisition preserve permanent inode. Test SHA256 47c43668afc8e9e0105b89efa3a2506e06c610924cd98b35db2d1efe29015132.
  IQ-6:
    title: Owned recovery-process death cannot strand successors or admit two writers
    status: OPEN
    classification: proof-only
    assurance_profile: full
    complexity: complex
    depends_on:
    - IQ-3
    - IQ-6F
    type: debug
    validation_tier: unit-fast
    impact_risk: high
    owner_files:
    - ontoindex/src/cli/analyze.ts
    - ontoindex/src/core/analysis/analysis-coordinator.ts
    - ontoindex/test/unit/analyze-lock.test.ts
    - ontoindex/test/unit/analysis-coordinator.test.ts
    - .memory-bank/ADW_INDEPENDENT_REVIEW_AUDIT.md
    allowed_write_set: []
    non_goals:
    - No ADW lease/status edits, default activation, release, provider calls, new service or unrelated changes.
    required_validation:
    - ONTOINDEX_AUTO_WORKSPACE=0 ONTOINDEX_TEST_WORKERS=1 node node_modules/vitest/vitest.mjs run --maxWorkers=1 --no-file-parallelism test/unit/analyze-lock.test.ts test/unit/analysis-coordinator.test.ts
    - git diff --check
    expected_evidence:
    - Pause an owned fixture after lifetime kernel acquisition during recovery and before public identity publication; terminate it, then race two independent successor processes. Retain the stale-main diagnostic setup and archived evidence.
    - Record exactly-one-writer behavior, bounded recovery, no live-owner displacement and cleanup/reacquisition; cover death before identity write, PID reuse, legacy empty and malformed sentinels.
    - An orphan sentinel with no main lock does not prove the stale-main-lock recovery failure.
    rollback:
    - Revert only this packet; preserve pre-existing dirty changes, live owners and retained failure evidence.
    stop_conditions:
    - Acquire the single validation lane before executable checks; stop on conflicting ownership or changing frozen inputs.
    - Obtain OntoIndex impact before source edits; stop for a bounded manager decision when scope or contract is unresolved.
    known_blockers: []
  IQ-6N:
    title: Native process-owned file lock survives contention and releases on SIGKILL
    status: DONE
    classification: implementation-ready
    assurance_profile: full
    complexity: complex
    depends_on:
    - IQ-3
    type: code
    validation_tier: unit-fast
    impact_risk: high
    owner_files:
    - ontoindex-native/src/file_lock.rs
    - ontoindex-native/src/lib.rs
    - ontoindex-native/index.cjs
    - ontoindex-native/test/native-file-lock.test.cjs
    allowed_write_set:
    - ontoindex-native/src/file_lock.rs
    - ontoindex-native/src/lib.rs
    - ontoindex-native/index.cjs
    - ontoindex-native/test/native-file-lock.test.cjs
    non_goals:
    - No production activation, package dependency changes, external CLI runtime dependency, default activation or release.
    required_validation:
    - Native Linux release addon build with Cargo locked and offline; run node test/native-file-lock.test.cjs and node test/native-csv-writer.test.cjs from ontoindex-native.
    - git diff --check
    expected_evidence:
    - Standard-library nonblocking kernel lock returns null only for contention and throws other errors; idempotent release retains permanent inode and file bytes.
    - Independent ready-gated processes prove contention, SIGKILL release, exactly one retained successor lock, cleanup and reacquisition.
    rollback:
    - Revert only new native lock module, exports and test; preserve existing native functions and dirty source.
    stop_conditions:
    - Missing offline dependencies, unsupported Rust file-lock API, compiler conflict or platform other than Linux stops executable proof.
    known_blockers: []
    closeout:
      role_results:
        coder-worker: null
        coder-worker-test-challenger: null
      main_session_evidence:
        authorized_by: user
        authorization_ref: User proceed open tasks after dependency fetch recommendation.
        validation_summary: Locked Linux dependency fetch exit0; offline release addon build exit0 in12.84s; copy-native exit0; native-file-lock process tests exit0; native-csv-writer regression exit0; Cargo.lock SHA256 unchanged eeea721344c054e570d7a5d0f9385d044233930a9fed5df524b6669d859013c6; git diff --check exit0. Production integration remains gated.
    dod_status: pass
  IQ-6D:
    title: Select an atomic recovery ownership primitive with an explicit compatibility contract
    status: DONE
    classification: architecture-paperwork
    assurance_profile: full
    complexity: complex
    depends_on:
    - IQ-3
    - IQ-6N
    type: design-gate
    validation_tier: unit-fast
    impact_risk: high
    owner_files:
    - .memory-bank/ADW_INDEPENDENT_REVIEW_IMPLEMENTATION_PLAN.md
    - ontoindex/src/cli/analyze.ts
    - ontoindex/src/core/analysis/analysis-coordinator.ts
    - .memory-bank/ADW_INDEPENDENT_REVIEW_AUDIT.md
    allowed_write_set:
    - .memory-bank/ADW_INDEPENDENT_REVIEW_IMPLEMENTATION_PLAN.md
    - .memory-bank/ADW_INDEPENDENT_REVIEW_AUDIT.md
    non_goals:
    - No new runtime dependency, native addon, default activation or release without a separately accepted compatibility decision.
    required_validation:
    - git diff --check
    expected_evidence:
    - Compare permanent-inode kernel ownership, pathname claims and abstract sockets against process death, shared storage, namespace boundaries and mixed runtime versions.
    - Establish a supported runtime acquisition and lifetime owner; installed flock alone is insufficient. Insert an exact code correction and successor-matrix task before IQ-6 qualification.
    rollback:
    - Revert only new design text while preserving historical receipts and crash evidence.
    stop_conditions:
    - No proven supported atomic primitive or compatibility contract; retain IQ-6 success criteria unchanged.
    known_blockers: []
    closeout:
      role_results:
        coder-manager: null
      main_session_evidence:
        authorized_by: user
        authorization_ref: Repeated user proceed after native integration recommendation and accepted IQ-6N.
        validation_summary: IQ-6N native lifetime proof accepted; four independent design reviews selected lifetime kernel locks and package-owned addon. Exact IQ-6P packaging and IQ-6R ownership corrections inserted before IQ-6F and IQ-6; compatibility contract and rejected alternatives recorded in audit; git diff --check exit0.
    dod_status: pass
  IQ-6P:
    title: Package-owned native loader resolves the accepted lock addon without sibling fallback
    status: DONE
    classification: implementation-ready
    assurance_profile: full
    complexity: complex
    type: code
    validation_tier: unit-fast
    impact_risk: high
    depends_on:
    - IQ-6D
    owner_files:
    - ontoindex/scripts/build.js
    - ontoindex/src/native/module.ts
    - ontoindex-native/native.cjs
    - ontoindex/test/unit/native-module.test.ts
    allowed_write_set:
    - ontoindex/scripts/build.js
    - ontoindex/src/native/module.ts
    - ontoindex-native/native.cjs
    - ontoindex/test/unit/native-module.test.ts
    non_goals:
    - No release, default activation, new external dependency or unrelated source changes.
    required_validation:
    - node scripts/build.js from ontoindex
    - Focused native-module and existing native selection tests from ontoindex
    - git diff --check
    expected_evidence:
    - Build copies existing wrapper and Linux addon into dist/native/addon; missing artifacts fail the build.
    - Source and compiled loaders resolve package-owned addon; isolated installed layout loads without repository sibling; missing addon rejects.
    rollback:
    - Revert only this task's edits while preserving concurrent work.
    stop_conditions:
    - Unresolved ownership, incompatible artifact or scope expansion requires bounded correction.
    known_blockers: []
    closeout:
      role_results:
        coder-worker: null
        coder-worker-test-challenger: null
      main_session_evidence:
        authorized_by: user
        authorization_ref: Direct-session execution override and proceed open tasks.
        validation_summary: Native build exit0 copied addon and rewrote194 imports; focused native-module, CSV, import-extractor and graph-writer tests18/18 exit0; git diff --check exit0. Four source hashes verified unchanged on resume. Isolated package loads and missing addon rejects.
    dod_status: pass
  IQ-6R:
    title: Lifetime kernel ownership serializes analysis and bootstrap mutation through crash recovery
    status: DONE
    classification: implementation-ready
    assurance_profile: full
    complexity: complex
    type: code
    validation_tier: unit-fast
    impact_risk: high
    depends_on:
    - IQ-6P
    owner_files:
    - ontoindex/src/native/file-lock.ts
    - ontoindex/src/cli/analyze.ts
    - ontoindex/src/core/analysis/analysis-coordinator.ts
    - ontoindex/src/cli/export.ts
    - ontoindex/test/unit/analysis-coordinator.test.ts
    - ontoindex/test/unit/export-bootstrap.test.ts
    - ontoindex/test/unit/native-file-lock.test.ts
    allowed_write_set:
    - ontoindex/src/native/file-lock.ts
    - ontoindex/src/cli/analyze.ts
    - ontoindex/src/core/analysis/analysis-coordinator.ts
    - ontoindex/src/cli/export.ts
    - ontoindex/test/unit/analysis-coordinator.test.ts
    - ontoindex/test/unit/export-bootstrap.test.ts
    - ontoindex/test/unit/native-file-lock.test.ts
    non_goals:
    - No release, default activation, new external dependency or unrelated source changes.
    required_validation:
    - node scripts/build.js from ontoindex
    - Focused native-file-lock, analysis-coordinator and export-bootstrap suites serialized; analyze-lock regressions excluding obsolete records-stranded-recovery-sentinel characterization. IQ-6F must replace that characterization and pass the unfiltered suites before IQ-6 proof.
    - git diff --check
    expected_evidence:
    - Hold strong native handle through callback or AnalyzeLock.release finally; permanent analyze.lock.kernel and active.mutation.lock.kernel are never removed.
    - Atomically publish complete diagnostic identity; no new recovery sentinel; preserve malformed legacy markers and unknown/live owners byte-for-byte.
    - Bootstrap hydration acquires normal analysis lifetime ownership and never deletes analyze.lock as conflict cleanup.
    - Linux local filesystem and trusted metadata directory; quiescent upgrade excludes mixed-version writers, shared network storage and external inode replacement.
    rollback:
    - Revert only this task's edits while preserving concurrent work.
    stop_conditions:
    - Unresolved ownership, incompatible artifact or scope expansion requires bounded correction.
    known_blockers: []
    closeout:
      role_results:
        coder-worker: null
        coder-worker-test-challenger: null
      main_session_evidence:
        authorized_by: user
        authorization_ref: Direct-session execution override and proceed open tasks.
        validation_summary: Native build exit0; four focused suites66 passed and1 obsolete characterization excluded exit0; git diff --check exit0. Native lifetime held through callbacks and hydration; permanent inodes preserved; malformed legacy validation precedes removal. IQ-6F replaces obsolete crash characterization before independent recovery qualification.
    dod_status: pass
  IQ-9M:
    title: Module existence lookup excludes unused File content and preserves response fallbacks
    status: DONE
    classification: implementation-ready
    assurance_profile: lite
    complexity: simple
    depends_on:
    - IQ-8
    type: code
    validation_tier: unit-fast
    impact_risk: low
    owner_files:
    - ontoindex/src/mcp/super/explain-module.ts
    - ontoindex/test/unit/super/explain-module.test.ts
    allowed_write_set:
    - ontoindex/src/mcp/super/explain-module.ts
    - ontoindex/test/unit/super/explain-module.test.ts
    non_goals:
    - No pool size change, shared lifecycle rewrite, schema migration or community semantics change.
    required_validation:
    - ONTOINDEX_AUTO_WORKSPACE=0 ONTOINDEX_TEST_WORKERS=1 node node_modules/vitest/vitest.mjs run --maxWorkers=1 --no-file-parallelism test/unit/super/explain-module.test.ts test/unit/super/find-related.test.ts test/integration/super-functions.test.ts
    - git diff --check
    expected_evidence:
    - File lookup projects only filePath; scalar row keeps indexed-file response, source line count and git date fallback.
    - Ordered native integration passes at the existing pool budget; allocation failure remains open if reproduced.
    rollback:
    - Restore only the File projection and the new scalar-row regression.
    stop_conditions:
    - Native allocation failure persists or response compatibility regresses; diagnose without raising the memory limit.
    known_blockers: []
    closeout:
      role_results:
        coder-worker: null
        coder-worker-test-challenger: null
      main_session_evidence:
        authorized_by: user
        authorization_ref: Direct-session execution override and proceed open tasks on 2026-10-19.
        validation_summary: Required ordered native command passed42/42 across three files exit0 in19.08s at unchanged pool budget; git diff --check0. Prior allocation failure not reproduced; hashes in audit.
    dod_status: pass
  IQ-7:
    title: Adjudicate H1 H2 H3 and freeze only evidence-backed corrective packets
    status: DONE
    classification: architecture-paperwork
    assurance_profile: full
    complexity: complex
    depends_on:
    - IQ-4
    - IQ-5
    type: design-gate
    validation_tier: unit-fast
    impact_risk: high
    owner_files:
    - ontoindex/src/mcp/local/workspace-build-supervisor.ts
    - ontoindex/src/mcp/local/local-backend-repo-runtime.ts
    - ontoindex/src/cli/analyze.ts
    - ontoindex/src/core/analyze-delta.ts
    - .memory-bank/ADW_INDEPENDENT_REVIEW_IMPLEMENTATION_PLAN.md
    - .memory-bank/ADW_INDEPENDENT_REVIEW_AUDIT.md
    allowed_write_set:
    - .memory-bank/ADW_INDEPENDENT_REVIEW_IMPLEMENTATION_PLAN.md
    - .memory-bank/ADW_INDEPENDENT_REVIEW_AUDIT.md
    non_goals:
    - No ADW lease/status edits, default activation, release, provider calls, new service or unrelated changes.
    required_validation:
    - git diff --check
    expected_evidence:
    - For each hypothesis record reproduced, refuted within tested scope, or unresolved; no source-only runtime claim.
    - Completion records the evidence disposition and correction gates; it does not certify IQ-6 recovery success. IQ-11 directly requires IQ-6.
    - If confirmed, insert separate bounded corrective tasks and make IQ-11 depend on them before execution; the design gate alone cannot satisfy a confirmed defect.
    - Prefer shared admission guard in existing owners for H1; reuse identity/claim recovery conventions for H3; choose kernel/descriptor containment for H2 only after native-owner capability review. No dependency or native public surface is preauthorized.
    - Unknown unsafe writer/capture behavior blocks qualification. Recovery must preserve live-owner evidence and account for CLI admission, PID reuse and marker-write failure.
    rollback:
    - Revert only this packet; preserve pre-existing dirty changes, live owners and retained failure evidence.
    stop_conditions:
    - Acquire the single validation lane before executable checks; stop on conflicting ownership or changing frozen inputs.
    - Obtain OntoIndex impact before source edits; stop for a bounded manager decision when scope or contract is unresolved.
    known_blockers: []
    closeout:
      role_results:
        coder-manager: null
      main_session_evidence:
        authorized_by: user
        authorization_ref: Fresh user request to challenge, consolidate and proceed; direct-session ceremony removal preserved.
        validation_summary: Audit challenged review records H1 accepted IQ-4 admission proof; H2 finite IQ-5 containment proof; H3 real crash reproduces stranded successors. IQ-6D creates the design correction branch; IQ-11 directly requires IQ-6 and IQ-6D. Canonical plan parser passes and git diff --check exits 0.
    dod_status: pass
  IQ-8:
    title: Inventory report contracts against every public route and existing ADW owners
    status: DONE
    classification: architecture-paperwork
    assurance_profile: full
    complexity: complex
    depends_on: []
    type: inventory
    validation_tier: unit-fast
    impact_risk: medium
    owner_files:
    - ontoindex/src/mcp/local/local-backend.ts
    - ontoindex/src/mcp/local/local-backend-repo-runtime.ts
    - ontoindex/src/mcp/shared/target-context.ts
    - ontoindex/src/mcp/shared/response-envelope.ts
    - ontoindex/src/mcp/server.ts
    - .memory-bank/AUTOMATIC_DIRTY_WORKSPACE_PROJECT_PLAN.md
    - .memory-bank/ADW_INDEPENDENT_REVIEW_IMPLEMENTATION_PLAN.md
    - .memory-bank/ADW_INDEPENDENT_REVIEW_AUDIT.md
    allowed_write_set:
    - .memory-bank/ADW_INDEPENDENT_REVIEW_IMPLEMENTATION_PLAN.md
    - .memory-bank/ADW_INDEPENDENT_REVIEW_AUDIT.md
    non_goals:
    - No ADW lease/status edits, default activation, release, provider calls, new service or unrelated changes.
    required_validation:
    - git diff --check
    expected_evidence:
    - Produce per-route flag-off/on table with supported, unsupported and unproven states; include direct/facade/lazy/resource routes, lexical/vector/neighborhood/group, pagination and diagnostics.
    - For every report P0/P1/P2 row identify actual symbol/schema, test and ADW task; classify implemented-unqualified versus missing. Existing typed errors/envelopes/pins are reused.
    - Retain repository/base/digest/generation/coverage identity, failure codes/retry policy, response shaping cache keys, per-member group provenance and pin release/cancellation coverage.
    rollback:
    - Revert only this packet; preserve pre-existing dirty changes, live owners and retained failure evidence.
    stop_conditions:
    - Acquire the single validation lane before executable checks; stop on conflicting ownership or changing frozen inputs.
    - Obtain OntoIndex impact before source edits; stop for a bounded manager decision when scope or contract is unresolved.
    known_blockers: []
    evidence:
    - Direct-session acceptance authorized by user request to remove CDR ceremony; expanded ADW_IQ_ROUTE_INVENTORY.md inventories all routes and maps runtime gaps to explicit unproven or unmapped dispositions.
    - Source inventory only; no runtime qualification inferred. Final diff validation recorded in audit.
    closeout:
      role_results:
        coder-manager: null
      main_session_evidence:
        authorized_by: user
        authorization_ref: Explicit instruction to remove CDR ceremony and execute directly.
        validation_summary: Expanded source route inventory; git diff --check exit 0; runtime support remains explicitly unproven.
    dod_status: pass
  IQ-9:
    title: Freeze additive contract corrections only where route inventory demonstrates gaps
    status: DONE
    classification: architecture-paperwork
    assurance_profile: full
    complexity: complex
    depends_on:
    - IQ-7
    - IQ-8
    type: design-gate
    validation_tier: unit-fast
    impact_risk: medium
    owner_files:
    - ontoindex/src/mcp/shared/response-envelope.ts
    - ontoindex/src/mcp/shared/target-context.ts
    - ontoindex/src/mcp/local/local-backend.ts
    - .memory-bank/ADW_INDEPENDENT_REVIEW_IMPLEMENTATION_PLAN.md
    - .memory-bank/ADW_INDEPENDENT_REVIEW_AUDIT.md
    allowed_write_set:
    - .memory-bank/ADW_INDEPENDENT_REVIEW_IMPLEMENTATION_PLAN.md
    - .memory-bank/ADW_INDEPENDENT_REVIEW_AUDIT.md
    non_goals:
    - No ADW lease/status edits, default activation, release, provider calls, new service or unrelated changes.
    required_validation:
    - git diff --check
    expected_evidence:
    - Insert owner-sized code/test tasks for confirmed gaps; update IQ-11 dependencies to require their accepted results. Do not rebuild capabilities already present.
    - Freeze legacy-compatible compact default fields, unknown-on-missing metadata and explicit unsupported capabilities; use existing MCP progress and lifecycle owners.
    - Prefer per-request identity and existing pins; add multi-read handle only if an edit-between-reads experiment demonstrates insufficiency. Ontocode product edits require separate navigation in that checkout.
    rollback:
    - Revert only this packet; preserve pre-existing dirty changes, live owners and retained failure evidence.
    stop_conditions:
    - Acquire the single validation lane before executable checks; stop on conflicting ownership or changing frozen inputs.
    - Obtain OntoIndex impact before source edits; stop for a bounded manager decision when scope or contract is unresolved.
    known_blockers: []
    closeout:
      role_results:
        coder-manager: null
      main_session_evidence:
        authorized_by: user
        authorization_ref: Proceed following explicit review and direct-session execution authorization.
        validation_summary: Audit IQ-9 contract disposition records verified group metadata loss, positional docs cursors, committed-only discovery and existing envelope reuse. IQ-9G/C/R/P are explicit IQ-11 gates. Native baseline passes199/199 across six files exit0; plan parser passes and git diff --check exits0. No SDK qualification inferred.
    dod_status: pass
  IQ-9G:
    title: Group responses preserve distinct member provenance including empty and failed members
    status: DONE
    classification: architecture-paperwork
    assurance_profile: full
    complexity: complex
    depends_on:
    - IQ-9
    type: design-gate
    validation_tier: unit-fast
    impact_risk: medium
    owner_files:
    - ontoindex/src/core/group/service.ts
    - ontoindex/src/core/group/cross-impact.ts
    - ontoindex/src/core/group/types.ts
    - ontoindex/test/unit/group/service.test.ts
    - ontoindex/test/unit/group/cross-impact.test.ts
    - .memory-bank/ADW_INDEPENDENT_REVIEW_IMPLEMENTATION_PLAN.md
    - .memory-bank/ADW_INDEPENDENT_REVIEW_AUDIT.md
    allowed_write_set:
    - .memory-bank/ADW_INDEPENDENT_REVIEW_IMPLEMENTATION_PLAN.md
    - .memory-bank/ADW_INDEPENDENT_REVIEW_AUDIT.md
    non_goals:
    - No new snapshot coordinator, public preference flag, provider calls, release or source edits before exact correction scope is frozen.
    required_validation:
    - ONTOINDEX_AUTO_WORKSPACE=0 ONTOINDEX_TEST_WORKERS=1 node node_modules/vitest/vitest.mjs run --maxWorkers=1 --no-file-parallelism test/unit/group/service.test.ts test/unit/group/cross-impact.test.ts
    - git diff --check
    expected_evidence:
    - Record two members with distinct existing targetContext/freshness/graphAuthority fields; prove aggregation loss, then retain compact metadata in existing per-member output without changing ranking or adding group atomicity.
    - Insert exact implementation and flag-on SDK proof tasks for confirmed gaps; IQ-11 must depend on accepted corrections and proofs.
    rollback:
    - Revert only new packet text and preserve source fixtures, historical receipts and failure evidence.
    stop_conditions:
    - Unresolved compatibility or ownership decision; do not claim source inventory or unit-only evidence establishes SDK qualification.
    known_blockers: []
    closeout:
      role_results:
        coder-manager: null
      main_session_evidence:
        authorized_by: user
        authorization_ref: Explicit direct-session execution override and proceed.
        validation_summary: Group correction scope frozen in IQ-9GQ, boundary proof IQ-9GB and real producer proof IQ-9GS; all are direct IQ-11 dependencies. Fresh six-file regression passes67/67 exit0. Actual native SDK proof passes2/2; absent generation freshness explicitly unqualified. See audit for source hashes and graph attribution limitation.
    dod_status: pass
  IQ-9GQ:
    title: Existing group aggregators retain defined member provenance and sanitize failures
    status: DONE
    classification: implementation-ready
    assurance_profile: full
    complexity: complex
    depends_on:
    - IQ-9
    type: code
    validation_tier: unit-fast
    impact_risk: medium
    owner_files:
    - ontoindex/src/core/group/service.ts
    - ontoindex/src/core/group/cross-impact.ts
    - ontoindex/src/core/group/types.ts
    - ontoindex/test/unit/group/service.test.ts
    - ontoindex/test/unit/group/cross-impact-bridge-limit.test.ts
    allowed_write_set:
    - ontoindex/src/core/group/service.ts
    - ontoindex/src/core/group/cross-impact.ts
    - ontoindex/src/core/group/types.ts
    - ontoindex/test/unit/group/service.test.ts
    - ontoindex/test/unit/group/cross-impact-bridge-limit.test.ts
    non_goals:
    - No fabricated identity, full payload copying, new coordinator or group atomicity claim.
    required_validation:
    - ONTOINDEX_AUTO_WORKSPACE=0 ONTOINDEX_TEST_WORKERS=1 node node_modules/vitest/vitest.mjs run --maxWorkers=1 --no-file-parallelism test/unit/group/service.test.ts test/unit/group/group-service-group-mode.test.ts test/unit/group/cross-impact.test.ts test/unit/group/cross-impact-bridge-limit.test.ts
    - git diff --check
    expected_evidence:
    - Defined member metadata survives query, filtered context and cross-impact; context and impact also retain existing source and graphImpactAvailable fields including false. Absent metadata remains absent and failed query members are unavailable without raw errors.
    rollback:
    - Revert only this correction while retaining unrelated dirty changes.
    stop_conditions:
    - Metadata needs a new producer or public contract; record separate proof scope.
    known_blockers: []
    closeout:
      role_results:
        coder-worker: null
        coder-worker-test-challenger: null
      main_session_evidence:
        authorized_by: user
        authorization_ref: Explicit direct-session execution override and proceed.
        validation_summary: Required four-file native regression44/44 exit0 in3.28s; git diff --check0. Defined metadata and source plus false graphImpactAvailable preserved; failures sanitized. Actual producer scope independently validated by IQ-9GS2/2; no generation freshness claim.
    dod_status: pass
  IQ-9GB:
    title: Real group routing and SDK serialization preserve existing member metadata
    status: DONE
    classification: implementation-ready
    assurance_profile: full
    complexity: complex
    depends_on:
    - IQ-9
    type: test
    validation_tier: unit-fast
    impact_risk: low
    owner_files:
    - ontoindex/test/unit/mcp/group-repo-routing.test.ts
    - ontoindex/test/integration/mcp-http-api-auth.test.ts
    allowed_write_set:
    - ontoindex/test/unit/mcp/group-repo-routing.test.ts
    - ontoindex/test/integration/mcp-http-api-auth.test.ts
    non_goals:
    - Injected member analysis results do not establish real workspace analysis or graph generation identity.
    required_validation:
    - ONTOINDEX_AUTO_WORKSPACE=0 ONTOINDEX_TEST_WORKERS=1 node node_modules/vitest/vitest.mjs run --maxWorkers=1 --no-file-parallelism test/unit/mcp/group-repo-routing.test.ts test/integration/mcp-http-api-auth.test.ts
    - git diff --check
    expected_evidence:
    - Flag-on member callbacks use dispatchRepoTool and flag-off callbacks use direct handlers through real GroupService; real SDK Client preserves distinct injected metadata over HTTP.
    rollback:
    - Remove only the added test cases and fixtures.
    stop_conditions:
    - Test requires production changes beyond the frozen six-field projection.
    known_blockers: []
    closeout:
      role_results:
        coder-worker: null
        coder-worker-test-challenger: null
      main_session_evidence:
        authorized_by: user
        authorization_ref: Explicit direct-session execution override and proceed.
        validation_summary: Fresh six-file group and SDK regression passes67/67 exit0 in3.68s; flag-on/off callbacks and authenticated SDK HTTP boundary pass. Injected analysis explicitly limited to boundary proof.
    dod_status: pass
  IQ-9GS:
    title: Flag-on public SDK reports evidence from actual workspace member analysis
    status: DONE
    classification: proof-only
    assurance_profile: full
    complexity: complex
    depends_on:
    - IQ-9GQ
    - IQ-9GB
    type: proof
    validation_tier: unit-fast
    impact_risk: medium
    owner_files:
    - ontoindex/test/integration/group-workspace-provenance.test.ts
    - ontoindex/src/mcp/local/local-backend.ts
    - ontoindex/test/integration/workspace-graph-snapshot.test.ts
    - .memory-bank/ADW_INDEPENDENT_REVIEW_AUDIT.md
    allowed_write_set: []
    non_goals:
    - No injected producer identity may stand in for actual analysis; no default activation or release.
    required_validation:
    - ONTOINDEX_AUTO_WORKSPACE=1 ONTOINDEX_TEST_WORKERS=1 node node_modules/vitest/vitest.mjs run --maxWorkers=1 --no-file-parallelism test/integration/group-workspace-provenance.test.ts
    expected_evidence:
    - Two actual member results carry independently resolved provenance or explicitly unknown metadata through the public SDK, including empty and failed members.
    rollback:
    - Preserve failed proof evidence and remove only owned temporary fixtures.
    stop_conditions:
    - Producer does not emit required metadata; freeze a bounded existing-owner correction before editing.
    known_blockers: []
    closeout:
      role_results:
        coder-auditor: null
        coder-manager: null
      main_session_evidence:
        authorized_by: user
        authorization_ref: Explicit direct-session execution override and proceed.
        validation_summary: Fresh native actual-workspace SDK proof2/2 exit0 in16.30s; two real analyzed repositories, dirty symbols, filtered and empty results, unavailable member. InMemoryTransport SDK; absent generation freshness and targetContext stay absent; cross-impact runtime relationships unqualified. Test hash in audit.
    dod_status: pass
  IQ-9CL:
    title: Optional logical cursor binding rejects dataset changes while preserving unbound v1 callers
    status: DONE
    classification: implementation-ready
    assurance_profile: lite
    complexity: simple
    depends_on:
    - IQ-9
    type: code
    validation_tier: unit-fast
    impact_risk: low
    owner_files:
    - ontoindex/src/mcp/shared/response-limits.ts
    - ontoindex/test/unit/response-limits.test.ts
    allowed_write_set:
    - ontoindex/src/mcp/shared/response-limits.ts
    - ontoindex/test/unit/response-limits.test.ts
    non_goals:
    - No docs wiring, dataset derivation, byte-replay changes or server-side cursor registry.
    required_validation:
    - ONTOINDEX_AUTO_WORKSPACE=0 ONTOINDEX_TEST_WORKERS=1 node node_modules/vitest/vitest.mjs run --maxWorkers=1 --no-file-parallelism test/unit/response-limits.test.ts test/unit/response-pages.test.ts test/unit/super/docs-evidence.test.ts
    - git diff --check
    expected_evidence:
    - Bound v2 continuation rejects changed binding and legacy continuation with bounded restart error; unchanged binding and unbound v1 remain compatible.
    rollback:
    - Revert optional binding and its tests without modifying existing callers.
    stop_conditions:
    - Docs integration requires stable complete dataset or pre-pagination identity; freeze separate correction before editing docs.
    known_blockers: []
    closeout:
      role_results:
        coder-worker: null
        coder-worker-test-challenger: null
      main_session_evidence:
        authorized_by: user
        authorization_ref: Direct-session proceed authorization.
        validation_summary: Three focused suites pass44/44 exit0 in1.07s. Docs remains unbound; no dataset-drift closure claimed.
    dod_status: pass
  IQ-9CD:
    title: Docs binds logical continuation to complete source inputs while retaining context bounds
    status: DONE
    classification: implementation-ready
    assurance_profile: lite
    complexity: simple
    depends_on:
    - IQ-9CL
    type: code
    validation_tier: unit-fast
    impact_risk: low
    owner_files:
    - ontoindex/src/mcp/super/docs.ts
    - ontoindex/test/unit/super/docs-evidence.test.ts
    - ontoindex/test/integration/mcp-docs-facades.test.ts
    allowed_write_set:
    - ontoindex/src/mcp/super/docs.ts
    - ontoindex/test/unit/super/docs-evidence.test.ts
    - ontoindex/test/integration/mcp-docs-facades.test.ts
    non_goals:
    - No byte-replay changes, server-side registry, new API or removal of context derivation bounds.
    required_validation:
    - ONTOINDEX_AUTO_WORKSPACE=0 ONTOINDEX_TEST_WORKERS=1 node node_modules/vitest/vitest.mjs run --maxWorkers=1 --no-file-parallelism test/unit/response-limits.test.ts test/unit/response-pages.test.ts test/unit/super/docs-evidence.test.ts
    - git diff --check
    expected_evidence:
    - Docs emits v2 binding source identity, complete facts/resolutions and drift route candidates; unchanged context and trace continuation succeeds while mutation, request identity change and legacy v1 require restart.
    rollback:
    - Revert optional binding and its tests without modifying existing callers.
    stop_conditions:
    - Docs integration requires stable complete dataset or pre-pagination identity; freeze separate correction before editing docs.
    known_blockers: []
    closeout:
      role_results:
        coder-worker: null
        coder-worker-test-challenger: null
      main_session_evidence:
        authorized_by: user
        authorization_ref: Direct-session proceed authorization.
        validation_summary: Four focused suites pass72/72 exit0 in1.57s, native build0, diff check0 and bounded OntoIndex file verification PASS. Public SDK and drift-specific mutation proof remain separate.
    dod_status: pass
  IQ-9CS:
    title: Public SDK docs continuation rejects changed evidence with automatic workspace enabled
    status: DONE
    classification: implementation-ready
    assurance_profile: full
    complexity: standard
    depends_on:
    - IQ-9CD
    type: test
    validation_tier: unit-fast
    impact_risk: low
    owner_files:
    - ontoindex/test/integration/mcp-docs-cursor-sdk.test.ts
    - ontoindex/test/integration/mcp-docs-facades.test.ts
    allowed_write_set:
    - ontoindex/test/integration/mcp-docs-cursor-sdk.test.ts
    - ontoindex/test/integration/mcp-docs-facades.test.ts
    non_goals:
    - No production changes, provider calls, default activation or qualification of real graph route production using injected rows.
    required_validation:
    - ONTOINDEX_AUTO_WORKSPACE=1 ONTOINDEX_TEST_WORKERS=1 node node_modules/vitest/vitest.mjs run --maxWorkers=1 --no-file-parallelism test/integration/mcp-docs-cursor-sdk.test.ts test/integration/mcp-docs-facades.test.ts
    - git diff --check
    expected_evidence:
    - Real SDK client and server with LocalBackend continue unchanged docs pages and reject an unseen same-length edit; trace and context use real docs handler with automatic workspace enabled.
    - Injected graph rows produce three drift findings; changing only an unseen route sourceFile preserves count and first page but rejects old continuation.
    rollback:
    - Revert only the new SDK fixture and added drift cases.
    stop_conditions:
    - Stop if the real backend needs production changes or unrelated graph fixture ownership.
    known_blockers: []
    closeout:
      role_results:
        coder-worker: null
        coder-worker-test-challenger: null
      main_session_evidence:
        authorized_by: user
        authorization_ref: Explicit direct-session execution override and proceed.
        validation_summary: Serialized flag-on SDK and facade suites pass25/25 exit0 in3.55s; native build0. Real LocalBackend SDK context/trace continue four unique pages and reject same-byte-length ignored sidecar edits. Injected graph rows prove unseen route sourceFile and docs path changes reject drift continuation with unchanged first page and count. Bounded OntoIndex verification PASS exactly two test files without symbol attribution.
    dod_status: pass
  IQ-9C:
    title: Logical docs continuation rejects dataset drift without changing immutable byte replay
    status: DONE
    classification: architecture-paperwork
    assurance_profile: full
    complexity: complex
    depends_on:
    - IQ-9
    type: design-gate
    validation_tier: unit-fast
    impact_risk: medium
    owner_files:
    - ontoindex/src/mcp/shared/response-limits.ts
    - ontoindex/src/mcp/shared/response-pages.ts
    - ontoindex/src/mcp/super/docs.ts
    - ontoindex/test/unit/response-limits.test.ts
    - ontoindex/test/unit/super/docs-evidence.test.ts
    - .memory-bank/ADW_INDEPENDENT_REVIEW_IMPLEMENTATION_PLAN.md
    - .memory-bank/ADW_INDEPENDENT_REVIEW_AUDIT.md
    allowed_write_set:
    - .memory-bank/ADW_INDEPENDENT_REVIEW_IMPLEMENTATION_PLAN.md
    - .memory-bank/ADW_INDEPENDENT_REVIEW_AUDIT.md
    non_goals:
    - No new snapshot coordinator, public preference flag, provider calls, release or source edits before exact correction scope is frozen.
    required_validation:
    - ONTOINDEX_AUTO_WORKSPACE=0 ONTOINDEX_TEST_WORKERS=1 node node_modules/vitest/vitest.mjs run --maxWorkers=1 --no-file-parallelism test/unit/response-limits.test.ts test/unit/response-pages.test.ts test/unit/super/docs-evidence.test.ts
    - git diff --check
    expected_evidence:
    - First reproduce same-length reorder between logical pages. Freeze compatible dataset/argument binding or reuse existing stored-response owner; legacy positional cursor policy must be explicit before edits. Byte response replay remains immutable.
    - Insert exact implementation and flag-on SDK proof tasks for confirmed gaps; IQ-11 must depend on accepted corrections and proofs.
    rollback:
    - Revert only new packet text and preserve source fixtures, historical receipts and failure evidence.
    stop_conditions:
    - Unresolved compatibility or ownership decision; do not claim source inventory or unit-only evidence establishes SDK qualification.
    known_blockers: []
    closeout:
      role_results:
        coder-manager: null
      main_session_evidence:
        authorized_by: user
        authorization_ref: Explicit direct-session execution override and proceed.
        validation_summary: Fresh serialized cursor primitive, immutable byte replay and docs unit suites pass50/50 exit0 in1.13s. Three designs compared twice; complete input binding selected and legacy docs v1 restart explicit. IQ-9CL/CD corrections and IQ-9CS flag-on SDK proof frozen; IQ-11 directly requires all three. No SDK qualification claimed by design acceptance.
    dod_status: pass
  IQ-9R:
    closeout:
      role_results:
        coder-manager: null
      main_session_evidence:
        authorized_by: user
        authorization_ref: Explicit direct-session execution override and proceed.
        validation_summary: Three alternatives challenged twice; existing contract/description wording selected over schema expansion or duplicate registry. Exact correction IQ-9RD and real SDK proof IQ-9RS frozen; IQ-11 directly requires both. Fresh resources/server/lazy regression153/153 exit0 in1.40s. Existing notice and dispatch owners retained.
    title: Lazy graph tools and resources disclose committed-only support and preserve notices
    status: DONE
    classification: architecture-paperwork
    assurance_profile: full
    complexity: complex
    depends_on:
    - IQ-9
    type: design-gate
    validation_tier: unit-fast
    impact_risk: medium
    owner_files:
    - ontoindex/src/mcp/resources.ts
    - ontoindex/src/mcp/super/help.ts
    - ontoindex/src/mcp/server.ts
    - ontoindex/test/unit/resources.test.ts
    - ontoindex/test/unit/server.test.ts
    - ontoindex/test/unit/mcp-server-lazy-loading.test.ts
    - .memory-bank/ADW_INDEPENDENT_REVIEW_IMPLEMENTATION_PLAN.md
    - .memory-bank/ADW_INDEPENDENT_REVIEW_AUDIT.md
    allowed_write_set:
    - .memory-bank/ADW_INDEPENDENT_REVIEW_IMPLEMENTATION_PLAN.md
    - .memory-bank/ADW_INDEPENDENT_REVIEW_AUDIT.md
    non_goals:
    - No new snapshot coordinator, public preference flag, provider calls, release or source edits before exact correction scope is frozen.
    required_validation:
    - ONTOINDEX_AUTO_WORKSPACE=0 ONTOINDEX_TEST_WORKERS=1 node node_modules/vitest/vitest.mjs run --maxWorkers=1 --no-file-parallelism test/unit/resources.test.ts test/unit/server.test.ts test/unit/mcp-server-lazy-loading.test.ts
    - git diff --check
    expected_evidence:
    - Expose committed-only workspace support in existing discovery definitions; test dirty flag-on/off notices including singular resources and lazy dispatch. Preserve legacy response shape and availability.
    - Insert exact implementation and flag-on SDK proof tasks for confirmed gaps; IQ-11 must depend on accepted corrections and proofs.
    rollback:
    - Revert only new packet text and preserve source fixtures, historical receipts and failure evidence.
    stop_conditions:
    - Unresolved compatibility or ownership decision; do not claim source inventory or unit-only evidence establishes SDK qualification.
    known_blockers: []
    dod_status: pass
  IQ-9RD:
    title: Resource and lazy graph discovery disclose committed-index scope
    status: DONE
    classification: implementation-ready
    assurance_profile: full
    complexity: standard
    depends_on:
    - IQ-9
    type: code
    validation_tier: unit-fast
    impact_risk: low
    owner_files:
    - ontoindex/src/mcp/resources.ts
    - ontoindex/src/mcp/super/tool-definitions.ts
    - ontoindex/test/unit/resources.test.ts
    allowed_write_set:
    - ontoindex/src/mcp/resources.ts
    - ontoindex/src/mcp/super/tool-definitions.ts
    - ontoindex/test/unit/resources.test.ts
    non_goals:
    - No schema or runtime dispatch changes.
    required_validation:
    - ONTOINDEX_AUTO_WORKSPACE=0 ONTOINDEX_TEST_WORKERS=1 node node_modules/vitest/vitest.mjs run --maxWorkers=1 --no-file-parallelism test/unit/resources.test.ts test/unit/server.test.ts test/unit/mcp-server-lazy-loading.test.ts
    - git diff --check
    expected_evidence:
    - Five graph resource contracts and three lazy graph tools disclose committed-index graph scope; singular resource notices are covered.
    rollback:
    - Revert only new descriptions and assertions.
    stop_conditions:
    - Runtime changes or public schema expansion required.
    known_blockers: []
    closeout:
      role_results:
        coder-worker: null
        coder-worker-test-challenger: null
      main_session_evidence:
        authorized_by: user
        authorization_ref: Explicit direct-session execution override and proceed.
        validation_summary: Resource/server/lazy suites pass153/153 exit0 in1.40s; native build0. Singular notices and both resource discovery surfaces covered. Two sol-medium developers changed five freshness strings, three descriptions and resource assertions. Bounded OntoIndex verify PASS expected constants RESOURCE_TEMPLATES and ONTOINDEX_SUPER_TOOLS in three files. No runtime/schema changes.
    dod_status: pass
  IQ-9RS:
    title: SDK discovery and committed graph notices respect workspace flags
    status: DONE
    classification: implementation-ready
    assurance_profile: full
    complexity: standard
    depends_on:
    - IQ-9RD
    type: test
    validation_tier: unit-fast
    impact_risk: low
    owner_files:
    - ontoindex/test/integration/mcp-committed-discovery-sdk.test.ts
    allowed_write_set:
    - ontoindex/test/integration/mcp-committed-discovery-sdk.test.ts
    non_goals:
    - No production changes or provider calls.
    required_validation:
    - ONTOINDEX_AUTO_WORKSPACE=1 ONTOINDEX_TEST_WORKERS=1 node node_modules/vitest/vitest.mjs run --maxWorkers=1 --no-file-parallelism test/integration/mcp-committed-discovery-sdk.test.ts
    - git diff --check
    expected_evidence:
    - Real SDK and LocalBackend expose accurate resource/tool descriptions and clean/dirty notices for workspace flag on/off; lazy dispatch retains warning.
    rollback:
    - Remove only the new SDK fixture.
    stop_conditions:
    - Native fixture requires unrelated production fixes.
    known_blockers: []
    closeout:
      role_results:
        coder-worker: null
        coder-worker-test-challenger: null
      main_session_evidence:
        authorized_by: user
        authorization_ref: Explicit direct-session execution override and proceed.
        validation_summary: Frozen native SDK fixture ab63c6f0818afdc8672471045f5e6f62534d94d45fb7ded0d3771452ee1ce00d passes2/2 exit0 in3.46s. Actual LocalBackend/native analysis proves five template descriptions and three tool descriptions, clean and dirty flag-on/off resource notices including required real cluster/process details, and first-call lazy gn_find_related preserving existing warnings. Correction round1 fixed tiny-cluster fixture by dense eight-function DAG; earlier conditional pass is not acceptance evidence.
    dod_status: pass
  IQ-9P:
    closeout:
      role_results:
        coder-manager: null
      main_session_evidence:
        authorized_by: user
        authorization_ref: Explicit direct-session execution override and proceed.
        validation_summary: Design scope frozen in PI PE PD PW PS PV PC with direct IQ11 gates. Fresh326/326 flag-on and217/217 flag-off exit0; diff check0. Existing vector warning and cancellation ownership inspected; no SDK proof inferred. Audit records alternatives and limits.
    title: Existing route envelopes retain unknown metadata and privacy boundaries under both flags
    status: DONE
    classification: architecture-paperwork
    assurance_profile: full
    complexity: complex
    depends_on:
    - IQ-9
    type: design-gate
    validation_tier: unit-fast
    impact_risk: medium
    owner_files:
    - ontoindex/src/mcp/shared/response-envelope.ts
    - ontoindex/src/mcp/shared/target-context.ts
    - ontoindex/src/mcp/local/local-backend.ts
    - ontoindex/test/unit/response-envelope.test.ts
    - ontoindex/test/unit/calltool-dispatch.test.ts
    - ontoindex/test/unit/super/diagnose.test.ts
    - .memory-bank/ADW_INDEPENDENT_REVIEW_IMPLEMENTATION_PLAN.md
    - .memory-bank/ADW_INDEPENDENT_REVIEW_AUDIT.md
    allowed_write_set:
    - .memory-bank/ADW_INDEPENDENT_REVIEW_IMPLEMENTATION_PLAN.md
    - .memory-bank/ADW_INDEPENDENT_REVIEW_AUDIT.md
    non_goals:
    - No new snapshot coordinator, public preference flag, provider calls, release or source edits before exact correction scope is frozen.
    required_validation:
    - ONTOINDEX_AUTO_WORKSPACE=0 ONTOINDEX_TEST_WORKERS=1 node node_modules/vitest/vitest.mjs run --maxWorkers=1 --no-file-parallelism test/unit/response-envelope.test.ts test/unit/calltool-dispatch.test.ts test/unit/super/diagnose.test.ts
    - git diff --check
    expected_evidence:
    - Qualify existing fields and defaults before proposing code: absent identity remains unknown, fallback labeled, unsupported workspace vectors explicit, bounded diagnostics contain no source text or credentials; request cancellation uses existing pins.
    - Insert exact implementation and flag-on SDK proof tasks for confirmed gaps; IQ-11 must depend on accepted corrections and proofs.
    rollback:
    - Revert only new packet text and preserve source fixtures, historical receipts and failure evidence.
    stop_conditions:
    - Unresolved compatibility or ownership decision; do not claim source inventory or unit-only evidence establishes SDK qualification.
    known_blockers: []
    dod_status: pass
  IQ-9PI:
    title: Missing commit identity stays unknown while proven changes remain true
    status: DONE
    classification: implementation-ready
    assurance_profile: full
    complexity: complex
    depends_on:
    - IQ-9
    type: code
    validation_tier: unit-fast
    impact_risk: high
    owner_files:
    - ontoindex/src/mcp/shared/target-context.ts
    - ontoindex/test/unit/target-context.test.ts
    allowed_write_set:
    - ontoindex/src/mcp/shared/target-context.ts
    - ontoindex/test/unit/target-context.test.ts
    non_goals:
    - No graph authority or schema changes.
    required_validation:
    - ONTOINDEX_AUTO_WORKSPACE=0 ONTOINDEX_TEST_WORKERS=1 node node_modules/vitest/vitest.mjs run --maxWorkers=1 --no-file-parallelism test/unit/target-context.test.ts test/unit/response-envelope.test.ts
    - git diff --check
    expected_evidence:
    - Missing identity or worktree knowledge yields null unless dirty status or commit mismatch proves true.
    rollback:
    - Revert only calculation and regressions.
    stop_conditions:
    - Authority redesign required.
    known_blockers: []
    closeout:
      role_results:
        coder-worker: null
        coder-worker-test-challenger: null
      main_session_evidence:
        authorized_by: user
        authorization_ref: Explicit direct-session execution override and proceed.
        validation_summary: Fresh combined privacy validation 2026-10-19 passes326/326 across six files exit0 in11.35s with AUTO_WORKSPACE=1; SDK internally covers both flags and response modes. Current hashes and independent review recorded in audit. git diff --check exit0..
    dod_status: pass
  IQ-9PE:
    title: Diagnostic environment serialization redacts endpoint settings
    status: DONE
    classification: implementation-ready
    assurance_profile: full
    complexity: standard
    depends_on:
    - IQ-9
    type: code
    validation_tier: unit-fast
    impact_risk: medium
    owner_files:
    - ontoindex/src/mcp/super/diagnose.ts
    - ontoindex/test/unit/super/diagnose.test.ts
    allowed_write_set:
    - ontoindex/src/mcp/super/diagnose.ts
    - ontoindex/test/unit/super/diagnose.test.ts
    non_goals:
    - No concurrent startup repair or requested source result changes.
    required_validation:
    - ONTOINDEX_AUTO_WORKSPACE=0 ONTOINDEX_TEST_WORKERS=1 node node_modules/vitest/vitest.mjs run --maxWorkers=1 --no-file-parallelism test/unit/super/diagnose.test.ts
    - git diff --check
    expected_evidence:
    - Legacy and envelope envVars redact URL and endpoint keys through existing sanitizer while scalar settings remain visible.
    rollback:
    - Revert only endpoint sensitivity and regressions.
    stop_conditions:
    - Concurrent conflict or serializer redesign required.
    known_blockers: []
    closeout:
      role_results:
        coder-worker: null
        coder-worker-test-challenger: null
      main_session_evidence:
        authorized_by: user
        authorization_ref: Explicit direct-session execution override and proceed.
        validation_summary: Fresh combined privacy validation 2026-10-19 passes326/326 across six files exit0 in11.35s with AUTO_WORKSPACE=1; SDK internally covers both flags and response modes. Current hashes and independent review recorded in audit. git diff --check exit0..
    dod_status: pass
  IQ-9PD:
    title: Diagnostic failures expose fixed categories without claiming retrieval execution
    status: DONE
    classification: implementation-ready
    assurance_profile: full
    complexity: complex
    depends_on:
    - IQ-9
    type: code
    validation_tier: unit-fast
    impact_risk: medium
    owner_files:
    - ontoindex/src/mcp/super/diagnose.ts
    - ontoindex/test/unit/super/diagnose.test.ts
    allowed_write_set:
    - ontoindex/src/mcp/super/diagnose.ts
    - ontoindex/test/unit/super/diagnose.test.ts
    non_goals:
    - No schema changes or new sanitizer framework.
    required_validation:
    - ONTOINDEX_AUTO_WORKSPACE=1 ONTOINDEX_TEST_WORKERS=1 node node_modules/vitest/vitest.mjs run --maxWorkers=1 --no-file-parallelism test/unit/super/diagnose.test.ts
    - git diff --check
    expected_evidence:
    - Synthetic credential and source markers do not escape failure diagnostics; error codes and missing capability facts remain accurate.
    rollback:
    - Revert only scoped corrections and regressions.
    stop_conditions:
    - Unresolved ownership or concurrent write conflict.
    known_blockers: []
    closeout:
      role_results:
        coder-worker: null
        coder-worker-test-challenger: null
      main_session_evidence:
        authorized_by: user
        authorization_ref: Explicit direct-session execution override and proceed.
        validation_summary: Fresh combined privacy validation 2026-10-19 passes326/326 across six files exit0 in11.35s with AUTO_WORKSPACE=1; SDK internally covers both flags and response modes. Current hashes and independent review recorded in audit. git diff --check exit0.
    dod_status: pass
  IQ-9PW:
    title: Workspace and manifest failures omit raw dependency error text
    status: DONE
    classification: implementation-ready
    assurance_profile: full
    complexity: complex
    depends_on:
    - IQ-9
    type: code
    validation_tier: unit-fast
    impact_risk: medium
    owner_files:
    - ontoindex/src/mcp/local/local-backend.ts
    - ontoindex/test/unit/calltool-dispatch.test.ts
    - ontoindex/src/mcp/local/local-backend-repo-runtime.ts
    - ontoindex/test/unit/local-backend-repo-runtime.test.ts
    - ontoindex/src/mcp/shared/target-context.ts
    - ontoindex/test/unit/target-context.test.ts
    allowed_write_set:
    - ontoindex/src/mcp/local/local-backend.ts
    - ontoindex/test/unit/calltool-dispatch.test.ts
    - ontoindex/src/mcp/local/local-backend-repo-runtime.ts
    - ontoindex/test/unit/local-backend-repo-runtime.test.ts
    - ontoindex/src/mcp/shared/target-context.ts
    - ontoindex/test/unit/target-context.test.ts
    non_goals:
    - No schema changes or new sanitizer framework.
    required_validation:
    - ONTOINDEX_AUTO_WORKSPACE=1 ONTOINDEX_TEST_WORKERS=1 node node_modules/vitest/vitest.mjs run --maxWorkers=1 --no-file-parallelism test/unit/local-backend-repo-runtime.test.ts test/unit/target-context.test.ts
    - git diff --check
    expected_evidence:
    - Synthetic credential and source markers do not escape failure diagnostics; error codes and missing capability facts remain accurate.
    rollback:
    - Revert only scoped corrections and regressions.
    stop_conditions:
    - Unresolved ownership or concurrent write conflict.
    known_blockers: []
    closeout:
      role_results:
        coder-worker: null
        coder-worker-test-challenger: null
      main_session_evidence:
        authorized_by: user
        authorization_ref: Explicit direct-session execution override and proceed.
        validation_summary: Fresh combined privacy validation 2026-10-19 passes326/326 across six files exit0 in11.35s with AUTO_WORKSPACE=1; SDK internally covers both flags and response modes. Current hashes and independent review recorded in audit. git diff --check exit0.
    dod_status: pass
  IQ-9PS:
    title: SDK diagnostic serialization preserves privacy under both workspace flags
    status: DONE
    classification: implementation-ready
    assurance_profile: full
    complexity: complex
    depends_on:
    - IQ-9
    type: code
    validation_tier: unit-fast
    impact_risk: medium
    owner_files:
    - ontoindex/test/integration/mcp-diagnostic-privacy-sdk.test.ts
    allowed_write_set:
    - ontoindex/test/integration/mcp-diagnostic-privacy-sdk.test.ts
    non_goals:
    - No schema changes or new sanitizer framework.
    required_validation:
    - ONTOINDEX_AUTO_WORKSPACE=1 ONTOINDEX_TEST_WORKERS=1 node node_modules/vitest/vitest.mjs run --maxWorkers=1 --no-file-parallelism test/integration/mcp-diagnostic-privacy-sdk.test.ts
    - git diff --check
    expected_evidence:
    - Synthetic credential and source markers do not escape failure diagnostics; error codes and missing capability facts remain accurate.
    rollback:
    - Revert only scoped corrections and regressions.
    stop_conditions:
    - Unresolved ownership or concurrent write conflict.
    known_blockers: []
    closeout:
      role_results:
        coder-worker: null
        coder-worker-test-challenger: null
      main_session_evidence:
        authorized_by: user
        authorization_ref: Explicit direct-session execution override and proceed.
        validation_summary: Fresh combined privacy validation 2026-10-19 passes326/326 across six files exit0 in11.35s with AUTO_WORKSPACE=1; SDK internally covers both flags and response modes. Current hashes and independent review recorded in audit. git diff --check exit0.
    dod_status: pass
  IQ-9PV:
    title: Real SDK workspace search labels unsupported vector retrieval
    status: DONE
    classification: implementation-ready
    assurance_profile: full
    complexity: complex
    depends_on:
    - IQ-9
    type: test
    validation_tier: unit-fast
    impact_risk: medium
    owner_files:
    - ontoindex/test/integration/mcp-workspace-vector-sdk.test.ts
    allowed_write_set:
    - ontoindex/test/integration/mcp-workspace-vector-sdk.test.ts
    non_goals:
    - No production seams or provider calls or fake preparation results.
    required_validation:
    - ONTOINDEX_AUTO_WORKSPACE=1 ONTOINDEX_TEST_WORKERS=1 node node_modules/vitest/vitest.mjs run --maxWorkers=1 --no-file-parallelism test/integration/mcp-workspace-vector-sdk.test.ts
    - git diff --check
    expected_evidence:
    - Native workspace search returns dirty-only symbol and explicit full-text-only warning; no vector request; symbol-neighborhood warning when requested.
    rollback:
    - Remove only this fixture.
    stop_conditions:
    - Native failure or need for production change requires separate bounded correction.
    known_blockers: []
    closeout:
      role_results:
        coder-worker: null
        coder-worker-test-challenger: null
      main_session_evidence:
        authorized_by: user
        authorization_ref: Explicit direct-session execution override and proceed.
        validation_summary: Native SDK2/2 exit0 in4.88s; dirty-only symbol and vector/policy warnings verified; no semantic or embedding calls. Hash107a7c57fb2b080b2f418971b4f2cbdf683cc2d4d6f5ea8ffe26d87ea595f6b4. Bounded graph verification PASS; diff check0.
    dod_status: pass
  IQ-9PC:
    title: Real SDK cancellation preserves shared preparation and generation pins
    status: DONE
    classification: implementation-ready
    assurance_profile: full
    complexity: complex
    depends_on:
    - IQ-9
    type: test
    validation_tier: unit-fast
    impact_risk: medium
    owner_files:
    - ontoindex/test/integration/mcp-workspace-cancellation-sdk.test.ts
    allowed_write_set:
    - ontoindex/test/integration/mcp-workspace-cancellation-sdk.test.ts
    non_goals:
    - No production seams or provider calls or fake preparation results.
    required_validation:
    - ONTOINDEX_AUTO_WORKSPACE=1 ONTOINDEX_TEST_WORKERS=1 node node_modules/vitest/vitest.mjs run --maxWorkers=1 --no-file-parallelism test/integration/mcp-workspace-cancellation-sdk.test.ts
    - git diff --check
    expected_evidence:
    - Cancelled server waiter settles independently; survivor completes shared preparation once; real generation reader marker remains until handler settles and then is removed.
    rollback:
    - Remove only this fixture.
    stop_conditions:
    - Native failure or need for production change requires separate bounded correction.
    known_blockers: []
    closeout:
      role_results:
        coder-worker: null
        coder-worker-test-challenger: null
      main_session_evidence:
        authorized_by: user
        authorization_ref: Explicit direct-session execution override and proceed.
        validation_summary: Native SDK2/2 exit0 in5.16s; cancelled server waiter exits independently and survivor completes one actual shared build; real reader marker persists through abort until handler settles. Hash49ac1bdc44c8b107fe65210655c8ca526b6ea7f09819aa25e134b3dbce031e7c. Bounded graph verification PASS; diff check0.
    dod_status: pass
  IQ-10:
    title: Accept one discriminating pilot and instrument fixes before performance work
    status: DONE
    classification: architecture-paperwork
    assurance_profile: full
    complexity: complex
    depends_on:
    - IQ-9
    type: design-gate
    validation_tier: unit-fast
    impact_risk: medium
    owner_files:
    - ontoindex/scripts/overlay-benchmark.mjs
    - ontoindex/scripts/overlay-benchmark-automatic.mjs
    - ontoindex/test/unit/overlay-benchmark-automatic.test.ts
    - .memory-bank/ADR_AUTOMATIC_DIRTY_WORKSPACE.md
    - .memory-bank/ADW_INDEPENDENT_REVIEW_IMPLEMENTATION_PLAN.md
    - .memory-bank/ADW_INDEPENDENT_REVIEW_AUDIT.md
    allowed_write_set:
    - .memory-bank/ADW_INDEPENDENT_REVIEW_IMPLEMENTATION_PLAN.md
    - .memory-bank/ADW_INDEPENDENT_REVIEW_AUDIT.md
    non_goals:
    - No ADW lease/status edits, default activation, release, provider calls, new service or unrelated changes.
    required_validation:
    - ONTOINDEX_AUTO_WORKSPACE=0 ONTOINDEX_TEST_WORKERS=1 node node_modules/vitest/vitest.mjs run --maxWorkers=1 --no-file-parallelism test/unit/overlay-benchmark-automatic.test.ts test/unit/overlay-benchmark-stats.test.ts
    - git diff --check
    expected_evidence:
    - Check benchmark help and existing CLI options before pilot; preserve failing pilot and same-byte full-reference added-caller oracle.
    - Confirm terminal user/system process-tree CPU accounting; current sampled warm CPU cannot prove <=1 CPU-second. Insert a bounded instrument task if absent; no matrix until accepted.
    - Evaluate measured cross-file yield/query reuse/parse reuse only after attribution. Any optimization gets a separate exact write set, graph-equivalence regression and fresh candidate identity; never relax 55-second budget.
    rollback:
    - Revert only this packet; preserve pre-existing dirty changes, live owners and retained failure evidence.
    stop_conditions:
    - Acquire the single validation lane before executable checks; stop on conflicting ownership or changing frozen inputs.
    - Obtain OntoIndex impact before source edits; stop for a bounded manager decision when scope or contract is unresolved.
    known_blockers: []
    closeout:
      role_results:
        coder-manager: null
      main_session_evidence:
        authorized_by: user
        authorization_ref: Direct-session execution override and proceed open tasks.
        validation_summary: Final native instrument154/154 exit0; resolver147/147 exit0; native build0; cold41601ms warm537ms and0.720609CPU-s all budgets pass; added-caller parity41840ms exit0. Failed pilots retained; candidate-pass-cache.json and artifact hashes in audit; diff check0.
    dod_status: pass
  IQ-10C:
    title: Strict cgroup CPU deltas reject incomplete or decreasing counters
    status: DONE
    classification: implementation-ready
    assurance_profile: full
    complexity: standard
    depends_on:
    - IQ-9
    type: code
    validation_tier: unit-fast
    impact_risk: medium
    owner_files:
    - ontoindex/scripts/overlay-benchmark-stats.mjs
    - ontoindex/test/unit/overlay-benchmark-stats.test.ts
    allowed_write_set:
    - ontoindex/scripts/overlay-benchmark-stats.mjs
    - ontoindex/test/unit/overlay-benchmark-stats.test.ts
    non_goals:
    - No delegation changes or performance matrix or provenance relaxation.
    required_validation:
    - ONTOINDEX_AUTO_WORKSPACE=0 ONTOINDEX_TEST_WORKERS=1 node node_modules/vitest/vitest.mjs run --maxWorkers=1 --no-file-parallelism test/unit/overlay-benchmark-stats.test.ts
    - git diff --check
    expected_evidence:
    - Strict parse and component deltas exclude baseline and reject malformed duplicate unsafe or decreasing counters.
    rollback:
    - Revert only this bounded packet.
    stop_conditions:
    - Unresolved measurement ownership or missing host capability.
    known_blockers: []
    closeout:
      role_results:
        coder-worker: null
        coder-worker-test-challenger: null
      main_session_evidence:
        authorized_by: user
        authorization_ref: Explicit direct-session execution override and proceed.
        validation_summary: Native stats106/106 and combined123/123 exit0; strict parser and component regression tests pass; diff check0. Hashes in audit2026-10-19.
    focused_validation: ONTOINDEX_AUTO_WORKSPACE=0 ONTOINDEX_TEST_WORKERS=1 node node_modules/vitest/vitest.mjs run --maxWorkers=1 --no-file-parallelism test/unit/overlay-benchmark-stats.test.ts
    validation_evidence: Native106/106 exit0; combined native123/123 exit0; diff check0; hashes recorded in audit2026-10-19.
    dod_status: pass
  IQ-10I:
    title: Freeze delegated cgroup interval instrumentation and native descendant proof
    status: DONE
    classification: architecture-paperwork
    assurance_profile: full
    complexity: standard
    depends_on:
    - IQ-9
    type: design-gate
    validation_tier: unit-fast
    impact_risk: medium
    owner_files:
    - .memory-bank/ADW_INDEPENDENT_REVIEW_IMPLEMENTATION_PLAN.md
    - .memory-bank/ADW_INDEPENDENT_REVIEW_AUDIT.md
    allowed_write_set:
    - .memory-bank/ADW_INDEPENDENT_REVIEW_IMPLEMENTATION_PLAN.md
    - .memory-bank/ADW_INDEPENDENT_REVIEW_AUDIT.md
    non_goals:
    - No delegation changes or performance matrix or provenance relaxation.
    required_validation:
    - git diff --check
    expected_evidence:
    - Exclusive delegated scope and before-exec membership required; native barriers must exclude preparation and retain exited descendants; no sampled or lifetime substitution.
    rollback:
    - Revert only this bounded packet.
    stop_conditions:
    - Unresolved measurement ownership or missing host capability.
    known_blockers: []
    closeout:
      role_results:
        coder-manager: null
      main_session_evidence:
        authorized_by: user
        authorization_ref: Explicit direct-session execution override and proceed.
        validation_summary: Final native instrument154/154 exit0; ADR accepts baseline through empty-scope final CPU including shutdown. Fresh cold41601ms warm537ms and0.720609CPU-s pass; parity41840ms exit0. Hashes and retained failures in audit; git diff --check0.
    dod_status: pass
  IQ-10W:
    title: Benchmark cgroup placement and request interval capture fail closed
    status: DONE
    classification: implementation-ready
    assurance_profile: full
    complexity: complex
    depends_on:
    - IQ-9
    type: code
    validation_tier: unit-fast
    impact_risk: medium
    owner_files:
    - ontoindex/scripts/overlay-benchmark-automatic.mjs
    - ontoindex/test/unit/overlay-benchmark-automatic.test.ts
    allowed_write_set:
    - ontoindex/scripts/overlay-benchmark-automatic.mjs
    - ontoindex/test/unit/overlay-benchmark-automatic.test.ts
    non_goals:
    - No host delegation changes or matrix or runtime source changes.
    required_validation:
    - ONTOINDEX_AUTO_WORKSPACE=0 ONTOINDEX_TEST_WORKERS=1 node node_modules/vitest/vitest.mjs run --maxWorkers=1 --no-file-parallelism test/unit/overlay-benchmark-automatic.test.ts test/unit/overlay-benchmark-stats.test.ts
    - git diff --check
    expected_evidence:
    - Fresh cgroup leaf entered before exec; warm baseline after preparation through empty-scope final snapshot including shutdown CPU per ADR disposition; native descendant proof or explicitly unqualified provenance; cleanup only owned empty leaf.
    rollback:
    - Revert only wiring and fixtures.
    stop_conditions:
    - Ownership uncertainty or native accounting mismatch.
    known_blockers: []
    closeout:
      role_results:
        coder-worker: null
        coder-worker-test-challenger: null
      main_session_evidence:
        authorized_by: user
        authorization_ref: Explicit direct-session execution override and proceed.
        validation_summary: Final native instrument154/154 exit0; ADR accepts baseline through empty-scope final CPU including shutdown. Fresh cold41601ms warm537ms and0.720609CPU-s pass; parity41840ms exit0. Hashes and retained failures in audit; git diff --check0.
    dod_status: pass
  IQ-11A:
    title: Frozen candidate passes one build and serialized flag-off full suite
    status: OPEN
    classification: proof-only
    assurance_profile: full
    complexity: complex
    depends_on:
    - IQ-7
    - IQ-9
    - IQ-10
    - IQ-10C
    - IQ-10I
    - IQ-10W
    - IQ-6
    - IQ-6D
    - IQ-9M
    - IQ-9G
    - IQ-9GQ
    - IQ-9GB
    - IQ-9GS
    - IQ-9CL
    - IQ-9CD
    - IQ-9CS
    - IQ-9C
    - IQ-9R
    - IQ-9RD
    - IQ-9RS
    - IQ-9P
    - IQ-9PI
    - IQ-9PE
    - IQ-9PD
    - IQ-9PW
    - IQ-9PS
    - IQ-9PV
    - IQ-9PC
    type: proof
    validation_tier: unit-fast
    impact_risk: medium
    owner_files:
    - ontoindex/test/integration/automatic-dirty-workspace.test.ts
    - .memory-bank/ADW_INDEPENDENT_REVIEW_IMPLEMENTATION_PLAN.md
    - .memory-bank/ADW_INDEPENDENT_REVIEW_AUDIT.md
    allowed_write_set:
    - .memory-bank/ADW_INDEPENDENT_REVIEW_IMPLEMENTATION_PLAN.md
    - .memory-bank/ADW_INDEPENDENT_REVIEW_AUDIT.md
    non_goals:
    - No ADW lease/status edits, default activation, release, provider calls, new service or unrelated changes.
    required_validation:
    - ONTOINDEX_SKIP_EXT_FETCH=1 ONTOINDEX_TEST_WORKERS=1 node scripts/build.js
    - ONTOINDEX_AUTO_WORKSPACE=0 ONTOINDEX_TEST_WORKERS=1 node node_modules/vitest/vitest.mjs run --maxWorkers=1 --no-file-parallelism
    - git diff --check
    expected_evidence:
    - Verify corrective tasks inserted by IQ-7/IQ-9 and instrument tasks by IQ-10 are dependencies and accepted before launch; record frozen input hashes.
    - Run one build, then the full flag-off suite serially with global setup, one worker and no file parallelism; retain stdout/stderr, exit, skips and unhandled/native diagnostics. No subset/retry substitutes for full-suite success.
    rollback:
    - Revert only this packet; preserve pre-existing dirty changes, live owners and retained failure evidence.
    stop_conditions:
    - Acquire the single validation lane before executable checks; stop on conflicting ownership or changing frozen inputs.
    - Obtain OntoIndex impact before source edits; stop for a bounded manager decision when scope or contract is unresolved.
    known_blockers: []
  IQ-11B:
    title: Same frozen build passes serialized flag-on full suite
    status: OPEN
    classification: proof-only
    assurance_profile: full
    complexity: complex
    depends_on:
    - IQ-11A
    type: proof
    validation_tier: unit-fast
    impact_risk: medium
    owner_files:
    - ontoindex/test/integration/automatic-dirty-workspace.test.ts
    - .memory-bank/ADW_INDEPENDENT_REVIEW_IMPLEMENTATION_PLAN.md
    - .memory-bank/ADW_INDEPENDENT_REVIEW_AUDIT.md
    allowed_write_set:
    - .memory-bank/ADW_INDEPENDENT_REVIEW_IMPLEMENTATION_PLAN.md
    - .memory-bank/ADW_INDEPENDENT_REVIEW_AUDIT.md
    non_goals:
    - No ADW lease/status edits, default activation, release, provider calls, new service or unrelated changes.
    required_validation:
    - ONTOINDEX_AUTO_WORKSPACE=1 ONTOINDEX_TEST_WORKERS=1 node node_modules/vitest/vitest.mjs run --maxWorkers=1 --no-file-parallelism
    - git diff --check
    expected_evidence:
    - Reuse the IQ-11A build on identical frozen input hashes; any input change refreezes and reruns IQ-11A first.
    - Run the full flag-on suite serially; retain stdout/stderr, exit, skips and unhandled/native diagnostics. No subset/retry substitutes for full-suite success.
    rollback:
    - Revert only this packet; preserve pre-existing dirty changes, live owners and retained failure evidence.
    stop_conditions:
    - Acquire the single validation lane before executable checks; stop on conflicting ownership or changing frozen inputs.
    - Obtain OntoIndex impact before source edits; stop for a bounded manager decision when scope or contract is unresolved.
    known_blockers: []
  IQ-11:
    title: Real SDK route proof and full-analysis parity adjudicate flag-off and flag-on qualification
    status: OPEN
    classification: proof-only
    assurance_profile: full
    complexity: complex
    depends_on:
    - IQ-11B
    type: proof
    validation_tier: unit-fast
    impact_risk: medium
    owner_files:
    - ontoindex/test/integration/automatic-dirty-workspace.test.ts
    - ontoindex/test/integration/workspace-graph-snapshot.test.ts
    - ontoindex/test/integration/workspace-graph-search.test.ts
    - ontoindex/test/integration/lbug-pool-generation-swap.test.ts
    - .memory-bank/ADW_INDEPENDENT_REVIEW_IMPLEMENTATION_PLAN.md
    - .memory-bank/ADW_INDEPENDENT_REVIEW_AUDIT.md
    allowed_write_set:
    - .memory-bank/ADW_INDEPENDENT_REVIEW_IMPLEMENTATION_PLAN.md
    - .memory-bank/ADW_INDEPENDENT_REVIEW_AUDIT.md
    non_goals:
    - No ADW lease/status edits, default activation, release, provider calls, new service or unrelated changes.
    required_validation:
    - ONTOINDEX_AUTO_WORKSPACE=1 ONTOINDEX_TEST_WORKERS=1 node node_modules/vitest/vitest.mjs run --maxWorkers=1 --no-file-parallelism test/integration/automatic-dirty-workspace.test.ts test/integration/workspace-graph-snapshot.test.ts test/integration/workspace-graph-search.test.ts test/integration/lbug-pool-generation-swap.test.ts
    - git diff --check
    expected_evidence:
    - Run real SDK clean/modified/added/deleted/rename/import/config/parse-error routes; reuse/second edit, waiter cancellation, contention, pins, shutdown and pagination; retain request/response identity and no unnecessary clean build.
    - Compare full-analysis reference against identical bytes with added caller and deleted edge; assert route support honestly, including unsupported vector/group cases.
    - Adjudicate IQ-11A/IQ-11B receipts; any failure routes to a bounded correction task and refreezes both suites.
    rollback:
    - Revert only this packet; preserve pre-existing dirty changes, live owners and retained failure evidence.
    stop_conditions:
    - Acquire the single validation lane before executable checks; stop on conflicting ownership or changing frozen inputs.
    - Obtain OntoIndex impact before source edits; stop for a bounded manager decision when scope or contract is unresolved.
    known_blockers: []
  IQ-12A:
    title: Pilot and one-repetition functional sweep pass on frozen inputs
    status: OPEN
    classification: implementation-ready
    assurance_profile: full
    complexity: complex
    depends_on:
    - IQ-11
    type: measurement
    validation_tier: integration
    impact_risk: medium
    owner_files:
    - ontoindex/scripts/overlay-benchmark-automatic.mjs
    - .memory-bank/ADW_INDEPENDENT_REVIEW_IMPLEMENTATION_PLAN.md
    - .memory-bank/ADW_INDEPENDENT_REVIEW_AUDIT.md
    allowed_write_set:
    - .memory-bank/ADW_INDEPENDENT_REVIEW_IMPLEMENTATION_PLAN.md
    - .memory-bank/ADW_INDEPENDENT_REVIEW_AUDIT.md
    non_goals:
    - No ADW lease/status edits, default activation, release, provider calls, new service or unrelated changes.
    required_validation:
    - node scripts/overlay-benchmark.mjs --automatic --help
    - node scripts/overlay-benchmark.mjs --automatic --pilot --output ../.ontoindex/adw-validation/independent-pilot.json
    - node scripts/overlay-benchmark.mjs --automatic --sizes 0,1,50,51 --extras config,contention,parity --repetitions 1 --output ../.ontoindex/adw-validation/independent-functional.json
    - git diff --check
    expected_evidence:
    - Successful retained pilot gates the functional sweep; stop and diagnose at the first invalid gate and preserve failed evidence.
    - A one-repetition sweep is functional evidence only; record runtime/input hashes that IQ-12 must reuse unchanged.
    rollback:
    - Revert only this packet; preserve pre-existing dirty changes, live owners and retained failure evidence.
    stop_conditions:
    - Acquire the single validation lane before executable checks; stop on conflicting ownership or changing frozen inputs.
    - Obtain OntoIndex impact before source edits; stop for a bounded manager decision when scope or contract is unresolved.
    known_blockers: []
  IQ-12:
    title: Twenty-repetition matrix meets unchanged latency CPU memory and cleanup budgets
    status: OPEN
    classification: implementation-ready
    assurance_profile: full
    complexity: complex
    depends_on:
    - IQ-12A
    type: measurement
    validation_tier: integration
    impact_risk: medium
    owner_files:
    - ontoindex/scripts/overlay-benchmark-automatic.mjs
    - .memory-bank/ADR_AUTOMATIC_DIRTY_WORKSPACE.md
    - .memory-bank/ADW_INDEPENDENT_REVIEW_IMPLEMENTATION_PLAN.md
    - .memory-bank/ADW_INDEPENDENT_REVIEW_AUDIT.md
    allowed_write_set:
    - .memory-bank/ADW_INDEPENDENT_REVIEW_IMPLEMENTATION_PLAN.md
    - .memory-bank/ADW_INDEPENDENT_REVIEW_AUDIT.md
    non_goals:
    - No ADW lease/status edits, default activation, release, provider calls, new service or unrelated changes.
    required_validation:
    - node scripts/overlay-benchmark.mjs --automatic --sizes 0,1,50,51 --extras config,contention,parity --repetitions 20 --output ../.ontoindex/adw-validation/independent-matrix.json
    - git diff --check
    expected_evidence:
    - Retain median/p95, terminal CPU, sampled process-tree peak RSS with sampling gaps, artifact bytes, build counts, cleanup, hardware/load and complete runtime/input hashes.
    - Pass warm p95 <=1s, dirty cold p95 <=55s, RSS <=4GiB, cold CPU <=300s, warm CPU <=1s, artifacts <=2GiB/repo, cleanup <=5s; zero clean/unchanged-warm builds, one contending writer.
    - If fixes follow any failure, refreeze and rerun impacted proof and final full suites before the new matrix.
    rollback:
    - Revert only this packet; preserve pre-existing dirty changes, live owners and retained failure evidence.
    stop_conditions:
    - Acquire the single validation lane before executable checks; stop on conflicting ownership or changing frozen inputs.
    - Obtain OntoIndex impact before source edits; stop for a bounded manager decision when scope or contract is unresolved.
    known_blockers: []
  IQ-13A:
    title: Record accepted contract coverage and residual risk for the existing Ontocode MCP owner
    status: OPEN
    classification: architecture-paperwork
    assurance_profile: full
    complexity: complex
    depends_on:
    - IQ-12
    type: closeout
    validation_tier: unit-fast
    impact_risk: medium
    owner_files:
    - .memory-bank/ADW_INDEPENDENT_REVIEW_IMPLEMENTATION_PLAN.md
    - .memory-bank/ADW_INDEPENDENT_REVIEW_AUDIT.md
    - .memory-bank/AUTOMATIC_DIRTY_WORKSPACE_PROJECT_PLAN.md
    allowed_write_set:
    - .memory-bank/ADW_INDEPENDENT_REVIEW_IMPLEMENTATION_PLAN.md
    - .memory-bank/ADW_INDEPENDENT_REVIEW_AUDIT.md
    non_goals:
    - No ADW lease/status edits, default activation, release, provider calls, new service or unrelated changes.
    required_validation:
    - git diff --check
    expected_evidence:
    - Publish a compact accepted contract/coverage and residual-risk record; external implementation remains a separate inspected scope.
    - Require original-parent authenticated ADW acceptance before default activation/release readiness; independent qualification never closes the stranded ADW-2 lease.
    rollback:
    - Revert only this packet; preserve pre-existing dirty changes, live owners and retained failure evidence.
    stop_conditions:
    - Acquire the single validation lane before executable checks; stop on conflicting ownership or changing frozen inputs.
    - Obtain OntoIndex impact before source edits; stop for a bounded manager decision when scope or contract is unresolved.
    known_blockers: []
  IQ-13:
    title: Close out routers with final manager state while preserving ADW acceptance and opt-in boundaries
    status: OPEN
    classification: architecture-paperwork
    assurance_profile: full
    complexity: complex
    depends_on:
    - IQ-13A
    type: closeout
    validation_tier: unit-fast
    impact_risk: medium
    owner_files:
    - .memory-bank/ADW_INDEPENDENT_REVIEW_IMPLEMENTATION_PLAN.md
    - .memory-bank/ADW_INDEPENDENT_REVIEW_AUDIT.md
    - .memory-bank/MEMORY.md
    - .memory-bank/project_plan-current.md
    - .memory-bank/project_pending-tasks.md
    allowed_write_set:
    - .memory-bank/ADW_INDEPENDENT_REVIEW_IMPLEMENTATION_PLAN.md
    - .memory-bank/ADW_INDEPENDENT_REVIEW_AUDIT.md
    - .memory-bank/MEMORY.md
    - .memory-bank/project_plan-current.md
    - .memory-bank/project_pending-tasks.md
    non_goals:
    - No ADW lease/status edits, default activation, release, provider calls, new service or unrelated changes.
    required_validation:
    - git diff --check
    expected_evidence:
    - Update router lines to point at the IQ-13A record; report manager status, exact terminal validation exits and blockers.
    - No product default switch or publication in this plan.
    rollback:
    - Revert only this packet; preserve pre-existing dirty changes, live owners and retained failure evidence.
    stop_conditions:
    - Acquire the single validation lane before executable checks; stop on conflicting ownership or changing frozen inputs.
    - Obtain OntoIndex impact before source edits; stop for a bounded manager decision when scope or contract is unresolved.
    known_blockers: []
```

## Required Traceability

| Requirement ID | ADR/user requirement | Disposition | Task IDs | Validation |
| --- | --- | --- | --- | --- |
| EVIDENCE | Build provenance, lane overlap, missing suite receipts; accepted IQ-0 above | implementation | IQ-11A, IQ-11B, IQ-11 | Frozen inputs, actual receipts, serial final suites |
| F1 | Inherited NODE_OPTIONS overwritten | implementation | IQ-1 | Actual child preload marker and stderr |
| F2 | Global unhandled-error suppression | implementation | IQ-2 | Injected rejection must fail child Vitest |
| H4 | Setup waiter timeout and unconditional INSTALL | implementation | IQ-3 | Offline local loader and bounded native settlement |
| H1 | Surviving writer admission | implementation | IQ-4F, IQ-4, IQ-7 | Next writer blocked, live artifacts preserved |
| H2 | Ancestor-symlink ABA | proof-only | IQ-5, IQ-7 | Controlled descriptor race and no outside capture |
| H3 | Recovery sentinel death | proof-only | IQ-6N, IQ-6D, IQ-6P, IQ-6R, IQ-6F, IQ-6, IQ-7 | Two successor processes, one writer, bounded recovery |
| P0-1 | Per-route capability discovery | compatibility-test | IQ-8, IQ-9, IQ-11 | Flag-off/on route matrix; ADW-4a/5a/6b |
| P0-2 | Consistent provenance envelope | compatibility-test | IQ-8, IQ-9, IQ-11 | Mutation/parse identity; ADW-2b/2c/5/6b |
| P0-3 | Structured errors and retry advice | compatibility-test | IQ-8, IQ-9, IQ-11 | Stable codes and diagnostics; ADW-3b/5a/6b |
| P0-4 | Request generation consistency | compatibility-test | IQ-8, IQ-9, IQ-11 | Pins/edit/cancel/expiry; ADW-5/5a/5b |
| P1-1 | Coalescing and bounded progress | compatibility-test | IQ-8, IQ-9, IQ-11 | Shared generation, independent waiters; ADW-3/3b/6 |
| P1-2 | Explicit read preference/fail-closed relationships | compatibility-test | IQ-8, IQ-9, IQ-11 | Existing policy inventory first; ADW-4a/5a/5e |
| P1-3 | Dirty search/context/impact consistency | compatibility-test | IQ-8, IQ-11 | SDK mutation/full-analysis oracle; ADW-5d/5e/7e |
| P1-4 | Group member provenance | compatibility-test | IQ-8, IQ-9, IQ-11 | Two-member mixed states; gap-specific packet if absent |
| P1-5 | Identity-aware pagination/cache reuse | compatibility-test | IQ-8, IQ-9, IQ-11 | Edit between pages and shaping keys; ADW-5c/5h/5i |
| P2-1 | Compact timing/reuse diagnostics | compatibility-test | IQ-8, IQ-10 | Boundaries/privacy; ADW-6c/7c |
| P2-2 | Offline integration qualification | proof-only | IQ-3, IQ-10, IQ-11A, IQ-11B, IQ-11, IQ-12A, IQ-12 | Pilot, final suites, repeated matrix; ADW-7d/7e/7f |
| ROUTE-GAPS | Group provenance, logical cursor identity, committed discovery and envelope qualification | architecture-gate | IQ-9G, IQ-9C, IQ-9R, IQ-9P | Bounded reproductions, frozen corrections and flag-on SDK proof |
| GROUP-PROOF | Preserve member metadata and distinguish boundary tests from actual workspace analysis | implementation | IQ-9GQ, IQ-9GB, IQ-9GS | Aggregator regressions, real SDK exchange and separate real producer proof |
| CURSOR-BINDING | Reject logical dataset drift without altering byte replay | implementation | IQ-9CL, IQ-9CD, IQ-9CS, IQ-9C | Bound primitive regression, docs integration and flag-on SDK proof |
| COMMITTED-DISCOVERY | Resource and lazy graph descriptions state committed-index scope | implementation | IQ-9R, IQ-9RD, IQ-9RS | Description assertions and SDK flag matrix |
| CPU-WIRING | Isolated native request CPU accounting | implementation | IQ-10W | Native scope placement and counter discrimination |
| CPU-INSTRUMENT | Interval counter primitive and delegated native proof | implementation | IQ-10C, IQ-10I | Strict regression and native qualification |
| VECTOR-CANCEL | Workspace vector warning and waiter/pin ownership | compatibility-test | IQ-9PV, IQ-9PC | Real native SDK fixtures |
| DIAGNOSTIC-PRIVACY | Bounded producer failures and SDK privacy | implementation | IQ-9PD, IQ-9PW, IQ-9PS | Controlled failures and SDK flag matrix |
| IDENTITY-PRIVACY | Unknown identity and endpoint diagnostic redaction | implementation | IQ-9P, IQ-9PI, IQ-9PE | Tri-state and legacy/envelope regressions |
| MODULE | Avoid unused File materialization while preserving module response | implementation | IQ-9M | Scalar-row regression and ordered native integration |
| PERF | Cross-file optimization only after attribution | architecture-gate | IQ-10, IQ-12 | Graph equivalence and unchanged budgets |
| ADOPT | Ontocode capability-aware consumption | architecture-gate | IQ-13A, IQ-13 | Separate external owner inspection; ADW-8 through 8c |
| DEFAULT | Default switch and release publication | non-goal | IQ-13A, IQ-13 | Existing authenticated ADW gates retained |


Fixture authoring tasks IQ-4F/IQ-5F/IQ-6F implement H1/H2/H3 fixtures; corresponding proof tasks depend on their acceptance. Run package commands with runner workdir /opt/d1/_wrk/ontoindex/ontoindex.

## Conditional Repair Branches

- Reproduced: IQ-7 inserts bounded correction tasks for each confirmed hypothesis and adds them as dependencies of IQ-11. Qualification waits for accepted fixes and passing regressions.
- not-reproduced: IQ-7 records exact tested schedules and limits, retains the fixture, and permits IQ-11 only when no unresolved unsafe condition remains. Failure to reproduce is not proof of universal safety.
- Unresolved: IQ-7 records the exact missing capability or evidence and a bounded correction/design task. IQ-11 remains blocked until the correction and independent success proof pass.

## Consolidated review and next execution — 2026-10-19

Good: native descendant accounting and cleanup, actual SDK boundaries, retained
candidate hashes,39.78s cold pilot and added-caller parity with zero differences.
Weakest: evidence closeout lags implementation; repeated instrument-only work
left recovery and allocation failures unresolved. Single samples do not qualify
shipping percentiles. Forgotten: label-only CPU acceptance, unsafe huge
repetition counts, and same-user cgroup replacement limitations.

Selected after two reviews: validate CPU interval evidence against sample CPU
and summary p95 using existing counters. Relabel-only acceptance and lifetime
GNU-time substitution rejected. Keep terminal provenance and1CPU-second gates.
Two sol-medium developers own disjoint stats source/test files; main session
wires existing callers. Next: one real cold/warm proof; adjudicate CPU semantics;
close C/I/W with manager transitions; resolve IQ-6D/F recovery and IQ-9M native
allocation; reconcile IQ-9GQ/GS; serialized final flag-off/on qualification;
20-repetition matrix; original ADW acceptance and release gates. No optimization
before attribution or regression proof. Repetition overflow receives a bounded
follow-up; hostile same-user containment remains outside current measurement.

## Closeout

Qualification and corrective implementation are accepted in the closed continuation tracker and the dated handoff below. Original task receipts remain historical authority; this summary does not rewrite their state.


## Direct session execution override

The user explicitly requested removal of CDR ceremony and execution in this
session. No new CDR roles, dispatch leases or acceptance receipts are required.
Historical receipts remain immutable evidence. Direct-session state below and
validation in the audit supersede automated routing for this iteration.

1. IQ-8 inventory complete; qualify source inventory only.
2. Fix public error metadata by additive bounded serialization in server.ts;
   preserve existing retry policy and unknown-error compatibility.
3. Propagate request cancellation through existing context and waiter owner;
   independently cancelled waiters must not cancel shared builds.
4. Run focused boundary/lifecycle and benchmark-instrument unit suites serially.
5. IQ-5 finite containment schedules are accepted. Keep IQ-6 crash recovery
   proof unresolved; defensive design changes require their own evidence.
   IQ-7/9 adjudication may record partial decisions without qualifying IQ-6.
6. IQ-10 pilot/terminal CPU instrument acceptance gates IQ-11 final flag-off/on
   qualification and IQ-12 repeated performance. No matrix before those gates.
7. IQ-13 handoff retains original ADW-2 acceptance and opt-in/default boundaries.

Selected fixes reuse current formatter, request context, waiter and pin owners;
no new error protocol, coordinator or dependencies. Timeout-based sentinel
deletion is rejected because it may displace a live slow owner.

## Qualified integration handoff — 2026-10-20

Independent qualification is accepted for the existing opt-in automatic
workspace owner. Retain request cancellation, shared-build waiter isolation,
generation pins, shutdown, pagination and additive retryable-error metadata.
Mutation and same-byte parity checks include added callers and deleted edges;
unsupported vector/group routes remain explicit rather than implied coverage.
No external Ontocode implementation, default activation or release is included.

Evidence: `.ontoindex/adw-validation/qualification-20261020-retry-r1/`.
Build, full flag-off, full flag-on, pilot, functional sweep and20-repetition
matrix each exited0. Both suites passed661 files and11891 tests, with one
expected failure and315 skipped tests. Matrix self-check and all12 workload
budget verdicts passed. Candidate4662 and dependency12734 frozen paths remained
unchanged. Matrix SHA256:
3340913e92882cbd563edf9c4ef20bfe077716aa26009aae9e00ed26ac7ce3a6.

Worst workload warm p95:619.23ms; cold p95:34831.01ms; sampled RSS maximum:
2974216192bytes. Warm/clean builds remain0. RSS sampling can miss peaks,
OS caches were not flushed, installed inputs do not cover every OS library,
and contention checks generation count rather than observing lock exclusivity.
Retain complete CPU, cleanup, artifact, hardware/load and sampling-gap records
in the matrix JSON. Deliberate native-close, tarball and WAL fixture diagnostics
remain in full-suite logs; skipped/unsupported routes are not certified.

Original-parent authenticated ADW-2 acceptance remains mandatory before
default activation or release readiness. This handoff does not alter its
stranded lease or replace its receipt. RT-5 closeout is separately outstanding.
