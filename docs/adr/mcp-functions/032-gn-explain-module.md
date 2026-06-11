# ADR-MCP-032: gn_explain_module

## Status

Accepted.

## Function

`gn_explain_module`

## SEO Summary

OntoIndex MCP function `gn_explain_module` supports what does this file do? for AI coding agents, local code graph analysis, repository safety workflows, and Model Context Protocol automation.

## Context

File/module overview: given a file path, returns exported symbols, cluster membership, co-changed files, last-commit date, and file stats — all in one call.

## Decision

Document `gn_explain_module` as a public OntoIndex MCP function because agents and human operators need a stable, linkable explanation of its purpose, predecessor surface, call shape, and returned evidence.

## Predecessors

Predecessor is the lower-level graph query, impact, audit, or backend action surface that existed before the public super-function/facade contract.

## How To Use

Call this function through an MCP client connected to the OntoIndex server.

```json
{
  "tool": "gn_explain_module",
  "arguments": {
    "repo": "my-repo",
    "filePath": "src/auth/validate-user.ts"
  }
}
```

## What Information You Can Get

- Category: `discovery`.
- Evidence classes: `graph_evidence`.
- Response style: structured JSON suitable for automation.
- Permission profile: `read_only`.
- Typical result: What does this file do; Need overview of a specific file.

## Parameters

| Parameter | Type | Required | Purpose |
| --- | --- | --- | --- |
| `filePath` | string | yes | Relative or absolute path to the file (e.g. "ontoindex/src/core/search/per-intent-ensemble.ts"). |
| `includeCoChange` | boolean | no | Include co-changed file partners from git history. Default: true. |
| `includePublicAPI` | boolean | no | Include the list of exported symbols. Default: true. |
| `includeSkeleton` | boolean | no | Include a text skeleton of the file. Default: true. |
| `recentTouchDays` | number | no | Window in days for "recently touched" classification. Default: 30. |
| `repo` | string | no | Repository name or path. Omit if only one repo is indexed. |

## Returning Answer Shape

Actual responses depend on repository state, index freshness, and requested limits. A minimal expected shape is:

```json
{
  "status": "ok",
  "tool": "gn_explain_module",
  "summary": "What does this file do?",
  "evidenceClasses": [
    "graph_evidence"
  ],
  "nextAction": "Need overview of a specific file"
}
```

## When It Is Useful

Need overview of a specific file.

## Operational Notes

- Kind: `super`.
- Contract status: `stable`.
- Discoverable modes: `general`, `audit`, `refactor`, `query-projects`.
- Audit authority: `false`.
- Advisory-only: `false`.
- Source of truth: `ontoindex/src/mcp/shared/tool-registry.ts` and `ontoindex/src/mcp/*/tool-definitions.ts`.

## Related Concepts

OntoIndex, MCP server, code graph, AI coding agent, static analysis, repository impact analysis, discovery, gn_explain_module.
