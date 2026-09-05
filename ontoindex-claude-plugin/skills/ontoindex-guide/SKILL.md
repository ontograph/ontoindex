---
name: ontoindex-guide
description: "Use when the user asks about OntoIndex itself — available tools, how to query the knowledge graph, MCP resources, graph schema, or workflow reference. Examples: \"What OntoIndex tools are available?\", \"How do I use OntoIndex?\""
---

# OntoIndex Guide

Quick reference for all OntoIndex MCP tools, resources, and the knowledge graph schema.

Verified against OntoIndex 2.2.0 on 2026-09-05 by calling the running MCP
server (`gn_tool_contract`).

## Always Start Here

For any task involving code understanding, debugging, impact analysis, or refactoring:

1. **Check freshness** with `gn_ensure_fresh({repo})` before any graph-backed claim.
2. **Match your task to a skill below** and **read that skill file**
3. **Follow the skill's workflow and checklist**

If OntoIndex is required but no OntoIndex tool is callable, stop and report the
missing tool. Do not silently fall back to grep-only inspection and present the
result as graph-backed evidence. Repair with `ontoindex mcp-doctor` and
`ontoindex setup`, then confirm the tools are callable.

> If freshness reports stale, refresh with `ontoindex analyze`. See
> `ontoindex-cli` for the single-owner lock and job rules.

## Tool Naming

Two callable surfaces exist. Both are served by the same MCP server.

- Facade tools take an `action`: `search`, `inspect`, `impact`, `refactor`,
  `audit`, `docs`, `discover`, `manage`.
- Compatibility tools are the 54 `gn_*` tools, such as `gn_explore`,
  `gn_ensure_fresh`, `gn_verify_diff`, and `gn_safe_edit_check`.

The `ontoindex` dispatcher tool is advertised by the registry but is **not**
callable in the default `public-full` startup profile; calling it returns
`Unknown tool method: ontoindex`. Use a facade or `gn_*` tool instead.

Verified callable examples:

```
search({action: "semantic", repo: "<repo>", query: "concept"})
inspect({action: "context", repo: "<repo>", target: "symbolName"})
impact({action: "symbol", repo: "<repo>", target: "symbolName", direction: "upstream"})
gn_ensure_fresh({repo: "<repo>"})
```

Older `ontoindex_query`, `ontoindex_context`, `ontoindex_impact`,
`ontoindex_rename`, and `ontoindex_detect_changes` names are **not** callable in
2.2.0. Use the facade or `gn_*` equivalents below.

## Skills

| Task                                         | Skill to read       |
| -------------------------------------------- | ------------------- |
| Understand architecture / "How does X work?" | `ontoindex-exploring`         |
| Blast radius / "What breaks if I change X?"  | `ontoindex-impact-analysis`   |
| Trace bugs / "Why is X failing?"             | `ontoindex-debugging`         |
| Rename / extract / split / refactor          | `ontoindex-refactoring`       |
| Tools, resources, schema reference           | `ontoindex-guide` (this file) |
| Index, status, clean, wiki CLI commands      | `ontoindex-cli`               |

## Tools Reference

| Intent                  | Callable tool                                     |
| ----------------------- | ------------------------------------------------- |
| Find execution flows    | `search({action: "semantic"})` or `gn_explore`     |
| Symbol callers/callees  | `inspect({action: "context"})` or `gn_find_related`|
| Blast radius            | `impact({action: "symbol"})`                       |
| Pre-edit safety check   | `gn_safe_edit_check`                               |
| Diff/commit verification| `gn_verify_diff`, `gn_diff_impact`                 |
| Coordinated rename      | `refactor({action: "rename"})`, `gn_safe_refactor` |
| Index freshness         | `gn_ensure_fresh`, `gn_analyze_job`                |
| Deletion safety         | `gn_can_delete`                                    |
| Discover the surface    | `gn_help`, `gn_tool_contract`                      |

Confirm the exact surface for an installed version with `gn_tool_contract`;
it reports advertised versus callable names and any drift.

## Resources Reference

Lightweight reads (~100-500 tokens) for navigation. `mcp-doctor` may report the
resource bridge as "not exposed"; when it is unavailable, use the tools above
instead of assuming the resource read failed for another reason.

| Resource                                       | Content                                   |
| ---------------------------------------------- | ----------------------------------------- |
| `ontoindex://repo/{name}/context`               | Stats, staleness check                    |
| `ontoindex://repo/{name}/clusters`              | All functional areas with cohesion scores |
| `ontoindex://repo/{name}/cluster/{clusterName}` | Area members                              |
| `ontoindex://repo/{name}/processes`             | All execution flows                       |
| `ontoindex://repo/{name}/process/{processName}` | Step-by-step trace                        |
| `ontoindex://repo/{name}/schema`                | Graph schema for Cypher                   |

## Graph Schema

**Nodes:** File, Function, Class, Interface, Method, Community, Process
**Edges (via CodeRelation.type):** CALLS, IMPORTS, EXTENDS, IMPLEMENTS, DEFINES, MEMBER_OF, STEP_IN_PROCESS

```cypher
MATCH (caller)-[:CodeRelation {type: 'CALLS'}]->(f:Function {name: "myFunc"})
RETURN caller.name, caller.filePath
```
