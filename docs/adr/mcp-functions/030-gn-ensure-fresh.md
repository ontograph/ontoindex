# ADR-MCP-030: gn_ensure_fresh

## Status

Accepted.

## Function

`gn_ensure_fresh`

## SEO Summary

OntoIndex MCP function `gn_ensure_fresh` supports make sure the index is current for AI coding agents, local code graph analysis, repository safety workflows, and Model Context Protocol automation.

## Context

Index lifecycle helper: reports whether the OntoIndex index is stale (indexed commit ≠ current HEAD), surfaces embeddings status, and optionally re-runs `ontoindex analyze` using the current CLI process when autoAnalyze: true is passed.

## Decision

Document `gn_ensure_fresh` as a public OntoIndex MCP function because agents and human operators need a stable, linkable explanation of its purpose, predecessor surface, call shape, and returned evidence.

## Predecessors

Predecessor is the lower-level graph query, impact, audit, or backend action surface that existed before the public super-function/facade contract.

## How To Use

Call this function through an MCP client connected to the OntoIndex server.

```json
{
  "tool": "gn_ensure_fresh",
  "arguments": {
    "repo": "my-repo"
  }
}
```

## What Information You Can Get

- Category: `lifecycle`.
- Evidence classes: `graph_evidence`.
- Response style: structured JSON suitable for automation.
- Permission profile: `read_only`.
- Typical result: Make sure the index is current; Before retrieval-heavy ops if repo edited recently.

## Parameters

| Parameter | Type | Required | Purpose |
| --- | --- | --- | --- |
| `autoAnalyze` | boolean | no | Automatically run ontoindex analyze when the index is stale. Default: false. |
| `killMcpForLock` | boolean | no | Advisory only: report lock-release guidance before analyzing. OntoIndex will not terminate MCP processes. Default: false. |
| `repo` | string | no | Repository name or path. Omit if only one repo is indexed. |
| `withEmbeddings` | boolean | no | Also check and populate embeddings. Default: false. |

## Returning Answer Shape

Actual responses depend on repository state, index freshness, and requested limits. A minimal expected shape is:

```json
{
  "status": "ok",
  "tool": "gn_ensure_fresh",
  "summary": "Make sure the index is current",
  "evidenceClasses": [
    "graph_evidence"
  ],
  "nextAction": "Before retrieval-heavy ops if repo edited recently"
}
```

## When It Is Useful

Before retrieval-heavy ops if repo edited recently.

## Operational Notes

- Kind: `super`.
- Contract status: `stable`.
- Discoverable modes: `general`, `audit`, `refactor`, `query-projects`.
- Audit authority: `false`.
- Advisory-only: `false`.
- Source of truth: `ontoindex/src/mcp/shared/tool-registry.ts` and `ontoindex/src/mcp/*/tool-definitions.ts`.

## Related Concepts

OntoIndex, MCP server, code graph, AI coding agent, static analysis, repository impact analysis, lifecycle, gn_ensure_fresh.
