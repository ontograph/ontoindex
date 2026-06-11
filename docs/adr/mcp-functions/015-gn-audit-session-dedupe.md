# ADR-MCP-015: gn_audit_session_dedupe

## Status

Accepted.

## Function

`gn_audit_session_dedupe`

## SEO Summary

OntoIndex MCP function `gn_audit_session_dedupe` supports collapse duplicates inside the locked manager loop for AI coding agents, local code graph analysis, repository safety workflows, and Model Context Protocol automation.

## Context

Manager-level audit dedupe: refuse stale sessions, then collapse duplicates before implementation planning or dispatch.

## Decision

Document `gn_audit_session_dedupe` as a public OntoIndex MCP function because agents and human operators need a stable, linkable explanation of its purpose, predecessor surface, call shape, and returned evidence.

## Predecessors

Evolved from standalone audit ingest, verify, dedupe, bundle, dispatch, and review calls into a manager-loop lifecycle function.

## How To Use

Call this function through an MCP client connected to the OntoIndex server.

```json
{
  "tool": "gn_audit_session_dedupe",
  "arguments": {
    "repo": "my-repo",
    "session": "audit-session-001"
  }
}
```

## What Information You Can Get

- Category: `lifecycle`.
- Evidence classes: `audit_evidence`.
- Response style: structured JSON suitable for automation.
- Permission profile: `write_apply`.
- Typical result: Collapse duplicates inside the locked manager loop; Before manager bundling or dispatch.

## Parameters

| Parameter | Type | Required | Purpose |
| --- | --- | --- | --- |
| `maxGroups` | number | no | Maximum groups returned. Default: 50. |
| `repo` | string | no | Repository name or path. Omit if only one repo is indexed. |
| `session` | string | yes | Audit session id. |
| `sessionId` | string | no | Alias for session. |
| `strategy` | string: exact, symbol, root-cause, write-set, test-surface | no | Dedupe strategy. Default: root-cause. |

## Returning Answer Shape

Actual responses depend on repository state, index freshness, and requested limits. A minimal expected shape is:

```json
{
  "status": "ok",
  "tool": "gn_audit_session_dedupe",
  "summary": "Collapse duplicates inside the locked manager loop",
  "evidenceClasses": [
    "audit_evidence"
  ],
  "nextAction": "Before manager bundling or dispatch"
}
```

## When It Is Useful

Before manager bundling or dispatch.

## Operational Notes

- Kind: `super`.
- Contract status: `stable`.
- Discoverable modes: `general`, `audit`, `refactor`.
- Audit authority: `true`.
- Advisory-only: `false`.
- Source of truth: `ontoindex/src/mcp/shared/tool-registry.ts` and `ontoindex/src/mcp/*/tool-definitions.ts`.

## Related Concepts

OntoIndex, MCP server, code graph, AI coding agent, static analysis, repository impact analysis, lifecycle, gn_audit_session_dedupe.
