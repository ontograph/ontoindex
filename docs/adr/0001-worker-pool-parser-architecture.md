# ADR-0001: Worker pool parser architecture

**Status:** Accepted
**Date:** 2026-04-30 (v12 P1 baseline; perf-stability hardening)
**Source:** `ontoindex/src/core/ingestion/workers/worker-pool.ts`, `parse-worker.ts`.

## Context

Tree-sitter parsing of large TypeScript/JavaScript/Python/etc. corpora is CPU-bound and synchronous. Naive single-threaded parsing of OntoIndex self-corpus (~888 files) took 21+ minutes due to a 4-bug worker-pool fallback path. Production users on Tier 1-2 corpora (≤ ~1000 files) need <1 minute end-to-end indexing; the prior implementation silently fell back to sequential and produced misleading timing.

## Decision

Use a **bounded worker pool** with **chunked sub-batches** + **per-progress watchdog** + **terminate-and-respawn on timeout** + **strictly-conservative full-batch sequential fallback**. Default to 8 workers (`min(8, os.cpus().length - 1)`).

## Algorithm / Technique

### Pool construction (`worker-pool.ts:45-58`)

1. Validate worker script exists at `workerUrl` before spawning to catch `MODULE_NOT_FOUND` early (e.g., when running from `src/` via vitest before the build step).
2. Spawn `size` workers (`Worker(workerUrl)` each); store in `workers[]`.
3. Expose `dispatch(items, onProgress)` and `terminate()` on the returned `WorkerPool` interface.

### Dispatch loop (`worker-pool.ts:60-167`)

1. Compute `chunkSize = Math.ceil(items.length / size)`. Slice `items` into `size` chunks.
2. For each chunk, post a `Promise<TResult>` to its assigned worker via `parentPort.postMessage`.
3. Each worker processes its chunk in **sub-batches** of 300 items (`SUB_BATCH_SIZE = 300`, reduced from 1500 in v12 W1c). The worker emits `{ type: 'sub-batch-done' }` after each, prompting the parent to send the next.

### Watchdog (per-progress reset, terminate-and-respawn) (`worker-pool.ts:87-99`)

1. After each `sendNextSubBatch()`, set `subBatchTimer = setTimeout(callback, SUB_BATCH_TIMEOUT_MS=30_000)`.
2. **In v12 W1a:** the parent message handler resets the timer on every `'progress'` event from the worker (not only on `sub-batch-done`). This prevents premature timeout during an active but slow batch.
3. On timeout fire: `cleanup()` (remove listeners, clear timer); `void worker.terminate()`; **respawn** `workers[i] = new Worker(workerUrl)`; then `reject(timeoutError)`.
4. Respawn before reject ensures the slot is live for the next dispatch — avoids dead-slot accumulation.

### Result collection (`worker-pool.ts:166-198`, **perf-stability inversion of v12 W1b**)

1. `await Promise.allSettled(promises)` — wait for all workers to finish or reject.
2. Iterate settlements: collect fulfilled `TResult` values into `results[]`; capture `firstError` from first rejection; log all rejections via `console.warn`.
3. **If `firstError` is set, throw it** (not return partial results). The strictly-conservative posture forces the consumer (`parsing-processor.ts`) to run a full-batch sequential fallback rather than ship silent partial extraction.
4. Otherwise return `results[]` (one `WorkerExtractedData` per chunk).

### setTimeoutMicros native parse limit (`parse-worker.ts:308 area`, v12 W1c)

1. At worker module load, probe `typeof parser.setTimeoutMicros === 'function'`.
2. If available, call `parser.setTimeoutMicros(10_000_000)` — 10 second native parse limit. Persists across all subsequent `parser.parse()` calls.
3. If unavailable, log `'[parse-worker] tree-sitter setTimeoutMicros unavailable — external watchdog only'`.
4. This provides in-process cancellation for pathological files (minified bundles, generated code) that would otherwise wedge the worker.

### Sequential fallback (`parsing-processor.ts:725-746`, perf-stability)

1. `processParsing()` wraps `processParsingWithWorkers()` in try/catch.
2. On any throw from `dispatch()`, log warning and call `processParsingSequential(graph, files, ...)` on the **full** input file list.
3. (Pre-perf-stability v12 W1b had per-chunk fallback via `processedPaths` field; reverted for correctness — the strictly-conservative path eliminates the risk of mid-chunk silent partial extraction.)

### Sub-batch size rationale

- **1500 (pre-v12 W1c):** budget = 30s / 1500 = 20ms/file. Impossible during JIT warmup; watchdog tripped on first batch.
- **300 (post-v12 W1c):** budget = 30s / 300 = 100ms/file. Realistic; gives 5× more progress events to reset the watchdog.

### Verified empirically

- ontoindex self-corpus (~888 files): 21 min → 21.1s cold / 17.0s warm = ~60× speedup.
- vscode (Tier 3, ~9k+ files): KILL-SWITCH at 15+ min wall-clock. Sequential fallback can't recover at this scale.

### Pipeline Profiles and Large-Repo Scaling

To support massive codebases (e.g., LibreOffice Core), the analyze pipeline supports bounded profiles around the worker-pool parse phase:

1. **`full` (Default)**: Runs all phases: `scan -> structure -> parse -> enrichment -> graph`.
2. **`symbols` / `symbols-only` CLI behavior**: Runs only `scan -> structure -> parse`. It skips expensive cross-file relationship extraction and sidecar enrichment.
3. **`huge-repo-symbols` / `--huge-repo` CLI behavior**: Composition of symbols-only indexing with large-repo-safe defaults and include-path guardrails.

### Durable Degraded Metadata

When an index is built in a symbols-only or huge-repo mode, `RepoMeta` persists the degradation state in `ontoindex/src/storage/repo-manager.ts`:

```ts
interface RepoMeta {
  indexMode?: 'full' | 'symbols-only';
  pipelineProfile?: 'full' | 'symbols' | 'huge-repo-symbols';
  skippedPhases?: string[];
  degradedFiles?: { filePath: string; reason: string }[];
  capabilities?: {
    symbols?: boolean;
    impact?: 'full' | 'degraded';
    processes?: boolean;
  };
}
```

This ensures that downstream tools (query, impact, report) can emit explicit capability warnings instead of silent partial results.

## Consequences

**Positive:**
- 60× speedup on Tier 1-2 corpora (the user-facing common case)
- Worker zombies = 0 (terminate-and-respawn closes the leak)
- No silent partial results (strictly-conservative inversion)
- Tree-sitter native cancellation active for pathological files

**Negative:**
- Tier 3+ corpora still hit the timeout; sequential fallback is too slow at vscode scale
- `processedPaths` field on `ParseWorkerResult` is dead code (still populated by workers; no longer read)
- Full-batch fallback re-parses ALL files on any worker failure (was per-chunk; reverted for correctness over performance)

**Open issues for future work:**
- T-1 Tier 3 parser scaling (HIGH; see forward plan §1.1)
- T-2 EMBEDDING_NODE_LIMIT cap (MEDIUM; cross-cuts T-1)
