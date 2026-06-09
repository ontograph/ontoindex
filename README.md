# OntoIndex

**Graph-powered code intelligence for AI agents.** OntoIndex indexes a codebase into a local knowledge graph, then exposes precise code search, symbol context, blast-radius analysis, review helpers, and multi-repo navigation through the Model Context Protocol (MCP), CLI, and web UI.

> Important: OntoIndex has no official cryptocurrency, token, or coin. Any token using the OntoIndex name is not affiliated with this project or its maintainers.

[![npm version](https://img.shields.io/npm/v/ontoindex.svg)](https://www.npmjs.com/package/ontoindex)
[![License: AGPL-3.0-or-later](https://img.shields.io/badge/License-AGPL--3.0--or--later-blue.svg)](https://www.gnu.org/licenses/agpl-3.0.html)
[![GitHub](https://img.shields.io/badge/GitHub-ontograph%2Fontoindex-181717?logo=github)](https://github.com/ontograph/ontoindex)

- **Current release:** `1.9.0`
- **npm:** [ontoindex](https://www.npmjs.com/package/ontoindex)
- **Repository:** [github.com/ontograph/ontoindex](https://github.com/ontograph/ontoindex)
- **Web UI:** [ontoindex.vercel.app](https://ontoindex.vercel.app)
- **Enterprise:** [akonlabs.com](https://akonlabs.com)
- **Community:** [Discord](https://discord.gg/MgJrmsqr62)

## Why OntoIndex

AI coding agents are fast, but they often operate from partial file snippets. They can rename a function without seeing downstream callers, edit a service without understanding cross-file routes, or miss architectural coupling hidden outside the prompt.

OntoIndex gives agents a precomputed graph of the repository:

- **Symbols:** functions, classes, methods, interfaces, files, communities
- **Relations:** imports, calls, inheritance, implementation, membership, execution flow
- **Search:** BM25, semantic retrieval, reciprocal-rank fusion, typed queries
- **Safety:** impact analysis, diff-to-symbol mapping, review reports, audit workflows
- **Local-first:** indexes live in `.ontoindex/`; the MCP server reads local graph data

The result is a smaller, more reliable context surface: agents ask the graph instead of repeatedly scanning the tree.

## Quick Start

```bash
# Run from the repository you want to index.
npx -y ontoindex@1.9.0 analyze

# Configure MCP clients once.
npx -y ontoindex@1.9.0 setup

# Start the MCP server manually when needed.
npx -y ontoindex@1.9.0 mcp
```

If you run `ontoindex setup` or `ontoindex mcp` from a helper checkout (for example, a global Codex/Claude installation), set the target project hint explicitly so startup can validate selection against the intended repo:

```bash
cd /path/to/target/repo
ONTOINDEX_MCP_PROJECT_CWD=/path/to/target/repo ONTOINDEX_MCP_REPO=/path/to/target/repo npx -y ontoindex@1.9.0 setup

ONTOINDEX_MCP_PROJECT_CWD=/path/to/target/repo ONTOINDEX_MCP_REPO=/path/to/target/repo npx -y ontoindex@1.9.0 mcp --repo my-project
```

Startup prints both the executable cwd and project path, and will error loudly when `ONTOINDEX_MCP_REPO` or `--repo` points outside the configured `ONTOINDEX_MCP_PROJECT_CWD` unless `ONTOINDEX_MCP_ALLOW_REPO_MISMATCH=1`.

For the browser UI:

```bash
npx -y ontoindex@1.9.0 serve
```

Then open [ontoindex.vercel.app](https://ontoindex.vercel.app). The UI detects the local backend at `http://localhost:4747` and can browse indexed repositories without uploading code.

## MCP Setup

`ontoindex setup` configures supported MCP clients automatically. Manual examples:

### Claude Code

```bash
claude mcp add ontoindex -- npx -y ontoindex@1.9.0 mcp
```

### Codex

```bash
codex mcp add ontoindex -- npx -y ontoindex@1.9.0 mcp
```

### Cursor

Add this to `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "ontoindex": {
      "command": "npx",
      "args": ["-y", "ontoindex@1.9.0", "mcp"]
    }
  }
}
```

### OpenCode

Add this to `~/.config/opencode/config.json`:

```json
{
  "mcp": {
    "ontoindex": {
      "type": "local",
      "command": ["npx", "-y", "ontoindex@1.9.0", "mcp"]
    }
  }
}
```

## Editor Support

| Client | MCP | Skills | Hooks | Notes |
| --- | --- | --- | --- | --- |
| Claude Code | Yes | Yes | Yes | Deepest integration: MCP tools, generated skills, and optional hooks |
| Cursor | Yes | Yes | No | Global MCP config works across projects |
| Codex | Yes | Yes | No | Use `codex mcp add` or `.codex/config.toml` |
| Windsurf | Yes | No | No | Standard MCP server connection |
| OpenCode | Yes | Yes | No | Standard local MCP process |
| Any MCP client | Yes | Client-dependent | Client-dependent | Uses the stdio MCP server |

## How OntoIndex Compares

This table compares public code-graph or code-navigation MCP projects by their documented positioning. Capabilities change quickly, so treat this as a practical selection guide rather than a benchmark.

| Project | Best Fit | Graph / Storage Model | MCP Surface | Where OntoIndex Differs |
| --- | --- | --- | --- | --- |
| **OntoIndex** | Local-first repository and multi-repo code intelligence for coding agents | LadybugDB graph stored per repo, global registry, optional embeddings, communities, execution flows | Search, context, impact, diff review, rename, docs, audit, systems-audit, resources, prompts | Combines code graph, process traces, blast-radius analysis, review/audit workflows, web bridge, generated skills, and local package distribution |
| [CodeGPT Deep Graph MCP](https://github.com/JudiniLabs/mcp-code-graph) | Querying CodeGPT / DeepGraph-hosted repository graphs | Graphs available through CodeGPT account or public DeepGraph URLs | Graph listing, code retrieval, direct connection exploration | OntoIndex is local-first and does not require a hosted graph account for indexing or MCP use |
| [code-graph-mcp](https://github.com/sdsrss/code-graph-mcp) | AST knowledge graph for Claude Code with semantic search, call graph traversal, route tracing | Tree-sitter AST graph, language tiers, local MCP server | Semantic search, call graph traversal, HTTP route tracing, impact analysis | OntoIndex adds multi-repo registry, graph resources, generated skills, audit/docs workflows, web UI bridge, and package release workflow |
| [Codegraph](https://github.com/optave/codegraph) | Function-level dependency graph, impact analysis, complexity metrics, hybrid search | Local SQLite-backed graph with Tree-sitter parsing | Broad MCP toolset for graph queries and metrics | OntoIndex emphasizes agent-ready higher-level workflows: process-grouped search, safe rename, diff review, audit lifecycle, and docs evidence |
| [Codesteward](https://codesteward.ai/docs) | Structural graph server with multiple graph backend options | Tree-sitter graph with Neo4j, JanusGraph, or embedded GraphQLite-style backend options | Rebuild, query, augment, status; optional taint-style analysis | OntoIndex ships a fixed local embedded graph path by default, reducing backend setup for local agent workflows |
| [Hex Graph MCP](https://vibehackers.io/mcp/hex-graph-mcp) | Deterministic layered code graph with framework overlays and SCIP interop | SQLite-backed graph, incremental hashing, overlays, SCIP import/export | Symbol navigation, dependency/dataflow tracing, architecture and workspace audit tools | OntoIndex focuses on LadybugDB graph queries, execution-flow/process grouping, generated repo skills, and browser bridge integration |
| [Graphiti MCP](https://github.com/getzep/graphiti/blob/main/mcp_server/README.md) | Temporal knowledge graph memory over facts and events | Neo4j-backed temporal knowledge graph | Entity/relationship graph operations through MCP | Graphiti is a general temporal KG; OntoIndex is specialized for source-code structure, call relationships, diffs, and repository workflows |
| [Serena](https://github.com/oraios/serena) | Symbolic code navigation and editing through language-server style operations | Project memories plus language-server symbol access | Symbol lookup, references, edits, memory-oriented workflows | Serena is excellent for IDE-like symbolic operations; OntoIndex precomputes a persistent graph for impact, process, community, and cross-repo analysis |

## What the Agent Gets

Core MCP tools:

| Tool | Purpose |
| --- | --- |
| `list_repos` | Discover indexed repositories |
| `query` | Process-grouped hybrid search |
| `context` | Symbol-centric callers, callees, references, and process participation |
| `impact` | Blast-radius analysis before edits |
| `detect_changes` | Map Git diff hunks to affected symbols and execution flows |
| `rename` | Coordinated multi-file rename with graph and text-search evidence |
| `cypher` | Raw graph queries for advanced users |

Higher-level surfaces:

- **Docs:** requirement tracing, docs drift, docs context, readiness reports
- **Review:** graph-aware diff review and pre-commit audit
- **Audit lifecycle:** ingest, verify, lint, bundle, and dispatch audit findings
- **Systems audit:** resource tracing, path verification, test suggestions, taint-style heuristics
- **Resources:** `ontoindex://repos`, repo context, clusters, processes, schema, memories, onboarding
- **Generated skills:** repository-specific `.claude/skills/generated/*/SKILL.md` files with module-level context

## Functional Architecture

OntoIndex has three runtime entry points over the same local graph backend:

```mermaid
flowchart LR
  Repo[Source repository] --> Analyze[CLI analyze pipeline]
  Analyze --> Graph[.ontoindex LadybugDB graph]
  Analyze --> Registry[~/.ontoindex registry]

  Graph --> Backend[LocalBackend]
  Registry --> Backend

  Backend --> MCP[MCP stdio server]
  Backend --> HTTP[HTTP bridge: ontoindex serve]
  Backend --> CLI[Direct CLI tools]

  MCP --> Agents[Claude Code / Cursor / Codex / OpenCode / MCP clients]
  HTTP --> Web[OntoIndex Web UI]
```

| Component | Code | Responsibility |
| --- | --- | --- |
| CLI command layer | [`ontoindex/src/cli/`](ontoindex/src/cli/) | User-facing commands: `analyze`, `mcp`, `serve`, `query`, `impact`, `review`, `docs`, `audit`, `group` |
| Ingestion pipeline | [`ontoindex/src/core/ingestion/`](ontoindex/src/core/ingestion/) | File walk, Tree-sitter parsing, import/call/type/heritage resolution, route/tool/ORM extraction |
| Pipeline phase DAG | [`ontoindex/src/core/ingestion/pipeline-phases/`](ontoindex/src/core/ingestion/pipeline-phases/) | Ordered graph build phases: scan, structure, markdown, parse, routes, tools, ORM, cross-file, MRO, communities, processes |
| Graph storage | [`ontoindex/src/core/lbug/`](ontoindex/src/core/lbug/) | LadybugDB schema, graph loading, query execution, embedding persistence |
| Repository registry | [`ontoindex/src/storage/`](ontoindex/src/storage/) | `.ontoindex/` metadata, global `~/.ontoindex/registry.json`, stale-index checks |
| Search and ranking | [`ontoindex/src/core/search/`](ontoindex/src/core/search/) | BM25, semantic retrieval, intent routing, Reciprocal Rank Fusion, repomap context |
| Embeddings | [`ontoindex/src/core/embeddings/`](ontoindex/src/core/embeddings/) | Optional local embedding generation and incremental embedding reuse |
| MCP backend | [`ontoindex/src/mcp/`](ontoindex/src/mcp/) | MCP server, resources, facade tools, `gn_*` super-functions, local backend dispatch |
| HTTP backend | [`ontoindex/src/server/`](ontoindex/src/server/) | Express API used by the browser UI and local bridge mode |
| Web UI | [`ontoindex-web/src/`](ontoindex-web/src/) | Graph explorer, repository browser, local backend connection, AI chat UI |
| Shared contracts | [`ontoindex-shared/src/`](ontoindex-shared/src/) | Shared language IDs, API types, and client/server constants |
| Native helpers | [`ontoindex-native/`](ontoindex-native/) | Optional native acceleration and extraction helpers |
| Agent integration assets | [`ontoindex-claude-plugin/`](ontoindex-claude-plugin/), [`ontoindex-cursor-integration/`](ontoindex-cursor-integration/) | Skills, hooks, and editor-specific packaging |
| Evaluation harness | [`eval/`](eval/) | Benchmarks and agent/tool evaluation workflows |

### Data Model

The graph is stored in `.ontoindex/` inside each indexed repository. A global registry under `~/.ontoindex/` lets one MCP server serve many repositories.

| Graph entity | Examples |
| --- | --- |
| Nodes | `File`, `Folder`, `Function`, `Class`, `Interface`, `Method`, `Property`, `Community`, `Process`, `Route`, `Tool`, `Section`, `Embedding` |
| Relations | `CONTAINS`, `DEFINES`, `CALLS`, `IMPORTS`, `EXTENDS`, `IMPLEMENTS`, `HAS_METHOD`, `HAS_PROPERTY`, `ACCESSES`, `MEMBER_OF`, `STEP_IN_PROCESS`, `HANDLES_ROUTE`, `HANDLES_TOOL` |
| Derived structures | Functional communities, execution processes, route maps, tool maps, contract bridges, markdown/doc evidence, advisory memories |

### Request Flow

| Request | Flow |
| --- | --- |
| `ontoindex analyze` | CLI scans the repository, runs the ingestion DAG, writes LadybugDB tables, saves metadata, and registers the repo globally |
| MCP `search` / `query` | Agent calls MCP stdio server, `LocalBackend` opens the indexed repo, search combines BM25/vector/graph signals, response is grouped by process |
| MCP `impact` / `gn_safe_edit_check` | Backend resolves a symbol or diff, traverses upstream/downstream graph edges, adds process/test/co-change evidence, and returns a risk verdict |
| `ontoindex serve` + web UI | HTTP server exposes the same backend to the browser UI, so large repos use local indexes instead of browser-only memory |
| Multi-repo groups | Group config links multiple indexed repos; contract extraction and cross-impact use service boundaries and exported contracts |

For implementation details, see [ARCHITECTURE.md](ARCHITECTURE.md).

## CLI Commands

```bash
ontoindex setup                         # Configure MCP clients
ontoindex analyze [path]                # Index a repository
ontoindex analyze --force               # Full re-index
ontoindex analyze --skills              # Generate repo-specific skills
ontoindex analyze --embeddings          # Enable semantic embeddings
ontoindex index [path...]               # Register existing .ontoindex folders
ontoindex serve                         # Start local HTTP backend for web UI
ontoindex mcp                           # Start stdio MCP server
ontoindex list                          # List indexed repositories
ontoindex status                        # Show current repo index status
ontoindex clean                         # Delete current repo index
ontoindex wiki [path]                   # Generate repo wiki from graph
ontoindex query "authentication flow"   # Search execution flows and symbols
ontoindex context validateUser          # Callers, callees, refs, processes
ontoindex impact validateUser           # Blast-radius analysis
ontoindex detect-changes                # Analyze current Git diff
ontoindex cypher "MATCH (n) RETURN n LIMIT 5"
ontoindex review diff                   # Graph-aware local diff review
ontoindex audit                         # Structured audit report
ontoindex docs readiness                # Docs evidence readiness
ontoindex group create <name>           # Multi-repo group
ontoindex group sync <name>             # Cross-repo contract extraction
```

Run `ontoindex --help` or `ontoindex <command> --help` for the full command surface.

## Indexing Pipeline

OntoIndex builds the graph through a typed phase DAG:

```text
scan -> structure -> [markdown, cobol] -> parse -> [routes, tools, orm]
  -> crossFile -> mro -> communities -> processes
```

The key functional steps are:

1. **Scan and structure:** walk files, apply repository ignore policy, create folder/file nodes.
2. **Parse:** run Tree-sitter providers in worker threads or sequential fallback, extracting unified symbols and captures.
3. **Resolve:** connect imports, calls, receivers, constructor inference, type hints, heritage, and method-resolution-order edges.
4. **Enrich graph:** extract routes, MCP/RPC tools, ORM queries, markdown sections, docs evidence, communities, and execution processes.
5. **Persist:** load nodes and `CodeRelation` edges into LadybugDB, create text indexes, reuse or generate embeddings.
6. **Expose:** serve the graph through CLI commands, MCP tools/resources, HTTP bridge APIs, and the web UI.

Supported language coverage includes TypeScript, JavaScript, Python, Java, Kotlin, C#, Go, Rust, PHP, Ruby, Swift, C, C++, Dart, and protobuf-related parser support. Depth varies by language, but the core model is consistent: symbols, files, relationships, communities, and execution flows.

## Repository Layout

| Path | Purpose |
| --- | --- |
| [`ontoindex/`](ontoindex/) | CLI, indexing pipeline, MCP server, graph logic |
| [`ontoindex-web/`](ontoindex-web/) | React/Vite web UI |
| [`ontoindex-shared/`](ontoindex-shared/) | Shared TypeScript types/constants |
| [`ontoindex-native/`](ontoindex-native/) | Optional native helpers |
| [`ontoindex-claude-plugin/`](ontoindex-claude-plugin/) | Claude integration assets |
| [`ontoindex-cursor-integration/`](ontoindex-cursor-integration/) | Cursor integration assets |
| [`eval/`](eval/) | Evaluation harness |
| [`docs/`](docs/) | ADRs, guides, code-indexing notes |

## Development

```bash
cd ontoindex
npm install
npm run build
npm run test:unit
```

Useful docs:

- [ARCHITECTURE.md](ARCHITECTURE.md)
- [RUNBOOK.md](RUNBOOK.md)
- [GUARDRAILS.md](GUARDRAILS.md)
- [CONTRIBUTING.md](CONTRIBUTING.md)
- [TESTING.md](TESTING.md)
- [docs/adr/0000-index.md](docs/adr/0000-index.md)

## Web UI

Use the hosted UI at [ontoindex.vercel.app](https://ontoindex.vercel.app), or run it locally:

```bash
cd ontoindex-shared && npm install && npm run build
cd ../ontoindex-web && npm install && npm run dev
```

The browser-only mode can inspect uploaded ZIPs in memory. For larger repositories, run `ontoindex serve` and let the UI connect to the local backend.

## Docker

```bash
docker compose up -d
```

Images:

| Image | Purpose |
| --- | --- |
| `ghcr.io/ontograph/ontoindex:1.9.0` | CLI, MCP, and `ontoindex serve` backend |
| `ghcr.io/ontograph/ontoindex-web:1.9.0` | Web UI |

The compose stack exposes:

- Backend: `http://localhost:4747`
- Web UI: `http://localhost:4173`

## Release Integrity

Stable Docker images are intended to match npm package versions. For `1.9.0`:

```bash
cosign verify ghcr.io/ontograph/ontoindex:1.9.0 \
  --certificate-identity-regexp '^https://github\.com/ontograph/ontoindex/\.github/workflows/docker\.yml@refs/tags/v[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.]+)?$' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

Kubernetes policy example:

- [deploy/kubernetes/cluster-image-policy.yaml](deploy/kubernetes/cluster-image-policy.yaml)

## Security And Privacy

- CLI/MCP indexing is local by default.
- Repository indexes are stored in `.ontoindex/`.
- The global registry stores repository paths and metadata under the user profile.
- Browser-only mode keeps code in the browser session.
- Enterprise deployments can be self-hosted.

Report security issues through [SECURITY.md](SECURITY.md).

## Community Integrations

| Project | Description |
| --- | --- |
| [pi-ontoindex](https://github.com/tintinweb/pi-ontoindex) | OntoIndex plugin for [pi](https://pi.dev) |
| [ontoindex-stable-ops](https://github.com/ShunsukeHayashi/ontoindex-stable-ops) | Stable ops and deployment workflows |

Open a pull request to add maintained integrations.

## Source And Donor Acknowledgments

OntoIndex includes code originally developed as **GitNexus**. Copyright and attribution for GitNexus contributors are preserved in [NOTICE](NOTICE).

The project also builds on open source components and donated ecosystem work from upstream maintainers, including:

- [Model Context Protocol](https://modelcontextprotocol.io/)
- [Tree-sitter](https://tree-sitter.github.io/tree-sitter/)
- [LadybugDB](https://ladybugdb.com/)
- [Graphology](https://graphology.github.io/)
- [Sigma.js](https://www.sigmajs.org/)
- [Transformers.js](https://huggingface.co/docs/transformers.js)

See [NOTICE](NOTICE) for preserved attribution and third-party component notices.

## License

AGPL-3.0-or-later. See [LICENSE](LICENSE).
