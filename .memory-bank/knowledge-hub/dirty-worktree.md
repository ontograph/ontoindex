# Working with uncommitted code

## The snapshot and the working tree

The active graph records the indexed commit in metadata. Edits and untracked
files made after indexing are absent from that snapshot until another analysis
reads them; matching `HEAD` does not prove that the graph reflects current source.
Runtime health reports `dirty` for an otherwise healthy, current index when Git
reports uncommitted changes. An overlay does not clear that dirty state. [1][2]

## Build a disposable overlay

```sh
ontoindex analyze --dirty-overlay
```

This rebuilds `<storage>/overlay` using the `symbols` pipeline profile and stores
its database at `<storage>/overlay/lbug` (normally `.ontoindex/overlay/lbug`).
The overlay directory is disposable and replaced on each build. This branch
returns before active-index lifecycle operations: it does not activate a
generation or write `meta.json`, and skips embeddings and skill generation. [2][3]

Planning uses Git status, including staged, unstaged and untracked source paths.
Deleted source paths become tombstones; a rename tombstones the old source path
and includes the new source path. Tombstones let readers suppress old identities
without trying to parse a missing file. Unsupported extensions are skipped. [4]

The limit is 50 distinct source paths, including tombstones; a rename can count
as two. Above this limit, the CLI refuses rather than doing a full scan, and
readers reject any existing overlay. [3][4][5]

## Keep it refreshed

```sh
ontoindex watch [path]
```

Omit `[path]` to use the current directory; the command resolves its Git root.
The CLI exposes no watch-specific options beyond help. Startup prints a line
such as `Watching <root> (debounce 750 ms); tree is clean`; dirty startup instead
reports the dirty-source count and starts a build, unless over the limit or
blocked by an active analyze lock. There is no periodic idle status output. [6][7]

The recursive watcher debounces changes for 750 ms and starts a child
`analyze --dirty-overlay`. Refreshes are serialized, with a follow-up refresh
when changes arrive during a running refresh. An active `analyze.lock` skips
the refresh and clears queued work; releasing the lock alone does not trigger
a retry. The child also acquires the normal analyze lock. [3][6]

Events under `node_modules`, `dist`, `.git` and `.ontoindex` are ignored, as are
listed binary, archive, media, font, log, lock and temporary extensions.
The watcher also applies the repository ignore filter, including `.gitignore`
unless disabled by the existing environment setting, and `.ontoindexignore`.
It never requests embeddings and removes embedding-named environment variables
from the child; overlay analysis itself reports zero embeddings. [2][6][8]

## Reading overlay results

An overlay is usable only when its database exists, the source-path limit is
not exceeded, and no included dirty file has a modification time later than the
database. Equal timestamps pass this check. Saving a file after the build makes
the overlay stale once its file timestamp is newer. Snapshot checks are cached
for two seconds, so this is not an instantaneous content-hash guarantee. [5]

With a usable overlay and a successful overlay read, query and symbol resolution
suppress base candidates from dirty paths, including tombstones, and merge current
overlay candidates. Returned overlay identities carry `source: "overlay"`.
Unavailable, stale or failed overlay reads retain base-only lookup behavior;
do not assume dirty base results are always suppressed. [5][9][10]

Overlay context returns identity, location and optional content with
`source: "overlay"` and `graphImpactAvailable: false`. Empty caller, callee and
process collections mean unavailable evidence, not absent relationships. [11]

Impact for an overlay symbol returns `risk: "UNKNOWN"`,
`graphImpactAvailable: false` and `source: "overlay"`. Its zero impacted count
means impact was not computed, not that the change is safe. The read API does
not traverse overlay relationships into the base graph. [12]

For base-graph impact traversal, encountered rows in dirty paths remain visible
with `dirty: true`, but traversal does not expand through them. Encountering
these rows marks the result `partial` and adds a stale-graph-ID warning. [12][13]

NodeNext `.js`-to-`.ts` import mapping lets the full graph report previously missed callers. [14][18]

## Freshness fields

- `targetContext.dirtyWorkspace.dirtyPaths` lists distinct dirty paths from the
  workspace summary, capped at 50; `dirtyPathsTruncated: true` signals more paths.
  These are workspace paths, not just the overlay's supported source paths. [15]
- `freshness.dirtyResultPaths` lists known dirty paths found in result fields
  named `filePath`, `path` or `file`, sorted and deduplicated. It is omitted when
  there are no matches. Scanning is bounded to 5,000 result nodes and uses the
  capped dirty-path list, so absence is not proof that every result is clean. [16]

## Limits and mutation caution

There are no overlay embeddings: edited files have lexical/name lookup, not new
semantic vectors. Updated semantic retrieval waits for a full
`ontoindex analyze --embeddings`. [2][9]

The build uses the `symbols` profile, but this does not guarantee an edge-free
store: structure adds `CONTAINS` edges and parsing still resolves imports and
calls. Context and impact nevertheless expose overlay symbols without graph
relationship evidence. Treat the overlay as identity/location data. [11][12][17]

Mutation tools (`move_symbol`, `extract_function`, replace/delete symbol) slice
the graph's stored line range out of the live file. The graph keeps index-time
ranges, so on a file with uncommitted edits a base range can be wrong. Real
writes are therefore refused for a dirty file unless the range came from a
usable overlay; dry runs succeed and carry a warning. Clean files are
unaffected. The guard depends on the same two-second snapshot cache and is not
protection against concurrent edits. [10][19][21]

## Recorded costs

The closeout records warm medians from `scripts/overlay-benchmark.mjs` on a Ryzen 9 9950X, commit `61f0b6c`: [18][20]

| Dirty files | Warm median |
| ----------- | ----------- |
| 1           | 0.86 s      |
| 10          | 2.3–2.4 s   |
| 25          | 1.2 s       |
| 50          | 1.4 s       |

A full analyze without embeddings took about 38–39 s on that machine. Warm
medians use two subsequent CLI runs on a shared host, selecting tracked TypeScript
files in sorted path order. The closeout attributes non-monotonic times to file
costs: these are recorded measurements, not fresh timings or a scaling law. [18][20]

## Sources

- [1] `ontoindex/src/core/runtime/runtime-health.ts` — commit comparison and dirty state.
- [2] `ontoindex/src/core/run-analyze.ts` — `runDirtyOverlayAnalysis`, early return, metadata lifecycle.
- [3] `ontoindex/src/cli/analyze.ts` — planning, lock acquisition, overlay completion.
- [4] `ontoindex/src/core/analyze-delta.ts` — `planDirtyOverlay`, source extensions, tombstones, limit.
- [5] `ontoindex/src/mcp/local/backend-overlay.ts` — timestamp usability, cache, read access.
- [6] `ontoindex/src/cli/watch.ts` — startup, debounce, lock skip, ignores, child arguments/environment.
- [7] `ontoindex/src/cli/index.ts` — analyze/watch command registration; built CLI help checked.
- [8] `ontoindex/src/config/ignore-service.ts` — shared ignore rules and environment behavior.
- [9] `ontoindex/src/mcp/local/backend-search.ts` — overlay replacement and lexical candidates.
- [10] `ontoindex/src/mcp/local/backend-symbol-resolution.ts` — overlay gate, suppression, source tag.
- [11] `ontoindex/src/mcp/local/backend-context.ts` — overlay context response.
- [12] `ontoindex/src/mcp/local/backend-impact.ts` — overlay UNKNOWN response, dirty-path kernel input.
- [13] `ontoindex/src/core/impact/impact-kernel.ts` — dirty rows, traversal stop, partial result.
- [14] `ontoindex/src/core/ingestion/import-resolvers/{standard,utils}.ts` — relative import mapping.
- [15] `ontoindex/src/mcp/shared/target-context.ts` — dirty-path list and truncation.
- [16] `ontoindex/src/mcp/shared/response-envelope.ts` — bounded dirty-result scan.
- [17] `ontoindex/src/core/ingestion/{pipeline,structure-processor}.ts` and `pipeline-phases/parse-impl.ts` — symbols profile and relationship creation.
- [18] `.memory-bank/REALTIME_DIRTY_WORKTREE_SUPPORT_PROJECT_PLAN.md` — closeout caller evidence and recorded RT-16 measurements.
- [19] `ontoindex/src/mcp/local/{local-backend,backend-move-symbol,backend-extract-function,backend-symbol-mutations}.ts` and `ontoindex-shared/src/ports/backend-port.ts` — runtime mutation handle flow.
- [20] `ontoindex/scripts/overlay-benchmark.mjs` — file selection, temporary clone, timing method.
- [21] `ontoindex/src/mcp/local/{backend-move-symbol,backend-extract-function,backend-symbol-mutations}.ts` — dirty-file guard.
