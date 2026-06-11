# ADR-MCP-051: gn_test_gap

## Status

Accepted.

## Function

`gn_test_gap`

## SEO Summary

OntoIndex MCP function `gn_test_gap` supports report changed production symbols with missing test evidence for AI coding agents, local code graph analysis, repository safety workflows, and Model Context Protocol automation.

## Context

Post-edit test evidence review: report changed production symbols that have no linked tests or executed test evidence. Filename-derived matches remain heuristic until richer test data is ingested.

## Decision

Document `gn_test_gap` as a public OntoIndex MCP function because agents and human operators need a stable, linkable explanation of its purpose, predecessor surface, call shape, and returned evidence.

## Predecessors

Predecessor is the lower-level graph query, impact, audit, or backend action surface that existed before the public super-function/facade contract.

## How To Use

Call this function through an MCP client connected to the OntoIndex server.

```json
{
  "tool": "gn_test_gap",
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
- Typical result: Report changed production symbols with missing test evidence; After edits to confirm changed code still has linked or executed tests.

## Parameters

| Parameter | Type | Required | Purpose |
| --- | --- | --- | --- |
| `baseRef` | string | no | Alias for diffRef. |
| `changedFiles` | array | no | Optional changed files override. |
| `changedSymbols` | array | no | Optional changed symbols override. |
| `diffRef` | string | no | Optional compare base ref. When present, gn_test_gap uses compare mode. |
| `executedTests` | array | no | Tests actually executed. |
| `repo` | string | no | Repository name or path. Omit if only one repo is indexed. |
| `scope` | string: unstaged, staged, all, compare | no | Diff scope to inspect. Default: unstaged. |

## Returning Answer Shape

Actual responses depend on repository state, index freshness, and requested limits. A minimal expected shape is:

```json
{
  "status": "ok",
  "tool": "gn_test_gap",
  "summary": "Report changed production symbols with missing test evidence",
  "evidenceClasses": [
    "graph_evidence"
  ],
  "nextAction": "After edits to confirm changed code still has linked or executed tests"
}
```

## When It Is Useful

After edits to confirm changed code still has linked or executed tests.

## Operational Notes

- Kind: `super`.
- Contract status: `stable`.
- Discoverable modes: `general`, `audit`, `refactor`, `query-projects`.
- Audit authority: `false`.
- Advisory-only: `false`.
- Source of truth: `ontoindex/src/mcp/shared/tool-registry.ts` and `ontoindex/src/mcp/*/tool-definitions.ts`.

## Related Concepts

OntoIndex, MCP server, code graph, AI coding agent, static analysis, repository impact analysis, lifecycle, gn_test_gap.
