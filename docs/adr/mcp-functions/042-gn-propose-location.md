# ADR-MCP-042: gn_propose_location

## Status

Accepted.

## Function

`gn_propose_location`

## SEO Summary

OntoIndex MCP function `gn_propose_location` supports where should i add new code for x? for AI coding agents, local code graph analysis, repository safety workflows, and Model Context Protocol automation.

## Context

Where-to-add-new-code suggester: given a free-text intent description, uses semantic search to find the best-matching clusters, then proposes a directory, filename, and import pattern for the new code.

## Decision

Document `gn_propose_location` as a public OntoIndex MCP function because agents and human operators need a stable, linkable explanation of its purpose, predecessor surface, call shape, and returned evidence.

## Predecessors

Predecessor is the lower-level graph query, impact, audit, or backend action surface that existed before the public super-function/facade contract.

## How To Use

Call this function through an MCP client connected to the OntoIndex server.

```json
{
  "tool": "gn_propose_location",
  "arguments": {
    "repo": "my-repo",
    "intent": "add audit-safe auth middleware"
  }
}
```

## What Information You Can Get

- Category: `self-help`.
- Evidence classes: `runtime_diagnostic`.
- Response style: structured JSON suitable for automation.
- Permission profile: `read_only`.
- Typical result: Where should I add new code for X; When adding new code; cluster-aware placement suggestion.

## Parameters

| Parameter | Type | Required | Purpose |
| --- | --- | --- | --- |
| `intent` | string | yes | Free-text description of the new code (e.g. "test feature handler", "auth middleware"). |
| `language` | string | no | Target language for the file extension suggestion (e.g. "python" → .py; anything else → .ts). Default: ts. |
| `repo` | string | no | Repository name or path. Omit if only one repo is indexed. |

## Returning Answer Shape

Actual responses depend on repository state, index freshness, and requested limits. A minimal expected shape is:

```json
{
  "status": "ok",
  "tool": "gn_propose_location",
  "summary": "Where should I add new code for X?",
  "evidenceClasses": [
    "runtime_diagnostic"
  ],
  "nextAction": "When adding new code; cluster-aware placement suggestion"
}
```

## When It Is Useful

When adding new code; cluster-aware placement suggestion.

## Operational Notes

- Kind: `super`.
- Contract status: `stable`.
- Discoverable modes: `general`, `audit`, `refactor`, `query-projects`.
- Audit authority: `false`.
- Advisory-only: `true`.
- Source of truth: `ontoindex/src/mcp/shared/tool-registry.ts` and `ontoindex/src/mcp/*/tool-definitions.ts`.

## Related Concepts

OntoIndex, MCP server, code graph, AI coding agent, static analysis, repository impact analysis, self-help, gn_propose_location.
