# ADR-MCP-023: gn_bundle_conflicts

## Status

Accepted.

## Function

`gn_bundle_conflicts`

## SEO Summary

OntoIndex MCP function `gn_bundle_conflicts` supports detect write-set, symbol, file, and test-surface conflicts between bundles for AI coding agents, local code graph analysis, repository safety workflows, and Model Context Protocol automation.

## Context

Audit lifecycle bundle conflict detector: report file, symbol, test-surface, and write-set overlaps before parallel worker dispatch.

## Decision

Document `gn_bundle_conflicts` as a public OntoIndex MCP function because agents and human operators need a stable, linkable explanation of its purpose, predecessor surface, call shape, and returned evidence.

## Predecessors

Predecessor is the lower-level graph query, impact, audit, or backend action surface that existed before the public super-function/facade contract.

## How To Use

Call this function through an MCP client connected to the OntoIndex server.

```json
{
  "tool": "gn_bundle_conflicts",
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
- Permission profile: `write_apply`.
- Typical result: Detect write-set, symbol, file, and test-surface conflicts between bundles; Before dispatching bundles in parallel.

## Parameters

| Parameter | Type | Required | Purpose |
| --- | --- | --- | --- |
| `bundleIds` | array | no | Optional bundle ids to filter conflict output. |
| `maxConflicts` | number | no | Maximum conflicts returned. Default: 50. |
| `repo` | string | no | Repository name or path. Omit if only one repo is indexed. |
| `session` | string | yes | Audit session id. |
| `sessionId` | string | no | Alias for session. |
| `strategy` | string: exact, symbol, root-cause, write-set, test-surface | no | Bundle grouping strategy to evaluate. Default: root-cause. |

## Returning Answer Shape

Actual responses depend on repository state, index freshness, and requested limits. A minimal expected shape is:

```json
{
  "status": "ok",
  "tool": "gn_bundle_conflicts",
  "summary": "Detect write-set, symbol, file, and test-surface conflicts between bundles",
  "evidenceClasses": [
    "audit_evidence",
    "graph_evidence"
  ],
  "nextAction": "Before dispatching bundles in parallel"
}
```

## When It Is Useful

Before dispatching bundles in parallel.

## Operational Notes

- Kind: `super`.
- Contract status: `stable`.
- Discoverable modes: `general`, `audit`, `refactor`.
- Audit authority: `true`.
- Advisory-only: `false`.
- Source of truth: `ontoindex/src/mcp/shared/tool-registry.ts` and `ontoindex/src/mcp/*/tool-definitions.ts`.

## Related Concepts

OntoIndex, MCP server, code graph, AI coding agent, static analysis, repository impact analysis, audit, gn_bundle_conflicts.
