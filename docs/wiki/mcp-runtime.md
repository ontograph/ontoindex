# MCP Runtime

## Purpose

The MCP runtime exposes OntoIndex graph intelligence to agents. It wraps primitive graph queries and higher-level super-functions behind a stable MCP frontier.

Current MCP audit result:

- Runtime package: `ontoindex@1.9.3`
- Callable MCP tools: 61
- Transport-level method calls tested: 61/61
- Unknown-tool failures: 0
- Tool contract status: `ok`

## Runtime Components

| Path | Responsibility |
| --- | --- |
| `ontoindex/src/mcp/server.ts` | MCP stdio server setup. |
| `ontoindex/src/mcp/tools.ts` | Legacy/primitive tool registrations. |
| `ontoindex/src/mcp/facade/` | Public facade tools: `discover`, `search`, `inspect`, `audit`, `refactor`, `manage`, `docs`, `impact`. |
| `ontoindex/src/mcp/super/` | Higher-level `gn_*` workflows. |
| `ontoindex/src/mcp/local/` | Backend implementations for local graph operations. |
| `ontoindex/src/mcp/shared/` | Response envelopes, freshness policy, tool registry, target context. |

## Main Facades

| Tool | Use |
| --- | --- |
| `discover` | Repos, routes, tools, packs, groups, sync. |
| `search` | Semantic, Cypher, and repomap retrieval. |
| `inspect` | Symbol context, evidence, API shape, IPC trace. |
| `impact` | Symbol, route, batch, and diff impact. |
| `audit` | Audit reports and systems checks. |
| `refactor` | Rename, replace, sandbox operations. |
| `manage` | Sessions and route maps. |
| `docs` | Docs readiness, trace, drift, context. |

## Super-Function Groups

| Group | Examples |
| --- | --- |
| Discovery | `gn_explore`, `gn_explain_module`, `gn_find_related`, `gn_graph_walk` |
| Safety | `gn_safe_edit_check`, `gn_can_delete`, `gn_pre_commit_audit`, `gn_verify_diff`, `gn_test_gap` |
| Refactor | `gn_safe_refactor` |
| Audit lifecycle | `gn_audit_ingest`, `gn_audit_verify`, `gn_audit_bundle`, `gn_audit_session_*` |
| Systems audit | `gn_resource_trace`, `gn_path_verify`, `gn_trace_boundary`, `gn_error_topology`, `gn_taint_trace`, `gn_abi_diff` |
| Self-help | `gn_help`, `gn_tool_contract`, `gn_diagnose`, `gn_propose_location`, `gn_quality_mode` |

## Current Registration

The Codex MCP config was repaired to start OntoIndex with:

```text
ONTOINDEX_MCP_PROJECT_CWD=/opt/demodb/_workfolder/OntoIndex
ONTOINDEX_MCP_REPO=/opt/demodb/_workfolder/OntoIndex
ONTOINDEX_MAX_WORKERS=7
```

Restart MCP clients after config changes so the runtime loads the current repository instead of an older target.
