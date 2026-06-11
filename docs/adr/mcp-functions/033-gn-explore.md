# ADR-MCP-033: gn_explore

## Status

Accepted.

## Function

`gn_explore`

## SEO Summary

OntoIndex MCP function `gn_explore` supports help me understand this concept for AI coding agents, local code graph analysis, repository safety workflows, and Model Context Protocol automation.

## Context

Concept-level discovery: given a free-text query, returns a structured ExploreReport with top processes, top symbols (with optional skeletons and citation paths), cluster info, and suggested entry points.

## Decision

Document `gn_explore` as a public OntoIndex MCP function because agents and human operators need a stable, linkable explanation of its purpose, predecessor surface, call shape, and returned evidence.

## Predecessors

Predecessor is the lower-level graph query, impact, audit, or backend action surface that existed before the public super-function/facade contract.

## How To Use

Call this function through an MCP client connected to the OntoIndex server.

```json
{
  "tool": "gn_explore",
  "arguments": {
    "repo": "my-repo",
    "query": "authentication flow"
  }
}
```

## What Information You Can Get

- Category: `discovery`.
- Evidence classes: `graph_evidence`.
- Response style: structured JSON suitable for automation.
- Permission profile: `read_only`.
- Typical result: Help me understand this concept; First exploration of unfamiliar code.

## Parameters

| Parameter | Type | Required | Purpose |
| --- | --- | --- | --- |
| `depth` | string: shallow, balanced, deep | no | Controls how many top symbols are returned. shallow=3, balanced=5 (default), deep=10. |
| `includeCitations` | boolean | no | Include graph-path citation edges for each top symbol. Default: true. |
| `includeSkeletons` | boolean | no | Include file skeletons for each top symbol. Default: true. |
| `qualityMode` | string: fast, balanced, thorough | no | Search quality vs speed trade-off. Default: balanced. |
| `query` | string | yes | Free-text concept or feature query (e.g. "auth flow", "worker-pool"). |
| `repo` | string | no | Repository name or path. Omit if only one repo is indexed. |

## Returning Answer Shape

Actual responses depend on repository state, index freshness, and requested limits. A minimal expected shape is:

```json
{
  "status": "ok",
  "tool": "gn_explore",
  "summary": "Help me understand this concept",
  "evidenceClasses": [
    "graph_evidence"
  ],
  "nextAction": "First exploration of unfamiliar code"
}
```

## When It Is Useful

First exploration of unfamiliar code.

## Operational Notes

- Kind: `super`.
- Contract status: `stable`.
- Discoverable modes: `general`, `audit`, `refactor`, `query-projects`.
- Audit authority: `false`.
- Advisory-only: `false`.
- Source of truth: `ontoindex/src/mcp/shared/tool-registry.ts` and `ontoindex/src/mcp/*/tool-definitions.ts`.

## Related Concepts

OntoIndex, MCP server, code graph, AI coding agent, static analysis, repository impact analysis, discovery, gn_explore.
