# ADR-MCP-014: gn_audit_session_bundle

## Status

Accepted.

## Function

`gn_audit_session_bundle`

## SEO Summary

OntoIndex MCP function `gn_audit_session_bundle` supports run dedupe first, then create implementation bundles in the manager loop for AI coding agents, local code graph analysis, repository safety workflows, and Model Context Protocol automation.

## Context

Manager-level audit bundle: run dedupe first, then project verified findings into implementation bundles with optional manager sizing limits.

## Decision

Document `gn_audit_session_bundle` as a public OntoIndex MCP function because agents and human operators need a stable, linkable explanation of its purpose, predecessor surface, call shape, and returned evidence.

## Predecessors

Evolved from standalone audit ingest, verify, dedupe, bundle, dispatch, and review calls into a manager-loop lifecycle function.

## How To Use

Call this function through an MCP client connected to the OntoIndex server.

```json
{
  "tool": "gn_audit_session_bundle",
  "arguments": {
    "repo": "my-repo",
    "session": "audit-session-001"
  }
}
```

## What Information You Can Get

- Category: `lifecycle`.
- Evidence classes: `audit_evidence`.
- Response style: structured JSON suitable for automation.
- Permission profile: `write_apply`.
- Typical result: Run dedupe first, then create implementation bundles in the manager loop; Preferred bundling step before dispatch.

## Parameters

| Parameter | Type | Required | Purpose |
| --- | --- | --- | --- |
| `maxBundles` | number | no | Maximum bundles returned. Default: 25. |
| `maxFiles` | number | no | Optional manager limit for files touched per bundle. |
| `maxLoc` | number | no | Optional manager limit for estimated lines changed per bundle. |
| `parallelism` | number | no | Requested manager parallelism hint. Default: 1. |
| `persist` | boolean | no | Persist bundle events. Default: true. |
| `repo` | string | no | Repository name or path. Omit if only one repo is indexed. |
| `session` | string | yes | Audit session id. |
| `sessionId` | string | no | Alias for session. |
| `strategy` | string: exact, symbol, root-cause, write-set, test-surface | no | Bundle grouping strategy. Default: root-cause. |

## Returning Answer Shape

Actual responses depend on repository state, index freshness, and requested limits. A minimal expected shape is:

```json
{
  "status": "ok",
  "tool": "gn_audit_session_bundle",
  "summary": "Run dedupe first, then create implementation bundles in the manager loop",
  "evidenceClasses": [
    "audit_evidence"
  ],
  "nextAction": "Preferred bundling step before dispatch"
}
```

## When It Is Useful

Preferred bundling step before dispatch.

## Operational Notes

- Kind: `super`.
- Contract status: `stable`.
- Discoverable modes: `general`, `audit`, `refactor`.
- Audit authority: `true`.
- Advisory-only: `false`.
- Source of truth: `ontoindex/src/mcp/shared/tool-registry.ts` and `ontoindex/src/mcp/*/tool-definitions.ts`.

## Related Concepts

OntoIndex, MCP server, code graph, AI coding agent, static analysis, repository impact analysis, lifecycle, gn_audit_session_bundle.
