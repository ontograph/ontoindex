# ADR-MCP-012: gn_audit_pr_marker_scan

## Status

Accepted.

## Function

`gn_audit_pr_marker_scan`

## SEO Summary

OntoIndex MCP function `gn_audit_pr_marker_scan` supports find nearby pr/todo/fixme/follow-up/deferred markers around evidence for AI coding agents, local code graph analysis, repository safety workflows, and Model Context Protocol automation.

## Context

Audit lifecycle PR marker scan: inspect comments around evidence lines for PR-N, TODO, FIXME, follow-up, known limitation, and deferred markers before reflagging known debt as bugs.

## Decision

Document `gn_audit_pr_marker_scan` as a public OntoIndex MCP function because agents and human operators need a stable, linkable explanation of its purpose, predecessor surface, call shape, and returned evidence.

## Predecessors

Predecessor is the lower-level graph query, impact, audit, or backend action surface that existed before the public super-function/facade contract.

## How To Use

Call this function through an MCP client connected to the OntoIndex server.

```json
{
  "tool": "gn_audit_pr_marker_scan",
  "arguments": {
    "repo": "my-repo",
    "evidenceLine": 1
  }
}
```

## What Information You Can Get

- Category: `audit`.
- Evidence classes: `audit_evidence`, `graph_evidence`.
- Response style: structured JSON suitable for automation.
- Permission profile: `read_only`.
- Typical result: Find nearby PR/TODO/FIXME/follow-up/deferred markers around evidence; Before reflagging code that may already be known deferred debt or decision-gated work.

## Parameters

| Parameter | Type | Required | Purpose |
| --- | --- | --- | --- |
| `evidenceLine` | number | yes | 1-based evidence line to scan around. |
| `path` | string | no | Repository-relative source path or inline source label. |
| `repo` | string | no | Repository name or path. Omit if only one repo is indexed. |
| `source` | string | no | Alias for inline source text. |
| `sourceText` | string | no | Inline source text to scan. |
| `windowAfter` | number | no | Lines after evidence line. Default: 3. |
| `windowBefore` | number | no | Lines before evidence line. Default: 3. |

## Returning Answer Shape

Actual responses depend on repository state, index freshness, and requested limits. A minimal expected shape is:

```json
{
  "status": "ok",
  "tool": "gn_audit_pr_marker_scan",
  "summary": "Find nearby PR/TODO/FIXME/follow-up/deferred markers around evidence",
  "evidenceClasses": [
    "audit_evidence",
    "graph_evidence"
  ],
  "nextAction": "Before reflagging code that may already be known deferred debt or decision-gated work"
}
```

## When It Is Useful

Before reflagging code that may already be known deferred debt or decision-gated work.

## Operational Notes

- Kind: `super`.
- Contract status: `stable`.
- Discoverable modes: `general`, `audit`, `refactor`, `query-projects`.
- Audit authority: `true`.
- Advisory-only: `false`.
- Source of truth: `ontoindex/src/mcp/shared/tool-registry.ts` and `ontoindex/src/mcp/*/tool-definitions.ts`.

## Related Concepts

OntoIndex, MCP server, code graph, AI coding agent, static analysis, repository impact analysis, audit, gn_audit_pr_marker_scan.
