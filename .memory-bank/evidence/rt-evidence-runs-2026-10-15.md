# RT evidence runs (2026-10-15)

Commit under test: `b5d254583c403dbb5e4a885e78f92377d50d3fc3` (master plus the RT-41/43/44 test PR). Machine: Linux 6.11.0-29-generic x86_64, v24.21.0. The host was shared, so timings are indicative.

## RT-9: dirty-overlay-build.test.ts, 30 consecutive runs

Command: `cd ontoindex && for i in $(seq 1 30); do npx vitest run test/unit/dirty-overlay-build.test.ts || exit 1; done`

Result: 30 of 30 runs exited 0.

## RT-23: dirty-overlay-build.test.ts and backend-overlay.test.ts, 20 consecutive runs on Linux

Command: `npx vitest run test/unit/dirty-overlay-build.test.ts test/unit/backend-overlay.test.ts`, 20 times.

Result: 20 of 20 runs exited 0.

## RT-16: overlay benchmark

Command: `cd ontoindex && node scripts/overlay-benchmark.mjs` (exit 0, 60 s wall).

```text
Baseline analyze: b5d254583c403dbb5e4a885e78f92377d50d3fc3 (embeddings disabled, temporary clone)
Baseline: 41195.1 ms; 39552 nodes, 65010 edges
Files  Cold ms  Warm median ms  Warm min ms  Warm max ms  Nodes  Edges  Overlay bytes
1  1073.9  838.4  832.7  844.1  6  5  4092014
10  2324.4  2421.7  2387.7  2455.7  62  78  5439598
25  1259.4  1160.4  1159.3  1161.4  243  323  7254126
50  1354.0  1381.6  1341.4  1421.7  664  892  10743918
```

The full JSON output is reproducible with the command above; the paths inside it are temporary clones.

## RT-10: JS-extension import resolution

## Environment and input

- Source clone: `/tmp/rt10_work/repo`
- Source commit: `b5d254583c403dbb5e4a885e78f92377d50d3fc3`
- Registry home: `/tmp/rt10_work/home`
- Index storage: `/tmp/rt10_work/repo/.ontoindex`
- Machine: `Linux ai 6.11.0-29-generic #29~24.04.1-Ubuntu SMP PREEMPT_DYNAMIC Thu Jun 26 14:16:59 UTC 2025 x86_64 x86_64 x86_64`
- Node: `v24.21.0`

The clone was created with:

```text
git clone --no-hardlinks /opt/d1/tmp/wt_ev /tmp/rt10_work/repo
```

Source inspection confirmed `getGlobalDir()` uses `process.env.ONTOINDEX_HOME || path.join(os.homedir(), '.ontoindex')`; repository graph data uses the clone-local `.ontoindex`. No existing checkout or global registry was used.

## Exact analysis command and result

```text
/usr/bin/time -f 'WALL_SECONDS=%e' env ONTOINDEX_HOME=/tmp/rt10_work/home ONTOINDEX_MAX_WORKERS=7 node /opt/d1/tmp/wt_ev/ontoindex/dist/cli/index.js analyze /tmp/rt10_work/repo --skip-agents-md
```

Exit code: `0`; wall time: `42.00` seconds.

Raw terminal excerpt:

```text
[gitMining] Added 854 CO_CHANGED_WITH edges.
[pageRank] Computed importance for 8581 nodes.
  Embedding lifecycle: off (embeddings absent)

  Repository indexed successfully (41.7s)

  39,552 nodes | 65,859 edges | 1458 clusters | 300 flows
  /tmp/rt10_work/repo

WALL_SECONDS=42.00
```

The isolated registry recorded `lastCommit` `b5d254583c403dbb5e4a885e78f92377d50d3fc3`, `storagePath` `/opt/d1/tmp/rt10_work/repo/.ontoindex`, and the same 39,552-node/65,859-edge totals.

## Cypher measurements

The CLI requires `LIMIT 5000` even for aggregate queries. The first attempts omitted that clause and returned a validation error (`shell exit code 0`, JSON error: `MCP Cypher queries must include LIMIT 5000 or lower`). The successful commands were:

```text
ONTOINDEX_HOME=/tmp/rt10_work/home node /opt/d1/tmp/wt_ev/ontoindex/dist/cli/index.js cypher --repo wt_ev "MATCH (a:File)-[r:CodeRelation {type: 'IMPORTS'}]->(b:File) WHERE a.filePath ENDS WITH '.ts' AND b.filePath ENDS WITH '.ts' RETURN count(r) AS tsToTs LIMIT 5000"
```

Result: `tsToTs = 3855`.

```text
ONTOINDEX_HOME=/tmp/rt10_work/home node /opt/d1/tmp/wt_ev/ontoindex/dist/cli/index.js cypher --repo wt_ev "MATCH ()-[r:CodeRelation {type: 'IMPORTS'}]->() RETURN count(r) AS totalImports LIMIT 5000"
```

Result: `totalImports = 4052`.

```text
ONTOINDEX_HOME=/tmp/rt10_work/home node /opt/d1/tmp/wt_ev/ontoindex/dist/cli/index.js cypher --repo wt_ev "MATCH (caller)-[r:CodeRelation {type: 'CALLS'}]->(target:Function {name: 'runImpactKernel'}) WHERE target.filePath ENDS WITH 'ontoindex/src/core/impact/impact-kernel.ts' RETURN caller.name AS caller, caller.filePath AS filePath LIMIT 5000"
```

Result: `row_count = 8`; callers:

- `impact-kernel-traversal.test.ts` — `ontoindex/test/unit/impact-kernel-traversal.test.ts`
- `impact-kernel-dirty.test.ts` — `ontoindex/test/unit/impact-kernel-dirty.test.ts`
- `runImpactBFS` — `ontoindex/src/mcp/local/backend-impact.ts`
- `collectLinkedTestsBySymbol` — `ontoindex/src/mcp/super/write-through-verification.ts`
- `collectImpactedSymbols` — `ontoindex/src/mcp/super/write-through-verification.ts`
- `fetchUpstream` — `ontoindex/src/mcp/super/safe-edit-check.ts`
- `fetchDownstream` — `ontoindex/src/mcp/super/safe-edit-check.ts`
- `buildDiffReview` — `ontoindex/src/core/review/diff-review.ts`

## Optional `.js` specifier count

Not available from stored graph data. `ontoindex/src/core/ingestion/import-processor.ts` emits `IMPORTS` edges with only `sourceId`, `targetId`, `type`, `confidence`, and an empty `reason`; the original import specifier is not persisted as an edge property.

## Verdict

- `tsToTs IMPORTS = 3855`: **well above 294** (13.1× the baseline).
- `runImpactKernel` callers: **present; 8 direct caller rows**.
