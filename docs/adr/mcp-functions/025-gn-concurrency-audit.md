# ADR-MCP-025: gn_concurrency_audit

## Status

Accepted.

## Function

`gn_concurrency_audit`

## SEO Summary

OntoIndex MCP function `gn_concurrency_audit` supports find lock-scope hazards and lock-order risks for AI coding agents, local code graph analysis, repository safety workflows, and Model Context Protocol automation.

## Context

Systems-audit concurrency scan: identify locks, lock scopes, blocking or allocation work under locks, nested locks, and possible lock-order inversion.

## Decision

Document `gn_concurrency_audit` as a public OntoIndex MCP function because agents and human operators need a stable, linkable explanation of its purpose, predecessor surface, call shape, and returned evidence.

## Predecessors

Extends the audit layer with systems-programming analyzers for resource, concurrency, ABI, taint, and fault evidence.

## How To Use

Call this function through an MCP client connected to the OntoIndex server.

```json
{
  "tool": "gn_concurrency_audit",
  "arguments": {
    "repo": "my-repo"
  }
}
```

## What Information You Can Get

- Category: `systems-audit`.
- Evidence classes: `audit_evidence`, `graph_evidence`.
- Response style: structured JSON suitable for automation.
- Permission profile: `read_only`.
- Typical result: Find lock-scope hazards and lock-order risks; When auditing mutex contention, blocking calls under locks, or inversion risk.

## Parameters

| Parameter | Type | Required | Purpose |
| --- | --- | --- | --- |
| `legacyResponse` | boolean | no | Return the legacy pre-envelope response shape. Default: true. Set false to opt into the capability-aware response envelope. |
| `maxEvidence` | number | no | Maximum evidence records returned. Default: 100. |
| `maxFindings` | number | no | Maximum findings returned. Default: 50. |
| `path` | string | no | Repository-relative source path to read. |
| `repo` | string | no | Repository name or path. Omit if only one repo is indexed. |
| `sourceText` | string | no | Inline source text to analyze. |
| `symbol` | string | no | Optional symbol under audit. |

## Returning Answer Shape

Actual responses depend on repository state, index freshness, and requested limits. A minimal expected shape is:

```json
{
  "status": "ok",
  "tool": "gn_concurrency_audit",
  "summary": "Find lock-scope hazards and lock-order risks",
  "evidenceClasses": [
    "audit_evidence",
    "graph_evidence"
  ],
  "nextAction": "When auditing mutex contention, blocking calls under locks, or inversion risk"
}
```

## When It Is Useful

When auditing mutex contention, blocking calls under locks, or inversion risk.

## Operational Notes

- Kind: `super`.
- Contract status: `stable`.
- Discoverable modes: `general`, `audit`, `refactor`, `query-projects`.
- Audit authority: `true`.
- Advisory-only: `false`.
- Source of truth: `ontoindex/src/mcp/shared/tool-registry.ts` and `ontoindex/src/mcp/*/tool-definitions.ts`.

## Related Concepts

OntoIndex, MCP server, code graph, AI coding agent, static analysis, repository impact analysis, systems-audit, gn_concurrency_audit.
