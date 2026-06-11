# ADR-MCP-005: gn_audit_bundle

## Status

Accepted.

## Function

`gn_audit_bundle`

## SEO Summary

OntoIndex MCP function `gn_audit_bundle` supports group verified findings into implementation bundles for AI coding agents, local code graph analysis, repository safety workflows, and Model Context Protocol automation.

## Context

Audit lifecycle bundle projection: group verified OPEN/PARTIAL findings into bounded implementation bundles. No dispatch prompts are generated.

## Decision

Document `gn_audit_bundle` as a public OntoIndex MCP function because agents and human operators need a stable, linkable explanation of its purpose, predecessor surface, call shape, and returned evidence.

## Predecessors

Predecessor is the lower-level graph query, impact, audit, or backend action surface that existed before the public super-function/facade contract.

## How To Use

Call this function through an MCP client connected to the OntoIndex server.

```json
{
  "tool": "gn_audit_bundle",
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
- Typical result: Group verified findings into implementation bundles; After verification and linting, before implementation planning.

## Parameters

| Parameter | Type | Required | Purpose |
| --- | --- | --- | --- |
| `maxBundles` | number | no | Maximum bundles returned. Default: 25, max: 100. |
| `persist` | boolean | no | Persist bundle events. Default: true. |
| `repo` | string | no | Repository name or path. Omit if only one repo is indexed. |
| `session` | string | yes | Audit session id. Alias for sessionId. |
| `sessionId` | string | no | Audit session id. |
| `strategy` | string: exact, symbol, root-cause, write-set, test-surface | no | Dedupe strategy. Default: root-cause. |

## Returning Answer Shape

Actual responses depend on repository state, index freshness, and requested limits. A minimal expected shape is:

```json
{
  "status": "ok",
  "tool": "gn_audit_bundle",
  "summary": "Group verified findings into implementation bundles",
  "evidenceClasses": [
    "audit_evidence",
    "graph_evidence"
  ],
  "nextAction": "After verification and linting, before implementation planning"
}
```

## When It Is Useful

After verification and linting, before implementation planning.

## Operational Notes

- Kind: `super`.
- Contract status: `stable`.
- Discoverable modes: `general`, `audit`, `refactor`.
- Audit authority: `true`.
- Advisory-only: `false`.
- Source of truth: `ontoindex/src/mcp/shared/tool-registry.ts` and `ontoindex/src/mcp/*/tool-definitions.ts`.

## Related Concepts

OntoIndex, MCP server, code graph, AI coding agent, static analysis, repository impact analysis, audit, gn_audit_bundle.
