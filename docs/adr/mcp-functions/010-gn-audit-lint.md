# ADR-MCP-010: gn_audit_lint

## Status

Accepted.

## Function

`gn_audit_lint`

## SEO Summary

OntoIndex MCP function `gn_audit_lint` supports check audit quality gates for AI coding agents, local code graph analysis, repository safety workflows, and Model Context Protocol automation.

## Context

Audit lifecycle lint: report or bundle process checks for stale OPEN findings, line-only evidence, runtime-only claims, duplicates, tombstones, HOLD metadata, tests, and impact targets.

## Decision

Document `gn_audit_lint` as a public OntoIndex MCP function because agents and human operators need a stable, linkable explanation of its purpose, predecessor surface, call shape, and returned evidence.

## Predecessors

Predecessor is the lower-level graph query, impact, audit, or backend action surface that existed before the public super-function/facade contract.

## How To Use

Call this function through an MCP client connected to the OntoIndex server.

```json
{
  "tool": "gn_audit_lint",
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
- Typical result: Check audit quality gates; Before accepting an audit report or bundle set.

## Parameters

| Parameter | Type | Required | Purpose |
| --- | --- | --- | --- |
| `advisory` | boolean | no | Recommend zero exit even when issues exist. Default: false. |
| `cursor` | string | no | Opaque cursor returned by a previous lint response. Keeps deterministic page boundaries for follow-up pages. |
| `includeIgnored` | boolean | no | Include findings whose target paths match repository ignore/generated policy. Default: false. |
| `maxIssues` | number | no | Maximum lint issues returned. Default: 50, max: 100. |
| `minimal` | boolean | no | Return only the core result summary and next action. Default: false. |
| `persist` | boolean | no | Persist lint event when a session is supplied. Default: true. |
| `repo` | string | no | Repository name or path. Omit if only one repo is indexed. |
| `scope` | string: report, bundle, all | no | Rule set to run. Default: report. |
| `session` | string | no | Audit session id. Alias for sessionId. |
| `sessionId` | string | no | Audit session id. |
| `summary` | boolean | no | Return lighter JSON that keeps status and warnings while omitting bulky per-item detail. Default: false. |

## Returning Answer Shape

Actual responses depend on repository state, index freshness, and requested limits. A minimal expected shape is:

```json
{
  "status": "ok",
  "tool": "gn_audit_lint",
  "summary": "Check audit quality gates",
  "evidenceClasses": [
    "audit_evidence",
    "graph_evidence"
  ],
  "nextAction": "Before accepting an audit report or bundle set"
}
```

## When It Is Useful

Before accepting an audit report or bundle set.

## Operational Notes

- Kind: `super`.
- Contract status: `stable`.
- Discoverable modes: `general`, `audit`, `refactor`.
- Audit authority: `true`.
- Advisory-only: `false`.
- Source of truth: `ontoindex/src/mcp/shared/tool-registry.ts` and `ontoindex/src/mcp/*/tool-definitions.ts`.

## Related Concepts

OntoIndex, MCP server, code graph, AI coding agent, static analysis, repository impact analysis, audit, gn_audit_lint.
