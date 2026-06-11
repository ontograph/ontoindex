# ADR-MCP-019: gn_audit_session_start

## Status

Accepted.

## Function

`gn_audit_session_start`

## SEO Summary

OntoIndex MCP function `gn_audit_session_start` supports start the governed manager loop by ingesting findings and creating a session lock for AI coding agents, local code graph analysis, repository safety workflows, and Model Context Protocol automation.

## Context

Manager-level audit session start: ingest findings and create the session lock that governs the rest of the audit loop.

## Decision

Document `gn_audit_session_start` as a public OntoIndex MCP function because agents and human operators need a stable, linkable explanation of its purpose, predecessor surface, call shape, and returned evidence.

## Predecessors

Evolved from standalone audit ingest, verify, dedupe, bundle, dispatch, and review calls into a manager-loop lifecycle function.

## How To Use

Call this function through an MCP client connected to the OntoIndex server.

```json
{
  "tool": "gn_audit_session_start",
  "arguments": {
    "repo": "my-repo"
  }
}
```

## What Information You Can Get

- Category: `lifecycle`.
- Evidence classes: `audit_evidence`.
- Response style: structured JSON suitable for automation.
- Permission profile: `write_apply`.
- Typical result: Start the governed manager loop by ingesting findings and creating a session lock; Preferred first step for customer-facing audit work.

## Parameters

| Parameter | Type | Required | Purpose |
| --- | --- | --- | --- |
| `graphIndexId` | string | no | Optional graph index identity to attach to candidates. |
| `maxFindings` | number | no | Maximum findings returned. Default: 25. |
| `pastedText` | string | no | Pasted audit report text. |
| `persist` | boolean | no | Persist ingest events and session lock. Default: true. |
| `repo` | string | no | Repository name or path. Omit if only one repo is indexed. |
| `sourcePath` | string | no | Markdown audit report path. |
| `strictFresh` | boolean | no | Advisory manager preference for strict freshness handling. Default: true. |
| `targetRef` | string | no | Target git ref to ingest against. Default: HEAD. |

## Returning Answer Shape

Actual responses depend on repository state, index freshness, and requested limits. A minimal expected shape is:

```json
{
  "status": "ok",
  "tool": "gn_audit_session_start",
  "summary": "Start the governed manager loop by ingesting findings and creating a session lock",
  "evidenceClasses": [
    "audit_evidence"
  ],
  "nextAction": "Preferred first step for customer-facing audit work"
}
```

## When It Is Useful

Preferred first step for customer-facing audit work.

## Operational Notes

- Kind: `super`.
- Contract status: `stable`.
- Discoverable modes: `general`, `audit`, `refactor`.
- Audit authority: `true`.
- Advisory-only: `false`.
- Source of truth: `ontoindex/src/mcp/shared/tool-registry.ts` and `ontoindex/src/mcp/*/tool-definitions.ts`.

## Related Concepts

OntoIndex, MCP server, code graph, AI coding agent, static analysis, repository impact analysis, lifecycle, gn_audit_session_start.
