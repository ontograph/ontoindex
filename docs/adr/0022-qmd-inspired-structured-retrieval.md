# ADR 0022: QMD-Inspired Structured Retrieval and Organic Recommendations

Status: Partially Implemented

## Context

QMD is useful as a reference because it treats retrieval as a typed, multi-stage pipeline rather
than a single fuzzy search box. Its strongest ideas are structured subqueries, hybrid lexical/vector
retrieval, explainable reciprocal-rank fusion, chunk-first reranking, path-scoped context metadata,
and MCP/HTTP surfaces that make retrieval ergonomics explicit.

OntoIndex should not copy QMD as a document-search engine. OntoIndex already has a deeper authority
layer: LadybugDB graph storage, symbols, execution flows, impact analysis, freshness policy, target
context, sidecar enrichment, MCP envelopes, and graph-aware review reports. The useful direction is
to make OntoIndex retrieval and recommendations more explicit, evidence-backed, and explainable while
keeping the graph as the source of truth.

Related decisions:

- ADR 0015: Post-index enrichment sidecar
- ADR 0018: MCP Audit Trust Contract and Customer Readiness Gates
- ADR 0019: Query replay reports for retrieval changes
- ADR 0020: Graph-aware diff review and review reports
- ADR 0021: Serena-inspired agent interface for OntoIndex

Reviewed reference:

- <https://github.com/tobi/qmd>

Existing OntoIndex anchors:

```text
ontoindex/src/core/search/typed-query-document.ts
ontoindex/src/core/search/hybrid-search.ts
ontoindex/src/core/search/symbol-merge.ts
ontoindex/src/mcp/facade/tool-definitions.ts
ontoindex/src/mcp/facade/dispatch.ts
ontoindex/src/mcp/local/backend-query.ts
ontoindex/src/mcp/local/backend-search.ts
ontoindex/src/core/embeddings/embedding-pipeline.ts
ontoindex/src/mcp/shared/response-envelope.ts
ontoindex/src/mcp/shared/target-context.ts
ontoindex/src/mcp/super/explore.ts
ontoindex/src/mcp/super/find-related.ts
ontoindex/src/mcp/super/propose-location.ts
ontoindex/src/mcp/super/diff-impact.ts
ontoindex/src/mcp/super/pre-commit-audit.ts
ontoindex/src/mcp/super/safe-edit-check.ts
```

## Challenge Review

The unsafe implementation would add a second retrieval product beside OntoIndex, copy QMD's local
GGUF model lifecycle, or let LLM-generated suggestions appear as recommendations without graph
evidence. That would conflict with OntoIndex' safety model.

The constraints are:

1. **Graph evidence remains primary.** Vector, lexical, docs, and reranker signals can improve
   discovery, but impact, process, flow, and audit claims must stay grounded in indexed graph facts.
2. **Recommendations must be organic.** A recommendation is allowed only when it is derived from
   returned evidence and has a traceable reason. Static generic advice should be removed from
   high-level review/report tools.
3. **Do not require heavyweight local models.** QMD's local GGUF embeddings/reranker lifecycle is
   useful as an optional pattern, not a default OntoIndex dependency.
4. **Keep one response contract.** New retrieval results must use ADR 0018-style freshness,
   capability, warning, evidence, and limit fields instead of inventing another envelope.
5. **Structured search should reduce ambiguity, not add tool sprawl.** Prefer extending the existing
   `search` facade and super tools before creating new public MCP tools.
6. **Ranking is not safety pruning.** Rank fusion can order evidence, but it must not hide complete
   blast-radius data when a safety tool promises exhaustive impact.
7. **Replay gates are required before tuning.** Retrieval/ranking changes need ADR 0019-style replay
   cases before score weights become release-critical.

## Implementation Status

Partially implemented. Typed-query parsing, structured retrieval output, retrieval policies,
capability diagnostics, RRF tracing, and organic recommendation gates now exist in the search and
review surfaces. Replay-gated ranking changes, path context metadata, and optional reranking remain
bounded follow-up work.

Current-code evidence tightens the decision further:

- `core/search/typed-query-document.ts` already defines `intent`, `symbol`, `file`, `lex`, `vec`,
  `graph`, and `hyde` typed lines. ADR 0022 should extend or expose this existing parser, not create
  a second structured-query grammar.
- `core/search/hybrid-search.ts` and `core/search/symbol-merge.ts` already implement RRF. The v1
  work is traceability and unification, not a brand-new rank-fusion algorithm.
- `mcp/local/backend-search.ts` already combines BM25, vector, optional graph traversal, optional
  CE reranking, intent classification, skeletons, and citations. A new structured search action must
  be a facade over this path unless a replay test proves the existing path cannot support it.
- `docs`, `process`, and `repomap` typed query lanes are useful, but they do not exist in the
  typed-query parser today. Adding them in v1 would expand the protocol before the current typed
  query document has a public contract.
- `.ontoindex/context.yml` can duplicate existing markdown/doc sidecar context and repo resources.
  It should be postponed until there is a clear precedence rule between graph facts, docs facts,
  sidecar facts, and user-authored context.
- The repository already has generic recommendation arrays in tools such as `gn_diagnose` and
  `gn_ensure_fresh`. The organic recommendation rule must first define which tools are safety/review
  surfaces subject to evidence gates; it should not outlaw health-check remediation hints globally.
- The OntoIndex index was stale during this review: indexed commit `83a0773`, current commit
  `9665894`. Graph-derived evidence from this review is architecture navigation, not acceptance
  evidence.
- The direct CLI already exposes `ontoindex query --typed`, but `queryCommand` currently converts the
  typed query document into one plain string via `typedQueryDocumentToPlainQuery` before calling the
  backend. That means the typed lanes exist syntactically but do not yet survive as independent
  retrieval lanes.

### OntoIndex Evidence Check

This ADR was challenged with local OntoIndex and source reads:

```bash
ONTOINDEX_MAX_WORKERS=7 node /home/er77/_wrk/OntoIndex/ontoindex/dist/cli/index.js status
ONTOINDEX_MAX_WORKERS=7 node /home/er77/_wrk/OntoIndex/ontoindex/dist/cli/index.js query "typed query document hybrid search RRF organic recommendations review diff pre commit audit" --repo /home/er77/_wrk/OntoIndex --limit 8
ONTOINDEX_MAX_WORKERS=7 node /home/er77/_wrk/OntoIndex/ontoindex/dist/cli/index.js context parseTypedQueryDocument --repo /home/er77/_wrk/OntoIndex
ONTOINDEX_MAX_WORKERS=7 node /home/er77/_wrk/OntoIndex/ontoindex/dist/cli/index.js context mergeSymbolsWithRRF --repo /home/er77/_wrk/OntoIndex
ONTOINDEX_MAX_WORKERS=7 node /home/er77/_wrk/OntoIndex/ontoindex/dist/cli/index.js context gnDiffImpact --repo /home/er77/_wrk/OntoIndex
```

Findings:

- OntoIndex resolved `parseTypedQueryDocument`, `mergeSymbolsWithRRF`, and `gnDiffImpact`, confirming
  the ADR is about existing surfaces rather than greenfield architecture.
- `query --typed` exists in the direct CLI, but the typed document is flattened before retrieval. The
  implementation gap is preserving typed lanes through backend search, not merely adding a parser.
- `per-intent-ensemble.ts` already owns weighted BM25/vector/graph/CE score policy behind env gates.
  ADR 0022 must not introduce an independent weight table that bypasses that policy.
- `gnDiffImpact` is an existing graph-aware review surface, so organic recommendations should first
  harden its output contract instead of inventing a new review report.

## Decision

Adopt QMD-inspired retrieval by tightening the existing OntoIndex search stack, not by adding a
parallel retrieval product.

The approved direction is:

1. Preserve the existing typed-query document as a structured request through backend search instead
   of flattening it into a plain string.
2. Add explain traces to the existing RRF and per-intent ensemble paths before changing ranking
   weights.
3. Add an organic recommendation gate for review/release/audit safety surfaces.
4. Postpone new typed lanes such as `docs`, `process`, and `repomap` until the existing typed-query
   document is exposed and replay-tested.
5. Postpone path/module context metadata and optional chunk reranking until the structured retrieval
   contract is stable.

This ADR does not approve vendoring QMD, replacing OntoIndex' graph store, making local GGUF models
mandatory, creating a second typed-query grammar, or allowing generic recommendation text in
release/review/audit outputs.

## Algorithm/Technique

### 1. Structured search contract

Use the existing typed query document as the v1 syntax contract:

```ts
// ontoindex/src/core/search/typed-query-document.ts
type SearchableTypedQueryLineType = 'symbol' | 'file' | 'lex' | 'vec' | 'graph' | 'hyde';

interface TypedQueryRequest {
  intent?: string;
  lines: Array<{
    type: SearchableTypedQueryLineType;
    query: string;
    lineNumber: number;
  }>;
}
```

Example typed query document:

```text
intent: find evidence-backed release review recommendations
symbol: gnHelp
graph: MCP tool registry drift
lex: ADR 0018 review diff envelope
vec: review diff safety recommendations
```

Implementation ownership:

```text
ontoindex/src/core/search/typed-query-document.ts  # parser and line types
ontoindex/src/cli/tool.ts                          # currently flattens --typed input
ontoindex/src/core/search/tabular-lane.ts          # proposed config/data extraction logic
ontoindex/src/mcp/local/backend-search.ts          # orchestration path
ontoindex/src/mcp/local/backend-query.ts           # lexical/vector adapters
ontoindex/src/mcp/facade/tool-definitions.ts       # later public schema extension
ontoindex/src/mcp/facade/dispatch.ts               # later action routing
```

Routing rules:

- `symbol` resolves named symbols and exact symbol candidates.
- `file` resolves files and file-scoped skeletons.
- `graph` uses graph traversal only when intent and confidence make it useful.
- `lex` uses lexical/BM25 style lookup where available.
- `vec` uses embeddings only when target context reports embeddings available.
- `hyde` is accepted only when a vector backend exists; otherwise it is downgraded with a warning.
- `tabular`, `docs`, `process`, and `repomap` are follow-up line types, not v1.

### Typed Query Filters

Typed query filters are a proposed follow-up. The current parser accepts typed searchable lines; it does not yet accept `filter:` blocks.

```text
filter: kind=Function
filter: filePath~ontoindex/src/core/search/**
filter: capability!=semantic
```

The follow-up filter contract should validate fields before retrieval and apply them to materialized `RetrievalCandidate` objects. Supported fields should start with `kind`, `filePath`, `repo`, `language`, `freshness`, and `capability`. Supported operators should start with `=`, `!=`, and `~` (glob).

### Row-Normalized Retrieval Results

Row-normalized retrieval results are a proposed derived view. Current structured retrieval returns `candidates` plus `capabilityState`; a later CLI/export adapter can derive `rows` without changing candidate ranking.

```ts
interface StructuredRetrievalRow {
  id: string;
  kind: RetrievalCandidate['kind'];
  label: string;
  filePath?: string;
  startLine?: number;
  endLine?: number;
  score?: number;
  source: SearchableTypedQueryLineType;
  freshness: RetrievalFreshnessStatus;
  retrievalKinds: Array<'exact' | 'bm25' | 'vector' | 'graph' | 'hybrid'>;
}
```

The `rows` field is mechanically derived from the `candidates` array and preserves ranking order.

The first implementation change should introduce an internal request type, not a new public tool:

```ts
type BackendSearchInput =
  | { mode: 'plain'; query: string }
  | { mode: 'typed'; document: TypedQueryRequest };
```

`ontoindex query --typed` can then pass `TypedQueryRequest` through instead of calling
`typedQueryDocumentToPlainQuery`. MCP exposure should come after this internal path is tested.

The first MCP exposure should eventually be one of:

```text
search({ action: "semantic", query: "<typed document>", typed_query: true })
search({ action: "structured", query_document: "<typed document>" })
```

The implementation should choose the smaller compatibility change after checking MCP client behavior.
Do not add both.

The returned result should include normalized candidates:

```ts
interface RetrievalCandidate {
  id: string;
  kind: 'symbol' | 'file' | 'process' | 'doc' | 'route' | 'module';
  label: string;
  filePath?: string;
  startLine?: number;
  endLine?: number;
  source: SearchableTypedQueryLineType;
  rawScore?: number;
  evidence: unknown;
  freshness: 'fresh' | 'stale' | 'degraded' | 'unknown';
}
```

### 2. Explainable rank fusion

Extend the existing RRF and ensemble modules before adding a new package:

```text
ontoindex/src/core/search/hybrid-search.ts
ontoindex/src/core/search/symbol-merge.ts
ontoindex/src/core/search/per-intent-ensemble.ts
```

Core API:

```ts
interface RankedList<T> {
  source: string;
  weight: number;
  items: T[];
  getId(item: T): string;
  getRawScore?: (item: T) => number | undefined;
}

interface FusedCandidate<T> {
  id: string;
  item: T;
  score: number;
  trace: Array<{
    source: string;
    rank: number;
    weight: number;
    contribution: number;
    rawScore?: number;
  }>;
}
```

Use weighted reciprocal rank fusion:

```text
contribution = weight / (k + rank)
score = sum(contribution)
```

Initial trace-only work must preserve current scores. Weighted source tuning is follow-up work after
replay gates and must go through `per-intent-ensemble.ts` or a direct successor to it.

Rules:

- Emit `scoreTrace` when `explain: true`.
- Do not add new user-controllable weights in v1.
- Do not use fusion to truncate exhaustive impact results.
- Add replay cases before changing default weights.
- Do not change existing RRF ordering in the same patch that adds traces.
- Do not define a second ranking policy outside `per-intent-ensemble.ts`.

### 3. Organic recommendation kernel

Add a shared recommendation layer for review/release/audit safety tools:

```text
ontoindex/src/core/recommendations/organic.ts
ontoindex/src/core/recommendations/types.ts
```

Recommendation shape:

```ts
interface OrganicRecommendation {
  id: string;
  action: string;
  target: {
    kind: 'symbol' | 'file' | 'process' | 'doc' | 'test' | 'route';
    name: string;
    filePath?: string;
    startLine?: number;
  };
  reason: string;
  confidence: 'low' | 'medium' | 'high';
  evidenceIds: string[];
  scoreTrace?: unknown;
  nextTools: string[];
}
```

Emission gate:

```text
recommendation is valid iff:
  evidenceIds.length > 0
  and reason references a concrete evidence fact
  and target is tied to a symbol/file/process/doc
  and nextTools are callable public tools or explicit non-tool actions
  and freshness/capability state is visible to the caller
```

Integrate first into:

```text
ontoindex/src/mcp/super/diff-impact.ts
ontoindex/src/mcp/super/pre-commit-audit.ts
```

The first migration should remove generic advice such as "add tests" unless the tool can point to a
specific changed symbol, affected process, missing coverage evidence, or test gap.

Do not migrate `gn_diagnose` and `gn_ensure_fresh` in v1. Those tools produce environment and
readiness remediation hints, not code-review recommendations. They may later adopt evidence ids, but
they should not block the organic recommendation kernel.

### 4. Path and module context metadata (postponed)

Path context is useful, but v1 should not add another user-authored context source. Postpone optional
OntoIndex context metadata until structured retrieval can explain how it uses existing docs,
enrichment, and repo resources.

```text
.ontoindex/context.yml
```

Example:

```yaml
contexts:
  ontoindex/src/mcp/super:
    domain: "agent-facing safety tools"
    risk: "high"
    invariants:
      - "recommendations must be evidence-backed"
      - "responses use capability envelopes"

  ontoindex/src/core/ingestion:
    domain: "graph indexing pipeline"
    invariants:
      - "shared ingestion code must stay language-neutral"
```

Implementation ownership:

```text
ontoindex/src/mcp/local/backend-repo-paths.ts
ontoindex/src/mcp/shared/target-context.ts
ontoindex/src/mcp/shared/response-envelope.ts
ontoindex/src/core/ingestion/enrichment/docs-inline-context.ts
```

Future rules:

- Context inherits from parent path prefixes.
- Context is advisory metadata, not audit evidence by itself.
- Context must be included in capability/evidence sections when it affects ranking or
  recommendations.
- Missing or malformed context files must degrade gracefully.

### 5. Optional chunk reranking (postponed)

Use QMD's chunk-first lesson later, without copying its default local model lifecycle:

```text
retrieve candidates -> hydrate bounded chunks -> optional rerank -> fuse with graph score
```

Implementation ownership:

```text
ontoindex/src/mcp/core/ce-reranker.ts
ontoindex/src/core/embeddings/chunker.ts
ontoindex/src/core/embeddings/embedding-pipeline.ts
ontoindex/src/mcp/shared/response-envelope.ts
```

Rules:

- Rerank only bounded chunks, never full files or full reports.
- Reranking is optional and reported through `capabilitiesUsed` / `capabilitiesMissing`.
- If reranking is unavailable, return fused graph/lex/vector results with a warning.
- Reranker disagreement cannot suppress critical impact evidence.

## Rollout Plan

1. **Phase 1: Retrieval kernel**
   - Keep existing parser tests and add typed-backend adapter tests.
   - Replace CLI `--typed` flattening with an internal `TypedQueryRequest` path.
   - Add trace output to `mergeSymbolsWithRRF` / `mergeWithRRF` without changing ordering.
   - Add internal structured search adapter over `backend-search.ts`.

2. **Phase 2: Facade exposure**
   - Expose exactly one typed-query public shape.
   - Keep existing `semantic`, `cypher`, and `repomap` behavior unchanged.
   - Add docs for typed query examples.

3. **Phase 3: Organic recommendations**
   - Add recommendation types and emission gate.
   - Migrate `gn_diff_impact` and `gn_pre_commit_audit` first.
   - Add tests proving generic recommendations are rejected.

4. **Phase 4: Replay gates**
   - Add ADR 0019-style query replay fixtures for structured retrieval.
   - Freeze baseline result sets before changing source weights.

5. **Phase 5: Context metadata**
   - Parse `.ontoindex/context.yml`.
   - Attach inherited path context to structured retrieval evidence.
   - Add malformed-file and stale-context warnings.

6. **Phase 6: Optional reranking**
   - Wire reranking behind capability checks.
   - Add replay cases before enabling any default rerank path.

## Acceptance Criteria

- Existing `search` actions keep their current contract.
- Existing typed query document parsing is reused, not duplicated.
- `ontoindex query --typed` preserves typed lanes internally instead of flattening them before
  retrieval.
- Adding score traces does not change existing RRF ordering.
- Ranking-weight changes stay in `per-intent-ensemble.ts` or its explicit successor.
- Structured search returns deterministic results for fixed indexed data.
- Every fused result can explain which sources contributed to its score.
- Every recommendation has at least one evidence id and a concrete target.
- Tools using organic recommendations expose freshness and missing capabilities.
- Tests cover unavailable embeddings, unavailable reranker, stale index, dirty worktree, empty result
  sets, duplicate candidates, and generic recommendation rejection.
- ADR 0019 replay cases are added before changing ranking weights or adding new typed lanes after v1.

## Consequences

Positive:

- Agents can express retrieval intent directly instead of guessing one natural-language query.
- Recommendations become traceable and easier to challenge.
- Review and release reports can keep only organic recommendations.
- Ranking quality can improve without weakening graph-first safety.
- Optional model-backed reranking becomes an enhancement, not a release dependency.

Negative:

- Adds a new ranking layer that must be calibrated and regression-tested.
- Structured search increases schema surface area.
- Path context metadata can become stale if users treat it as documentation without review.
- Recommendation gates may initially suppress some useful but unevidenced hints.

Mitigations:

- Keep v1 deterministic and model-optional.
- Require score traces and evidence ids.
- Add replay tests before score changes.
- Label context metadata as advisory unless corroborated by graph/docs evidence.
