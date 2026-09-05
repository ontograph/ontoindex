---
name: ontoindex-cli
description: "Use when the user needs to run OntoIndex CLI commands like analyze/index a repo, check status, clean the index, generate a wiki, or list indexed repos. Examples: \"Index this repo\", \"Reanalyze the codebase\", \"Generate a wiki\""
---

# OntoIndex CLI Commands

Use the installed `ontoindex` binary when it is on PATH; otherwise `npx
ontoindex` works without a global install. Verified against OntoIndex 2.2.0.

## MCP Availability

When OntoIndex is required but no OntoIndex tool is callable in the session,
treat it as a tooling failure and repair it before graph-backed work:

```bash
ontoindex mcp-doctor --repo <repo>   # verdict, freshness, and exact repair command
ontoindex setup                      # register MCP for supported clients
```

`mcp-doctor` reports whether an MCP process is running, whether the resource
bridge is exposed, and which repair command to run. After `setup` writes the
client configuration, the client must be restarted to load the server.

The `ontoindex` facade dispatcher is advertised but not callable in the default
`public-full` startup profile. Use the `search`, `inspect`, `impact`, and
`refactor` facades or the `gn_*` tools.

## Commands

### analyze — Build or refresh the index

```bash
npx ontoindex analyze
```

Run from the project root. This parses all source files, builds the knowledge graph, writes it to `.ontoindex/`, and generates CLAUDE.md / AGENTS.md context files.

| Flag           | Effect                                                           |
| -------------- | ---------------------------------------------------------------- |
| `--force`      | Force full re-index even if up to date                           |
| `--embeddings` | Enable embedding generation for semantic search (off by default) |

**When to run:** First time in a project, after major code changes, or when `ontoindex://repo/{name}/context` reports the index is stale. In Claude Code, a PostToolUse hook runs `analyze` automatically after `git commit` and `git merge`, preserving embeddings if previously generated.

### status — Check index freshness

```bash
npx ontoindex status
```

Shows whether the current repo has a OntoIndex index, when it was last updated, and symbol/relationship counts. Use this to check if re-indexing is needed.

### clean — Delete the index

```bash
npx ontoindex clean
```

Deletes the `.ontoindex/` directory and unregisters the repo from the global registry. Use before re-indexing if the index is corrupt or after removing OntoIndex from a project.

| Flag      | Effect                                            |
| --------- | ------------------------------------------------- |
| `--force` | Skip confirmation prompt                          |
| `--all`   | Clean all indexed repos, not just the current one |

### wiki — Generate documentation from the graph

```bash
npx ontoindex wiki
```

Generates repository documentation from the knowledge graph using an LLM. Requires an API key (saved to `~/.ontoindex/config.json` on first use).

| Flag                | Effect                                    |
| ------------------- | ----------------------------------------- |
| `--force`           | Force full regeneration                   |
| `--model <model>`   | LLM model (default: minimax/minimax-m2.5) |
| `--base-url <url>`  | LLM API base URL                          |
| `--api-key <key>`   | LLM API key                               |
| `--concurrency <n>` | Parallel LLM calls (default: 3)           |
| `--gist`            | Publish wiki as a public GitHub Gist      |

### list — Show all indexed repos

```bash
npx ontoindex list
```

Lists all repositories registered in `~/.ontoindex/registry.json`. The MCP `list_repos` tool provides the same information.

## After Indexing

1. **Read `ontoindex://repo/{name}/context`** to verify the index loaded
2. Use the other OntoIndex skills (`exploring`, `debugging`, `impact-analysis`, `refactoring`) for your task

## Stale-Index Recovery

When an OntoIndex query reports a stale index or cannot resolve a symbol that
exists in current source:

1. Preserve the blocked query and its arguments.
2. Check freshness with `gn_ensure_fresh`. If the index is current, return to
   the query instead of starting analysis.
3. Before refresh, inspect `.ontoindex/analyze.lock`. Never start a second
   analysis while its recorded PID is alive. Clear the lock only after proving
   that PID is dead.
4. Submit one background refresh with `gn_ensure_fresh(autoAnalyze=true)` and
   observe it with `gn_analyze_job`. For an Axel CLI refresh already running by
   PID and log, route monitoring through `axel-background-job-watch`.
5. Accept refresh only after the job exits successfully and
   `gn_ensure_fresh` reports the expected freshness state. Dirty-worktree
   freshness is valid only for claims checked against current source or diff.
6. Retry the blocked graph query once with its original arguments. Report the
   refresh evidence and keep unresolved results provisional.

Do not request embeddings unless the blocked operation requires semantic or
vector retrieval. Graph impact and traversal need only the normal index.

## Troubleshooting

- **"Not inside a git repository"**: Run from a directory inside a git repo
- **Index is stale after re-analyzing**: Restart Claude Code to reload the MCP server
- **Embeddings slow**: Omit `--embeddings` (it's off by default) or set `OPENAI_API_KEY` for faster API-based embedding

## Routine Tool Ownership

This skill owns routine-tool operation 39, `ONTOINDEX_FRESH_GATE`, in
`~/.ontocode/skills/ontocode-routine-tools/references/tool-catalog.md`. The gate
must verify commit/index/job/publication identity and fail closed before graph
queries when freshness cannot be proven. Return the coordinator's shared
envelope.
