# ADR-MCP-007: gn_audit_diff

## Status

Accepted.

## Function

`gn_audit_diff`

## SEO Summary

OntoIndex MCP function `gn_audit_diff` supports show semantic changes between two audit sessions for AI coding agents, local code graph analysis, repository safety workflows, and Model Context Protocol automation.

## Context

Audit lifecycle diff: compare two persisted audit sessions by finding fingerprint/id and report added, removed, status-changed, and unchanged findings.

## Decision

Document `gn_audit_diff` as a public OntoIndex MCP function because agents and human operators need a stable, linkable explanation of its purpose, predecessor surface, call shape, and returned evidence.

## Predecessors

Predecessor is the lower-level graph query, impact, audit, or backend action surface that existed before the public super-function/facade contract.

## How To Use

Call this function through an MCP client connected to the OntoIndex server.

```json
{
  "tool": "gn_audit_diff",
  "arguments": {
    "repo": "my-repo",
    "sessionA": "example",
    "sessionB": "example"
  }
}
```

## What Information You Can Get

- Category: `audit`.
- Evidence classes: `audit_evidence`, `graph_evidence`.
- Response style: structured JSON suitable for automation.
- Permission profile: `read_only`.
- Typical result: Show semantic changes between two audit sessions; When comparing audit rounds or producing an audit changelog.

## Parameters

| Parameter | Type | Required | Purpose |
| --- | --- | --- | --- |
| `maxEntries` | number | no | Maximum entries per diff bucket. Default: 100. |
| `repo` | string | no | Repository name or path. Omit if only one repo is indexed. |
| `sessionA` | string | yes | Previous audit session id. |
| `sessionB` | string | yes | Current audit session id. |

## Returning Answer Shape

Actual responses depend on repository state, index freshness, and requested limits. A minimal expected shape is:

```json
{
  "status": "ok",
  "tool": "gn_audit_diff",
  "summary": "Show semantic changes between two audit sessions",
  "evidenceClasses": [
    "audit_evidence",
    "graph_evidence"
  ],
  "nextAction": "When comparing audit rounds or producing an audit changelog"
}
```

## When It Is Useful

When comparing audit rounds or producing an audit changelog.

## Operational Notes

- Kind: `super`.
- Contract status: `stable`.
- Discoverable modes: `general`, `audit`, `refactor`, `query-projects`.
- Audit authority: `true`.
- Advisory-only: `false`.
- Source of truth: `ontoindex/src/mcp/shared/tool-registry.ts` and `ontoindex/src/mcp/*/tool-definitions.ts`.

## Related Concepts

OntoIndex, MCP server, code graph, AI coding agent, static analysis, repository impact analysis, audit, gn_audit_diff.
