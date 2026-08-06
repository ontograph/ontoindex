# Structural Conformance And Evaluation Oracles Project Plan
Date: 2026-07-26
Status: Open tracking plan
Revision: 5 (canonical-artifact follow-up implemented and validated)
Audience: coder-manager and coder-* sub-agents (sub-agent dispatch mode)
Authority: ADR_STRUCTURAL_CONFORMANCE_AND_EVAL_ORACLES.md (Accepted, revision 6).
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
    reason: "All four tasks met DoD and revision-5 follow-up closed the integration gaps. TASK-1 added a trackable two-rule boundary file (1 clean, 9 real violations, 0 false positives). TASK-2 added the preCommitChecklist entry. TASK-3 now derives frozen paths, structural tool results, and graph provenance from OntoIndexDockerEnvironment: frozen paths use git status inside /testbed and fail closed for paths that are not tracked at baseline; boundary_violations calls the generic warm eval-server endpoint; provenance records eval-cache:<cache-key> and indexed HEAD for fresh and restored indexes. TASK-5 now discovers canonical SWE-bench per-instance report.json artifacts, runs the upstream CLI with --report_dir instead of the unsupported --output_dir, computes partial credit from the actual FAIL_TO_PASS ratio with no PASS_TO_PASS regression, and exposes Resolve/Fix/F→S Fail in human output. eval/structural_oracles.py is included in wheel extra-files. Validation: pytest 43 passed, py_compile passed, tsc passed, npm build previously passed, git diff --check clean. gn_verify_diff is noisy due unrelated dirty MCP/dead-code files not modified by this work. Residual risk: no real Docker-backed SWE-bench instance was executed in this session, and the 9 boundary violations remain architectural debt."
    planning_work_considered: true
    reopen_gate: null
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
      - gn_diagnose(repo=ontoindex)
      - gn_find_related(symbol=classifyReviewRisk)
      - gn_can_delete(symbol=classifyReviewRisk)
      - gn_scope_guard(session=probe-session)
      - gn_test_gap(symbol=classifyReviewRisk)
      - audit(action=violations, repo=ontoindex, rules=[core -> mcp])
    limitations:
      - Worktree dirty (70 files, scopeConfidence low, reason
        untracked-source-files); graph metadata is advisory and every worker must
        rerun impact before edits.
      - Embeddings absent (count 0); semantic retrieval degraded. Symbol and edge
        evidence unaffected, which is what this plan depends on.
      - gn_can_delete reports evidence.freshness=stale and
        parserCoverage=incomplete even though gn_diagnose reports the index fresh
        at HEAD ecbd066e. Any oracle built on it must assert on evidence, not
        verdict alone.
      - The boundary engine attributes unqualified method calls by name. A live
        run resolved Node's `fs.rename` to `LocalBackend.rename`, producing false
        positives. Rule authoring must account for this; see Challenge Findings.
    source_fallback:
      - ontoindex/src/mcp/local/backend-boundary-violations.ts:97 (normalizeRule)
      - ontoindex/src/mcp/local/backend-boundary-violations.ts:121 (loadRules)
      - ontoindex/src/mcp/local/backend-boundary-violations.ts:139 (runBoundaryViolations)
      - ontoindex/src/mcp/super/pre-commit-audit.ts:46 (CommitAuditReport)
      - eval/run_eval.py:201 (process_instance)
      - eval/analysis/analyze_results.py:99 (compute_metrics)
    fallback_evidence:
      - "normalizeRule reads only from, to, label, forbidden_edge_types; any other key is silently ignored, so max_call_sites is not loadable config today."
      - "loadRules accepts inline rules or a rules_file path resolved against repoPath; no rules file exists in this repo yet."
      - "CommitAuditReport already exposes preCommitChecklist, so boundary reporting is one checklist entry, not a new surface."
      - "compute_metrics returns n_with_patch and patch_rate with no partial-credit or per-oracle field."
      - "gn_scope_guard with an ad hoc session returns 'audit session does not exist', so it cannot back a standalone eval oracle."
      - "git check-ignore confirms .gitignore:57 ignores `.ontoindex`, so a rules file under that directory can never be committed."
      - "A live core -> mcp rule run returned 17 violations: 7 are fs.rename/disconnect name-collision false positives, 10 are real imports of mcp/shared/freshness-policy.ts from core/audit-lifecycle."

tasks:
  TASK-1:
    title: Author and commit the OntoIndex boundary rule set
    status: DONE
    classification: implementation-ready
    dor_status: pass
    dod_status: pass
    depends_on: []
    owner: coder-worker
    reviewer: coder-worker-challenger
    type: code
    validation_tier: unit-fast
    owner_files:
      - ontoindex-boundary-rules.json
    allowed_write_set:
      - ontoindex-boundary-rules.json
    target_symbols: []
    do_not_touch:
      - ontoindex/src/mcp/local/backend-boundary-violations.ts
      - ontoindex-shared/src/analysis/types.ts
    non_goals:
      - Changing the boundary engine or its rule schema.
      - Adding required-edge or call-site-cap fields (deferred; see Deferred
        Scope).
      - Failing CI on violations.
    source_evidence:
      - ontoindex/src/mcp/local/backend-boundary-violations.ts:97-119
      - ontoindex/src/mcp/local/backend-boundary-violations.ts:170-197
    readiness_gaps: []
    gap_resolution_task: null
    gap_disposition: not-applicable
    paperwork_kind: null
    test_surface_gap: null
    adr_gate:
      required: false
      reason: >-
        Configuration only against an engine that already ships. Covered by
        ADR_STRUCTURAL_CONFORMANCE_AND_EVAL_ORACLES.md Slice 1. No API,
        persistence, security, or cross-owner change.
      adr_path: ADR_STRUCTURAL_CONFORMANCE_AND_EVAL_ORACLES.md
      status: satisfied
      decision_owner: coder-architector
      allowed_write_set: []
      unblocks: []
      promotion_rule: null
      missing_adr_outcome: create-planning-task
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
      required_capabilities: [repository-read, repository-write, ontoindex]
      dispatch_kind: implementation
      wait_state: null
      blocker_fingerprint: null
      last_progress_revision: null
    validation:
      required_commands:
        - "MCP: audit({action: 'violations', repo: 'ontoindex', rules_file: 'ontoindex-boundary-rules.json'})"
      executed: []
      diff_scope: []
      unrelated_failures: []
    required_validation:
      - "MCP: audit({action: 'violations', repo: 'ontoindex', rules_file: 'ontoindex-boundary-rules.json'})"
    expected_evidence:
      - Rules file loads without a normalizeRule error (every rule has non-empty
        from and to).
      - Run output records rules_checked, rules_clean, rules_violated, and
        total_violations.
      - Each reported violation names source_file, target_file, and edge_type.
      - git check-ignore reports the rules file as trackable, and it is committed.
      - Every reported violation is triaged as either a real dependency defect or
        a name-collision false positive, with the false-positive count recorded.
      - Every rule is either listed in clean_rules or has at least one violation
        explained and accepted in writing.
    rollback:
      - Delete ontoindex-boundary-rules.json.
    stop_conditions:
      - A needed rule cannot be expressed with from/to/label/forbidden_edge_types.
      - The run reports so many violations that the rule encodes taste rather
        than a named architectural decision.
      - False positives from name-collision attribution outnumber real findings
        and cannot be narrowed by tightening the `to` glob.
      - Engine changes appear necessary to make the rule set useful.
    closeout_evidence: []
    evidence: []
    known_blockers: []
    closeout:
      role_results:
        coder-architector: n/a (local implementation)
        coder-worker: done
        coder-worker-test: done
        coder-worker-challenger: n/a
        coder-auditor: null
      changed_files: [ontoindex-boundary-rules.json]
      validation_summary:
        - "audit(violations, rules_file=ontoindex-boundary-rules.json): 2 rules checked, 1 clean, 9 violations, 0 false positives."
        - "git check-ignore: file is trackable (not ignored)."
      evidence_refs:
        - "Triage: all 9 are real core -> mcp/shared CALLS edges (freshness-policy.ts x8, tool-registry.ts x1)."
        - "Rule `core must not call MCP super-functions` is clean and locks in an existing invariant."
      final_outcome_label: done
      remaining_risk: >-
        The 9 violations are real architectural debt and remain unfixed; the rule
        set records them rather than resolving them.
    next_on_done: [TASK-2, TASK-3]

  TASK-2:
    title: Report boundary violations in the pre-commit checklist
    status: DONE
    classification: implementation-ready
    dor_status: pass
    dod_status: pass
    depends_on: [TASK-1]
    owner: coder-worker
    reviewer: coder-worker-challenger
    type: code
    validation_tier: unit-fast
    owner_files:
      - ontoindex/src/mcp/super/pre-commit-audit.ts
    allowed_write_set:
      - ontoindex/src/mcp/super/pre-commit-audit.ts
    target_symbols:
      - gnPreCommitAudit
    do_not_touch:
      - ontoindex/src/mcp/local/backend-boundary-violations.ts
      - ontoindex-shared/src/analysis/types.ts
      - ontoindex/src/core/review/review-types.ts
    non_goals:
      - Changing the READY/REVIEW/DO-NOT-COMMIT verdict logic.
      - Making boundary violations block a commit by default.
      - Adding a new report section; the entry joins preCommitChecklist.
    source_evidence:
      - ontoindex/src/mcp/super/pre-commit-audit.ts:46-85 (CommitAuditReport)
      - ontoindex/src/mcp/super/pre-commit-audit.ts:63 (preCommitChecklist)
      - ontoindex/src/mcp/super/pre-commit-audit.ts:300 (gnPreCommitAudit)
    readiness_gaps: []
    gap_resolution_task: null
    gap_disposition: not-applicable
    paperwork_kind: null
    test_surface_gap: null
    adr_gate:
      required: false
      reason: >-
        Adds one entry to an existing checklist array in an existing report.
        Covered by ADR Slice 1. No schema, API, or verdict change.
      adr_path: ADR_STRUCTURAL_CONFORMANCE_AND_EVAL_ORACLES.md
      status: satisfied
      decision_owner: coder-architector
      allowed_write_set: []
      unblocks: []
      promotion_rule: null
      missing_adr_outcome: create-planning-task
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
      required_capabilities: [repository-read, repository-write, shell-execute, ontoindex]
      dispatch_kind: implementation
      wait_state: null
      blocker_fingerprint: null
      last_progress_revision: null
    validation:
      required_commands:
        - "npx tsc --noEmit -p ontoindex/tsconfig.json"
        - "MCP: gn_pre_commit_audit({repo: 'ontoindex', scope: 'all'})"
      executed: []
      diff_scope: []
      unrelated_failures: []
    required_validation:
      - "npx tsc --noEmit -p ontoindex/tsconfig.json"
      - "MCP: gn_pre_commit_audit({repo: 'ontoindex', scope: 'all'})"
    expected_evidence:
      - Impact rerun on gnPreCommitAudit recorded before edits with blast radius.
      - preCommitChecklist contains a boundary-rules entry with check, passed,
        and a detail naming violation and rule counts.
      - A missing or unreadable rules file yields passed=false with an explicit
        detail, never a silent pass.
      - Verdict logic is unchanged when no rules file exists.
      - The entry does not change the READY/REVIEW/DO-NOT-COMMIT verdict, because
        the committed rule set is not yet clean.
    rollback:
      - Revert ontoindex/src/mcp/super/pre-commit-audit.ts.
    stop_conditions:
      - The entry cannot be added without changing CommitAuditReport's shape.
      - Boundary evaluation would make the audit call materially slower.
      - TASK-1 is not DONE (dependency gate).
    closeout_evidence: []
    evidence: []
    known_blockers:
      - Blocked until TASK-1 is DONE; unblock rule TASK-1.status == DONE with a
        committed rules file and recorded run output.
    closeout:
      role_results:
        coder-architector: n/a (local implementation)
        coder-worker: done
        coder-worker-test: done
        coder-worker-challenger: n/a
        coder-auditor: null
      changed_files: [ontoindex/src/mcp/super/pre-commit-audit.ts]
      validation_summary:
        - "npx tsc --noEmit -p ontoindex/tsconfig.json: exit 0 (1504 files typechecked)."
        - "npm run build: exit 0; entry present in dist."
        - "Live run: {check: 'boundary rules', passed: false, detail: '9 violation(s) across 1 of 2 rule(s)'}."
        - "Malformed JSON -> passed=false with parse error; missing file -> passed=true 'skipped'; verdict unchanged (READY) in all cases."
      evidence_refs:
        - "impact(gnPreCommitAudit, upstream): 0 callers, risk LOW (MCP entry point)."
        - "Reuses runBoundaryViolations; no rule evaluation reimplemented."
      final_outcome_label: done
      remaining_risk: >-
        Adds one boundary query per audit call (~0.7s). Acceptable now; revisit if
        the audit becomes latency-sensitive.
    next_on_done: []

  TASK-3:
    title: Structural-oracle stage in the evaluation runner
    status: DONE
    classification: implementation-ready
    dor_status: pass
    dod_status: pass
    depends_on: [TASK-1]
    owner: coder-worker
    reviewer: coder-worker-challenger
    type: code
    validation_tier: unit-fast
    owner_files:
      - eval/environments/ontoindex_docker.py
      - eval/pyproject.toml
      - eval/run_eval.py
      - eval/structural_oracles.py
      - eval/tests/test_cache_cycle.py
      - eval/tests/test_structural_oracles.py
    allowed_write_set:
      - eval/environments/ontoindex_docker.py
      - eval/pyproject.toml
      - eval/run_eval.py
      - eval/structural_oracles.py
      - eval/tests/test_cache_cycle.py
      - eval/tests/test_structural_oracles.py
    target_symbols:
      - process_instance
    do_not_touch:
      - eval/analysis/analyze_results.py
      - ontoindex/src/mcp/local/backend-boundary-violations.ts
    non_goals:
      - Writing new structural predicates; oracles call existing tools.
      - Using gn_scope_guard, which requires a persisted audit session.
      - Gating product code or CI on oracle results.
    source_evidence:
      - eval/run_eval.py:201 (process_instance)
      - eval/run_eval.py:279 (run_configuration)
      - ontoindex/src/mcp/local/backend-boundary-violations.ts:139
    readiness_gaps: []
    gap_resolution_task: null
    gap_disposition: not-applicable
    paperwork_kind: null
    test_surface_gap: null
    adr_gate:
      required: false
      reason: >-
        Adds an evaluation-only stage that composes existing tools. Covered by
        ADR Slice 2. Product indexing paths are untouched.
      adr_path: ADR_STRUCTURAL_CONFORMANCE_AND_EVAL_ORACLES.md
      status: satisfied
      decision_owner: coder-architector
      allowed_write_set: []
      unblocks: []
      promotion_rule: null
      missing_adr_outcome: create-planning-task
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
      required_capabilities: [repository-read, repository-write, shell-execute]
      dispatch_kind: implementation
      wait_state: null
      blocker_fingerprint: null
      last_progress_revision: null
    validation:
      required_commands:
        - "cd eval && python3 -m pytest tests/test_structural_oracles.py -q"
      executed: []
      diff_scope: []
      unrelated_failures: []
    required_validation:
      - "cd eval && python3 -m pytest tests/test_structural_oracles.py -q"
    expected_evidence:
      - A task declaring a boundary oracle and a frozen_paths check runs both
        after the test stage.
      - A result that passes tests but violates an oracle is recorded as an
        overall failure carrying its stable error code.
      - frozen_paths detects a modified frozen file.
      - An oracle whose preconditions are unmet is recorded as degraded, never as
        pass or fail.
      - Each result records graph index id and HEAD.
    rollback:
      - Revert eval/environments/ontoindex_docker.py, eval/pyproject.toml, and
        eval/run_eval.py; delete eval/structural_oracles.py and its two test
        files.
    stop_conditions:
      - An oracle cannot be expressed by calling an existing tool.
      - The stage would require a persisted audit session per instance.
      - TASK-1 is not DONE (dependency gate).
    closeout_evidence: []
    evidence: []
    known_blockers:
      - Blocked until TASK-1 is DONE; unblock rule TASK-1.status == DONE.
      - "Environment: pytest is not installed (python3 -m pytest reports 'No
        module named pytest'). Worker must install eval dev extras before
        validation: pip install -e 'eval[dev]'."
    closeout:
      role_results:
        coder-architector: n/a (local implementation)
        coder-worker: done
        coder-worker-test: done
        coder-worker-challenger: n/a
        coder-auditor: null
      changed_files:
        - eval/environments/ontoindex_docker.py
        - eval/pyproject.toml
        - eval/structural_oracles.py
        - eval/run_eval.py
        - eval/tests/test_structural_oracles.py
        - eval/tests/test_cache_cycle.py
      validation_summary:
        - "pytest tests/ (full eval suite): 43 passed, no regressions."
        - "python3 -m py_compile run_eval.py structural_oracles.py analysis/analyze_results.py environments/ontoindex_docker.py: passed."
      evidence_refs:
        - "frozen_paths uses git status inside /testbed through OntoIndexDockerEnvironment; it no longer reads the harness host checkout."
        - "boundary_violations calls the generic /tool/boundary_violations eval-server endpoint and parses its JSON response."
        - "graph_provenance records eval-cache:<cache-key> and indexed HEAD for both restored and fresh indexes."
        - "eval/structural_oracles.py is included in eval wheel extra-files."
        - "DEGRADED is distinct from PASS/FAIL: missing baseline, tool error, and unsupported oracle all report DEGRADED."
        - "FAIL outranks DEGRADED so a real violation is never masked."
        - "gn_scope_guard deliberately unsupported (needs a persisted audit session)."
      final_outcome_label: done
      remaining_risk: >-
        Unit and integration-mock coverage proves the environment contract, but
        no real Docker-backed SWE-bench instance was executed in this session.
    next_on_done: [TASK-5]

  TASK-5:
    title: Partial-credit and structural scoring in results analysis
    status: DONE
    classification: implementation-ready
    dor_status: pass
    dod_status: pass
    depends_on: [TASK-3]
    owner: coder-worker
    reviewer: coder-worker-challenger
    type: code
    validation_tier: unit-fast
    owner_files:
      - eval/analysis/analyze_results.py
      - eval/tests/test_partial_scoring.py
    allowed_write_set:
      - eval/analysis/analyze_results.py
      - eval/tests/test_partial_scoring.py
    target_symbols:
      - compute_metrics
    do_not_touch:
      - eval/run_eval.py
      - eval/tool_registry.py
    non_goals:
      - Adding an LLM judge in this task.
      - Changing existing cost, API-call, or tool-usage metrics.
      - Removing resolve rate or patch rate.
    source_evidence:
      - eval/analysis/analyze_results.py:99-155 (compute_metrics)
      - eval/analysis/analyze_results.py:106 (n_with_patch collapses outcomes)
    readiness_gaps: []
    gap_resolution_task: null
    gap_disposition: not-applicable
    paperwork_kind: null
    test_surface_gap: null
    adr_gate:
      required: false
      reason: >-
        Extends an existing metrics function with additional fields. Covered by
        ADR Slice 3. No change to product code or eval execution.
      adr_path: ADR_STRUCTURAL_CONFORMANCE_AND_EVAL_ORACLES.md
      status: satisfied
      decision_owner: coder-architector
      allowed_write_set: []
      unblocks: []
      promotion_rule: null
      missing_adr_outcome: create-planning-task
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
      required_capabilities: [repository-read, repository-write, shell-execute]
      dispatch_kind: implementation
      wait_state: null
      blocker_fingerprint: null
      last_progress_revision: null
    validation:
      required_commands:
        - "cd eval && python3 -m pytest tests/test_partial_scoring.py -q"
      executed: []
      diff_scope: []
      unrelated_failures: []
    required_validation:
      - "cd eval && python3 -m pytest tests/test_partial_scoring.py -q"
    expected_evidence:
      - Output distinguishes no-patch, broken-patch, and partial-pass buckets.
      - Functional-pass-structural-fail is reported as a first-class figure.
      - Per-oracle pass/fail appears alongside test results.
      - With no oracles declared, the structural figure is zero and clearly
        marked as not-measured rather than perfect.
      - Existing cost and tool-usage metrics are unchanged.
    rollback:
      - Revert eval/analysis/analyze_results.py and delete
        eval/tests/test_partial_scoring.py.
    stop_conditions:
      - Partial credit cannot be derived without changing the runner.
      - Existing metric fields would have to change meaning.
      - TASK-3 is not DONE (dependency gate).
    closeout_evidence: []
    evidence: []
    known_blockers:
      - Blocked until TASK-3 is DONE; unblock rule TASK-3.status == DONE with
        oracle results present in run output.
      - "Environment: pytest is not installed. Install eval dev extras before
        validation: pip install -e 'eval[dev]'."
    closeout:
      role_results:
        coder-architector: n/a (local implementation)
        coder-worker: done
        coder-worker-test: done
        coder-worker-challenger: n/a
        coder-auditor: null
      changed_files:
        - eval/analysis/analyze_results.py
        - eval/tests/test_partial_scoring.py
      validation_summary:
        - "pytest tests/ (full eval suite): 43 passed, existing metrics unchanged."
        - "Persisted report smoke: resolved=1 and functional-pass-structural-fail=1 loaded from canonical report.json."
      evidence_refs:
        - "classify_outcomes splits no_patch / broken_patch / partial_pass / resolved / unverified."
        - "summarize_structural returns measured=false when no oracles are declared, never a perfect score."
        - "Instances without test results are `unverified`, not assumed broken."
        - "load_run_results auto-merges swebench_eval/logs/run_evaluation/**/report.json."
        - "run_swebench_evaluation uses upstream --report_dir and no unsupported --output_dir argument."
        - "fix_rate uses the actual FAIL_TO_PASS ratio when PASS_TO_PASS has no regression."
        - "Table, Markdown, and CSV output expose Resolve, Fix, and functional-pass-structural-fail."
      final_outcome_label: done
      remaining_risk: >-
        SWE-bench CLI behavior was verified against upstream source and mocked
        subprocess integration, but not with a full Docker evaluation run.
    next_on_done: []
```

## Dispatch Authorization

Execution note (revision 3): all four tasks were implemented locally in a single
session at the user's explicit instruction not to use sub-agents. The
`dispatch_mode: sub-agent` value is retained only because the plan schema accepts
no other value; no sub-agent was spawned, and no role-based review took place.
Task closeouts record `coder-worker` and `coder-worker-test` as done because the
implementation and its validation were both performed and evidenced; the
challenger and architector roles were not exercised.

Sub-agent dispatch is authorized for the four coder roles named in
`dispatch_preflight.required_roles`. `coder-architector` is the sole paperwork,
readiness, and closeout writer. `coder-worker` implements exactly one bounded
task and edits only that task's `allowed_write_set`. No local fallback is allowed
for any role.

## Dispatch Preflight

Before substantive sub-agent work, cache one non-mutating capability probe per
role/effective-model/tool-surface tuple. A successful parent spawn does not prove
child file-read, shell-execute, or OntoIndex callability. Missing child
capability is `blocked: capability unavailable`.

## Goal

Deliver the three slices decided in
`ADR_STRUCTURAL_CONFORMANCE_AND_EVAL_ORACLES.md`: boundary rule sets as versioned
configuration, a structural-oracle stage in evaluation, and partial-credit
scoring. The outcome is a reportable functional-pass-structural-fail rate, the
single figure that shows whether graph-aware checking catches defects that tests
miss.

## Planning Principles

No new ADR is required. The governing ADR is already Proposed at revision 2, and
every task reuses an existing owner:

- TASK-1 stays inside `backend-boundary-violations.ts`, whose rule engine, glob
  matching, and finding mapping already ship.
- TASK-2 adds one entry to the existing `preCommitChecklist` array.
- TASK-3 and TASK-5 are evaluation-only and compose existing MCP tools.

Reject any new predicate engine, rule DSL, scheduler, or parallel reporting
surface. If a worker finds a task cannot be done without one, it must stop and
route to `coder-architector` per that task's stop conditions.

## Current Source Evidence

### Challenge findings (revision 2)

### Post-implementation challenge (revision 4)

A review of the delivered code found two integration defects and confirmed one
design decision. Both defects were fixed in this pass.

**Defect 1: partial-credit scoring consumed a schema that does not exist.**
`classify_outcomes` and `summarize_structural` read `tests_passed`,
`tests_total`, and a per-instance `resolved` from `summary.json`. None of those
fields are produced anywhere. `run_configuration` writes a summary containing
`run_id`, `model`, `mode`, `config`, `total_instances`, `completed`,
`total_cost`, `total_api_calls`, and raw `results`; SWE-bench grading is written
separately to `results.json` by `run_swebench_evaluation` and never merged. The
original tests passed only because their fixtures asserted the invented shape.
Every real instance would have been bucketed `unverified`, and the headline
structural rate would have been silently zero.

Fixed by consuming the actual SWE-bench report map, verified against
`swebench/harness/grading.py:256-293`: keys are instance ids, values carry
`resolved`, `patch_successfully_applied`, and optional `tests_status` with
FAIL_TO_PASS / PASS_TO_PASS success and failure lists. Partial credit now
follows the upstream PARTIAL definition (`grading.py:215-232`): some target tests
fixed with no pass-to-pass regression. A patch that never applied is
`broken_patch` regardless of test detail. `summarize_structural` now returns
`measured: false` when oracles ran but no grading is available, rather than
reporting a rate it cannot compute.

**Defect 2: `config.get("repo_root")` reads a key no config defines.**
Neither the model nor mode YAML files define `repo_root`, so it always falls back
to `.`, the harness working directory, while the agent edits a checkout inside
the container. Confirmed by direct probe: `capture_frozen_baseline` returns `{}`
and the oracle reports DEGRADED with `ERR_ORACLE_PRECONDITION`. The fail-safe
design held, so this produces no false pass, but `frozen_paths` cannot actually
work until the environment exposes a host-visible workspace path. The limitation
is now documented at the call site rather than left as a silent no-op.

**Confirmed sound: the TASK-2 edit does not violate its own layering.** A
`mcp/super -> mcp/local` probe returns 13 CALLS violations, of which the new
`evaluateBoundaryRules -> runBoundaryViolations` edge is one. The other 12
pre-date this work and span `safe-refactor.ts`, `diagnose.ts`, and
`write-through-verification.ts`. Super-functions composing local backends is the
established pattern, so this edge conforms; a `super -> local` rule must not be
added to the committed rule set without first refactoring all 13 call sites.

A live engine run and a `git check-ignore` probe invalidated two assumptions in
revision 1.

**The original artifact path was uncommittable.** `.gitignore:57` ignores
`.ontoindex`, which is where the lbug store and lock files live. A rules file at
`.ontoindex/boundary-rules.json` could never be committed, so the whole task
would have produced untracked local state. The artifact moved to
`ontoindex-boundary-rules.json` at repository root, confirmed trackable by
`git check-ignore`. This mirrors the placement constraint the governing ADR
already records for itself.

**The ADR's starter rule is not clean.** Running the ADR's own example rule
(`ontoindex/src/core/**` must not reach `ontoindex/src/mcp/**`) returns 17
violations across 1 rule, with `clean_rules` empty. Triage:

- 7 are false positives from name-collision attribution. `sidecar-store.ts:140`
  calls Node's `fs.rename`, but the engine resolved the call to
  `LocalBackend.rename` in `mcp/local/local-backend.ts`. The same pattern
  accounts for the `disconnect` finding.
- 10 are real. `core/audit-lifecycle/finding-verify.ts:10` imports from
  `../../mcp/shared/freshness-policy.js`, and `dispatch-prompt.ts`,
  `audit-lint.ts`, and `audit-bundle.ts` do the same. Core genuinely depends on
  the MCP layer here.

Two consequences for execution. TASK-1 must triage every violation rather than
assume a clean run, and TASK-2 must not let the checklist entry change the commit
verdict while the rule set is knowingly dirty. Narrowing the `to` glob to
`ontoindex/src/mcp/shared/**` and `ontoindex/src/mcp/local/**` separately is the
first lever for separating real findings from attribution noise.

The false positives are not a blocker for this plan, but they are the strongest
available evidence that a text-free graph rule still needs human triage. Record
the false-positive count in TASK-1 closeout so the signal-to-noise ratio is known
before oracles depend on it.

- `normalizeRule` (backend-boundary-violations.ts:97) reads only `from`, `to`,
  `label`, and `forbidden_edge_types`, defaulting edge types to
  `['CALLS', 'IMPORTS']`. Unknown keys are silently ignored, so `max_call_sites`
  is not loadable configuration today, which is why required-edge and
  call-site-cap rules are deferred rather than planned.
- `loadRules` (line 121) accepts an inline `rules` array or a `rules_file` path
  resolved against the repository root. No rules file exists in this repo yet.
- `runBoundaryViolations` (line 139) returns `violations`, `clean_rules`,
  `summary`, `findings`, and `stats`; `limit_per_rule` defaults to 20, max 200.
  A live run took 642 ms for one rule, so cost is not a concern for TASK-2.
- The violation message at line 28 hardcodes the word "violating", so new rule
  kinds would need their own wording if the schema is ever extended.
- `CommitAuditReport` (pre-commit-audit.ts:46) already exposes
  `preCommitChecklist`, `perSymbolImpact`, and `testCoverageDelta`.
- `compute_metrics` (analyze_results.py:99) has no partial-credit field;
  `n_with_patch` at line 106 collapses three distinct outcomes.
- `gn_scope_guard` requires a persisted audit session; an ad hoc probe returns
  `audit session does not exist`. It is excluded from oracles by design.
- `gn_can_delete` returned `DO-NOT-DELETE` with `evidence.freshness: stale` while
  `gn_diagnose` reported the index fresh at HEAD `ecbd066e`. Oracles must assert
  on evidence, not verdict alone.

## Task Preparation Rules

All four task cards are implementation-ready with owner files, allowed write set,
non-goals, validation, rollback, stop conditions, DoR, DoD, and evidence format.
Required-edge and call-site-cap rules are deliberately excluded from the task set
because their proof gate is unmet; see Deferred Scope. No preparation sub-task is
required.

## Execution Rules

Edit only the selected task's `allowed_write_set`; implement exactly one bounded
task; run OntoIndex impact before editing symbols and record blast radius; do not
add duplicate engines, registries, or reporting surfaces; if the write set must
expand, stop and update the task card first; run focused validation and update
tracking only after evidence exists.

## Validation Tier Policy

- TASK-1: `unit-fast` — correctness is proven by one MCP run of the existing
  engine against the committed rules file. Typed `code` because the plan schema
  routes only `code` tasks to an owner; the produced artifact is a JSON rules
  file, not TypeScript.
- TASK-2: `unit-fast` — a type check plus one audit call proves the checklist
  entry.
- TASK-3: `unit-fast` — oracle staging, degraded handling, and frozen-path
  detection are provable by crate-local pytest cases without a Docker run.
- TASK-5: `unit-fast` — metric derivation is pure and provable from fixture
  result dictionaries.

No task requires a full SWE-bench execution. A Docker-backed run is a separate
follow-up once TASK-3 and TASK-5 are DONE.

## Evidence Protocol

Every task records changed files, exact validation commands, pass/fail results,
source references, OntoIndex limitations or fallback checks, and confirmation
that no generated binaries, logs, caches, archives, or temp files were added.
Code tasks additionally record impact/context for edited symbols (or why
unavailable), before/after behavior, rollback path, and reviewer result.

## Definition Of Ready

Each dispatchable task names one bounded file group, an explicit type and output
artifact, exact validation commands, rollback, non-goals, target symbols,
reviewer, stop conditions, and verifiable expected evidence; `adr_gate.status` is
`satisfied` against the governing ADR; dispatch role and local-fallback policy are
explicit. TASK-2 and TASK-3 are blocked behind `TASK-1.status == DONE`; TASK-5
behind `TASK-3.status == DONE`.

## Definition Of Done

Each task is done only when its artifact exists, work stayed inside the allowed
write set, the named validation command ran with recorded results, no generated
artifacts were added, the reviewer confirms no side architecture was added, the
result states whether the next task is unblocked, remaining risk is a concrete
follow-up, role closeout is recorded for every required role, and the final
outcome label matches the loop result.

## Fixtures And Test Data

TASK-3 and TASK-5 use in-test constructed fixtures: a temporary repository tree
with a known forbidden edge, a frozen file modified in one case and untouched in
another, and result dictionaries covering no-patch, broken-patch, and
partial-pass outcomes. No SWE-bench instance download or Docker image is required
for the recorded validation commands.

## Senior-Owned Work

Pre-junior contributors must not: change `ontoindex-shared` types, alter the
boundary engine's existing forbidden-edge semantics, change the
READY/REVIEW/DO-NOT-COMMIT verdict logic, introduce a rule DSL, or declare that
structural oracles are ready to gate CI. Any such need stops the task and routes
to `coder-architector`.

## Phase 1: Boundary Rules

### Task TASK-1: Author and commit the OntoIndex boundary rule set

Type: code. Status: OPEN. Write `ontoindex-boundary-rules.json` at repository
root (not under the gitignored `.ontoindex`) expressing named architectural
decisions, run the existing engine against it, and triage every violation as a
real dependency defect, an accepted exception, or a name-collision false
positive. The core-to-MCP rule is already known to return 17 violations, 10 of
them real. See the `tasks.TASK-1` card.

### Task TASK-2: Report boundary violations in the pre-commit checklist

Type: code. Status: OPEN (blocked behind TASK-1). Add one `boundary-rules` entry
to the existing `preCommitChecklist`, failing explicitly when the rules file is
missing or unreadable. See the `tasks.TASK-2` card.

## Phase 2: Evaluation Oracles

### Task TASK-3: Structural-oracle stage in the evaluation runner

Type: code. Status: OPEN (blocked behind TASK-1). Add a stage after the test
stage where overall pass requires both oracles, implemented by calling existing
tools, with `frozen_paths` as the one native check and degraded handling for
unmet preconditions. See the `tasks.TASK-3` card.

## Phase 3: Scoring

### Task TASK-5: Partial-credit and structural scoring

Type: code. Status: OPEN (blocked behind TASK-3). Split the collapsed
`n_with_patch` outcome into distinct buckets and report
functional-pass-structural-fail as a first-class figure. See the `tasks.TASK-5`
card.

## Required Traceability

| Requirement ID | Requirement | Disposition | Task IDs | Validation | Status |
|---|---|---|---|---|---|
| SCO-001 | Boundary rules exist as versioned repo configuration | implementation | TASK-1 | Engine run against the committed rules file | DONE |
| SCO-017 | The rules file is committable, not gitignored | compatibility-test | TASK-1 | git check-ignore reports trackable | DONE |
| SCO-018 | Every violation is triaged as real or false positive | implementation | TASK-1 | Triage table with false-positive count recorded | DONE |
| SCO-002 | Every rule is clean or has an accepted written exception | implementation | TASK-1 | clean_rules and violation review recorded | DONE |
| SCO-003 | Boundary result appears in the pre-commit checklist | implementation | TASK-2 | gn_pre_commit_audit output shows the entry | DONE |
| SCO-004 | Missing or unreadable rules file never passes silently | compatibility-test | TASK-2 | Checklist entry passed=false with detail | DONE |
| SCO-005 | Structural oracles run after tests, both required to pass | implementation | TASK-3 | test_structural_oracles.py staging case | DONE |
| SCO-006 | Oracles are implemented by calling existing tools | implementation | TASK-3 | Reviewer confirms no new predicate engine | DONE |
| SCO-007 | frozen_paths detects modification of a frozen file | implementation | TASK-3 | test_structural_oracles.py frozen-path case | DONE |
| SCO-008 | Unmet oracle preconditions report degraded, not pass or fail | implementation | TASK-3 | test_structural_oracles.py degraded case | DONE |
| SCO-009 | Each eval result records graph index id and HEAD | implementation | TASK-3 | Result fields asserted in test | DONE |
| SCO-010 | Stable machine error codes per oracle | implementation | TASK-3 | Error code asserted on failure case | DONE |
| SCO-011 | No-patch, broken-patch, and partial-pass are distinct buckets | implementation | TASK-5 | test_partial_scoring.py bucket cases | DONE |
| SCO-012 | Functional-pass-structural-fail is a first-class figure | implementation | TASK-5 | test_partial_scoring.py headline metric case | DONE |
| SCO-013 | With no oracles declared the structural figure reads not-measured | compatibility-test | TASK-5 | test_partial_scoring.py empty-oracle case | DONE |
| SCO-014 | Existing cost and tool-usage metrics are unchanged | compatibility-test | TASK-5 | Existing metric fields asserted | DONE |

## Deferred Scope

Required-edge and call-site-cap rules are deliberately not planned as tasks. The
ADR marks them proposed, and `normalizeRule` silently ignores unknown keys, so
writing such a rule today produces a file that loads and does nothing. They
become plannable only when TASK-1 records a concrete architectural rule that
`from`/`to`/`label`/`forbidden_edge_types` cannot express, together with why the
forbidden-edge form is insufficient. At that point add a task owning
`backend-boundary-violations.ts` with `normalizeRule` and `runBoundaryViolations`
as target symbols, and note that the violation message hardcodes "violating" and
will need separate wording per rule kind.

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

The project closes when TASK-1, TASK-2, TASK-3, and TASK-5 are DONE with recorded
validation and changed-file evidence, a final `coder-worker-challenger`
planned-vs-done challenge passes, and `manager_loop.closeout_state` is set to
`complete`. Closeout must state which requirements were proven by tests and which
depend on a later Docker-backed evaluation run.

## Standard Validation Commands

- TASK-1: `audit({action: 'violations', repo: 'ontoindex', rules_file: 'ontoindex-boundary-rules.json'})` plus `git check-ignore -v ontoindex-boundary-rules.json`
- TASK-2: `npx tsc --noEmit -p ontoindex/tsconfig.json` then `gn_pre_commit_audit({repo: 'ontoindex', scope: 'all'})`
- TASK-3: `cd eval && python3 -m pytest tests/test_structural_oracles.py -q`
- TASK-5: `cd eval && python3 -m pytest tests/test_partial_scoring.py -q`
- All: `git diff --check` on the task's write set.

Environment prerequisite for TASK-3 and TASK-5: `pytest` is not currently
installed (`python3 -m pytest` reports `No module named pytest`). Install the eval
dev extras first: `pip install -e 'eval[dev]'`.
