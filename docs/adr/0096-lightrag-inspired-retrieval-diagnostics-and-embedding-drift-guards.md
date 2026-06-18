# ADR 0096: LightRAG-Inspired Retrieval Diagnostics And Embedding Drift Guards

Status: Proposed - narrowed
Date: 2026-06-17
Source reviewed: `./tmp/LightRAG`

## Decision

Extend existing OntoIndex retrieval and health checks with two small capabilities:

1. opt-in retrieval diagnostics for existing `search` / `gn_explore` paths;
2. embedding configuration drift reporting in existing `gn_diagnose` / `gn_ensure_fresh` paths.

Do not add a RAG server, new storage backend, chat API, provider framework, or new MCP tool family.

## Architecture Fit Gate

### Real New Functionality

Approved:

- explain which existing retrieval lanes contributed to a result;
- report missing, stale, or incompatible embedding state more precisely than `embeddings: absent`;
- add one LLM-free regression fixture that checks expected anchors still appear for an architecture query.

Rejected:

- copying LightRAG query modes as a user-facing chat surface;
- RAG answer generation;
- external vector or graph stores;
- multimodal/VLM ingestion;
- LLM-graded RAGAS evaluation;
- docs chunk rewriting.

### Core Extension

This ADR extends existing owners only:

- `ontoindex/src/core/search/semantic-frontier-search.ts`
- `ontoindex/src/core/search/semantic-frontier-adapter.ts`
- `ontoindex/src/core/search/retrieval-context-composition.ts`
- `ontoindex/src/core/ingestion/enrichment/markdown-docs-code-eval.ts`
- `ontoindex/src/mcp/super/diagnose.ts`
- `ontoindex/src/mcp/super/ensure-fresh.ts`
- `ontoindex/src/mcp/super/explore.ts`

OntoIndex MCP exploration confirmed these are the current relevant owners. No parallel subsystem is approved.

## Why This Is Worth Doing

Today an agent can see a result but not cheaply tell whether it came from graph structure, vector similarity, docs evidence, or fallback lexical search. When embeddings are missing or misconfigured, the current health signal is too coarse for repair automation.

LightRAG's useful idea is not its RAG stack. The useful idea is mode observability: retrieval should say what path produced the evidence and whether the indexed vector state still matches runtime configuration.

## First Slice

### Retrieval Diagnostics

Add an opt-in diagnostic block to existing search/explore responses.

Example shape:

```ts
type RetrievalDiagnostics = {
  lanes: Array<{
    name: "lexical" | "vector" | "graph" | "docs" | "rerank";
    candidateCount: number;
    emittedCount: number;
    warnings: string[];
  }>;
  overlap: {
    sharedAnchors: number;
    graphOnly: number;
    vectorOnly: number;
    docsOnly: number;
  };
};
```

Rules:

- default responses stay unchanged;
- diagnostics are bounded and summary-first;
- no new public MCP tool is required;
- if a lane is unavailable, report why instead of hiding it.

### Embedding Drift Guard

Record and compare an embedding fingerprint when embeddings are created:

- provider;
- model;
- vector dimension;
- index format version;
- query/document prefix settings if present.

Expose status through `gn_diagnose` and `gn_ensure_fresh`:

- `ok`;
- `missing`;
- `metadata-unavailable`;
- `drifted`.

For `drifted`, return the exact local repair command.

### Retrieval Fixture

Add one LLM-free test fixture:

```json
{
  "query": "MCP repo resolution without env harness",
  "expectedAnchors": [
    "docs/adr/0085-mcp-repo-resolution-without-env-harness.md",
    "ontoindex/src/mcp/shared/target-context.ts"
  ]
}
```

The test should assert anchor presence within a bounded result set, not exact ranking.

## Postponed

Docs chunk boundary diagnostics are postponed. They are only allowed later if the existing docs sidecar already exposes reliable chunk spans. Do not add a new Markdown parser for this ADR.

## Acceptance Criteria

- No new dependency.
- No new daemon.
- No new database/table family unless existing metadata storage already needs a small field.
- No default response-shape change.
- `gn_diagnose` distinguishes missing embeddings from drifted embeddings.
- One retrieval fixture fails if expected anchors disappear.
- Tests cover the new diagnostic status logic.

## Non-Goals

- Replace OntoIndex retrieval with LightRAG.
- Add chat or answer synthesis.
- Add external storage adapters.
- Add multimodal parsing.
- Add LLM-based evaluation.
- Add another wiki or web surface.

