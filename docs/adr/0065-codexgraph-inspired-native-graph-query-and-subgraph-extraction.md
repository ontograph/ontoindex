# ADR 0065: Core graph schema manifest and subgraph context packaging

**Status:** Implemented (core subgraph context packaging)
**Source:** CodexGraph (Alibaba ModelScope-Agent) review, 2026-06-01; narrowed 2026-06-10
**External reference:** <https://arxiv.org/abs/2408.03910>

## Context

CodexGraph argues that agents should reason over a repository graph with explicit schema context and compact relational evidence, not only text snippets. That idea is useful for OntoIndex, but the original version of this ADR proposed too much adapter and MCP work as if it were missing core functionality.

OntoIndex already has direct graph-query surfaces:

- `ontoindex cypher <query>` is registered in `ontoindex/src/cli/index.ts`.
- CLI tool plumbing calls the backend `cypher` tool from `ontoindex/src/cli/tool.ts`.
- MCP/local backend Cypher support exists under `ontoindex/src/mcp/local/`.
- Cypher write blocking and pipeable JSON behavior are covered by integration tests.
- `ontoindex/src/core/cypher-limit.ts` already provides a top-level query limit guard.
- MCP resources already expose a graph schema reference for Cypher users.

The new core gap is narrower: OntoIndex lacks a pure, deterministic core utility that turns known graph schema and selected nodes/edges into a compact, bounded context object suitable for agent reasoning and downstream MCP/CLI surfaces.

## Challenge Findings

1. A new `gn_graph_query` or direct raw-Cypher tool is not new core functionality. The repository already exposes raw Cypher through CLI/MCP/backend paths and tests read-only enforcement.
2. Prompt-time schema injection is not core. It belongs in MCP/client startup layers after a core manifest exists.
3. Query execution, query repair, near-miss hints, ambiguity resolution, and template RAG are adapter behaviors. They should consume a core schema/subgraph contract later, not define the core contract.
4. Graph-path validation for refactors is a separate safety/refactor concern and should not be bundled into graph context packaging.
5. The ADR must not introduce Graph ORM, NL-to-Cypher, arbitrary write queries, or new agent prompt policy.

## Decision

Add one core extension: a deterministic graph schema manifest and subgraph context packager.

This keeps the CodexGraph value that is new for OntoIndex core:

- make graph shape explicit as data;
- compact selected graph evidence into a stable format;
- preserve token budget and truncation metadata;
- provide a reusable contract for later MCP, CLI, docs, and review surfaces.

## Core Functionality

Create a pure core module:

`ontoindex/src/core/graph/subgraph-context.ts`

The module should expose types similar to:

- `GraphSchemaManifestInput`
- `GraphSchemaManifest`
- `GraphSchemaNodeLabel`
- `GraphSchemaEdgeType`
- `SubgraphContextInput`
- `SubgraphContextNode`
- `SubgraphContextEdge`
- `SubgraphContextLimits`
- `SubgraphContextReport`
- `SubgraphContextFormat = "shape" | "triples" | "compact-json"`

The module should expose functions:

- `buildGraphSchemaManifest(input): GraphSchemaManifest`
- `buildSubgraphContext(input): SubgraphContextReport`

## Required Behavior

The core implementation must:

1. Accept supplied schema labels, edge types, properties, nodes, and edges.
2. Sort labels, edge types, nodes, edges, and properties deterministically.
3. Produce compact shape-style schema text.
4. Produce compact subgraph evidence as triples and/or compact JSON.
5. Enforce explicit limits for node count, edge count, property count, and rendered text length.
6. Return truncation metadata instead of silently dropping context.
7. Include enough source identifiers to let adapters trace each node/edge back to the graph rows that produced it.
8. Avoid all database access, Cypher parsing, MCP registration, CLI command registration, file reads, prompt injection, and LLM calls.

## Algorithm/Technique

The implementation should use a pure data-normalization pipeline:

1. Normalize input schema labels and edge types into maps keyed by stable string ids.
2. Normalize input nodes and edges into maps keyed by stable node/edge ids.
3. Sort all labels, edge types, properties, nodes, and edges lexicographically before rendering.
4. Apply limits after sorting so truncation is deterministic.
5. Render schema shape lines from normalized schema only, for example `Function {name,path} -CALLS-> Function`.
6. Render subgraph triples from normalized edges only, for example `Function:a CALLS Function:b`.
7. Render compact JSON with small arrays and short keys, preserving source ids and omitted counts.
8. Return a report containing:
   - requested limits;
   - observed counts before limits;
   - emitted counts after limits;
   - truncation flags;
   - rendered formats;
   - warnings for dangling edges or duplicate ids.

The module must not infer schema by querying Kuzu/LadybugDB. Any adapter that wants database-backed context must query elsewhere and pass rows into this pure module.

## Rejected From Core

- New `gn_graph_query` MCP tool.
- New direct Cypher execution path.
- New MCP/CLI wrappers.
- Prompt or system-message schema injection.
- Query-repair or near-miss suggestion engine.
- Semantic ambiguity resolver.
- Query-template retrieval from docs or `.ontoindex/queries`.
- Graph invariant checks for refactor workflows.
- NL-to-Cypher translation.
- Graph writes through `CREATE`, `MERGE`, `SET`, or `DELETE`.

These can be proposed later as adapters once the core manifest and context contract exists.

## Later Adapter Opportunities

After the core module lands, later ADRs or implementation tasks may add:

- an MCP tool that renders the schema manifest;
- an MCP/CLI adapter that runs an existing read-only Cypher query and feeds rows into `buildSubgraphContext`;
- a docs/debug view that shows compact graph evidence beside text evidence;
- query repair hints that reference the schema manifest;
- safe refactor checks that consume a precomputed subgraph context.

## Acceptance Criteria

1. `ontoindex/src/core/graph/subgraph-context.ts` exists and exports the public types/functions above.
2. The implementation is pure and deterministic.
3. The manifest builder handles supplied node labels, edge types, and property names without touching the graph database.
4. The subgraph packager handles supplied nodes/edges and emits bounded shape/triples/compact-json output.
5. Limit enforcement is visible in the returned report through counts and truncation flags.
6. Unit tests cover:
   - stable ordering;
   - schema manifest rendering;
   - triples and compact JSON rendering;
   - node/edge/property/text truncation;
   - empty input;
   - no DB/Cypher/MCP dependency.

## Validation Gates

- `cd ontoindex && npm test -- --run test/unit/graph-subgraph-context.test.ts`
- `cd ontoindex && npx tsc --noEmit --pretty false`

## Stop Conditions

Stop and re-review the ADR if implementation requires:

- adding a new MCP tool before the core module exists;
- executing Cypher inside the core module;
- changing graph storage schema;
- adding prompt policy;
- adding write-query support;
- broad refactor-safety logic unrelated to graph context packaging.
