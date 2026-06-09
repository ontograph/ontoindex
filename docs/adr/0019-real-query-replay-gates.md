# ADR 0019: Query Replay Reports for Retrieval Changes

Status: Postponed

## Context

OntoIndex already records live query behavior in one narrow place:

- `ontoindex/src/mcp/local/query-log.ts` defines `QueryLogEntry` and `appendQueryLog`.
- `ontoindex/src/mcp/local/backend-search.ts` appends the top query result IDs, timing phases, and FTS availability after `query` runs.
- `ontoindex/scripts/bench-gate.mjs` already demonstrates the lightweight script pattern used for local measurement gates.

That is enough organic substrate for a replay report. It is not enough to justify a broad new capture platform for every MCP tool.

The current query log is intentionally small, but its contract is too loose for regression review:

- it has no `schema_version`;
- result IDs are raw strings without a declared identity type;
- captured rows do not include enough index/freshness context to explain drift;
- logs are on by default unless `ONTOINDEX_QUERY_LOG=0`;
- there is no first-class export or replay command;
- replay metrics are not connected to a stable benchmark contract.

Retrieval changes in OntoIndex often move behavior without breaking tests. Examples include intent classification, RRF tuning, skeleton defaults, markdown context, enrichment consumption, LSP references, and cross-encoder rerank. A replay report can show how much a change moved real query results before the change is merged.

## Challenge Review

The earlier version of this ADR imported too much from an external architecture. The useful recommendation is smaller:

1. Keep the scope on `query` first. Do not start with `context`, `impact`, audit tools, or edit tools.
2. Produce a report, not a hard gate. OntoIndex does not yet have enough labeled real-query truth to make replay a correctness oracle.
3. Reuse the existing query log and lightweight benchmark script pattern. Do not introduce a separate event-store subsystem for v1.
4. Treat privacy as a blocker. A default-on query log is hard to defend once replay becomes a formal workflow.
5. Keep result identity explicit. Comparing opaque row IDs across index rebuilds can create false drift.

This ADR therefore proposes a narrow query replay report. Broader MCP capture, audit status replay, and CI enforcement are deferred until the query-only report proves useful.

## Decision

Add a schema-versioned query replay report for OntoIndex retrieval changes.

The report compares a captured baseline of `query` calls against the current build and current index. It reports result-set overlap, top-result stability, latency delta, warning drift, and skipped/errored rows.

The first implementation is report-only. It must not block commits, imply semantic correctness, or classify audit status. It should be used by maintainers when touching retrieval, ranking, query intent, skeleton selection, enrichment consumption, or rerank code.

## Algorithm/Technique

### 1. Tighten `QueryLogEntry`

Evolve `ontoindex/src/mcp/local/query-log.ts` instead of adding a parallel recorder.

Version 1 rows should include:

```json
{
  "schema_version": 1,
  "query_id": "uuid",
  "ts": 1770000000000,
  "repo_id": "OntoIndex",
  "indexed_head": "abc123",
  "dirty_worktree": false,
  "query": "scrubbed or capped query",
  "result_ids": ["symbol:uid:...", "process:..."],
  "result_scores": [0.91],
  "phases": {
    "wall": 42
  },
  "fts_used": true,
  "query_intent": "conceptual",
  "metadata": {
    "include_skeleton": true,
    "ce_rerank": false,
    "enrichment_used": false
  }
}
```

Required changes:

- Add `schema_version`.
- Keep query text length-capped.
- Record `indexed_head` when available from repo metadata.
- Record `dirty_worktree` only if it can be obtained cheaply; otherwise omit it.
- Prefix result IDs by identity type where possible.
- Keep file contents and source snippets out of the log.

### 2. Make formal replay capture opt-in

Do not expand the current default-on diagnostic log into formal replay capture.

Introduce a separate opt-in for replay-grade rows:

```bash
ONTOINDEX_QUERY_REPLAY_LOG=1
```

Behavior:

- `ONTOINDEX_QUERY_LOG` may remain as legacy diagnostics.
- `ONTOINDEX_QUERY_REPLAY_LOG=1` enables schema-versioned replay rows.
- `ONTOINDEX_QUERY_REPLAY_LOG_DIR` may override the sink directory.
- Replay-grade rows should be written to a distinct filename prefix, for example `query-replay-{repoId}-{yyyymmdd}.jsonl`.

This avoids silently converting existing diagnostic logging into a productized capture system.

### 3. Add export

Add a command that streams replay rows:

```bash
ontoindex eval export-query-log --since 7d --repo OntoIndex > baseline.ndjson
```

Requirements:

- Stream NDJSON to stdout.
- Write progress and skipped-row warnings to stderr.
- Support `--since`, `--limit`, `--repo`, and `--schema-version`.
- Reject unsupported schema versions.
- Never run `analyze`, refresh sidecars, or mutate `.ontoindex/`.

The command can initially read JSONL files from the replay log directory. It does not need a database.

### 4. Add replay

Add a report command:

```bash
ontoindex eval replay-query-log --against baseline.ndjson --json
```

For each row:

1. Re-run the captured `query` with equivalent user-visible parameters.
2. Extract current result IDs using the same identity contract.
3. Compare captured and current IDs.
4. Record timing delta.
5. Record warning drift, especially FTS degradation and stale-index warnings.

Summary metrics:

- `rows_total`
- `rows_replayed`
- `rows_skipped`
- `rows_errored`
- `mean_jaccard_at_k`
- `top1_stability_rate`
- `mean_latency_delta_ms`
- `rows_over_2x_latency`

The human report should list the worst moved queries by low Jaccard and changed top result.

### 5. Keep thresholds advisory

Do not introduce CI enforcement in v1.

Recommended advisory thresholds for a retrieval-neutral change:

```json
{
  "min_mean_jaccard_at_k": 0.85,
  "min_top1_stability_rate": 0.85,
  "max_rows_over_2x_latency_rate": 0.05
}
```

The report may print `PASS`, `WARN`, or `FAIL` relative to those thresholds, but the command should exit non-zero only for replay infrastructure failure in v1.

### 6. Connect to existing benches

The replay report should not replace curated benchmarks. It should sit next to them:

- use query replay to detect movement on organic agent queries;
- use maintained heldout benchmarks to test labeled relevance when they exist;
- use dedicated rerank experiments outside the release package until they have stable semantics;
- use `bench-gate.mjs` only after a benchmark has stable semantics.

This keeps each tool honest about what it measures.

## Consequences

Positive:

- Maintainers get a low-friction drift report for retrieval changes.
- The design builds on existing OntoIndex code instead of adding a new subsystem.
- Privacy risk is lower because replay-grade capture is opt-in and narrow.
- The report can be useful before the project has full labeled query relevance.
- Existing benchmark patterns remain relevant.

Negative:

- Query replay measures movement, not correctness.
- Drift may come from index/corpus changes rather than code changes.
- Stable result identity needs careful work across index rebuilds.
- Query-only replay will not catch regressions in `context`, `impact`, or audit tools.
- A second log prefix adds some operational complexity.

## Guardrails

- Replay-grade capture is opt-in.
- No source snippets or file bodies are captured.
- Export and replay commands are read-only.
- Replay does not run `analyze`.
- v1 is query-only.
- v1 is advisory/report-only.
- Broad MCP capture requires a later ADR or explicit revision of this ADR.

## Deferred

The following ideas are intentionally not part of this ADR:

- Capturing `context`, `impact`, audit, or edit tools.
- CI-enforced replay gates.
- Audit status drift comparison.
- A centralized event store for all tool calls.
- HTTP MCP remote replay capture.
- Query text hashing mode.
- Frozen `.ontoindex` index snapshots.

These may be valid later, but they are not organic to the current code path.

## Relationship to Existing ADRs

- ADR 0011 defines skeleton-first viewing; query replay can show movement when skeleton behavior changes.
- ADR 0012 defines intent classification; query replay can show movement when intent routing changes.
- ADR 0013 defines LSP bridge integration; query replay can report optional LSP-driven result changes when enabled.
- ADR 0015 defines post-index sidecars; query replay can observe sidecar-assisted retrieval without promoting sidecar facts.
- ADR 0018 defines MCP audit trust; this ADR does not implement that trust contract, but it can later provide one empirical signal for retrieval readiness.

## Open Questions

- Should legacy `ONTOINDEX_QUERY_LOG` eventually become default-off?
- What is the canonical stable identity for a query result: symbol UID, graph node ID, process ID, citation anchor, or a composite?
- Should replay rows include the effective retrieval mode once named modes exist?
- Should a future labeling tool consume the new schema directly or remain separate?
- Should a small anonymized replay baseline be checked in, or should baselines remain local-only?
