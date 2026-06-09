# OntoIndex

**Graph-powered code intelligence for AI agents.** Index any codebase into a knowledge graph, then query it via MCP or CLI.

> Important: OntoIndex has no official cryptocurrency, token, or coin. Any token using the OntoIndex name is not affiliated with this project or its maintainers.

Works with **Cursor**, **Claude Code**, **Codex**, **Windsurf**, **Cline**, **OpenCode**, and any MCP-compatible tool.

[![npm version](https://img.shields.io/npm/v/ontoindex.svg)](https://www.npmjs.com/package/ontoindex)
[![License: AGPL-3.0-or-later](https://img.shields.io/badge/License-AGPL--3.0--or--later-blue.svg)](https://www.gnu.org/licenses/agpl-3.0.html)
[![GitHub](https://img.shields.io/badge/GitHub-ontograph%2Fontoindex-181717?logo=github)](https://github.com/ontograph/ontoindex)

- **Current release:** `1.9.1`
- **Repository:** [github.com/ontograph/ontoindex](https://github.com/ontograph/ontoindex)
- **Web UI:** [ontoindex.vercel.app](https://ontoindex.vercel.app)

---

## Why?

AI coding tools don't understand your codebase structure. They edit a function without knowing 47 other functions depend on it. OntoIndex fixes this by **precomputing every dependency, call chain, and relationship** into a queryable graph.

**Three commands to give your AI agent full codebase awareness.**

## Quick Start

```bash
# Index your repo (run from repo root)
npx ontoindex analyze

# Scope MCP setup to this repo by running setup here.
npx ontoindex setup
```

From a source checkout, install the latest GitHub release tarball with:

```bash
../scripts/install-ontoindex-latest.sh
```

That's it. This indexes the codebase, installs agent skills, registers Claude Code hooks, and creates `AGENTS.md` / `CLAUDE.md` context files — all in one command.

To configure MCP for your editor, run `npx ontoindex setup` once — or set it up manually below.

`ontoindex setup` auto-detects your editors and writes the correct global MCP config. You only need to run it once.

### Editor Support

| Editor | MCP | Skills | Hooks (auto-augment) | Support |
|--------|-----|--------|---------------------|---------|
| **Claude Code** | Yes | Yes | Yes (PreToolUse) | **Full** |
| **Cursor** | Yes | Yes | — | MCP + Skills |
| **Codex** | Yes | Yes | — | MCP + Skills |
| **Windsurf** | Yes | — | — | MCP |
| **OpenCode** | Yes | Yes | — | MCP + Skills |

> **Claude Code** gets the deepest integration: MCP tools + agent skills + PreToolUse hooks that automatically enrich grep/glob/bash calls with knowledge graph context.

### Community Integrations

| Agent | Install | Source |
|-------|---------|--------|
| [pi](https://pi.dev) | `pi install npm:pi-ontoindex` | [pi-ontoindex](https://github.com/tintinweb/pi-ontoindex) |

## MCP Setup (manual)

If you prefer to configure manually instead of using `ontoindex setup`:

### Claude Code (full support — MCP + skills + hooks)

```bash
# macOS / Linux
claude mcp add ontoindex -- npx -y ontoindex@latest mcp

# Windows
claude mcp add ontoindex -- cmd /c npx -y ontoindex@latest mcp
```

### Codex (full support — MCP + skills)

```bash
codex mcp add ontoindex -- npx -y ontoindex@latest mcp
```

### Cursor / Windsurf

Add to `~/.cursor/mcp.json` (global — works for all projects):

```json
{
  "mcpServers": {
    "ontoindex": {
      "command": "npx",
      "args": ["-y", "ontoindex@latest", "mcp"]
    }
  }
}
```

### OpenCode

Add to `~/.config/opencode/config.json`:

```json
{
  "mcp": {
    "ontoindex": {
      "command": "npx",
      "args": ["-y", "ontoindex@latest", "mcp"]
    }
  }
}
```

## How It Works

OntoIndex builds a complete knowledge graph of your codebase through a multi-phase indexing pipeline:

1. **Structure** — Walks the file tree and maps folder/file relationships
2. **Parsing** — Extracts functions, classes, methods, and interfaces using Tree-sitter ASTs
3. **Resolution** — Resolves imports and function calls across files with language-aware logic
   - **Field & Property Type Resolution** — Tracks field types across classes and interfaces for deep chain resolution (e.g., `user.address.city.getName()`)
   - **Return-Type-Aware Variable Binding** — Infers variable types from function return types, enabling accurate call-result binding
4. **Clustering** — Groups related symbols into functional communities
5. **Processes** — Traces execution flows from entry points through call chains
6. **Search** — Builds hybrid search indexes for fast retrieval

The result is a **LadybugDB graph database** stored locally in `.ontoindex/` with full-text search and semantic embeddings.

## MCP Tools

Your AI agent gets these tools automatically:

| Tool | What It Does | `repo` Param |
|------|-------------|--------------|
| `list_repos` | Discover all indexed repositories | — |
| `query` | Process-grouped hybrid search (BM25 + semantic + RRF) | Optional |
| `context` | 360-degree symbol view — categorized refs, process participation | Optional |
| `impact` | Blast radius analysis with depth grouping and confidence | Optional |
| `detect_changes` | Git-diff impact — maps changed lines to affected processes | Optional |
| `rename` | Multi-file coordinated rename with graph + text search | Optional |
| `cypher` | Raw Cypher graph queries | Optional |

> With one indexed repo, the `repo` param is optional. With multiple, specify which: `query({query: "auth", repo: "my-app"})`.

When MCP starts from a tool checkout, it uses `ONTOINDEX_MCP_PROJECT_CWD` (set by `setup`) as the target-project hint, and startup checks this against the selected repo target.
If the selected repo target does not match that project scope, startup fails loudly unless override is enabled.
For external helper checkouts (for example, `cwd=/opt/demodb/_workfolder/OntoIndex` while the target repo is `/opt/demodb/_workfolder/ontocode`), set setup and config against the target repo path:

```bash
cd /path/to/target/repo
ONTOINDEX_MCP_PROJECT_CWD=/path/to/target/repo ONTOINDEX_MCP_REPO=/path/to/target/repo ontoindex mcp
ONTOINDEX_MCP_PROJECT_CWD=/path/to/target/repo ONTOINDEX_MCP_REPO=/path/to/target/repo ontoindex mcp --repo my-target-repo
ONTOINDEX_MCP_ALLOW_REPO_MISMATCH=1 ontoindex mcp   # override when intentionally cross-repo
```

Full MCP tool examples live in the repository reference: [`../docs/reference/mcp.md`](../docs/reference/mcp.md).

## MCP Resources

| Resource | Purpose |
|----------|---------|
| `ontoindex://repos` | List all indexed repositories (read first) |
| `ontoindex://repo/{name}/context` | Codebase stats, staleness check, and available tools |
| `ontoindex://repo/{name}/clusters` | All functional clusters with cohesion scores |
| `ontoindex://repo/{name}/cluster/{name}` | Cluster members and details |
| `ontoindex://repo/{name}/processes` | All execution flows |
| `ontoindex://repo/{name}/process/{name}` | Full process trace with steps |
| `ontoindex://repo/{name}/schema` | Graph schema for Cypher queries |

## MCP Prompts

| Prompt | What It Does |
|--------|-------------|
| `detect_impact` | Pre-commit change analysis — scope, affected processes, risk level |
| `generate_map` | Architecture documentation from the knowledge graph with mermaid diagrams |

## CLI Commands

```bash
ontoindex setup                   # Configure MCP for your editors (one-time)
ontoindex analyze [path]          # Index a repository (or update stale index)
ontoindex analyze --force         # Force full re-index
ontoindex analyze --embeddings    # Enable embedding generation (slower, better search)
ontoindex analyze --skip-agents-md  # Preserve custom AGENTS.md/CLAUDE.md ontoindex section edits
ontoindex analyze --verbose       # Log skipped files when parsers are unavailable
ontoindex mcp                     # Start MCP server (stdio) — serves all indexed repos
ontoindex serve                   # Start local HTTP server (multi-repo) for web UI
ontoindex index                   # Register an existing .ontoindex/ folder into the global registry
ontoindex list                    # List all indexed repositories
ontoindex status                  # Show index status for current repo
ontoindex clean                   # Delete index for current repo
ontoindex clean --all --force     # Delete all indexes
ontoindex wiki [path]             # Generate LLM-powered docs from knowledge graph
ontoindex wiki --model <model>    # Wiki with custom LLM model (default: gpt-4o-mini)

# Repository groups (multi-repo / monorepo service tracking)
ontoindex group create <name>     # Create a repository group
ontoindex group add <name> <repo> # Add a repo to a group
ontoindex group remove <name> <repo> # Remove a repo from a group
ontoindex group list [name]       # List groups, or show one group's config
ontoindex group sync <name>       # Extract contracts and match across repos/services
ontoindex group contracts <name>  # Inspect extracted contracts and cross-links
ontoindex group query <name> <q>  # Search execution flows across all repos in a group
ontoindex group status <name>     # Check staleness of repos in a group
```

## Remote Embeddings

Set these env vars to use a remote OpenAI-compatible `/v1/embeddings` endpoint instead of the local model:

```bash
export ONTOINDEX_EMBEDDING_URL=http://your-server:8080/v1
export ONTOINDEX_EMBEDDING_MODEL=BAAI/bge-large-en-v1.5
export ONTOINDEX_EMBEDDING_DIMS=1024          # optional, default 384
export ONTOINDEX_EMBEDDING_API_KEY=your-key   # optional, default: "unused"
ontoindex analyze . --embeddings
```

Works with Infinity, vLLM, TEI, llama.cpp, Ollama, LM Studio, or OpenAI. When unset, local embeddings are used unchanged.

## Multi-Repo Support

OntoIndex supports indexing multiple repositories. Each `ontoindex analyze` registers the repo in a global registry (`~/.ontoindex/registry.json`). The MCP server serves all indexed repos automatically.

## Supported Languages

TypeScript, JavaScript, Python, Java, C, C++, C#, Go, Rust, PHP, Kotlin, Swift, Ruby

### Language Feature Matrix

| Language | Imports | Named Bindings | Exports | Heritage | Type Annotations | Constructor Inference | Config | Frameworks | Entry Points |
|----------|---------|----------------|---------|----------|-----------------|---------------------|--------|------------|-------------|
| TypeScript | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| JavaScript | ✓ | ✓ | ✓ | ✓ | — | ✓ | ✓ | ✓ | ✓ |
| Python | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Java | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | — | ✓ | ✓ |
| Kotlin | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | — | ✓ | ✓ |
| C# | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Go | ✓ | — | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Rust | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | — | ✓ | ✓ |
| PHP | ✓ | ✓ | ✓ | — | ✓ | ✓ | ✓ | ✓ | ✓ |
| Ruby | ✓ | — | ✓ | ✓ | — | ✓ | — | ✓ | ✓ |
| Swift | — | — | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| C | — | — | ✓ | — | ✓ | ✓ | — | ✓ | ✓ |
| C++ | — | — | ✓ | ✓ | ✓ | ✓ | — | ✓ | ✓ |

**Imports** — cross-file import resolution · **Named Bindings** — `import { X as Y }` / re-export tracking · **Exports** — public/exported symbol detection · **Heritage** — class inheritance, interfaces, mixins · **Type Annotations** — explicit type extraction for receiver resolution · **Constructor Inference** — infer receiver type from constructor calls (`self`/`this` resolution included for all languages) · **Config** — language toolchain config parsing (tsconfig, go.mod, etc.) · **Frameworks** — AST-based framework pattern detection · **Entry Points** — entry point scoring heuristics

## Agent Skills

OntoIndex ships with skill files that teach AI agents how to use the tools effectively:

- **Exploring** — Navigate unfamiliar code using the knowledge graph
- **Debugging** — Trace bugs through call chains
- **Impact Analysis** — Analyze blast radius before changes
- **Refactoring** — Plan safe refactors using dependency mapping

Installed automatically by both `ontoindex analyze` (per-repo) and `ontoindex setup` (global).

## Requirements

- Node.js >= 20
- Git repository (uses git for commit tracking)

## Release candidates

Stable releases publish to the default `latest` dist-tag. When a pull request
with non-documentation changes merges into `master`, an automated workflow also
publishes a prerelease build under the `rc` dist-tag, so early adopters can
try in-flight fixes without waiting for the next stable cut. (Docs-only
merges are skipped.)

```bash
# Try the latest release candidate (pre-stable — may change at any time)
npm install -g ontoindex@rc
# — or —
npx ontoindex@rc analyze
```

Release-candidate versions follow the standard semver prerelease format
`X.Y.Z-rc.N`, where `X.Y.Z` is the next stable target (bumped from the
current `latest` by patch by default; `minor` or `major` when kicking off a
bigger cycle) and `N` increments per published rc. Example sequence:
`1.9.1-rc.1`, `1.9.1-rc.2`, …, then once `1.9.1` ships stable, the next patch-cycle starts at
`1.9.2-rc.1` (or `1.10.0-rc.1` for a minor/bigger cycle). See the [Releases page](https://github.com/ontograph/ontoindex/releases)
for the full list; stable `latest` is unaffected.

## Troubleshooting

### `Cannot destructure property 'package' of 'node.target' as it is null`

This crash was caused by a dependency URL format that is incompatible with
certain npm/arborist versions ([npm/cli#8126](https://github.com/npm/cli/issues/8126)).
It is fixed in **ontoindex v1.9.0+**. Upgrade to the latest version:

```bash
npx ontoindex@latest analyze          # always uses the newest release
# — or —
npm install -g ontoindex@latest       # upgrade a global install
```

If you still hit npm install issues after upgrading, these generic workarounds
may help:

```bash
npm install -g npm@latest            # update npm itself
npm cache clean --force              # clear a possibly corrupt cache
```

### Optional native grammar build warnings

Some optional language grammars (Dart, Kotlin, Swift, Proto) require native
compilation. If an optional grammar fails to build, OntoIndex still installs and
continues to work; only that language's parsing support is skipped.

Local native build requirements:

- Node.js 20 or newer
- npm with install scripts enabled
- Python 3
- `make`
- a C/C++ compiler (`g++` on Linux, Xcode command line tools on macOS)

If optional grammar build warnings appear:

```bash
# Ubuntu/Debian: sudo apt install python3 make g++
# macOS: xcode-select --install

npm install -g ontoindex
```

### Analysis runs out of memory

For very large repositories:

```bash
# Increase Node.js heap size
NODE_OPTIONS="--max-old-space-size=16384" npx ontoindex analyze

# Exclude large directories
echo "vendor/" >> .ontoindexignore
echo "dist/" >> .ontoindexignore
```

## Privacy

- All processing happens locally on your machine
- No code is sent to any server
- Index stored in `.ontoindex/` inside your repo (gitignored)
- Global registry at `~/.ontoindex/` stores only paths and metadata

## Web UI

OntoIndex also has a browser-based UI at [ontoindex.vercel.app](https://ontoindex.vercel.app) — 100% client-side, your code never leaves the browser.

**Local Backend Mode:** Run `ontoindex serve` and open the web UI locally — it auto-detects the server and shows all your indexed repos, with full AI chat support. No need to re-upload or re-index. The agent's tools (Cypher queries, search, code navigation) route through the backend HTTP API automatically.

## License

[GNU Affero General Public License v3.0 or later](https://www.gnu.org/licenses/agpl-3.0.html)
