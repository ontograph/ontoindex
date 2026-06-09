# ADR 0074: Ontologx-inspired native formal ontologies and neurosymbolic reasoning

**Status:** Proposed
**Source:** Ontologx (GitHub: LucaCtt/ontologx) review, 2026-06-01
**External reference:** <https://github.com/LucaCtt/ontologx>

## Context

OntoIndex manages architectural intent through Semiotic Signs (ADR 0063), Perspective Lenses (ADR 0064), and Expert-Verified Domain Constraints (ADR 0072). While these primitives add high-signal meaning, they are still largely heuristic or reliant on manual expert tagging. OntoIndex lacks a mechanism to define **Architecture as Code** using formal, machine-readable logic, and it cannot enforce hard constraints on the graph using standardized web ontology languages.

The `ontologx` framework demonstrates a **Neurosymbolic** approach: using LLMs (Neural) for fuzzy mapping and data extraction, but anchoring them to strict, formal Ontologies (Symbolic) using Turtle (TTL) and SHACL (Shapes Constraint Language) to prevent hallucinations and enforce logical consistency.

This ADR extends:
- [ADR 0017](0017-audit-lifecycle-layer.md), for audit governance;
- semantic contracts;
- conceptual nodes;
- vertical domain profiles.

## OntoIndex Review Evidence

- OntoIndex semantic contracts (ADR 0033) check for graph invariant violations, but they are hardcoded in TypeScript. There is no support for a user-provided, standardized ruleset (like SHACL) that teams can author and version alongside their code.
- `ConceptualNode`s (ADR 0054) exist, but they are not backed by a formal RDF/OWL/TTL ontology. An agent cannot execute SPARQL-like queries or run a formal reasoner over the concept graph.
- LLM agent reasoning (ADR 0059) is entirely "Neural." If an agent misunderstands the architecture, the core has no "Symbolic" logic engine to formally reject the agent's premise before it modifies code.

## Pruned Core Recommendations

### 1. `FormalArchitectureOntology` (TTL Engine)
- **Capability:** A core subsystem that ingests W3C standardized Turtle (`.ttl`) or OWL files located in the repository (e.g., `.ontoindex/ontology.ttl`). These define the permitted nodes, edges, and domain concepts (e.g., "A `Controller` can only `CALL` a `Service`").
- **Native Surface:** `ontoindex/src/core/ontology/ttl-parser.ts`.
- **Purpose:** Provide a formal, machine-readable "Ground Truth" for the repository's architecture.

### 2. `GraphConstraintLinter` (SHACL Validator)
- **Capability:** A structural validator that maps KuzuDB graph data into an RDF representation in-memory to execute SHACL validation rules.
- **Native Surface:** `ontoindex/src/core/ontology/shacl-validator.ts`.
- **Purpose:** Automatically flag architectural violations (e.g., "Dependency Inversion broken") during indexing or safe-refactor checks.

### 3. `NeurosymbolicCorrectionLoop` (Agentic Guardrail)
- **Capability:** An interceptor for agentic proposals (ADR 0064 intents or ADR 0017 bundles). If an agent proposes a change that violates a SHACL constraint, this loop automatically bounces the proposal back to the LLM with the formal error message, forcing a correction before human review.
- **Native Surface:** `ontoindex/src/core/reasoning/neurosymbolic-guard.ts`.

### 4. `OntologicalGraphProjection` (Semantic Join)
- **Capability:** A background task that uses the Neural engine (LLM) to map ambiguous AST symbols (e.g., a function named `processData`) to a formal Symbolic node (e.g., `DataSanitizer` in the TTL file), storing the link as an `IMPLEMENTS_CONCEPT` edge.
- **Native Surface:** `ontoindex/src/core/ontology/concept-mapper.ts`.
### 5. `Ontology-Aware Handoff Artifacts`
- **Capability:** Include the repository's `.ttl` ontology in cross-repo handoff bundles (ADR 0061), allowing a consumer repo to "Inherit" the architectural rules of its upstream libraries.
- **Native Surface:** Extension of `handoff-manager.ts`.

### 6. `VerticalDomainProfile` (Core Specialization)
- **Capability:** A configuration-driven mode that re-weights the entire OntoIndex core (Retrieval, Audit, Impact) for a specific industry (e.g., `Safety-Critical`, `Fintech-Audit`) by activating a subset of TTL/SHACL constraints.
- **Native Surface:** `ontoindex/src/core/vertical/domain-manager.ts`.

### 7. `Constraint-Gated Reasoning` (Domain Invariants)
- **Capability:** A pre-check that forces agentic reasoning to remain within the "Rules" defined by a vertical profile's SHACL Shapes.
- **Native Surface:** `ontoindex/src/core/vertical/constraint-gate.ts`.
- **Example:** "In the `Fintech` profile, `Amount` variables must never be typed as `float`."

## Decision
### 6. `StandardValidationReportGraph` (Explainable Audits)
- **Capability:** Instead of returning generic error strings, the linter generates a formal `sh:ValidationReport` graph serialized as N-Triples/JSON-LD.
- **Native Surface:** `ontoindex/src/core/ontology/validation-report.ts`.
- **Purpose:** Agents can query the report graph to understand exactly which `sh:focusNode` failed which `sh:sourceShape`.

### 7. `SeverityGradedConstraints`
- **Capability:** Natively maps SHACL severities (`sh:Violation`, `sh:Warning`, `sh:Info`) to OntoIndex Audit Severities, allowing agents to prioritize critical architectural breaks over stylistic warnings.
- **Native Surface:** Extension of `shacl-validator.ts`.

## Decision

Implement the **Formal Ontologies and Neurosymbolic Reasoning Contract** to enable verifiable, logic-based architecture enforcement.

### Implementation Solution: Pure Contract First

1. **`OntologySidecar`**: Add a new sidecar (ADR 0015) responsible for parsing `.ttl` files and maintaining the `IMPLEMENTS_CONCEPT` mapping edges in KuzuDB.
2. **`gn_shacl_audit`**: Expose a new MCP tool that runs SHACL validation over the current workspace or a proposed PR diff (ADR 0020), returning standard JSON-LD/N-Triples validation reports.
3. **`ConstraintViolation`**: Update the `AuditFinding` schema to explicitly support formal SHACL validation errors as a first-class evidence type.

## Rejected From Core

- **Full RDF Database Migration**: We do not replace KuzuDB (Property Graph) with a pure RDF triple-store (like GraphDB). We project KuzuDB data into RDF only at validation time for SHACL rules, keeping the main graph optimized for Cypher and impact analysis.
- **Automatic TTL Generation**: We do not use LLMs to hallucinate the foundational `.ttl` files. The ontology must be authored (or at least approved) by human architects. The LLM only maps *code* to the *existing* ontology.

## Validation Gates

- `npm run build`
- Unit tests verifying that a `.ttl` parsing error gracefully falls back to heuristic modes.
- Assertion that the `GraphConstraintLinter` correctly flags a `Controller` calling a `Repository` if the SHACL shape forbids it.
- Performance check: In-memory RDF projection and SHACL validation for a 1,000-node subgraph must complete in <200ms.
