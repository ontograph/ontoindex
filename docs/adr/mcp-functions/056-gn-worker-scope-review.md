# ADR-MCP-056: gn_worker_scope_review

## Status

Accepted.

## Function

`gn_worker_scope_review`

## SEO Summary

OntoIndex MCP function `gn_worker_scope_review` supports run write-through review for a dispatched bundle after worker edits for AI coding agents, local code graph analysis, repository safety workflows, and Model Context Protocol automation.

## Context

Write-through worker review: validate a bundle against changed files, changed symbols, impacted symbols, executed tests, and missing test evidence after worker edits.

## Decision

Document `gn_worker_scope_review` as a public OntoIndex MCP function because agents and human operators need a stable, linkable explanation of its purpose, predecessor surface, call shape, and returned evidence.

## Predecessors

Predecessor is the lower-level graph query, impact, audit, or backend action surface that existed before the public super-function/facade contract.

## How To Use

Call this function through an MCP client connected to the OntoIndex server.

```json
{
  "tool": "gn_worker_scope_review",
  "arguments": {
    "repo": "my-repo",
    "session": "audit-session-001",
    "bundleId": "bundle-001"
  }
}
```

## What Information You Can Get

- Category: `lifecycle`.
- Evidence classes: `graph_evidence`.
- Response style: structured JSON suitable for automation.
- Permission profile: `write_apply`.
- Typical result: Run write-through review for a dispatched bundle after worker edits; Preferred explicit worker verification step after bundle edits.

## Parameters

| Parameter | Type | Required | Purpose |
| --- | --- | --- | --- |
| `bundleId` | string | yes | Bundle id under review. |
| `changedFiles` | array | no | Changed files from the implementation diff. |
| `changedSymbols` | array | no | Changed symbols from the implementation diff. |
| `commit` | string | no | Optional compare base ref or commit for diff collection. |
| `executedTests` | array | no | Tests actually run by the worker. |
| `repo` | string | no | Repository name or path. Omit if only one repo is indexed. |
| `requiredTests` | array | no | Override required tests for this review. |
| `session` | string | yes | Audit session id. |
| `sessionId` | string | no | Alias for session. |

## Returning Answer Shape

Actual responses depend on repository state, index freshness, and requested limits. A minimal expected shape is:

```json
{
  "status": "ok",
  "tool": "gn_worker_scope_review",
  "summary": "Run write-through review for a dispatched bundle after worker edits",
  "evidenceClasses": [
    "graph_evidence"
  ],
  "nextAction": "Preferred explicit worker verification step after bundle edits"
}
```

## When It Is Useful

Preferred explicit worker verification step after bundle edits.

## Operational Notes

- Kind: `super`.
- Contract status: `stable`.
- Discoverable modes: `general`, `audit`, `refactor`.
- Audit authority: `false`.
- Advisory-only: `false`.
- Source of truth: `ontoindex/src/mcp/shared/tool-registry.ts` and `ontoindex/src/mcp/*/tool-definitions.ts`.

## Related Concepts

OntoIndex, MCP server, code graph, AI coding agent, static analysis, repository impact analysis, lifecycle, gn_worker_scope_review.
