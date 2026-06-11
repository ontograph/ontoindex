# OntoIndex Wiki Overview

Generated: 2026-06-10

Source repository: `/opt/demodb/_workfolder/OntoIndex`

Indexed commit: `022098e3332bc94da85ce3dbb6a2523f0b7c4cb1`

Index snapshot:

- Files: 1,490
- Symbols: 34,983
- Relationships: 52,219
- Clusters: 1,224
- Execution flows: 300
- Package version: `ontoindex@1.9.3`
- License: `AGPL-3.0-or-later`

## Purpose

OntoIndex is a graph-powered code intelligence system for AI agents. It indexes repositories into a local graph, exposes that graph through CLI, MCP, and HTTP APIs, and provides higher-level workflows for exploration, impact analysis, audit, refactoring safety, and release review.

## Repository Layout

| Path | Role |
| --- | --- |
| `ontoindex/` | TypeScript CLI, indexing pipeline, graph storage, MCP server, HTTP API, audit and search logic. |
| `ontoindex-web/` | React/Vite graph UI and operational frontend. |
| `ontoindex-shared/` | Shared TypeScript contracts and constants used by CLI/core and web. |
| `ontoindex-native/` | Optional Rust/N-API acceleration for graph and import extraction paths. |
| `ontoindex-packs/` | Analysis packs and suite definitions. |
| `ontoindex-claude-plugin/` | Claude integration packaging. |
| `ontoindex-cursor-integration/` | Cursor integration packaging. |
| `eval/` | Python evaluation harness. |
| `docs/adr/` | Architecture decision records and implementation frontier docs. |

## Main Runtime Surfaces

- CLI binary: `ontoindex/dist/cli/index.js`
- MCP stdio server: `ontoindex mcp`
- HTTP API server: `ontoindex serve`
- Web UI: `ontoindex-web`
- Generated wiki output: `.ontoindex/wiki/`

## How To Read This Wiki

Start with the CLI and indexing page to understand how repository facts enter the graph. Then read the MCP runtime page for the agent-facing API surface, the HTTP/Web UI page for browser-facing flows, and the audit/safety page for release gates.
