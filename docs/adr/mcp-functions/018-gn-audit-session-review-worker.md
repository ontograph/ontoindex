# ADR-MCP-018: gn_audit_session_review_worker

## Status

Accepted.

## Function

`gn_audit_session_review_worker`

## SEO Summary

OntoIndex MCP function `gn_audit_session_review_worker` supports review worker edits with scope guard and required test checks for AI coding agents, local code graph analysis, repository safety workflows, and Model Context Protocol automation.

## Context

Manager-level audit worker review: run scope guard and required-test checks against a persisted bundle after worker edits.

## Decision

Document `gn_audit_session_review_worker` as a public OntoIndex MCP function because agents and human operators need a stable, linkable explanation of its purpose, predecessor surface, call shape, and returned evidence.

## Predecessors

Evolved from standalone audit ingest, verify, dedupe, bundle, dispatch, and review calls into a manager-loop lifecycle function.

## How To Use

Call this function through an MCP client connected to the OntoIndex server.

```json
{
  "tool": "gn_audit_session_review_worker",
  "arguments": {
    "repo": "my-repo",
    "session": "audit-session-001"
  }
}
```

## What Information You Can Get

- Category: `lifecycle`.
- Evidence classes: `audit_evidence`.
- Response style: structured JSON suitable for automation.
- Permission profile: `write_apply`.
- Typical result: Review worker edits with scope guard and required test checks; Preferred post-worker manager review step.

## Parameters

| Parameter | Type | Required | Purpose |
| --- | --- | --- | --- |
| `bundleId` | string | no | Persisted bundle id under review. |
| `changedFiles` | array | no | Changed files from the implementation diff. |
| `changedSymbols` | array | no | Changed symbols from the implementation diff. |
| `executedTests` | array | no | Tests the worker actually executed. |
| `persist` | boolean | no | Persist ScopeGuardEvaluated event. Default: true. |
| `repo` | string | no | Repository name or path. Omit if only one repo is indexed. |
| `requiredTests` | array | no | Override required tests for this review. |
| `session` | string | yes | Audit session id. |
| `sessionId` | string | no | Alias for session. |

## Returning Answer Shape

Actual responses depend on repository state, index freshness, and requested limits. A minimal expected shape is:

```json
{
  "status": "ok",
  "tool": "gn_audit_session_review_worker",
  "summary": "Review worker edits with scope guard and required test checks",
  "evidenceClasses": [
    "audit_evidence"
  ],
  "nextAction": "Preferred post-worker manager review step"
}
```

## When It Is Useful

Preferred post-worker manager review step.

## Operational Notes

- Kind: `super`.
- Contract status: `stable`.
- Discoverable modes: `general`, `audit`, `refactor`.
- Audit authority: `true`.
- Advisory-only: `false`.
- Source of truth: `ontoindex/src/mcp/shared/tool-registry.ts` and `ontoindex/src/mcp/*/tool-definitions.ts`.

## Related Concepts

OntoIndex, MCP server, code graph, AI coding agent, static analysis, repository impact analysis, lifecycle, gn_audit_session_review_worker.
