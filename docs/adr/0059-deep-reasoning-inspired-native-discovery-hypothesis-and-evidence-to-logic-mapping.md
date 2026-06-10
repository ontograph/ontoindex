# ADR 0059: Core Hypothesis Grounding and Evidence Gap Mapping

**Status:** Implemented (core grounding)
**Source:** Towards Agentic RAG with Deep Reasoning (arXiv:2507.09477) review, 2026-05-31; narrowed and implemented 2026-06-10
**External reference:** <https://arxiv.org/abs/2507.09477>

## Context

The Synergized RAG-Reasoning pattern treats retrieval as evidence for or against a working
hypothesis, not merely as a fuzzy lookup. The useful OntoIndex-native idea is narrow:

```text
Given an explicit hypothesis, expected premises, and already-collected OntoIndex evidence, report
which premises are supported, refuted, ambiguous, or missing.
```

This ADR must not create a reasoning product, a graph ontology, an LLM judge, or a self-correcting
agent loop. It keeps only the missing core functionality: a deterministic grounding kernel that maps
evidence to a hypothesis and produces a gap manifest.

## Existing Functionality Excluded From This ADR

The following already exist and are not the new feature:

- structured retrieval and retrieval policies;
- evidence classification metadata;
- evidence diagnostics;
- semantic contracts for citation, freshness, docs authority, and truncation visibility;
- architecture-tour composition;
- evidence-gap next-step recommendations;
- audit-lifecycle verifier capability classification;
- graph-aware review and audit lifecycle status checks;
- MCP help, facade, and recommendation surfaces.

Those systems may provide inputs or consume reports later, but this ADR does not approve changing
them in the first implementation.

## OntoIndex Evidence Review

This challenge pass used the local OntoIndex CLI and source reads.

- `ontoindex status` reported the local index is up to date at commit `1b0e8ce`.
- `ontoindex query "hypothesis evidence logic grounding discovery recommendations semantic contracts evidence diagnostics safe refactor" --repo OntoIndex --limit 12`
  resolved existing semantic-contract, evidence-diagnostic, review/export, tool-registry, and
  architecture-tour surfaces.
- The query did not reveal an existing core `DiscoveryHypothesis`, `GroundingReport`, or hypothesis
  gap-manifest module.
- Existing core contracts already cover citation and authority rules:
  - `ontoindex/src/core/runtime/evidence-diagnostics.ts`
  - `ontoindex/src/core/runtime/semantic-contracts.ts`
- Existing recommendation and audit modules already cover adjacent behavior:
  - `ontoindex/src/core/recommendations/evidence-gap-next-steps.ts` maps known evidence gap
    conditions to tool/non-tool next steps.
  - `ontoindex/src/core/audit-lifecycle/verifier-capabilities.ts` classifies whether audit claim
    kinds are supported by known verifier capabilities.
- ADR 0032 added `architecture-tour.ts`, which orders cited evidence for explanation. ADR 0059 must
  not duplicate that. Its new value is premise-level support/refute/missing classification.

Conclusion: ADR 0059 should add only a pure core grounding contract over supplied evidence. It must
reuse existing diagnostics and semantic contracts instead of inventing graph schema, MCP tools, or
agent loops.

## Challenge Findings

1. **The original scope mixed core, graph schema, MCP, and agent behavior.**
   KuzuDB hypothesis nodes, `SUPPORTS`/`REFUTES` graph edges, `gn_help` capability advertising,
   `backend-search.ts` retries, and `gn_safe_refactor` hallucination scoring have different owners and
   blast radii.

2. **The new core feature is not evidence retrieval.**
   Retrieval returns candidates. This ADR starts after retrieval and asks whether supplied evidence
   satisfies explicit premises.

3. **A hypothesis is a value object first, not a persistent graph node.**
   Persisting logical claims in the graph creates schema, lifecycle, and authority questions. The first
   implementation should be pure and in-memory.

4. **Support/refute links are report relations first, not graph edges.**
   First prove the relation model in a deterministic report before promoting it to storage.

5. **No LLM, NLI, or theorem prover belongs in core.**
   The agent may generate a hypothesis. OntoIndex core validates explicit evidence mappings and gaps.

6. **No autonomous self-correction loop in v1.**
   Search expansion and retry policy belong to retrieval surfaces after replay gates exist.

7. **A gap manifest is not a recommendation engine.**
   Existing evidence-gap next-step code maps conditions to actions. ADR 0059 only reports premise
   sufficiency gaps; adapters may translate those gaps to recommendations later.

8. **A grounding report is not an audit verifier.**
   Audit lifecycle code already classifies supported claim kinds. ADR 0059 should not mark findings
   open, fixed, verified, or unsupported.

## Decision

Add a pure core hypothesis-grounding subsystem.

The subsystem accepts an explicit hypothesis, a list of required premises, and already-collected
evidence records. It emits a deterministic report that classifies each premise as supported, refuted,
ambiguous, or missing and exposes diagnostics for stale, uncited, advisory, truncated, or ambiguous
evidence.

Approved core shape:

```text
HypothesisGroundingInput
  -> normalize hypothesis, premises, and evidence
  -> classify evidence-to-premise relations
  -> build premise verdicts
  -> build gap manifest
  -> attach diagnostics
  -> HypothesisGroundingReport
```

## Core Functionality

### 1. Shared Grounding Model

Add:

```text
ontoindex/src/core/reasoning/hypothesis-grounding.ts
```

Core types:

```ts
export interface DiscoveryHypothesis {
  id: string;
  statement: string;
  subject?: string;
}

export interface HypothesisPremise {
  id: string;
  statement: string;
  required?: boolean;
}

export type GroundingRelationKind = 'supports' | 'refutes' | 'mentions' | 'ambiguous';

export interface GroundingEvidence {
  id: string;
  relation: GroundingRelationKind;
  premiseId?: string;
  citation: GroundingCitation;
  diagnostic?: EvidenceDiagnosticRecord;
}

export interface HypothesisGroundingReport {
  hypothesis: DiscoveryHypothesis;
  premiseVerdicts: readonly PremiseGroundingVerdict[];
  gapManifest: readonly GroundingGap[];
  diagnostics: readonly EvidenceDiagnosticRecord[];
  summary: HypothesisGroundingSummary;
}
```

Rules:

- The model is internal core infrastructure, not a public MCP or CLI schema.
- Hypotheses and premises are explicit input data, not inferred by OntoIndex core.
- Evidence must include citation identity such as file path, symbol, process, doc path, graph identity,
  or diagnostic id.
- Diagnostics use existing `EvidenceDiagnosticRecord` quality kinds and fields.

### 2. Grounding Report Builder

Add:

```ts
export function buildHypothesisGroundingReport(
  input: HypothesisGroundingInput,
): HypothesisGroundingReport;
```

Builder rules:

- Pure deterministic function over supplied input.
- No filesystem, Git, LadybugDB, MCP, HTTP, embedding, or LLM calls.
- A required premise with no supported evidence becomes a `missing` gap.
- Refuting evidence produces an explicit `refuted` verdict, not a hidden warning.
- Mixed support/refute evidence becomes `ambiguous` unless caller supplies a stricter policy.
- Uncited evidence is excluded from support/refute decisions and recorded as a diagnostic.
- Bounded output emits truncation diagnostics.
- The gap manifest reports missing/refuted/ambiguous premises; it does not recommend tools or change
  audit lifecycle status.
- Existing semantic-contract utilities are used by tests or adapters to prove citation and authority
  behavior; this ADR does not add a second semantic policy engine.

### 3. Gap Manifest

The gap manifest is the new core output that distinguishes this ADR from architecture tours and
generic diagnostics.

Gap kinds:

```ts
export type GroundingGapKind =
  | 'missing-required-premise'
  | 'refuted-premise'
  | 'ambiguous-premise'
  | 'uncited-evidence'
  | 'truncated-evidence';
```

Rules:

- Gaps name the premise or evidence id that caused them.
- Gaps must carry an actionable reason.
- Gaps are advisory unless a later safety surface explicitly promotes them.
- Docs-only evidence can support a docs premise, but it cannot prove a code/graph premise unless
  linked to code or graph citation fields.

## Rejected From Core

- Persistent `HypothesisNode` graph schema.
- KuzuDB `SUPPORTS` or `REFUTES` edge types.
- `edge_context` / quad-store-style graph partitioning.
- `gn_help` reasoning capability advertising.
- New MCP tool or response field.
- Changes to `backend-search.ts` retry behavior.
- Autonomous self-correction loop.
- `gn_safe_refactor` hallucination critic or faithfulness score.
- Evidence-gap next-step recommendation policy.
- Audit verifier capability classification or audit status transition logic.
- LLM/NLI-based logic evaluation.
- Theorem proving.
- Interactive reasoning tree UI.
- Storing agent chain-of-thought or private reasoning traces.

## Later Adapters

After the core report lands and tests prove the contract, later ADRs or implementation notes may add
thin adapters:

1. retrieval adapter that maps `RetrievalCandidate[]` into `GroundingEvidence`;
2. review/audit adapter that attaches a grounding report to existing diagnostics;
3. optional CLI/MCP wrapper that remains advisory and preserves existing response contracts;
4. storage promotion only after schema, lifecycle, and migration review.

Those adapters must not change the core rules above.

## Implementation Status

Implemented in:

- `ontoindex/src/core/reasoning/hypothesis-grounding.ts`
- `ontoindex/test/unit/hypothesis-grounding.test.ts`

The implementation landed only the approved core slice: explicit hypotheses and premises, supplied
evidence relations, premise verdicts, gap manifest entries, summary counts, truncation diagnostics,
and reuse of existing `EvidenceDiagnosticRecord` and semantic-contract behavior in tests.

No graph schema, MCP/CLI wrapper, retrieval retry, recommendation policy, audit lifecycle status, LLM,
or theorem-proving behavior was added.

## Acceptance Criteria

- `hypothesis-grounding.ts` exists under core reasoning.
- The builder accepts explicit hypotheses, premises, and already-collected evidence.
- The builder does not query graph, MCP, HTTP, Git, filesystem, embeddings, or LLMs.
- Required missing premises produce gap-manifest entries.
- Refuting evidence is reported separately from missing evidence.
- Mixed support/refute evidence is visibly ambiguous.
- Uncited evidence cannot satisfy a premise.
- Docs-only evidence cannot prove code/graph premises without code/graph citations.
- Gap output does not contain recommended tools/actions and does not change audit lifecycle status.
- Existing `EvidenceDiagnosticRecord` and semantic-contract utilities are reused instead of duplicated.
- Unit tests cover support, refute, missing, ambiguous, uncited, docs-only, truncation, and
  deterministic output behavior.

## Validation

For implementation work, run focused tests first:

```bash
cd ontoindex && npm test -- --run test/unit/hypothesis-grounding.test.ts
cd ontoindex && npx tsc --noEmit --pretty false
```

Before editing any existing implementation symbol, rerun fresh OntoIndex impact checks for that
symbol. Adding the new core module does not require impact analysis on existing symbols.

## Consequences

Positive:

- OntoIndex gains a deterministic core report for evidence sufficiency and gaps.
- Later retrieval, review, and audit surfaces can share one grounding contract.
- The feature stays evidence-first and avoids LLM or agent-loop authority.

Negative:

- The first slice is not directly user-visible unless called by tests or later adapters.
- Core cannot judge semantic truth beyond explicit evidence/premise mappings supplied by callers.
- Persisted logical graph relations remain out of scope until the report model proves useful.

## Stop Conditions

- Stop if implementation requires persistent graph schema changes.
- Stop if core must generate hypotheses or chain-of-thought.
- Stop if LLM/NLI evaluation becomes required for correctness.
- Stop if search retry or refactor safety behavior must change to prove the core.
