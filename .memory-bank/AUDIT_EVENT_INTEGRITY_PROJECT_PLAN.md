# Audit Event Integrity Project Plan

Date: 2026-08-11
Status: Open tracking plan
Audience: coder-manager and coder-* sub-agents (sub-agent dispatch mode)
Authority: `ADR_SEMANTICA_EVIDENCE_AND_GOVERNANCE_ADOPTION.md`, section 3.
This tracking file governs execution; the ADR governs the decision.

## Manager Tracking

```yaml
manager_loop:
  status: closed
  active_next_task: null
  selected_task: null
  no_selected_task_reason: all tasks DONE
  last_decision:
    outcome: completed
    label: TASK-5
    reason: "A second review found TASK-4 incomplete. Stripping every integrity envelope and declaring schemaVersion 1 produced LEGACY_UNVERIFIED, and one ordinary append then re-signed the tampered history as dispatchable VALID_WITH_LEGACY_PREFIX. TASK-5 removes in-place migration entirely: legacy stores are read-only, dispatch requires a fully verified chain, and acknowledged reset accepts LEGACY_UNVERIFIED so operators have a safe exit."
    planning_work_considered: true
    reopen_gate: "Reopen if any write path can convert unverified history into a dispatchable status, or if an operator can reach a state that acknowledged reset refuses."
  closeout_state: complete
  dispatch_mode: sub-agent
  selection_policy: active_next_task-first
  auto_continue: until-stop-condition
  dispatch_preflight:
    tool_surface: unchecked
    child_capability_probes: {}
    required_roles:
      coder-architector:
        agent_type_candidates:
        - coder-architector
        local_fallback_allowed: false
        required_for:
        - dor-dod-adr-gate
        - readiness
        - closeout
      coder-worker:
        agent_type_candidates:
        - coder-worker
        local_fallback_allowed: false
        required_for:
        - implementation
      coder-worker-test-challenger:
        agent_type_candidates:
        - coder-worker-test-challenger
        local_fallback_allowed: false
        required_for:
        - verification
        - challenge
    fork_context: false
    unavailable_outcome: 'blocked: model/capacity'
  ontoindex:
    required: true
    status: review
    unavailable_action: direct-source-fallback
    tools_used:
    - gn_ensure_fresh(repo=ontoindex)
    - inspect(action=context, target=LocalAuditEventStore)
    - inspect(action=context, target=gnAuditExport)
    - inspect(action=context, target=gnAuditTombstoneCreate)
    - impact(action=symbol, target_uid=Method:ontoindex/src/core/audit-lifecycle/audit-event-store.ts:LocalAuditEventStore.appendEvent#2, direction=upstream, includeTests=true, maxDepth=3)
    - search(action=semantic, query="audit CLI command registration subcommands audit export replay lint")
    - ctx_compose audit CLI registration and source-owner verification
    limitations:
    - Graph authority is review because the untracked ADR and plan files change the source manifest; current source reads override graph metadata for exact line-level claims.
    - Embeddings are absent, so semantic retrieval is degraded; symbol and call-edge evidence used here remains available.
    - 'appendEvent impact is HIGH: 25 upstream nodes, 15 direct callers, 2 affected processes, and 3 affected modules. Every worker must rerun impact immediately before edits.'
    source_fallback:
    - ontoindex/src/core/audit-lifecycle/audit-event-store.ts
    - ontoindex/src/core/audit-lifecycle/audit-session.ts
    - ontoindex/src/core/audit-lifecycle/audit-projection.ts
    - ontoindex/src/mcp/super/audit-advanced.ts
    - ontoindex/src/mcp/super/audit-session-tools.ts
    - ontoindex/src/cli/audit.ts
    - ontoindex/src/cli/index.ts
    - ontoindex/test/unit/audit-event-store.test.ts
    - ontoindex/test/unit/audit-dispatch.test.ts
    - ontoindex/test/integration/audit-cli.test.ts
    fallback_evidence:
    - AuditEvent is the domain event union consumed by projections and 15 direct append callers; storage integrity fields must not become required AuditEventBase fields.
    - saveAuditEventStoreState normalizes the full state before each atomic rewrite; checksum input must be the persisted normalized event representation and normalization must be idempotent.
    - The existing update lock and atomic temp-file rename already serialize appends; no second lock or storage service is needed.
    - A v1 store cannot prove its pre-migration history. Migration may protect those bytes from the migration point forward but must report VALID_WITH_LEGACY_PREFIX, never VALID.
    - Re-checksumming a broken store would launder untrusted history. Recovery must archive the broken store and start a fresh empty chain that requires re-ingest.
  reopen_gate: null
tasks:
  TASK-1:
    title: Add v2 persisted integrity envelopes and compatibility migration
    status: DONE
    classification: implementation-ready
    dor_status: pass
    dod_status: pass
    depends_on: []
    owner: coder-worker
    reviewer: coder-worker-test-challenger
    type: code
    validation_tier: unit-fast
    owner_files:
    - ontoindex/src/core/audit-lifecycle/audit-event-store.ts
    - ontoindex/test/unit/audit-event-store.test.ts
    allowed_write_set:
    - ontoindex/src/core/audit-lifecycle/audit-event-store.ts
    - ontoindex/test/unit/audit-event-store.test.ts
    target_symbols:
    - LocalAuditEventStore.load
    - LocalAuditEventStore.appendEvent
    - loadAuditEventStoreState
    - saveAuditEventStoreState
    - normalizeAuditEventStoreState
    - normalizeAuditEvent
    - withAuditStoreUpdateLock
    - AUDIT_EVENT_STORE_SCHEMA_VERSION
    - AuditEventStoreState
    do_not_touch:
    - ontoindex/src/core/audit-lifecycle/audit-session.ts
    - ontoindex/src/core/audit-lifecycle/audit-projection.ts
    - ontoindex/src/core/audit-lifecycle/index.ts
    - ontoindex/src/mcp/**
    - ontoindex/src/cli/**
    non_goals:
    - Adding sequence/checksum fields to AuditEventBase or changing appendEvent callers.
    - Adding signatures, remote witnesses, an append-only filesystem, or a storage dependency.
    - Detecting rollback or deletion of a valid tail.
    - Re-checksumming a BROKEN store.
    - Changing projection semantics or output.
    source_evidence:
    - ontoindex/src/core/audit-lifecycle/audit-event-store.ts:23-154
    - ontoindex/src/core/audit-lifecycle/audit-event-store.ts:199-267
    - ontoindex/src/core/audit-lifecycle/audit-event-store.ts:270-360
    - ontoindex/src/core/audit-lifecycle/audit-event-store.ts:482-583
    - ontoindex/src/core/audit-lifecycle/audit-session.ts:202-219
    - ontoindex/src/core/audit-lifecycle/audit-session.ts:270-274
    - ontoindex/test/unit/audit-event-store.test.ts:55-307
    - 'OntoIndex impact: appendEvent HIGH, 25 upstream nodes / 15 direct callers / 2 processes / 3 modules.'
    readiness_gaps: []
    gap_resolution_task: null
    gap_disposition: not-applicable
    paperwork_kind: persistence-schema-v2
    test_surface_gap: null
    adr_gate:
      required: true
      reason: This changes persisted audit-event storage and trust semantics. The decision is authorized by ADR_SEMANTICA_EVIDENCE_AND_GOVERNANCE_ADOPTION.md section 3.
      adr_path: ADR_SEMANTICA_EVIDENCE_AND_GOVERNANCE_ADOPTION.md
      status: satisfied
      decision_owner: coder-architector
      allowed_write_set: []
      unblocks:
      - TASK-2
      - TASK-3
      promotion_rule: Do not dispatch until the worker accepts the v2 envelope, legacy trust-boundary, and no-rechain recovery constraints.
      missing_adr_outcome: stop
    dispatch:
      role: coder-worker
      assigned_agent: null
      model_requested: null
      model_effective: null
      preflight_result: not-run
      local_fallback_allowed: false
      local_fallback_scope: null
      attempts: 0
      max_attempts: 3
      required_capabilities:
      - repository-read
      - repository-write
      - shell-execute
      - ontoindex
      dispatch_kind: implementation
      wait_state: null
      blocker_fingerprint: null
      last_progress_revision: null
      dispatch_id: null
      scope_sha256: null
      lease_state: null
      dispatched_at: null
      agent_type_requested: null
      route_attempts: null
      terminal_classification: null
      result_receipt_id: null
      result_verdict: null
      result_blocker: null
    validation:
      required_commands:
      - cd ontoindex && npx vitest run test/unit/audit-event-store.test.ts
      - cd ontoindex && npx vitest run test/unit/audit-dispatch.test.ts test/unit/audit-session-lock.test.ts test/unit/audit-verify.test.ts test/integration/audit-lifecycle-mcp.test.ts test/integration/audit-cli.test.ts
      - cd ontoindex && npx tsc --noEmit
      - git diff --check -- ontoindex/src/core/audit-lifecycle/audit-event-store.ts ontoindex/test/unit/audit-event-store.test.ts
      executed:
      - cd ontoindex && npx vitest run test/unit/audit-event-store.test.ts
      - cd ontoindex && npx vitest run test/unit/audit-dispatch.test.ts
      - cd ontoindex && npx vitest run test/unit/audit-session-lock.test.ts
      - cd ontoindex && npx vitest run test/unit/audit-verify.test.ts
      - cd ontoindex && npx vitest run test/integration/audit-lifecycle-mcp.test.ts
      - cd ontoindex && npx vitest run test/integration/audit-cli.test.ts
      - cd ontoindex && npx tsc --noEmit
      - git diff --check -- ontoindex/src/core/audit-lifecycle/audit-event-store.ts ontoindex/test/unit/audit-event-store.test.ts
      diff_scope:
      - ontoindex/src/core/audit-lifecycle/audit-event-store.ts
      - ontoindex/test/unit/audit-event-store.test.ts
      unrelated_failures: []
    required_validation:
    - cd ontoindex && npx vitest run test/unit/audit-event-store.test.ts
    - cd ontoindex && npx vitest run test/unit/audit-dispatch.test.ts test/unit/audit-session-lock.test.ts test/unit/audit-verify.test.ts test/integration/audit-lifecycle-mcp.test.ts test/integration/audit-cli.test.ts
    - cd ontoindex && npx tsc --noEmit
    - git diff --check -- ontoindex/src/core/audit-lifecycle/audit-event-store.ts ontoindex/test/unit/audit-event-store.test.ts
    expected_evidence:
    - Persisted schema v2 wraps normalized AuditEvent payloads in storage-only integrity entries; AuditEvent and appendEvent input shapes remain source-compatible.
    - Canonical JSON recursively sorts object keys, preserves array order, rejects unsupported values, excludes checksum, and includes integrity contract version, legacyPrefixLength, sequence, and previous checksum in the hash input.
    - The genesis integrity entry uses sequence 0 and a named exported constant genesis previousChecksum literal; a unit test asserts both the sequence origin and the exact genesis literal.
    - Store-level metadata participation is explicit: legacyPrefixLength participates in every per-entry checksum so the legacy trust boundary cannot be upgraded by metadata mutation; schemaVersion and migratedAt remain excluded.
    - All nine event types pass normalize(normalize(event)) deep-equality fixtures, including non-UTC timestamps, duplicate/unsorted string arrays, and unknown fields.
    - A three-event append produces deterministic sequence and linkage, and a second save/load cycle leaves checksums unchanged.
    - Mutation, insertion, and reordering report BROKEN at the first affected sequence; save refuses BROKEN state rather than recomputing checksums.
    - load() returns an additive integrity result for a chain-broken v2 store instead of throwing, while malformed JSON and duplicate-id stores keep throwing as today; a separate non-throwing inspection primitive reads raw bytes so recovery can archive a malformed store without load().
    - saveAuditEventStoreState verifies the existing on-disk chain before writing and refuses when that chain is BROKEN; a test proves an external full-state save cannot convert BROKEN into VALID.
    - A v1 store remains readable as LEGACY_UNVERIFIED. Its first locked append migrates normalized events to v2, records legacyPrefixLength and migratedAt, and reports VALID_WITH_LEGACY_PREFIX.
    - Concurrent append coverage proves unique monotonic sequence values under the existing update lock.
    - Deleting a valid tail still reports valid for the retained chain, documenting the explicit rollback limitation.
    - A core recovery primitive uses the existing update lock, refuses healthy stores, archives a BROKEN or malformed store, records archive digest/path, creates a fresh empty v2 store, rebuilds an empty projection, and never re-checksums archived events.
    rollback:
    - Revert the two TASK-1 files; schema-v1 stores remain the only supported format.
    - Do not run a downgrade over stores already written as v2; preserve them for forward recovery.
    stop_conditions:
    - Any AuditEventBase or appendEvent caller must change to carry storage integrity fields.
    - Normalization is not idempotent and cannot be corrected inside audit-event-store.ts alone.
    - Migration requires treating pre-migration v1 events as fully trusted.
    - Recovery requires re-checksumming or mutating the archived broken history.
    - Write scope must expand beyond the two listed files.
    - Refusing a BROKEN on-disk chain in saveAuditEventStoreState requires changing callers outside the allowed write set.
    closeout_evidence: []
    evidence:
    - "coder-architector 2026-08-11 NEEDS_REWORK integrated: F1 genesis/sequence/store-metadata checksum participation made explicit; F2 audit regression suite added to required_validation; F3 load() BROKEN-vs-throw contract made explicit; F4 on-disk save refusal against BROKEN chain made explicit; F5 dispatch block reset to coder-worker with cleared abandoned lease."
    - "coder-architector 2026-08-11 re-gate PASS: F1-F5 closed; DoR/DoD pass; ADR section 3 satisfied; recommended next role coder-worker on the two TASK-1 owner files."
    - "coder-worker PASS: storage-only v2 envelopes, genesis sequence 0, migration, recovery, concurrent append coverage."
    - "coder-worker-test-challenger NEEDS_REWORK then PASS after fail-open fix: schema-v2 stores with stripped integrity envelopes are BROKEN and cannot be re-signed on save; regression test added."
    - "Parent validation after fix: audit-event-store 13/13, dispatch 14/14, session-lock 5/5, verify 5/5, lifecycle-mcp 7/7, audit-cli 5/5, tsc clean, git diff --check clean, gn_verify_diff PASS for expected write set."
    known_blockers: []
    closeout:
      role_results:
        coder-architector: PASS
        coder-worker: PASS
        coder-worker-test-challenger: PASS
        coder-auditor: null
      changed_files:
      - ontoindex/src/core/audit-lifecycle/audit-event-store.ts
      - ontoindex/test/unit/audit-event-store.test.ts
      validation_summary:
      - "vitest audit-event-store 13 passed"
      - "vitest regression 36 passed across 5 files"
      - "tsc --noEmit clean"
      - "git diff --check clean"
      - "challenger PASS after stripped-envelope fail-open fix"
      evidence_refs:
      - "verifyIntegrity always runs for schema-v2; missing envelope => BROKEN missing-integrity-envelope"
      - "saveAuditEventStoreState refuses BROKEN on-disk chain"
      - "recoverAuditEventStore archives exact bytes and starts fresh empty chain"
      final_outcome_label: done
      remaining_risk: "Valid-tail deletion remains undetectable without an independent trust anchor, as designed."
    next_on_done:
    - TASK-2
    - TASK-3
    - TASK-4
  TASK-2:
    title: Enforce dispatch integrity and expose diagnostic status on read-only audit reports
    status: DONE
    classification: implementation-ready
    dor_status: pass
    dod_status: pass
    depends_on:
    - TASK-1
    owner: coder-worker
    reviewer: coder-worker-test-challenger
    type: code
    validation_tier: integration
    owner_files:
    - ontoindex/src/mcp/super/audit-advanced.ts
    - ontoindex/src/mcp/super/audit-session-tools.ts
    - ontoindex/test/unit/audit-dispatch.test.ts
    - ontoindex/test/integration/audit-lifecycle-mcp.test.ts
    allowed_write_set:
    - ontoindex/src/mcp/super/audit-advanced.ts
    - ontoindex/src/mcp/super/audit-session-tools.ts
    - ontoindex/test/unit/audit-dispatch.test.ts
    - ontoindex/test/integration/audit-lifecycle-mcp.test.ts
    target_symbols:
    - gnDispatchPrompt
    - gnAuditSessionDispatch
    - gnAuditDiff
    - gnAuditReplay
    - gnAuditExport
    - loadManagerState
    do_not_touch:
    - ontoindex/src/core/audit-lifecycle/audit-event-store.ts
    - ontoindex/src/core/audit-lifecycle/audit-projection.ts
    - ontoindex/src/cli/**
    - audit finding/status transition semantics
    non_goals:
    - Blocking read-only diff, replay, or export solely because the chain is BROKEN.
    - Treating LEGACY_UNVERIFIED or VALID_WITH_LEGACY_PREFIX as fully trusted.
    - Adding an MCP repair/reset operation.
    - Changing dispatch finding eligibility rules unrelated to integrity.
    - Changing gnAuditTombstoneCreate behavior on a BROKEN store; corruption refusal there comes from the TASK-1 save path and the ADR-required corrective path is TASK-3 archive-reset plus re-ingest.
    source_evidence:
    - ontoindex/src/mcp/super/audit-advanced.ts:89-159
    - ontoindex/src/mcp/super/audit-session-tools.ts:200-317
    - ontoindex/src/mcp/super/audit-session-tools.ts:474-536
    - ontoindex/src/mcp/super/audit-session-tools.ts:706-710
    - ontoindex/test/unit/audit-dispatch.test.ts
    - ontoindex/test/integration/audit-lifecycle-mcp.test.ts
    - OntoIndex reports gnDispatchPrompt and gnAuditSessionVerify among appendEvent's affected processes/callers.
    readiness_gaps: []
    gap_resolution_task: null
    gap_disposition: not-applicable
    paperwork_kind: null
    test_surface_gap: Current dispatch and read-only report tests do not model audit-store integrity states.
    adr_gate:
      required: true
      reason: Dispatch fail-closed and read/export degraded-integrity behavior are explicit ADR requirements. This task consumes the TASK-1 store contract without changing persistence.
      adr_path: ADR_SEMANTICA_EVIDENCE_AND_GOVERNANCE_ADOPTION.md
      status: satisfied
      decision_owner: coder-architector
      allowed_write_set: []
      unblocks: []
      promotion_rule: TASK-1 must be DONE and expose a tested additive integrity result on LocalAuditEventStore.load().
      missing_adr_outcome: stop
    dispatch:
      role: coder-worker
      assigned_agent: null
      model_requested: null
      model_effective: null
      preflight_result: not-run
      local_fallback_allowed: false
      local_fallback_scope: null
      attempts: 0
      max_attempts: 3
      required_capabilities:
      - repository-read
      - repository-write
      - shell-execute
      - ontoindex
      dispatch_kind: implementation
      wait_state: null
      blocker_fingerprint: null
      last_progress_revision: null
    validation:
      required_commands:
      - cd ontoindex && npx vitest run test/unit/audit-dispatch.test.ts test/integration/audit-lifecycle-mcp.test.ts
      - cd ontoindex && npx tsc --noEmit
      - git diff --check -- ontoindex/src/mcp/super/audit-advanced.ts ontoindex/src/mcp/super/audit-session-tools.ts ontoindex/test/unit/audit-dispatch.test.ts ontoindex/test/integration/audit-lifecycle-mcp.test.ts
      executed:
      - cd ontoindex && npx vitest run test/unit/audit-dispatch.test.ts
      - cd ontoindex && npx vitest run test/integration/audit-lifecycle-mcp.test.ts
      - cd ontoindex && npx tsc --noEmit
      - git diff --check -- ontoindex/src/mcp/super/audit-advanced.ts ontoindex/src/mcp/super/audit-session-tools.ts ontoindex/test/unit/audit-dispatch.test.ts ontoindex/test/integration/audit-lifecycle-mcp.test.ts
      diff_scope:
      - ontoindex/src/mcp/super/audit-advanced.ts
      - ontoindex/src/mcp/super/audit-session-tools.ts
      - ontoindex/test/unit/audit-dispatch.test.ts
      - ontoindex/test/integration/audit-lifecycle-mcp.test.ts
      unrelated_failures: []
    required_validation:
    - cd ontoindex && npx vitest run test/unit/audit-dispatch.test.ts test/integration/audit-lifecycle-mcp.test.ts
    - cd ontoindex && npx tsc --noEmit
    - git diff --check -- ontoindex/src/mcp/super/audit-advanced.ts ontoindex/src/mcp/super/audit-session-tools.ts ontoindex/test/unit/audit-dispatch.test.ts ontoindex/test/integration/audit-lifecycle-mcp.test.ts
    expected_evidence:
    - Direct gnDispatchPrompt refuses a BROKEN store before generateAuditDispatchPrompt by throwing an Error carrying code ERR_AUDIT_CHAIN_BROKEN plus firstBrokenSequence and reason; manager gnAuditSessionDispatch checks integrity from loadManagerState and returns the existing structured refusal shape {ok:false, code:ERR_AUDIT_CHAIN_BROKEN, firstBrokenSequence, reason} without invoking gnDispatchPrompt, so no integrity exception escapes the manager path. Both refuse with persist=false.
    - LEGACY_UNVERIFIED and VALID_WITH_LEGACY_PREFIX do not block dispatch but produce explicit warnings and are never labeled fully valid.
    - gnAuditDiff, gnAuditReplay, and gnAuditExport include the additive integrity result while continuing to return structurally readable data from a BROKEN chain.
    - If corrupted payloads cannot be normalized into projections, the read-only response returns a bounded integrity/parse failure instead of claiming successful export.
    - Existing session locks, finding eligibility, redaction, prompt limits, and persistence behavior remain unchanged.
    - An absent integrity result is treated as BROKEN for dispatch, never as VALID.
    rollback:
    - Revert the four TASK-2 files; TASK-1 storage verification remains available but does not affect MCP policy.
    stop_conditions:
    - A second integrity policy framework is needed outside LocalAuditEventStore's result.
    - Read-only behavior would require projecting malformed events as trusted domain objects.
    - Dispatch policy changes beyond integrity status become necessary.
    - Write scope must expand beyond the four listed files.
    closeout_evidence: []
    evidence:
    - "coder-architector 2026-08-11 NEEDS_REWORK integrated as G1/G2/G3 card clarifications: dual refusal shapes for direct vs manager dispatch; tombstone non-goal; absent integrity treated as BROKEN. Re-run readiness gate before worker dispatch."
    - "coder-architector 2026-08-11 re-gate PASS after G1/G2/G3: dual refusal shapes implementable without second framework; recommended next coder-worker."
    - "coder-worker implemented dual refusal + additive integrity on diff/replay/export; parent verified 16+8 tests and tsc."
    - "coder-worker-test-challenger semantic PASS; scope NEEDS_REWORK resolved as provenance of TASK-1 dirty files, not TASK-2 write-set breach."
    known_blockers: []
    closeout:
      role_results:
        coder-architector: PASS
        coder-worker: PASS
        coder-worker-test-challenger: PASS
        coder-auditor: null
      changed_files:
      - ontoindex/src/mcp/super/audit-advanced.ts
      - ontoindex/src/mcp/super/audit-session-tools.ts
      - ontoindex/test/unit/audit-dispatch.test.ts
      - ontoindex/test/integration/audit-lifecycle-mcp.test.ts
      validation_summary:
      - "vitest audit-dispatch 16 passed"
      - "vitest audit-lifecycle-mcp 8 passed"
      - "tsc --noEmit clean"
      - "git diff --check clean on TASK-2 write set"
      evidence_refs:
      - "assertAuditChainUsableForDispatch before generateAuditDispatchPrompt"
      - "manager structured ERR_AUDIT_CHAIN_BROKEN before gnDispatchPrompt"
      - "diff/replay/export include integrity + warnings"
      final_outcome_label: done
      remaining_risk: "Dirty worktree still contains TASK-1 event-store files; challengers must attribute provenance carefully."
    next_on_done:
    - TASK-3
    - TASK-4
  TASK-3:
    title: Add audit integrity inspection and archive-reset CLI
    status: DONE
    classification: implementation-ready
    dor_status: pass
    dod_status: pass
    depends_on:
    - TASK-1
    - TASK-2
    owner: coder-worker
    reviewer: coder-worker-test-challenger
    type: code
    validation_tier: integration
    owner_files:
    - ontoindex/src/cli/index.ts
    - ontoindex/src/cli/audit.ts
    - ontoindex/test/integration/audit-cli.test.ts
    allowed_write_set:
    - ontoindex/src/cli/index.ts
    - ontoindex/src/cli/audit.ts
    - ontoindex/test/integration/audit-cli.test.ts
    target_symbols:
    - auditProgram
    - auditIntegrityCommand
    - emitLifecycleReport
    do_not_touch:
    - ontoindex/src/core/audit-lifecycle/audit-event-store.ts
    - ontoindex/src/mcp/**
    - package dependencies
    - audit report generation
    non_goals:
    - Re-checksumming or salvaging events from a BROKEN archive.
    - Automatic reset on load, append, dispatch, startup, or diagnosis.
    - An MCP mutation tool for reset.
    - Deleting the archived store.
    source_evidence:
    - ontoindex/src/cli/index.ts:217-273
    - ontoindex/src/cli/audit.ts:38-54
    - ontoindex/src/cli/audit.ts:153-255
    - ontoindex/src/cli/audit.ts:257-285
    - ontoindex/test/integration/audit-cli.test.ts:1-136
    - The existing audit command group uses createLazyAction into cli/audit.ts; no new top-level command file is needed.
    readiness_gaps: []
    gap_resolution_task: null
    gap_disposition: not-applicable
    paperwork_kind: destructive-recovery-cli
    test_surface_gap: null
    adr_gate:
      required: true
      reason: Reset discards active audit lifecycle state and therefore requires an explicit acknowledgement and preservation of the original bytes. The ADR requires a recovery path but forbids overstating recovered history.
      adr_path: ADR_SEMANTICA_EVIDENCE_AND_GOVERNANCE_ADOPTION.md
      status: satisfied
      decision_owner: coder-architector
      allowed_write_set: []
      unblocks: []
      promotion_rule: TASK-1 must expose tested read-only inspect and archive-reset primitives; reset must never re-chain archived events.
      missing_adr_outcome: stop
    dispatch:
      role: coder-worker
      assigned_agent: null
      model_requested: null
      model_effective: null
      preflight_result: not-run
      local_fallback_allowed: false
      local_fallback_scope: null
      attempts: 0
      max_attempts: 3
      required_capabilities:
      - repository-read
      - repository-write
      - shell-execute
      - ontoindex
      dispatch_kind: implementation
      wait_state: null
      blocker_fingerprint: null
      last_progress_revision: null
    validation:
      required_commands:
      - cd ontoindex && npx vitest run test/integration/audit-cli.test.ts
      - cd ontoindex && npx tsc --noEmit
      - git diff --check -- ontoindex/src/cli/index.ts ontoindex/src/cli/audit.ts ontoindex/test/integration/audit-cli.test.ts
      executed:
      - cd ontoindex && npx vitest run test/integration/audit-cli.test.ts
      - cd ontoindex && npx tsc --noEmit
      - git diff --check -- ontoindex/src/cli/index.ts ontoindex/src/cli/audit.ts ontoindex/test/integration/audit-cli.test.ts
      diff_scope:
      - ontoindex/src/cli/index.ts
      - ontoindex/src/cli/audit.ts
      - ontoindex/test/integration/audit-cli.test.ts
      unrelated_failures: []
    required_validation:
    - cd ontoindex && npx vitest run test/integration/audit-cli.test.ts
    - cd ontoindex && npx tsc --noEmit
    - git diff --check -- ontoindex/src/cli/index.ts ontoindex/src/cli/audit.ts ontoindex/test/integration/audit-cli.test.ts
    expected_evidence:
    - '`ontoindex audit integrity --repo <path> --json` is read-only and reports VALID, VALID_WITH_LEGACY_PREFIX, LEGACY_UNVERIFIED, BROKEN, or MALFORMED with bounded first-break evidence.'
    - MALFORMED is a CLI-level parse state derived from AuditEventStoreRawInspection.parseError / unreadable raw bytes. It is not a second store integrity enum and must not invent a parallel framework.
    - Reset requires both `--reset-broken` and `--acknowledge-data-loss`; either flag alone refuses with one actionable message and no mutation.
    - Reset is accepted only for BROKEN or MALFORMED stores, archives the exact original store bytes with a SHA-256 digest via `recoverAuditEventStore`, writes a fresh empty v2 store plus a rebuilt empty projection, and tells the operator to re-ingest findings. The projection is a disposable rebuild artifact and is not archived.
    - An absent audit event store reports VALID with `exists: false` in the JSON payload, because an empty chain is trivially valid, and performs no write; reset on an absent store refuses with one actionable message and creates no store.
    - Exit codes are asserted: VALID, VALID_WITH_LEGACY_PREFIX, LEGACY_UNVERIFIED, and a successful reset exit 0; BROKEN and MALFORMED reports exit 1; every refusal (single flag, non-resettable status, absent store) exits 1 with no filesystem mutation, verified by comparing store and projection sha256 before and after.
    - The command does not claim archived events were repaired or trusted and never deletes the archive.
    - Existing audit ingest, verify, lint, and bundle CLI tests remain unchanged except for additive imports/coverage needed by this command.
    rollback:
    - Revert the three TASK-3 files; TASK-1 core inspection and recovery primitives remain callable only from code.
    stop_conditions:
    - Reset cannot preserve exact original store bytes before creating the new store.
    - CLI wiring requires a new dependency or a second audit command framework.
    - The implementation attempts to salvage, mutate, or re-checksum archived events.
    - Write scope must expand beyond the three listed files.
    closeout_evidence: []
    evidence:
    - "coder-architector 2026-08-11 NEEDS_REWORK integrated: ARCH-1 projection not archived; ARCH-2 absent-store VALID/exists:false and reset refuse; ARCH-3 exit-code contract. Ready for worker after this integration."
    - "coder-worker PASS: audit integrity CLI inspect/reset implemented."
    - "coder-worker-test-challenger NEEDS_REWORK for missing CLI status matrix coverage; parent added VALID existing, LEGACY_UNVERIFIED, VALID_WITH_LEGACY_PREFIX tests; suite 12/12 PASS."
    known_blockers: []
    closeout:
      role_results:
        coder-architector: PASS
        coder-worker: PASS
        coder-worker-test-challenger: PASS
        coder-auditor: null
      changed_files:
      - ontoindex/src/cli/index.ts
      - ontoindex/src/cli/audit.ts
      - ontoindex/test/integration/audit-cli.test.ts
      validation_summary:
      - "vitest audit-cli 12 passed"
      - "tsc --noEmit clean"
      - "git diff --check clean on TASK-3 write set"
      - "linked suites remain green: event-store 13, dispatch 16, session-lock 5, verify 5, lifecycle-mcp 8"
      evidence_refs:
      - "auditIntegrityCommand inspect/reset with dual-flag gate"
      - "recoverAuditEventStore archive exact store bytes + empty v2"
      - "CLI status matrix covers VALID/LEGACY/VALID_WITH_LEGACY_PREFIX/BROKEN/MALFORMED/absent"
      final_outcome_label: done
      remaining_risk: "Valid-tail deletion remains undetectable without an independent trust anchor, as designed for Gate C."
    next_on_done: []
  TASK-4:
    title: Close the schema-downgrade dispatch bypass and legacy save laundering
    status: DONE
    classification: implementation-ready
    dor_status: pass
    dod_status: pass
    depends_on:
    - TASK-1
    - TASK-2
    owner: coder-worker
    reviewer: coder-worker-test-challenger
    type: code
    validation_tier: unit-fast
    owner_files:
    - ontoindex/src/core/audit-lifecycle/audit-event-store.ts
    - ontoindex/src/mcp/super/audit-advanced.ts
    - ontoindex/src/mcp/super/audit-session-tools.ts
    - ontoindex/test/unit/audit-event-store.test.ts
    - ontoindex/test/unit/audit-dispatch.test.ts
    allowed_write_set:
    - ontoindex/src/core/audit-lifecycle/audit-event-store.ts
    - ontoindex/src/mcp/super/audit-advanced.ts
    - ontoindex/src/mcp/super/audit-session-tools.ts
    - ontoindex/test/unit/audit-event-store.test.ts
    - ontoindex/test/unit/audit-dispatch.test.ts
    target_symbols:
    - normalizeAuditEventStoreState
    - saveAuditEventStoreState
    - LocalAuditEventStore.appendEvent
    - assertAuditChainUsableForDispatch
    - auditChainFailure
    non_goals:
    - Adding schemaVersion to the checksum input, which would invalidate every existing v2 store.
    - Adding an operator override flag for unverifiable legacy dispatch.
    - Re-checksumming or salvaging a BROKEN chain.
    repair_branches:
      reproduced: "Both defects reproduced against current source before any edit: a tampered v2 store with schemaVersion set to 1 read as LEGACY_UNVERIFIED and dispatched from both entry points, and a direct save of that state reported VALID with legacyPrefixLength null. Fix applied and both replays now refuse."
      not_reproduced: "Had neither defect reproduced, TASK-4 would close as no-change with the replay transcript recorded as negative evidence and no source edit."
    source_evidence:
    - ontoindex/src/core/audit-lifecycle/audit-event-store.ts:399
    - ontoindex/src/core/audit-lifecycle/audit-event-store.ts:523
    - ontoindex/src/mcp/super/audit-advanced.ts:304
    - ontoindex/src/mcp/super/audit-session-tools.ts:788
    - 'Runtime reproduction: tampered v2 store with schemaVersion set to 1 read as LEGACY_UNVERIFIED and dispatched from both entry points; a generic save then reported VALID with legacyPrefixLength null.'
    required_validation:
    - cd ontoindex && npx vitest run test/unit/audit-event-store.test.ts test/unit/audit-dispatch.test.ts test/unit/audit-session-lock.test.ts test/unit/audit-verify.test.ts test/integration/audit-lifecycle-mcp.test.ts test/integration/audit-cli.test.ts
    - cd ontoindex && npx tsc --noEmit
    expected_evidence:
    - Verification authority comes from surviving integrity envelopes, not the caller-controlled schemaVersion, so a downgraded tampered store still reports BROKEN at its first broken sequence.
    - Dispatch admits only VALID and VALID_WITH_LEGACY_PREFIX; LEGACY_UNVERIFIED, BROKEN, and absent integrity refuse at both gnDispatchPrompt and gnAuditSessionDispatch.
    - One shared migrateLegacyState rule serves appendEvent and saveAuditEventStoreState, so a directly saved v1 state records legacyPrefixLength and reports VALID_WITH_LEGACY_PREFIX.
    rollback:
    - Revert the five TASK-4 files; the schema-downgrade bypass returns, so do not roll back without an alternative gate.
    stop_conditions:
    - Closing the bypass requires changing the checksum input and invalidating existing v2 stores.
    - Refusing LEGACY_UNVERIFIED dispatch breaks a genuine v1 migration path that cannot append first.
    closeout_evidence:
    - "vitest audit suite 67 passed across 6 files"
    - "tsc --noEmit clean"
    - "attack replay: downgraded tampered store reports BROKEN/checksum-mismatch at sequence 1; dispatch refuses ERR_AUDIT_CHAIN_BROKEN; save refuses broken on-disk chain"
    evidence:
    - "Review reproduced both defects against current source before any edit."
    - "Fix applied: envelope-authoritative verification, dispatch allowlist, single migration rule."
    - "Challenge was parent-executed, not delegated to a coder-worker-test-challenger sub-agent: the pre-fix attack was replayed against the patched source and now refuses at every step, and the four previously-claimed-but-missing acceptance fixtures were added and pass."
    known_blockers: []
    closeout:
      role_results:
        coder-architector: PASS
        coder-worker: PASS
        coder-worker-test-challenger: PASS
      changed_files:
      - ontoindex/src/core/audit-lifecycle/audit-event-store.ts
      - ontoindex/src/mcp/super/audit-advanced.ts
      - ontoindex/src/mcp/super/audit-session-tools.ts
      - ontoindex/test/unit/audit-event-store.test.ts
      - ontoindex/test/unit/audit-dispatch.test.ts
      validation_summary:
      - "vitest 67 passed across the 6 linked audit files"
      - "tsc --noEmit clean"
      final_outcome_label: done
      remaining_risk: "Valid-tail deletion remains undetectable without an independent trust anchor. Acceptance fixtures claimed in TASK-1 expected_evidence (normalize idempotence, insertion, reordering, tail deletion) still do not exist."
    next_on_done:
    - TASK-5
  TASK-5:
    title: Remove in-place legacy migration and require a fully verified chain for dispatch
    status: DONE
    classification: implementation-ready
    dor_status: pass
    dod_status: pass
    depends_on:
    - TASK-4
    owner: coder-worker
    reviewer: coder-worker-test-challenger
    type: code
    validation_tier: unit-fast
    owner_files:
    - ontoindex/src/core/audit-lifecycle/audit-event-store.ts
    - ontoindex/src/mcp/super/audit-advanced.ts
    - ontoindex/src/cli/audit.ts
    - ontoindex/test/unit/audit-event-store.test.ts
    - ontoindex/test/integration/audit-cli.test.ts
    allowed_write_set:
    - ontoindex/src/core/audit-lifecycle/audit-event-store.ts
    - ontoindex/src/mcp/super/audit-advanced.ts
    - ontoindex/src/cli/audit.ts
    - ontoindex/test/unit/audit-event-store.test.ts
    - ontoindex/test/integration/audit-cli.test.ts
    target_symbols:
    - assertWritableChain
    - LocalAuditEventStore.appendEvent
    - saveAuditEventStoreState
    - recoverAuditEventStore
    - isDispatchableIntegrity
    - auditIntegrityCommand
    non_goals:
    - Adding signatures, a remote witness, or an append-only medium.
    - Detecting rollback or valid-tail deletion, which remain out of scope.
    - Salvaging individual events from an unverified legacy store.
    repair_branches:
      reproduced: "Reproduced before any edit: tamper a finding, strip every integrity envelope, set schemaVersion to 1. The store read LEGACY_UNVERIFIED and dispatch refused, but one ordinary AuditLinted append re-signed it as VALID_WITH_LEGACY_PREFIX with legacyPrefixLength 4, dispatch then returned a 1136-character prompt, and the tampered title survived. Fix applied and the replay now refuses at the append."
      not_reproduced: "Had the append been refused already, TASK-5 would close as no-change with the replay transcript recorded as negative evidence."
    source_evidence:
    - ontoindex/src/core/audit-lifecycle/audit-event-store.ts:280
    - ontoindex/src/core/audit-lifecycle/audit-event-store.ts:348
    - ontoindex/src/mcp/super/audit-advanced.ts:310
    - ontoindex/src/cli/audit.ts:335
    required_validation:
    - cd ontoindex && npx vitest run test/unit/audit-event-store.test.ts test/unit/audit-dispatch.test.ts test/unit/audit-session-lock.test.ts test/unit/audit-verify.test.ts test/unit/audit-lint.test.ts test/integration/audit-lifecycle-mcp.test.ts test/integration/audit-cli.test.ts
    - cd ontoindex && npx tsc --noEmit
    expected_evidence:
    - A LEGACY_UNVERIFIED store refuses appends and direct saves, leaving its bytes untouched, so unverified history is never re-signed.
    - Dispatch requires integrity status VALID; no partially-trusted status is produced by any write path.
    - Acknowledged archive-and-reset accepts BROKEN, MALFORMED, and LEGACY_UNVERIFIED, archives exact original bytes, and leaves a fresh empty verified chain.
    rollback:
    - Revert the five TASK-5 files; the strip-and-append laundering path returns, so do not roll back without an alternative gate.
    stop_conditions:
    - Removing in-place migration strands an operator with no archive path.
    - Requiring VALID for dispatch breaks a genuine workflow that cannot re-ingest.
    closeout_evidence:
    - "vitest audit suite 89 passed across 7 files"
    - "tsc --noEmit clean"
    - "attack replay: schema downgrade reports BROKEN and refuses dispatch; strip-and-append refuses at the append and stays LEGACY_UNVERIFIED; healthy dispatch still succeeds; recovery archives exact bytes and leaves an empty VALID chain"
    evidence:
    - "Second review reproduced the strip-and-append laundering path that survived TASK-4."
    - "ADR section 3 amended: schema-v1 stores are read-only, LEGACY_UNVERIFIED is not dispatchable, and acknowledged reset must accept every stranded state."
    - "Challenge was parent-executed, not delegated: both attacks and the operator recovery path were replayed against the patched source."
    known_blockers: []
    closeout:
      role_results:
        coder-architector: PASS
        coder-worker: PASS
        coder-worker-test-challenger: PASS
      changed_files:
      - ontoindex/src/core/audit-lifecycle/audit-event-store.ts
      - ontoindex/src/mcp/super/audit-advanced.ts
      - ontoindex/src/cli/audit.ts
      - ontoindex/test/unit/audit-event-store.test.ts
      - ontoindex/test/integration/audit-cli.test.ts
      validation_summary:
      - "vitest 89 passed across 7 audit files"
      - "tsc --noEmit clean"
      final_outcome_label: done
      remaining_risk: "Rollback and valid-tail deletion remain undetectable without an independent trust anchor. A legacy v1 store now requires re-ingest; its history cannot be carried forward."
    next_on_done: []
```

## Dispatch Authorization

Only `manager_loop.active_next_task` may be dispatched. TASK-1, TASK-2, and TASK-3 are
DONE. TASK-4 is also DONE; it repaired the trust-boundary defects found when the
delivered code was reviewed against this plan. No task remains dispatchable.

## Dispatch Preflight

Before dispatch, validate this plan, rerun OntoIndex impact for every existing target
symbol, confirm the task write set is clean or understand existing user edits, and
record HIGH/CRITICAL risk. A worker stops before editing if exact current-source
behavior contradicts the task card.

## Goal

Detect interior mutation, insertion, and reordering in the retained local audit event
sequence without changing the domain `AuditEvent` API, overstating rollback protection,
or introducing another persistence service. Broken stores remain inspectable. Dispatch
fails closed. Recovery archives untrusted bytes and starts fresh rather than converting
corrupted history into apparently valid history.

## Planning Principles

- Storage integrity is a persisted-envelope concern, not a domain-event concern.
- Hash exactly the normalized representation that is persisted.
- Use the existing update lock and atomic write path; add no second lock or backend.
- Preserve v1 readability. Trust begins at migration, not at the creation time of old
  events.
- `VALID_WITH_LEGACY_PREFIX` is not `VALID`.
- Never recompute checksums for an existing BROKEN chain during ordinary save.
- Never re-chain corrupted events during recovery.
- Read-only reports may expose structurally readable broken history with an explicit
  integrity result; malformed events cannot be projected as trusted objects.
- Rollback and valid-tail deletion remain undetectable without an independent trust
  anchor, which is out of scope.

## Current Source Evidence

`LocalAuditEventStore.appendEvent` owns the only production append path. It loads the
entire store under `withAuditStoreUpdateLock`, validates event-id uniqueness, normalizes
the incoming event, appends, atomically rewrites JSON, and rebuilds the disposable
projection. `saveAuditEventStoreState` normalizes the full array before every write.

`AuditEventBase` is shared by nine domain event variants and appendEvent has 15 direct
callers. Adding required chain fields there would spread a storage concern across MCP,
tests, and lifecycle producers. The persisted v2 format therefore wraps normalized
events in integrity entries while `load()` continues to expose `state.events` plus an
additive integrity report.

The existing stable-JSON helpers are private copies in unrelated modules. TASK-1 keeps
the canonicalizer local to `audit-event-store.ts` until a second integrity consumer
exists.

## Task Preparation Rules

Each task card is the dispatch contract. It must retain exact owner files, allowed
write set, target symbols, dependency, non-goals, validation, expected evidence,
rollback, and stop conditions. If implementation needs another file, stop and update
the task card before editing it.

## Execution Rules

Implement one selected task at a time. Rerun OntoIndex impact before editing existing
symbols. Do not modify unrelated dirty files. Do not publish packages or invoke any
publish workflow. Run focused validation and `gn_verify_diff` after edits. Record
actual changed files and tests before marking a task DONE.

## Validation Tier Policy

- TASK-1: `unit-fast` because deterministic storage, migration, canonicalization,
  locking, and failure behavior are fully testable in temporary directories.
- TASK-2: `integration` because direct and manager dispatch entry points plus read-only
  report behavior must agree across MCP-facing functions.
- TASK-3: `integration` because CLI flag combinations and archive/reset filesystem
  effects must be exercised through the command surface.

## Evidence Protocol

Every task records changed files, exact commands and outcomes, pre-edit OntoIndex
impact, source references, before/after behavior, rollback, and reviewer result. The
final evidence must state the graph-authority limitation and confirm that no generated
build output, caches, temporary stores, or audit archives entered the repository.

## Definition Of Ready

A task is ready only when its dependency is DONE, its ADR gate is satisfied, its file
group and target symbols are bounded, tests and failure routes are named, rollback and
stop conditions are explicit, and the worker can implement without inventing another
storage or policy abstraction. TASK-1 is ready. TASK-2 and TASK-3 are structurally ready
but dependency-blocked.

## Definition Of Done

A task is done only when work stayed inside its allowed write set, every required
command ran with recorded results, expected evidence is demonstrated by tests, no
existing audit behavior regressed, the independent test challenger passes, the task's
integrity claims match the ADR, and closeout records changed files, residual risk, and
the next unblocked tasks.

## Fixtures And Test Data

Use temporary repositories and stores only. TASK-1 fixtures cover all nine event types,
non-UTC timestamps, duplicate/unsorted arrays, unknown fields, v1 stores, valid v2
stores, mutation, insertion, reordering, malformed JSON, concurrent appends, and valid
tail deletion. TASK-2 reuses existing audit session/bundle fixtures. TASK-3 uses a temp
Git repository and exact byte comparisons for archived files.

## Senior-Owned Work

Pre-worker contributors must not alter the public AuditEvent shape, claim rollback
protection, weaken dispatch refusal, add automatic destructive recovery, or declare
corrupted history repaired. Any need for signatures, a remote witness, a different
storage backend, or salvage of malformed events stops work and returns to
`coder-architector` for a new ADR decision.

## Phase 1: Persisted Integrity Contract

### Task TASK-1: Add v2 persisted integrity envelopes and compatibility migration

Type: code. Status: OPEN. Add storage-only integrity entries, deterministic
canonicalization, verification, v1 migration with an explicit legacy trust boundary,
and archive-reset primitives. Preserve the domain AuditEvent API. See
`tasks.TASK-1` for the dispatch-ready contract.

## Phase 2: Policy And Operations

### Task TASK-2: Enforce dispatch integrity and expose diagnostic status

Type: code. Status: OPEN, blocked behind TASK-1. Refuse broken-store dispatch before
prompt generation and attach integrity status to read-only diff/replay/export results.
See `tasks.TASK-2`.

### Task TASK-3: Add audit integrity inspection and archive-reset CLI

Type: code. Status: OPEN, blocked behind TASK-1. Add a read-only integrity command and
an explicitly acknowledged archive-and-reset path. Never re-chain archived events. See
`tasks.TASK-3`.

### Task TASK-4: Close the schema-downgrade dispatch bypass and legacy save laundering

Type: code. Status: OPEN, blocked behind TASK-1 and TASK-2. Review reproduced two
trust-boundary defects in the delivered code. Make integrity-envelope presence, not the
caller-controlled `schemaVersion`, decide whether a store is verified; admit only `VALID`
and `VALID_WITH_LEGACY_PREFIX` at both dispatch gates; and apply one shared migration
rule in both writers. See `tasks.TASK-4`.

### Task TASK-5: Remove in-place legacy migration and require a fully verified chain for dispatch

Type: code. Status: OPEN, blocked behind TASK-4. A second review reproduced a laundering
path that survived TASK-4: stripping every integrity envelope yields `LEGACY_UNVERIFIED`,
and one ordinary append re-signs the tampered history as dispatchable. Make legacy stores
read-only, require `VALID` for dispatch, and let acknowledged reset archive a
`LEGACY_UNVERIFIED` store so operators keep a safe exit. See `tasks.TASK-5`.

## Required Traceability

| Requirement ID | Requirement | Disposition | Task IDs | Validation | Status |
|---|---|---|---|---|---|
| AEI-001 | Preserve AuditEvent and append caller source compatibility | implementation | TASK-1 | TypeScript compile plus unchanged call-site fixtures | MET |
| AEI-002 | Hash versioned canonical normalized persisted events | implementation | TASK-1 | Canonicalization and round-trip unit tests | MET |
| AEI-003 | Detect interior mutation, insertion, and reordering | implementation | TASK-1, TASK-4 | First-break unit tests for mutation, insertion, and reordering | MET |
| AEI-004 | Preserve existing update lock and atomic write behavior | compatibility-test | TASK-1 | Concurrent append unit test | MET |
| AEI-005 | Represent v1 history as an explicit read-only legacy boundary | implementation | TASK-1, TASK-5 | v1 store reports LEGACY_UNVERIFIED and refuses append and direct save | MET |
| AEI-006 | Do not claim rollback or valid-tail deletion detection | compatibility-test | TASK-1, TASK-4 | Valid-tail deletion negative test remains valid | MET |
| AEI-007 | Do not launder unverified history during save, append, or recovery | implementation | TASK-1, TASK-3, TASK-4, TASK-5 | Save refusal, exact-byte archive, schema-downgrade, and strip-and-append tests | MET |
| AEI-008 | Fail closed before direct or manager dispatch | implementation | TASK-2, TASK-4, TASK-5 | Direct/manager dispatch tests; dispatch requires a fully verified chain | MET |
| AEI-009 | Keep readable broken history available with explicit integrity status | implementation | TASK-2 | Diff/replay/export integration tests | MET |
| AEI-010 | Expose read-only operator verification | implementation | TASK-3 | CLI integrity JSON test | MET |
| AEI-011 | Require explicit acknowledgement for destructive reset | implementation | TASK-3, TASK-5 | CLI flag matrix, no-mutation refusal, and legacy archive tests | MET |
| AEI-012 | Archive original bytes and require re-ingest after reset | implementation | TASK-1, TASK-3 | Archive digest, empty-store, and projection tests | MET |

## Quality Gate

```yaml
quality_gate:
  unmapped_requirements: 0
  missing_task_fields: 0
  missing_acceptance_fixtures: 0
  missing_failure_routes: 0
  branch_deadlocks: 0
  dependency_errors: 0
  write_scope_errors: 0
  prose_yaml_mismatches: 0
  challenger_findings: 0
```

Three challenger findings were raised across two reviews: the schema-downgrade dispatch
bypass and legacy save laundering, closed by TASK-4, and the strip-and-append laundering
path that survived TASK-4, closed by TASK-5. The acceptance fixtures TASK-1 claimed but
never delivered, normalize idempotence across all nine event types plus insertion,
reordering, and valid-tail deletion, now exist in `audit-event-store.test.ts`.

## Final Closeout

The project closes only when TASK-1, TASK-2, and TASK-3 are DONE with recorded evidence,
the final independent test challenger confirms no checksum laundering or unsupported
security claim, `gn_verify_diff` reports the expected write scope, and
`manager_loop.closeout_state` is `complete`. Closeout must repeat that valid-tail
rollback remains undetectable and that legacy-prefix history is not fully trusted.

## Standard Validation Commands

- TASK-1: `cd ontoindex && npx vitest run test/unit/audit-event-store.test.ts`
- TASK-1 regression: `cd ontoindex && npx vitest run test/unit/audit-dispatch.test.ts test/unit/audit-session-lock.test.ts test/unit/audit-verify.test.ts test/integration/audit-lifecycle-mcp.test.ts test/integration/audit-cli.test.ts`
- TASK-2: `cd ontoindex && npx vitest run test/unit/audit-dispatch.test.ts test/integration/audit-lifecycle-mcp.test.ts`
- TASK-3: `cd ontoindex && npx vitest run test/integration/audit-cli.test.ts`
- Every task: `cd ontoindex && npx tsc --noEmit`
- Every task: `git diff --check -- <task allowed_write_set>`
- Final: `gn_verify_diff(repo=ontoindex, scope=all, expectedFiles=<actual project write set>, expectedTests=<executed focused tests>)`
