# ADR-MCP-006: gn_audit_dedupe

## Status

Accepted.

## Function

`gn_audit_dedupe`

## SEO Summary

OntoIndex MCP function `gn_audit_dedupe` supports collapse duplicate findings by root cause, write-set, symbol, or test surface for AI coding agents, local code graph analysis, repository safety workflows, and Model Context Protocol automation.

## Context

Audit lifecycle dedupe: group findings by exact fingerprint, symbol, root cause, write-set, or test surface so stale duplicate audit claims collapse before dispatch.

## Decision

Document `gn_audit_dedupe` as a public OntoIndex MCP function because agents and human operators need a stable, linkable explanation of its purpose, predecessor surface, call shape, and returned evidence.

## Predecessors

Predecessor is the lower-level graph query, impact, audit, or backend action surface that existed before the public super-function/facade contract.

## How To Use

Call this function through an MCP client connected to the OntoIndex server.

```json
{
  "tool": "gn_audit_dedupe",
  "arguments": {
    "repo": "my-repo",
    "session": "audit-session-001"
  }
}
```

## What Information You Can Get

- Category: `audit`.
- Evidence classes: `audit_evidence`, `graph_evidence`.
- Response style: structured JSON suitable for automation.
- Permission profile: `write_apply`.
- Typical result: Collapse duplicate findings by root cause, write-set, symbol, or test surface; Before bundling noisy audit reports or re-emitted stale claims.

## Parameters

| Parameter | Type | Required | Purpose |
| --- | --- | --- | --- |
| `maxGroups` | number | no | Maximum groups returned. Default: 50. |
| `repo` | string | no | Repository name or path. Omit if only one repo is indexed. |
| `session` | string | yes | Audit session id. |
| `sessionId` | string | no | Alias for session. |
| `strategy` | string: exact, symbol, root-cause, write-set, test-surface | no | Optional dedupe strategy filter. |

## Returning Answer Shape

Actual responses depend on repository state, index freshness, and requested limits. A minimal expected shape is:

```json
{
  "status": "ok",
  "tool": "gn_audit_dedupe",
  "summary": "Collapse duplicate findings by root cause, write-set, symbol, or test surface",
  "evidenceClasses": [
    "audit_evidence",
    "graph_evidence"
  ],
  "nextAction": "Before bundling noisy audit reports or re-emitted stale claims"
}
```

## When It Is Useful

Before bundling noisy audit reports or re-emitted stale claims.

## Operational Notes

- Kind: `super`.
- Contract status: `stable`.
- Discoverable modes: `general`, `audit`, `refactor`.
- Audit authority: `true`.
- Advisory-only: `false`.
- Source of truth: `ontoindex/src/mcp/shared/tool-registry.ts` and `ontoindex/src/mcp/*/tool-definitions.ts`.

## Related Concepts

OntoIndex, MCP server, code graph, AI coding agent, static analysis, repository impact analysis, audit, gn_audit_dedupe.
