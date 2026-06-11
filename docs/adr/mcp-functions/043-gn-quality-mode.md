# ADR-MCP-043: gn_quality_mode

## Status

Accepted.

## Function

`gn_quality_mode`

## SEO Summary

OntoIndex MCP function `gn_quality_mode` supports set retrieval quality preset for AI coding agents, local code graph analysis, repository safety workflows, and Model Context Protocol automation.

## Context

Env-var preset switch: applies one of three named quality presets (fast / balanced / thorough) by setting or clearing ONTOINDEX_* environment variables on process.env. Changes take effect immediately for all subsequent tool calls in the same session.

## Decision

Document `gn_quality_mode` as a public OntoIndex MCP function because agents and human operators need a stable, linkable explanation of its purpose, predecessor surface, call shape, and returned evidence.

## Predecessors

Predecessor is the lower-level graph query, impact, audit, or backend action surface that existed before the public super-function/facade contract.

## How To Use

Call this function through an MCP client connected to the OntoIndex server.

```json
{
  "tool": "gn_quality_mode",
  "arguments": {
    "level": "balanced"
  }
}
```

## What Information You Can Get

- Category: `lifecycle`.
- Evidence classes: `graph_evidence`.
- Response style: text or mixed output intended for direct agent use.
- Permission profile: `runtime_admin`.
- Typical result: Set retrieval quality preset; At session start (fast/balanced/thorough).

## Parameters

| Parameter | Type | Required | Purpose |
| --- | --- | --- | --- |
| `duration` | string: session, until-revert | no | Advisory only — both values set process.env for the lifetime of the process. Default: session. |
| `level` | string: fast, balanced, thorough | yes | Quality preset to apply. |

## Returning Answer Shape

Actual responses depend on repository state, index freshness, and requested limits. A minimal expected shape is:

```json
{
  "status": "ok",
  "tool": "gn_quality_mode",
  "summary": "Set retrieval quality preset",
  "evidenceClasses": [
    "graph_evidence"
  ],
  "nextAction": "At session start (fast/balanced/thorough)"
}
```

## When It Is Useful

At session start (fast/balanced/thorough).

## Operational Notes

- Kind: `super`.
- Contract status: `stable`.
- Discoverable modes: `general`, `audit`, `refactor`, `query-projects`.
- Audit authority: `false`.
- Advisory-only: `false`.
- Source of truth: `ontoindex/src/mcp/shared/tool-registry.ts` and `ontoindex/src/mcp/*/tool-definitions.ts`.

## Related Concepts

OntoIndex, MCP server, code graph, AI coding agent, static analysis, repository impact analysis, lifecycle, gn_quality_mode.
