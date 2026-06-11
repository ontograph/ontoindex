# ADR-MCP-026: gn_diagnose

## Status

Accepted.

## Function

`gn_diagnose`

## SEO Summary

OntoIndex MCP function `gn_diagnose` supports what is not optimal in my ontoindex setup? for AI coding agents, local code graph analysis, repository safety workflows, and Model Context Protocol automation.

## Context

Read-only system-status report: checks index freshness, embeddings, LSP server availability, and ONTOINDEX_* environment variables, then synthesises a ranked recommendation list.

## Decision

Document `gn_diagnose` as a public OntoIndex MCP function because agents and human operators need a stable, linkable explanation of its purpose, predecessor surface, call shape, and returned evidence.

## Predecessors

Predecessor is the lower-level graph query, impact, audit, or backend action surface that existed before the public super-function/facade contract.

## How To Use

Call this function through an MCP client connected to the OntoIndex server.

```json
{
  "tool": "gn_diagnose",
  "arguments": {
    "repo": "my-repo"
  }
}
```

## What Information You Can Get

- Category: `self-help`.
- Evidence classes: `runtime_diagnostic`.
- Response style: structured JSON suitable for automation.
- Permission profile: `runtime_admin`.
- Typical result: What is not optimal in my OntoIndex setup; When something feels off; session-start health check.

## Parameters

| Parameter | Type | Required | Purpose |
| --- | --- | --- | --- |
| `checkEmbeddings` | boolean | no | Check whether embeddings are populated. Default: true. |
| `checkIndexFreshness` | boolean | no | Check whether the index is stale vs the current HEAD. Default: true. |
| `checkLsp` | boolean | no | Probe whether typescript-language-server, pyright, and rust-analyzer are on PATH. Default: true. |
| `checkToolContract` | boolean | no | Check whether gn_help advertised tools match registered callable MCP tools. Default: true. |
| `legacyResponse` | boolean | no | Return the legacy pre-envelope response shape. Default: true. Set false to opt into the capability-aware response envelope. |
| `repo` | string | no | Repository name or path. Omit if only one repo is indexed. |

## Returning Answer Shape

Actual responses depend on repository state, index freshness, and requested limits. A minimal expected shape is:

```json
{
  "status": "ok",
  "tool": "gn_diagnose",
  "summary": "What is not optimal in my OntoIndex setup?",
  "evidenceClasses": [
    "runtime_diagnostic"
  ],
  "nextAction": "When something feels off; session-start health check"
}
```

## When It Is Useful

When something feels off; session-start health check.

## Operational Notes

- Kind: `super`.
- Contract status: `stable`.
- Discoverable modes: `general`, `audit`, `refactor`, `query-projects`.
- Audit authority: `false`.
- Advisory-only: `true`.
- Source of truth: `ontoindex/src/mcp/shared/tool-registry.ts` and `ontoindex/src/mcp/*/tool-definitions.ts`.

## Related Concepts

OntoIndex, MCP server, code graph, AI coding agent, static analysis, repository impact analysis, self-help, gn_diagnose.
