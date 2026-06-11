# ADR-MCP-001: audit

## Status

Accepted.

## Function

`audit`

## SEO Summary

OntoIndex MCP function `audit` supports run architectural audits, session workflows, and systems-audit checks for AI coding agents, local code graph analysis, repository safety workflows, and Model Context Protocol automation.

## Context

Run architectural audits, manager-level audit session workflows, write-through verification, and systems-audit checks.

## Decision

Document `audit` as a public OntoIndex MCP function because agents and human operators need a stable, linkable explanation of its purpose, predecessor surface, call shape, and returned evidence.

## Predecessors

Consolidates earlier direct backend actions into the `audit` facade. Current action set: report, dead_code, tech_debt, hotspots, cycles, coupling, violations, coverage, migration, drift, build, graph_diff, requirements, patterns, rerun, session_start, session_verify, session_dedupe, session_bundle, session_dispatch, session_review_worker, verify_diff, test_gap, worker_scope_review, logic, trace_boundary, resource_trace, path_verify, test_suggestions, extract_fsm, error_topology, concurrency, pressure, taint, abi, simulate_fault.

## How To Use

Call this function through an MCP client connected to the OntoIndex server.

```json
{
  "tool": "audit",
  "arguments": {
    "action": "report",
    "repo": "my-repo"
  }
}
```

## What Information You Can Get

- Category: `audit`.
- Evidence classes: `audit_evidence`, `graph_evidence`.
- Response style: structured JSON suitable for automation.
- Permission profile: `write_apply`.
- Facade actions: `report`, `dead_code`, `tech_debt`, `hotspots`, `cycles`, `coupling`, `violations`, `coverage`, `migration`, `drift`, `build`, `graph_diff`, `requirements`, `patterns`, `rerun`, `session_start`, `session_verify`, `session_dedupe`, `session_bundle`, `session_dispatch`, `session_review_worker`, `verify_diff`, `test_gap`, `worker_scope_review`, `logic`, `trace_boundary`, `resource_trace`, `path_verify`, `test_suggestions`, `extract_fsm`, `error_topology`, `concurrency`, `pressure`, `taint`, `abi`, `simulate_fault`.
- Typical result: Run architectural audits, session workflows, and systems-audit checks; Primary entry point for the audit lifecycle and systems reasoning.

## Parameters

| Parameter | Type | Required | Purpose |
| --- | --- | --- | --- |
| `action` | string: report, dead_code, tech_debt, hotspots, cycles, coupling, violations, coverage, migration, drift, build, graph_diff, requirements, patterns, rerun, session_start, session_verify, session_dedupe, session_bundle, session_dispatch, session_review_worker, verify_diff, test_gap, worker_scope_review, logic, trace_boundary, resource_trace, path_verify, test_suggestions, extract_fsm, error_topology, concurrency, pressure, taint, abi, simulate_fault | yes | The audit action to perform. |
| `legacyResponse` | boolean | no | Forward legacy response mode to envelope-capable audit actions. Default: true. Set false to opt into the capability-aware response envelope where supported. |
| `repo` | string | no | Repository name or path. |

## Returning Answer Shape

Actual responses depend on repository state, index freshness, and requested limits. A minimal expected shape is:

```json
{
  "status": "ok",
  "tool": "audit",
  "summary": "Run architectural audits, session workflows, and systems-audit checks",
  "evidenceClasses": [
    "audit_evidence",
    "graph_evidence"
  ],
  "nextAction": "Primary entry point for the audit lifecycle and systems reasoning"
}
```

## When It Is Useful

Primary entry point for the audit lifecycle and systems reasoning.

## Operational Notes

- Kind: `facade`.
- Contract status: `stable`.
- Discoverable modes: `general`, `audit`, `refactor`.
- Audit authority: `true`.
- Advisory-only: `false`.
- Source of truth: `ontoindex/src/mcp/shared/tool-registry.ts` and `ontoindex/src/mcp/*/tool-definitions.ts`.

## Related Concepts

OntoIndex, MCP server, code graph, AI coding agent, static analysis, repository impact analysis, audit, audit.
