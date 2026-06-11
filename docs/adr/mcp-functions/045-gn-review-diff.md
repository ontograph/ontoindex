# ADR-MCP-045: gn_review_diff

## Status

Accepted.

## Function

`gn_review_diff`

## SEO Summary

OntoIndex MCP function `gn_review_diff` supports return graph-aware diff review in the adr 0018 envelope for AI coding agents, local code graph analysis, repository safety workflows, and Model Context Protocol automation.

## Context

Graph-aware diff review with ADR 0018 capability-response envelope.

## Decision

Document `gn_review_diff` as a public OntoIndex MCP function because agents and human operators need a stable, linkable explanation of its purpose, predecessor surface, call shape, and returned evidence.

## Predecessors

Predecessor is the lower-level graph query, impact, audit, or backend action surface that existed before the public super-function/facade contract.

## How To Use

Call this function through an MCP client connected to the OntoIndex server.

```json
{
  "tool": "gn_review_diff",
  "arguments": {
    "repo": "my-repo"
  }
}
```

## What Information You Can Get

- Category: `pr-review`.
- Evidence classes: `graph_evidence`.
- Response style: structured JSON suitable for automation.
- Permission profile: `advisory`.
- Typical result: Return graph-aware diff review in the ADR 0018 envelope; Machine-readable local diff review aligned with ontoindex review diff --json.

## Parameters

| Parameter | Type | Required | Purpose |
| --- | --- | --- | --- |
| `commitRange` | string | no | Explicit git commit range (e.g. "HEAD~5..HEAD", "main...feature"). Omit to use staged changes. |
| `repo` | string | no | Repository name or path. Omit if only one repo is indexed. |
| `scope` | string: staged, commit-range, branch | no | Which changes to diff. staged = git diff --cached; branch = main...HEAD; commit-range requires commitRange param. Default: staged. |

## Returning Answer Shape

Actual responses depend on repository state, index freshness, and requested limits. A minimal expected shape is:

```json
{
  "status": "ok",
  "tool": "gn_review_diff",
  "summary": "Return graph-aware diff review in the ADR 0018 envelope",
  "evidenceClasses": [
    "graph_evidence"
  ],
  "nextAction": "Machine-readable local diff review aligned with ontoindex review diff --json"
}
```

## When It Is Useful

Machine-readable local diff review aligned with ontoindex review diff --json.

## Operational Notes

- Kind: `super`.
- Contract status: `stable`.
- Discoverable modes: `general`, `audit`, `refactor`, `query-projects`.
- Audit authority: `false`.
- Advisory-only: `true`.
- Source of truth: `ontoindex/src/mcp/shared/tool-registry.ts` and `ontoindex/src/mcp/*/tool-definitions.ts`.

## Related Concepts

OntoIndex, MCP server, code graph, AI coding agent, static analysis, repository impact analysis, pr-review, gn_review_diff.
