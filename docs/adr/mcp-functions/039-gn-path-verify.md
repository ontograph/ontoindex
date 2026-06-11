# ADR-MCP-039: gn_path_verify

## Status

Accepted.

## Function

`gn_path_verify`

## SEO Summary

OntoIndex MCP function `gn_path_verify` supports verify shallow branch/path invariants for AI coding agents, local code graph analysis, repository safety workflows, and Model Context Protocol automation.

## Context

Systems-audit shallow path verifier: for a trigger branch, verify required calls/patterns appear and forbidden calls/patterns do not appear in the bounded intra-procedural window.

## Decision

Document `gn_path_verify` as a public OntoIndex MCP function because agents and human operators need a stable, linkable explanation of its purpose, predecessor surface, call shape, and returned evidence.

## Predecessors

Extends the audit layer with systems-programming analyzers for resource, concurrency, ABI, taint, and fault evidence.

## How To Use

Call this function through an MCP client connected to the OntoIndex server.

```json
{
  "tool": "gn_path_verify",
  "arguments": {
    "repo": "my-repo",
    "when": "fork() < 0"
  }
}
```

## What Information You Can Get

- Category: `systems-audit`.
- Evidence classes: `audit_evidence`, `graph_evidence`.
- Response style: structured JSON suitable for automation.
- Permission profile: `read_only`.
- Typical result: Verify shallow branch/path invariants; When a finding depends on a specific branch such as fork failure or MSG_CTRUNC handling.

## Parameters

| Parameter | Type | Required | Purpose |
| --- | --- | --- | --- |
| `legacyResponse` | boolean | no | Return the legacy pre-envelope response shape. Default: true. Set false to opt into the capability-aware response envelope. |
| `maxEvidence` | number | no | Maximum evidence lines returned. Default: 25. |
| `must` | array | no | Patterns that must appear after the trigger. |
| `mustNot` | array | no | Patterns that must not appear after the trigger. |
| `path` | string | no | Repository-relative source path to read. |
| `repo` | string | no | Repository name or path. Omit if only one repo is indexed. |
| `source` | string | no | Alias for inline source text. |
| `sourceText` | string | no | Inline source text to analyze. |
| `symbol` | string | no | Optional symbol under verification. |
| `when` | string | yes | Trigger condition or branch pattern, e.g. fork() < 0. |

## Returning Answer Shape

Actual responses depend on repository state, index freshness, and requested limits. A minimal expected shape is:

```json
{
  "status": "ok",
  "tool": "gn_path_verify",
  "summary": "Verify shallow branch/path invariants",
  "evidenceClasses": [
    "audit_evidence",
    "graph_evidence"
  ],
  "nextAction": "When a finding depends on a specific branch such as fork failure or MSG_CTRUNC handling"
}
```

## When It Is Useful

When a finding depends on a specific branch such as fork failure or MSG_CTRUNC handling.

## Operational Notes

- Kind: `super`.
- Contract status: `stable`.
- Discoverable modes: `general`, `audit`, `refactor`, `query-projects`.
- Audit authority: `true`.
- Advisory-only: `false`.
- Source of truth: `ontoindex/src/mcp/shared/tool-registry.ts` and `ontoindex/src/mcp/*/tool-definitions.ts`.

## Related Concepts

OntoIndex, MCP server, code graph, AI coding agent, static analysis, repository impact analysis, systems-audit, gn_path_verify.
