# ADR-MCP-038: gn_help

## Status

Accepted.

## Function

`gn_help`

## SEO Summary

OntoIndex MCP function `gn_help` supports list all super-functions for AI coding agents, local code graph analysis, repository safety workflows, and Model Context Protocol automation.

## Context

Compact startup guide and MCP ergonomics review: lists super-functions, docs-aware workflows, setup steps, response-size limits, schema clarity notes, and recommended first calls for agents.

## Decision

Document `gn_help` as a public OntoIndex MCP function because agents and human operators need a stable, linkable explanation of its purpose, predecessor surface, call shape, and returned evidence.

## Predecessors

Predecessor is the lower-level graph query, impact, audit, or backend action surface that existed before the public super-function/facade contract.

## How To Use

Call this function through an MCP client connected to the OntoIndex server.

```json
{
  "tool": "gn_help",
  "arguments": {
    "limit": 1,
    "repo": "my-repo"
  }
}
```

## What Information You Can Get

- Category: `self-help`.
- Evidence classes: `runtime_diagnostic`.
- Response style: text or mixed output intended for direct agent use.
- Permission profile: `read_only`.
- Typical result: List all super-functions; First call when discovering the surface.

## Parameters

| Parameter | Type | Required | Purpose |
| --- | --- | --- | --- |
| `evidenceClass` | string: graph_evidence, docs_evidence, audit_evidence, advisory_memory, runtime_diagnostic, unknown | no | Optional evidence-class filter. By default, advisory_memory/runtime_diagnostic are excluded unless includeNonAuthoritativeEvidence=true. |
| `evidenceClasses` | array | no | Optional multi-value evidence-class filter (same vocabulary as evidenceClass). |
| `includeNonAuthoritativeEvidence` | boolean | no | Include advisory_memory/runtime_diagnostic evidence classes in filtering. Defaults to false to preserve trust boundaries. Default: false. |
| `intent` | string | no | Optional workflow-intent filter (e.g. "refactor", "audit", "docs", "release", "diagnose"). |
| `legacyResponse` | boolean | no | Return the legacy pre-envelope response shape. Default: true. Set false to opt into the capability-aware response envelope. |
| `limit` | number | no | Optional cap for filtered results (min 1, max 100). |
| `mode` | string: general, audit, refactor, query-projects | no | Optional agent mode. When supplied, filters advertised tools and workflow guidance to the specified mode and adds mode/modeDescription to the report. |
| `query` | string | no | Optional free-text discovery query. Filters/ranks tools by registry intent/whenToUse/workflow tags. |
| `repo` | string | no | Optional repository name or path. When supplied, adds lightweight readiness reminders (stale index, dirty worktree, missing embeddings/LSP/sidecar) to the report. |
| `stability` | string: stable, experimental, deprecated | no | Optional stability filter for registry-backed discovery results. |
| `topic` | string: overview, docs, editing, setup | no | Optional discovery focus. Current response is compact and includes all topics; use this to document caller intent. Default: "overview". |

## Returning Answer Shape

Actual responses depend on repository state, index freshness, and requested limits. A minimal expected shape is:

```json
{
  "status": "ok",
  "tool": "gn_help",
  "summary": "List all super-functions",
  "evidenceClasses": [
    "runtime_diagnostic"
  ],
  "nextAction": "First call when discovering the surface"
}
```

## When It Is Useful

First call when discovering the surface.

## Operational Notes

- Kind: `super`.
- Contract status: `stable`.
- Discoverable modes: `general`, `audit`, `refactor`, `query-projects`.
- Audit authority: `false`.
- Advisory-only: `true`.
- Source of truth: `ontoindex/src/mcp/shared/tool-registry.ts` and `ontoindex/src/mcp/*/tool-definitions.ts`.

## Related Concepts

OntoIndex, MCP server, code graph, AI coding agent, static analysis, repository impact analysis, self-help, gn_help.
