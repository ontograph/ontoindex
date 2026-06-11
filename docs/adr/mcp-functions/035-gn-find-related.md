# ADR-MCP-035: gn_find_related

## Status

Accepted.

## Function

`gn_find_related`

## SEO Summary

OntoIndex MCP function `gn_find_related` supports what is near this symbol? for AI coding agents, local code graph analysis, repository safety workflows, and Model Context Protocol automation.

## Context

Symbol-level neighborhood: given a symbol name or canonical nodeId, returns callers, callees, co-changed files, cluster siblings, and optionally cross-repo references.

## Decision

Document `gn_find_related` as a public OntoIndex MCP function because agents and human operators need a stable, linkable explanation of its purpose, predecessor surface, call shape, and returned evidence.

## Predecessors

Predecessor is the lower-level graph query, impact, audit, or backend action surface that existed before the public super-function/facade contract.

## How To Use

Call this function through an MCP client connected to the OntoIndex server.

```json
{
  "tool": "gn_find_related",
  "arguments": {
    "repo": "my-repo",
    "symbol": "validateUser"
  }
}
```

## What Information You Can Get

- Category: `discovery`.
- Evidence classes: `graph_evidence`.
- Response style: structured JSON suitable for automation.
- Permission profile: `read_only`.
- Typical result: What is near this symbol; Symbol-level neighborhood.

## Parameters

| Parameter | Type | Required | Purpose |
| --- | --- | --- | --- |
| `includeCallees` | boolean | no | Include downstream callees. Default: true. |
| `includeCallers` | boolean | no | Include upstream callers. Default: true. |
| `includeClusterSiblings` | boolean | no | Include other symbols in the same Leiden community. Default: true. |
| `includeCoChanged` | boolean | no | Include co-changed file partners. Default: true. |
| `includeCrossRepo` | boolean | no | Include cross-repo references (requires group config). Default: false. |
| `maxItemsPerCategory` | number | no | Maximum items returned per category (callers, callees, etc). Default: 10. |
| `repo` | string | no | Repository name or path. Omit if only one repo is indexed. |
| `symbol` | string | yes | Canonical nodeId (e.g. "Function:mergeWithRRF") or fuzzy symbol name (e.g. "mergeWithRRF"). |

## Returning Answer Shape

Actual responses depend on repository state, index freshness, and requested limits. A minimal expected shape is:

```json
{
  "status": "ok",
  "tool": "gn_find_related",
  "summary": "What is near this symbol?",
  "evidenceClasses": [
    "graph_evidence"
  ],
  "nextAction": "Symbol-level neighborhood"
}
```

## When It Is Useful

Symbol-level neighborhood.

## Operational Notes

- Kind: `super`.
- Contract status: `stable`.
- Discoverable modes: `general`, `audit`, `refactor`, `query-projects`.
- Audit authority: `false`.
- Advisory-only: `false`.
- Source of truth: `ontoindex/src/mcp/shared/tool-registry.ts` and `ontoindex/src/mcp/*/tool-definitions.ts`.

## Related Concepts

OntoIndex, MCP server, code graph, AI coding agent, static analysis, repository impact analysis, discovery, gn_find_related.
