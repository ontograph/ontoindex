# ADR-MCP-008: gn_audit_export

## Status

Accepted.

## Function

`gn_audit_export`

## SEO Summary

OntoIndex MCP function `gn_audit_export` supports export canonical audit session json or generated markdown for AI coding agents, local code graph analysis, repository safety workflows, and Model Context Protocol automation.

## Context

Audit lifecycle export: produce canonical JSON and/or generated Markdown from a persisted audit session so agents do not manually regenerate stale prose reports.

## Decision

Document `gn_audit_export` as a public OntoIndex MCP function because agents and human operators need a stable, linkable explanation of its purpose, predecessor surface, call shape, and returned evidence.

## Predecessors

Predecessor is the lower-level graph query, impact, audit, or backend action surface that existed before the public super-function/facade contract.

## How To Use

Call this function through an MCP client connected to the OntoIndex server.

```json
{
  "tool": "gn_audit_export",
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
- Permission profile: `read_only`.
- Typical result: Export canonical audit session JSON or generated Markdown; When producing audit artifacts without hand-written stale prose reports.

## Parameters

| Parameter | Type | Required | Purpose |
| --- | --- | --- | --- |
| `format` | string: json, markdown, both | no | Export format. Default: json. |
| `maxFindings` | number | no | Maximum findings exported. Default: 500. |
| `repo` | string | no | Repository name or path. Omit if only one repo is indexed. |
| `session` | string | yes | Audit session id. |
| `sessionId` | string | no | Alias for session. |

## Returning Answer Shape

Actual responses depend on repository state, index freshness, and requested limits. A minimal expected shape is:

```json
{
  "status": "ok",
  "tool": "gn_audit_export",
  "summary": "Export canonical audit session JSON or generated Markdown",
  "evidenceClasses": [
    "audit_evidence",
    "graph_evidence"
  ],
  "nextAction": "When producing audit artifacts without hand-written stale prose reports"
}
```

## When It Is Useful

When producing audit artifacts without hand-written stale prose reports.

## Operational Notes

- Kind: `super`.
- Contract status: `stable`.
- Discoverable modes: `general`, `audit`, `refactor`, `query-projects`.
- Audit authority: `true`.
- Advisory-only: `false`.
- Source of truth: `ontoindex/src/mcp/shared/tool-registry.ts` and `ontoindex/src/mcp/*/tool-definitions.ts`.

## Related Concepts

OntoIndex, MCP server, code graph, AI coding agent, static analysis, repository impact analysis, audit, gn_audit_export.
