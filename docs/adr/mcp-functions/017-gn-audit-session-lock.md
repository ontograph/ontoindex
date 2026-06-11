# ADR-MCP-017: gn_audit_session_lock

## Status

Accepted.

## Function

`gn_audit_session_lock`

## SEO Summary

OntoIndex MCP function `gn_audit_session_lock` supports create or validate a hard head/graph/tombstone lock for an audit session for AI coding agents, local code graph analysis, repository safety workflows, and Model Context Protocol automation.

## Context

Audit lifecycle session lock: create, load, or validate a hard audit session lock containing target HEAD, graph index/hash, OntoIndex version, and tombstone snapshot. Validation returns STALE_SESSION on drift.

## Decision

Document `gn_audit_session_lock` as a public OntoIndex MCP function because agents and human operators need a stable, linkable explanation of its purpose, predecessor surface, call shape, and returned evidence.

## Predecessors

Evolved from standalone audit ingest, verify, dedupe, bundle, dispatch, and review calls into a manager-loop lifecycle function.

## How To Use

Call this function through an MCP client connected to the OntoIndex server.

```json
{
  "tool": "gn_audit_session_lock",
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
- Typical result: Create or validate a hard HEAD/graph/tombstone lock for an audit session; Before lifecycle work and whenever current HEAD or graph freshness may have drifted.

## Parameters

| Parameter | Type | Required | Purpose |
| --- | --- | --- | --- |
| `action` | string: create, load, validate | no | Lock operation. Default: validate. |
| `currentHead` | string | no | Override current HEAD for validation tests. |
| `graphHash` | string | no | Override current graph hash for creation/validation. |
| `graphIndexId` | string | no | Override current graph index id for validation. |
| `ontoindexVersion` | string | no | Override OntoIndex version recorded in the lock. |
| `repo` | string | no | Repository name or path. Omit if only one repo is indexed. |
| `session` | string | yes | Audit session id. |
| `sessionId` | string | no | Alias for session. |

## Returning Answer Shape

Actual responses depend on repository state, index freshness, and requested limits. A minimal expected shape is:

```json
{
  "status": "ok",
  "tool": "gn_audit_session_lock",
  "summary": "Create or validate a hard HEAD/graph/tombstone lock for an audit session",
  "evidenceClasses": [
    "audit_evidence"
  ],
  "nextAction": "Before lifecycle work and whenever current HEAD or graph freshness may have drifted"
}
```

## When It Is Useful

Before lifecycle work and whenever current HEAD or graph freshness may have drifted.

## Operational Notes

- Kind: `super`.
- Contract status: `stable`.
- Discoverable modes: `general`, `audit`, `refactor`.
- Audit authority: `true`.
- Advisory-only: `false`.
- Source of truth: `ontoindex/src/mcp/shared/tool-registry.ts` and `ontoindex/src/mcp/*/tool-definitions.ts`.

## Related Concepts

OntoIndex, MCP server, code graph, AI coding agent, static analysis, repository impact analysis, lifecycle, gn_audit_session_lock.
