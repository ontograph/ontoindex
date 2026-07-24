# GLM-5.2 Max OntoIndex MCP Compatibility Project Plan

Date: 2026-07-18
Status: In progress, architecture gate accepted
Audience: Human/main-session implementers and current coder-role agents
Authority: `GLM_5_2_MAX_ONTOINDEX_MCP_TEST_PLAN.md`, current source evidence, and `.memory-bank/audit_session-2026-06-19-openai-only-provider-policy.md`. That policy authorizes user-configured external OpenAI-compatible endpoints, but it does not decide provider-dependent tool namespace encoding. TASK-0.0 must produce and accept that boundary ADR before product implementation.

## Manager Tracking

```yaml
manager_loop:
  status: in-progress
  active_next_task: TASK-3.0
  selected_task: null
  no_selected_task_reason: null
  last_decision:
    outcome: null
    label: null
    reason: null
    planning_work_considered: true
    reopen_gate: null
  closeout_state: in-progress
  dispatch_mode: sub-agent
  selection_policy: active_next_task-first
  auto_continue: until-stop-condition
  dispatch_preflight:
    tool_surface: available-with-role-limitations
    child_capability_probes:
      coder-architector: "failed: role-result envelope protocol; ADR artifact independently verified"
      coder-worker-challenger: "pass via bounded evidence packet; child lacked direct repository/OntoIndex tools"
    required_roles:
      coder-architector:
        agent_type_candidates: [coder-architector]
        model_candidates: [claude-opus-4-8]
        reasoning_effort: high
        local_fallback_allowed: false
        required_for: [dor-dod-adr-gate, paperwork, readiness, closeout]
      coder-worker:
        agent_type_candidates: [coder-worker]
        model_candidates: [gpt-5.6-sol]
        reasoning_effort: medium
        local_fallback_allowed: false
        required_for: [implementation]
      coder-worker-test:
        agent_type_candidates: [coder-worker-test]
        model_candidates: [claude-opus-4-6-thinking]
        reasoning_effort: medium
        local_fallback_allowed: false
        required_for: [verification]
      coder-worker-challenger:
        agent_type_candidates: [coder-worker-challenger]
        model_candidates: [claude-opus-4-6-thinking]
        reasoning_effort: medium
        local_fallback_allowed: false
        required_for: [challenge]
    fork_context: false
    unavailable_outcome: "blocked: model/capacity"
  ontoindex:
    required: true
    status: degraded
    unavailable_action: direct-source-fallback
    tools_used:
      - gn_diagnose
      - gn_explore
      - impact
      - inspect
      - gn_find_related
      - gn_safe_edit_check
      - gn_test_gap
      - gn_test_suggestions
    limitations:
      - "The Ontocode worktree has 57 changed files; graph scope confidence is low for dirty and newly added symbols."
      - "OntoIndex reports Rust LSP available, but dirty-worktree graph scope confidence remains low."
      - "The Markdown docs sidecar is missing, so ADR search was verified from source files directly."
    source_fallback:
      - "/opt/demodb/_workfolder/ontocode/ontocode-rs/model-provider/src/provider.rs"
      - "/opt/demodb/_workfolder/ontocode/ontocode-rs/model-provider/src/descriptor.rs"
      - "/opt/demodb/_workfolder/ontocode/ontocode-rs/core/src/tools/spec_plan.rs"
      - "/opt/demodb/_workfolder/ontocode/ontocode-rs/core/src/tools/spec_plan_tests.rs"
      - "/opt/demodb/_workfolder/ontocode/ontocode-rs/core/src/tools/registry.rs"
      - "/opt/demodb/_workfolder/ontocode/ontocode-rs/core/src/tools/registry_tests.rs"
      - "/opt/demodb/_workfolder/ontocode/ontocode-rs/core/src/tools/router_tests.rs"
      - "/opt/demodb/_workfolder/ontocode/ontocode-rs/core/tests/suite/remote_models.rs"
    fallback_evidence:
      - "Current dirty source contains ToolNamespaceEncoding::{Native, Flattened}, provider selection, flattened request planning, collision rejection, and flat registry dispatch."
      - "The installed ontocode binary predates those source changes."
      - "The existing GLM integration test exercises a plain shell tool, not MCP."

tasks:
  TASK-0.0:
    title: Decide the OpenAI-compatible tool namespace encoding boundary
    status: DONE
    classification: completed
    dor_status: pass
    dod_status: pass
    depends_on: []
    owner: coder-architector
    reviewer: coder-worker-challenger
    type: design-gate
    validation_tier: static
    owner_files:
      - .memory-bank/ADR_OPENAI_COMPATIBLE_TOOL_NAMESPACE_ENCODING.md
    allowed_write_set:
      - .memory-bank/ADR_OPENAI_COMPATIBLE_TOOL_NAMESPACE_ENCODING.md
    target_symbols: []
    do_not_touch:
      - ontocode-rs/**
      - /opt/demodb/_workfolder/OntoIndex/GLM_5_2_MAX_ONTOINDEX_MCP_TEST_PLAN.md
    non_goals:
      - Implement provider or tool changes.
      - Authorize generic GetMcpTools or CallMcpTool handlers.
      - Change OntoIndex MCP server behavior.
    source_evidence:
      - "External non-OpenAI providers are routed through user-managed OpenAI-compatible endpoints by existing policy."
      - "No existing ADR found by direct source search decides when native namespace objects must be flattened."
      - "Provider and spec-planning edit surfaces are LOW graph risk; built_tools is CRITICAL/DANGEROUS and excluded."
    readiness_gaps: []
    gap_resolution_task: null
    gap_disposition: not-applicable
    paperwork_kind: boundary-adr
    test_surface_gap: null
    adr_gate:
      required: true
      reason: "Provider-dependent tool declaration shape is a cross-provider compatibility and routing boundary, not a test-only choice."
      adr_path: .memory-bank/ADR_OPENAI_COMPATIBLE_TOOL_NAMESPACE_ENCODING.md
      status: accepted
      decision_owner: coder-architector
      allowed_write_set:
        - .memory-bank/ADR_OPENAI_COMPATIBLE_TOOL_NAMESPACE_ENCODING.md
      unblocks:
        - TASK-1.0
      promotion_rule: "ADR is accepted only when it defines Native versus Flattened selection, flat-name construction, collision behavior, tool_search behavior, compatibility limits, and a no-generic-gateway default."
      missing_adr_outcome: stop
    dispatch:
      role: coder-architector
      assigned_agent: 019f76ec-be57-70b1-98f3-f74e92fbd9d1
      model_requested: claude-opus-4-8
      model_effective: claude-opus-4-8
      preflight_result: "role envelope failed; one-file artifact recovered and independently reviewed"
      local_fallback_allowed: false
      local_fallback_scope: null
      attempts: 2
      max_attempts: 3
      required_capabilities: [repository-read, repository-write, ontoindex]
      dispatch_kind: implementation
      wait_state: completed-with-recovered-artifact
      blocker_fingerprint: "role-result-envelope-protocol"
      last_progress_revision: null
    validation:
      required_commands:
        - "Review the ADR against current provider, spec-plan, registry, and GLM test source."
        - "Run direct Markdown/source search for conflicting provider or namespace ADRs."
        - "Challenge the ADR with coder-worker-challenger before acceptance."
      executed:
        - "Reviewed ADR against current provider, spec-plan, registry, and GLM test source."
        - "Searched .memory-bank Markdown for conflicting provider/namespace decisions; none found."
        - "coder-worker-challenger PASS from bounded evidence packet; no critical findings."
      diff_scope:
        - .memory-bank/ADR_OPENAI_COMPATIBLE_TOOL_NAMESPACE_ENCODING.md
      unrelated_failures: []
    required_validation:
      - "ADR states the exact compatibility invariant and rejected alternatives."
      - "ADR keeps generic MCP compatibility out of scope unless later runtime evidence proves it necessary."
      - "ADR preserves existing MCP policy and execution paths."
    expected_evidence:
      - Accepted ADR path and decision summary.
      - Challenger result with no unresolved critical finding.
      - Explicit promotion of TASK-1.0 to implementation-ready.
    rollback:
      - Reject the ADR and leave all product-code tasks blocked.
    stop_conditions:
      - "Stop if the decision requires changing OntoIndex MCP server semantics."
      - "Stop if the decision cannot preserve collision-safe deterministic routing."
      - "Stop if ownership conflicts with an existing accepted provider/tool ADR."
    closeout_evidence:
      - "/opt/demodb/_workfolder/ontocode/.memory-bank/ADR_OPENAI_COMPATIBLE_TOOL_NAMESPACE_ENCODING.md is Accepted."
      - "Challenger verdict PASS with no blocking findings."
    evidence:
      - "ADR defines Native/Flattened selection, deterministic code-mode flat names, collision omission, disabled namespace-dependent tool_search, compatibility limits, preserved execution paths, and no generic gateway default."
      - "OntoIndex inspect found build_model_visible_specs_and_registry with one direct caller; graph scope confidence is low because the host worktree has 59 dirty files."
    known_blockers:
      - "Architect child role returned invalid result envelopes; its ADR artifact was treated as untrusted until independent evidence-packet challenge passed."
    closeout:
      role_results:
        coder-architector: "artifact produced; result envelope invalid"
        coder-worker: null
        coder-worker-test: null
        coder-worker-challenger: "PASS; no critical findings"
        coder-auditor: null
      changed_files:
        - .memory-bank/ADR_OPENAI_COMPATIBLE_TOOL_NAMESPACE_ENCODING.md
      validation_summary:
        - "ADR content satisfies every promotion rule."
        - "No conflicting provider-selection ADR was found."
      evidence_refs:
        - .memory-bank/ADR_OPENAI_COMPATIBLE_TOOL_NAMESPACE_ENCODING.md
      final_outcome_label: completed
      remaining_risk: "ProviderCapabilities defaults to Native; every future concrete descriptor must continue to set encoding explicitly."
    next_on_done:
      - TASK-1.0

  TASK-1.0:
    title: Finalize provider encoding and flattened model-visible tool declarations
    status: DONE
    classification: completed
    dor_status: pass
    dod_status: pass
    depends_on:
      - TASK-0.0
    owner: coder-worker
    reviewer: coder-worker-challenger
    type: code
    validation_tier: unit-fast
    owner_files:
      - ontocode-rs/model-provider/src/provider.rs
      - ontocode-rs/model-provider/src/descriptor.rs
      - ontocode-rs/core/src/tools/spec_plan.rs
      - ontocode-rs/core/src/tools/spec_plan_tests.rs
    allowed_write_set:
      - ontocode-rs/model-provider/src/provider.rs
      - ontocode-rs/model-provider/src/descriptor.rs
      - ontocode-rs/core/src/tools/spec_plan.rs
      - ontocode-rs/core/src/tools/spec_plan_tests.rs
    target_symbols:
      - ProviderCapabilities
      - ToolNamespaceEncoding
      - ProviderDescriptor::openai_compatible
      - openai_compatible_tool_namespace_encoding
      - build_model_visible_specs_and_registry
      - model_visible_specs_for_capabilities
      - search_tool_enabled
    do_not_touch:
      - ontocode-rs/core/src/session/turn.rs::built_tools
      - ontocode-rs/codex-mcp/src/connection_manager.rs
      - ontocode-rs/core/src/mcp_tool_call.rs
      - /opt/demodb/_workfolder/OntoIndex/ontoindex/**
    non_goals:
      - Add runtime telemetry to built_tools.
      - Add generic MCP gateway handlers.
      - Change MCP server startup or inventory behavior.
      - Fix unrelated compilation failures in session/turn.rs.
    source_evidence:
      - "ProviderDescriptor::openai_compatible has LOW upstream graph impact."
      - "build_model_visible_specs_and_registry has LOW upstream graph impact but no authoritative indexed coverage; current source tests are required."
      - "Existing dirty tests already cover proxy flattening, official endpoint preservation, and collision omission."
    readiness_gaps:
      - "Host-tree compilation remains blocked by an unrelated non-Send compile failure near run_sampling_request; equivalent current-source proof passed in a disposable copy."
    gap_resolution_task: null
    gap_disposition: external-validation-blocker
    paperwork_kind: null
    test_surface_gap: "Current-source tests must run after the external compile blocker is cleared by its owner."
    adr_gate:
      required: true
      reason: "TASK-0.0 must authorize the encoding contract."
      adr_path: .memory-bank/ADR_OPENAI_COMPATIBLE_TOOL_NAMESPACE_ENCODING.md
      status: accepted
      decision_owner: coder-architector
      allowed_write_set: []
      unblocks: []
      promotion_rule: "Promote this task only after TASK-0.0 is DONE and the unrelated compile blocker is cleared or formally waived with equivalent current-source proof."
      missing_adr_outcome: stop
    dispatch:
      role: coder-worker
      assigned_agent: 019f76f7-2b69-7282-98cb-e3d2764d90f2
      model_requested: gpt-5.6-sol
      model_effective: gpt-5.6-sol
      preflight_result: pass
      local_fallback_allowed: false
      local_fallback_scope: null
      attempts: 1
      max_attempts: 3
      required_capabilities: [repository-read, repository-write, shell-execute, ontoindex]
      dispatch_kind: implementation
      wait_state: completed-with-equivalent-current-source-proof
      blocker_fingerprint: "external-compile:blocking-await-inside-tracing-macro"
      last_progress_revision: null
    validation:
      required_commands:
        - "cd ontocode-rs && cargo test -p ontocode-model-provider descriptor::tests::official_openai_compatible_endpoints_preserve_native_tool_namespaces -- --exact"
        - "cd ontocode-rs && cargo test -p ontocode-model-provider descriptor::tests::custom_openai_compatible_provider_preserves_non_openai_auth_requirement -- --exact"
        - "cd ontocode-rs && cargo test -p ontocode-core --lib tools::spec_plan::tests::openai_compatible_proxy_flattens_mcp_namespaces_and_disables_tool_search -- --exact"
        - "cd ontocode-rs && cargo test -p ontocode-core --lib tools::spec_plan::tests::flattened_namespace_name_collisions_are_omitted -- --exact"
        - "cd ontocode-rs && cargo test -p ontocode-core --lib tools::spec_plan::tests::flattened_namespace_name_collision_with_plain_tool_is_omitted -- --exact"
        - "git diff --check -- ontocode-rs/model-provider/src/provider.rs ontocode-rs/model-provider/src/descriptor.rs ontocode-rs/core/src/tools/spec_plan.rs ontocode-rs/core/src/tools/spec_plan_tests.rs"
      executed:
        - "Provider official-endpoint namespace test: PASS."
        - "Provider custom-auth preservation test: PASS."
        - "Fresh disposable current-source ontocode_core binary: proxy flatten/tool_search test PASS."
        - "Fresh disposable current-source ontocode_core binary: namespace collision omission test PASS."
        - "Fresh disposable current-source ontocode_core binary: plain-name collision omission test PASS."
        - "git diff --check for the four-file scope: PASS."
      diff_scope:
        - ontocode-rs/model-provider/src/provider.rs
        - ontocode-rs/model-provider/src/descriptor.rs
        - ontocode-rs/core/src/tools/spec_plan.rs
        - ontocode-rs/core/src/tools/spec_plan_tests.rs
      unrelated_failures:
        - "Host compile: future is not Send because session/turn.rs awaits get_estimated_token_count inside warn!; no host edit authorized."
        - "coder-worker-test lacked shell_execution and could not independently rerun commands."
    required_validation:
      - "Non-official OpenAI-compatible endpoints select Flattened."
      - "Official OpenAI, ChatGPT Codex, and Azure endpoints retain Native."
      - "Flattened namespace children become unique plain function names."
      - "Every collided flat name is omitted."
      - "Namespace-dependent tool_search is absent for Flattened providers."
    expected_evidence:
      - Focused current-source test results.
      - Exact first-request tool spec snapshots from unit tests.
      - OntoIndex impact and diff verification for the four-file write set.
    rollback:
      - Restore the pre-task versions of only the four allowed files.
      - Leave TASK-2.0 and later tasks blocked.
    stop_conditions:
      - "Stop if implementation requires built_tools or connection-manager edits."
      - "Stop if a collision can resolve to more than one runtime."
      - "Stop if the ADR and implementation disagree."
      - "Wait without retrying if another Cargo/rustc owner holds the shared target directory."
    closeout_evidence:
      - "All five focused tests passed against current source; the three core tests used a disposable copy with only the unrelated non-Send await hoisted before warn!."
      - "No TASK-1 worker source edit was required; inherited four-file implementation matches the accepted ADR."
    evidence:
      - "OntoIndex: ProviderCapabilities LOW, build_model_visible_specs_and_registry LOW."
      - "OntoIndex: search_tool_enabled CRITICAL with five direct callers and seven affected modules; no new edit was made to that symbol."
      - "gn_verify_diff observed exactly the four expected TASK-1 changed files; its earlier FAIL was solely missing-test evidence before the core tests completed."
    known_blockers:
      - "Unrelated current-source non-Send compile failure near run_sampling_request."
    closeout:
      role_results:
        coder-architector: null
        coder-worker: "reviewed inherited implementation; no source edits; provider tests passed"
        coder-worker-test: "blocked by missing shell capability; inherited evidence only"
        coder-worker-challenger: null
        coder-auditor: null
      changed_files:
        - ontocode-rs/model-provider/src/provider.rs
        - ontocode-rs/model-provider/src/descriptor.rs
        - ontocode-rs/core/src/tools/spec_plan.rs
        - ontocode-rs/core/src/tools/spec_plan_tests.rs
      validation_summary:
        - "2 provider tests passed."
        - "3 core spec-plan tests passed from a fresh disposable current-source binary."
        - "Scoped diff check passed."
      evidence_refs:
        - .memory-bank/ADR_OPENAI_COMPATIBLE_TOOL_NAMESPACE_ENCODING.md
        - /tmp/ontocode-glm-task1-target/debug/deps/ontocode_core-2aa07d0975785ee3
      final_outcome_label: completed-with-external-compile-blocker
      remaining_risk: "search_tool_enabled has CRITICAL blast radius; existing change is accepted by focused proof but must receive broad regression coverage when the unrelated host compile blocker is fixed."
    next_on_done:
      - TASK-2.0

  TASK-2.0:
    title: Finalize unique flat-name registry resolution and dispatch tests
    status: DONE
    classification: completed
    dor_status: pass
    dod_status: pass
    depends_on:
      - TASK-1.0
    owner: coder-worker
    reviewer: coder-worker-challenger
    type: code
    validation_tier: unit-fast
    owner_files:
      - ontocode-rs/core/src/tools/registry.rs
      - ontocode-rs/core/src/tools/registry_tests.rs
      - ontocode-rs/core/src/tools/router_tests.rs
    allowed_write_set:
      - ontocode-rs/core/src/tools/registry.rs
      - ontocode-rs/core/src/tools/registry_tests.rs
      - ontocode-rs/core/src/tools/router_tests.rs
    target_symbols:
      - ToolRegistry::resolve_tool_name
      - resolve_plain_tool_name
      - resolve_flat_mcp_tool_name
      - flat_mcp_tool_name_dispatches_to_registered_handler
    do_not_touch:
      - ontocode-rs/core/src/tools/router.rs
      - ontocode-rs/core/src/tools/parallel.rs
      - ontocode-rs/core/src/mcp_tool_call.rs
      - ontocode-rs/core/tests/suite/rmcp_client.rs::insert_mcp_server
    non_goals:
      - Refactor the shared registry.
      - Generalize every namespace alias.
      - Change hook, approval, parallel, or lifecycle execution.
    source_evidence:
      - "Flat resolution has one direct caller and LOW graph impact."
      - "The shared insert_mcp_server test helper has HIGH impact across 15 direct tests and must not be refactored for this plan."
      - "Existing unit tests cover registered, legacy, delimiter-containing, delimiterless, unknown, and ambiguous names."
    readiness_gaps:
      - "Host-tree core validation still requires equivalent proof until the unrelated non-Send compile blocker is fixed."
    gap_resolution_task: null
    gap_disposition: external-validation-blocker
    paperwork_kind: null
    test_surface_gap: null
    adr_gate:
      required: true
      reason: "The accepted namespace ADR controls the flat-name identity."
      adr_path: .memory-bank/ADR_OPENAI_COMPATIBLE_TOOL_NAMESPACE_ENCODING.md
      status: accepted
      decision_owner: coder-architector
      allowed_write_set: []
      unblocks: []
      promotion_rule: "Promote after TASK-1.0 is DONE."
      missing_adr_outcome: stop
    dispatch:
      role: coder-worker
      assigned_agent: 019f771d-00ba-7e10-b873-1991b99bcc49
      model_requested: gpt-5.6-sol
      model_effective: gpt-5.6-sol
      preflight_result: pass
      local_fallback_allowed: false
      local_fallback_scope: null
      attempts: 1
      max_attempts: 3
      required_capabilities: [repository-read, repository-write, shell-execute, ontoindex]
      dispatch_kind: implementation
      wait_state: completed-with-current-source-binary-proof
      blocker_fingerprint: null
      last_progress_revision: null
    validation:
      required_commands:
        - "cd ontocode-rs && cargo test -p ontocode-core --lib tools::registry::tests::handler_looks_up_registered_flat_mcp_name -- --exact"
        - "cd ontocode-rs && cargo test -p ontocode-core --lib tools::registry::tests::handler_looks_up_unique_delimiterless_mcp_name -- --exact"
        - "cd ontocode-rs && cargo test -p ontocode-core --lib tools::registry::tests::handler_rejects_ambiguous_flat_namespaced_tool_name -- --exact"
        - "cd ontocode-rs && cargo test -p ontocode-core --lib tools::registry::tests::unregistered_flat_mcp_name_does_not_resolve -- --exact"
        - "cd ontocode-rs && cargo test -p ontocode-core --lib tools::router::tests::flat_mcp_tool_name_dispatches_to_registered_handler -- --exact"
        - "git diff --check -- ontocode-rs/core/src/tools/registry.rs ontocode-rs/core/src/tools/registry_tests.rs ontocode-rs/core/src/tools/router_tests.rs"
      executed:
        - "handler_looks_up_registered_flat_mcp_name: PASS."
        - "handler_looks_up_unique_delimiterless_mcp_name: PASS."
        - "handler_rejects_ambiguous_flat_namespaced_tool_name: PASS."
        - "unregistered_flat_mcp_name_does_not_resolve: PASS."
        - "flat_mcp_tool_name_dispatches_to_registered_handler: PASS."
        - "git diff --check for the three-file scope: PASS."
        - "gn_verify_diff for expected files/symbols/tests: PASS."
      diff_scope:
        - ontocode-rs/core/src/tools/registry.rs
        - ontocode-rs/core/src/tools/registry_tests.rs
        - ontocode-rs/core/src/tools/router_tests.rs
      unrelated_failures:
        - "Normal Cargo orchestration exceeded the tool response window; exact tests passed from its fresh current-source unit test binary."
    required_validation:
      - "Unique flat names resolve to the original namespaced handler."
      - "Ambiguous and unregistered flat names fail closed."
      - "Router dispatch uses the normal registered runtime path."
    expected_evidence:
      - Focused registry and router test output.
      - Changed-file evidence limited to the three-file write set.
      - Challenger confirmation that shared dispatch behavior was not broadened.
    rollback:
      - Restore the pre-task versions of the three allowed files.
    stop_conditions:
      - "Stop if product router or MCP execution code must change."
      - "Stop if exact plain-name precedence changes for existing tools."
      - "Wait without retrying if another Cargo/rustc owner holds the shared target directory."
    closeout_evidence:
      - "Five exact registry/router tests passed."
      - "gn_verify_diff PASS with exactly the three expected files and no missing tests."
    evidence:
      - "OntoIndex resolve_plain_tool_name LOW with one direct caller; TASK-2 batch union MEDIUM."
      - "Worker reviewed inherited implementation and required no additional edit."
    known_blockers: []
    closeout:
      role_results:
        coder-architector: null
        coder-worker: "PASS; inherited implementation accepted without additional edit"
        coder-worker-test: null
        coder-worker-challenger: null
        coder-auditor: null
      changed_files:
        - ontocode-rs/core/src/tools/registry.rs
        - ontocode-rs/core/src/tools/registry_tests.rs
      validation_summary:
        - "Four registry resolution tests passed."
        - "Router dispatch proof passed through the normal registered runtime."
        - "Scoped diff check and OntoIndex diff verification passed."
      evidence_refs:
        - /tmp/ontocode-glm-task1-target/debug/deps/ontocode_core-2aa07d0975785ee3
      final_outcome_label: completed
      remaining_risk: "Broad worktree graph verification remains noisy because of unrelated dirty files; bounded TASK-2 verification is clean."
    next_on_done:
      - TASK-3.0

  TASK-3.0:
    title: Prove the GLM custom-provider MCP flat-function round trip
    status: OPEN
    classification: implementation-ready
    dor_status: pass
    dod_status: pending
    depends_on:
      - TASK-2.0
    owner: coder-worker
    reviewer: coder-worker-test
    type: test
    validation_tier: integration
    owner_files:
      - ontocode-rs/core/tests/suite/remote_models.rs
    allowed_write_set:
      - ontocode-rs/core/tests/suite/remote_models.rs
    target_symbols:
      - remote_models_glm_5_2_max_custom_provider_tool_round_trip
    do_not_touch:
      - ontocode-rs/core/tests/suite/rmcp_client.rs
      - ontocode-rs/core/tests/common/lib.rs
      - ontocode-rs/core/src/**
      - ontocode-rs/model-provider/src/**
    non_goals:
      - Add shared test helpers.
      - Use live GLM credentials or an external provider.
      - Add generic MCP provider calls.
    source_evidence:
      - "The current GLM integration test exercises shell_command and second-request continuation, not MCP."
      - "stdio_server_bin is already public in core/tests/common/lib.rs."
      - "Existing integration tests configure McpServerConfig inline; no shared helper edit is required."
    readiness_gaps:
      - "Host-tree integration compilation still requires equivalent proof until the unrelated non-Send blocker is fixed."
    gap_resolution_task: null
    gap_disposition: external-validation-blocker
    paperwork_kind: null
    test_surface_gap: "No current integration test proves flat MCP declaration, dispatch, result, and continuation for the GLM proxy route."
    adr_gate:
      required: true
      reason: "The integration test must assert the accepted namespace contract."
      adr_path: .memory-bank/ADR_OPENAI_COMPATIBLE_TOOL_NAMESPACE_ENCODING.md
      status: accepted
      decision_owner: coder-architector
      allowed_write_set: []
      unblocks: []
      promotion_rule: "Promote after TASK-2.0 is DONE."
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
      required_capabilities: [repository-read, repository-write, shell-execute, ontoindex]
      dispatch_kind: implementation
      wait_state: null
      blocker_fingerprint: "dependency:TASK-2.0"
      last_progress_revision: null
    validation:
      required_commands:
        - "cd ontocode-rs && cargo test -p ontocode-core --test all remote_models_glm_5_2_max_custom_provider_tool_round_trip -- --exact --nocapture"
        - "git diff --check -- ontocode-rs/core/tests/suite/remote_models.rs"
        - "Run gn_verify_diff with changedFiles and expectedFiles limited to remote_models.rs."
      executed: []
      diff_scope:
        - ontocode-rs/core/tests/suite/remote_models.rs
      unrelated_failures: []
    required_validation:
      - "First provider request contains the expected flat MCP function and no native MCP namespace object."
      - "The flat call reaches the original MCP server and tool through the normal runtime."
      - "The MCP result is present unchanged in the second request with the matching call id."
      - "Final assistant completion succeeds without fallback calls."
    expected_evidence:
      - First-request tool declaration assertion.
      - MCP server-observed tool call and arguments.
      - Second-request history assertion.
      - Focused integration test pass.
    rollback:
      - Restore only remote_models.rs to its pre-task state.
    stop_conditions:
      - "Stop if the test requires modifying shared MCP helpers."
      - "Stop if the test bypasses normal MCP handler dispatch."
      - "Wait without retrying if another Cargo/rustc owner holds the shared target directory."
    closeout_evidence: []
    evidence: []
    known_blockers:
      - "The unrelated current-source non-Send compile failure must be cleared by its owning workstream before this test can execute."
    closeout:
      role_results:
        coder-architector: null
        coder-worker: null
        coder-worker-test: null
        coder-worker-challenger: null
        coder-auditor: null
      changed_files: []
      validation_summary: []
      evidence_refs: []
      final_outcome_label: null
      remaining_risk: null
    next_on_done:
      - TASK-4.0

  TASK-4.0:
    title: Build, install, restart, and execute the live GLM MCP acceptance run
    status: BLOCKED
    classification: proof-only
    dor_status: blocked
    dod_status: pending
    depends_on:
      - TASK-3.0
    owner: coder-worker-test
    reviewer: coder-worker-challenger
    type: diagnostic
    validation_tier: release
    owner_files: []
    allowed_write_set: []
    target_symbols: []
    do_not_touch:
      - /opt/demodb/_workfolder/OntoIndex/ontoindex/**
      - /opt/demodb/_workfolder/ontocode/ontocode-rs/**
    non_goals:
      - Implement new behavior during the acceptance run.
      - Reclassify generic resource reads as callable MCP success.
      - Guess provider model or reasoning mapping.
    source_evidence:
      - "The installed ontocode binary predates the current flattening source."
      - "Inherited controls pass while current GLM sub-agents report an empty generic MCP catalog."
      - "The source smoke plan defines GLM-00 through GLM-11 and separate provider-mapping gates."
    readiness_gaps:
      - "TASK-3.0 is not DONE."
      - "Installation and host restart require explicit human authorization."
    gap_resolution_task: TASK-3.0
    gap_disposition: hard-block
    paperwork_kind: null
    test_surface_gap: null
    adr_gate:
      required: true
      reason: "The installed behavior must match the accepted namespace ADR."
      adr_path: .memory-bank/ADR_OPENAI_COMPATIBLE_TOOL_NAMESPACE_ENCODING.md
      status: needed
      decision_owner: coder-architector
      allowed_write_set: []
      unblocks: []
      promotion_rule: "Run only after TASK-3.0 passes and a human authorizes installation and restart."
      missing_adr_outcome: stop
    dispatch:
      role: coder-worker-test
      assigned_agent: null
      model_requested: null
      model_effective: null
      preflight_result: not-run
      local_fallback_allowed: false
      local_fallback_scope: null
      attempts: 0
      max_attempts: 1
      required_capabilities: [repository-read, shell-execute, ontoindex]
      dispatch_kind: implementation
      wait_state: external-resource
      blocker_fingerprint: "human-approval:install-restart-ontocode"
      last_progress_revision: null
    validation:
      required_commands:
        - "Build the reviewed ontocode source and record the binary checksum and timestamp."
        - "Install only after explicit human approval, then fully restart the host."
        - "Run the inherited control prompts from GLM_5_2_MAX_ONTOINDEX_MCP_TEST_PLAN.md."
        - "Run GLM tool discovery and repository evidence once each."
        - "Run the sequential GLM prompt in three fresh agents."
      executed: []
      diff_scope: []
      unrelated_failures: []
    required_validation:
      - "Installed binary contains the reviewed source revision."
      - "Inherited controls remain green."
      - "GLM receives and successfully calls the flat OntoIndex tools."
      - "GLM-00 and GLM-03 through GLM-11 pass."
      - "GLM-01 and GLM-02 are proven from telemetry or remain NOT OBSERVABLE."
    expected_evidence:
      - Binary checksum, timestamp, and source revision.
      - Host restart timestamp.
      - Exact model-visible tool definitions.
      - Raw assistant/tool history and gate verdicts.
    rollback:
      - Restore the prior installed binary and restart the host.
      - Mark live compatibility failed without changing OntoIndex server code.
    stop_conditions:
      - "Stop if the inherited control fails."
      - "Stop if human installation/restart approval is absent."
      - "Stop if the rebuilt request already contains correct flat tools but GLM ignores them; close with a model/tool-use finding."
      - "Stop if child inventory is empty before request serialization; create a separate session-inheritance plan."
      - "Stop if GLM only emits GetMcpTools or CallMcpTool despite valid flat tools; require a new ADR and project plan rather than extending this queue."
    closeout_evidence: []
    evidence: []
    known_blockers:
      - "Explicit human approval is required for installation and restart."
    closeout:
      role_results:
        coder-architector: null
        coder-worker: null
        coder-worker-test: null
        coder-worker-challenger: null
        coder-auditor: null
      changed_files: []
      validation_summary: []
      evidence_refs: []
      final_outcome_label: null
      remaining_risk: null
    next_on_done: []
```

## Dispatch Authorization

- TASK-0.0 is the only task authorized for immediate dispatch.
- No product-code task is authorized until the boundary ADR is accepted.
- TASK-1.0 through TASK-3.0 use disjoint write sets and execute in dependency order.
- TASK-4.0 is proof-only and requires explicit human approval before installing a binary or restarting the host.
- Generic `GetMcpTools` or `CallMcpTool` compatibility is not authorized by this plan. Proven need requires a new ADR and project plan.

## Dispatch Preflight

1. Probe the exact child role/model/tool-surface before substantive dispatch.
2. Confirm the worker can read the Ontocode checkout and, for implementation tasks, write only the allowed files.
3. Confirm OntoIndex is callable; record degraded dirty-worktree and missing-LSP limitations.
4. Before Rust validation, confirm no other Cargo, rustc, Just, nextest, or artifact-lock owner is active.
5. If the shared build lane is occupied, set the manager state to `waiting`, keep the same active task, and do not retry until the lane changes.

## Goal

Prove and ship the smallest host-side compatibility fix that lets a `glm-5.2-max` sub-agent call OntoIndex MCP tools through the existing MCP policy and execution path. The accepted implementation must preserve native namespace objects for proven providers, flatten names only for incompatible OpenAI-compatible endpoints, route flat calls deterministically, and pass a real mock-MCP integration test before live installation.

## Planning Principles

- Fix the provider declaration boundary, not OntoIndex server behavior.
- Reuse existing tool naming, registry, MCP handlers, and test infrastructure.
- Keep `built_tools` and `McpConnectionManager` out of the default write set. OntoIndex rates `built_tools` CRITICAL/DANGEROUS.
- Treat the unrelated non-`Send` compile failure as an external readiness blocker, not work authorized by this plan.
- Prefer one offline integration proof over broad production telemetry.
- Fail closed on collisions and unknown flat names.
- Keep generic MCP gateway work out of scope until exact runtime evidence proves the flat-function path cannot work.

## Current Source Evidence

- The parent and inherited controls can call OntoIndex; the server is not the failing boundary.
- Current GLM agents report no servers through an external generic MCP catalog.
- The installed host binary predates current dirty source changes.
- Current dirty source adds `ToolNamespaceEncoding::{Native, Flattened}`, provider selection, namespace flattening, collision omission, and flat registry dispatch.
- Focused prebuilt provider and flat-dispatch tests passed, but current-source integration compilation remains blocked by unrelated work in `run_sampling_request`.
- `ProviderDescriptor::openai_compatible`, `build_model_visible_specs_and_registry`, and flat registry resolution have LOW upstream graph impact.
- `unsupported_tool_call_message` is MEDIUM impact and already contains bounded registry-miss diagnostics; this plan does not add broad telemetry.
- `built_tools` has five direct callers across startup prewarm, prompt debug, compaction, and sampling. It is excluded from routine implementation.
- The existing GLM remote-model test proves a plain shell tool loop and second-request continuation, but not MCP declaration or execution.
- The shared `insert_mcp_server` helper has HIGH test impact. TASK-3.0 must use existing public `stdio_server_bin()` and local inline configuration instead of refactoring the helper.

## Task Preparation Rules

1. Re-read the current dirty diff for every owner file immediately before dispatch.
2. Run fresh OntoIndex impact analysis before editing each existing function or method.
3. Treat symbols absent from the graph as dirty-source evidence requiring direct source verification.
4. Do not broaden a task write set after dispatch. Stop and update this plan first.
5. Do not mark a task implementation-ready while its ADR or dependency gate is pending.
6. Record current-source validation only; prebuilt binaries are supporting evidence, not DoD evidence.

## Task Card Template

Every dispatched packet must include:

- task id, title, classification, owner, reviewer, and dependencies;
- exact allowed write set and do-not-touch list;
- target symbols and current source evidence;
- required validation commands and expected evidence;
- rollback and stop conditions;
- the instruction that other contributors may have dirty changes and must not be reverted.

## Execution Rules

1. Select exactly `manager_loop.active_next_task` when its dependencies and DoR pass.
2. TASK-0.0 must close before TASK-1.0 can be promoted.
3. TASK-1.0, TASK-2.0, and TASK-3.0 execute serially because their behavioral contracts depend on the preceding task.
4. No task may edit `built_tools`, `McpConnectionManager`, OntoIndex server code, or shared RMCP test helpers.
5. If a required edit falls outside the allowed write set, stop with `blocked: scope expansion required`.
6. If Rust validation is blocked by the unrelated non-`Send` failure, record it and wait for the owning workstream. Do not patch it here.
7. TASK-4.0 cannot install or restart without explicit human approval.

## Evidence Protocol

- Source evidence must name exact files and symbols.
- Graph-backed risk claims must record the OntoIndex tool and its degraded-state limitations.
- Test evidence must include the exact command, exit status, pass/fail count, and whether current source or a prebuilt artifact ran.
- Integration evidence must capture the first tool declaration, MCP server-observed call, MCP result, second-request history, and final completion.
- Live evidence must preserve spawn metadata, exact model-visible tool definitions, raw tool history, and gate verdicts.
- Do not use model self-report as provider identity or reasoning-effort evidence.

## Definition Of Ready

### Global DoR

- The current dirty diff has been read and unrelated edits are identified.
- The task has one bounded allowed write set.
- Required child capabilities have passed preflight.
- OntoIndex impact has been run for each existing target symbol.
- No shared Cargo/rustc artifact owner is active before validation.

### Product-code DoR

- TASK-0.0 is DONE and the boundary ADR is accepted.
- The task dependency is DONE.
- The unrelated current-source compile blocker is cleared by its owning workstream or an equivalent clean build lane is available.
- Current-source tests can execute; prebuilt test binaries are not sufficient.

## Definition Of Done

### Task DoD

- Only allowed files changed.
- Required current-source validation passed.
- OntoIndex diff verification matches expected files and symbols, subject to recorded dirty-worktree limitations.
- Reviewer findings are resolved or explicitly accepted by the decision owner.
- Closeout records changed files, commands, evidence, rollback state, and remaining risk.

### Plan DoD

- The namespace boundary ADR is accepted.
- Provider selection and flattened model-visible declarations pass current-source tests.
- Unique flat registry resolution and dispatch pass current-source tests.
- The GLM custom-provider integration test proves MCP declaration, normal MCP execution, second-request continuation, and final completion.
- A reviewed binary is built and, after human approval, installed and loaded by a restarted host.
- Live GLM gates `GLM-00` and `GLM-03` through `GLM-11` pass.
- Provider identity and reasoning gates are proven or remain explicitly `NOT OBSERVABLE`.
- No OntoIndex server change or generic MCP gateway was added.

## Fixtures And Test Data

- Reuse `ontocode-rs/core/tests/common/lib.rs::stdio_server_bin()`.
- Reuse the existing stdio MCP test server and its read-only echo/query behavior.
- Configure the MCP server locally inside `remote_models.rs`; do not edit the shared `insert_mcp_server` helper.
- Use the existing mock Responses server and SSE request-capture helpers.
- Live credentials are not required for TASK-3.0 and must not appear in fixtures.

## Senior-Owned Work

- Accept or reject the namespace boundary ADR.
- Resolve conflicts with existing provider or tool-routing ADRs.
- Decide whether the unrelated compile blocker is cleared by another workstream or requires a separate plan.
- Authorize binary installation and host restart.
- If runtime evidence proves a generic MCP-only model path, open a new ADR and plan; do not append that architecture to this queue.

## Phase 0: Architecture Gate

- Execute TASK-0.0 only.
- Result: accepted namespace encoding ADR or `no-dispatch` closeout.

## Phase 1: Offline Implementation And Proof

- Execute TASK-1.0, TASK-2.0, and TASK-3.0 in order.
- Result: current-source unit and integration proof with no live credentials.

## Phase 2: Controlled Live Acceptance

- Execute TASK-4.0 only after explicit human approval.
- Result: live pass, rollback, or a bounded failure classification that opens a separate plan.

## Final Closeout

Close as `complete` only when all Plan DoD items pass.

Close as `no-dispatch` with an exact reopen gate when:

- the ADR is rejected;
- the rebuilt request contains correct flat tools but GLM ignores them;
- child MCP inventory is empty before request serialization;
- GLM requires generic MCP calls despite valid flat tools;
- installation/restart approval is withheld.

Do not silently expand this plan. Each closeout above requires a new bounded ADR or project plan before implementation resumes.

## Standard Validation Commands

```text
cd /opt/demodb/_workfolder/ontocode/ontocode-rs

cargo test -p ontocode-model-provider descriptor::tests::official_openai_compatible_endpoints_preserve_native_tool_namespaces -- --exact
cargo test -p ontocode-model-provider descriptor::tests::custom_openai_compatible_provider_preserves_non_openai_auth_requirement -- --exact

cargo test -p ontocode-core --lib tools::spec_plan::tests::openai_compatible_proxy_flattens_mcp_namespaces_and_disables_tool_search -- --exact
cargo test -p ontocode-core --lib tools::spec_plan::tests::flattened_namespace_name_collisions_are_omitted -- --exact
cargo test -p ontocode-core --lib tools::spec_plan::tests::flattened_namespace_name_collision_with_plain_tool_is_omitted -- --exact

cargo test -p ontocode-core --lib tools::registry::tests::handler_looks_up_registered_flat_mcp_name -- --exact
cargo test -p ontocode-core --lib tools::registry::tests::handler_looks_up_unique_delimiterless_mcp_name -- --exact
cargo test -p ontocode-core --lib tools::registry::tests::handler_rejects_ambiguous_flat_namespaced_tool_name -- --exact
cargo test -p ontocode-core --lib tools::registry::tests::unregistered_flat_mcp_name_does_not_resolve -- --exact
cargo test -p ontocode-core --lib tools::router::tests::flat_mcp_tool_name_dispatches_to_registered_handler -- --exact

cargo test -p ontocode-core --test all remote_models_glm_5_2_max_custom_provider_tool_round_trip -- --exact --nocapture
cargo fmt --all -- --check
```
