# ADR-MCP-027: gn_diff_impact

## Status

Accepted.

## Function

`gn_diff_impact`

## SEO Summary

OntoIndex MCP function `gn_diff_impact` supports what is the blast radius of these commits? (mcp surface) for AI coding agents, local code graph analysis, repository safety workflows, and Model Context Protocol automation.

## Context

PR blast-radius report: diffs the working tree (staged, branch, or an explicit commit range), finds symbols defined in each changed file, runs upstream/downstream impact analysis per symbol, aggregates HIGH-risk symbols, and optionally suggests reviewers from git history.

## Decision

Document `gn_diff_impact` as a public OntoIndex MCP function because agents and human operators need a stable, linkable explanation of its purpose, predecessor surface, call shape, and returned evidence.

## Predecessors

Predecessor is the lower-level graph query, impact, audit, or backend action surface that existed before the public super-function/facade contract.

## How To Use

Call this function through an MCP client connected to the OntoIndex server.

```json
{
  "tool": "gn_diff_impact",
  "arguments": {
    "repo": "my-repo"
  }
}
```

## What Information You Can Get

- Category: `pr-review`.
- Evidence classes: `graph_evidence`.
- Response style: structured JSON suitable for automation.
- Permission profile: `advisory`.
- Typical result: What is the blast radius of these commits? (MCP surface); Commit-range or staged blast-radius analysis via MCP; pair with `ontoindex review diff` for local CLI review. Hosted PR adapter is a later Phase 6 feature.

## Parameters

| Parameter | Type | Required | Purpose |
| --- | --- | --- | --- |
| `commitRange` | string | no | Explicit git commit range (e.g. "HEAD~5..HEAD", "main...feature"). Omit to use staged changes. |
| `docsEvidence` | boolean | no | Opt in to advisory Markdown docs evidence for related requirements, API specs, and route drift. Does not affect risk reporting. Default: false. |
| `includeReviewers` | boolean | no | Suggest reviewers from git blame/log history. Default: true. |
| `repo` | string | no | Repository name or path. Omit if only one repo is indexed. |
| `scope` | string: staged, commit-range, branch | no | Which changes to diff. staged = git diff --cached; branch = main...HEAD; commit-range requires commitRange param. Default: staged. |

## Returning Answer Shape

Actual responses depend on repository state, index freshness, and requested limits. A minimal expected shape is:

```json
{
  "status": "ok",
  "tool": "gn_diff_impact",
  "summary": "What is the blast radius of these commits? (MCP surface)",
  "evidenceClasses": [
    "graph_evidence"
  ],
  "nextAction": "Commit-range or staged blast-radius analysis via MCP; pair with `ontoindex review diff` for local CLI review. Hosted PR adapter is a later Phase 6 feature."
}
```

## When It Is Useful

Commit-range or staged blast-radius analysis via MCP; pair with `ontoindex review diff` for local CLI review. Hosted PR adapter is a later Phase 6 feature.

## Operational Notes

- Kind: `super`.
- Contract status: `stable`.
- Discoverable modes: `general`, `audit`, `refactor`, `query-projects`.
- Audit authority: `false`.
- Advisory-only: `true`.
- Source of truth: `ontoindex/src/mcp/shared/tool-registry.ts` and `ontoindex/src/mcp/*/tool-definitions.ts`.

## Related Concepts

OntoIndex, MCP server, code graph, AI coding agent, static analysis, repository impact analysis, pr-review, gn_diff_impact.
