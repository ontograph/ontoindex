# ADR-MCP-044: gn_resource_trace

## Status

Accepted.

## Function

`gn_resource_trace`

## SEO Summary

OntoIndex MCP function `gn_resource_trace` supports trace posix resource ownership acquire/duplicate/release facts for AI coding agents, local code graph analysis, repository safety workflows, and Model Context Protocol automation.

## Context

Systems-audit resource ownership trace: extract POSIX resource acquire/duplicate/handoff/release facts for fd, pid, pidfd, pipe, socket, fork, exec, and wait flows.

## Decision

Document `gn_resource_trace` as a public OntoIndex MCP function because agents and human operators need a stable, linkable explanation of its purpose, predecessor surface, call shape, and returned evidence.

## Predecessors

Extends the audit layer with systems-programming analyzers for resource, concurrency, ABI, taint, and fault evidence.

## How To Use

Call this function through an MCP client connected to the OntoIndex server.

```json
{
  "tool": "gn_resource_trace",
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
- Typical result: Trace POSIX resource ownership acquire/duplicate/release facts; When proving or rejecting fd, pid, pidfd, pipe, socket, fork, exec, or wait lifecycle claims.

## Parameters

| Parameter | Type | Required | Purpose |
| --- | --- | --- | --- |
| `legacyResponse` | boolean | no | Return the legacy pre-envelope response shape. Default: true. Set false to opt into the capability-aware response envelope. |
| `maxRecords` | number | no | Maximum resource records returned. Default: 500. |
| `path` | string | no | Repository-relative source path to read. |
| `processIdentity` | string | no | Process identity label. Default: process:local. |
| `repo` | string | no | Repository name or path. Omit if only one repo is indexed. |
| `source` | string | no | Alias for inline source text. |
| `sourceText` | string | no | Inline source text to analyze. |

## Returning Answer Shape

Actual responses depend on repository state, index freshness, and requested limits. A minimal expected shape is:

```json
{
  "status": "ok",
  "tool": "gn_resource_trace",
  "summary": "Trace POSIX resource ownership acquire/duplicate/release facts",
  "evidenceClasses": [
    "audit_evidence",
    "graph_evidence"
  ],
  "nextAction": "When proving or rejecting fd, pid, pidfd, pipe, socket, fork, exec, or wait lifecycle claims"
}
```

## When It Is Useful

When proving or rejecting fd, pid, pidfd, pipe, socket, fork, exec, or wait lifecycle claims.

## Operational Notes

- Kind: `super`.
- Contract status: `stable`.
- Discoverable modes: `general`, `audit`, `refactor`, `query-projects`.
- Audit authority: `true`.
- Advisory-only: `false`.
- Source of truth: `ontoindex/src/mcp/shared/tool-registry.ts` and `ontoindex/src/mcp/*/tool-definitions.ts`.

## Related Concepts

OntoIndex, MCP server, code graph, AI coding agent, static analysis, repository impact analysis, systems-audit, gn_resource_trace.
