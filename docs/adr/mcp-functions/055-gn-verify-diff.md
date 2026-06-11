# ADR-MCP-055: gn_verify_diff

## Status

Accepted.

## Function

`gn_verify_diff`

## SEO Summary

OntoIndex MCP function `gn_verify_diff` supports compare expected scope against actual changed files, symbols, impact, and tests for AI coding agents, local code graph analysis, repository safety workflows, and Model Context Protocol automation.

## Context

Post-edit diff verification: compare expected files, symbols, and tests against actual changed files, changed symbols, impacted symbols, and executed tests.

## Decision

Document `gn_verify_diff` as a public OntoIndex MCP function because agents and human operators need a stable, linkable explanation of its purpose, predecessor surface, call shape, and returned evidence.

## Predecessors

Predecessor is the lower-level graph query, impact, audit, or backend action surface that existed before the public super-function/facade contract.

## How To Use

Call this function through an MCP client connected to the OntoIndex server.

```json
{
  "tool": "gn_verify_diff",
  "arguments": {
    "repo": "my-repo"
  }
}
```

## What Information You Can Get

- Category: `lifecycle`.
- Evidence classes: `graph_evidence`.
- Response style: structured JSON suitable for automation.
- Permission profile: `write_apply`.
- Typical result: Compare expected scope against actual changed files, symbols, impact, and tests; After edits when detect_changes alone is too vague.

## Parameters

| Parameter | Type | Required | Purpose |
| --- | --- | --- | --- |
| `baseRef` | string | no | Alias for diffRef. |
| `changedFiles` | array | no | Optional changed files override. |
| `changedSymbols` | array | no | Optional changed symbols override. |
| `diffRef` | string | no | Optional compare base ref. When present, gn_verify_diff uses compare mode. |
| `executedTests` | array | no | Tests actually executed. |
| `expectedFiles` | array | no | Expected changed files. |
| `expectedSymbols` | array | no | Expected changed symbols. |
| `expectedTests` | array | no | Required executed tests. |
| `repo` | string | no | Repository name or path. Omit if only one repo is indexed. |
| `scope` | string: unstaged, staged, all, compare | no | Diff scope to inspect. Default: unstaged. |

## Returning Answer Shape

Actual responses depend on repository state, index freshness, and requested limits. A minimal expected shape is:

```json
{
  "status": "ok",
  "tool": "gn_verify_diff",
  "summary": "Compare expected scope against actual changed files, symbols, impact, and tests",
  "evidenceClasses": [
    "graph_evidence"
  ],
  "nextAction": "After edits when detect_changes alone is too vague"
}
```

## When It Is Useful

After edits when detect_changes alone is too vague.

## Operational Notes

- Kind: `super`.
- Contract status: `stable`.
- Discoverable modes: `general`, `audit`, `refactor`.
- Audit authority: `false`.
- Advisory-only: `false`.
- Source of truth: `ontoindex/src/mcp/shared/tool-registry.ts` and `ontoindex/src/mcp/*/tool-definitions.ts`.

## Related Concepts

OntoIndex, MCP server, code graph, AI coding agent, static analysis, repository impact analysis, lifecycle, gn_verify_diff.
