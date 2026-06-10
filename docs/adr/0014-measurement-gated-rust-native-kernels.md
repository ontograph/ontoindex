# ADR-0014: Measurement-gated Rust native kernels

**Status:** Accepted (partially implemented; native kernels remain opt-in)
**Date:** 2026-05-05
**Source:** large-codebase scalability benchmark work

## Context

OntoIndex is primarily a TypeScript system with several performance-sensitive surfaces:

- `ontoindex analyze` must remain reliable on large and pathological repositories.
- Recent large-repo work has focused on TypeScript hardening: bounded worker pools, streaming graph responses, request timeouts, and safer LadybugDB concurrency.
- Some remaining surfaces are deterministic, CPU-heavy, memory-sensitive kernels that may benefit from Rust without moving the whole architecture out of TypeScript.
- The current OntoIndex index used for discovery was stale (`b3cb9c5` indexed, `f9df2c1` current), so every candidate must be revalidated with source review and benchmarks before implementation.

The scalability plan identifies candidate native boundaries:

- Graph-to-CSV serialization: `ontoindex/src/core/lbug/csv-generator.ts`
- Tree-sitter parse/match worker core: `ontoindex/src/core/ingestion/workers/parse-match-loop.ts`
- Search tokenization, BM25 merge, and top-k ranking: `ontoindex/src/core/search/bm25-index.ts`
- Scope-resolution graph algorithms: `ontoindex-shared/src/scope-resolution/finalize-algorithm.ts`
- Graph API row mapping and NDJSON encoding: `ontoindex/src/server/api.ts`
- MCP stdio framing: `ontoindex/src/mcp/compatible-stdio-transport.ts`
- Second-pass candidates: dead-code reachability, cycle detection, community graph construction, hotspot scoring, graph diff, COBOL/JCL extraction, group contract scanning, and ignore/path filtering.

## Decision

Adopt a **measurement-gated hybrid native-kernel strategy**:

1. Keep orchestration, CLI commands, MCP tools, repo management, HTTP routes, and UI code in TypeScript.
2. Consider Rust only for narrow, deterministic kernels with stable input/output contracts.
3. Require a benchmark and golden-output fixture before any Rust prototype.
4. Select no first prototype candidate yet; defer native/Rust work until clean repeated Axel evidence identifies a stable active bottleneck and replaceable boundary.
5. Keep a TypeScript fallback path until native packaging and CI are proven.
6. Prefer in-process N-API for bounded kernels; consider a sidecar binary only when crash isolation or independent memory limits are required.

This ADR does not approve a broad rewrite. It approves the architecture rule: Rust is allowed only behind measured, replaceable TypeScript adapters.

## Implementation Status

Partially implemented. The repository now includes `ontoindex-native/` and TypeScript adapters under
`ontoindex/src/native/` for selected native kernels, including graph/CSV writing and import extraction
fallback paths. The architecture remains measurement-gated and opt-in; this ADR does not mark every
candidate kernel as implemented.

## Algorithm / Technique

### Candidate gate

A candidate can move from plan to prototype only if Phase R0 produces:

1. A benchmark command.
2. Baseline wall time.
3. Baseline peak RSS or process memory.
4. Output-size measurement where relevant.
5. A correctness fixture with deterministic expected output.
6. A TypeScript fallback path.

Reject a native prototype if the benchmark shows that LadybugDB query time, disk I/O, git command time, or unstable dirty-checkout variance dominates the measured path.

### Native module layout

Initial native package shape:

```text
ontoindex-native/
  Cargo.toml
  src/lib.rs
  src/csv_writer.rs
  src/framing.rs
  src/search.rs
  src/scope_graph.rs
  src/reachability.rs
  src/path_filter.rs
```

TypeScript wrapper shape:

```text
ontoindex/src/native/
  index.ts
  csv-writer.ts
  search-ranking.ts
  scope-graph.ts
  reachability.ts
  path-filter.ts
```

Wrappers own native-module loading, fallback selection, feature flags, and error conversion. Callers should depend on wrapper interfaces, not on N-API bindings directly.

### Deferred prototype selection

Current LCS-015 decision state:

- No native/Rust prototype candidate is selected yet.
- Cross-file resolution is the leading measured hot path in the current Axel evidence, with parse/extraction second.
- CSV generation is no longer a native-start reason after the TypeScript-side CSV/cache fixes reduced the cap-disabled CSV phase to low single-digit seconds.
- The latest dirty-branch benchmark does not supersede the cleaner post-CSV-fix ranking because LBUG variance dominated the result.
- LCS-016 and LCS-017 stay blocked/open until clean repeated Axel runs confirm the active bottleneck and stable boundary.

If CSV, parse/extraction, or graph-resolution work is reconsidered later, it must still satisfy the candidate gate above:

1. Preserve existing TypeScript behavior.
2. Produce deterministic fixture output.
3. Demonstrate material wall-time or RSS improvement on clean repeated target benchmarks.
4. Fall back to the TypeScript path when native loading fails or the feature flag is disabled.

### Later graph kernels

Shared Rust graph helpers may cover:

- `tarjanSccs` in `ontoindex-shared/src/scope-resolution/finalize-algorithm.ts`
- `tarjan` / cycle assembly in `ontoindex/src/mcp/local/backend-cycle-detect.ts`
- dead-code reachability over symbol and edge row lists in `ontoindex/src/mcp/local/backend-dead-code.ts`
- hotspot change-coupling pair counting in `ontoindex/src/mcp/local/backend-hotspot-analysis.ts`
- graph-diff edge-key comparison in `ontoindex/src/mcp/local/backend-graph-diff.ts`

All DB reads stay in TypeScript first. Rust receives plain rows or compact typed arrays and returns deterministic result records.

### Later extractor kernels

Extractor kernels may cover:

- COBOL preprocessing, copy expansion, and regex extraction records.
- HTTP/topic/manifest source scanners for group contracts.
- Ignore/path filtering during repository walks.

These kernels must not mutate `KnowledgeGraph` directly in the first version. They return normalized extraction records that existing TypeScript graph-mapping code consumes.

### Packaging policy

Native code must not become a hard install blocker until all of these are true:

1. CI validates native-enabled and fallback paths.
2. Missing native toolchain produces a clear fallback, not a broken install.
3. Linux x64 works first.
4. Broader platform support is added only after benchmark value is proven.

## Consequences

**Positive:**

- Keeps OntoIndex's contributor-facing architecture mostly TypeScript.
- Allows Rust where it can materially improve throughput, RSS, or crash containment.
- Forces benchmark-backed decisions instead of speculative rewrites.
- Preserves portability via TypeScript fallback paths.
- Provides a reusable pattern for future kernels.

**Negative:**

- Adds native build and CI complexity.
- N-API boundaries can erase performance gains if data copying is excessive.
- Debugging failures crosses the TypeScript/Rust boundary.
- Golden-output tests become mandatory for every native/fallback pair.

**Open issues for future work:**

- Choose the exact N-API toolchain.
- Define benchmark commands and result schema under a caller-specified or ignored local output directory.
- Decide which boundary, if any, should become the first native/Rust prototype after clean repeated Axel runs.
- Decide when, if ever, a sidecar binary is preferable to in-process N-API.
- Re-run OntoIndex analysis before implementation so candidate lines and call graphs reflect current `HEAD`.
