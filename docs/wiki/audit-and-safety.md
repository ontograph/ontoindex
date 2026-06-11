# Audit And Safety Workflows

## Purpose

OntoIndex provides audit and safety workflows for agents before they edit, refactor, dispatch worker tasks, or release code.

The main goal is to turn graph evidence, docs evidence, and audit evidence into bounded, checkable decisions.

## Core Areas

| Path | Responsibility |
| --- | --- |
| `ontoindex/src/core/audit-lifecycle/` | Persistent audit sessions, findings, dedupe, verification, bundles, tombstones. |
| `ontoindex/src/core/systems-audit/` | Resource, boundary, error, concurrency, taint, ABI, and fault-model analysis. |
| `ontoindex/src/core/review/` | Diff and review support. |
| `ontoindex/src/checks/` | Semantic and impact threshold checks. |
| `ontoindex/src/mcp/super/` | Agent-facing safety and audit super-functions. |

## Pre-Edit And Pre-Commit

Recommended agent flow:

1. `gn_safe_edit_check` before modifying a symbol.
2. `gn_safe_refactor` for rename/extract/move/modify operations.
3. `gn_verify_diff` after editing.
4. `gn_test_gap` to verify test evidence.
5. `gn_pre_commit_audit` before commit.

## Audit Lifecycle

Manager-level audit flows use:

| Tool | Role |
| --- | --- |
| `gn_audit_ingest` | Parse untrusted audit reports into candidate findings. |
| `gn_audit_session_lock` | Record target HEAD and graph identity. |
| `gn_audit_session_verify` | Verify findings against current evidence. |
| `gn_audit_session_dedupe` | Collapse duplicate/stale findings. |
| `gn_audit_session_bundle` | Group verified work into implementation bundles. |
| `gn_audit_session_dispatch` | Generate one worker prompt for one bundle. |
| `gn_audit_session_review_worker` | Check worker output against scope and tests. |

## Current Audit Notes

The latest MCP method audit found:

- All 61 MCP tools callable at transport level.
- `gn_tool_contract` reports an internally consistent frontier.
- Docs sidecar readiness is stale.
- `gn_audit_verify` returned an untyped JavaScript exception for one smoke input: `Cannot read properties of undefined (reading 'includes')`.

That last item should be converted into a typed validation error before relying on arbitrary external audit finding shapes.
