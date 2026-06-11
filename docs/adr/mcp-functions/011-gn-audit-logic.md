# ADR-MCP-011: gn_audit_logic

## Status

Accepted.

## Function

`gn_audit_logic`

## SEO Summary

OntoIndex MCP function `gn_audit_logic` supports scan for systems anti-pattern evidence for AI coding agents, local code graph analysis, repository safety workflows, and Model Context Protocol automation.

## Context

Systems-audit logic scan: run bounded deterministic anti-pattern rules for resources, fork safety, signals, TOCTOU, and concurrency. Findings are evidence only and do not directly change audit lifecycle status.

## Decision

Document `gn_audit_logic` as a public OntoIndex MCP function because agents and human operators need a stable, linkable explanation of its purpose, predecessor surface, call shape, and returned evidence.

## Predecessors

Extends the audit layer with systems-programming analyzers for resource, concurrency, ABI, taint, and fault evidence.

## How To Use

Call this function through an MCP client connected to the OntoIndex server.

```json
{
  "tool": "gn_audit_logic",
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
- Typical result: Scan for systems anti-pattern evidence; When auditing resources, fork safety, signals, TOCTOU, or concurrency.

## Parameters

| Parameter | Type | Required | Purpose |
| --- | --- | --- | --- |
| `category` | string: resource-leaks, fork-safety, signals, toctou, concurrency | no | Rule category to run. Omit to run all MVP categories. |
| `legacyResponse` | boolean | no | Return the legacy pre-envelope response shape. Default: true. Set false to opt into the capability-aware response envelope. |
| `maxFindings` | number | no | Maximum findings returned. Default: 25, max: 100. |
| `path` | string | no | Repository-relative source path or snippet label to scan. |
| `repo` | string | no | Repository name or path. Omit if only one repo is indexed. |
| `source` | string | no | Optional source text to scan directly. |

## Returning Answer Shape

Actual responses depend on repository state, index freshness, and requested limits. A minimal expected shape is:

```json
{
  "status": "ok",
  "tool": "gn_audit_logic",
  "summary": "Scan for systems anti-pattern evidence",
  "evidenceClasses": [
    "audit_evidence",
    "graph_evidence"
  ],
  "nextAction": "When auditing resources, fork safety, signals, TOCTOU, or concurrency"
}
```

## When It Is Useful

When auditing resources, fork safety, signals, TOCTOU, or concurrency.

## Operational Notes

- Kind: `super`.
- Contract status: `stable`.
- Discoverable modes: `general`, `audit`, `refactor`.
- Audit authority: `true`.
- Advisory-only: `false`.
- Source of truth: `ontoindex/src/mcp/shared/tool-registry.ts` and `ontoindex/src/mcp/*/tool-definitions.ts`.

## Related Concepts

OntoIndex, MCP server, code graph, AI coding agent, static analysis, repository impact analysis, systems-audit, gn_audit_logic.
