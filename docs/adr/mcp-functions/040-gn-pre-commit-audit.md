# ADR-MCP-040: gn_pre_commit_audit

## Status

Accepted.

## Function

`gn_pre_commit_audit`

## SEO Summary

OntoIndex MCP function `gn_pre_commit_audit` supports is this commit ready to ship? for AI coding agents, local code graph analysis, repository safety workflows, and Model Context Protocol automation.

## Context

Ship-readiness verdict: diffs the working tree, identifies changed symbols, runs per-symbol impact analysis, and emits READY / REVIEW / DO-NOT-COMMIT with a per-file breakdown and any unexpected symbol warnings.

## Decision

Document `gn_pre_commit_audit` as a public OntoIndex MCP function because agents and human operators need a stable, linkable explanation of its purpose, predecessor surface, call shape, and returned evidence.

## Predecessors

Predecessor is the lower-level graph query, impact, audit, or backend action surface that existed before the public super-function/facade contract.

## How To Use

Call this function through an MCP client connected to the OntoIndex server.

```json
{
  "tool": "gn_pre_commit_audit",
  "arguments": {
    "repo": "my-repo"
  }
}
```

## What Information You Can Get

- Category: `safety`.
- Evidence classes: `audit_evidence`, `graph_evidence`.
- Response style: structured JSON suitable for automation.
- Permission profile: `release`.
- Typical result: Is this commit ready to ship; Before commit (replaces ontoindex_detect_changes).

## Parameters

| Parameter | Type | Required | Purpose |
| --- | --- | --- | --- |
| `docsEvidence` | boolean | no | Opt in to advisory Markdown docs evidence for related requirements, API specs, and route drift. Does not affect verdict/risk scoring. Default: false. |
| `expectedSymbols` | array | no | Symbols you intended to change. Unexpected changed symbols outside this list are flagged as warnings. |
| `repo` | string | no | Repository name or path. Omit if only one repo is indexed. |
| `scope` | string: staged, unstaged, all, branch | no | Which changes to audit. staged = git diff --cached; unstaged = git diff; all = both; branch = all commits since main. Default: staged. |

## Returning Answer Shape

Actual responses depend on repository state, index freshness, and requested limits. A minimal expected shape is:

```json
{
  "status": "ok",
  "tool": "gn_pre_commit_audit",
  "summary": "Is this commit ready to ship?",
  "evidenceClasses": [
    "audit_evidence",
    "graph_evidence"
  ],
  "nextAction": "Before commit (replaces ontoindex_detect_changes)"
}
```

## When It Is Useful

Before commit (replaces ontoindex_detect_changes).

## Operational Notes

- Kind: `super`.
- Contract status: `stable`.
- Discoverable modes: `general`, `audit`, `refactor`.
- Audit authority: `true`.
- Advisory-only: `false`.
- Source of truth: `ontoindex/src/mcp/shared/tool-registry.ts` and `ontoindex/src/mcp/*/tool-definitions.ts`.

## Related Concepts

OntoIndex, MCP server, code graph, AI coding agent, static analysis, repository impact analysis, safety, gn_pre_commit_audit.
