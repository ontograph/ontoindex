# ADR-MCP-057: impact

## Status

Accepted.

## Function

`impact`

## SEO Summary

OntoIndex MCP function `impact` supports analyze impact of changes on symbols, routes, or batches of symbols for AI coding agents, local code graph analysis, repository safety workflows, and Model Context Protocol automation.

## Context

Analyze impact of changes on symbols, routes, or batches of symbols. Symbol impact supports opt-in sidecar enrichment with a safety-critical gate.

## Decision

Document `impact` as a public OntoIndex MCP function because agents and human operators need a stable, linkable explanation of its purpose, predecessor surface, call shape, and returned evidence.

## Predecessors

Consolidates earlier direct backend actions into the `impact` facade. Current action set: symbol, batch, route, diff.

## How To Use

Call this function through an MCP client connected to the OntoIndex server.

```json
{
  "tool": "impact",
  "arguments": {
    "action": "symbol",
    "repo": "my-repo"
  }
}
```

## What Information You Can Get

- Category: `discovery`.
- Evidence classes: `graph_evidence`.
- Response style: structured JSON suitable for automation.
- Permission profile: `read_only`.
- Facade actions: `symbol`, `batch`, `route`, `diff`.
- Typical result: Analyze impact of changes on symbols, routes, or batches of symbols; When checking the blast radius of a change (pre-edit or post-edit).

## Parameters

| Parameter | Type | Required | Purpose |
| --- | --- | --- | --- |
| `action` | string: symbol, batch, route, diff | yes | The impact analysis action to perform. |
| `allow_low_confidence` | boolean | no | Allow low-confidence sidecar enrichment records. Default: false. |
| `allow_safety_critical_enrichment` | boolean | no | Allow sidecar fact consumption for safety-critical impact analysis. Default: false. |
| `consume_enrichment_facts` | boolean | no | Opt in to sidecar enrichment facts under the top-level enrichment envelope. Default: false. |
| `crossDepth` | number | no | Maximum cross-repo traversal depth. Default: 1. |
| `direction` | string: upstream, downstream | no | Impact direction for symbol and batch analysis. Defaults to upstream. Default: "upstream". |
| `file_path` | string | no | Symbol file-path disambiguator. |
| `includeTests` | boolean | no | Include test relationships in impact traversal. Default: false. |
| `kind` | string | no | Symbol kind disambiguator. |
| `maxDepth` | number | no | Maximum graph traversal depth. Default: 3. |
| `minConfidence` | number | no | Minimum relationship confidence. Default: 0. |
| `relationTypes` | array | no | Relationship types to include. |
| `repo` | string | no | Repository name or path. |
| `route` | string | no | Route for API impact. |
| `service` | string | no | Optional monorepo service root. In group mode (@repo), prefix-matches member file paths. |
| `target` | string | no | Symbol name, UID, route, or batch seed. Facade maps route target to route and batch target to targets[0]. |
| `target_uid` | string | no | Direct symbol UID for symbol impact. |
| `targets` | array | no | Batch impact target symbols. |
| `timeoutMs` | number | no | Impact timeout in milliseconds. |

## Returning Answer Shape

Actual responses depend on repository state, index freshness, and requested limits. A minimal expected shape is:

```json
{
  "status": "ok",
  "tool": "impact",
  "summary": "Analyze impact of changes on symbols, routes, or batches of symbols",
  "evidenceClasses": [
    "graph_evidence"
  ],
  "nextAction": "When checking the blast radius of a change (pre-edit or post-edit)"
}
```

## When It Is Useful

When checking the blast radius of a change (pre-edit or post-edit).

## Operational Notes

- Kind: `facade`.
- Contract status: `stable`.
- Discoverable modes: `general`, `audit`, `refactor`, `query-projects`.
- Audit authority: `false`.
- Advisory-only: `false`.
- Source of truth: `ontoindex/src/mcp/shared/tool-registry.ts` and `ontoindex/src/mcp/*/tool-definitions.ts`.

## Related Concepts

OntoIndex, MCP server, code graph, AI coding agent, static analysis, repository impact analysis, discovery, impact.
