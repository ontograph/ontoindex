# ADR 0076: OntoGPT-inspired native LinkML schema governance and recursive SPIRES extraction

**Status:** Proposed
**Source:** OntoGPT (GitHub: monarch-initiative/ontogpt) review, 2026-06-01
**External reference:** <https://github.com/monarch-initiative/ontogpt>

## Context

OntoIndex manages a complex, multi-modal knowledge graph containing AST symbols, architectural semiotics (ADR 0063), and formal ontologies (ADR 0074). Currently, the graph schema is defined implicitly in TypeScript and KuzuDB setup scripts, and architectural rules are enforced via hardcoded semantic contracts (ADR 0033) or external SHACL files. Furthermore, extracting structured meaning from "unstructured" sources—like verbose Markdown docs or legacy code comments—is performed using ad-hoc LLM prompts that often suffer from drift or lack of rigorous validation.

The `ontogpt` framework introduces a more robust approach: **LinkML (Linked Data Modeling Language)** as a unified schema-as-code backbone, and **SPIRES (Structured Prompt Interrogation and Recursive Extraction of Semantics)** as a zero-shot, schema-guided method for recursive knowledge extraction. By adopting these, OntoIndex can move to a "Schema-First" architecture where the graph structure, the extraction prompts, and the validation logic are all derived from a single, versioned source of truth.

This ADR extends:
- [ADR 0015](0015-post-index-enrichment-sidecar.md), for post-index sidecars;
- [ADR 0033](0033-neosemantics-inspired-semantic-contract-checks.md), for semantic contracts;
- [ADR 0063](0063-nouz-inspired-native-architectural-semiotics-and-meaning-profile-aggregation.md), for semiotic signs;
- [ADR 0074](0074-ontologx-inspired-native-formal-ontologies-and-neurosymbolic-reasoning.md), for formal ontologies.

## OntoIndex Review Evidence

- OntoIndex lacks a unified **Schema Modeling Language**. Adding a new node type requires manual updates to TypeScript interfaces, KuzuDB DDL, and MCP tool schemas.
- Current documentation parsing is "Flat." We struggle to extract nested, multi-layered data (e.g., "The `Auth` module implements `Pattern X` which has `Constraint Y` and `Requirement Z`") from Markdown without significant token waste or hallucination.
- Symbol identity is primarily file-and-name-based. We lack a native core surface for **Persistent URI Grounding** (OAK-style), making it difficult to maintain stable references to symbols and decisions (ADR 0072) as code is refactored across files.

## Pruned Core Recommendations

### 1. `LinkML-Driven Schema Core` (Unified Modeling)
- **Capability:** A core subsystem that uses LinkML YAML to define the OntoIndex graph schema (Node types, Slots/Properties, and Enum domains).
- **Native Surface:** `ontoindex/src/core/schema/linkml-definitions.yaml`.
- **Purpose:** Automatically generate the TypeScript types, KuzuDB schemas, and MCP JSON-Schema definitions from a single source, ensuring "Schema Parity" across the entire stack.

### 2. `SPIRES-Extraction Engine` (Recursive Interrogation)
- **Capability:** A specialized extraction service that transforms a LinkML schema and unstructured text (Markdown/Comments) into a structured LLM prompt using the SPIRES "Interrogation" template.
- **Native Surface:** `ontoindex/src/core/extraction/spires-engine.ts`.
- **Logic:** Enables recursive extraction, where a parent object (e.g., `Module`) automatically triggers sub-interrogations for its children (e.g., `Invariants`, `SideEffects`).

### 3. `Persistent URI Grounding` (OAK Lane)
- **Capability:** A mapping facility that assigns stable, globally unique URIs (e.g., `ontoindex:symbol/auth/v1/Validator`) to every code symbol, documentation requirement, and architectural decision.
- **Native Surface:** `ontoindex/src/core/ontology/grounding-manager.ts`.
- **Purpose:** Enable long-term "Decisional Memory" and cross-repo referencing (ADR 0061) that survives file renames.

### 4. `Schema-to-Prompt Bridge`
- **Capability:** A utility that programmatically generates "System Prompts" for agentic tools (ADR 0025) directly from the LinkML schema, ensuring the agent's internal model of the data matches the system's structural constraints.
- **Native Surface:** `ontoindex/src/core/schema/prompt-generator.ts`.

### 5. `Multi-Layered Data Validator`
- **Capability:** A runtime validator that checks LLM-extracted data against LinkML constraints (Types, Ranges, Required fields) before it is committed to the graph.
- **Native Surface:** `ontoindex/src/core/schema/linkml-validator.ts`.

### 6. `LinkMLMixinsAndInheritance` (DRY Graph Definition)
- **Capability:** Leverage LinkML's `mixins` and `slots` inheritance to clean up the KuzuDB node definitions (e.g., instead of repeating `timestamp` on every node, apply a `HasTimestamp` mixin).
- **Native Surface:** Extension of `linkml-definitions.yaml`.

### 7. `SchemaDrivenRedaction` (Agent Masking)
- **Capability:** Use LinkML slot annotations (e.g., `annotations: { sensitive: true }`) to automatically strip fields from the graph *before* they are sent to an LLM context window.
- **Native Surface:** `ontoindex/src/core/schema/redaction-filter.ts`.

## Decision

Implement the **LinkML Schema Governance and SPIRES Extraction Contract** to unify OntoIndex knowledge representation and improve extraction fidelity.

### Implementation Solution: Pure Contract First

1. **`LinkMLSource`**: Establish the `ontoindex-shared/src/schema/linkml/` folder as the source of truth for all graph entities.
2. **`ExtractionSidecar`**: Register a post-index sidecar that runs the SPIRES engine over Markdown documentation to extract structured architectural facts.
3. **`gn_ground_symbol`**: A new internal tool for assigning and resolving persistent URIs for graph nodes.

## Rejected From Core

- **Dynamic Schema Evolution**: We use LinkML for *static* schema definition and versioning. We do not allow agents to dynamically modify the LinkML YAML at runtime.
- **Direct LinkML-to-Neo4j/Kuzu DDL Generation**: We use LinkML to define the *structure*; the actual KuzuDB DDL generation is a separate, human-vetted build step to ensure database performance.

## Validation Gates

- `npm run build`
- Unit tests verifying that the SPIRES engine correctly extracts a nested `SideEffect` object from a Markdown comment.
- Assertion that the `LinkML-to-TypeScript` generator produces types that match the existing hand-authored interfaces.
- Performance check: LinkML-based validation of an extraction bundle must complete in <50ms to avoid blocking tool turns.
