# ADR 0092: Harness-1-Inspired Evidence Trajectory And Context Pruning

**Status:** Proposed - Challenged And Narrowed
**Date:** 2026-06-17
**Source:** `./tmp/harness-1` donor review, challenged with OntoIndex MCP against current
`recordEvidenceReadSafe`, `createQueryBudgetSnapshot`, `gnReviewDiff`, response-envelope, and
docs-evidence owners.

## Context

Harness-1 is a stateful retrieval agent. Its useful idea for OntoIndex is not the model, RL training,
vLLM serving, or dataset pipeline. The useful idea is a recoverable search trajectory: actions,
observations, candidate evidence, curated evidence, verification records, and budget-aware pruning.

OntoIndex already has the right primitives:

- evidence-read ledger in `ontoindex/src/core/runtime/evidence-read-ledger.ts`;
- query budget snapshots in `ontoindex/src/core/runtime/query-budget.ts`;
- bounded diff/review envelopes in `ontoindex/src/mcp/super/diff-impact.ts`;
- docs evidence and response-envelope metadata.

The gap is not a missing session database. The immediate gap is simpler: some MCP responses truncate
or budget evidence, but the response does not always make the candidate, curated, and pruned counts
easy to inspect in one place.

## Review And Challenge

Architecture-fit gate:

1. **Real new functionality gate:** pass only for response-local evidence trajectory and pruning
   metadata that OntoIndex does not currently expose as one compact report section.
2. **Core-extension gate:** pass only if implemented by extending existing evidence ledger, query
   budget, and response-envelope owners. Reject new storage, model training, external rerankers, or a
   separate agent runtime.

Challenge findings:

1. **Do not import Harness-1's ML stack.**
   OntoIndex is a code graph and MCP runtime, not a model-training project.
2. **Do not add another search tool family.**
   Existing `gn_explore`, `gn_review_diff`, docs, and audit tools should emit better trajectory data.
3. **Do not add a persistent conversation database.**
   First slice stays inside the current response. Durable or in-memory session history is deferred.
4. **Do not add LLM reranking.**
   Use existing graph, lexical, docs, and budget scores first.
5. **Do not prune silently.**
   Any pruning must be reported with counts and reasons.
6. **Do not add a diagnose session report yet.**
   `gn_diagnose` already owns setup/runtime health. Putting session trajectory there would mix
   concerns before the response-local metadata proves useful.
7. **Do not create durable JSONL artifacts in the first slice.**
   Cross-call history, replay, and diff are useful later, but first prove the per-response shape.

## Decision

Approve one native capability:

**Response-local evidence trajectory metadata for existing MCP review responses, with explicit
pruning counts and reasons.**

Approved first scope:

1. response-local evidence trajectory records for `gn_review_diff`;
2. compact candidate-versus-curated evidence counts;
3. pruning reasons when response budgets drop evidence;
4. verification status summary derived only from existing diagnostics;
5. no new report surface in the first slice.

Not approved:

- RL/SFT data generation;
- vLLM or Hugging Face serving;
- Baseten or external reranker integration;
- new retrieval database;
- autonomous agent loop;
- provider-specific tool schema conversion beyond existing MCP schemas;
- first-slice `gn_diagnose({ profile: "evidence-trajectory" })`.

## What Is New

### 1. Evidence Trajectory Record

Add a compact response-local item to `gn_review_diff` results:

```ts
type EvidenceTrajectoryItem = {
  tool: string;
  target: string;
  candidates: number;
  curated: number;
  pruned: number;
  verification: "verified" | "partial" | "unverified";
  reasons: string[];
};
```

This is runtime metadata, not graph authority. It should be computed from facts already collected for
the response.

### 2. Context Pruning Metadata

When an MCP response drops candidates because of a budget, include:

- original candidate count;
- emitted evidence count;
- pruned count;
- top pruning reasons;
- retry hint for narrower scope.

This extends existing budget metadata instead of adding a new pruning tool.

### 3. Verification Summary

Use existing diagnostics to summarize whether emitted evidence is verified, partial, or unverified.
Do not introduce a new claim-verification engine.

## Integration Points

| Need                  | Existing owner to extend                                      |
| --------------------- | ------------------------------------------------------------- |
| evidence reads        | `ontoindex/src/core/runtime/evidence-read-ledger.ts`           |
| budget/pruning counts | `ontoindex/src/core/runtime/query-budget.ts`                   |
| review trajectory     | `ontoindex/src/mcp/super/diff-impact.ts`                      |
| docs trajectory       | `ontoindex/src/mcp/super/docs.ts`, `docs-evidence.ts`          |
| response metadata     | `ontoindex/src/mcp/shared/response-envelope.ts`                |

## Implementation Slices

1. Add a tiny response-local trajectory item type near `gn_review_diff`.
2. Record candidate, curated, and pruned counts from `gn_review_diff` without new graph queries.
3. Add pruning reasons from existing query budget truncation/degradation reasons.
4. Add a verification summary from existing review diagnostics.
5. Add focused tests for backward compatibility, no rerun, bounded output, and visible pruning
   reasons.

## Acceptance Criteria

- Existing MCP responses remain backward compatible.
- `gn_review_diff` returns trajectory metadata without new graph queries.
- Pruned evidence is never silent.
- No ML training, external reranker, vLLM, Hugging Face, or new storage dependency is added.
- No diagnose profile or durable session artifact is added in the first slice.

## Deferred

- Trajectory replay.
- Trajectory diff.
- Diagnose/session trajectory profile.
- Benchmark dataset exports.
- LLM or classifier reranking.
- Cross-session durable history.
- Training data export.
