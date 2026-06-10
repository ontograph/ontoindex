# ADR 0081: Core virtual source mapping and anytime result envelopes

**Status:** Implemented (core virtual mapping and anytime envelope contracts)
**Source:** OpenLink Virtuoso review; narrowed 2026-06-10
**External reference:** <https://github.com/openlink/virtuoso-opensource>

## Context

Virtuoso is useful as a reference because it treats heterogeneous data as queryable views and keeps
long-running queries usable through partial results. Those ideas are relevant to OntoIndex, but only
as graph-core contracts.

OntoIndex should not copy Virtuoso as a universal database server, SQL/RDF engine, web-data sponger,
or federated query optimizer. OntoIndex already has:

- graph execution adapters and an `IndexStore` port;
- typed query parsing and structured retrieval composition;
- query budget snapshots with truncation, degraded reasons, steps, and token-cost fields;
- query diagnostics and freshness/capability health;
- semantic cache and semantic ANN frontier adapters;
- evidence/read ledgers, grounding reports, and graph context packaging.

The remaining new core gap is smaller: OntoIndex lacks a pure contract that can describe external
data sources as graph-shaped virtual mappings and wrap partial retrieval/query results in a
deterministic anytime envelope.

## Current OntoIndex Evidence

Existing code already covers several parts of the original ADR:

- `ontoindex/src/core/runtime/query-budget.ts` defines `QueryBudgetSnapshot`, timeout fields,
  truncation reasons, degraded reasons, phase steps, and token cost snapshots.
- `ontoindex/src/core/runtime/query-diagnostics.ts` defines `QueryExecutionDiagnostics`,
  freshness, capability health, lane state, cache status, truncation, degradation, and timing.
- `ontoindex/src/core/search/retrieval-context-composition.ts` already composes tiered retrieval
  candidates with provenance, related symbols, freshness, truncation, and warnings.
- `ontoindex/src/core/search/semantic-cache.ts` already implements a filesystem-backed semantic
  retrieval cache.
- `ontoindex/src/core/search/semantic-frontier-adapter.ts` already adapts ANN neighbor edges into
  semantic frontier search.
- OntoIndex context shows `createQueryBudgetSnapshot` is already consumed by cross-impact,
  review-diff, and query-budget tests.
- Local OntoIndex search finds existing graph execution symbols such as `executeQuery` and the
  shared `IndexStore` port, but no dedicated virtual source mapping contract or anytime
  result-envelope contract.
- Source search found no existing `virtual-source-mapping`, `anytime-result-envelope`,
  `sponger`, or `polyglot` core module; the only current `virtual-*` core file is ADR 0079's
  unrelated virtual diff selection contract.

Those existing surfaces must be reused. ADR 0081 should not re-plan generic query budgets,
semantic caching, ANN frontier search, or graph execution.

### OntoIndex Evidence Check

This ADR was challenged with local OntoIndex and source reads:

```bash
ONTOINDEX_MAX_WORKERS=7 node /opt/demodb/_workfolder/OntoIndex/ontoindex/dist/cli/index.js status
ONTOINDEX_MAX_WORKERS=7 node /opt/demodb/_workfolder/OntoIndex/ontoindex/dist/cli/index.js query "virtual view anytime query partial result query budget sponger polyglot router external sql sqlite duckdb structured retrieval" --repo OntoIndex --limit 12
ONTOINDEX_MAX_WORKERS=7 node /opt/demodb/_workfolder/OntoIndex/ontoindex/dist/cli/index.js query "virtual source mapping anytime result envelope QueryBudgetSnapshot QueryExecutionDiagnostics external-source partial slices" --repo OntoIndex --limit 12
ONTOINDEX_MAX_WORKERS=7 node /opt/demodb/_workfolder/OntoIndex/ontoindex/dist/cli/index.js context createQueryBudgetSnapshot --repo OntoIndex
rg -n "QueryBudget|Partial|partial|timeout|Timeout|budget|truncated|degraded|VirtualView|virtual view|sponger|polyglot|sqlite|duckdb|external" ontoindex/src/core ontoindex/src/mcp/local ontoindex/src/mcp/shared ontoindex/src/storage
find ontoindex/src/core ontoindex-shared/src -type f \( -name '*virtual*' -o -name '*anytime*' -o -name '*sponger*' -o -name '*polyglot*' \) | sort
```

## Challenge Findings

1. A real SQL/graph federated query engine is not a core v1 extension.
2. Translating arbitrary Cypher into SQL is too broad and storage-specific for a pure core module.
3. Runtime "sponging" of URLs/log systems requires network, trust, auth, parsing, and sandbox
   policy; it should not be part of core.
4. `QueryBudgetSnapshot` already handles timeout/truncation/degradation. The new work must extend
   result shape, not duplicate budget logic.
5. Updating all retrieval envelopes before a pure partial-result contract exists would be too broad.
6. Statistical incomplete aggregation estimates need real sampling guarantees; they should not land
   as a string flag without a validation model.
7. The useful core increment is a deterministic planning/reporting layer that adapters can consume
   later.

## Decision

Add one core extension: pure virtual source mapping and anytime result-envelope contracts.

This keeps only the parts of the Virtuoso review that are new to OntoIndex core:

- describe external tabular/document/log sources as graph-shaped virtual nodes and relationships;
- validate mapping definitions without opening external databases;
- describe which parts of a query/retrieval result are complete, partial, skipped, or exhausted;
- compose partial result slices with existing `QueryBudgetSnapshot` and `QueryExecutionDiagnostics`
  concepts.

## Core Functionality

Create pure modules:

- `ontoindex/src/core/search/virtual-source-mapping.ts`
- `ontoindex/src/core/runtime/anytime-result-envelope.ts`

The modules should expose types and builders similar to:

- `VirtualSourceMapping`
- `VirtualSourceDefinition`
- `VirtualNodeProjection`
- `VirtualRelationshipProjection`
- `VirtualFieldMapping`
- `VirtualSourceValidationReport`
- `AnytimeResultEnvelope`
- `AnytimeResultSlice`
- `AnytimeCompleteness`
- `AnytimeExhaustedResource`
- `AnytimeResultDiagnostic`

## Required Behavior

The virtual source mapping implementation must:

1. Accept supplied source definitions and graph projection definitions.
2. Support source kinds such as `sqlite`, `duckdb`, `jsonl`, `csv`, `http-json`, and `custom`
   as labels only; it must not connect to those sources.
3. Validate that each virtual node projection has a stable graph label, source name, primary key,
   and field mappings.
4. Validate that each virtual relationship projection has source/target node references,
   relationship type, and join fields.
5. Normalize mapping identities deterministically by source name, projection kind, graph label/type,
   and primary key/join fields.
6. Report duplicate projections, missing sources, missing primary keys, unsupported source kinds,
   invalid labels, and dangling relationship endpoints as structured diagnostics.
7. Return deterministic summaries by source kind, node label, relationship type, and diagnostic
   severity.
8. Stay pure: no filesystem reads/writes, no database access, no network access, no environment
   reads, no timers, no random values, no MCP transport calls, and no LLM calls.

The anytime result envelope implementation must:

1. Accept supplied result slices from graph, lexical, vector, semantic frontier, docs, or virtual
   source lanes.
2. Preserve existing result payloads opaquely; the core module should not know query-row shape.
3. Attach completeness state to every slice: `complete`, `partial`, `skipped`, or `failed`.
4. Support exhausted resources such as `time`, `nodes`, `edges`, `candidates`, `bytes`,
   `external-source`, and `unknown`.
5. Merge slice diagnostics into an envelope-level summary.
6. Derive `isPartial` from supplied slice states, exhausted resources, and budget truncation.
7. Preserve existing `QueryBudgetSnapshot` when supplied, instead of creating a parallel budget
   schema.
8. Return deterministic counts by lane, completeness, exhausted resource, and severity.
9. Enforce optional max-slices and max-diagnostics limits with truncation diagnostics.
10. Stay pure: no query execution, no timers, no database access, no filesystem access, no network
    access, no MCP transport calls, and no LLM calls.

## Algorithm/Technique

Use stable normalization and aggregation:

1. Normalize source names, projection names, graph labels, relationship types, field names, and
   source kinds by trimming strings and preserving original display names.
2. Reject or warn on unsupported mapping shapes while still returning a bounded validation report.
3. Build projection IDs from stable mapping keys rather than insertion order.
4. Sort sources, projections, diagnostics, and summaries by stable string keys.
5. For anytime envelopes, normalize every slice to `{ lane, completeness, exhaustedResources,
   emittedCount, payload, diagnostics }`.
6. Derive envelope partiality from any non-complete slice, any exhausted resource, or any truncated
   budget.
7. Preserve opaque payload references by value-copying shallow metadata only; do not mutate caller
   arrays.
8. Emit deterministic diagnostics for invalid lane names, invalid completeness values, duplicate
   slice IDs, and limit truncation.

## Rejected From Core

- Building a universal SQL/RDF/graph database.
- Translating arbitrary Cypher or graph query ASTs into SQL.
- Opening SQLite/DuckDB/ClickHouse/Postgres connections from core.
- Network fetchers, URL sponging, auth handling, or live API/document scraping.
- A public `gn_sponger_fetch` tool before a pure mapping/envelope contract exists.
- Statistical incomplete aggregation estimates without a validated sampling model.
- Changing existing retrieval candidates or MCP response envelopes in the first implementation.
- Adding persistent `.vview.yaml` loading before the in-memory mapping contract is stable.
- Adding wall-clock timeout enforcement in the pure module.

## Later Adapter Opportunities

After the pure contracts land, later work may:

- load `.vview.yaml` or `.vview.json` files into `VirtualSourceMapping`;
- add SQLite/DuckDB adapters that consume validated mappings;
- expose mapping validation through CLI or MCP;
- wrap selected retrieval/search surfaces with `AnytimeResultEnvelope`;
- connect external evidence fetchers under explicit trust and network policies;
- add replay cases for partial-result behavior before changing default retrieval envelopes.

## Acceptance Criteria

1. The two core modules exist and export the public contracts above.
2. Unit tests cover valid virtual source mapping normalization and summaries.
3. Unit tests cover duplicate projections, dangling relationships, unsupported source kinds, and
   invalid labels.
4. Unit tests cover anytime envelope partiality from slice state, exhausted resources, and budget
   truncation.
5. Unit tests cover lane/completeness/resource summaries and diagnostic truncation.
6. Unit tests prove caller input arrays are not mutated.
7. The implementation has no filesystem, database, network, MCP, environment, timer, random, or LLM
   dependency.

## Validation Gates

- `cd ontoindex && npm test -- --run test/unit/virtual-source-mapping.test.ts`
- `cd ontoindex && npm test -- --run test/unit/anytime-result-envelope.test.ts`
- `cd ontoindex && npx tsc --noEmit --pretty false`

## Stop Conditions

Stop and re-review the ADR if implementation requires:

- executing SQL or Cypher;
- connecting to an external database or API;
- adding network fetch behavior;
- modifying MCP tool contracts;
- changing `RetrievalCandidate` or `StructuredRetrievalResult` globally;
- adding wall-clock timers or timeout enforcement in the pure modules;
- persisting or loading `.vview.*` files before the in-memory contract exists.

## Implementation Status

Implemented for the pure core contracts.

Implemented in:

- `ontoindex/src/core/search/virtual-source-mapping.ts`
- `ontoindex/src/core/runtime/anytime-result-envelope.ts`
- `ontoindex/test/unit/virtual-source-mapping.test.ts`
- `ontoindex/test/unit/anytime-result-envelope.test.ts`

The implementation remains deliberately adapter-free: it does not execute SQL or Cypher, connect to
databases or APIs, fetch network resources, add MCP tools, read/write files, read environment
variables, use timers or random values, call an LLM, or change existing retrieval/MCP envelopes.
