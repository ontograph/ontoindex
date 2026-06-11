# ADR-MCP-016: gn_audit_session_dispatch

## Status

Accepted.

## Function

`gn_audit_session_dispatch`

## SEO Summary

OntoIndex MCP function `gn_audit_session_dispatch` supports generate a worker prompt only for a persisted, dispatchable manager bundle for AI coding agents, local code graph analysis, repository safety workflows, and Model Context Protocol automation.

## Context

Manager-level audit dispatch: refuse stale sessions, unverified findings, HOLD/NEEDS-VERIFY statuses, and duplicate-only bundle children before generating a worker prompt.

## Decision

Document `gn_audit_session_dispatch` as a public OntoIndex MCP function because agents and human operators need a stable, linkable explanation of its purpose, predecessor surface, call shape, and returned evidence.

## Predecessors

Evolved from standalone audit ingest, verify, dedupe, bundle, dispatch, and review calls into a manager-loop lifecycle function.

## How To Use

Call this function through an MCP client connected to the OntoIndex server.

```json
{
  "tool": "gn_audit_session_dispatch",
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
- Permission profile: `release`.
- Typical result: Generate a worker prompt only for a persisted, dispatchable manager bundle; Preferred worker handoff path after manager bundling.

## Parameters

| Parameter | Type | Required | Purpose |
| --- | --- | --- | --- |
| `bundleId` | string | no | Persisted bundle id to dispatch. |
| `maxPromptChars` | number | no | Maximum prompt characters returned. Default: 20000. |
| `persist` | boolean | no | Persist BundleDispatched event. Default: true. |
| `redactionMode` | string: none, paths, snippets, sensitive | no | Prompt redaction policy. Default: sensitive. |
| `repo` | string | no | Repository name or path. Omit if only one repo is indexed. |
| `session` | string | yes | Audit session id. |
| `sessionId` | string | no | Alias for session. |

## Returning Answer Shape

Actual responses depend on repository state, index freshness, and requested limits. A minimal expected shape is:

```json
{
  "status": "ok",
  "tool": "gn_audit_session_dispatch",
  "summary": "Generate a worker prompt only for a persisted, dispatchable manager bundle",
  "evidenceClasses": [
    "audit_evidence"
  ],
  "nextAction": "Preferred worker handoff path after manager bundling"
}
```

## When It Is Useful

Preferred worker handoff path after manager bundling.

## Operational Notes

- Kind: `super`.
- Contract status: `stable`.
- Discoverable modes: `general`, `audit`, `refactor`.
- Audit authority: `true`.
- Advisory-only: `false`.
- Source of truth: `ontoindex/src/mcp/shared/tool-registry.ts` and `ontoindex/src/mcp/*/tool-definitions.ts`.

## Related Concepts

OntoIndex, MCP server, code graph, AI coding agent, static analysis, repository impact analysis, lifecycle, gn_audit_session_dispatch.
