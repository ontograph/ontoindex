# ADR-MCP-024: gn_can_delete

## Status

Accepted.

## Function

`gn_can_delete`

## SEO Summary

OntoIndex MCP function `gn_can_delete` supports can i delete this? for AI coding agents, local code graph analysis, repository safety workflows, and Model Context Protocol automation.

## Context

Dead-code safety check: resolves a symbol, then checks callers, test-file imports, cross-repo references, and co-change recency to synthesise a DELETE-SAFE / CAUTION / DO-NOT-DELETE verdict.

## Decision

Document `gn_can_delete` as a public OntoIndex MCP function because agents and human operators need a stable, linkable explanation of its purpose, predecessor surface, call shape, and returned evidence.

## Predecessors

Predecessor is the lower-level graph query, impact, audit, or backend action surface that existed before the public super-function/facade contract.

## How To Use

Call this function through an MCP client connected to the OntoIndex server.

```json
{
  "tool": "gn_can_delete",
  "arguments": {
    "repo": "my-repo",
    "symbol": "validateUser"
  }
}
```

## What Information You Can Get

- Category: `safety`.
- Evidence classes: `audit_evidence`, `graph_evidence`.
- Response style: structured JSON suitable for automation.
- Permission profile: `advisory`.
- Typical result: Can I delete this; Dead-code check.

## Parameters

| Parameter | Type | Required | Purpose |
| --- | --- | --- | --- |
| `includeCrossRepo` | boolean | no | Check cross-repo references (requires group config). Default: false. |
| `repo` | string | no | Repository name or path. Omit if only one repo is indexed. |
| `symbol` | string | yes | Canonical nodeId (e.g. "Function:mergeWithRRF") or fuzzy symbol name (e.g. "mergeWithRRF"). |

## Returning Answer Shape

Actual responses depend on repository state, index freshness, and requested limits. A minimal expected shape is:

```json
{
  "status": "ok",
  "tool": "gn_can_delete",
  "summary": "Can I delete this?",
  "evidenceClasses": [
    "audit_evidence",
    "graph_evidence"
  ],
  "nextAction": "Dead-code check"
}
```

## When It Is Useful

Dead-code check.

## Operational Notes

- Kind: `super`.
- Contract status: `stable`.
- Discoverable modes: `general`, `audit`, `refactor`.
- Audit authority: `false`.
- Advisory-only: `true`.
- Source of truth: `ontoindex/src/mcp/shared/tool-registry.ts` and `ontoindex/src/mcp/*/tool-definitions.ts`.

## Related Concepts

OntoIndex, MCP server, code graph, AI coding agent, static analysis, repository impact analysis, safety, gn_can_delete.
