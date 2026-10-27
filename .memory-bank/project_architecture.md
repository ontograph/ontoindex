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

Scope resolution keeps three owners: `finalize-orchestrator.ts` builds finalized
indexes and a separate registry context; `resolve-references.ts` materializes
singleton free-call, identifier-read and Class constructor references into the
shared two-way `ReferenceIndex`;
`emit-references.ts` converts resolved references into graph edges. The bounded
materializer reports unresolved, ambiguous and unsupported sites separately.
Production pipeline activation remains gated on capture completeness.

[Type/value namespace decision](ADR_TYPE_VALUE_NAMESPACES.md): binding metadata
belongs to shared scope types; lexical filtering belongs to lookup-core and
resolve-type-ref; strict retention belongs to parse-scope-codec. Import/export
propagation and qualified access remain prerequisites before provider activation.
