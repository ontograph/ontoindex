# ADR-MCP-020: gn_audit_session_verify

## Status

Accepted.

## Function

`gn_audit_session_verify`

## SEO Summary

OntoIndex MCP function `gn_audit_session_verify` supports verify a locked audit session and enforce repeated-finding tombstones before work for AI coding agents, local code graph analysis, repository safety workflows, and Model Context Protocol automation.

## Context

Manager-level audit verify: refuse stale sessions, run fresh verification, and enforce repeated-finding tombstones before work can proceed.

## Decision

Document `gn_audit_session_verify` as a public OntoIndex MCP function because agents and human operators need a stable, linkable explanation of its purpose, predecessor surface, call shape, and returned evidence.

## Predecessors

Evolved from standalone audit ingest, verify, dedupe, bundle, dispatch, and review calls into a manager-loop lifecycle function.

## How To Use

Call this function through an MCP client connected to the OntoIndex server.

```json
{
  "tool": "gn_audit_session_verify",
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
- Typical result: Verify a locked audit session and enforce repeated-finding tombstones before work; Preferred verification step in the manager loop.

## Parameters

| Parameter | Type | Required | Purpose |
| --- | --- | --- | --- |
| `findingId` | string | no | Optional finding id filter. |
| `maxEvidence` | number | no | Maximum evidence items per finding. Default: 25. |
| `maxFindings` | number | no | Maximum findings verified in one response. Default: 25. |
| `persist` | boolean | no | Persist verification and repeated-finding tombstone events. Default: true. |
| `proofMode` | string: heuristic, path-sensitive, resource-ledger, runtime-required | no | Advisory proof-mode label for the manager loop. Default: "heuristic". |
| `repo` | string | no | Repository name or path. Omit if only one repo is indexed. |
| `session` | string | yes | Audit session id. |
| `sessionId` | string | no | Alias for session. |

## Returning Answer Shape

Actual responses depend on repository state, index freshness, and requested limits. A minimal expected shape is:

```json
{
  "status": "ok",
  "tool": "gn_audit_session_verify",
  "summary": "Verify a locked audit session and enforce repeated-finding tombstones before work",
  "evidenceClasses": [
    "audit_evidence"
  ],
  "nextAction": "Preferred verification step in the manager loop"
}
```

## When It Is Useful

Preferred verification step in the manager loop.

## Operational Notes

- Kind: `super`.
- Contract status: `stable`.
- Discoverable modes: `general`, `audit`, `refactor`.
- Audit authority: `true`.
- Advisory-only: `false`.
- Source of truth: `ontoindex/src/mcp/shared/tool-registry.ts` and `ontoindex/src/mcp/*/tool-definitions.ts`.

## Related Concepts

OntoIndex, MCP server, code graph, AI coding agent, static analysis, repository impact analysis, lifecycle, gn_audit_session_verify.
