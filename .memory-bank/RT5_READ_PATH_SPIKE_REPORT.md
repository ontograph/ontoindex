# RT-5: read-only overlay read-path spike

## Conclusion

Use a small MCP-local overlay reader backed by the existing **read-only connection pool**, and merge at typed symbol boundaries. Do not switch the writer singleton and do not rewrite arbitrary Cypher results. There is a common dispatch/lifecycle owner, but **no single existing merge point safely covers query, context, and impact**.

An overlay containing only symbols can prove current symbol identity/content, not current call relationships or complete impact. Set `source: "overlay"` only on identities actually obtained from that store. Never infer overlay provenance merely because a path is dirty.

All source citations below are relative to `ontoindex/`, except explicitly named dependency/test paths. Verified HEAD: `24769238dddebda149d934747b6da26f6c2f7336`. Inspected production files had no source diff when checked; unrelated plan edits were ignored. No repository files were edited, created, or deleted by this spike's explicit commands.

## 1. Exact read paths and hook points

### Common dispatch and lifecycle

- Public MCP: `src/mcp/server.ts:442-447` dispatches facade or legacy tools. `src/mcp/facade/dispatch.ts:75-76` calls the backend; `:199-230` maps semantic search to `query`, context inspection to `context`, and symbol impact to `impact`.
- `src/mcp/local/local-backend.ts:1691-1698` enters `callTool`; `:1726-1749` routes to repository dispatch. `:1768-1778` resolves the repo, invokes its handler, then adds capability warnings and repo identity.
- **Common wiring hook:** `local-backend.ts:1769-1772`, before handler invocation, can resolve a dirty-path snapshot for a single-repo request. This is not a sufficient result merge hook: failures, ambiguity, ranking, and traversal already happen inside handlers. Group calls bypass this point at `:1745-1746`; shared implementation functions must accept the overlay read context rather than relying exclusively on outer dispatch.
- Repository handles are cached at `local-backend.ts:1151-1159`. Registry refresh chooses active-generation base DB paths at `:1429-1431`, and constructs handles at `:1454-1463`. Preserve `storagePath`: overlay location is based on it, not on the active-generation base filename.
- Lazy initialization: `local-backend.ts:1634-1648` serializes initialization through the per-repo promise lock (`:1325-1335`). `src/mcp/local/local-backend-repo-runtime.ts:208-257` maintains initialized/reinitializing state, checks base `meta.json` at most every five seconds (`:225-240`), and opens `handle.lbugPath`. This lock is not a lock around an entire tool or an OS writer lock.
- **Overlay lifecycle hooks:** `local-backend.ts:1634-1648` for adjacent lazy acquisition, `:1338-1343` for closing the companion pool on explicit repo close. `:2642-2651` already closes all pool entries on dispose. Overlay replacement needs its own generation/file-identity check; base `indexedAt` does not detect overlay changes.

### Query

- Important ownership correction: `local-backend.ts:61` imports actual process-grouped `query` from **`backend-search.ts`**, not `backend-query.ts`. Its wrapper initializes base and invokes it at `:2095-2096`.
- `src/mcp/local/backend-query.ts:249-329` supplies BM25 retrieval: FTS at `:257`; symbol materialization by IDs/path at `:274-296`; result construction at `:299-307`. These are useful reusable overlay retrieval hooks.
- `backend-query.ts:340-431` supplies semantic retrieval: embedding presence at `:349-353`, ANN query at `:368-381`, node hydration at `:400-418`. A symbols-only overlay does not imply FTS or vector indexes exist.
- Actual search retrieval lanes meet in `src/mcp/local/backend-search.ts:1771-1834`; plain BM25/vector run at `:1792-1799`. **Best query merge hook:** after all lanes are available and before ranking, `:1835` / `:1865`. Suppress dirty-path base candidates in BM25, vector, graph, and locked lanes, add query-matched overlay candidates, then use existing merge/ranking (`:1865-1881`). Filtering only one lane is insufficient.
- **Hydration/provenance hook:** `backend-search.ts:1925-2038`, particularly symbol construction at `:2010`. Overlay identity/content must not be hydrated from base at `:1974-1983`, nor inherit base process/community/citation facts at `:1939`, `:1954`, or `:1992`. With symbols-only overlay, emit those matches as definitions, marked `source: "overlay"`, without invented process membership. Final outputs are assembled at `:2389-2399`.
- **Cache hook:** `backend-search.ts:1693-1750` is a structured-cache early-return path and `:2368-2381` writes the cache. The key uses indexed HEAD (`:1683`), not overlay generation. Existing eligibility permits only fresh/not-applicable states (`:1593-1595`), but a previously fresh cache can still return before current dirty state is recomputed. Smallest safe policy: skip cache read/write whenever overlay/dirty routing is active; a generation-keyed cache is a later optimization.
- Raw Cypher is separate: `backend-query.ts:193-214` validates and executes arbitrary bounded reads; `:222-243` formats them. **Do not overlay-merge arbitrary Cypher:** rows may be aggregates, scalars, or joins with no path or stable symbol identity.

### Context / symbol lookup

- Wrapper: `local-backend.ts:2202-2207`; neighborhood mode branches at `:2204-2205` and is a separate read surface.
- `src/mcp/local/backend-context.ts:214-218` calls the shared resolver. `src/mcp/local/backend-symbol-resolution.ts:191-233` performs UID lookup (`:200-208`) or name/path lookup (`:229-233`).
- **Smallest shared context/impact identity merge hook:** `backend-symbol-resolution.ts:200-208` and `:229-240`, before not-found, label enrichment, Class preference, scoring, and ambiguity decisions. Look up overlay even when base has no match. Discard every base candidate whose exact normalized file path is dirty; add matching overlay candidates; deduplicate by canonical ID, not name. Empty overlay results must not resurrect deleted/renamed base symbols. Preserve existing `file_path` substring selector behavior, but use exact normalized paths for dirty membership.
- Provenance must survive `parseSymbolRow` (`:160-169`) and `toSymbolIdentity` (`:172-181`). Label enrichment at `:79-109` and `:247-251` must use the selected symbol's store.
- **Context response hook:** `backend-context.ts:242-248` before relationship reads, and `:323-340` for output. An overlay target should return current identity/content with `source: "overlay"` and explicit relationship incompleteness; do not query same-UID stale base edges. Incoming/outgoing relationship reads at `:248-277`, process membership at `:282-291`, and metadata at `:299` otherwise still use base `repo.id`.
- For clean targets, neighbor identity materialization at `backend-context.ts:62-74` also needs path-sensitive substitution/suppression. Updating an endpoint's identity does not refresh its base edge; retain snapshot qualification and a missing/incomplete reason.

### Impact

- Wrapper: `local-backend.ts:2320-2322`; `src/mcp/local/backend-impact.ts:209-214` enters implementation.
- **Critical pre-resolution hook:** `backend-impact.ts:242`, before `resolveSourceOnly`. That existing branch reparses dirty/untracked `file_path` targets and returns immediately (`:242-249`); merely changing the shared resolver would never reach overlay for those requests.
- Resolver then runs at `:252-256`; its identity is copied at `:293-297`; BFS starts at `:301-307`.
- **Overlay-target safety hook:** `backend-impact.ts:293-301`, before BFS. Return overlay identity with `source: "overlay"`, `risk: "UNKNOWN"`, and `graphImpactAvailable: false` when the overlay has only symbols. Reuse the existing unavailable/source-only result policy (`:310-333`), but do not fabricate `sourceDigest` or parser-specific resolution reasons. A symbols-only overlay BFS would otherwise produce zero neighbors and `LOW` risk (`:719-739`), falsely implying safety.
- Graph traversal is not implemented solely in backend-impact: `:477-493` calls `src/core/impact/impact-kernel.ts:288`. That kernel reads relationships at `:328-335`, constructs endpoints at `:344-381`, and enqueues IDs at `:362-364`. **If replacing dirty impacted endpoints as well as the target:** gate/substitute at `impact-kernel.ts:344-364`, before enqueueing. Missing overlay identities suppress stale endpoints; stop unproved traversal through dirty nodes and mark partial/unknown. Output-only replacement at `backend-impact.ts:730-750` cannot repair already computed counts or traversal.
- Impact enrichment still reads base process/community data at `backend-impact.ts:531`, `:597`, `:644`, and `:677`; these are snapshot data, not overlay proof.
- Group UID bypass: `backend-impact.ts:769-807` resolves and traverses directly, called by `local-backend.ts:2334-2354`. Extend this too if claiming group-impact coverage; it bypasses both the shared resolver and `impactImpl`.

## 2. Smallest merge point / minimum set

**No single safe universal merge point exists.** `local-backend.ts:1772` is a shared response interception point, but cannot discover new overlay-only matches, fix ambiguity/ranking, or undo stale BFS. The envelope is even later and intentionally generic/synchronous.

Minimum semantic integration set:

1. Query candidate merging before ranking plus store-aware hydration/cache handling in `backend-search.ts`.
2. UID/name candidate merging in `backend-symbol-resolution.ts` (shared by context and ordinary impact).
3. Context provenance and honest relationship handling in `backend-context.ts`.
4. Impact's pre-source-fallback branch and pre-BFS unavailable result in `backend-impact.ts`.
5. Shared acquisition/dirty snapshot and lifecycle in `local-backend.ts`, using one small local overlay helper.

For all returned dirty relationship endpoints, add the impact-kernel hook above; do not mistake primary-identity coverage for complete graph-overlay coverage. Explicit context neighborhoods, groups, impact batches, and arbitrary Cypher require separate coverage decisions.

## 3. Second DB handle: feasible, with constraints

**Feasible through `src/core/lbug/pool-adapter.ts`, not through the writer singleton.** MCP imports pool `initLbug(repoId, dbPath)` (`local-backend.ts:13-18`). Pool entries are keyed by ID (`pool-adapter.ts:102`) and native DBs by path (`:168-180`); a distinct internal overlay ID plus distinct DB filename gets a second native Database (`:554-574`) without closing base.

Concrete risks:

- **Singleton:** `lbug-adapter.ts:267-269` has one db/conn/path. Its `initLbug(path)` locks at `:547-548` and closes the old DB on a path switch (`:594-598`). It is unsuitable for concurrently retained base+overlay readers. It also creates schema and may remove stale directories (`:600-647`); never use it from overlay MCP reads.
- **Pool ID/path:** pool `initLbug` returns immediately for an existing ID regardless of supplied new path (`pool-adapter.ts:517-521`). Never reuse base repo ID for overlay. Explicit close/reopen is required after publication changes. Cache keys are literal path strings (`:556`), so canonicalize aliases consistently to avoid duplicate opens.
- **Concurrency:** Connection objects are not thread-safe (`pool-adapter.ts:9-12`). Reuse checkout/return (`:940-978`, `:986-1044`), not a shared global overlay Connection. Default is two connections per pool entry, configurable 1-16 (`:187`). Initialization is deduplicated by ID (`:524-535`), not universally by file path.
- **Locks/publication:** pool uses read-only Database construction (`:566-570`) but explicitly handles lock failures (`:579-582`). Read-only is not proof that readers can coexist with an active writer to the same file. Publish a completed/checkpointed overlay and close readers before in-place rebuild; do not rely on the comment at `:558-560` as a runtime lock guarantee. Base preflight checks analyze locks and recovery sidecars (`local-backend-repo-runtime.ts:55-75`); those checks do not automatically protect a companion overlay writer.
- **Disposable store freshness:** a persistent cached handle cannot automatically see a replaced DB. Bind it to the builder's publication generation/file identity and covered paths/digests. Dirty status alone does not prove the overlay matches current file contents. This protocol is not supplied by the inspected reader source.
- **Memory/LRU:** each distinct overlay DB adds a buffer manager/native mapping and its own connection/prepared-statement caches (`pool-adapter.ts:168-200`, `:566-568`). Five-entry LRU and five-minute idle timeout (`:182-187`, `:251-264`) mean overlays consume repo capacity and can evict base entries between queries; recheck readiness, don't trust cached boolean state. No exact RSS estimate was measured. Driver documents a default 8-TB mmap address-space ceiling (`node_modules/@ladybugdb/core/database.js:17-19`), not 8 TB resident RAM.
- **Teardown:** explicit close waits for checked-out queries (`pool-adapter.ts:349-370`), but native close is fire-and-forget in teardown (`:284-308`), and comments flag platform destructor hazards. Waiting for pool close alone is not demonstrated proof that a writer may immediately reopen/delete the same file.
- **Path contract:** LadybugDB's store is a single file (`lbug-adapter.ts:600-601`). If `<storagePath>/overlay` is a directory, actual DB path must be inside it (for example `overlay/lbug`); if it is the file itself, pass it directly. Confirm the builder's contract rather than assuming.

## 4. Alternatives, second review, and recommendation

Three materially distinct approaches:

| Approach | First review | Second review / disposition |
| --- | --- | --- |
| Rewrite all outputs at dispatch/envelope | Few edits; simple rollback; preserves base store. | Cannot find added symbols, fix pre-merge limits/ambiguity, or prove refreshed edges; arbitrary rows lack identity. Masks stale-data symptoms. Reject. |
| Federate every Cypher read at the pool layer | Central interception; potentially covers more consumers. | Aggregates, joins, ORDER/LIMIT, absent path columns, and cross-store relationships require real query federation, not array merging. Large compatibility/performance/security surface and difficult validation. Reject. |
| Merge at typed symbol boundaries, reuse pool | Small existing-owner change; additive provenance; parameterized queries; independently testable; revert hooks/helper for rollback. | Must cover UID-not-found, deletion, all retrieval lanes, cache hits, and source-only impact short circuit. Symbols-only means graph claims remain partial/unavailable. **Recommend.** |

The second pass specifically challenged the assumption that one symbol resolver covers everything: actual query uses backend-search, impact has an earlier source fallback, and group UID impact bypasses that resolver. It also rejected using dirty-result paths as the complete selector: those contain only paths already present in returned data.

Recommended implementation sketch (proposal only; nothing implemented):

1. Add one focused `src/mcp/local/backend-overlay.ts` helper for read-only companion acquisition and path-filtered symbol reads. Use pool `initLbug` with a reserved internal ID; leave base handle/public repo identity unchanged. Never register overlay as an independent user-visible repo. Keep initialization sequential per actual repo and retain the existing pool lifecycle.
2. Resolve `TargetContext` against the selected canonical checkout and pass an immutable request read context to query/context/impact. Use `dirtyWorkspace.dirtyPaths` as suppression/routing set. Match repo-relative paths exactly after slash normalization; do not lowercase paths.
3. Merge matching overlay identities with clean base identities before ranking/disambiguation. A dirty path is a whole-file replacement boundary, not a node-ID update: suppress removed/renamed symbols too. Query must search overlay independently, not merely fetch replacements for base hits. Reuse `backend-query.ts` BM25 helper if the builder supplies compatible FTS; no vector requirement for a symbols-only overlay. Missing search capability must be explicit, not silently described as full recall.
4. Propagate optional `source: "overlay"` through identity/output types and selected-store label/content lookups. Do not attach base process/community/citation facts to an overlay definition. Preserve validation, path canonicalization, parameterization, limits, and cancellation.
5. Reuse unavailable graph-impact policy for overlay-only targets, and flag base graph relationships as snapshot/partial wherever dirty paths can affect coverage. Do not report zero impact/LOW from a symbols-only store. For dirty impacted endpoints, filter/substitute before BFS enqueueing and recompute counts from retained evidence; kernel modification is needed for that claim.
6. Use `freshness.dirtyResultPaths` as an **affected-output diagnostic**, not provenance or a complete input list. `target-context.ts:96,719-731` caps paths at 50; truncated/unknown dirty coverage must fail closed for authority claims. `response-envelope.ts:339-363` scans at most 5000 nodes and only `filePath/path/file` keys; absence of hits is not proof of cleanliness. `:401-423` computes hits from final results. For legacy raw tools, call the existing helper with the same snapshot if attaching freshness; a breaking envelope conversion is unnecessary. Do not remove degraded graph freshness merely because some identities came from overlay.

Expected production touch set: `local-backend.ts`, new `backend-overlay.ts`, `backend-search.ts`, `backend-symbol-resolution.ts`, `backend-context.ts`, `backend-impact.ts`; add `src/core/impact/impact-kernel.ts` if serving/substituting dirty impacted endpoints rather than only target identity. Reuse `backend-query.ts`, `target-context.ts`, `response-envelope.ts`, and `pool-adapter.ts` unchanged unless builder/search or bounded-coverage requirements reveal a concrete need. No singleton refactor is required.

Focused regression proposals: base+overlay distinct-store parallel reads; dirty updated UID; overlay-only added symbol; deleted/renamed symbol not resurrected; clean same-name candidate still disambiguates; dirty structured-cache hit cannot leak base results; provenance survives serialization; overlay-only impact returns UNKNOWN/unavailable; clean-target dirty-neighbor traversal is partial; generation replacement, unavailable overlay, >50 dirty paths, and pool eviction. Existing surfaces include `test/integration/lbug-pool.test.ts`, `lbug-pool-stability.test.ts`, `test/unit/backend-impact-identity.test.ts`, `backend-context-bounds.test.ts`, `backend-search-typed.test.ts`, `target-context.test.ts`, and `response-envelope.test.ts`.

## 5. Evidence and unverified items

Executed from `/opt/d1/_wrk/ontoindex/ontoindex`: `ontoindex --help`, `ontoindex status`, `ontoindex query "How do MCP local backend query context and impact resolve repositories and execute LadybugDB reads?"`, a second path-bounded query, CLI context for `ensureRepoInitialized` and `resolveSymbolCandidates`, and depth-1 CLI impact for the resolver. Direct numbered source reads supplied the citations. Index and HEAD both matched `2476923`; dirty worktree alone did not justify reindexing.

**OntoIndex stale/degraded: semantic search reported `Binder exception: Cannot change literal expression data type from FLOAT[384] to FLOAT[768]`; source inspection is authority.** First query still returned BM25/structural results; the path-bounded query returned none. CLI impact reported zero upstream callers for the resolver, although direct imports/calls exist in context and impact. Treat that graph result as incomplete, not proof of no blast radius. No reindex was attempted: this spike forbids repository writes.

Not verified:

- No companion overlay existed at the conventional local index path inspected. No two-distinct-store runtime smoke, writer/read-lock experiment, generation-swap experiment, or memory measurement was run.
- Pool source supports multiple paths; existing tests inspected include two IDs sharing one DB (`test/integration/lbug-pool.test.ts:94-102`) and one-store concurrent queries (`lbug-pool-stability.test.ts:60-168`). They were not run and do not prove distinct overlay-store operation.
- Builder schema, FTS/vector availability, publication protocol, covered-file manifest/digests, tombstones, and source-content parity are unknown. Concurrent writer behavior across platforms remains unproved.
- Full neighborhood, group/batch, cross-repo bridge, raw-Cypher, and enrichment overlay semantics were not validated; bypasses are explicitly identified above.
- No tests/builds/formatters were run; no implementation correctness or performance claim is made. CLI navigation uses the installed binary; inspected source was confirmed separately, not assumed to be byte-identical to that binary.
- No callable sub-agent dispatch or OntoIndex MCP tools were exposed in this session. The required four Luna/Sol agents could not be dispatched; models were not substituted. Native `rg` was absent; focused `grep`/numbered reads followed CLI navigation instead.

Only requested deliverable: `/tmp/rt5-spike-report.md`. No tracking state, worktrees, commits, or repository documentation were changed.
