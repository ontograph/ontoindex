# ADR 0028: Answer-Engine-Inspired Evidence Expansion for OntoIndex

Status: Implemented (core discipline)

Source: [`developersdigest/llm-answer-engine`](https://github.com/developersdigest/llm-answer-engine)

## Context

The reviewed `llm-answer-engine` repository is a Perplexity-style web answer application. Its useful
architecture is an answer pipeline: search sources, fetch content, chunk/vectorize, stream an answer,
generate follow-up questions, and optionally cache results.

OntoIndex should not copy that product shape. OntoIndex is not a public web answer engine and should
not add external search, generic RAG, dynamic UI components, or LLM-generated follow-up questions as
core features.

The OntoIndex-native lesson is narrower: answer engines work well when they make retrieval,
evidence expansion, and next-step guidance explicit. OntoIndex already has the correct trust model
for this through ADR 0018, ADR 0024, ADR 0025, and ADR 0026:

- tool contracts and registry metadata;
- evidence classes;
- evidence read ledger and `basedOnReads`;
- freshness and degraded-state reporting;
- organic recommendation guardrails.

This ADR keeps only the parts that naturally improve OntoIndex' core function: finding and
classifying repository knowledge without weakening audit authority.

## Review and Challenge

Reviewed against OntoIndex on 2026-05-23.

OntoIndex evidence:

- `gn_diagnose({repo: "OntoIndex", checkToolContract: true})` reported a clean tool contract but a
  stale index: indexed `01b797718afe7468166072b7a24bee36129b8b20` vs current
  `8006ed4faa2f750856d07b86dd9998aab8cc5c30`.
- `gn_tool_contract({includeFacades: true})` reported no missing or extra public callable tools.
- `gn_explore(...)` surfaced existing docs/memory and evidence-ledger code paths, but because the
  graph index is stale and embeddings are unavailable, direct source review is required before
  treating graph-discovered evidence as complete.
- Direct source review found that ADR 0026 already owns the evidence-class vocabulary and explicitly
  says retrieval implementation details should remain secondary metadata.
- Direct source review found `EvidenceReadLedger`, `summarizeBasedOnReads()`, and organic
  recommendation authority gates already exist.

Challenge findings:

1. **The ADR must not create a second evidence registry.** “Evidence Source Inventory” is acceptable
   only as metadata on existing resource/tool/report contracts. It must not become a parallel
   provider framework.
2. **Pipeline language is too broad unless phased narrowly.** A shared pipeline across `gn_explore`,
   `gn_docs`, review, and audit can become a large rewrite. The first accepted slice should be an
   inventory and deterministic next-step helper only.
3. **`basedOnReads` must stay material-read-only.** The ADR should not require every candidate lookup
   to be recorded. Only reads that materially support a recommendation should enter the ledger.
4. **Audit integration is high risk.** Review and audit tools can consume source metadata, but no
   report should gain new audit authority from this ADR.
5. **No semantic expansion under stale graph assumptions.** Because the active OntoIndex index is
   stale and embeddings are unavailable, implementation claims must be validated by source review and
   focused tests until the index is refreshed.
6. **Organic recommendations already have gates.** ADR 0028 should feed those gates; it should not
   introduce a second recommendation validator.

## Decision

Adopt a narrow OntoIndex-native **Evidence Expansion Discipline** for exploration, docs, review, and
audit reports.

The pipeline is:

```text
intent -> candidate knowledge -> bounded evidence reads -> evidence classification -> ranked next action
```

This is an internal architectural pattern, not a new public answer-engine product. Existing public
surfaces may consume it incrementally after proving compatibility:

- `gn_explore`
- `gn_docs`
- `gn_review_diff` / `gn_diff_impact` only after docs/explore prove the pattern
- `gn_audit_session_verify` only after a separate audit-authority review
- `gn_help`
- `gn_tool_contract`

## Implementation Status

Implemented as a core evidence discipline. `EvidenceReadLedger`, `basedOnReads` summaries, evidence
classification metadata, passive related facts, Markdown context/PPR options, and organic
recommendation gates now feed existing exploration, docs, review, pre-commit, and safe-edit
surfaces. This ADR did not add a generic answer engine or external web-search product.

## Accepted Recommendations

### 1. Evidence Expansion Pipeline

OntoIndex should centralize only the safe, repeated parts of expanding a user intent into bounded,
classified evidence.

The pipeline should:

1. Resolve the user intent into candidate symbols, docs, resources, audit records, or diagnostics.
2. Read only bounded evidence.
3. Record only material recommendation-supporting reads in the evidence read ledger.
4. Classify each evidence item using the ADR 0026 vocabulary.
5. Rank next actions by authority, freshness, and relevance.
6. Return `basedOnReads` and provenance metadata where the evidence materially supports a
   recommendation.

This does not approve a rewrite of report-specific evidence collection. Early implementation should
extract small helpers only where duplication is already visible. It does not change audit authority
rules.

### 2. Evidence Source Inventory

OntoIndex should extend existing registry/resource/report metadata to describe evidence sources. This
must extend ADR 0025 and ADR 0026 rather than creating a parallel provider abstraction.

Each source should declare:

- evidence class;
- freshness behavior;
- audit authority;
- provenance fields;
- truncation and response-size policy;
- whether reads are safe to include in `basedOnReads`;
- whether the source is advisory only.

This inventory should be implemented as contract metadata and validation tests first. Do not add a
new runtime provider interface unless later implementation proves the metadata-only approach cannot
support the use case.

Initial source inventory:

| Source | Evidence class | Authority |
| --- | --- | --- |
| Graph/index facts | `graph_evidence` | Can support audit only when fresh and verified. |
| Docs, ADRs, guides | `docs_evidence` | Context only; must not override code evidence. |
| Audit session outputs | `audit_evidence` | Can support status when produced by accepted gates. |
| Runtime health/freshness | `runtime_diagnostic` | Operational context only. |
| Memories | `advisory_memory` | Advisory only; never audit evidence by itself. |

### 3. Deterministic Next-Step Engine

OntoIndex should generate next-step recommendations from evidence gaps, not from an LLM.

This should reuse existing `nextTools`, `suggestedNext`, `gn_help`, `gn_tool_contract`, and organic
recommendation validation concepts. It must not create a second recommendation engine.

Examples:

| Condition | Next step |
| --- | --- |
| Index is stale | `gn_ensure_fresh` |
| Tool contract drift | `gn_tool_contract` / fix registry drift |
| Docs-only claim about code behavior | Verify through graph/code evidence |
| Edit risk without impact evidence | `gn_safe_edit_check` |
| Audit finding without replay evidence | `gn_audit_replay` |
| Runtime diagnostic used as recommendation support | Mark advisory/degraded |
| Evidence class is `unknown` | Downgrade or classify before recommending |

The output should be concrete tool recommendations, not open-ended generated questions.

## Rejected Recommendations

### Staged Streaming Answer UI

Rejected for core OntoIndex. MCP reports should remain structured and deterministic. Streaming UI
events may be useful later for a web interface, but they do not improve core evidence authority.

### Web Search Provider Abstraction

Rejected. OntoIndex evidence sources are local graph/docs/audit/runtime sources, not interchangeable
web providers. A provider abstraction modeled after Brave/Serper would blur trust boundaries.

### Semantic Cache for Answers

Rejected for core. Cached answers can become stale and can obscure provenance. A future advisory
cache may be considered only if entries are keyed by target HEAD, graph index id, tool-contract
version, evidence class, and source identity.

### LLM Follow-Up Question Generator

Rejected. OntoIndex next steps should be deterministic and grounded in missing evidence, not
generated from answer text.

### Dynamic Function-Calling UI

Rejected. OntoIndex already has MCP tools, facades, tool contracts, and release-policy gates. A
parallel function router would duplicate ADR 0025 and weaken contract drift checks.

### Model/Provider Configuration Knobs

Rejected as a core feature. OntoIndex indexing and MCP safety workflows should not depend on runtime
LLM provider selection. Quality and evidence budgets should remain OntoIndex-native.

## Implementation Plan

### Phase 1: Inventory Existing Evidence Sources

Add or consolidate metadata for current graph, docs, audit, diagnostics, and memory sources. This is
the only approved first implementation slice.

Deliverables:

- Contract metadata fields or a small source-inventory type that is consumed by existing contracts.
- Registry/resource/report contract mapping.
- Tests that every public evidence-producing surface maps to an ADR 0026 evidence class.

### Phase 2: Deterministic Next-Step Helper

Introduce a small internal helper that maps evidence gaps to existing tools and non-tool actions.
Use it in one low-risk surface first, preferably `gn_help`, `gn_docs`, or `gn_explore`.

Deliverables:

- deterministic next-step list.
- tests that next steps are public callable tools or explicitly allowed non-tool actions.

### Phase 3: Shared Evidence Expansion Helper

Introduce bounded evidence expansion only after Phase 1 and Phase 2 have proven useful.

Deliverables:

- bounded candidate collection;
- material-read ledger recording;
- evidence-class summary;
- provenance list;
- no broad refactor of audit/review tools in the first implementation.

### Phase 4: Report Integration

Adopt the helper in review reports where evidence already exists. Audit reports require an explicit
authority review before integration.

Deliverables:

- `basedOnReads` in reports where material reads support recommendations;
- degraded/advisory labels when source classes are non-authoritative;
- tests that docs/memory/diagnostics cannot become audit evidence without accepted gates.

### Phase 5: Recommendation Integration

Feed deterministic next steps into organic recommendation output by using the existing organic
recommendation gates.

Deliverables:

- next steps based on evidence gaps;
- no LLM-generated recommendation text;
- organic recommendation tests for authority downgrades.

## Guardrails

- Do not add external web search to core OntoIndex.
- Do not add a generic answer engine or chat runtime.
- Do not add a second tool/function registry.
- Do not add a second recommendation validator.
- Do not add LLM-generated follow-up questions.
- Do not cache audit verdicts or organic recommendations.
- Do not allow docs, memories, or runtime diagnostics to drive audit/session status transitions.
- Do not record speculative candidates in `basedOnReads`; record material supporting reads only.
- Every recommendation must expose evidence class, freshness, and provenance when evidence supports
  it.

## Acceptance Criteria

- Existing OntoIndex surfaces remain the public API.
- Evidence expansion is bounded and records material reads.
- Evidence source metadata reuses ADR 0025/0026 registry and resource/report contract concepts.
- Deterministic next steps are emitted from evidence gaps through existing `nextTools`,
  `suggestedNext`, or organic recommendation fields.
- Audit authority remains unchanged.
- Organic recommendation gates continue to reject or downgrade non-authoritative evidence.

## Validation

For implementation work, run:

```bash
cd ontoindex && npx tsc --noEmit --pretty false
cd ontoindex && npx vitest run test/unit/evidence-read-ledger.test.ts test/unit/recommendations/organic.test.ts test/unit/super/help.test.ts test/unit/super/tool-contract.test.ts
```

When report surfaces are changed, also run the focused tests for the modified report tool.
