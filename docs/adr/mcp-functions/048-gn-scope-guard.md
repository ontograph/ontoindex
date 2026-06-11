# ADR-MCP-048: gn_scope_guard

## Status

Accepted.

## Function

`gn_scope_guard`

## SEO Summary

OntoIndex MCP function `gn_scope_guard` supports check whether a worker stayed inside bundle scope for AI coding agents, local code graph analysis, repository safety workflows, and Model Context Protocol automation.

## Context

Audit lifecycle scope guard: compare an implementation diff summary against a bundle write-set, symbols, required tests, and neighboring bundles.

## Decision

Document `gn_scope_guard` as a public OntoIndex MCP function because agents and human operators need a stable, linkable explanation of its purpose, predecessor surface, call shape, and returned evidence.

## Predecessors

Predecessor is the lower-level graph query, impact, audit, or backend action surface that existed before the public super-function/facade contract.

## How To Use

Call this function through an MCP client connected to the OntoIndex server.

```json
{
  "tool": "gn_scope_guard",
  "arguments": {
    "repo": "my-repo",
    "session": "audit-session-001",
    "bundleId": "bundle-001"
  }
}
```

## What Information You Can Get

- Category: `audit`.
- Evidence classes: `audit_evidence`, `graph_evidence`.
- Response style: structured JSON suitable for automation.
- Permission profile: `write_apply`.
- Typical result: Check whether a worker stayed inside bundle scope; During manager review of an implementation diff.

## Parameters

| Parameter | Type | Required | Purpose |
| --- | --- | --- | --- |
| `bundleId` | string | yes | Bundle id under review. |
| `changedFiles` | array | no | Changed files from the implementation diff. |
| `changedSymbols` | array | no | Changed symbols from the implementation diff. |
| `executedTests` | array | no | Tests actually run by the worker. |
| `persist` | boolean | no | Persist ScopeGuardEvaluated event. Default: true. |
| `repo` | string | no | Repository name or path. Omit if only one repo is indexed. |
| `requiredTests` | array | no | Override required tests for this guard run. |
| `session` | string | yes | Audit session id. |
| `sessionId` | string | no | Alias for session. |

## Returning Answer Shape

Actual responses depend on repository state, index freshness, and requested limits. A minimal expected shape is:

```json
{
  "status": "ok",
  "tool": "gn_scope_guard",
  "summary": "Check whether a worker stayed inside bundle scope",
  "evidenceClasses": [
    "audit_evidence",
    "graph_evidence"
  ],
  "nextAction": "During manager review of an implementation diff"
}
```

## When It Is Useful

During manager review of an implementation diff.

## Operational Notes

- Kind: `super`.
- Contract status: `stable`.
- Discoverable modes: `general`, `audit`, `refactor`.
- Audit authority: `true`.
- Advisory-only: `false`.
- Source of truth: `ontoindex/src/mcp/shared/tool-registry.ts` and `ontoindex/src/mcp/*/tool-definitions.ts`.

## Related Concepts

OntoIndex, MCP server, code graph, AI coding agent, static analysis, repository impact analysis, audit, gn_scope_guard.
