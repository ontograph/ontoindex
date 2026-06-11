# ADR-MCP-052: gn_test_suggestions

## Status

Accepted.

## Function

`gn_test_suggestions`

## SEO Summary

OntoIndex MCP function `gn_test_suggestions` supports suggest the smallest audit regression test shape for AI coding agents, local code graph analysis, repository safety workflows, and Model Context Protocol automation.

## Context

Audit-to-test suggestion generator: propose the smallest test file/case/assertion shape for a verified finding, symbol, claim pattern, or risk invariant.

## Decision

Document `gn_test_suggestions` as a public OntoIndex MCP function because agents and human operators need a stable, linkable explanation of its purpose, predecessor surface, call shape, and returned evidence.

## Predecessors

Extends the audit layer with systems-programming analyzers for resource, concurrency, ABI, taint, and fault evidence.

## How To Use

Call this function through an MCP client connected to the OntoIndex server.

```json
{
  "tool": "gn_test_suggestions",
  "arguments": {
    "repo": "my-repo"
  }
}
```

## What Information You Can Get

- Category: `systems-audit`.
- Evidence classes: `audit_evidence`, `graph_evidence`.
- Response style: structured JSON suitable for automation.
- Permission profile: `write_apply`.
- Typical result: Suggest the smallest audit regression test shape; For a verified OPEN finding that needs test evidence before dispatch.

## Parameters

| Parameter | Type | Required | Purpose |
| --- | --- | --- | --- |
| `claimPattern` | string | no | Claim pattern or invariant under test. |
| `findingId` | string | no | Optional finding id. |
| `legacyResponse` | boolean | no | Return the legacy pre-envelope response shape. Default: true. Set false to opt into the capability-aware response envelope. |
| `path` | string | no | Preferred test file path. |
| `repo` | string | no | Repository name or path. Omit if only one repo is indexed. |
| `risk` | string | no | Risk category under test. |
| `symbol` | string | no | Symbol under test. |

## Returning Answer Shape

Actual responses depend on repository state, index freshness, and requested limits. A minimal expected shape is:

```json
{
  "status": "ok",
  "tool": "gn_test_suggestions",
  "summary": "Suggest the smallest audit regression test shape",
  "evidenceClasses": [
    "audit_evidence",
    "graph_evidence"
  ],
  "nextAction": "For a verified OPEN finding that needs test evidence before dispatch"
}
```

## When It Is Useful

For a verified OPEN finding that needs test evidence before dispatch.

## Operational Notes

- Kind: `super`.
- Contract status: `stable`.
- Discoverable modes: `general`, `audit`, `refactor`.
- Audit authority: `true`.
- Advisory-only: `false`.
- Source of truth: `ontoindex/src/mcp/shared/tool-registry.ts` and `ontoindex/src/mcp/*/tool-definitions.ts`.

## Related Concepts

OntoIndex, MCP server, code graph, AI coding agent, static analysis, repository impact analysis, systems-audit, gn_test_suggestions.
