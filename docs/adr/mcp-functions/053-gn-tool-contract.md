# ADR-MCP-053: gn_tool_contract

## Status

Accepted.

## Function

`gn_tool_contract`

## SEO Summary

OntoIndex MCP function `gn_tool_contract` supports verify gn_help advertised tools match the registered callable mcp frontier for AI coding agents, local code graph analysis, repository safety workflows, and Model Context Protocol automation.

## Context

MCP tool contract preflight: compare gn_help advertised super-functions with the registered callable MCP frontier and report missing or extra tools before agents hit Unknown tool at runtime. When `mode` is supplied, also computes a mode-filtered frontier comparison and structural integrity checks.

## Decision

Document `gn_tool_contract` as a public OntoIndex MCP function because agents and human operators need a stable, linkable explanation of its purpose, predecessor surface, call shape, and returned evidence.

## Predecessors

Predecessor is the lower-level graph query, impact, audit, or backend action surface that existed before the public super-function/facade contract.

## How To Use

Call this function through an MCP client connected to the OntoIndex server.

```json
{
  "tool": "gn_tool_contract",
  "arguments": {}
}
```

## What Information You Can Get

- Category: `self-help`.
- Evidence classes: `runtime_diagnostic`.
- Response style: structured JSON suitable for automation.
- Permission profile: `read_only`.
- Typical result: Verify gn_help advertised tools match the registered callable MCP frontier; At session start or after Unknown tool errors to detect stale MCP/runtime drift.

## Parameters

| Parameter | Type | Required | Purpose |
| --- | --- | --- | --- |
| `includeFacades` | boolean | no | Include facade tools such as audit, inspect, impact, and search in callable output. Default: false. |
| `mode` | string: general, audit, refactor, query-projects | no | Optional agent mode. When supplied, adds a mode-filtered frontier comparison (`modeFrontier`) to the report comparing gn_help({mode}) advertised tools against mode-discoverable callable tools. |

## Returning Answer Shape

Actual responses depend on repository state, index freshness, and requested limits. A minimal expected shape is:

```json
{
  "status": "ok",
  "tool": "gn_tool_contract",
  "summary": "Verify gn_help advertised tools match the registered callable MCP frontier",
  "evidenceClasses": [
    "runtime_diagnostic"
  ],
  "nextAction": "At session start or after Unknown tool errors to detect stale MCP/runtime drift"
}
```

## When It Is Useful

At session start or after Unknown tool errors to detect stale MCP/runtime drift.

## Operational Notes

- Kind: `super`.
- Contract status: `stable`.
- Discoverable modes: `general`, `audit`, `refactor`, `query-projects`.
- Audit authority: `false`.
- Advisory-only: `true`.
- Source of truth: `ontoindex/src/mcp/shared/tool-registry.ts` and `ontoindex/src/mcp/*/tool-definitions.ts`.

## Related Concepts

OntoIndex, MCP server, code graph, AI coding agent, static analysis, repository impact analysis, self-help, gn_tool_contract.
