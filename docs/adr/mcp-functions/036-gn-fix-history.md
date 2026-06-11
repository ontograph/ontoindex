# ADR-MCP-036: gn_fix_history

## Status

Accepted.

## Function

`gn_fix_history`

## SEO Summary

OntoIndex MCP function `gn_fix_history` supports find commits that may have fixed a finding for AI coding agents, local code graph analysis, repository safety workflows, and Model Context Protocol automation.

## Context

Audit lifecycle fix-history lookup: search git history at target HEAD for commits matching supplied fix or negative-evidence patterns.

## Decision

Document `gn_fix_history` as a public OntoIndex MCP function because agents and human operators need a stable, linkable explanation of its purpose, predecessor surface, call shape, and returned evidence.

## Predecessors

Predecessor is the lower-level graph query, impact, audit, or backend action surface that existed before the public super-function/facade contract.

## How To Use

Call this function through an MCP client connected to the OntoIndex server.

```json
{
  "tool": "gn_fix_history",
  "arguments": {
    "repo": "my-repo",
    "targetHead": "example",
    "path": "src/auth/validate-user.ts",
    "limit": 20
  }
}
```

## What Information You Can Get

- Category: `audit`.
- Evidence classes: `audit_evidence`, `graph_evidence`.
- Response style: structured JSON suitable for automation.
- Permission profile: `write_apply`.
- Typical result: Find commits that may have fixed a finding; When a finding may be stale or already resolved.

## Parameters

| Parameter | Type | Required | Purpose |
| --- | --- | --- | --- |
| `limit` | number | no | Maximum commits returned. Default: 20, max: 100. |
| `path` | string | yes | Repository-relative file path to search. |
| `patterns` | array | no | Git -G patterns to search in history. |
| `repo` | string | no | Repository name or path. Omit if only one repo is indexed. |
| `targetHead` | string | yes | Locked target commit to search from. |

## Returning Answer Shape

Actual responses depend on repository state, index freshness, and requested limits. A minimal expected shape is:

```json
{
  "status": "ok",
  "tool": "gn_fix_history",
  "summary": "Find commits that may have fixed a finding",
  "evidenceClasses": [
    "audit_evidence",
    "graph_evidence"
  ],
  "nextAction": "When a finding may be stale or already resolved"
}
```

## When It Is Useful

When a finding may be stale or already resolved.

## Operational Notes

- Kind: `super`.
- Contract status: `stable`.
- Discoverable modes: `general`, `audit`, `refactor`.
- Audit authority: `true`.
- Advisory-only: `false`.
- Source of truth: `ontoindex/src/mcp/shared/tool-registry.ts` and `ontoindex/src/mcp/*/tool-definitions.ts`.

## Related Concepts

OntoIndex, MCP server, code graph, AI coding agent, static analysis, repository impact analysis, audit, gn_fix_history.
