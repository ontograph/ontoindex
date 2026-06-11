# ADR-MCP-046: gn_safe_edit_check

## Status

Accepted.

## Function

`gn_safe_edit_check`

## SEO Summary

OntoIndex MCP function `gn_safe_edit_check` supports is it safe to edit this? for AI coding agents, local code graph analysis, repository safety workflows, and Model Context Protocol automation.

## Context

Pre-edit risk synthesis: resolves a symbol, computes blast radius (callers, callees, processes, clusters), test coverage likelihood, and co-change recency, then emits a SAFE / CAUTION / DANGEROUS / BLOCKED verdict with a recommended tool and suggested next steps.

## Decision

Document `gn_safe_edit_check` as a public OntoIndex MCP function because agents and human operators need a stable, linkable explanation of its purpose, predecessor surface, call shape, and returned evidence.

## Predecessors

Evolved from direct impact and refactor primitives into a graph-aware safety gate.

## How To Use

Call this function through an MCP client connected to the OntoIndex server.

```json
{
  "tool": "gn_safe_edit_check",
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
- Typical result: Is it safe to edit this; Before any edit (replaces ontoindex_impact).

## Parameters

| Parameter | Type | Required | Purpose |
| --- | --- | --- | --- |
| `docsEvidence` | boolean | no | Opt in to advisory Markdown docs evidence for related requirements, API specs, and route drift. Does not affect verdict/risk scoring. Default: false. |
| `force` | boolean | no | Bypass BLOCKED verdict guards. Use only when you have confirmed the risk manually. Default: false. |
| `intent` | string: rename, modify-body, delete, general | no | Type of edit planned. Influences verdict thresholds. Default: general. |
| `legacyResponse` | boolean | no | Return the legacy pre-envelope response shape. Default: true. Set false to opt into the capability-aware response envelope. |
| `repo` | string | no | Repository name or path. Omit if only one repo is indexed. |
| `symbol` | string | yes | Canonical nodeId (e.g. "Function:mergeWithRRF") or fuzzy symbol name (e.g. "mergeWithRRF"). |

## Returning Answer Shape

Actual responses depend on repository state, index freshness, and requested limits. A minimal expected shape is:

```json
{
  "status": "ok",
  "tool": "gn_safe_edit_check",
  "summary": "Is it safe to edit this?",
  "evidenceClasses": [
    "audit_evidence",
    "graph_evidence"
  ],
  "nextAction": "Before any edit (replaces ontoindex_impact)"
}
```

## When It Is Useful

Before any edit (replaces ontoindex_impact).

## Operational Notes

- Kind: `super`.
- Contract status: `stable`.
- Discoverable modes: `general`, `audit`, `refactor`.
- Audit authority: `false`.
- Advisory-only: `true`.
- Source of truth: `ontoindex/src/mcp/shared/tool-registry.ts` and `ontoindex/src/mcp/*/tool-definitions.ts`.

## Related Concepts

OntoIndex, MCP server, code graph, AI coding agent, static analysis, repository impact analysis, safety, gn_safe_edit_check.
