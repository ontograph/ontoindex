# ADR-MCP-054: gn_trace_boundary

## Status

Accepted.

## Function

`gn_trace_boundary`

## SEO Summary

OntoIndex MCP function `gn_trace_boundary` supports trace resource handoff across process boundaries for AI coding agents, local code graph analysis, repository safety workflows, and Model Context Protocol automation.

## Context

Systems-audit resource boundary trace: trace FD/resource handoff across SCM_RIGHTS, pidfd_getfd, fork inheritance, and exec close-on-exec filtering without using FD number equality as identity proof.

## Decision

Document `gn_trace_boundary` as a public OntoIndex MCP function because agents and human operators need a stable, linkable explanation of its purpose, predecessor surface, call shape, and returned evidence.

## Predecessors

Extends the audit layer with systems-programming analyzers for resource, concurrency, ABI, taint, and fault evidence.

## How To Use

Call this function through an MCP client connected to the OntoIndex server.

```json
{
  "tool": "gn_trace_boundary",
  "arguments": {
    "repo": "my-repo",
    "resource": "fd",
    "start": "openConfig"
  }
}
```

## What Information You Can Get

- Category: `systems-audit`.
- Evidence classes: `audit_evidence`, `graph_evidence`.
- Response style: structured JSON suitable for automation.
- Permission profile: `read_only`.
- Typical result: Trace resource handoff across process boundaries; When following FD or process-boundary resource lifecycle evidence.

## Parameters

| Parameter | Type | Required | Purpose |
| --- | --- | --- | --- |
| `end` | string | no | Optional expected destination symbol, file, or receiver label. |
| `legacyResponse` | boolean | no | Return the legacy pre-envelope response shape. Default: true. Set false to opt into the capability-aware response envelope. |
| `mechanism` | string: SCM_RIGHTS, pidfd_getfd, fork, exec | no | Boundary handoff mechanism. Omit to infer from evidence. |
| `repo` | string | no | Repository name or path. Omit if only one repo is indexed. |
| `resource` | string | yes | Resource kind to trace, for example fd or signal_mask. Default: "fd". |
| `source` | string | no | Optional source text to trace directly. |
| `start` | string | yes | Starting symbol, file, or source-side handle label. |

## Returning Answer Shape

Actual responses depend on repository state, index freshness, and requested limits. A minimal expected shape is:

```json
{
  "status": "ok",
  "tool": "gn_trace_boundary",
  "summary": "Trace resource handoff across process boundaries",
  "evidenceClasses": [
    "audit_evidence",
    "graph_evidence"
  ],
  "nextAction": "When following FD or process-boundary resource lifecycle evidence"
}
```

## When It Is Useful

When following FD or process-boundary resource lifecycle evidence.

## Operational Notes

- Kind: `super`.
- Contract status: `stable`.
- Discoverable modes: `general`, `audit`, `refactor`, `query-projects`.
- Audit authority: `true`.
- Advisory-only: `false`.
- Source of truth: `ontoindex/src/mcp/shared/tool-registry.ts` and `ontoindex/src/mcp/*/tool-definitions.ts`.

## Related Concepts

OntoIndex, MCP server, code graph, AI coding agent, static analysis, repository impact analysis, systems-audit, gn_trace_boundary.
