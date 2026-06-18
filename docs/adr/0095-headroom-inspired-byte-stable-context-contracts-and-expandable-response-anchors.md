# ADR 0095: Headroom-Inspired Byte-Stable Context Contracts And Expandable Response Anchors

**Status:** Proposed - Core Extension Only
**Date:** 2026-06-17
**Source:** `./tmp/headroom` donor review, challenged with OntoIndex MCP against current
`response-guard`, `response-limits`, docs pagination, context-cost, evidence trajectory, and wiki
owners.

## Context

Headroom is a context-compression proxy. OntoIndex should not copy the proxy, auth modes, provider
request rewriting, reversible prompt cache, memory store, or model-based compressors. Those are a
separate product.

The useful donor idea for OntoIndex is smaller:

> Agent-facing graph responses should be byte-stable, summary-first, and expandable by stable
> anchors when evidence is omitted.

OntoIndex already has most raw parts:

- response guarding in `ontoindex/src/mcp/local/response-guard.ts`;
- cursor pagination in `ontoindex/src/mcp/shared/response-limits.ts`;
- capability envelopes in `ontoindex/src/mcp/shared/response-envelope.ts`;
- context-cost telemetry from ADR 0093;
- evidence trajectory and pruning metadata from ADR 0092;
- docs inline-context and wiki generation surfaces.

The missing feature is a tiny response contract on the already-paginated docs surface. It should say
which parts of a response are stable, which items were omitted by pagination, and how to request the
next page without asking an agent to rerun a broad query.

## Review And Challenge

Architecture-fit gate:

1. **Real new functionality gate:** pass only for docs-response stability metadata and source
   anchors not already covered by ADR 0090 response budgets, ADR 0092 pruning metadata, or ADR 0093
   context-cost telemetry.
2. **Core-extension gate:** pass only when implemented through existing MCP response envelopes,
   response limits, docs pagination, evidence metadata, and wiki/export surfaces.

Rejected:

- LLM proxy or provider request rewriting;
- cache hot-zone mutation rules for upstream model requests;
- cross-agent memory;
- local compression model;
- auth-mode compression policy;
- new MCP `compress` / `retrieve` tool family;
- hidden raw payload cache or cross-call payload store;
- provider token-savings claims.

## Decision

Approve one narrow capability:

**A byte-stable response contract for `gn_docs` compact reports, with stable source anchors and
cursor-based expansion hints.**

Approved first scope:

1. add a compact `responseContract` metadata object to `gn_docs` non-minimal reports first;
2. generate stable evidence anchors from existing docs evidence source identities, not random ids;
3. include omitted evidence counts and cursor-based next-page hints;
4. preserve deterministic ordering in compact outputs;
5. add tests that rerunning the same docs fixture produces the same anchors and same contract.

Not approved:

- new storage;
- new compression dependency;
- proxy mode;
- transforming tool definitions;
- exact tokenizer accounting;
- automatic wiki regeneration during MCP calls;
- applying the contract to review, diff, audit, or wiki responses in the first slice.

## What Is New

### 1. Response Contract Metadata

Add a tiny metadata shape to selected response envelopes:

```ts
type ResponseContract = {
  mode: "summary-first";
  stablePrefix: "repo-and-contract";
  deterministicOrder: true;
  expandable: boolean;
  anchorScheme: "source-identity-v1";
  omittedItems: number;
  nextCursor?: string;
  expandHint: string;
};
```

This is not a compression layer. It is a promise about response shape.

### 2. Stable Evidence Anchors

When a docs response emits evidence, each retained summary item should carry an anchor derived from
facts OntoIndex already knows:

```text
<repoLabel>:<docPath-or-sourceId>:<line-span-or-fact-id>:<evidenceKind>
```

The anchor must be deterministic for the same graph snapshot. Do not use timestamps, counters, random
ids, or process-local state.

### 3. Expand By Cursor, Not Hidden Retrieval

Use existing cursor and evidence metadata only:

- `gn_docs` already returns `cursor` from `paginateMcpItems`;
- `expandHint` should be an exact next call with `cursor.next` when available;
- no hidden payload cache is created;
- no broad rerun is required when the next page cursor is present.

If later evidence expansion needs more than pagination, extend the existing docs surface before
adding a new tool.

### 4. Stable Ordering

For `gn_docs` compact reports:

- keep repo and contract metadata before variable evidence arrays;
- preserve current sidecar freshness data, but do not include volatile values in anchors;
- sort anchors only if the source item order is not already deterministic;
- keep generated wiki/export cleanup out of the first slice.

This extends current docs pagination behavior. It does not add a separate docs product.

## Integration Points

| Need | Existing owner to extend |
| --- | --- |
| cursor and limits | `ontoindex/src/mcp/shared/response-limits.ts` |
| docs compact reports | `ontoindex/src/mcp/super/docs.ts` |
| docs inline context evidence formatting | `ontoindex/src/core/ingestion/enrichment/docs-inline-context.ts` |
| docs response tests | `ontoindex/test/unit/` docs-focused tests |

## Proposed First Slice

Keep this smaller than Headroom:

1. add `ResponseContract` near `DocsMcpFullReport`; do not create a global framework yet;
2. attach it only to `gn_docs` non-minimal reports from `finalizeDocsItemsReport`;
3. derive anchors in the existing `toSummaryItem` / `toFullItem` mapping path when source identity is
   available;
4. set `omittedItems` from `cursor.total - cursor.offset - cursor.returned`;
5. set `expandHint` to an exact `gn_docs({ cursor: "<next>" })` style hint when `cursor.next`
   exists;
6. add deterministic fixture tests for repeated summary reports.

## Acceptance Criteria

- Existing MCP response shapes remain backward compatible.
- Compact docs responses expose `responseContract`; minimal reports may stay unchanged.
- Anchors are deterministic across repeated fixture runs.
- Omitted evidence has a count and, when possible, a next-cursor expansion hint.
- The first slice does not add a new MCP tool or hidden retrieval store.
- No proxy, compressor, external model, raw payload cache, or new storage is added.

## Deferred

- Applying the contract to review, diff, audit, wiki, or every MCP response.
- A dedicated `expandEvidence` tool.
- Tokenizer-accurate accounting.
- Provider prompt-cache integration.
- Cross-call payload retrieval.
- Compression benchmarks.
- UI controls for compact/full response mode.
- Wiki/export deterministic cleanup.
