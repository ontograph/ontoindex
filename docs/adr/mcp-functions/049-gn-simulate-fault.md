# ADR-MCP-049: gn_simulate_fault

## Status

Accepted.

## Function

`gn_simulate_fault`

## SEO Summary

OntoIndex MCP function `gn_simulate_fault` supports simulate a target call returning a fault value for AI coding agents, local code graph analysis, repository safety workflows, and Model Context Protocol automation.

## Context

Systems-audit semantic fault simulation: statically model a target call returning a chosen value and report likely branches, assignments, early returns, and bypass warnings.

## Decision

Document `gn_simulate_fault` as a public OntoIndex MCP function because agents and human operators need a stable, linkable explanation of its purpose, predecessor surface, call shape, and returned evidence.

## Predecessors

Extends the audit layer with systems-programming analyzers for resource, concurrency, ABI, taint, and fault evidence.

## How To Use

Call this function through an MCP client connected to the OntoIndex server.

```json
{
  "tool": "gn_simulate_fault",
  "arguments": {
    "repo": "my-repo",
    "target": "validateUser"
  }
}
```

## What Information You Can Get

- Category: `systems-audit`.
- Evidence classes: `audit_evidence`, `graph_evidence`.
- Response style: structured JSON suitable for automation.
- Permission profile: `read_only`.
- Typical result: Simulate a target call returning a fault value; When reasoning about ENOSYS, failure returns, bypasses, and fallback paths.

## Parameters

| Parameter | Type | Required | Purpose |
| --- | --- | --- | --- |
| `legacyResponse` | boolean | no | Return the legacy pre-envelope response shape. Default: true. Set false to opt into the capability-aware response envelope. |
| `maxAssignments` | number | no | Maximum assignments returned. Default: 20. |
| `maxBranches` | number | no | Maximum branches returned. Default: 20. |
| `maxEarlyReturns` | number | no | Maximum early returns returned. Default: 20. |
| `path` | string | no | Repository-relative source path to read. |
| `repo` | string | no | Repository name or path. Omit if only one repo is indexed. |
| `returnValue` | string | no | Injected return value. |
| `return_value` | string | no | Alias for injected return value. |
| `sourceText` | string | no | Inline source text to analyze. |
| `target` | string | yes | Target call to force, e.g. pidfd_open. |
| `targetCall` | string | no | Alias for target call. |
| `triggerPath` | array | no | Expected trigger path labels. |

## Returning Answer Shape

Actual responses depend on repository state, index freshness, and requested limits. A minimal expected shape is:

```json
{
  "status": "ok",
  "tool": "gn_simulate_fault",
  "summary": "Simulate a target call returning a fault value",
  "evidenceClasses": [
    "audit_evidence",
    "graph_evidence"
  ],
  "nextAction": "When reasoning about ENOSYS, failure returns, bypasses, and fallback paths"
}
```

## When It Is Useful

When reasoning about ENOSYS, failure returns, bypasses, and fallback paths.

## Operational Notes

- Kind: `super`.
- Contract status: `stable`.
- Discoverable modes: `general`, `audit`, `refactor`, `query-projects`.
- Audit authority: `true`.
- Advisory-only: `false`.
- Source of truth: `ontoindex/src/mcp/shared/tool-registry.ts` and `ontoindex/src/mcp/*/tool-definitions.ts`.

## Related Concepts

OntoIndex, MCP server, code graph, AI coding agent, static analysis, repository impact analysis, systems-audit, gn_simulate_fault.
