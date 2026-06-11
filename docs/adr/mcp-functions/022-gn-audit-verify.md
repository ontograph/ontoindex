# ADR-MCP-022: gn_audit_verify

## Status

Accepted.

## Function

`gn_audit_verify`

## SEO Summary

OntoIndex MCP function `gn_audit_verify` supports verify candidate findings against target head for AI coding agents, local code graph analysis, repository safety workflows, and Model Context Protocol automation.

## Context

Audit lifecycle verify: re-check candidate findings against fresh target HEAD evidence and classify unsupported or incomplete proof without promoting stale findings to OPEN.

## Decision

Document `gn_audit_verify` as a public OntoIndex MCP function because agents and human operators need a stable, linkable explanation of its purpose, predecessor surface, call shape, and returned evidence.

## Predecessors

Predecessor is the lower-level graph query, impact, audit, or backend action surface that existed before the public super-function/facade contract.

## How To Use

Call this function through an MCP client connected to the OntoIndex server.

```json
{
  "tool": "gn_audit_verify",
  "arguments": {
    "repo": "my-repo"
  }
}
```

## What Information You Can Get

- Category: `audit`.
- Evidence classes: `audit_evidence`, `graph_evidence`.
- Response style: structured JSON suitable for automation.
- Permission profile: `write_apply`.
- Typical result: Verify candidate findings against target HEAD; Before accepting OPEN or RESOLVED audit status.

## Parameters

| Parameter | Type | Required | Purpose |
| --- | --- | --- | --- |
| `finding` | object | no | Inline lifecycle finding object to verify instead of loading a session. |
| `findingId` | string | no | Optional finding id filter. |
| `legacyResponse` | boolean | no | Return the legacy pre-envelope response shape. Default: true. Set false to opt into the capability-aware response envelope. |
| `maxEvidence` | number | no | Maximum evidence items per finding. Default: 25, max: 100. |
| `maxFindings` | number | no | Maximum findings verified in one response. Default: 25, max: 100. |
| `persist` | boolean | no | Persist verification/status events when a session is supplied. Default: true. |
| `repo` | string | no | Repository name or path. Omit if only one repo is indexed. |
| `session` | string | no | Audit session id. Alias for sessionId. |
| `sessionId` | string | no | Audit session id. |

## Returning Answer Shape

Actual responses depend on repository state, index freshness, and requested limits. A minimal expected shape is:

```json
{
  "status": "ok",
  "tool": "gn_audit_verify",
  "summary": "Verify candidate findings against target HEAD",
  "evidenceClasses": [
    "audit_evidence",
    "graph_evidence"
  ],
  "nextAction": "Before accepting OPEN or RESOLVED audit status"
}
```

## When It Is Useful

Before accepting OPEN or RESOLVED audit status.

## Operational Notes

- Kind: `super`.
- Contract status: `stable`.
- Discoverable modes: `general`, `audit`, `refactor`.
- Audit authority: `true`.
- Advisory-only: `false`.
- Source of truth: `ontoindex/src/mcp/shared/tool-registry.ts` and `ontoindex/src/mcp/*/tool-definitions.ts`.

## Related Concepts

OntoIndex, MCP server, code graph, AI coding agent, static analysis, repository impact analysis, audit, gn_audit_verify.
