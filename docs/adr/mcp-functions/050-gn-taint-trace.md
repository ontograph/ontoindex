# ADR-MCP-050: gn_taint_trace

## Status

Accepted.

## Function

`gn_taint_trace`

## SEO Summary

OntoIndex MCP function `gn_taint_trace` supports trace bounded untrusted source-to-sink data flow for AI coding agents, local code graph analysis, repository safety workflows, and Model Context Protocol automation.

## Context

Systems-audit taint trace: bounded source-to-sink data-flow heuristic with sanitizer detection and provenance-backed findings.

## Decision

Document `gn_taint_trace` as a public OntoIndex MCP function because agents and human operators need a stable, linkable explanation of its purpose, predecessor surface, call shape, and returned evidence.

## Predecessors

Extends the audit layer with systems-programming analyzers for resource, concurrency, ABI, taint, and fault evidence.

## How To Use

Call this function through an MCP client connected to the OntoIndex server.

```json
{
  "tool": "gn_taint_trace",
  "arguments": {
    "repo": "my-repo",
    "source": "request.body",
    "sink": "exec"
  }
}
```

## What Information You Can Get

- Category: `systems-audit`.
- Evidence classes: `audit_evidence`, `graph_evidence`.
- Response style: structured JSON suitable for automation.
- Permission profile: `read_only`.
- Typical result: Trace bounded untrusted source-to-sink data flow; When checking whether input reaches a dangerous sink without sanitization.

## Parameters

| Parameter | Type | Required | Purpose |
| --- | --- | --- | --- |
| `legacyResponse` | boolean | no | Return the legacy pre-envelope response shape. Default: true. Set false to opt into the capability-aware response envelope. |
| `maxPaths` | number | no | Maximum taint paths returned. Default: 25, max: 100. |
| `path` | string | no | Repository-relative source path to read. |
| `repo` | string | no | Repository name or path. Omit if only one repo is indexed. |
| `sanitizers` | array | no | Known sanitizer function names. |
| `sink` | string | yes | Dangerous sink symbol/name. |
| `sinkName` | string | no | Alias for sink symbol/name. |
| `source` | string | yes | Untrusted source symbol/name. |
| `sourceName` | string | no | Alias for source symbol/name. |
| `sourceText` | string | no | Inline source text to analyze. |

## Returning Answer Shape

Actual responses depend on repository state, index freshness, and requested limits. A minimal expected shape is:

```json
{
  "status": "ok",
  "tool": "gn_taint_trace",
  "summary": "Trace bounded untrusted source-to-sink data flow",
  "evidenceClasses": [
    "audit_evidence",
    "graph_evidence"
  ],
  "nextAction": "When checking whether input reaches a dangerous sink without sanitization"
}
```

## When It Is Useful

When checking whether input reaches a dangerous sink without sanitization.

## Operational Notes

- Kind: `super`.
- Contract status: `stable`.
- Discoverable modes: `general`, `audit`, `refactor`, `query-projects`.
- Audit authority: `true`.
- Advisory-only: `false`.
- Source of truth: `ontoindex/src/mcp/shared/tool-registry.ts` and `ontoindex/src/mcp/*/tool-definitions.ts`.

## Related Concepts

OntoIndex, MCP server, code graph, AI coding agent, static analysis, repository impact analysis, systems-audit, gn_taint_trace.
