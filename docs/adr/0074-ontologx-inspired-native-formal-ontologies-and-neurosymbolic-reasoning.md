# ADR 0074: Core ontology constraint validation report contract

**Status:** Implemented (core validation report contract)
**Source:** Ontologx (GitHub: LucaCtt/ontologx) review, narrowed 2026-06-10
**External reference:** <https://github.com/LucaCtt/ontologx>

## Context

Ontologx is useful as a reference for formal ontology workflows, but the original proposal mixed too many layers: Turtle parsing, OWL/RDF modeling, SHACL execution, LLM concept mapping, MCP tools, sidecars, audit schema changes, and vertical domain policy.

The current OntoIndex codebase already has deterministic semantic contract checks in `ontoindex/src/core/runtime/semantic-contracts.ts`, but it does not have a standard formal-constraint report contract that future ontology, policy, or audit layers can share.

Current review evidence:

- There is no `ontoindex/src/core/ontology/` implementation.
- There are no RDF, Turtle, OWL, SHACL, SPARQL, or JSON-LD package dependencies in the CLI package.
- There is no `gn_shacl_audit` MCP tool.
- ADR 0015 sidecar work is postponed, so this ADR must not depend on a new sidecar.
- Semantic contracts are pure TypeScript checks and do not emit SHACL-style validation reports.

## Challenge Findings

The original ADR should not be implemented as written.

1. A TTL/OWL parser is not a small core extension. It adds new syntax support, dependency policy, file discovery, error handling, and security surface.
2. A SHACL validator over the Kuzu graph requires RDF projection, graph query planning, dependency selection, and performance gates.
3. A neurosymbolic correction loop is an agent workflow, not a core graph primitive.
4. LLM concept mapping and `IMPLEMENTS_CONCEPT` graph writes are non-deterministic and need separate governance.
5. Ontology sidecars are blocked by the postponed sidecar ADR.
6. MCP tools such as `gn_shacl_audit` are adapters and must not be the first implementation target.
7. Vertical domain profiles and constraint gates are policy layers, not a minimum reusable core.
8. Audit schema changes belong to the audit lifecycle, not this first ontology slice.

## Decision

Add only one new core capability: a pure ontology constraint validation report contract.

This contract standardizes how future formal-constraint engines report failures, without adding a TTL parser, RDF store, SHACL runtime, LLM mapper, sidecar, MCP tool, or graph writer.

## Core Functionality

Create `ontoindex/src/core/ontology/validation-report.ts`.

The module should expose deterministic data structures and pure functions for composing SHACL-style reports from already-computed constraint findings.

Minimum API:

- `OntologyConstraintSeverity`: `violation`, `warning`, or `info`.
- `OntologyConstraintFindingInput`: one supplied finding with `focusNode`, `sourceShape`, optional `resultPath`, `message`, `severity`, optional `evidence`, and optional `metadata`.
- `OntologyConstraintValidationReport`: normalized report with `conforms`, sorted `results`, severity counts, truncation metadata, and stable render-ready fields.
- `buildOntologyValidationReport(input)`: pure report builder.
- `mapOntologyConstraintSeverityToAuditSeverity(severity)`: deterministic mapping to existing audit severity labels without importing audit lifecycle code.

## Algorithm/Technique

1. Validate each supplied finding with a narrow runtime guard:
   - required strings: `focusNode`, `sourceShape`, `message`;
   - optional string: `resultPath`;
   - severity default: `violation`;
   - unknown severities are rejected, not coerced.
2. Normalize each accepted finding into a stable report result:
   - trim whitespace;
   - preserve original evidence and metadata as opaque JSON-like values;
   - attach `auditSeverity` from the deterministic severity map.
3. Sort results by:
   - severity rank: `violation`, `warning`, `info`;
   - `focusNode`;
   - `sourceShape`;
   - `resultPath`;
   - `message`.
4. Apply limits after sorting:
   - `maxResults` truncates result count;
   - `maxRenderedBytes` truncates only optional rendered report text, not structured result records.
5. Compute report summary:
   - `conforms` is false when any untruncated or truncated input finding has severity `violation`;
   - counts are computed from all accepted input findings, not just visible results;
   - truncation metadata records omitted result count and rendered text truncation.
6. Return a plain object. Do not serialize RDF, JSON-LD, or N-Triples in this ADR.

## Required Behavior

- Accept supplied findings only; do not parse files, inspect the graph, call an LLM, or run an MCP tool.
- Normalize and sort results deterministically by severity, `focusNode`, `sourceShape`, `resultPath`, and `message`.
- Emit SHACL-style fields: `focusNode`, `sourceShape`, `resultPath`, `message`, and `severity`.
- Map severities as:
  - `violation` -> `HIGH`
  - `warning` -> `MEDIUM`
  - `info` -> `LOW`
- Return `conforms: true` only when there are no `violation` findings.
- Enforce configurable limits for maximum result count and maximum rendered text bytes.
- Return explicit truncation metadata when limits are applied.
- Keep the module dependency-free beyond existing project utilities.

## Rejected From This ADR

- TTL, RDF, OWL, SPARQL, JSON-LD, or SHACL parsing.
- In-memory RDF projection from Kuzu graph data.
- New database tables, graph edges, or schema migrations.
- Automatic ontology generation.
- LLM-based concept mapping.
- Agent correction loops.
- MCP tools and resources.
- Sidecar storage or migration.
- Vertical domain profiles.
- Audit finding schema changes.

## Later Adapter Opportunities

Future ADRs may connect this core report contract to:

- A real SHACL validator.
- A repository-authored ontology file.
- MCP audit tools.
- Audit lifecycle findings.
- Guided refactor or pre-commit gates.
- Domain-specific architecture policy packs.

Those adapters must consume this report contract instead of defining competing report shapes.

## Acceptance Criteria

- The new module is pure TypeScript and has no runtime dependency on RDF or SHACL packages.
- Unit tests cover empty reports, severity mapping, deterministic ordering, limit truncation, and mixed-severity `conforms` behavior.
- The public API can be used by semantic contracts or a future SHACL adapter without importing MCP, graph database, or LLM code.
- No existing semantic contract behavior changes.

## Consequences

- OntoIndex gains a reusable core report shape for formal constraint failures without committing to a specific ontology engine.
- Future SHACL/RDF/MCP work has a stable integration target and cannot introduce a competing validation report shape without a new ADR.
- The first implementation is intentionally modest: it improves evidence structure, not reasoning power.
- Users still need a separate validator or semantic-contract producer to generate findings.

## Validation Gates

- `cd ontoindex && npm test -- --run test/unit/ontology-validation-report.test.ts`
- `cd ontoindex && npx tsc --noEmit --pretty false`

## Stop Conditions

Stop and write a separate ADR if implementation requires:

- Adding RDF, SHACL, Turtle, OWL, SPARQL, or JSON-LD dependencies.
- Reading ontology files from disk.
- Querying Kuzu or writing graph edges.
- Adding an MCP tool.
- Changing the audit finding schema.
- Calling an LLM.
