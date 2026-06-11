# ADR-MCP-060: refactor

## Status

Accepted.

## Function

`refactor`

## SEO Summary

OntoIndex MCP function `refactor` supports perform safe refactoring: rename symbols, replace bodies, or stage in sandbox for AI coding agents, local code graph analysis, repository safety workflows, and Model Context Protocol automation.

## Context

Perform safe refactoring: rename symbols, replace bodies, or stage in sandbox.

## Decision

Document `refactor` as a public OntoIndex MCP function because agents and human operators need a stable, linkable explanation of its purpose, predecessor surface, call shape, and returned evidence.

## Predecessors

Consolidates earlier direct backend actions into the `refactor` facade. Current action set: rename, replace, sandbox.

## How To Use

Call this function through an MCP client connected to the OntoIndex server.

```json
{
  "tool": "refactor",
  "arguments": {
    "action": "rename",
    "repo": "my-repo"
  }
}
```

## What Information You Can Get

- Category: `refactor`.
- Evidence classes: `graph_evidence`.
- Response style: text or mixed output intended for direct agent use.
- Permission profile: `write_apply`.
- Facade actions: `rename`, `replace`, `sandbox`.
- Typical result: Perform safe refactoring: rename symbols, replace bodies, or stage in sandbox; When applying code changes through the refactoring engine.

## Parameters

| Parameter | Type | Required | Purpose |
| --- | --- | --- | --- |
| `action` | string: rename, replace, sandbox | yes | The refactoring action to perform. |
| `repo` | string | no | Repository name or path. |
| `target` | string | no | Symbol name or UID alias for rename/replace actions. |

## Returning Answer Shape

Actual responses depend on repository state, index freshness, and requested limits. A minimal expected shape is:

```json
{
  "status": "ok",
  "tool": "refactor",
  "summary": "Perform safe refactoring: rename symbols, replace bodies, or stage in sandbox",
  "evidenceClasses": [
    "graph_evidence"
  ],
  "nextAction": "When applying code changes through the refactoring engine"
}
```

## When It Is Useful

When applying code changes through the refactoring engine.

## Operational Notes

- Kind: `facade`.
- Contract status: `stable`.
- Discoverable modes: `general`, `audit`, `refactor`.
- Audit authority: `false`.
- Advisory-only: `false`.
- Source of truth: `ontoindex/src/mcp/shared/tool-registry.ts` and `ontoindex/src/mcp/*/tool-definitions.ts`.

## Related Concepts

OntoIndex, MCP server, code graph, AI coding agent, static analysis, repository impact analysis, refactor, refactor.
