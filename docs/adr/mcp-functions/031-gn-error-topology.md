# ADR-MCP-031: gn_error_topology

## Status

Accepted.

## Function

`gn_error_topology`

## SEO Summary

OntoIndex MCP function `gn_error_topology` supports map error sources, sinks, and swallowed failures for AI coding agents, local code graph analysis, repository safety workflows, and Model Context Protocol automation.

## Context

Systems-audit error topology: find errno/exception/error-return sources, checks, sinks, swallowed errors, and generic exit-code black holes.

## Decision

Document `gn_error_topology` as a public OntoIndex MCP function because agents and human operators need a stable, linkable explanation of its purpose, predecessor surface, call shape, and returned evidence.

## Predecessors

Extends the audit layer with systems-programming analyzers for resource, concurrency, ABI, taint, and fault evidence.

## How To Use

Call this function through an MCP client connected to the OntoIndex server.

```json
{
  "tool": "gn_error_topology",
  "arguments": {
    "repo": "my-repo"
  }
}
```

## What Information You Can Get

- Category: `systems-audit`.
- Evidence classes: `audit_evidence`, `graph_evidence`.
- Response style: structured JSON suitable for automation.
- Permission profile: `read_only`.
- Typical result: Map error sources, sinks, and swallowed failures; When auditing errno, exceptions, generic exits, or silent catch blocks.

## Parameters

| Parameter | Type | Required | Purpose |
| --- | --- | --- | --- |
| `legacyResponse` | boolean | no | Return the legacy pre-envelope response shape. Default: true. Set false to opt into the capability-aware response envelope. |
| `maxRecords` | number | no | Maximum nodes/edges/findings returned. Default: 50, max: 200. |
| `path` | string | no | Repository-relative source path to read. |
| `repo` | string | no | Repository name or path. Omit if only one repo is indexed. |
| `sourceText` | string | no | Inline source text to analyze. |
| `symbol` | string | no | Optional symbol under audit. |

## Returning Answer Shape

Actual responses depend on repository state, index freshness, and requested limits. A minimal expected shape is:

```json
{
  "status": "ok",
  "tool": "gn_error_topology",
  "summary": "Map error sources, sinks, and swallowed failures",
  "evidenceClasses": [
    "audit_evidence",
    "graph_evidence"
  ],
  "nextAction": "When auditing errno, exceptions, generic exits, or silent catch blocks"
}
```

## When It Is Useful

When auditing errno, exceptions, generic exits, or silent catch blocks.

## Operational Notes

- Kind: `super`.
- Contract status: `stable`.
- Discoverable modes: `general`, `audit`, `refactor`, `query-projects`.
- Audit authority: `true`.
- Advisory-only: `false`.
- Source of truth: `ontoindex/src/mcp/shared/tool-registry.ts` and `ontoindex/src/mcp/*/tool-definitions.ts`.

## Related Concepts

OntoIndex, MCP server, code graph, AI coding agent, static analysis, repository impact analysis, systems-audit, gn_error_topology.
