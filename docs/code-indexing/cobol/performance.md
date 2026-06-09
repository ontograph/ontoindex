# COBOL Performance and Tuning

This document covers real-world benchmarks, worker pool configuration, memory management, known limitations, and troubleshooting for COBOL indexing.

## PROJECT-NAME Benchmark

The PROJECT-NAME project is a large Italian payroll system written in COBOL. It serves as the primary benchmark for COBOL indexing performance.

### Input

| Metric                      | Value                                                                        |
| --------------------------- | ---------------------------------------------------------------------------- |
| Paths scanned               | 14,217                                                                       |
| Parseable files             | 13,129                                                                       |
| Total source size           | 224 MB                                                                       |
| Chunks                      | 12 (at 20 MB budget)                                                         |
| Copybooks loaded            | 2,976                                                                        |
| Copybooks used in expansion | 2,955                                                                        |
| Key directories             | `s/` (7773 programs), `c/` (3036 copybooks), `wfproc/` (1973 workflow files) |

### Output

| Metric                 | Value  |
| ---------------------- | ------ |
| Graph nodes            | 2.79M  |
| Graph edges            | 5.67M  |
| Clusters (communities) | 16,679 |
| Execution flows        | 300    |

### Timing

| Phase                           | Duration          |
| ------------------------------- | ----------------- |
| Total                           | ~251s             |
| KuzuDB write                    | 132s              |
| Full-text search indexing       | 6.7s              |
| Regex extraction (avg per file) | ~1ms              |
| COPY expansion + deep indexing  | Remainder (~112s) |

### Indexing Command

```bash
cd /path/to/PROJECT-NAME
ONTOINDEX_COBOL_DIRS=s,c,wfproc ONTOINDEX_VERBOSE=1 node --max-old-space-size=8192 \
  /path/to/ontoindex/dist/cli/index.js analyze --force
```

## Open-Source Benchmarks

### CardDemo (AWS)

| Metric | Value |
| ------ | ----- |
| Graph nodes | 12,323 |
| Graph edges | 8,893 |
| Total time | 7.4s |

### ACAS

| Metric | Value |
| ------ | ----- |
| Graph nodes | 14,016 |
| Graph edges | 15,452 |
| Total time | 9.3s |

### Micro-Benchmark (Single-File Extraction)

| Metric | Value |
| ------ | ----- |
| Per-iteration | 0.65ms |
| Throughput | ~382K lines/sec |

## Worker Pool Tuning

### Sub-Batch Size

The worker pool splits each worker's chunk into sub-batches to bound peak memory per `postMessage` serialization. COBOL repos use a smaller sub-batch size than the default:

| Parameter             | Default     | COBOL Mode          |
| --------------------- | ----------- | ------------------- |
| Sub-batch size        | 1,500 files | 200 files           |
| Per sub-batch timeout | 120s        | 120s (configurable) |

**Why 200?** COBOL regex extraction + preprocessing takes ~1ms per file on average, but with COPY expansion and deep indexing the effective time is ~150ms per file. At sub-batch size 1500, that would be ~225s per sub-batch, exceeding the 120s timeout.

COBOL mode is activated automatically when `ONTOINDEX_COBOL_DIRS` is set:

```typescript
// From pipeline.ts
const cobolSubBatch = process.env.ONTOINDEX_COBOL_DIRS ? 200 : undefined;
workerPool = createWorkerPool(workerUrl, undefined, cobolSubBatch);
```

### Worker Count

Workers default to `min(8, cpus - 1)`. For COBOL repos, this is usually sufficient since regex extraction is CPU-bound but fast. The bottleneck is typically KuzuDB write, not extraction.

### Timeout Configuration

| Environment Variable                 | Default         | Purpose                                             |
| ------------------------------------ | --------------- | --------------------------------------------------- |
| `ONTOINDEX_WORKER_TIMEOUT_MS`         | 120,000 (2 min) | Per sub-batch processing timeout                    |
| `ONTOINDEX_WORKER_STARTUP_TIMEOUT_MS` | 60,000 (1 min)  | Worker initialization timeout (tree-sitter loading) |

For COBOL-only repos, worker startup is faster because tree-sitter native modules are loaded lazily (skipped entirely if only COBOL files are present).

## Data Item Cap

### Configuration

```typescript
const MAX_DATA_ITEMS_PER_FILE = 500;
```

This constant appears in both `parse-worker.ts` (worker path) and `parsing-processor.ts` (sequential fallback).

### Rationale

Some COBOL programs, especially after COPY expansion, can have 10,000+ data items. At that scale:

- The in-memory relationship Map (for CONTAINS, REDEFINES, etc.) approaches the V8 16.7M entry limit across thousands of files
- KuzuDB write time increases linearly with edge count
- Most deep-nested items (level 20+) are rarely queried individually

### Impact

The cap truncates data items beyond the 500th in source order. Since 01-level Records appear first in COBOL source, the cap preserves:

- All 01-level record definitions
- The most important 02-49 level items (those closest to the record root)
- 88-level conditions associated with early items

To increase the cap for specific needs, modify the `MAX_DATA_ITEMS_PER_FILE` constant in both files.

## Memory Management

### COPY Expansion Breadth Guard

A per-file `MAX_TOTAL_EXPANSIONS = 500` limit prevents exponential blowup from diamond-shaped COPY graphs (e.g., N copybooks each containing N COPY statements). Once the limit is reached, further COPY statements in that file are left unexpanded. See [copy-expansion.md](copy-expansion.md) for details.

### COPY Expansion Memory

All copybook content is loaded upfront into a Map before chunk processing begins. For PROJECT-NAME:

- 2,976 copybooks, typically under 100MB total
- The Map is shared (read-only) across chunk iterations
- Per-chunk, the copybook map is merged with chunk file content (in case a chunk contains copybooks not in the pre-loaded set)
- After all chunks are processed, the copybook map is freed (`cobolCopybookContents = undefined`)

### Chunk Budget

Source files are grouped into chunks of max 20MB (`CHUNK_BYTE_BUDGET`). Each chunk's lifecycle:

1. Read file content into memory
2. Expand COPY statements (mutates content in-place)
3. Dispatch to workers for extraction
4. Workers return serialized results
5. Merge results into graph
6. Chunk content goes out of scope (GC reclaims)

This ensures only ~20MB of source + ~200-400MB of working memory (ASTs, extracted records, serialization) is active at any time.

### Shared Warning Deduplication

The `warnedCircular` set (used by the COPY expansion engine) is shared across all files in a chunk. This prevents the same circular copybook warning (e.g., `ANAZI includes itself`) from being logged thousands of times.

## Known Limitations

| Limitation                               | Impact                                                                                                          | Workaround                                                 |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| tree-sitter-cobol hangs on ~5% of files  | Cannot use tree-sitter for COBOL                                                                                | Regex-only extraction (current approach)                   |
| Data item cap (500/file)                 | May miss deeply nested items in large programs                                                                  | Increase `MAX_DATA_ITEMS_PER_FILE` in source               |
| Circular copybooks (ANAZI, ANDIP, QDIPE) | Self-referential includes cannot be expanded                                                                    | Detected and skipped with warning                          |
| wfproc/ files may not be pure COBOL      | Workflow files may produce extraction noise                                                                     | Exclude `wfproc` from `ONTOINDEX_COBOL_DIRS` if problematic |
| No MOVE DATA_FLOW edges yet              | Data flow between variables not in graph                                                                        | Reserved for future release                                |
| Continuation line handling               | Some complex multi-line continuations (especially in string literals spanning 3+ lines) may not merge correctly | Known edge case; affects <0.1% of lines                    |
| Single-line EXEC blocks                  | `EXEC SQL SELECT ... END-EXEC` on one line is handled, but pathological nesting is not                          | Extremely rare in practice                                 |
| Extension case sensitivity               | `.GNM` and `.gnm` are matched differently                                                                       | Use the exact case from the codebase                       |

## Troubleshooting

### "COPY expansion failed"

```
[pipeline] COPY expansion failed for s/BGTABFL: Cannot read properties of null
```

**Cause:** A copybook referenced by a COPY statement cannot be found.

**Fix:**

1. Verify `ONTOINDEX_COBOL_DIRS` includes the directory containing copybooks (typically `c`)
2. Check that copybook filenames match the COPY target (case-insensitive, after stripping extensions)
3. Ensure copybook files are not in `.gitignore`

### Worker sub-batch timeout

```
Worker 3 sub-batch timed out after 120s (chunk: 200 items)
```

**Cause:** A sub-batch took longer than the timeout. Typically happens when one file is extremely large (50,000+ lines after COPY expansion).

**Fix:** Increase the timeout:

```bash
ONTOINDEX_WORKER_TIMEOUT_MS=300000 ontoindex analyze
```

### Memory errors (heap out of memory)

```
FATAL ERROR: CALL_AND_RETRY_LAST Allocation failed - JavaScript heap out of memory
```

**Fix:** Increase Node.js heap size:

```bash
node --max-old-space-size=16384 /path/to/ontoindex/dist/cli/index.js analyze
```

For very large repos (>500MB source), consider `--max-old-space-size=32768`.

### Concurrent analyze corruption

**Rule:** Only ONE `ontoindex analyze` process should run at a time per repository. Concurrent writes to KuzuDB corrupt the database.

If corruption occurs:

```bash
# Remove the KuzuDB directory and re-index
rm -rf .ontoindex/kuzu
ontoindex analyze --force
```

### Slow KuzuDB write phase

The KuzuDB write phase (132s for PROJECT-NAME) is the bottleneck for large COBOL repos. This is proportional to the number of nodes and edges being written. Reducing `MAX_DATA_ITEMS_PER_FILE` or excluding non-essential directories from `ONTOINDEX_COBOL_DIRS` can help.

### Verbose output

Enable verbose logging to see per-phase timing and statistics:

```bash
ONTOINDEX_VERBOSE=1 ontoindex analyze
```

This outputs:

- Scan statistics (paths, parseable files, chunk count)
- Worker pool configuration (worker count, sub-batch size)
- COPY expansion statistics (copybooks loaded, files expanded)
- Community and process detection results
- Contract detection results

## Source Files

- `ontoindex/src/core/ingestion/workers/worker-pool.ts` -- `DEFAULT_SUB_BATCH_SIZE`, `SUB_BATCH_TIMEOUT_MS`, `WORKER_STARTUP_TIMEOUT_MS`
- `ontoindex/src/core/ingestion/pipeline.ts` -- `CHUNK_BYTE_BUDGET`, COBOL sub-batch configuration, chunk lifecycle
- `ontoindex/src/core/ingestion/workers/parse-worker.ts` -- `MAX_DATA_ITEMS_PER_FILE`, `processCobolRegexOnly()`
- `ontoindex/src/core/ingestion/parsing-processor.ts` -- Sequential fallback `MAX_DATA_ITEMS_PER_FILE`
