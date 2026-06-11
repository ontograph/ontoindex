# ADR-MCP-037: gn_graph_walk

## Status

Accepted.

## Function

`gn_graph_walk`

## SEO Summary

OntoIndex MCP function `gn_graph_walk` supports iterative, agent-controlled graph exploration for AI coding agents, local code graph analysis, repository safety workflows, and Model Context Protocol automation.

## Context

Stateful graph traversal. Start a walk with a seed symbol, then step to explore neighbors based on a policy (follow-calls, follow-imports, expand-outward).

## Decision

Document `gn_graph_walk` as a public OntoIndex MCP function because agents and human operators need a stable, linkable explanation of its purpose, predecessor surface, call shape, and returned evidence.

## Predecessors

Predecessor is the lower-level graph query, impact, audit, or backend action surface that existed before the public super-function/facade contract.

## How To Use

Call this function through an MCP client connected to the OntoIndex server.

```json
{
  "tool": "gn_graph_walk",
  "arguments": {
    "repo": "my-repo",
    "action": "start"
  }
}
```

## What Information You Can Get

- Category: `discovery`.
- Evidence classes: `graph_evidence`.
- Response style: structured JSON suitable for automation.
- Permission profile: `write_apply`.
- Typical result: Iterative, agent-controlled graph exploration; Step-by-step neighbor discovery from a seed symbol.

## Parameters

| Parameter | Type | Required | Purpose |
| --- | --- | --- | --- |
| `action` | string: start, step, status | yes | Action to perform: start, step, or status. |
| `maxExpansionPerStep` | number | no | Maximum neighbors read per step. Default is 5, capped at 25. |
| `maxFrontier` | number | no | Maximum queued frontier nodes. Default is 100, capped at 250. |
| `maxSteps` | number | no | Maximum steps to allow. Default is 10, capped at 50. |
| `navigationPolicy` | string: follow-calls, follow-imports, expand-outward | no | Policy for expansion. Default is follow-calls. |
| `repo` | string | no | Repository name or path. Omit if only one repo is indexed. |
| `seedSymbol` | string | no | Seed symbol to start the walk (required for start). |
| `walkId` | string | no | ID of an active walk (required for step and status). |

## Returning Answer Shape

Actual responses depend on repository state, index freshness, and requested limits. A minimal expected shape is:

```json
{
  "status": "ok",
  "tool": "gn_graph_walk",
  "summary": "Iterative, agent-controlled graph exploration",
  "evidenceClasses": [
    "graph_evidence"
  ],
  "nextAction": "Step-by-step neighbor discovery from a seed symbol"
}
```

## When It Is Useful

Step-by-step neighbor discovery from a seed symbol.

## Operational Notes

- Kind: `super`.
- Contract status: `experimental`.
- Discoverable modes: `general`, `audit`, `refactor`.
- Audit authority: `false`.
- Advisory-only: `false`.
- Source of truth: `ontoindex/src/mcp/shared/tool-registry.ts` and `ontoindex/src/mcp/*/tool-definitions.ts`.

## Related Concepts

OntoIndex, MCP server, code graph, AI coding agent, static analysis, repository impact analysis, discovery, gn_graph_walk.
