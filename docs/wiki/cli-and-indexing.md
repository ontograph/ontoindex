# CLI And Indexing

## Entry Points

The CLI package is `ontoindex`, published from `ontoindex/package.json` with the executable:

```text
ontoindex -> dist/cli/index.js
```

Important commands:

| Command | Purpose |
| --- | --- |
| `analyze` | Build or refresh the repository graph. |
| `status` | Report index commit, current commit, and freshness. |
| `mcp` | Start the MCP stdio server for agents. |
| `serve` | Start the HTTP API for the web UI and integrations. |
| `setup` | Configure supported MCP clients and agent skills. |
| `wiki` | Legacy wiki generator. Requires an LLM provider. |

## Indexing Pipeline

The analyzer reads repository files, parses language-specific syntax with tree-sitter where supported, extracts symbols and relationships, and writes the graph to `.ontoindex/`.

Current parser stack includes TypeScript/JavaScript, Python, Go, Java, C/C++, C#, Rust, Ruby, PHP, Swift, Kotlin, Dart, and Proto-related support through tree-sitter packages and local vendor code.

Key directories:

| Path | Responsibility |
| --- | --- |
| `ontoindex/src/cli/` | CLI command definitions and command orchestration. |
| `ontoindex/src/core/ingestion/` | Parse and ingestion pipeline. |
| `ontoindex/src/core/tree-sitter/` | Parser loading and grammar compatibility. |
| `ontoindex/src/core/group/` | Route, gRPC, bridge, and framework extraction helpers. |
| `ontoindex/src/storage/` | Repository manager and git/storage adapters. |
| `ontoindex/src/native/` | Optional native adapters and fallbacks. |

## Current Index State

The self repository was indexed as `OntoIndex`:

```text
Repository: /opt/demodb/_workfolder/OntoIndex
Indexed commit: 022098e3332bc94da85ce3dbb6a2523f0b7c4cb1
Status: up to date
Symbols: 34,983
Edges: 52,219
Flows: 300
```

## Operational Notes

- Use `ONTOINDEX_MAX_WORKERS=7` on this host to respect the configured 25% CPU cap.
- The native graph writer is optional; current status reports it disabled/unavailable unless `ONTOINDEX_NATIVE_GRAPH_WRITER` is configured.
- Some tree-sitter parser packages may emit Node deprecation warnings after dependency upgrades; these do not block indexing.
