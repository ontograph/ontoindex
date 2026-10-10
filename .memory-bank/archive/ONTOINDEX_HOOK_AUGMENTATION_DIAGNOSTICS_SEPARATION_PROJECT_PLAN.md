# OntoIndex Hook Augmentation And Diagnostics Separation Project Plan
Date: 2026-07-23
Status: Complete (TASK-1 DONE; project closed out)
Audience: coder-manager and coder-* sub-agents (sub-agent dispatch mode)
Authority: This tracking file. No ADR required (see Planning Principles);
bounded correctness repair across the repository-owned augment producer and
both repository-owned hook consumers, plus their unit and integration tests.

## Manager Tracking

```yaml
manager_loop:
  status: closed
  active_next_task: null
  selected_task: null
  no_selected_task_reason: no-active-task
  last_decision:
    outcome: completed
    label: complete
    reason: >-
      TASK-1 implemented, validated (unit 84/84, integration 48/48, total 132),
      and closed. First coder-worker-challenger returned NEEDS_REWORK for
      embedded-delimiter injection; rework added a strict frame grammar plus
      tests and the final challenger returned PASS with OHD-001..OHD-008
      satisfied.
    planning_work_considered: true
    reopen_gate: >-
      Reopen only if the sentinel-frame contract, additionalContext JSON wire,
      or hook wiring regresses, or if either hook variant loses behavioral
      parity.
  closeout_state: complete
  dispatch_mode: sub-agent
  selection_policy: active_next_task-first
  auto_continue: until-stop-condition
  dispatch_preflight:
    tool_surface: unchecked
    child_capability_probes: {}
    required_roles:
      coder-architector:
        agent_type_candidates: [coder-architector, worker]
        local_fallback_allowed: false
        required_for: [dor-dod-adr-gate, paperwork, readiness, closeout]
      coder-worker:
        agent_type_candidates: [coder-worker, worker]
        local_fallback_allowed: false
        required_for: [implementation]
      coder-worker-test:
        agent_type_candidates: [coder-worker-test, worker]
        local_fallback_allowed: false
        required_for: [verification]
      coder-worker-challenger:
        agent_type_candidates: [coder-worker-challenger, worker]
        local_fallback_allowed: false
        required_for: [challenge]
    fork_context: false
    unavailable_outcome: "blocked: model/capacity"
  ontoindex:
    required: true
    status: dirty
    unavailable_action: direct-source-fallback
    tools_used:
      - gn_ensure_fresh(repo=ontoindex)
    limitations:
      - OntoIndex worktree is dirty (25 files, scopeConfidence medium); index
        head matches commit (8bcdc39) but impacted-symbol graph metadata is
        advisory. The worker must rerun impact/inspection before edits.
    source_fallback:
      - ontoindex/hooks/claude/ontoindex-hook.cjs (stderr piped into result, then result -> additionalContext)
      - ontoindex-claude-plugin/hooks/ontoindex-hook.js (same stderr -> additionalContext leak, independent variant)
      - ontoindex/src/cli/augment.ts (augmentation producer writes payload to stderr with no machine-readable frame)
    fallback_evidence:
      - "Both hooks assign result = child.stderr on CLI success and emit it as additionalContext via sendHookResponse, so operational/FTS diagnostics ride the same channel as intentional augmentation."
      - "The plugin hook (ontoindex-claude-plugin/hooks/ontoindex-hook.js) is spawned and asserted directly by both test files and is published as the plugin; setup.ts:415 only copies the .cjs into client configs and no code generates the plugin .js from the .cjs, so the two are independent and both must be repaired for parity."
      - "augment.ts writes the engine result to stderr; engine.ts only prefixes human-readable '[OntoIndex] N related symbols found:' text. There is no machine-readable frame today, and the '[OntoIndex]' marker must not be used as a parse signal."
      - "git status --short shows the five write-set files (augment.ts, both hooks, hooks.test.ts, hooks-e2e.test.ts) are clean and not among the 25 dirty files."

tasks:
  TASK-1:
    title: Frame OntoIndex hook augmentation and separate it from operational diagnostics
    status: DONE
    classification: implementation-ready
    dor_status: pass
    dod_status: pass
    depends_on: []
    owner: coder-worker
    reviewer: coder-worker-challenger
    type: code
    validation_tier: integration
    validation_tier_reason: >-
      unit-fast source-pattern assertions cannot prove that a real framed +
      diagnostic stderr stream is split correctly at runtime across both hook
      variants. The DoD claim "framed augmentation reaches additionalContext,
      diagnostics do not (but stay observable on stderr), and malformed/absent
      frames emit nothing" requires spawning each hook against a stub augment
      producer, which is an integration behavior (hooks-e2e.test.ts).
    owner_files:
      - ontoindex/src/cli/augment.ts
      - ontoindex/hooks/claude/ontoindex-hook.cjs
      - ontoindex-claude-plugin/hooks/ontoindex-hook.js
      - ontoindex/test/unit/hooks.test.ts
      - ontoindex/test/integration/hooks-e2e.test.ts
    allowed_write_set:
      - ontoindex/src/cli/augment.ts
      - ontoindex/hooks/claude/ontoindex-hook.cjs
      - ontoindex-claude-plugin/hooks/ontoindex-hook.js
      - ontoindex/test/unit/hooks.test.ts
      - ontoindex/test/integration/hooks-e2e.test.ts
    target_symbols:
      - augmentCommand
      - handlePreToolUse
      - runOntoIndexCli
      - resolveCliPath
      - sendHookResponse
    do_not_touch:
      - ontoindex/src/core/augmentation/engine.ts (payload producer stays as-is; only augment.ts adds the frame)
      - ontoindex/src/cli/setup.ts and ontoindex-claude-plugin/hooks/hooks.json (hook wiring unchanged)
      - any ontocode-rs path (different repo)
      - the 25 unrelated dirty OntoIndex files
    non_goals:
      - Changing PostToolUse staleness detection semantics.
      - Suppressing operational stderr/FTS warnings (they must stay diagnostic and observable on the hook's own stderr).
      - Parsing the human-readable '[OntoIndex]' marker as the augmentation frame.
      - Editing engine.ts or introducing a parallel/duplicate hook, registry, or side stack.
    source_evidence:
      - ontoindex/src/cli/augment.ts:15-30 (augmentCommand writes payload to stderr, no machine frame)
      - ontoindex/hooks/claude/ontoindex-hook.cjs:196-268 (resolveCliPath, runOntoIndexCli, handlePreToolUse, sendHookResponse)
      - ontoindex-claude-plugin/hooks/ontoindex-hook.js:181-269 (runOntoIndexCli PATH detection, handlePreToolUse, sendHookResponse)
      - ontoindex/test/unit/hooks.test.ts:1-40 (spawns both CJS and plugin hooks)
      - ontoindex/test/integration/hooks-e2e.test.ts:20-40 (describe.each over both hook variants)
    readiness_gaps: []
    gap_resolution_task: null
    gap_disposition: not-applicable
    paperwork_kind: null
    test_surface_gap: null
    adr_gate:
      required: false
      reason: >-
        Bounded correctness repair on an internal, repository-owned
        producer/consumer channel. augmentCommand adds a machine-readable frame
        to its own stderr payload, and both repository-owned hooks extract only
        the framed content while forwarding all other stderr as diagnostics.
        The stderr augmentation channel already exists (see augment.ts comment);
        this only makes its boundary explicit. No public API, config, MCP wire,
        persistence, or security posture change: the additionalContext JSON
        contract is unchanged and any new env seam reuses the established
        ONTOINDEX_HOOK_* pattern already present in both hooks.
      adr_path: null
      status: not-needed
      decision_owner: coder-architector
      allowed_write_set: []
      unblocks: []
      promotion_rule: null
      missing_adr_outcome: create-planning-task
    dispatch:
      role: coder-worker
      assigned_agent: coder-worker
      model_requested: null
      model_effective: null
      preflight_result: pass
      local_fallback_allowed: false
      local_fallback_scope: null
      attempts: 1
      max_attempts: 3
      required_capabilities: [repository-read, repository-write, shell-execute]
      dispatch_kind: implementation
      wait_state: done
      blocker_fingerprint: null
      last_progress_revision: closeout
    validation:
      required_commands:
        - "npx vitest run test/unit/hooks.test.ts"
        - "npx vitest run test/integration/hooks-e2e.test.ts"
      executed:
        - "npx vitest run test/unit/hooks.test.ts"
        - "npx vitest run test/integration/hooks-e2e.test.ts"
      diff_scope:
        - ontoindex/src/cli/augment.ts
        - ontoindex/hooks/claude/ontoindex-hook.cjs
        - ontoindex-claude-plugin/hooks/ontoindex-hook.js
        - ontoindex/test/unit/hooks.test.ts
        - ontoindex/test/integration/hooks-e2e.test.ts
      unrelated_failures: []
    required_validation:
      - "npx vitest run test/unit/hooks.test.ts"
      - "npx vitest run test/integration/hooks-e2e.test.ts"
    expected_evidence:
      - Pre-edit overlap check confirms all five write-set files are clean and
        not among the 25 dirty OntoIndex files (rerun git status short on the
        write set).
      - Impact/inspection rerun for augmentCommand and both hook handlers before
        edits (graph metadata is advisory; dirty worktree).
      - Behavioral execution for BOTH hook variants (CJS and plugin), driven by a
        stub augment producer that emits a well-formed frame plus operational/FTS
        diagnostic lines on stderr, proving (a) additionalContext carries only
        the framed augmentation payload; (b) diagnostics are excluded from
        additionalContext but remain observable on the hook's own stderr; (c) a
        malformed or absent frame emits no augmentation (no hookSpecificOutput);
        (d) PostToolUse staleness output is unchanged.
      - The augmentCommand frame is explicit and machine-readable (sentinel-
        delimited), and neither hook parses the '[OntoIndex]' marker.
      - git diff --check clean on the write set; no generated dist/binaries,
        logs, caches, or temp files added.
    rejected_evidence:
      - "REJECTED: a prior two-file patch/test touching only ontoindex-hook.cjs and hooks.test.ts. Rejected because (1) it left the independently published plugin hook (ontoindex-claude-plugin/hooks/ontoindex-hook.js) unpatched, breaking behavioral parity; (2) it relied on human-readable '[OntoIndex]' marker parsing, which is brittle and now forbidden; (3) it added no machine-readable frame at the producer (augmentCommand); (4) it lacked behavioral execution proving diagnostics-stay-on-stderr and malformed/absent-frame handling for both variants."
    rollback:
      - Revert augment.ts, both hook files, hooks.test.ts, and hooks-e2e.test.ts.
    stop_conditions:
      - Any write-set file overlaps an unrelated dirty change on dispatch.
      - Repair would require suppressing genuine diagnostics rather than routing them to stderr.
      - A behavioral proof for either hook variant cannot be made deterministic and offline without an env-based CLI-path injection seam beyond the established ONTOINDEX_HOOK_* pattern, or without editing files outside the write set.
      - The producer/consumer frame would require changing the additionalContext JSON contract, engine.ts, or hook wiring (setup.ts / hooks.json).
    closeout_evidence:
      - "Product changed files exactly: ontoindex/src/cli/augment.ts; ontoindex/hooks/claude/ontoindex-hook.cjs; ontoindex-claude-plugin/hooks/ontoindex-hook.js; ontoindex/test/unit/hooks.test.ts; ontoindex/test/integration/hooks-e2e.test.ts."
      - "Producer emits a sentinel frame; both consumers require exactly one frame with standalone delimiter lines, support LF/CRLF, route non-frame stderr diagnostics to hook stderr, emit only the framed non-empty body as additionalContext, and fail closed on absent/malformed/embedded/decorated/duplicate/reversed delimiters. '[OntoIndex]' is not a parse signal. PostToolUse unchanged."
      - "Validation: `npx vitest run test/unit/hooks.test.ts` 84/84; `npx vitest run test/integration/hooks-e2e.test.ts` 48/48; total 132; scoped `git diff --check` clean; scoped gn_verify_diff PASS on exactly the expected five files/symbols/tests; project_plan_validate PASS."
    evidence:
      - "unit: npx vitest run test/unit/hooks.test.ts -> 84/84 pass (frame contract + no-marker-parse + PostToolUse unchanged)."
      - "integration: npx vitest run test/integration/hooks-e2e.test.ts -> 48/48 pass (both hook variants; additionalContext carries only framed body; diagnostics stay on hook stderr; malformed/absent frames emit nothing)."
      - "Pre-edit overlap check: all five write-set files clean and not among the 25 dirty OntoIndex files."
      - "gn_verify_diff PASS: exactly the expected five files/symbols/tests; no generated dist/binaries, logs, caches, or temp files added."
    known_blockers: []
    closeout:
      role_results:
        coder-architector: PASS
        coder-worker: PASS
        coder-worker-test: PASS
        coder-worker-challenger: PASS
        coder-auditor: null
      changed_files:
        - ontoindex/src/cli/augment.ts
        - ontoindex/hooks/claude/ontoindex-hook.cjs
        - ontoindex-claude-plugin/hooks/ontoindex-hook.js
        - ontoindex/test/unit/hooks.test.ts
        - ontoindex/test/integration/hooks-e2e.test.ts
      validation_summary:
        - "npx vitest run test/unit/hooks.test.ts -> 84/84 pass"
        - "npx vitest run test/integration/hooks-e2e.test.ts -> 48/48 pass (total 132)"
        - "git diff --check clean on the five-file write set; gn_verify_diff PASS; project_plan_validate PASS"
      evidence_refs:
        - tasks.TASK-1.closeout_evidence
        - tasks.TASK-1.evidence
      final_outcome_label: complete
      remaining_risk: >-
        Legitimate augmentation containing sentinel literals is rejected and
        fails closed, remaining diagnostics rather than additionalContext; low
        risk. Unrelated dirty worktree changes remain and were preserved.
    next_on_done: []
```

## Dispatch Authorization

Sub-agent dispatch is authorized for the four coder roles named in
`dispatch_preflight.required_roles`. `coder-architector` is the sole paperwork,
readiness, and closeout writer. `coder-worker` implements exactly one bounded
task and edits only its `allowed_write_set`. No local fallback is allowed.

## Dispatch Preflight

Cache one non-mutating capability probe per role/effective-model/tool-surface
tuple before substantive sub-agent work. Missing child capability is
`blocked: capability unavailable`.

## Goal

Repair a confirmed correctness defect that spans one repository-owned producer
and two repository-owned consumers. `augmentCommand` writes its augmentation
payload to stderr with no machine-readable frame, and both hooks
(`ontoindex-hook.cjs` and the independently published
`ontoindex-claude-plugin/hooks/ontoindex-hook.js`) assign the whole child stderr
to `result` and emit it as provider-visible `additionalContext`, leaking
operational and FTS diagnostics. Deliver one bounded, dispatch-ready task:
`augmentCommand` emits an explicit machine-readable frame around its payload;
both hooks extract only the framed augmentation into `additionalContext` and
forward all other stderr as observable diagnostics. This packet is independent
of the ontocode barrier/history plan and shares no write set with it.

## Planning Principles

No ADR is required. The repair edits repository-owned source on an internal
producer/consumer channel (augmentCommand stderr payload plus both hook
consumers) and does not change public API, config, persistence, security
posture, the additionalContext JSON wire contract, MCP behavior, or cross-owner
boundaries. Any CLI-path injection seam needed for deterministic offline tests
must reuse the established `ONTOINDEX_HOOK_*` env pattern already present in both
hooks. If the worker finds the fix cannot be done without a contract, engine, or
wiring change, it must stop and route back to `coder-architector` per the task
stop conditions rather than expanding scope. Reject any parallel hook, registry,
or side stack; the existing producer and both hooks accommodate the repair.

The owner of augmentation output is `augmentCommand`; the owners of provider
context emission are the two hook `handlePreToolUse` paths. The frame is added
once at the producer and consumed identically by both hooks, so no new owner,
router, or side stack is introduced. The `[OntoIndex]` string from engine.ts is
human-readable body content, not a machine contract, and must not be parsed as
the frame.

## Current Source Evidence

- `augmentCommand` (augment.ts) writes the engine result to stderr with no
  machine frame; the comment there documents that KuzuDB/LadybugDB captures
  stdout at the OS level, so stderr is the intended augmentation channel.
- Both hooks assign `result = child.stderr` on CLI success and emit it via
  `sendHookResponse` as `additionalContext`, so operational/FTS diagnostics leak.
- The two hooks are independent files, not generated from each other: setup.ts
  copies only the `.cjs` into client configs, and both test files spawn and
  assert the plugin `.js` directly. Parity requires editing both.
- engine.ts emits `[OntoIndex] N related symbols found:` as human-readable body;
  it is not a machine contract and must not be used as the frame.
- OntoIndex worktree is dirty (25 files); all five write-set files are clean.
- OntoIndex graph metadata is advisory while dirty; direct source inspection is
  authoritative and the worker must rerun impact before edits.

## Task Preparation Rules

The single task card is normalized with owner files, the expanded five-file
allowed write set, target symbols, non-goals, both validation commands,
rollback, stop conditions, DoR, DoD, rejected-evidence record, and evidence
format. No metadata gap, ADR gate, or proof gap remains, so no preparation
sub-task is created.

## Execution Rules

Edit only the `allowed_write_set`; implement exactly one bounded task; run the
pre-edit overlap check and impact/inspection before editing symbols; do not add
a duplicate hook or side stack; if the write set must expand, stop and update the
task card first; run focused validation and update tracking only after evidence
exists.

## Validation Tier Policy

- TASK-1: `integration` — the augmentation-vs-diagnostics separation must be
  proven by spawning both hook variants against a stub augment producer that
  emits a framed payload plus diagnostic lines on stderr, then asserting the
  additionalContext split, the observable-diagnostics-on-stderr behavior, and
  the malformed/absent-frame behavior. That runtime claim exceeds unit-fast
  source-pattern assertions, so the tier escalates to `integration` and the
  named missing claim is the runtime stderr-split proof across both variants.
  The unit suite (`hooks.test.ts`) retains the fast source and PostToolUse
  coverage; the integration suite (`hooks-e2e.test.ts`) carries the behavioral
  frame/diagnostics proof.

## Evidence Protocol

The task records changed files, the exact validation command, pass/fail result,
source references, OntoIndex limitations or fallback checks, and confirmation
that no generated binaries, logs, caches, archives, or temp files were added. It
also records the pre-edit overlap check, before/after behavior, rollback path,
and reviewer result.

## Definition Of Ready

The task names one bounded five-file group (producer augment.ts, both hook
consumers, and both test files), an explicit type and output artifact, both
exact validation commands, rollback, non-goals, target symbols, reviewer, stop
conditions, the rejected prior-evidence record, and verifiable expected
evidence; `adr_gate.status` is `not-needed`; dispatch role and local-fallback
policy are explicit. The producer/consumer frame contract is stated: an explicit
machine-readable sentinel frame emitted by `augmentCommand`, consumed
identically by both hooks, with `[OntoIndex]` marker parsing forbidden.

## Definition Of Done

The task is done only when: `augmentCommand` wraps its non-empty payload in an
explicit machine-readable sentinel frame on stderr; both hooks extract only the
framed content into `additionalContext` and forward all other stderr as
observable diagnostics; a malformed or absent frame yields no augmentation;
PostToolUse staleness semantics are unchanged; work stayed inside the five-file
allowed write set; both named validation commands ran with recorded results
covering both hook variants behaviorally; no generated artifacts were added; the
reviewer confirms no side hook, no engine/wiring/contract change, and no
`[OntoIndex]` marker parsing; remaining risk is a concrete follow-up; role
closeout is recorded for every required role; and the final outcome label
matches the loop result.

## Fixtures And Test Data

Fixtures: a stub augment producer is required for the behavioral proof. Tests
spawn each hook process with controlled stdin JSON (vitest) and point the hook
at a stub CLI that emits a well-formed frame plus operational/FTS diagnostic
lines on stderr. The stub is created inside the test (or the test utils) and is
not a committed runtime fixture. If a deterministic offline injection requires a
CLI-path override, it must reuse the established `ONTOINDEX_HOOK_*` env pattern.

## Senior-Owned Work

Pre-junior contributors must not: change PostToolUse staleness semantics, change
public API/config/persistence/security surfaces or the additionalContext JSON
contract, edit engine.ts or hook wiring (setup.ts / hooks.json), suppress
genuine diagnostics instead of routing them to stderr, parse the `[OntoIndex]`
marker as the frame, add a side hook, delete active legacy paths, or declare
parity/runtime readiness. Any such need stops the task and routes to
`coder-architector`.

## Phase 1: Hook Diagnostics Separation

### Task TASK-1: Frame augmentation and separate it from diagnostics

Type: code. Status: OPEN. `augmentCommand` emits an explicit machine-readable
sentinel frame around its payload; both hook variants extract only the framed
augmentation into `additionalContext` while forwarding operational stderr/FTS
warnings as observable diagnostics; malformed/absent frames emit nothing;
PostToolUse is unchanged; `[OntoIndex]` marker parsing is forbidden. Require a
pre-edit overlap check against the dirty worktree and behavioral execution for
both hook variants. Validation: `vitest run test/unit/hooks.test.ts` and
`vitest run test/integration/hooks-e2e.test.ts`. See the `tasks.TASK-1` card.

## Required Traceability

| Requirement ID | Requirement | Disposition | Task IDs | Validation | Status |
|---|---|---|---|---|---|
| OHD-001 | additionalContext must contain only framed augmentation from augmentCommand | implementation | TASK-1 | `test/integration/hooks-e2e.test.ts` framed-augmentation-only coverage, both variants | DONE |
| OHD-002 | Operational stderr/FTS diagnostics excluded from additionalContext but observable on the hook's stderr | implementation | TASK-1 | `test/integration/hooks-e2e.test.ts` diagnostics-on-stderr coverage, both variants | DONE |
| OHD-003 | augmentCommand emits an explicit machine-readable sentinel frame; `[OntoIndex]` marker parsing forbidden | implementation | TASK-1 | `test/unit/hooks.test.ts` frame-contract + no-marker-parse coverage | DONE |
| OHD-004 | Both hook variants (CJS and plugin) achieve behavioral parity, proven by execution | implementation | TASK-1 | `test/integration/hooks-e2e.test.ts` describe.each over both variants | DONE |
| OHD-005 | Malformed or absent frames emit no augmentation | implementation | TASK-1 | `test/integration/hooks-e2e.test.ts` malformed/absent-frame coverage, both variants | DONE |
| OHD-006 | Preserve PostToolUse staleness detection semantics | compatibility-test | TASK-1 | `test/unit/hooks.test.ts` + `test/integration/hooks-e2e.test.ts` PostToolUse unchanged | DONE |
| OHD-007 | Require dirty-worktree overlap check before edits | proof-only | TASK-1 | Pre-edit `git status --short` overlap check recorded on all five write-set files | DONE |
| OHD-008 | Record the prior two-file patch/test as rejected evidence | proof-only | TASK-1 | `tasks.TASK-1.rejected_evidence` records the rejection and reasons | DONE |

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

## Final Closeout

The project is closed. TASK-1 is DONE with recorded validation (unit 84/84,
integration 48/48, total 132) and the exact five-file changed set. The first
`coder-worker-challenger` planned-vs-done challenge returned NEEDS_REWORK for
embedded-delimiter injection; the rework added a strict frame grammar plus
tests, and the final challenge returned PASS with OHD-001..OHD-008 satisfied.
`manager_loop.closeout_state` is `complete`.

Proven by tests: OHD-001, OHD-002, OHD-003, OHD-004, OHD-005, OHD-006 (the
frame contract, no-marker-parse, additionalContext-only-framed-body,
diagnostics-stay-on-stderr, malformed/absent-frame, both-variant parity, and
PostToolUse-unchanged claims are all covered by the unit and integration
suites). Required a live spawn-capable session: OHD-004's behavioral parity
across both hook variants and the diagnostics/malformed-frame runtime split
were exercised by spawning each hook against a stub augment producer; OHD-007
(pre-edit dirty-worktree overlap check) and OHD-008 (rejected prior-evidence
record) were proof-only and confirmed in-session.

## Standard Validation Commands

- TASK-1: `npx vitest run test/unit/hooks.test.ts`
- TASK-1: `npx vitest run test/integration/hooks-e2e.test.ts`
- All: `git diff --check` on the task's five-file write set.
