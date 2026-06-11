# ADR-MCP-059: manage

## Status

Accepted.

## Function

`manage`

## SEO Summary

OntoIndex MCP function `manage` supports manage ontoindex sessions and internal route maps for AI coding agents, local code graph analysis, repository safety workflows, and Model Context Protocol automation.

## Context

Manage OntoIndex sessions and internal route maps.

## Decision

Document `manage` as a public OntoIndex MCP function because agents and human operators need a stable, linkable explanation of its purpose, predecessor surface, call shape, and returned evidence.

## Predecessors

Consolidates earlier direct backend actions into the `manage` facade. Current action set: session, route_map.

## How To Use

Call this function through an MCP client connected to the OntoIndex server.

```json
{
  "tool": "manage",
  "arguments": {
    "action": "session"
  }
}
```

## What Information You Can Get

- Category: `lifecycle`.
- Evidence classes: `graph_evidence`.
- Response style: text or mixed output intended for direct agent use.
- Permission profile: `write_apply`.
- Facade actions: `session`, `route_map`.
- Typical result: Manage OntoIndex sessions and internal route maps; When performing administrative session or route management.

## Parameters

| Parameter | Type | Required | Purpose |
| --- | --- | --- | --- |
| `action` | string: session, route_map | yes | The management action to perform. |

## Returning Answer Shape

Actual responses depend on repository state, index freshness, and requested limits. A minimal expected shape is:

```json
{
  "status": "ok",
  "tool": "manage",
  "summary": "Manage OntoIndex sessions and internal route maps",
  "evidenceClasses": [
    "graph_evidence"
  ],
  "nextAction": "When performing administrative session or route management"
}
```

## When It Is Useful

When performing administrative session or route management.

## Operational Notes

- Kind: `facade`.
- Contract status: `stable`.
- Discoverable modes: `general`, `audit`, `refactor`.
- Audit authority: `false`.
- Advisory-only: `false`.
- Source of truth: `ontoindex/src/mcp/shared/tool-registry.ts` and `ontoindex/src/mcp/*/tool-definitions.ts`.

## Related Concepts

OntoIndex, MCP server, code graph, AI coding agent, static analysis, repository impact analysis, lifecycle, manage.
