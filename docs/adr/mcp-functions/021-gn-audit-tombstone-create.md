# ADR-MCP-021: gn_audit_tombstone_create

## Status

Accepted.

## Function

`gn_audit_tombstone_create`

## SEO Summary

OntoIndex MCP function `gn_audit_tombstone_create` supports record fixed findings that must not be reopened while invariants hold for AI coding agents, local code graph analysis, repository safety workflows, and Model Context Protocol automation.

## Context

Audit lifecycle tombstone creation: mark a resolved finding as tombstoned with negative/fix-proof evidence so future stale audit reports can be rejected.

## Decision

Document `gn_audit_tombstone_create` as a public OntoIndex MCP function because agents and human operators need a stable, linkable explanation of its purpose, predecessor surface, call shape, and returned evidence.

## Predecessors

Predecessor is the lower-level graph query, impact, audit, or backend action surface that existed before the public super-function/facade contract.

## How To Use

Call this function through an MCP client connected to the OntoIndex server.

```json
{
  "tool": "gn_audit_tombstone_create",
  "arguments": {
    "repo": "my-repo",
    "session": "audit-session-001",
    "findingId": "example",
    "reason": "example"
  }
}
```

## What Information You Can Get

- Category: `audit`.
- Evidence classes: `audit_evidence`, `graph_evidence`.
- Response style: structured JSON suitable for automation.
- Permission profile: `write_apply`.
- Typical result: Record fixed findings that must not be reopened while invariants hold; After a verified fix or RESOLVED-ALREADY classification.

## Parameters

| Parameter | Type | Required | Purpose |
| --- | --- | --- | --- |
| `findingId` | string | yes | Finding id to tombstone. |
| `fixCommit` | string | no | Optional fix commit sha. |
| `invariantId` | string | no | Optional fix invariant id. |
| `persist` | boolean | no | Persist FindingTombstoned event. Default: true. |
| `reason` | string | yes | Why this finding must not be reopened without invariant failure. |
| `repo` | string | no | Repository name or path. Omit if only one repo is indexed. |
| `session` | string | yes | Audit session id. |
| `sessionId` | string | no | Alias for session. |

## Returning Answer Shape

Actual responses depend on repository state, index freshness, and requested limits. A minimal expected shape is:

```json
{
  "status": "ok",
  "tool": "gn_audit_tombstone_create",
  "summary": "Record fixed findings that must not be reopened while invariants hold",
  "evidenceClasses": [
    "audit_evidence",
    "graph_evidence"
  ],
  "nextAction": "After a verified fix or RESOLVED-ALREADY classification"
}
```

## When It Is Useful

After a verified fix or RESOLVED-ALREADY classification.

## Operational Notes

- Kind: `super`.
- Contract status: `stable`.
- Discoverable modes: `general`, `audit`, `refactor`.
- Audit authority: `true`.
- Advisory-only: `false`.
- Source of truth: `ontoindex/src/mcp/shared/tool-registry.ts` and `ontoindex/src/mcp/*/tool-definitions.ts`.

## Related Concepts

OntoIndex, MCP server, code graph, AI coding agent, static analysis, repository impact analysis, audit, gn_audit_tombstone_create.
