# ADR-MCP-002: discover

## Status

Accepted.

## Function

`discover`

## SEO Summary

OntoIndex MCP function `discover` supports discover repositories, routes, tools, and analysis packs for AI coding agents, local code graph analysis, repository safety workflows, and Model Context Protocol automation.

## Context

Discover repositories, routes, tools, and analysis packs.

## Decision

Document `discover` as a public OntoIndex MCP function because agents and human operators need a stable, linkable explanation of its purpose, predecessor surface, call shape, and returned evidence.

## Predecessors

Consolidates earlier direct backend actions into the `discover` facade. Current action set: repos, routes, tools, packs, groups, sync.

## How To Use

Call this function through an MCP client connected to the OntoIndex server.

```json
{
  "tool": "discover",
  "arguments": {
    "action": "repos",
    "repo": "my-repo"
  }
}
```

## What Information You Can Get

- Category: `discovery`.
- Evidence classes: `graph_evidence`.
- Response style: text or mixed output intended for direct agent use.
- Permission profile: `read_only`.
- Facade actions: `repos`, `routes`, `tools`, `packs`, `groups`, `sync`.
- Typical result: Discover repositories, routes, tools, and analysis packs; When you need to find high-level project components or capabilities.

## Parameters

| Parameter | Type | Required | Purpose |
| --- | --- | --- | --- |
| `action` | string: repos, routes, tools, packs, groups, sync | yes | The discovery action to perform. |
| `repo` | string | no | Repository name or path. |

## Returning Answer Shape

Actual responses depend on repository state, index freshness, and requested limits. A minimal expected shape is:

```json
{
  "status": "ok",
  "tool": "discover",
  "summary": "Discover repositories, routes, tools, and analysis packs",
  "evidenceClasses": [
    "graph_evidence"
  ],
  "nextAction": "When you need to find high-level project components or capabilities"
}
```

## When It Is Useful

When you need to find high-level project components or capabilities.

## Operational Notes

- Kind: `facade`.
- Contract status: `stable`.
- Discoverable modes: `general`, `audit`, `refactor`, `query-projects`.
- Audit authority: `false`.
- Advisory-only: `false`.
- Source of truth: `ontoindex/src/mcp/shared/tool-registry.ts` and `ontoindex/src/mcp/*/tool-definitions.ts`.

## Related Concepts

OntoIndex, MCP server, code graph, AI coding agent, static analysis, repository impact analysis, discovery, discover.
