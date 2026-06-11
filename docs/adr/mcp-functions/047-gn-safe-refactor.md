# ADR-MCP-047: gn_safe_refactor

## Status

Accepted.

## Function

`gn_safe_refactor`

## SEO Summary

OntoIndex MCP function `gn_safe_refactor` supports apply rename/extract/move/modify safely for AI coding agents, local code graph analysis, repository safety workflows, and Model Context Protocol automation.

## Context

Single WRITE dispatcher for atomic refactor operations (rename, modify-body, extract, move). Wraps each operation with symbol resolution, pre-edit safety check (via gn_safe_edit_check), dry-run preview, optional apply, and post-write verification guidance (gn_verify_diff / gn_test_gap).

## Decision

Document `gn_safe_refactor` as a public OntoIndex MCP function because agents and human operators need a stable, linkable explanation of its purpose, predecessor surface, call shape, and returned evidence.

## Predecessors

Evolved from direct impact and refactor primitives into a graph-aware safety gate.

## How To Use

Call this function through an MCP client connected to the OntoIndex server.

```json
{
  "tool": "gn_safe_refactor",
  "arguments": {
    "repo": "my-repo",
    "intent": "rename",
    "params": {
      "example": true
    }
  }
}
```

## What Information You Can Get

- Category: `refactor`.
- Evidence classes: `graph_evidence`.
- Response style: text or mixed output intended for direct agent use.
- Permission profile: `write_apply`.
- Typical result: Apply rename/extract/move/modify safely; Any refactor (single dispatcher for 6 atomic tools; defaults to dryRun:true).

## Parameters

| Parameter | Type | Required | Purpose |
| --- | --- | --- | --- |
| `dryRun` | boolean | no | Preview changes without applying. Default: true. Pass false to apply changes. |
| `force` | boolean | no | Override BLOCKED/DANGEROUS pre-check verdict. Use only after manual confirmation. Default: false. |
| `intent` | string: rename, modify-body, extract, move, split-function, convert-to-method | yes | Refactor operation to perform. |
| `params` | object | yes | Operation-specific parameters: newName (rename/extract), newBody (modify-body), sourceLineRange (extract), targetFile (move/extract). |
| `preChecks` | boolean | no | Run gn_safe_edit_check before proceeding. Default: true. |
| `repo` | string | no | Repository name or path. Omit if only one repo is indexed. |
| `symbol` | string | no | Preferred symbol selector: canonical nodeId (e.g. "Function:mergeWithRRF") or fuzzy symbol name (e.g. "mergeWithRRF"). |
| `target` | string | no | Deprecated alias for symbol, preserved for callers migrating from facade-style target selectors. |

## Returning Answer Shape

Actual responses depend on repository state, index freshness, and requested limits. A minimal expected shape is:

```json
{
  "status": "ok",
  "tool": "gn_safe_refactor",
  "summary": "Apply rename/extract/move/modify safely",
  "evidenceClasses": [
    "graph_evidence"
  ],
  "nextAction": "Any refactor (single dispatcher for 6 atomic tools; defaults to dryRun:true)"
}
```

## When It Is Useful

Any refactor (single dispatcher for 6 atomic tools; defaults to dryRun:true).

## Operational Notes

- Kind: `super`.
- Contract status: `stable`.
- Discoverable modes: `general`, `audit`, `refactor`.
- Audit authority: `false`.
- Advisory-only: `false`.
- Source of truth: `ontoindex/src/mcp/shared/tool-registry.ts` and `ontoindex/src/mcp/*/tool-definitions.ts`.

## Related Concepts

OntoIndex, MCP server, code graph, AI coding agent, static analysis, repository impact analysis, refactor, gn_safe_refactor.
