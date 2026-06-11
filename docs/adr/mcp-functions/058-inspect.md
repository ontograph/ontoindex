# ADR-MCP-058: inspect

## Status

Accepted.

## Function

`inspect`

## SEO Summary

OntoIndex MCP function `inspect` supports inspect symbol context, evidence packs, api shapes, or ipc traces for AI coding agents, local code graph analysis, repository safety workflows, and Model Context Protocol automation.

## Context

Inspect symbol context, evidence packs, API shapes, or IPC traces. Context inspection can opt in to sidecar enrichment metadata.

## Decision

Document `inspect` as a public OntoIndex MCP function because agents and human operators need a stable, linkable explanation of its purpose, predecessor surface, call shape, and returned evidence.

## Predecessors

Consolidates earlier direct backend actions into the `inspect` facade. Current action set: context, evidence, shape, ipc.

## How To Use

Call this function through an MCP client connected to the OntoIndex server.

```json
{
  "tool": "inspect",
  "arguments": {
    "action": "context",
    "repo": "my-repo",
    "limit": 1
  }
}
```

## What Information You Can Get

- Category: `discovery`.
- Evidence classes: `graph_evidence`.
- Response style: structured JSON suitable for automation.
- Permission profile: `read_only`.
- Facade actions: `context`, `evidence`, `shape`, `ipc`.
- Typical result: Inspect symbol context, evidence packs, API shapes, or IPC traces; When you need deep context or evidence for a specific symbol or route.

## Parameters

| Parameter | Type | Required | Purpose |
| --- | --- | --- | --- |
| `action` | string: context, evidence, shape, ipc | yes | The inspection action to perform. |
| `allow_low_confidence` | boolean | no | Allow low-confidence sidecar enrichment records. Default: false. |
| `api_doc_id` | string | no | API docs identity for api-doc-neighborhood. |
| `consume_enrichment_facts` | boolean | no | Opt in to sidecar enrichment facts under the top-level enrichment envelope. Default: false. |
| `context_lines` | number | no | Evidence-pack context lines. Default: 3. |
| `depth` | number | no | Maximum traversal depth. |
| `doc_path` | string | no | Markdown document path identity. |
| `file_path` | string | no | Context file path disambiguator. |
| `include_content` | boolean | no | Include full symbol source content in context results. Default: false. |
| `include_markdown_context` | boolean | no | Include Markdown document context when enrichment facts and passive related facts are enabled. Default: false. |
| `include_markdown_ppr` | boolean | no | Include bounded Markdown document-only PPR metadata with Markdown context. Default: false. |
| `include_passive_related_facts` | boolean | no | Opt in to HippoRAG-style passive related fact metadata when consume_enrichment_facts is true. Default: false. |
| `include_snippet` | boolean | no | Include evidence-pack snippets. Default: true. |
| `kind` | string | no | Context symbol kind disambiguator. |
| `limit` | number | no | Maximum emitted items. |
| `maxCandidates` | number | no | Maximum ambiguous identity candidates. |
| `name` | string | no | Context symbol name. |
| `neighborhood_mode` | string: symbol-neighborhood, route-neighborhood, process-neighborhood, requirement-neighborhood, api-doc-neighborhood | no | Explicit bounded context neighborhood mode. When omitted, context keeps the default symbol view. |
| `process_id` | string | no | Process identity for process-neighborhood. |
| `repo` | string | no | Repository name or path. |
| `requirement_id` | string | no | Requirement identity for requirement-neighborhood. |
| `retrieval_policy` | string: graph-only, graph-with-passive-docs, requirement-neighborhood, api-route-neighborhood, process-neighborhood, symbol-neighborhood | no | Named retrieval expansion policy. Defaults to graph-only behavior unless explicitly set. |
| `route` | string | no | API route for shape checks. |
| `service` | string | no | Optional monorepo service root. In group mode (@repo), prefix-matches member file paths. |
| `symbol_name` | string | no | IPC trace symbol name. |
| `target` | string | no | Facade alias. Maps to name for context, targets[0] for evidence, route for shape, and symbol_name for IPC. |
| `targets` | array | no | Evidence-pack targets such as file:line or symbol names. |
| `uid` | string | no | Context symbol UID. |

## Returning Answer Shape

Actual responses depend on repository state, index freshness, and requested limits. A minimal expected shape is:

```json
{
  "status": "ok",
  "tool": "inspect",
  "summary": "Inspect symbol context, evidence packs, API shapes, or IPC traces",
  "evidenceClasses": [
    "graph_evidence"
  ],
  "nextAction": "When you need deep context or evidence for a specific symbol or route"
}
```

## When It Is Useful

When you need deep context or evidence for a specific symbol or route.

## Operational Notes

- Kind: `facade`.
- Contract status: `stable`.
- Discoverable modes: `general`, `audit`, `refactor`, `query-projects`.
- Audit authority: `false`.
- Advisory-only: `false`.
- Source of truth: `ontoindex/src/mcp/shared/tool-registry.ts` and `ontoindex/src/mcp/*/tool-definitions.ts`.

## Related Concepts

OntoIndex, MCP server, code graph, AI coding agent, static analysis, repository impact analysis, discovery, inspect.
