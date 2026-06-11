# ADR-MCP-028: gn_dispatch_prompt

## Status

Accepted.

## Function

`gn_dispatch_prompt`

## SEO Summary

OntoIndex MCP function `gn_dispatch_prompt` supports generate one concrete worker prompt for one verified bundle for AI coding agents, local code graph analysis, repository safety workflows, and Model Context Protocol automation.

## Context

Audit lifecycle dispatch prompt generator: emit one concrete worker prompt for exactly one verified implementation bundle, with scope, non-scope, tests, impact checks, and stop conditions.

## Decision

Document `gn_dispatch_prompt` as a public OntoIndex MCP function because agents and human operators need a stable, linkable explanation of its purpose, predecessor surface, call shape, and returned evidence.

## Predecessors

Predecessor is the lower-level graph query, impact, audit, or backend action surface that existed before the public super-function/facade contract.

## How To Use

Call this function through an MCP client connected to the OntoIndex server.

```json
{
  "tool": "gn_dispatch_prompt",
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
- Permission profile: `release`.
- Typical result: Generate one concrete worker prompt for one verified bundle; After bundling and before assigning implementation work.

## Parameters

| Parameter | Type | Required | Purpose |
| --- | --- | --- | --- |
| `allowRuntimeOnlyFindings` | boolean | no | Allow runtime-only findings to be dispatched. Default: false. |
| `bundleId` | string | no | Bundle id to dispatch. Required when the session has more than one bundle. |
| `forbidUnverifiedFindings` | boolean | no | Reject bundles without fresh verified implementation findings. Default: true. |
| `maxPromptChars` | number | no | Maximum prompt characters returned. Default: 20000. |
| `persist` | boolean | no | Persist BundleDispatched event. Default: true. |
| `redactionMode` | string: none, paths, snippets, sensitive | no | Prompt redaction policy. Default: sensitive. |
| `repo` | string | no | Repository name or path. Omit if only one repo is indexed. |
| `session` | string | yes | Audit session id. |
| `sessionId` | string | no | Alias for session. |

## Returning Answer Shape

Actual responses depend on repository state, index freshness, and requested limits. A minimal expected shape is:

```json
{
  "status": "ok",
  "tool": "gn_dispatch_prompt",
  "summary": "Generate one concrete worker prompt for one verified bundle",
  "evidenceClasses": [
    "audit_evidence",
    "graph_evidence"
  ],
  "nextAction": "After bundling and before assigning implementation work"
}
```

## When It Is Useful

After bundling and before assigning implementation work.

## Operational Notes

- Kind: `super`.
- Contract status: `stable`.
- Discoverable modes: `general`, `audit`, `refactor`.
- Audit authority: `true`.
- Advisory-only: `false`.
- Source of truth: `ontoindex/src/mcp/shared/tool-registry.ts` and `ontoindex/src/mcp/*/tool-definitions.ts`.

## Related Concepts

OntoIndex, MCP server, code graph, AI coding agent, static analysis, repository impact analysis, audit, gn_dispatch_prompt.
