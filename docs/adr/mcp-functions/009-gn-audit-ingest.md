# ADR-MCP-009: gn_audit_ingest

## Status

Accepted.

## Function

`gn_audit_ingest`

## SEO Summary

OntoIndex MCP function `gn_audit_ingest` supports ingest an audit report as candidate findings for AI coding agents, local code graph analysis, repository safety workflows, and Model Context Protocol automation.

## Context

Audit lifecycle ingest: parse a Markdown report or pasted findings into untrusted candidate findings at a locked target HEAD. Ingest never creates OPEN findings.

## Decision

Document `gn_audit_ingest` as a public OntoIndex MCP function because agents and human operators need a stable, linkable explanation of its purpose, predecessor surface, call shape, and returned evidence.

## Predecessors

Predecessor is the lower-level graph query, impact, audit, or backend action surface that existed before the public super-function/facade contract.

## How To Use

Call this function through an MCP client connected to the OntoIndex server.

```json
{
  "tool": "gn_audit_ingest",
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
- Typical result: Ingest an audit report as candidate findings; Before verifying or bundling audit findings; never emits OPEN.

## Parameters

| Parameter | Type | Required | Purpose |
| --- | --- | --- | --- |
| `graphIndexId` | string | no | Optional graph index identity to attach to candidates. |
| `maxFindings` | number | no | Maximum findings returned. Default: 25, max: 100. |
| `persist` | boolean | no | Persist ingest events to .ontoindex/audit. Default: true. |
| `repo` | string | no | Repository name or path. Omit if only one repo is indexed. |
| `report` | string | no | Audit report path. Alias for sourcePath. |
| `sourcePath` | string | no | Audit report path. |
| `sourceText` | string | no | Pasted audit report text. |
| `target` | string | no | Target git ref to lock. Alias for targetRef. Default: HEAD. |
| `targetRef` | string | no | Target git ref to lock. Default: HEAD. |

## Returning Answer Shape

Actual responses depend on repository state, index freshness, and requested limits. A minimal expected shape is:

```json
{
  "status": "ok",
  "tool": "gn_audit_ingest",
  "summary": "Ingest an audit report as candidate findings",
  "evidenceClasses": [
    "audit_evidence",
    "graph_evidence"
  ],
  "nextAction": "Before verifying or bundling audit findings; never emits OPEN"
}
```

## When It Is Useful

Before verifying or bundling audit findings; never emits OPEN.

## Operational Notes

- Kind: `super`.
- Contract status: `stable`.
- Discoverable modes: `general`, `audit`, `refactor`.
- Audit authority: `true`.
- Advisory-only: `false`.
- Source of truth: `ontoindex/src/mcp/shared/tool-registry.ts` and `ontoindex/src/mcp/*/tool-definitions.ts`.

## Related Concepts

OntoIndex, MCP server, code graph, AI coding agent, static analysis, repository impact analysis, audit, gn_audit_ingest.
