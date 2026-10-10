---
name: OntoIndex Architecture
description: Owner map and change-home rules
type: project
---

# OntoIndex Architecture

Canonical description: [`../ARCHITECTURE.md`](../ARCHITECTURE.md). Update this file when an owner, flow, or change-home rule changes.

| Path | Role |
| --- | --- |
| `ontoindex/` | CLI, MCP server, HTTP API, ingestion pipeline, graph, embeddings |
| `ontoindex-web/` | Vite + React client over `ontoindex serve` |
| `ontoindex-shared/` | Shared TypeScript types and constants |
