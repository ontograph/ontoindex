# ADR-MCP Index: OntoIndex MCP Function Pages

## Status

Accepted.

## Purpose

This directory contains one ADR-style Markdown page per public OntoIndex MCP function. The pages are generated from the MCP registry so search engines and human readers can discover what each function does, which predecessor surface it replaces or consolidates, how to call it, and what information it returns.

## Function Pages

| Function | Kind | Category | Status | Page |
| --- | --- | --- | --- | --- |
| `audit` | facade | audit | stable | [ADR](./001-audit.md) |
| `discover` | facade | discovery | stable | [ADR](./002-discover.md) |
| `docs` | facade | docs | stable | [ADR](./003-docs.md) |
| `gn_abi_diff` | super | systems-audit | stable | [ADR](./004-gn-abi-diff.md) |
| `gn_audit_bundle` | super | audit | stable | [ADR](./005-gn-audit-bundle.md) |
| `gn_audit_dedupe` | super | audit | stable | [ADR](./006-gn-audit-dedupe.md) |
| `gn_audit_diff` | super | audit | stable | [ADR](./007-gn-audit-diff.md) |
| `gn_audit_export` | super | audit | stable | [ADR](./008-gn-audit-export.md) |
| `gn_audit_ingest` | super | audit | stable | [ADR](./009-gn-audit-ingest.md) |
| `gn_audit_lint` | super | audit | stable | [ADR](./010-gn-audit-lint.md) |
| `gn_audit_logic` | super | systems-audit | stable | [ADR](./011-gn-audit-logic.md) |
| `gn_audit_pr_marker_scan` | super | audit | stable | [ADR](./012-gn-audit-pr-marker-scan.md) |
| `gn_audit_replay` | super | audit | stable | [ADR](./013-gn-audit-replay.md) |
| `gn_audit_session_bundle` | super | lifecycle | stable | [ADR](./014-gn-audit-session-bundle.md) |
| `gn_audit_session_dedupe` | super | lifecycle | stable | [ADR](./015-gn-audit-session-dedupe.md) |
| `gn_audit_session_dispatch` | super | lifecycle | stable | [ADR](./016-gn-audit-session-dispatch.md) |
| `gn_audit_session_lock` | super | lifecycle | stable | [ADR](./017-gn-audit-session-lock.md) |
| `gn_audit_session_review_worker` | super | lifecycle | stable | [ADR](./018-gn-audit-session-review-worker.md) |
| `gn_audit_session_start` | super | lifecycle | stable | [ADR](./019-gn-audit-session-start.md) |
| `gn_audit_session_verify` | super | lifecycle | stable | [ADR](./020-gn-audit-session-verify.md) |
| `gn_audit_tombstone_create` | super | audit | stable | [ADR](./021-gn-audit-tombstone-create.md) |
| `gn_audit_verify` | super | audit | stable | [ADR](./022-gn-audit-verify.md) |
| `gn_bundle_conflicts` | super | audit | stable | [ADR](./023-gn-bundle-conflicts.md) |
| `gn_can_delete` | super | safety | stable | [ADR](./024-gn-can-delete.md) |
| `gn_concurrency_audit` | super | systems-audit | stable | [ADR](./025-gn-concurrency-audit.md) |
| `gn_diagnose` | super | self-help | stable | [ADR](./026-gn-diagnose.md) |
| `gn_diff_impact` | super | pr-review | stable | [ADR](./027-gn-diff-impact.md) |
| `gn_dispatch_prompt` | super | audit | stable | [ADR](./028-gn-dispatch-prompt.md) |
| `gn_docs` | super | docs | stable | [ADR](./029-gn-docs.md) |
| `gn_ensure_fresh` | super | lifecycle | stable | [ADR](./030-gn-ensure-fresh.md) |
| `gn_error_topology` | super | systems-audit | stable | [ADR](./031-gn-error-topology.md) |
| `gn_explain_module` | super | discovery | stable | [ADR](./032-gn-explain-module.md) |
| `gn_explore` | super | discovery | stable | [ADR](./033-gn-explore.md) |
| `gn_extract_fsm` | super | systems-audit | stable | [ADR](./034-gn-extract-fsm.md) |
| `gn_find_related` | super | discovery | stable | [ADR](./035-gn-find-related.md) |
| `gn_fix_history` | super | audit | stable | [ADR](./036-gn-fix-history.md) |
| `gn_graph_walk` | super | discovery | experimental | [ADR](./037-gn-graph-walk.md) |
| `gn_help` | super | self-help | stable | [ADR](./038-gn-help.md) |
| `gn_path_verify` | super | systems-audit | stable | [ADR](./039-gn-path-verify.md) |
| `gn_pre_commit_audit` | super | safety | stable | [ADR](./040-gn-pre-commit-audit.md) |
| `gn_pressure_impact` | super | systems-audit | stable | [ADR](./041-gn-pressure-impact.md) |
| `gn_propose_location` | super | self-help | stable | [ADR](./042-gn-propose-location.md) |
| `gn_quality_mode` | super | lifecycle | stable | [ADR](./043-gn-quality-mode.md) |
| `gn_resource_trace` | super | systems-audit | stable | [ADR](./044-gn-resource-trace.md) |
| `gn_review_diff` | super | pr-review | stable | [ADR](./045-gn-review-diff.md) |
| `gn_safe_edit_check` | super | safety | stable | [ADR](./046-gn-safe-edit-check.md) |
| `gn_safe_refactor` | super | refactor | stable | [ADR](./047-gn-safe-refactor.md) |
| `gn_scope_guard` | super | audit | stable | [ADR](./048-gn-scope-guard.md) |
| `gn_simulate_fault` | super | systems-audit | stable | [ADR](./049-gn-simulate-fault.md) |
| `gn_taint_trace` | super | systems-audit | stable | [ADR](./050-gn-taint-trace.md) |
| `gn_test_gap` | super | lifecycle | stable | [ADR](./051-gn-test-gap.md) |
| `gn_test_suggestions` | super | systems-audit | stable | [ADR](./052-gn-test-suggestions.md) |
| `gn_tool_contract` | super | self-help | stable | [ADR](./053-gn-tool-contract.md) |
| `gn_trace_boundary` | super | systems-audit | stable | [ADR](./054-gn-trace-boundary.md) |
| `gn_verify_diff` | super | lifecycle | stable | [ADR](./055-gn-verify-diff.md) |
| `gn_worker_scope_review` | super | lifecycle | stable | [ADR](./056-gn-worker-scope-review.md) |
| `impact` | facade | discovery | stable | [ADR](./057-impact.md) |
| `inspect` | facade | discovery | stable | [ADR](./058-inspect.md) |
| `manage` | facade | lifecycle | stable | [ADR](./059-manage.md) |
| `refactor` | facade | refactor | stable | [ADR](./060-refactor.md) |
| `search` | facade | discovery | stable | [ADR](./061-search.md) |

## Source Of Truth

- `ontoindex/src/mcp/shared/tool-registry.ts`
- `ontoindex/src/mcp/super/tool-definitions.ts`
- `ontoindex/src/mcp/facade/tool-definitions.ts`
