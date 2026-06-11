# ADR-MCP-013: gn_audit_replay

## Status

Accepted.

## Function

`gn_audit_replay`

## SEO Summary

OntoIndex MCP function `gn_audit_replay` supports plan re-verification of a prior session against a newer target head for AI coding agents, local code graph analysis, repository safety workflows, and Model Context Protocol automation.

## Context

Audit lifecycle replay planner: replay a session against a target HEAD by returning findings that need verify/reverify because status, target HEAD, or evidence freshness changed.

## Decision

Document `gn_audit_replay` as a public OntoIndex MCP function because agents and human operators need a stable, linkable explanation of its purpose, predecessor surface, call shape, and returned evidence.

## Predecessors

Predecessor is the lower-level graph query, impact, audit, or backend action surface that existed before the public super-function/facade contract.

## How To Use

Call this function through an MCP client connected to the OntoIndex server.

```json
{
  "tool": "gn_audit_replay",
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
- Typical result: Plan re-verification of a prior session against a newer target HEAD; When avoiding regenerated stale Markdown audits after code has changed.

## Parameters

| Parameter | Type | Required | Purpose |
| --- | --- | --- | --- |
| `maxFindings` | number | no | Maximum replay findings returned. Default: 100. |
| `repo` | string | no | Repository name or path. Omit if only one repo is indexed. |
| `session` | string | yes | Audit session id. |
| `sessionId` | string | no | Alias for session. |
| `targetHead` | string | no | Target HEAD to replay against. Default: current git HEAD. |

## Returning Answer Shape

Actual responses depend on repository state, index freshness, and requested limits. A minimal expected shape is:

```json
{
  "status": "ok",
  "tool": "gn_audit_replay",
  "summary": "Plan re-verification of a prior session against a newer target HEAD",
  "evidenceClasses": [
    "audit_evidence",
    "graph_evidence"
  ],
  "nextAction": "When avoiding regenerated stale Markdown audits after code has changed"
}
```

## When It Is Useful

When avoiding regenerated stale Markdown audits after code has changed.

## Operational Notes

- Kind: `super`.
- Contract status: `stable`.
- Discoverable modes: `general`, `audit`, `refactor`.
- Audit authority: `true`.
- Advisory-only: `false`.
- Source of truth: `ontoindex/src/mcp/shared/tool-registry.ts` and `ontoindex/src/mcp/*/tool-definitions.ts`.

## Related Concepts

OntoIndex, MCP server, code graph, AI coding agent, static analysis, repository impact analysis, audit, gn_audit_replay.
