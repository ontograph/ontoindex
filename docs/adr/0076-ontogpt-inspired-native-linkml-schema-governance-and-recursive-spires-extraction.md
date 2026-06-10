# ADR 0076: Core schema-guided recursive extraction bundle contract

**Status:** Implemented (core schema-guided extraction contract)
**Source:** OntoGPT review; narrowed 2026-06-10
**External reference:** <https://github.com/monarch-initiative/ontogpt>

## Context

OntoGPT is useful as a reference because it combines schema-first modeling with schema-guided extraction from unstructured text. The original ADR mixed several layers: LinkML as a source of truth, SPIRES prompt generation, recursive LLM extraction, persistent URI grounding, schema-to-prompt generation, validation, redaction, sidecars, shared packages, and a new MCP grounding tool.

That scope is too broad for a core ADR. OntoIndex already has separate surfaces for graph schema manifests, semantic contracts, ontology validation reports, hypothesis grounding, audit lifecycle, MCP tool contracts, and sidecar enrichment. This ADR must add only new core functionality and must not reopen adapter, sidecar, graph-storage, or LLM decisions.

Current codebase evidence:

- `ontoindex/src/core/graph/subgraph-context.ts` already exposes `buildGraphSchemaManifest` and `buildSubgraphContext`.
- `ontoindex/src/core/ontology/validation-report.ts` already owns ontology-style validation report composition.
- `ontoindex/src/core/reasoning/hypothesis-grounding.ts` already owns evidence-to-logic grounding reports.
- `ontoindex/src/core/contract/versions.ts` already tracks coarse contract versions.
- `js-yaml` and `zod` are available dependencies, but there is no LinkML, SPIRES, JSON-LD, RDF, or ontology-parser dependency.
- Source search found no `LinkML`, `SPIRES`, `schema-guided extraction`, `ExtractionBundle`, or `SchemaGuidedExtraction` core module.
- The local OntoIndex index is up to date at commit `1b0e8ce`.

## Challenge Findings

The previous ADR should not be implemented as written.

1. LinkML-as-source-of-truth would require schema migration strategy, code generation, Kuzu DDL generation, MCP JSON-schema generation, and cross-package release governance.
2. SPIRES extraction is an LLM/prompt workflow, not a deterministic core primitive.
3. A post-index extraction sidecar is blocked by the postponed sidecar ADR and must not be smuggled into this scope.
4. Persistent URI grounding overlaps with existing identity, graph, summary-tree grounding, and future ontology decisions.
5. Schema-to-prompt generation is an adapter concern and would couple core to prompts.
6. Redaction-by-schema is useful but belongs to audit/context rendering policy, not this first core slice.
7. A new `gn_ground_symbol` tool is an MCP adapter and must not be the implementation target.
8. LinkML mixins, inheritance, and DDL generation are build/governance work, not a small core extension.

## Decision

Add only one new core capability: a schema-guided recursive extraction bundle contract.

The contract accepts a small OntoIndex-native extraction schema and already-extracted candidate objects, then returns a deterministic validation and normalization report. It does not parse LinkML, generate prompts, call an LLM, read Markdown, query the graph, write sidecar data, create URIs, or generate database schemas.

## Core Functionality

Create `ontoindex/src/core/extraction/schema-guided-extraction.ts`.

The module should expose deterministic data structures and pure functions for validating nested extraction bundles before an adapter decides whether to persist or render them.

Minimum API:

- `ExtractionScalarType`: `string`, `number`, `boolean`, or `object`.
- `ExtractionSlotSchema`: slot name, range, required flag, repeated flag, optional enum values, optional sensitivity marker.
- `ExtractionClassSchema`: class name and slots.
- `ExtractionSchemaDocument`: schema id, version, root class, and classes.
- `ExtractionCandidate`: candidate id, class name, fields, optional source span, optional confidence, optional metadata.
- `ExtractionBundleInput`: schema document, candidates, optional limits.
- `ExtractionValidationIssue`: deterministic issue with candidate id, path, code, severity, and message.
- `ExtractionBundleReport`: normalized candidates, issues, summary counts, redaction manifest, truncation metadata.
- `buildSchemaGuidedExtractionReport(input)`: pure report builder.

## Algorithm/Technique

1. Validate the schema document:
   - schema id, version, root class, class names, and slot names must be non-empty strings;
   - root class must exist;
   - slot ranges must refer to scalar types or known class names;
   - repeated and required flags default to false.
2. Normalize candidates:
   - trim candidate id and class name;
   - reject unknown candidate classes with an issue instead of throwing;
   - preserve source span and metadata as opaque values;
   - sort candidates deterministically by class name and id.
3. Validate fields recursively:
   - required missing fields produce `error`;
   - scalar range mismatches produce `error`;
   - unknown fields produce `warning`;
   - enum mismatches produce `error`;
   - repeated slots must be arrays and validate each element;
   - object slots must match the referenced class schema.
4. Build a redaction manifest:
   - any slot marked sensitive emits a path in the manifest;
   - the function does not redact values directly unless a future adapter opts in.
5. Enforce limits:
   - `maxCandidates` limits emitted normalized candidates;
   - `maxIssues` limits emitted issues;
   - counts are computed from the full accepted input, not just emitted rows.
6. Return a plain object with deterministic ordering and no side effects.

## Required Behavior

- Pure TypeScript only.
- No imports from `ontoindex/src/mcp/**`.
- No LinkML parser, SPIRES prompt engine, JSON-LD/RDF/OWL support, graph/Kuzu access, file-system access, sidecar access, web access, or LLM calls.
- No package dependency additions.
- Deterministic output for identical input.
- Explicit validation issues instead of hidden coercion.
- Preserve adapter metadata as opaque values.
- Keep redaction as manifest generation only.

## Rejected From This ADR

- LinkML YAML source of truth.
- LinkML-to-TypeScript, LinkML-to-Kuzu, or LinkML-to-MCP schema generation.
- SPIRES prompt generation.
- Recursive LLM extraction.
- Markdown or comment parsing.
- Persistent URI grounding.
- MCP tools such as `gn_ground_symbol`.
- Post-index extraction sidecar.
- Runtime graph writes.
- Audit lifecycle schema changes.
- Schema-driven prompt redaction or context rendering.

## Later Adapter Opportunities

Future adapters may call `buildSchemaGuidedExtractionReport` after they collect extracted objects from Markdown, comments, LLMs, or sidecars. Those adapters must provide the schema and candidates explicitly.

Possible later integrations:

- A LinkML adapter can translate a vetted LinkML subset into `ExtractionSchemaDocument`.
- A SPIRES adapter can use the schema to build prompts, then validate model output with this report builder.
- A docs sidecar can feed candidate objects into this core contract.
- A redaction renderer can consume the redaction manifest before sending context to an agent.

## Acceptance Criteria

- New module exists at `ontoindex/src/core/extraction/schema-guided-extraction.ts`.
- Focused unit tests exist at `ontoindex/test/unit/schema-guided-extraction.test.ts`.
- Tests cover schema validation, nested object validation, repeated slots, required fields, enum validation, unknown fields, deterministic ordering, issue limits, candidate limits, redaction manifest generation, and absence of forbidden imports.
- Existing graph schema, ontology validation, hypothesis grounding, MCP mode, and sidecar tests remain unchanged.
- No package dependencies are added.

## Validation Gates

- `cd ontoindex && npm test -- --run test/unit/schema-guided-extraction.test.ts`
- `cd ontoindex && npx tsc --noEmit --pretty false`
- `git diff --check -- docs/adr/0076-ontogpt-inspired-native-linkml-schema-governance-and-recursive-spires-extraction.md docs/adr/0000-index.md ontoindex/src/core/extraction/schema-guided-extraction.ts ontoindex/test/unit/schema-guided-extraction.test.ts`

## Consequences

Positive:

- OntoIndex gains a reusable core contract for validating nested extracted facts.
- LinkML and SPIRES ideas remain possible later without committing core to a parser or LLM workflow.
- Redaction-sensitive schema annotations can be represented without changing context rendering yet.

Negative:

- This does not make LinkML the source of truth.
- This does not extract facts from Markdown by itself.
- Adapters still need to collect text, run extraction, and decide persistence policy.

## Stop Conditions

Stop and write a separate ADR if implementation requires:

- adding LinkML, RDF, JSON-LD, SHACL, OWL, or SPIRES dependencies;
- parsing files from disk;
- generating prompts;
- calling an LLM;
- querying or writing Kuzu/LadybugDB;
- adding a sidecar;
- adding an MCP tool;
- changing graph schema or audit schema;
- changing redaction rendering behavior.
