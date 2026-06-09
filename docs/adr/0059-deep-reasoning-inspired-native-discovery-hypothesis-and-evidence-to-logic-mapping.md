# Deep-Reasoning-inspired native discovery hypothesis and evidence-to-logic mapping

**Status:** Proposed
**Source:** Towards Agentic RAG with Deep Reasoning (arXiv:2507.09477) review, 2026-05-31
**External reference:** <https://arxiv.org/abs/2507.09477>

## Context

The Synergized RAG-Reasoning paradigm (Li et al., 2025) moves beyond "Retrieval as a tool" and treats retrieval as a **Logical Premise**. It emphasizes iterative interleaving where an agent maintains a **Hypothesis**, identifies **Information Gaps**, and uses retrieved evidence to either support or refute the logical model.

OntoIndex currently implements structured retrieval (ADR 0022) and evidence classification (ADR 0026), but it lacks a native core primitive for a **Discovery Hypothesis** (a transient logical statement about a bug or feature) and has no structural support for **Evidence-to-Logic Mapping** (linking a symbol to a reasoning step via `SUPPORTS` or `REFUTES`).

This ADR extends:
- [ADR 0026](0026-knowledge-discovery-evidence-classification.md), for evidence metadata;
- [ADR 0054](0054-semantic-ritual-inspired-native-conceptual-mapping-and-ambiguity-diagnostics.md), for conceptual nodes;
- [ADR 0056](0056-agenticrag-inspired-native-corrective-retrieval-and-recursive-hierarchical-lanes.md), for self-correction loops;
- [ADR 0058](0058-agenticrag-inspired-native-graph-navigation-and-discovery-provenance.md), for navigation steps.

## OntoIndex Review Evidence

- OntoIndex has `validateFindingLifecycle` and `hasFreshEvidence`, but these are restricted to the **Audit Lifecycle** (bugs) rather than a generalized **Discovery Proof** for architectural changes.
- Current graph edges focus on physical relationships (`CALLS`, `MEMBER_OF`). There are no logical/inferential edges like `SUPPORTS_HYPOTHESIS`.
- Session state tracks "Visited Nodes" but does not track the **Logical Model** (e.g., "The bug is caused by the buffer overflow in Module X") that the agent is trying to prove.

## Pruned Core Recommendations

These recommendations focus on adding **Logical Reasoning Structures** to the OntoIndex discovery core.

### 1. `DiscoveryHypothesis` Primitive
- **Capability:** A transient graph node that represents a logical statement or "Theory of the Task."
- **Native Surface:** `ontoindex/src/core/reasoning/hypothesis-manager.ts`.
- **Purpose:** Allow agents to store their "Current Best Theory" in the graph so it can be refined across turns and across agents.

### 2. Logical Inferential Edges (`SUPPORTS` / `REFUTES`)
- **Capability:** Native support for edges linking `RetrievalCandidate` (evidence) to a `DiscoveryHypothesis`.
- **Native Surface:** KuzuDB schema update for `LogicalRelation`.
- **Purpose:** Explicitly track which symbols contribute to a specific reasoning step, allowing for "Logical Pruning" of irrelevant retrieval candidates.

### 3. `InformationGapManifest` (Discovery Proof)
- **Capability:** A report that identifies "Missing Premisses" for a given hypothesis.
- **Native Surface:** `ontoindex/src/core/reasoning/gap-manifest.ts`.
- **Logic:** If Hypothesis H depends on Fact A and Fact B, and only A is found, the manifest emits a high-priority "Discovery Requirement" for Fact B.

### 4. `ChainOfSearch` (Thought-Search-Action Trace)
- **Capability:** A structural record of the `Observation -> Thought -> Search -> Refinement` loop.
- **Native Surface:** Extension of `DiscoveryFrontier` (ADR 0058).
- **Purpose:** Provide a "System 2" trace of the agent's logic, making complex multi-turn searches human-auditable.

### 5. `LogicalProofValidationGate`
- **Capability:** A core utility that evaluates if a set of retrieved evidence satisfies a logical predicate (e.g., "Does this set of candidates prove that the cache is thread-safe?").
- **Native Surface:** `ontoindex/src/core/reasoning/proof-gate.ts`.

### 6. `HallucinationCritic` (Faithfulness Scoring)
- **Capability:** A real-time metric calculated during `gn_safe_refactor` that measures how well the proposed `newBody` aligns with the cited `RetrievalCandidate` pool.
- **Logic:** Performs NLI or structural overlap checks to ensure no "Hallucinated" variables or logic are introduced that contradict known evidence.

### 7. `GroundingDiagnostic` (Evidence Gap Alert)
- **Capability:** A diagnostic that flags if an agent attempts to edit a module without having *first* retrieved its associated Tests or Documentation.
- **Purpose:** Forces agents to satisfy the logical proof requirements before proposing implementation changes.

### 8. `RetrievalRecallCritic` (Corrective RAG)
- **Capability:** A native evaluator that scores the `RetrievalCandidate[]` set for sufficiency against the query.
- **Verdict:** Returns `{ sufficiency: 'high' | 'ambiguous' | 'low', missingReason: string }`.

### 9. `AutonomousSelfCorrectionLoop`
- **Capability:** An internal loop in `backend-search.ts` that triggers a "Wide-Recall" fallback (synonym expansion, cluster search) if sufficiency is `low`.
- **Constraint:** Limited to 1 internal retry to maintain latency bounds (<200ms overhead).

## Decision

Implement the **Logical Discovery and Self-Correction Contract** to allow OntoIndex to treat retrieval as a premise for formal reasoning and verified refactors.

### Implementation Solution: Pure Contract First

1. **`HypothesisNode`**: Update KuzuDB initialization to support logical theory nodes.
2. **`RecallCriticReport`**: Extend the structured retrieval result to include a "Recall Verdict."
3. **`RefinementTrigger`**: An internal flag allowing `LocalBackend.query` to perform a second, expanded pass if confidence is low.
4. **`HallucinationScore`**: Add a `faithfulness` field to the refactor response envelope.
5. **`buildGapManifest`**: A core helper that computes the "Information Delta" between a theory and current evidence.
6. **`ReasoningCapability`**: Advertise "Reasoning" as a first-class capability in `gn_help`.
7. **`edge_context` Property**: Update the KuzuDB edge schema to mandate an indexed `context_id` property, simulating Quad-Store behavior to partition hypothesis facts.

## Rejected From Core

- **LLM-based Logic Evaluation:** The *generation* of the thought belongs to the Agent. The Core only provides the *storage* and *graph structure* for the logic.
- **Theorem Provers:** OntoIndex remains an engineering tool; formal mathematical proof verification is out of scope.
- **Interactive "Why" UI:** Visual reasoning trees are a frontend concern.

## Validation Gates

- `npm run build`
- Unit tests verifying that a `RetrievalCandidate` can be linked to a `HypothesisNode` via a `REFUTES` edge.
- Assertion that the `GapManifest` correctly identifies a missing implementation when an interface is found.
- Performance check for `ChainOfSearch` persistence (must not block the tool turn).
are a frontend concern.

## Validation Gates

- `npm run build`
- Unit tests verifying that a `RetrievalCandidate` can be linked to a `HypothesisNode` via a `REFUTES` edge.
- Assertion that the `GapManifest` correctly identifies a missing implementation when an interface is found.
- Performance check for `ChainOfSearch` persistence (must not block the tool turn).
