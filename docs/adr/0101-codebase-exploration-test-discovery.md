# ADR 0101: Codebase Exploration Test Evidence Extensions

Status: Implemented
Date: 2026-06-21
Source reviewed: `/home/evrasyuk/_workfolder/ontocode/.memory-bank/ONTOINDEX_CODEBASE_EXPLORATION_TOOLS_PROPOSAL.md`

## Context

The proposal asks for a family of new codebase exploration tools: behavior ownership, flow
explanation, test discovery, architecture maps, entrypoint tracing, invariant tracing, graph-native
edge queries, migration helpers, review summaries, and orientation packs.

OntoIndex already has broad exploration surfaces:

- `gn_explore` for concept search and task packs;
- `gn_explain_module` for file/module orientation;
- `gn_find_related`, `impact`, and `gn_graph_walk` for graph neighborhoods and traversal;
- `search` and `inspect` for semantic/Cypher lookup and symbol context;
- process MCP resources for execution-flow steps;
- `gn_test_gap` for post-edit missing test evidence;
- `gn_test_suggestions` for audit/regression test shape suggestions.

Most proposed tools are useful agent questions, but not all justify new public tools. The approved
slice must extend an existing owner when one already exists.

## Evidence Review

The current code already has a test-evidence owner:

- `ontoindex/src/mcp/super/write-through-verification.ts` defines `gnTestGap`, `TestGapParams`, and
  `buildTestGapReport`.
- `gn_test_gap` already accepts `changedFiles`, `changedSymbols`, and `executedTests`, then reports
  missing test evidence for production symbols.
- `ontoindex/src/mcp/super/systems-public.ts` defines `gnTestSuggestions`, and
  `gn_test_suggestions` already accepts `symbol`, `path`, and `claimPattern`.
- `gn_diff_impact` already recommends `gn_test_gap` when changed files have no linked test import
  evidence.

That means a new `gn_test_finder` would mostly split one responsibility across two tools. The
smaller fit is to add pre-edit target discovery to `gn_test_gap`, then use `gn_test_suggestions`
only when no suitable existing test evidence is found.

## Architecture Fit Gate

### Real New Functionality

Passes only for pre-edit test evidence discovery.

`gn_test_gap` answers "did this diff miss tests?" after code changes exist. `gn_test_suggestions`
answers "what small regression test should I add?" for a known finding or risk. Neither answers the
common pre-edit exploration question: "which tests already cover this symbol, file, or behavior, and
what is the smallest command to run?"

This gap is real, but it belongs in the existing test-evidence tools. The rest of the proposal is
not approved as new public tools:

- behavior ownership should extend `gn_explore(profile: "task-pack")`, `search`, or `inspect`;
- flow narration should extend process resources or `gn_graph_walk`;
- architecture maps, entrypoints, change-home guidance, review surfaces, and orientation packs
  should extend existing exploration, impact, and diff tools;
- graph-native edge queries may be valid later, but need a concrete workflow and stable response
  contract before becoming public MCP functions.

### Core Extension

Passes if implemented as extensions to `gn_test_gap` and `gn_test_suggestions`. It fails if
implemented as `gn_test_finder`, because that would create a second test-evidence surface instead of
extending the existing one.

## Decision

Extend existing test-evidence tools. Do not add `gn_test_finder`.

Approved scope:

1. Add a pre-edit target mode to `gn_test_gap`:
   - accept one of `symbol`, `filePath`, or `query` in addition to current diff inputs;
   - return existing linked tests, heuristic test matches, coverage status, and the smallest
     existing command to run;
   - keep current post-edit diff behavior unchanged when target inputs are omitted.
2. Add or reuse shared helpers in `write-through-verification.ts` for:
   - collecting graph-linked test evidence for explicit targets;
   - sibling/name heuristic test discovery;
   - nearest package test command inference.
3. Extend `gn_test_suggestions` only for the missing-test path:
   - accept the target evidence summary from `gn_test_gap` when available;
   - avoid suggesting a new test file when an existing targeted test file is already found;
   - keep its current audit/regression suggestion behavior compatible.
4. Update tool docs and tests for the new parameters and response fields.

Not approved:

- a new `gn_test_finder` public tool;
- broad behavior ownership or flow narration tools;
- a separate test index or persisted coverage database;
- running tests from the MCP tool;
- adding new dependencies;
- making test coverage claims without evidence class labels;
- exposing every test match when a bounded summary and omitted counts are enough.

## Algorithm / Technique

1. Keep `gn_test_gap`'s current diff path as-is:
   - if `symbol`, `filePath`, and `query` are absent, use existing `collectVerificationDiff` and
     `buildTestGapReport` behavior.
2. Add a target path:
   - `symbol`: use the same target-context resolution used by graph-aware MCP tools;
   - `filePath`: normalize to a repo-relative path;
   - `query`: use existing semantic search to find likely production symbols or files when
     embeddings are available; otherwise fall back to bounded name/path heuristics and report the
     degraded evidence class.
3. Collect direct graph evidence first:
   - production symbols with relationships to test symbols;
   - callers/callees already marked as tests;
   - co-located test files known to the graph.
4. Fill gaps with cheap repository heuristics:
   - sibling test files such as `foo.test.ts`, `foo.spec.ts`, or matching `__tests__` paths;
   - test names containing the symbol or behavior terms;
   - package-level scripts from the nearest `package.json`.
5. Rank direct graph evidence above heuristics, then by path proximity and name match strength.
6. Return a compact extension of the existing `test-gap` report:

   ```ts
   type TestGapTargetReport = {
     version: 1;
     action: 'test-gap';
     mode: 'diff' | 'target';
     status: 'PASS' | 'FAIL' | 'NEEDS-VERIFY';
     target?: { kind: 'symbol' | 'filePath' | 'query'; value: string };
     evidence: Array<{
       testFile: string;
       testNames?: string[];
       reason: string;
       evidenceClass: 'graph' | 'name-heuristic' | 'path-heuristic';
       confidence: 'high' | 'medium' | 'low';
     }>;
     runCommand?: string;
     targetedCoverage: 'found' | 'not-found' | 'unknown';
     omittedCounts?: Record<string, number>;
     nextTools?: string[];
   };
   ```

7. If `targetedCoverage` is `not-found` or `unknown`, include `nextTools: ['gn_test_suggestions']`.
8. Keep all file reads bounded. Do not scan generated/vendor trees.

## Acceptance

- A user can call `gn_test_gap` for a symbol, file, or behavior query before editing code.
- The response names likely test files and the smallest test command without running it.
- Direct graph-backed matches are visibly separated from heuristic matches.
- Empty results are useful: they say no targeted coverage was found and suggest
  `gn_test_suggestions`.
- Existing post-edit `gn_test_gap` behavior and response compatibility are preserved.
- No new MCP tool, storage, UI, or dependency is added.

## Remaining Proposals

The proposal's broader exploration tools should be handled only when a concrete workflow proves that
existing surfaces cannot carry the behavior. Default to extending the named existing surface first:

- `gn_where_is_behavior`: proposal only as a `gn_explore` / `inspect` guard-condition extension.
- `gn_explain_flow`: proposal only as a process-resource or `gn_graph_walk` narrative extension.
- `gn_arch_map`: proposal only as an extension to `gn_explain_module` and ADR 0100 read-first
  projection.
- `gn_entrypoints`: proposal only as an upstream-entrypoint mode on `gn_find_related` or `impact`.
- `gn_change_home`: proposal only as an extension to `gn_propose_location` / `gn_safe_edit_check`.
- `gn_review_surface`: proposal only as an extension to `gn_diff_impact` and `gn_review_diff`.
- `gn_orientation_pack`: proposal only as an extension to `gn_explore(profile: "task-pack")`.
- `gn_property_access`, `gn_override_chain`, and `gn_interface_conformance`: possible future public
  tools because they expose graph-native edges not directly surfaced today. They still need separate
  ADRs with response contracts before implementation.
- `gn_config_trace` and `gn_data_flow`: proposal only after `gn_property_access` exists; otherwise
  they are premature wrappers.
- `gn_compare_implementations`, `gn_call_path`, `gn_dependency_graph`, `gn_migration_path`, and
  `gn_historical_context`: proposal only; first try `gn_find_related`, `gn_graph_walk`, `impact`,
  git history, and existing diff/review tools.

## Follow-up Challenge Resolution

- Public-contract changes for read-first `format: "files"` options belong to ADR 0100, not ADR 0101. Do not count that snapshot churn as test-discovery work.
- ADR 0101 ownership is limited to `gn_test_gap` target evidence, `gn_test_suggestions` handoff,
  tool schema for those parameters, and tests for that behavior.
