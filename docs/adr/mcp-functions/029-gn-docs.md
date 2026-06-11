# ADR-MCP-029: gn_docs

## Status

Accepted.

## Function

`gn_docs`

## SEO Summary

OntoIndex MCP function `gn_docs` supports inspect docs trace, drift, context, or readiness for AI coding agents, local code graph analysis, repository safety workflows, and Model Context Protocol automation.

## Context

Docs-specific safe agent reports over stabilized docs JSON contracts: trace requirements, check API drift, inspect docs context/readiness, and return compact MCP-safe metadata with skip reasons.

## Decision

Document `gn_docs` as a public OntoIndex MCP function because agents and human operators need a stable, linkable explanation of its purpose, predecessor surface, call shape, and returned evidence.

## Predecessors

Extends raw graph and markdown evidence into bounded documentation-readiness workflows.

## How To Use

Call this function through an MCP client connected to the OntoIndex server.

```json
{
  "tool": "gn_docs",
  "arguments": {
    "repo": "my-repo",
    "maxItems": 25,
    "limit": 25
  }
}
```

## What Information You Can Get

- Category: `docs`.
- Evidence classes: `advisory_memory`, `docs_evidence`.
- Response style: structured JSON suitable for automation.
- Permission profile: `read_only`.
- Typical result: Inspect docs trace, drift, context, or readiness; When you need bounded docs evidence without raw graph queries; use includeMemories only for advisory context/readiness and never as trace/drift evidence.

## Parameters

| Parameter | Type | Required | Purpose |
| --- | --- | --- | --- |
| `action` | string: trace, drift, context, readiness | no | Docs report action. Default: readiness. |
| `cursor` | string | no | Opaque cursor returned by a previous docs response. Keeps deterministic page boundaries for follow-up pages. |
| `format` | string: json, inline, both | no | Optional derived formatter. Omitted/json returns canonical compact JSON only; inline/both also include inlineContext text derived from the JSON report. Default: "json". |
| `id` | string | no | Requirement id filter for action="trace". |
| `includeMemories` | boolean | no | Opt in to advisory memory summary metadata for action="context" or "readiness". Ignored for trace/drift and never used as docs evidence or readiness authority. |
| `limit` | number | no | Alias for maxItems, for consistency with other bounded MCP tools. Default: 25. |
| `maxCandidatesPerFact` | number | no | Maximum ambiguous candidates retained per docs evidence fact. Default: 5. |
| `maxEvidenceItems` | number | no | Maximum evidence bullets included in inlineContext. Default: 6. |
| `maxItems` | number | no | Maximum compact docs evidence items to return. Default: 25. |
| `maxTokens` | number | no | Maximum estimated tokens for inlineContext when format is inline or both. Default: 900. |
| `minimal` | boolean | no | Return only the core result summary and next action. Default: false. |
| `repo` | string | no | Repository name or path. Omit if only one repo is indexed. |
| `summary` | boolean | no | Return lighter JSON that keeps status, freshness, and warnings while omitting heavy nested evidence. Default: false. |

## Returning Answer Shape

Actual responses depend on repository state, index freshness, and requested limits. A minimal expected shape is:

```json
{
  "status": "ok",
  "tool": "gn_docs",
  "summary": "Inspect docs trace, drift, context, or readiness",
  "evidenceClasses": [
    "advisory_memory",
    "docs_evidence"
  ],
  "nextAction": "When you need bounded docs evidence without raw graph queries; use includeMemories only for advisory context/readiness and never as trace/drift evidence."
}
```

## When It Is Useful

When you need bounded docs evidence without raw graph queries; use includeMemories only for advisory context/readiness and never as trace/drift evidence.

## Operational Notes

- Kind: `super`.
- Contract status: `stable`.
- Discoverable modes: `general`, `audit`, `refactor`, `query-projects`.
- Audit authority: `false`.
- Advisory-only: `true`.
- Source of truth: `ontoindex/src/mcp/shared/tool-registry.ts` and `ontoindex/src/mcp/*/tool-definitions.ts`.

## Related Concepts

OntoIndex, MCP server, code graph, AI coding agent, static analysis, repository impact analysis, docs, gn_docs.
