# ADR-0005: gitMining CO_CHANGED_WITH temporal coupling

**Status:** Accepted (default-on for small corpora; chunked streaming added v11 W1b)
**Date:** 2026-04-29 (v9-item2) + 2026-04-30 (v11 W1a/b streaming fix)
**Source:** `ontoindex/src/core/ingestion/pipeline-phases/git-mining.ts`.

## Context

Pure structural relationships (CALLS, IMPORTS, REFERENCES) miss temporal coupling: files that change together repeatedly indicate non-structural cohesion (a feature spans them; a refactor pattern; an undocumented contract). v9 added `CO_CHANGED_WITH` edges via gitMining; v11 W1a/b added chunked streaming because the v10-era implementation hit `Map maximum size exceeded` on large corpora.

## Decision

Mine **co-change pairs** from `git log --name-only` output. For each commit, every pair of changed files becomes a CO_CHANGED_WITH edge weighted by co-change count. Stream the git log output via `spawn` (NOT `execSync`) to avoid buffering the entire log. Chunk pair counting via `MAX_PAIR_ENTRIES=500_000` cap to prevent V8 Map limits.

## Algorithm / Technique

### Phase 1: stream git log via `spawn`

```
const child = spawn('git', ['log', '--name-only', '--pretty=format:%H'], { cwd: repoPath });
const reader = createInterface({ input: child.stdout });
```

This avoids the `execSync` memory blowup on multi-million-commit repos.

### Phase 2: parse stream into commits

`parseGitLog(reader)` (helper hoisted in W1b-v11):

1. State machine: `currentCommit: string | null = null`, `currentFiles: string[] = []`.
2. For each line:
   - 40-char hex → start of new commit; flush prior `(currentCommit, currentFiles)` to consumer; reset.
   - Empty line → boundary marker; ignore.
   - Otherwise → `currentFiles.push(line)`.
3. Yield each commit as `{ sha, files }` via async iterator.

### Phase 3: chunked pair counting (W1b streaming fix)

```
const CHUNK_SIZE = 200;       // commits per chunk
const MAX_PAIR_ENTRIES = 500_000;  // V8 Map safety cap

let pairCounts = new Map<string, number>();  // key: "fileA|fileB" (sorted)
let pairCountOverflow = false;
let chunkBuffer: Commit[] = [];

for await (const commit of parseGitLog(reader)) {
  chunkBuffer.push(commit);
  if (chunkBuffer.length >= CHUNK_SIZE) {
    accumulatePairsFromChunk(chunkBuffer, pairCounts);
    chunkBuffer = [];
    if (pairCounts.size >= MAX_PAIR_ENTRIES) {
      pairCountOverflow = true;
      break;
    }
  }
}
if (chunkBuffer.length > 0) accumulatePairsFromChunk(chunkBuffer, pairCounts);
```

`accumulatePairsFromChunk(commits, pairCounts)`:

1. For each commit C with files `[f1, f2, ..., fN]`:
2. For each pair `(fi, fj)` with `i < j`:
   - Skip if either is in the deny-list (binary files, generated files, large files).
   - `key = [fi, fj].sort().join('|')` — canonical order for symmetric edges.
   - `pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1)`.

### Phase 4: emit edges

For each `(key, count)` in `pairCounts` where `count >= MIN_CO_CHANGE_THRESHOLD`:

1. Split key into `[fileA, fileB]`.
2. Resolve `fileA` and `fileB` to nodeIds via the symbol table.
3. If both resolve to existing File or Folder nodes:
   - Emit `(fileA)-[CO_CHANGED_WITH { count, type: 'CO_CHANGED_WITH' }]->(fileB)` edge.
   - Symmetric edge — emit only once with sorted endpoints.

`MIN_CO_CHANGE_THRESHOLD` filters noise (one-off accidental co-changes). Default ≥3 per v9.

### Why a Map cap

V8's `Map` has a soft limit around ~2^24 entries (~16M); pre-W1b implementations crashed at `Map maximum size exceeded` on kubernetes (~320k commits, ~500k files, pair space ~10^11 worst case but typical corpora hit ~5-10M unique pairs).

`MAX_PAIR_ENTRIES = 500_000` is empirical — well below the V8 limit, leaves headroom for other Maps in the same process. When exceeded, set `pairCountOverflow = true` and stop accumulating; emit edges from what we have. Log a warning so operators know the gitMining was truncated.

### Why CHUNK_SIZE = 200 commits

- Smaller (e.g., 50): more flush overhead per chunk; same total work.
- Larger (e.g., 1000): more pair-Map churn per chunk; risk of intermediate Map size spikes.
- 200: empirical sweet spot from v11 W1b on Tier 1-2 corpora.

### Deny-list

Built-in: binary files (heuristic on extension), files >2MB, files matching common generated patterns (`*.min.js`, `dist/**`, `build/**`, `.ontoindex/**`, `node_modules/**`).

Customizable via `ontoindex/src/config/ignore-service.ts` (also used by parser).

### Empirical results

- ontoindex self-corpus: 3,696 CO_CHANGED_WITH edges (current; varies with commit count) — see latest analyze output.
- vscode (Tier 3): blocked at parse phase (T-1 in forward plan); gitMining never reached.
- v9 baseline: 3,883 edges. Post-W1b streaming: same order of magnitude but more deterministic.

## Consequences

**Positive:**
- Streaming `spawn` avoids memory blowup
- Chunked accumulation with Map cap prevents V8 limits
- Symmetric canonical-order pair keys avoid duplicate edges
- Deny-list filters noise from generated/binary files
- Graceful degradation on overflow (emit partial; log warning)

**Negative:**
- `MIN_CO_CHANGE_THRESHOLD=3` is a static heuristic; real signal may be lower for small repos and higher for large ones
- Pair space is O(N²) per commit; commits touching 1000+ files generate 500k pairs in one chunk
- Map cap is reactive (truncate on overflow), not proactive (cap pair growth per file)

**Open issues for future work:**
- Adaptive threshold based on corpus size
- Per-file pair cap (e.g., max 500 co-change partners per file)
- Time-decay weighting (recent co-changes weighted higher)
- Tier 3 unblocking (T-1 in forward plan) — gitMining can't run on vscode-scale today
