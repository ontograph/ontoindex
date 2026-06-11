# ADR-MCP-034: gn_extract_fsm

## Status

Accepted.

## Function

`gn_extract_fsm`

## SEO Summary

OntoIndex MCP function `gn_extract_fsm` supports extract state machines from enums and state variables for AI coding agents, local code graph analysis, repository safety workflows, and Model Context Protocol automation.

## Context

Systems-audit FSM extraction: map enum/state assignments, transition guards, and missing-state guard warnings from bounded source text or a source path.

## Decision

Document `gn_extract_fsm` as a public OntoIndex MCP function because agents and human operators need a stable, linkable explanation of its purpose, predecessor surface, call shape, and returned evidence.

## Predecessors

Extends the audit layer with systems-programming analyzers for resource, concurrency, ABI, taint, and fault evidence.

## How To Use

Call this function through an MCP client connected to the OntoIndex server.

```json
{
  "tool": "gn_extract_fsm",
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
- Typical result: Extract state machines from enums and state variables; When state transitions or missing guards are spread across a class/module.

## Parameters

| Parameter | Type | Required | Purpose |
| --- | --- | --- | --- |
| `enumName` | string | no | Optional enum name override. |
| `legacyResponse` | boolean | no | Return the legacy pre-envelope response shape. Default: true. Set false to opt into the capability-aware response envelope. |
| `maxRecords` | number | no | Maximum states/transitions/warnings returned. Default: 50, max: 200. |
| `path` | string | no | Repository-relative source path to read. |
| `repo` | string | no | Repository name or path. Omit if only one repo is indexed. |
| `sourceText` | string | no | Inline source text to analyze. |
| `stateVariable` | string | no | State variable name to track. |
| `target` | string | no | Enum/state target, e.g. SidecarManager::State. |

## Returning Answer Shape

Actual responses depend on repository state, index freshness, and requested limits. A minimal expected shape is:

```json
{
  "status": "ok",
  "tool": "gn_extract_fsm",
  "summary": "Extract state machines from enums and state variables",
  "evidenceClasses": [
    "audit_evidence",
    "graph_evidence"
  ],
  "nextAction": "When state transitions or missing guards are spread across a class/module"
}
```

## When It Is Useful

When state transitions or missing guards are spread across a class/module.

## Operational Notes

- Kind: `super`.
- Contract status: `stable`.
- Discoverable modes: `general`, `audit`, `refactor`, `query-projects`.
- Audit authority: `true`.
- Advisory-only: `false`.
- Source of truth: `ontoindex/src/mcp/shared/tool-registry.ts` and `ontoindex/src/mcp/*/tool-definitions.ts`.

## Related Concepts

OntoIndex, MCP server, code graph, AI coding agent, static analysis, repository impact analysis, systems-audit, gn_extract_fsm.
