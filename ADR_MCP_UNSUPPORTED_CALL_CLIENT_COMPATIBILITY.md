# ADR: MCP Unsupported Call Client Compatibility

Status: OntoIndex docs done - client router fix remains external
Date: 2026-07-07

## Context

An Ontocode session against `/home/er77/_wrk/axel` reported that OntoIndex and lean-ctx MCP calls
failed with:

```text
unsupported call: mcp__ontoindex__discover
unsupported call: mcp__ontoindex__inspect
unsupported call: mcp__lean_ctx__ctx_search
```

The same session had earlier successful calls using the namespaced shape:

```text
name="inspect" namespace="mcp__ontoindex"
name="impact"  namespace="mcp__ontoindex"
```

The failed calls used a flattened name:

```text
name="mcp__ontoindex__inspect"
```

## Decision

Do not change the OntoIndex MCP server to accept flattened tool names. The call is rejected by the
client router before OntoIndex receives it.

The primary fix belongs in Ontocode:

1. when `namespace` is absent and `name` starts with `mcp__`, resolve the flattened name against
   registered MCP tool namespaces using the longest matching namespace prefix;
2. dispatch only if the normalized `(namespace, name)` exists;
3. return an actionable error when a flattened-looking name cannot resolve.

OntoIndex owns only supporting documentation and diagnostics:

1. document canonical MCP call identity as `namespace="mcp__ontoindex"`, `name="<tool>"`;
2. document that `unsupported call: mcp__ontoindex__...` means the MCP client/router rejected the
   call before OntoIndex handled it;
3. keep generated MCP function docs explicit about the client-facing call shape.

## Rejected

- Adding duplicate OntoIndex tools named `mcp__ontoindex__inspect`, `mcp__ontoindex__impact`, etc.
- Adding a flattened-name compatibility layer inside the OntoIndex MCP server.
- Treating this as index staleness, auth failure, or repo-scope misconfiguration.

## Acceptance

Ontocode acceptance:

- `name="mcp__ontoindex__inspect"` resolves to `namespace="mcp__ontoindex"`, `name="inspect"`.
- `name="mcp__lean_ctx__ctx_search"` resolves to `namespace="mcp__lean_ctx"`, `name="ctx_search"`.
- unknown flattened MCP names return an error that suggests the canonical namespace/name shape.

OntoIndex acceptance:

- troubleshooting docs mention the unsupported-call signature and point to the client router.
- MCP docs show canonical namespace/name examples for Ontocode-style clients.

## OntoIndex Implementation

- `README.md` documents the canonical `namespace="mcp__ontoindex", name="<tool>"` shape and the
  `unsupported call: mcp__ontoindex__...` troubleshooting signature.
- `scripts/generate-mcp-function-adrs.mjs` now includes the canonical namespace/name shape in future
  generated MCP function pages.
