# ADR-MCP-004: gn_abi_diff

## Status

Accepted.

## Function

`gn_abi_diff`

## SEO Summary

OntoIndex MCP function `gn_abi_diff` supports compare cross-language payload and interface shapes for AI coding agents, local code graph analysis, repository safety workflows, and Model Context Protocol automation.

## Context

Systems-audit ABI diff: compare C++/Rust/JSON source payloads with TypeScript/JSON targets and flag precision, nullability, and field mismatches.

## Decision

Document `gn_abi_diff` as a public OntoIndex MCP function because agents and human operators need a stable, linkable explanation of its purpose, predecessor surface, call shape, and returned evidence.

## Predecessors

Extends the audit layer with systems-programming analyzers for resource, concurrency, ABI, taint, and fault evidence.

## How To Use

Call this function through an MCP client connected to the OntoIndex server.

```json
{
  "tool": "gn_abi_diff",
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
- Typical result: Compare cross-language payload and interface shapes; When C++/Rust/JSON payloads may not match TypeScript/JSON consumers.

## Parameters

| Parameter | Type | Required | Purpose |
| --- | --- | --- | --- |
| `legacyResponse` | boolean | no | Return the legacy pre-envelope response shape. Default: true. Set false to opt into the capability-aware response envelope. |
| `maxFindings` | number | no | Maximum findings returned. Default: 50, max: 100. |
| `repo` | string | no | Repository name or path. Omit if only one repo is indexed. |
| `sourceLanguage` | string: cpp, rust, json | no | Source language hint. |
| `sourcePath` | string | no | Path to source struct or payload. |
| `sourceStruct` | string | no | Inline source struct or JSON payload. |
| `targetInterface` | string | no | Inline target TypeScript interface or JSON payload. |
| `targetLanguage` | string: typescript, json | no | Target language hint. |
| `targetPath` | string | no | Path to target interface or payload. |

## Returning Answer Shape

Actual responses depend on repository state, index freshness, and requested limits. A minimal expected shape is:

```json
{
  "status": "ok",
  "tool": "gn_abi_diff",
  "summary": "Compare cross-language payload and interface shapes",
  "evidenceClasses": [
    "audit_evidence",
    "graph_evidence"
  ],
  "nextAction": "When C++/Rust/JSON payloads may not match TypeScript/JSON consumers"
}
```

## When It Is Useful

When C++/Rust/JSON payloads may not match TypeScript/JSON consumers.

## Operational Notes

- Kind: `super`.
- Contract status: `stable`.
- Discoverable modes: `general`, `audit`, `refactor`, `query-projects`.
- Audit authority: `true`.
- Advisory-only: `false`.
- Source of truth: `ontoindex/src/mcp/shared/tool-registry.ts` and `ontoindex/src/mcp/*/tool-definitions.ts`.

## Related Concepts

OntoIndex, MCP server, code graph, AI coding agent, static analysis, repository impact analysis, systems-audit, gn_abi_diff.
