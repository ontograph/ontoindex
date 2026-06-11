# ADR-MCP-061: search

## Status

Accepted.

## Function

`search`

## SEO Summary

OntoIndex MCP function `search` supports search the knowledge graph using semantic, cypher, or repomap queries for AI coding agents, local code graph analysis, repository safety workflows, and Model Context Protocol automation.

## Context

Search the knowledge graph using semantic, Cypher, or repomap queries. Semantic search can opt in to sidecar enrichment, passive related facts, Markdown context, and Markdown PPR metadata.

## Decision

Document `search` as a public OntoIndex MCP function because agents and human operators need a stable, linkable explanation of its purpose, predecessor surface, call shape, and returned evidence.

## Predecessors

Consolidates earlier direct backend actions into the `search` facade. Current action set: semantic, cypher, repomap.

## How To Use

Call this function through an MCP client connected to the OntoIndex server.

```json
{
  "tool": "search",
  "arguments": {
    "action": "semantic",
    "repo": "my-repo",
    "limit": 5
  }
}
```

## What Information You Can Get

- Category: `discovery`.
- Evidence classes: `graph_evidence`.
- Response style: structured JSON suitable for automation.
- Permission profile: `read_only`.
- Facade actions: `semantic`, `cypher`, `repomap`.
- Typical result: Search the knowledge graph using semantic, Cypher, or repomap queries; When you need to find specific symbols, patterns, or files via the graph.

## Parameters

| Parameter | Type | Required | Purpose |
| --- | --- | --- | --- |
| `action` | string: semantic, cypher, repomap | yes | The search action to perform. |
| `allow_low_confidence` | boolean | no | Allow low-confidence sidecar enrichment records. Default: false. |
| `consume_enrichment_facts` | boolean | no | Opt in to sidecar enrichment facts under the top-level enrichment envelope. Default: false. |
| `focus` | array | no | Repomap focus file paths or symbol names. |
| `format` | string: signatures, outline, full, compressed | no | Repomap output format. Default: "signatures". |
| `goal` | string | no | What you want to find. Helps semantic ranking. |
| `include_content` | boolean | no | Include full symbol source content for semantic results. Default: false. |
| `include_markdown_context` | boolean | no | Include Markdown document context when enrichment facts and passive related facts are enabled. Default: false. |
| `include_markdown_ppr` | boolean | no | Include bounded Markdown document-only PPR metadata with Markdown context. Default: false. |
| `include_passive_related_facts` | boolean | no | Opt in to HippoRAG-style passive related fact metadata when consume_enrichment_facts is true. Default: false. |
| `include_skeleton` | boolean | no | Include AST skeletons for top semantic result files. Default: true. |
| `limit` | number | no | Maximum semantic processes/results to return. Default: 5. |
| `max_symbols` | number | no | Maximum symbols per semantic process. Default: 10. |
| `query` | string | no | Search query or Cypher statement. For action="semantic", this can also carry the existing typed-query document when typed_query is true. |
| `repo` | string | no | Repository name or path. |
| `retrieval_policy` | string: graph-only, graph-with-passive-docs, requirement-neighborhood, api-route-neighborhood, process-neighborhood, symbol-neighborhood | no | Named retrieval expansion policy. Defaults to graph-only behavior unless explicitly set. |
| `service` | string | no | Optional monorepo service root. In group mode (@repo), prefix-matches member file paths. |
| `structured_output` | boolean | no | For action="semantic", include structured_retrieval candidates, evidence references, and capability state when the backend can produce them. Default: false. |
| `task_context` | string | no | What you are working on. Helps semantic ranking. |
| `token_budget` | number | no | Repomap token budget. Default: 4000. |
| `typed_query` | boolean | no | Parse query as the existing typed-query document when action="semantic". Current degraded capabilities: @group searches fall back to plain semantic search, vec/hyde lanes downgrade when embeddings are unavailable, and graph lanes may fall back to BM25 seeds when traversal is unavailable. Default: false. |

## Returning Answer Shape

Actual responses depend on repository state, index freshness, and requested limits. A minimal expected shape is:

```json
{
  "status": "ok",
  "tool": "search",
  "summary": "Search the knowledge graph using semantic, Cypher, or repomap queries",
  "evidenceClasses": [
    "graph_evidence"
  ],
  "nextAction": "When you need to find specific symbols, patterns, or files via the graph"
}
```

## When It Is Useful

When you need to find specific symbols, patterns, or files via the graph.

## Operational Notes

- Kind: `facade`.
- Contract status: `stable`.
- Discoverable modes: `general`, `audit`, `refactor`, `query-projects`.
- Audit authority: `false`.
- Advisory-only: `false`.
- Source of truth: `ontoindex/src/mcp/shared/tool-registry.ts` and `ontoindex/src/mcp/*/tool-definitions.ts`.

## Related Concepts

OntoIndex, MCP server, code graph, AI coding agent, static analysis, repository impact analysis, discovery, search.
