# Entire Graph Review: Challenged Additive Shortlist

Reviewed donor: `entireio/entire-graph@76eb362` from the shallow `main` clone in `/tmp/entire-graph`.

The original review listed 100 possible approaches. This challenge keeps only ideas that extend an existing OntoIndex owner, preserve current architecture decisions, and have a bounded validation path. The result is 12 retained extensions.

## Decision Gate

An idea remains only when it satisfies all of these constraints:

1. **One graph and one primary store.** The ingestion DAG builds one `KnowledgeGraph`, then persists it to LadybugDB. New file-based graph stores or parallel graph contracts are out of scope. See `ARCHITECTURE.md:16-27`, `ARCHITECTURE.md:118-122`, and `ARCHITECTURE.md:290-337`.
2. **Existing surfaces share one backend.** MCP, HTTP, and CLI are projections over the same local backend. Do not add a donor-shaped parallel query system. See `ARCHITECTURE.md:22-25`.
3. **Freshness remains explicit.** Queries use the last indexed commit; working-tree changes are not silently folded into cached graph answers. See `ARCHITECTURE.md:27` and `GUARDRAILS.md` under “Stale graph after edits.”
4. **Partial analysis is diagnostic, not authoritative.** Partial checkpoints are explicitly “not a complete OntoIndex index and not registered.” Extensions may improve diagnostics, but must not publish partial graphs as normal indexes. See `ontoindex/src/core/run-analyze.ts:200-280`.
5. **Bounded capability envelopes remain canonical.** Search, diagnostics, freshness, tool contracts, truncation, and cache state already have structured contracts. Extend them instead of creating new competing CLI contracts. See `ontoindex/src/mcp/super/diagnose.ts`, `ontoindex/src/mcp/shared/tool-registry.ts`, and `ontoindex/src/core/runtime/query-budget.ts`.
6. **Static pipeline and provider ownership remain intact.** The phase DAG is compile-time/static, while language-specific behavior belongs in `LanguageProvider` or shared language detection. See `ARCHITECTURE.md:104-128` and `ARCHITECTURE.md:150-211`.
7. **No public surface without demonstrated need.** Prefer extending telemetry, diagnostics, existing commands, tests, and workflows over adding `stats`, `agent-guide`, `capabilities`, or status-line products.

## Retained Extensions

| # | Extension | Existing owner | Why it survives the challenge | Acceptance gate |
|---:|---|---|---|---|
| 1 | Add graph-first and locate-share fields to existing model/evaluation transcripts. | `ontoindex/scripts/kimi-k3-mcp-smoke.mjs`, future model harnesses | The smoke harness already persists exact transcripts and grades tool use. Measuring whether graph tools precede broad exploration extends that evidence without creating runtime product telemetry or a new CLI. | A fixture transcript deterministically reports first locate mechanism, graph locate count, fallback locate count, and graph share. No user prompt content is copied into global telemetry. |
| 2 | Add cache status, response bytes, truncation state, and retrieval mode to the existing bounded query log. | `ontoindex/src/mcp/local/query-log.ts`, `backend-search.ts`, `tool-telemetry.ts` | Query logging and response-size telemetry already exist. Adding bounded operational fields supports retrieval evaluation and cache tuning without a new `ontoindex stats` surface. | JSONL remains bounded; logging failures remain non-fatal; tests cover hit, miss, stale, truncated, and disabled logging. |
| 3 | Tighten generated agent guidance to a small-tool ladder and explicit freshness rule. | `ontoindex/src/cli/ai-context.ts`, `ontoindex/src/cli/setup.ts` | OntoIndex already manages `AGENTS.md`, `CLAUDE.md`, `ONTOINDEX.md`, hooks, and skills. The donor's useful lesson is concise ordering, not another guide command. | Generated guidance says: explore/search first, inspect exact symbols next, impact before edits, verify diff before commit, and re-analyze when `HEAD` differs from the indexed commit. Existing managed-block idempotency tests remain green. |
| 4 | Make semantic-cache writes atomic and add a total-byte ceiling in addition to entry count. | `ontoindex/src/core/search/semantic-cache.ts` | The semantic cache already has deterministic keys, indexed-head invalidation, TTL, and count eviction. Atomic replacement and byte-bounded pruning strengthen the same cache rather than introducing committed-tree snapshot caches. | Interrupted writes never leave readable partial JSON; pruning honors both entry and byte limits; current key, TTL, stale-head, and eviction tests remain valid. |
| 5 | Add shebang fallback to shared language detection for extensionless executable files. | `ontoindex-shared/src/language-detection.ts`, ingestion scan/parse routing | Current detection is extension/basename based. A bounded first-line fallback naturally belongs in the shared detector and improves existing language providers without changing the provider model. | Tests cover `/usr/bin/env`, direct interpreter paths, optional env flags, whitespace, unsupported interpreters, and precedence of a recognized extension over the shebang. |
| 6 | Aggregate degraded-file metadata by reason, phase, and detected language in index capabilities and diagnostics. | `run-analyze.ts`, `storage/index-capabilities.ts`, `runtime-health.ts`, `gn_diagnose` | Degraded files and skipped phases already persist in `meta.json`; current output mainly reports a count. Aggregation extends the existing capability contract and preserves the rule that degraded indexes are explicit. | `status` and `gn_diagnose` expose bounded grouped counts plus samples; no raw unbounded file list is added to MCP responses. |
| 7 | Extend call-resolution validation with a shared cross-language precision baseline. | `ontoindex/test/unit/symbol-table.test.ts`, language-resolution fixtures, call processor tests | OntoIndex already has ambiguity and false-positive tests. The donor's useful pattern is a common precision report across languages, not a new resolver architecture. | Each supported semantic language contributes positive and negative call cases; unresolved ambiguity is counted as correct; baseline changes require an explicit fixture update. |
| 8 | Add relation-type and provenance-band counts to analysis metadata and benchmark output. | `KnowledgeGraph`, `run-analyze.ts`, `fact-provenance.ts`, large benchmark | OntoIndex already records total relationships and classifies facts as extracted, inferred, or ambiguous. Persisting aggregate distributions makes profile and quality drift measurable without changing graph schema. | Counts are deterministic, sum to the total relationship count, remain bounded, and are included in benchmark comparisons. |
| 9 | Replace the simulated performance gate with real benchmark output. | `.github/workflows/bench.yml`, `ontoindex/scripts/bench-gate.mjs`, Vitest benchmark reporter | The current workflow copies `baseline.json` to `current.json`, so it cannot catch regressions. Using real output directly strengthens an existing CI decision and is higher value than adding another benchmark framework. | CI fails on a deliberately regressed fixture and passes on unchanged baseline data; benchmark command failures are not hidden by `|| true`. |
| 10 | Add an optional peak-RSS threshold to the existing large-codebase benchmark. | `ontoindex/scripts/large-codebase-benchmark.mjs` | The harness already samples root and child-process RSS and records peak values. A threshold is a minimal extension of existing measurement, not a new memory subsystem. | `--max-peak-rss-mib` produces a structured failed threshold result and non-zero exit after writing the report; omitted threshold preserves current behavior. |
| 11 | Add a checked-in benchmark scenario manifest with pinned repository commits and thresholds. | large benchmark script, `eval/`, benchmark docs/workflow | Current runs record commit IDs, and SWE-bench instances already target commits. A manifest makes routine cross-repository runs repeatable while reusing existing harnesses. | Each scenario specifies repository, commit, mode/profile, timeout, memory threshold, and expected graph-quality floors; dirty or mismatched checkouts fail closed. |
| 12 | Add live release-asset verification after GitHub release creation. | `.github/workflows/publish.yml`, installer scripts | The workflow now packs and attaches `ontoindex-*.tgz`, but no step verifies the published release API and public download contract consumed by installers. This directly extends the repaired release path. | The workflow verifies `/releases/tags/<tag>` contains exactly the expected tarball, downloads it, checks the package version and CLI entry, and only then attempts npm publication. |

## Recommended Order

1. **Release and CI correctness:** 9, 12.
2. **Low-risk reliability:** 4, 5, 6, 10.
3. **Quality evidence:** 7, 8, 11.
4. **Agent and retrieval measurement:** 1, 2, 3.

## Rejection Ledger

### Already Implemented

The following original ideas were removed because current source already provides the substance:

- Semantic retrieval cache keyed by query inputs, capabilities, indexed head, embedding identity, and filters; it already reports hit/miss/stale/expired and evictions.
- Identifier splitting for camelCase, PascalCase, snake_case, and kebab-case queries.
- Retrieval lane diagnostics, token-cost snapshots, bounded response guards, truncation warnings, and optional explanations.
- Partial-analysis checkpoints with atomic writes and an explicit non-authoritative note.
- Degraded-file persistence, skipped-phase warnings, capability degradation, runtime-health reporting, and repair commands.
- Co-change ingestion and advisory use in related-file, safe-edit, delete, test-coverage, and hotspot tools.
- Ambiguous-call tests that prefer unresolved results over false-positive edges.
- Root/child RSS sampling, environment capture, commit capture, timeout handling, and benchmark report generation.
- Bootstrap schema/version validation and compatibility checks.
- Tool-contract comparison between advertised and callable MCP tools.
- Release tarball packing plus `fail_on_unmatched_files` in the GitHub release action.
- Model smoke transcripts, exact tool-call gates, repository-scope gates, grounding gates, and no-fallback gates.

### Conflicts With Core Decisions

These original ideas were removed because they would create competing architecture or weaken an explicit invariant:

- A second NDJSON/portable graph stream as a new primary interoperability contract. Existing bootstrap and review exports should remain the owned export surfaces unless a concrete consumer requirement justifies an ADR.
- A committed-tree graph snapshot cache parallel to LadybugDB. The indexed LadybugDB graph is already the committed-state cache.
- Worktree-aware graph caching. OntoIndex deliberately requires re-analysis and exposes staleness instead of silently mixing file state with indexed graph state.
- Publishing partial analysis as a usable normal graph. Partial checkpoints are diagnostic-only and unregistered by design.
- Renaming existing pipeline profiles to donor terminology. That would churn public behavior without adding capability.
- Dynamic/plugin analysis phases. The static DAG and declared dependency map are deliberate compile-time ownership controls.
- A separate CLI-only query architecture, removal of MCP/HTTP/UI, or replacement of LadybugDB.
- Default inclusion explanations or a new universal `agent` response format. Existing opt-in explanations and capability envelopes preserve bounded responses.
- A second impact/path-family subsystem. `context`, `impact`, `gn_find_related`, `gn_graph_walk`, and review tools already own those views.

### Unsupported by Current Foundations

These original ideas were removed because they require new foundational data or an ADR before they can be responsibly proposed:

- Exact semantic mirror deduplication. Searchable graph nodes do not currently carry a stable source-body fingerprint; embedding chunk hashes are not an equivalent identity contract.
- Rename detection based on body fingerprints. Current graph identity and diff contracts do not expose the required stable fingerprint model.
- Per-symbol body hashes as a general graph-schema addition. This is a schema/storage decision, not a small donor-derived extension.
- A synthetic module entity proposal. OntoIndex already has a `Module` node type; any diff-attribution gap needs a concrete failing case before changing semantics.

### Product Surface Without Proven Need

These original ideas were removed because existing surfaces can carry the value with less maintenance:

- New `ontoindex stats`, `ontoindex agent-guide`, or `ontoindex capabilities` commands.
- A Claude-specific status-line product.
- Global transcript harvesting or inferred “redundant grep” monitoring outside explicit evaluation runs.
- A new public `status --json` contract when `gn_diagnose`, MCP envelopes, and existing diagnostics already expose machine-readable state.
- General `NO_COLOR` work without evidence that current output emits problematic color codes in automation.

## Evidence Notes

- OntoIndex MCP was used for architecture navigation, symbol context, tool-contract state, runtime diagnostics, and current capability ownership.
- The OntoIndex graph index is stale (`8bcdc39e` indexed versus `ecbd066e` current), so exact keep/remove decisions were verified against current source files.
- The Markdown docs sidecar is missing, so docs MCP output was treated as degraded context rather than authority; `ARCHITECTURE.md`, `GUARDRAILS.md`, current source, tests, and workflows were read directly.
- No donor code is proposed for copying. The retained items are behavior and validation patterns implemented at existing OntoIndex ownership points.
