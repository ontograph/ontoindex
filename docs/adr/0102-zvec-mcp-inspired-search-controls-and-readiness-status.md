# ADR 0102: zvec-mcp-Inspired Search Controls and Readiness Status

Status: Partially implemented
Date: 2026-06-25
Source reviewed: `./tmp/zvec-mcp`

## Decision

Keep only four donor ideas from `./tmp/zvec-mcp`, and only as extensions to existing OntoIndex
core surfaces:

1. add path-scoped include/exclude filters to the existing public semantic query/search contracts;
2. add a bounded additive explanation field to existing semantic query/search output;
3. add a small fallback ranking penalty for generic app-shell entry files when higher-signal
   evidence is absent;
4. clarify runtime status by separating "backend is readable now" from "analyze is active" or
   "analysis metadata shows a partial/in-progress run" in existing status and diagnose surfaces.

Implementation status on 2026-06-25:

- implemented in `v1.9.28`: path-scoped include/exclude filters on existing semantic query/search
  contracts; bounded explanation fields on symbol-level semantic results; generic entry-file
  fallback reorder
- still open: runtime status and diagnose wording clarification

Do not import the donor's storage model, chunk index lifecycle, watcher pipeline, single-file MCP
server shape, or embedding fallback behavior.

## Architecture Fit Gate

### Real New Functionality

Approved:

- semantic search path filters on existing OntoIndex query/search surfaces;
- a user-visible additive explanation field derived from existing score components and evidence
  already present in OntoIndex retrieval;
- a narrow generic-entry-file penalty in the existing fallback ranking path;
- clearer "backend readable vs analyze/checkpoint state" runtime-health reporting for MCP and CLI
  status.

Rejected:

- a separate project-local semantic side index;
- a new MCP tool family for project knowledge search;
- donor-style `initialize_project_knowledge`, `index_file`, or `get_knowledge_status` tools;
- donor-style delete-before-reindex chunk lifecycle;
- zero-vector fallback on embedding failure;
- copying donor chunking, file watching, or direct per-file refresh behavior into OntoIndex core.

### Core Extension

This ADR extends existing OntoIndex owners only:

- `ontoindex/src/mcp/local/backend-search.ts` for semantic retrieval, ranking, and result shaping;
- `ontoindex/src/mcp/tools.ts`, `ontoindex/src/cli/tool.ts`, and MCP `search(action="semantic")`
  / CLI `query` contracts for path-filter and explanation parameters;
- `ontoindex/src/mcp/local/local-backend.ts` for search-response plumbing when explanations are
  included;
- `ontoindex/src/core/runtime/runtime-health.ts`, `ontoindex/src/mcp/super/diagnose.ts`, and
  `ontoindex/src/mcp/super/ensure-fresh.ts` for readiness/status clarification;
- existing retrieval diagnostics and response envelopes for any new explanation or fallback fields.

It fails the core-extension gate if implemented as a second semantic system, new MCP search
namespace, per-file indexing lane, or donor-style startup/index orchestration path.

## Context

The donor repo is a small stdio MCP server backed by a repo-local zvec database. It exposes:

- semantic search with `include_paths` / `exclude_paths`;
- explanation strings per search result;
- a simple heuristic re-ranker that suppresses generic app entry files;
- initialization/readiness status that can report usable storage before full indexing completes.

Those ideas are only partially relevant to OntoIndex.

Current OntoIndex already has the larger architecture in place:

- semantic search and hybrid ranking in `ontoindex/src/mcp/local/backend-search.ts`;
- CE reranking and retrieval diagnostics already present in the search stack;
- explanation plumbing already exists in local enrichment and several report surfaces;
- runtime-health, freshness, and embeddings diagnostics already exist in `status`, `gn_diagnose`,
  and `gn_ensure_fresh`;
- lock handling, WAL recovery, and backend-readiness logic already exist in LadybugDB adapters and
  runtime-health paths.

This means most donor mechanisms are duplicates, not missing capability.

## Evidence Review

### Donor ideas that survive

1. Path-scoped search filters

The donor exposes `include_paths` and `exclude_paths` on semantic search and applies them after
retrieval but before final ranking output. That is useful operator control for bounded code search
and does not require a new tool.

Donor evidence:

- `tmp/zvec-mcp/README.md`
- `tmp/zvec-mcp/zvec-mcp-bridge.js`

OntoIndex fit:

- extend current public semantic search contracts rather than adding a second search API;
- keep the existing retrieval stack;
- define filtering semantics explicitly for process-grouped results.

Required narrowing before implementation:

- pick the public owners explicitly: CLI `query` and MCP `search(action="semantic")`;
- define whether filters apply to:
  - candidate symbols before grouping;
  - emitted `definitions` / `process_symbols` only; or
  - whole `processes` when no surviving symbol remains in scope.

Without that, this item has not fully passed the core-extension gate.

2. Result explanations

The donor builds short explanation strings from matched query terms and domain hints. OntoIndex
already has richer internal score/evidence components than the donor, so the right move is to
surface a compact explanation from existing data rather than copy the donor heuristic verbatim.

Donor evidence:

- `tmp/zvec-mcp/zvec-mcp-bridge.js`

OntoIndex fit:

- reuse existing score/evidence inputs rather than donor heuristics;
- add one bounded additive field on current semantic query/search results.

Challenge:

OntoIndex does not currently expose an explanation field on the main semantic query result shape.
Explanation plumbing exists in enrichment and report paths, but this item is still a public query
contract addition and should be described as such.

Required narrowing before implementation:

- define the additive field name;
- define whether it appears on `definitions`, `process_symbols`, or both;
- define response-budget behavior when explanations are omitted.

3. Generic entry-file suppression in fallback ranking

The donor penalizes `App.tsx`, `main.tsx`, and similar entry files. OntoIndex already has stronger
ranking machinery, so this idea only survives as a bounded fallback heuristic for the current search
path when generic entrypoints crowd out more specific files.

Donor evidence:

- `tmp/zvec-mcp/zvec-mcp-bridge.js`
- `tmp/zvec-mcp/tests/search-ranking.test.mjs`

OntoIndex fit:

- add only a small penalty in the existing ranking stack;
- never replace current BM25/vector/CE behavior with donor-style heuristic ranking.

Challenge:

OntoIndex does not have a single generic "fallback ranking layer." It has BM25 + semantic merge,
intent-ensemble routing, optional CE reranking, locked-result prepending, and abstention gates.
This item is acceptable only if it names one concrete insertion point and leaves all stronger
signals intact.

Required narrowing before implementation:

- choose one insertion point in `backend-search.ts`;
- keep exact/locked matches, CE rerank, and RRF/ensemble logic authoritative;
- require a focused regression test that proves the heuristic demotes only generic entry files
  without hurting specific implementation hits.

4. Backend-readable vs analyze/checkpoint state

The donor distinguishes between "database exists and can be opened" and "full background indexing is
still running." OntoIndex already reports locks, stale indexes, startup timeouts, checkpoint state,
and embedding state. The useful carryover is not the donor's "warming" vocabulary, but a clearer
statement of when the backend is readable even while analyze/checkpoint state is degraded.

Donor evidence:

- `tmp/zvec-mcp/zvec-mcp-bridge.js`
- `tmp/zvec-mcp/tests/collection-ready.test.mjs`
- `tmp/zvec-mcp/tests/initialization-wait.test.mjs`

OntoIndex fit:

- clarify existing status surfaces rather than add another init/status command;
- use current OntoIndex states such as active analyze lock, partial checkpoint, failed checkpoint,
  dirty, stale, degraded, and untrusted.

### Donor ideas rejected by overlap

Rejected because OntoIndex already has a stronger owner:

- single-flight init guards;
- lock recovery and stale-lock handling;
- WAL recovery and backend open fallback;
- MCP stdout protection for native backend noise;
- embedding metadata and freshness diagnostics;
- result reranking infrastructure;
- backend fallback/circuit-break behavior.

Rejected because they do not fit OntoIndex architecture:

- per-file semantic indexing tooling;
- chunk-ID lifecycle and delete-before-reindex flow;
- direct project filesystem watcher as the primary freshness model;
- zero-vector fallback on embedding failure;
- donor's single-file server composition.

## Decision Detail

Approved implementation scope is narrow:

1. Search path filters
   - add `include_paths` / `exclude_paths` parameters to CLI `query` and MCP
     `search(action="semantic")`;
   - apply the path predicate at the symbol-candidate level after retrieval/ranking selection but
     before process grouping and final emission;
   - filter `definitions` and `process_symbols` by the same path predicate;
   - drop any `process` that has no surviving in-scope symbol after filtering;
   - document them as retrieval narrowing, not authorization or repo-boundary controls.

2. Search result explanations
   - expose an additive `explanation?: string` field based on existing score components;
   - carry that field on `process_symbols` and definition-like symbol rows that already have
     symbol-level search evidence;
   - do not add explanation text to the top-level `processes` array in this ADR;
   - gate explanation emission behind an explicit `include_explanations` opt-in parameter on the
     query/search contract;
   - keep output bounded and optional when response budgets are tight.

3. Fallback generic-file penalty
   - apply only as a bounded post-merge fallback reorder after locked-result prepending and
     abstention filtering, immediately before symbol lookup / process grouping;
   - never rewrite BM25, semantic, RRF, intent-ensemble, or CE scores;
   - never demote locked/exact-match results;
   - only apply to unlocked rows that do not already carry stronger rerank evidence;
   - do not bypass or replace CE reranking;
   - keep the heuristic list small and reviewable.

4. Runtime-status clarification
   - distinguish "repo backend can be opened now" from "analyze lock active" and
     "analysis-checkpoint shows partial/in-progress run";
   - reuse existing runtime-health vocabulary such as `degraded`, `dirty`, `stale`, `untrusted`,
     active analyze lock, and partial/failed checkpoint;
   - do not introduce donor lifecycle labels such as `warming`;
   - show this in existing CLI/MCP status/diagnose outputs.

## Not Approved

- no new storage backend;
- no donor-style knowledge-base initialization tools;
- no donor-style project watcher as a core OntoIndex workflow;
- no per-file indexing command family;
- no embedding failure masking;
- no new dependencies;
- no parallel MCP response contract for semantic search.

## Acceptance

This ADR is satisfied only if:

- the user can narrow semantic search by include/exclude path on existing OntoIndex search surfaces;
- semantic search can return a bounded additive explanation field for why a result ranked;
- generic app-shell files are less likely to outrank specific implementation files in fallback
  cases;
- status/diagnose can say "backend readable now" separately from active analyze/checkpoint states.

## Manager Loop Disposition

Dispatchable now:

1. Path-filter contract
   - public owners: CLI `query`, MCP `search(action="semantic")`, local `QuerySchema`, and
     `backend-search.ts`;
   - contract decision: apply path filtering to symbol candidates after retrieval/ranking selection
     and before process grouping; emit only in-scope `definitions` / `process_symbols`; drop empty
     processes.
   - naming decision: use snake_case public wire params `include_paths` / `exclude_paths` to match
     existing query/search contract style.

2. Explanation-field contract
   - public owners: CLI `query`, MCP `search(action="semantic")`, local `QuerySchema`, and
     symbol-entry shaping in `backend-search.ts`;
   - contract decision: add `explanation?: string` on symbol-level emitted rows only, behind an
     explicit opt-in request parameter, with omission allowed under response-budget pressure.
   - naming decision: use `include_explanations` as the snake_case opt-in request parameter, default
     `false`.

3. Runtime-status wording
   - public owners: `runtime-health.ts`, `diagnose.ts`, `ensure-fresh.ts`, and CLI/MCP status text;
   - contract decision: reuse current runtime-health states and wording; no new donor lifecycle
     vocabulary.

Dispatchable with focused regression coverage:

4. Generic-entry-file penalty contract
   - public owners: `backend-search.ts` result ordering path and focused unit/integration search
     tests;
   - contract decision: apply the heuristic only in a bounded post-merge fallback reorder after
     `prependLockedResults(...)` and abstention filtering, immediately before symbol lookup;
   - guardrails: never alter locked/exact-match ordering, never rewrite ranking scores, and never
     override stronger CE/exact-match signals;
   - acceptance gate: pair the change with a focused regression test showing a specific
     implementation file outranks a generic app-shell file without changing exact-match behavior.

## Remaining Open Contract Questions

These must be answered before implementation starts:

None at the ADR contract level.

Implementation is still expected to choose a minimal helper shape and prove the behavior with a
focused regression test, but the public contract questions are now resolved in this document.

This ADR is not satisfied by:

- adding a new search tool;
- adding a new repo-local semantic index;
- porting donor implementation structure;
- broad "improve ranking" work without a narrow contract.

## Challenge Resolution

The donor repo looked richer on first pass than it really is. After checking current OntoIndex
owners and public contracts, only four ideas remain worth carrying forward, and each belongs inside
an existing owner. The bounded manager pass resolved all four contract areas in-doc and narrowed the
ranking heuristic to a presentation-stage fallback reorder rather than a score-layer rewrite.

Everything else is either:

- already implemented more robustly in OntoIndex; or
- a worse fit than the current OntoIndex architecture.
