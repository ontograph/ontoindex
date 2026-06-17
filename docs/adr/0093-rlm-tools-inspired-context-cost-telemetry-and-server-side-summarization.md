# ADR 0093: RLM-Tools-Inspired Context-Cost Telemetry And Server-Side Summarization

**Status:** Implemented - First Slice
**Date:** 2026-06-17
**Source:** `./tmp/rlm-tools` donor review, challenged with OntoIndex MCP against current
`guardResponseSize`, `buildDiffOutputBudget`, and `createCapabilityResponseEnvelope` owners.

## Context

RLM Tools keeps broad exploration data in tool-side memory and returns only compact summaries to the
model. OntoIndex should not copy its Python sandbox or arbitrary code execution model. The useful
idea for OntoIndex is narrower: make response size and pruning pressure visible inside existing MCP
responses.

OntoIndex already has the right primitives:

- response-size guarding in `ontoindex/src/mcp/local/response-guard.ts`;
- per-surface output budgets in `ontoindex/src/mcp/shared/diff-output-budget.ts`;
- capability envelopes in `ontoindex/src/mcp/shared/response-envelope.ts`;
- evidence and budget metadata on review, docs, explore, and diagnose surfaces.

The missing core feature is a consistent way to report emitted response size and known item-level
pruning facts so agents can see when a response is still too large. OntoIndex should not estimate
"saved tokens" unless the skipped payload was actually measured.

## Review And Challenge

Architecture-fit gate:

1. **Real new functionality gate:** pass only for response-local context-cost telemetry not already
   exposed by ADR 0090 budgets or ADR 0092 evidence trajectory metadata.
2. **Core-extension gate:** pass only when implemented through existing response guards, budgets, and
   envelopes. Reject a new MCP sandbox, Python REPL, sub-LLM bridge, or independent exploration
   runtime.

Challenge findings:

1. **Do not add a Python sandbox.**
   OntoIndex already owns structured code graph retrieval; arbitrary execution is a separate product.
2. **Do not add start/execute/end MCP tools.**
   Tool-count reduction is good, but OntoIndex's existing frontier should get better metadata first.
3. **Do not add sub-LLM calls.**
   Core mode must stay local and deterministic.
4. **Do not store raw file contents in a session.**
   First slice reports cost and pruning; it does not retain hidden payloads.
5. **Do not make benchmark claims without fixtures.**
   Any savings metric must be computed from observed response sizes or test fixtures.
6. **Do not pretend to know omitted payload size.**
   First slice can report emitted characters and known candidate/emitted/pruned item counts. It
   cannot report "saved chars" unless a caller measured both sides.
7. **Do not create another budget abstraction.**
   Existing `limits`, `budget`, and evidence trajectory fields stay authoritative. `contextCost`
   should be a small convenience view over those facts.

## Decision

Approve one native capability:

**Context-cost telemetry for existing MCP responses, showing emitted payload size and known
candidate/emitted/pruned item counts.**

Approved first scope:

1. add a small `contextCost` object to capability envelopes or selected MCP results;
2. report emitted JSON character count and known item counts when already available;
3. expose existing review truncation as structured metadata, not only warnings;
4. add one regression fixture that proves metadata remains present for normal and capped responses;
5. document that metrics are approximate and local to the current response.

Not approved:

- Python execution sandbox;
- persistent exploration sessions;
- `llm_query` or any external model bridge;
- raw hidden data cache;
- new search/read/grep MCP tool family;
- marketing benchmark numbers without reproducible fixtures.

## What Is New

### 1. Context-Cost Metadata

Add a compact metadata shape:

```ts
type ContextCost = {
  emittedChars: number;
  candidateItems?: number;
  emittedItems?: number;
  prunedItems?: number;
  summaryFirst: boolean;
  truncated: boolean;
  reasons: string[];
};
```

This is runtime telemetry, not graph authority. It is not a tokenizer estimate and it is not a claim
about total context saved.

### 2. Review Response Integration

`gn_review_diff` exposes structured context-cost facts inside `results.contextCost`:

- emitted JSON character count;
- candidate and emitted item counts from existing diff/review budgets;
- pruned item count from existing truncation metadata;
- truncation and narrowing reasons.

Direct `guardResponseSize` integration is deferred until another response surface needs the same
metadata.

### 3. Budget Regression Fixture

Added representative unit coverage for normal and changed-path-capped `gn_review_diff` responses. The
tests assert that `contextCost` is present, emitted character count is positive, and truncation reasons
are visible. They avoid brittle exact byte ceilings.

## Integration Points

| Need                  | Existing owner to extend                               |
| --------------------- | ------------------------------------------------------ |
| response size guard   | `ontoindex/src/mcp/local/response-guard.ts` (deferred)      |
| diff/review budgets   | `ontoindex/src/mcp/shared/diff-output-budget.ts`            |
| response envelopes    | `ontoindex/src/mcp/shared/response-envelope.ts`             |
| review response usage | `ontoindex/src/mcp/super/diff-impact.ts`                    |
| tests                 | `ontoindex/test/unit/response-guard.test.ts`, diff tests    |

## Implementation Slices

1. Add the `ContextCost` type near the first consumer, `gn_review_diff`.
2. Populate it from existing budget/limit facts on `gn_review_diff`.
3. Keep `guardResponseSize` unchanged until a second response surface needs shared metadata.
4. Add regression tests for normal and capped review responses.
5. Document that context-cost values are emitted-character counts plus known item counts, not
   tokenizer-accurate costs or claimed savings.

## Acceptance Criteria

- Existing MCP callers remain backward compatible.
- `gn_review_diff` exposes context-cost metadata without new graph queries.
- Review response truncation is visible as structured metadata.
- Regression tests catch missing context-cost/truncation metadata.
- No sandbox, sub-LLM, hidden raw data cache, or new MCP tool family was added.

## Deferred

- Cross-call exploration sessions.
- Server-side scratch memory.
- Exact tokenizer-based accounting.
- A/B benchmark publication.
- New read/grep/glob tools.
- LLM-in-tool summarization.
- Shared `guardResponseSize` context-cost metadata.
