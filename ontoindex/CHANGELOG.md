# Changelog

All notable changes to OntoIndex will be documented in this file.

## [Unreleased]

## [2.3.20] - 2026-10-30

- TypeScript and JavaScript calls to an inherited method resolve again when an unrelated class in the same file defines a method of the same name. Before, with `class Foo extends Base` and `class Baz { greet() {} }`, `f.greet()` on a `Foo` produced no `CALLS` edge; it now resolves to `Base.greet`. Genuine overloads on the receiver's own class chain are handled as before.
- More Rust element receivers resolve: the item in `for (i, x) in v.iter().enumerate()` and `.enumerate().map(|(i, x)| ...)`, `HashMap` `keys()`, `values()` and `values_mut()` (key or value type), and closures passed to `filter_map`, `flat_map`, `inspect`, `position`, `take_while` and `skip_while`. Map `iter()` items and the enumerate index stay untyped.

## [2.3.19] - 2026-10-30

- A member call no longer binds to a method owned by an unrelated type in the same file. Before, `fn c(f: Foo) { f.only_baz(); }` in a file that also defined `Baz::only_baz` produced a `CALLS` edge to `Baz::only_baz` with reason `same-file` and confidence 0.95. This affected Rust (typed, indexed and closure receivers), TypeScript, JavaScript and Python. Methods owned by the receiver type, by one of its ancestors (inherited methods, default trait methods) or by no type still resolve.

## [2.3.18] - 2026-10-30

- Rust method calls on elements of a typed container resolve again. `v[0].bar()` and single-parameter closures passed to `map`, `filter`, `for_each`, `any`, `all` or `find` on `v.iter()`, `iter_mut()` or `into_iter()` now get the element type of `v: Vec<Foo>`, so their `CALLS` edges to `Foo::bar` return. 2.3.17 had dropped them.
- A closure parameter no longer inherits the type of a same-named local. Before, `let f = mk(); let g = |f| f.bar();` produced a wrong `CALLS` edge to the local's type. Typed parameters use their annotation, untyped parameters produce no edge, and neither changes the enclosing function's bindings.

## [2.3.17] - 2026-10-30

- A Rust method call whose receiver type is unknown or comes from another crate no longer binds to an unrelated same-file method of the same name. Before, `make_sq(2).area()` in a file that also defined `Other.area` produced a wrong `CALLS` edge with reason `same-file` and confidence 0.95. Calls with a known receiver type, free calls, module aliases, import-resolved candidates and other languages are unchanged.
- The Rust scope-extraction warning no longer claims that all calls in skipped files are indexed. It now says that symbols, name calls and import calls are indexed and that method calls on unresolved or foreign types may be missed.

## [2.3.16] - 2026-10-30

- No runtime change. Four project plans whose work shipped in 2.3.4 (Markdown retrieval ranking, mention resolution, answer grounding and `docs verify-answer`) now record their tasks as done, so plan tooling no longer offers them as open work.

## [2.3.15] - 2026-10-30

- A query whose working-tree graph is refused as too large (`workspace_too_large`, above `ONTOINDEX_WORKSPACE_MAX_FILES`, default 1600) now answers from the committed index instead of failing. This applies to `context`, `impact` and `query` on any large repository with uncommitted edits. The answer carries `readContext.mode: "committed"` and a warning that names up to 10 uncommitted source files it cannot see, with the total count. When no trustworthy committed index exists, the original refusal is returned unchanged.
- The Rust scope-extraction warning now says that skipped files are outside the supported subset and that their symbols and calls are still indexed by the standard Rust resolver.

## [2.3.14] - 2026-10-29

- Repo tool queries schedule one managed background refresh when the indexed commit differs from HEAD, or indexed-scope files change in a repository without commits, while returning the existing index with a freshness warning. Refresh keeps the recorded scope and excludes `huge-repo-symbols` indexes; `ONTOINDEX_AUTO_REFRESH_INTERVAL_MS` sets the interval (default 5 minutes), and `ONTOINDEX_AUTO_REFRESH=0` disables it. Dirty-only edits use the automatic overlay.
- While a refresh runs, queries keep answering: a published index generation stays readable while analyze holds its lock (only the legacy in-place database is refused), a managed refresh waits up to two minutes for a briefly held analyze lock instead of failing, and a query whose working-tree read is busy, too large, or timed out answers from the committed index with a warning when a refresh is scheduled.
- The Claude hook says the next query refreshes the index automatically, and its CLI fallback runs the installed `ontoindex` instead of downloading with `npx`.
- Agent guidance queries OntoIndex first, uses stale/refreshing evidence with freshness labels and source verification, and reserves manual refresh for immediate needs with no active job. Sub-agents never reindex, and staleness alone never triggers grep-only fallback.

## [2.3.13] - 2026-10-29

- The Claude hook keeps augment cooldown stamps and locks in one private temp subdirectory (`ontoindex-hook-augment/`, mode 0700). At most once an hour it deletes stamp and lock files older than 24 hours, capped at 500 per pass, including legacy files left directly in the temp directory. Cooldown and lock behavior are unchanged.

## [2.3.12] - 2026-10-29

- Runtime health `workspaceReadiness` reports `within-limit` or `over-limit` from the indexed file count against the workspace-graph limit (`ONTOINDEX_WORKSPACE_MAX_FILES`, default 1600), with the committed-mode remediation when over the limit. No preparation is attempted; without a recorded file count it stays `not-checked`.
- The dirty-workspace search warning says when a queried identifier appears in an untracked source file and lists that file first. It scans at most 50 untracked source files of up to 256 KiB each, inside the repository only.
- Index capability warnings name up to five degraded file paths (`Degraded paths: ...`, `+N more`).

## [2.3.11] - 2026-10-29

- Fixes a 2.3.10 regression: crates that inherit from a workspace without being listed in `[workspace] members` lost their library roots, although Cargo admits path dependencies of members as implicit members. On a 7,000-file Rust and TypeScript workspace this removed about 4,400 edges. `members` no longer limits inheritance; `exclude` still does.

## [2.3.10] - 2026-10-29

- Rust files whose scope extraction reports unsupported syntax no longer block replay of retained parse output; they are recorded as `not-required` in the retention inventory. Unexpected Rust errors, missing outcomes and TypeScript failures still refuse replay. Rust calls and imports still come from the legacy extraction path.
- Renamed dependencies (`alias = { package = "real" }`) map to the real crate across normal, dev, build, target-specific and `workspace = true` dependencies; an alias that names two crates stays unresolved.
- The tool contract's `hostVisible` lists the tools the server advertises for the active startup profile, including facades.
- Runtime health names up to five degraded files (`+N more`) in the degraded reason.
- `inspect` explore/related and `search` semantic add one warning when dirty or untracked source files are absent from the graph, naming up to five paths with query matches first. The warning is omitted when a workspace graph answered the request, and it is part of the paged response.

## [2.3.9] - 2026-10-29

- Rust crates that inherit their edition from the workspace (`edition.workspace = true`) are now recognized, so imports between crates in such workspaces resolve. 2.3.8 found no crates in these layouts; its notes wrongly said the fix covered them. The nearest ancestor `[workspace]` supplies the edition. `package.workspace = "<path>"` selects an explicit root, and a root whose `[workspace] exclude` lists the member is skipped. A missing or invalid inherited edition is reported as a manifest parse error.
- `meta.json` stats record `scopeSkippedUnsupportedRustFiles` when Rust files were skipped during scope extraction.

## [2.3.8] - 2026-10-29

- Rust imports between crates in a Cargo workspace resolve to the target crate's library (`package.name` or `[lib].name`, with `-` mapped to `_`), including items re-exported from the library root with `pub use`. A module declared with `mod` in the crate root takes precedence over a workspace crate with the same name; ambiguous crate names stay unresolved. Renamed dependencies (`package = "..."`) are not yet mapped.
- `query`, `context` and `impact` CLI commands report workspace preparation failures as one line with the error code, diagnostics and the `--read-mode committed` option, and exit with status 1 instead of printing a stack trace. Other errors are reported as before.
- Analyze prints one summary line with the number of Rust files whose scope extraction was skipped for unsupported syntax, instead of a warning per file.

## [2.3.7] - 2026-10-29

- Rust member calls on receiver types that are not in the index, such as `HashMap`, stay unresolved instead of linking to an unrelated method with the same name.
- Audit report Markdown shows a partial-report warning and marks sections from failed or timed-out backends as unavailable instead of reporting no findings. JSON results add optional `incompleteSections`.

## [2.3.6] - 2026-10-28

- Committed-mode errors identify the rejected operation and list supported navigation operations.
- Response-budget errors report a usable retry size.
- Verification explains omitted expected files and the coverage limits of checks with no changed production symbols.
- Tests isolate telemetry, query logs and paged results in temporary storage.
- Release packages exclude generated native build metadata containing developer machine paths.

## [2.3.5] - 2026-10-28

- Workspace navigation supports bounded dirty-file overlays, reports covered and uncovered source files, and invalidates overlays after subsequent saves. Committed-index reads remain explicit.
- TypeScript and JavaScript scope capture supports additional ordinary expressions, async declarations and methods, and flat object-pattern lexical declarations with defaults. Unsupported syntax continues to produce explicit whole-file refusals; coverage is not complete.
- Native database handle cleanup, generation pinning and process identity checks improve reader lifecycle safety.
- Answer grounding checks resolve cited paths and symbols against indexed evidence, with a CLI command for document verification.
- Analyze URL handling and server grep requests enforce bounded inputs.

- MCP defaults to the `core` startup profile with only the 8 facades advertised; legacy `gn_*` names remain callable aliases, and `ONTOINDEX_MCP_STARTUP_PROFILE=public-full` restores the 62-tool listing.
- The installer allows the `ontoindex`, `tree-sitter` and `@ladybugdb/core` install scripts on npm 11 for global installs.
- `gn_diagnose` reports `processMemory` (RSS, heap, native memory, open repository pools, buffer size and idle-exit setting) and recommends `ONTOINDEX_MCP_IDLE_EXIT_MS` when a server holds 400 MB or more of native memory with no open pool.
- `ONTOINDEX_MCP_IDLE_EXIT_MS` no longer exits the MCP server while a repository connection pool is still open.
- Impact analysis binds traversal node ids as a query parameter instead of building them into Cypher text, and reports `UNKNOWN` risk (never `LOW`) when a depth query fails.
- `export const f = () => ...` emits one `Function` symbol instead of a duplicate `Function` and `Const`, in both the sequential and worker parsers.
- tsconfig path aliases that name an emitted `.js` file (for example `@/a.js`) resolve to the TypeScript source.
- LadybugDB FTS and VECTOR network extension installs now require `ONTOINDEX_ALLOW_EXTENSION_INSTALL=1`; unavailable extensions are cached for the session, and FTS index creation reports a clear error when FTS cannot load.

## [2.3.4] - 2026-10-14

This release also carries 2.3.1 to 2.3.3, which were prepared but not published separately.

- Markdown context ranks chunks by BM25 over heading paths and excerpts, using at most 32 distinct query terms. Non-matching chunks are dropped unless a `retrieval_policy` is set; queries with no tokens keep path order. Low-authority paths receive a 0.5 weight, and matching chunks in documents linked from the highest-ranked chunk receive a link bonus.
- Markdown responses bound `facts`, `visibleRecords` and document `freshness` to the returned chunks and documents, omit unresolved code-mention facts, and de-duplicate freshness entries. `factsBound` reports the original counts and truncation; `markdownPpr.skipped` contains at most 5 entries, with the full count in `summary.skippedTotal`. Recorded queries on this repository shrank from 7.1 MB to about 87–153 KB in the final build (8 queries, with mention resolution included); 8 of 8 expected documents ranked in the top 5.
- The Markdown sidecar collects root `SECURITY.md`, `CONTRIBUTING.md`, `CHANGELOG.md`, `CODE_OF_CONDUCT.md` and `LICENSE.md` through an exact-name allowlist. `includeFiles` cannot bypass other built-in ignores; user ignore rules and the scan-size cap still apply. Existing sidecars need one `ontoindex docs sidecar run markdown`.
- Markdown document facts in responses are capped at 25 per source chunk and fact kind, preserving original order; `factsBound` reports the per-chunk-kind limit and omissions, and `truncated` indicates omitted facts. Stored sidecar facts, chunk selection and ranking are unchanged.
- Markdown retrieval resolves identifier-like backtick code mentions in returned chunks against the code graph per request. Chunk evidence carries only `mention` (the text); response metadata carries `mentionTargets`, keyed by mention text, with entries only for mentions that matched code symbols: `{ status: "resolved", targets: [{id, name, filePath, startLine}] }` for exactly one match, or `{ status: "ambiguous", targets: [], candidateCount }` (4 means 4 or more). A mention absent from the map is unresolved or was not looked up. `mentionResolution` (`status`: `ok`, `partial`, or `skipped`; `lookups`; optional `reason`) reports the run. At most 40 distinct names are looked up per response, with a 3-candidate limit per name (a fourth candidate is requested to detect overflow) and a 1,500 ms total limit. Ambiguous names are never auto-picked; ranking and stored facts are unchanged, and graph failures and timeouts do not fail queries.
- On macOS, `mcp-doctor` reads server working directories through `lsof` to verify project binding. Reader-pin PID-reuse detection uses the process start time from `ps`; unavailable or invalid start times report not reused.
- Updated the package's `uuid` dependency from `^14.0.0` to `^14.0.3`.
- Rewrote `ontoindex-cli`, `ontoindex-debugging`, `ontoindex-exploring`, `ontoindex-guide`, `ontoindex-impact-analysis`, `ontoindex-pr-review` and `ontoindex-refactoring` for the current MCP tools, and added `ontoindex-navigation` (freshness checks, task-to-tool routing, source-inspection fallback). Skills pass `repo` explicitly, leave reindexing to one coordinating session and no longer treat direct dependents as proof of breakage.
- `ontoindex setup` installs `ontoindex-navigation` first; `ontoindex analyze` also installs `ontoindex-navigation` and `ontoindex-pr-review` under `.claude/skills/ontoindex/`. Upgrading the package does not refresh skills that are already installed: rerun `ontoindex setup`. Copies you changed or that setup does not own are left alone.
- MCP next-step hints, the context and setup resources, the Claude session-start hook and generated community skills now name current tools (`search`, `inspect`, `impact`, `refactor`, `discover`, `audit`, `gn_*`) instead of removed ones such as `ontoindex_query`, `ontoindex_context`, `ontoindex_impact`, `ontoindex_cypher`, `list_repos`, `api_impact` and `detect_changes`. These are text changes only; no tool or schema was added or removed, and rename guidance remains preview-only.
- The Claude plugin and Cursor integration skill copies match the bundled skills and include `ontoindex-navigation`.
- Corrected the `ontoindex-cli` skill: removed the claim of an automatic post-commit reindex hook, documented `--skip-agents-md`, `mcp-doctor` and `clean --generations`, and described what `wiki` sends to an external LLM, a public Gist and saved credentials.
- New guards fail the build on removed tool names in next-step hints, on skill metadata and length, and when a plugin copy drifts from the bundled skills (`plugin-skills-sync.test.ts`).

## [2.2.31] - 2026-10-14

- LadybugDB pool: corrupt-WAL recovery now starts only for a WAL replay error (`classifyLbugOpenError`). A permission error, an unsupported storage version, an out-of-memory error or an extension error keeps its original message, is not retried with WAL-tail discard, and no longer prints a WAL warning. Lock detection matches native lock phrases instead of any message containing `lock` (so `block` and `clock` no longer count). A failing close of the failed wrapper no longer masks the original error, and the "unrecoverable" error names the recovery cause.
- `mcp-doctor`: several servers bound to the target, including one started with an explicit `--project` next to others bound by working directory, now report `ok` with the counts and prefer the explicit one for the reported PID.
- `ontoindex setup`: the stale staging and backup sweep now keeps an artifact whose embedded PID is alive until it is 60 minutes old, takes age from the newest entry inside the directory, and creates staging directories with exclusive `mkdir` and retries. The remaining sub-millisecond gap during a managed refresh is documented, since Node has no atomic directory exchange.
- `gn_diff_impact`, `gn_review_diff` and `gn_pre_commit_audit` run git through the async `execFileText` helper instead of `execFileSync`, so a slow `git diff` on a large dirty tree no longer blocks every other MCP request for up to 5 seconds.
- New opt-in `ONTOINDEX_MCP_IDLE_EXIT_MS` (60000 to 86400000, default off): the stdio server exits after that long with no requests and none in flight. Leave it unset for clients that do not restart a stopped server.
- Test fix: the gated real-driver WAL test seeds its database in a child process. Seeding in the test process let the driver finish its close asynchronously and consume the corrupt WAL, so about one run in three passed without exercising recovery or failed spuriously.

## [2.2.30] - 2026-10-14

- LadybugDB pool: corrupt-WAL recovery now runs. A real database with a bad `<db>.wal` fails in `init()` (checksum failure or read past the end of the file), not in the constructor, and the previous code rethrew before the recovery open could start. The failed primary wrapper is now closed while the generation pin stays held, then the database is reopened with WAL-tail discard. If recovery also fails, the recovery wrapper is retained with the pin and the unrecoverable error is thrown. Lock errors keep their retry loop and are retained only after the last attempt. A gated real-driver test (`ONTOINDEX_REAL_WAL_TEST=1`) covers both a checksum failure and a truncated WAL. The MCP server's existing preflight still refuses to open an index that has a non-empty `lbug.wal` or `lbug.shadow` sidecar and asks for one coordinated `ontoindex analyze`, so the pool-level recovery is reached only when that preflight passes (for example a sidecar that is absent or empty, or a path already marked ready). That policy is unchanged.
- LadybugDB pool: cleanup of expired failed opens is per entry, so one failing close no longer blocks opening other repos. `closeLbug()` without an argument also closes retained failed opens and releases their pins. The `_initPromise` workaround only runs when the driver field exists.
- `ontoindex setup`: skills are copied into a staging directory and renamed into place, so a failure part-way no longer leaves an unmarked half-copy that later looks user-owned. A managed refresh keeps the old copy until the new one is in place. Stale staging and backup directories older than 10 minutes are removed.
- Response paging: an explicit `maxBytes` is honored. Only when not even one character fits is the budget raised, and the page then carries `budgetRaisedTo`.

## [2.2.29] - 2026-10-14

- `mcp-doctor` run from a directory that is not an indexed repository (no `--repo`, no `--project-cwd`, no `ONTOINDEX_MCP_PROJECT_CWD`) now reports DEGRADED with a `no-target-repo` gap and `ontoindex mcp-doctor --repo <name>` as the next command, instead of MISCONFIGURED with a placeholder path. An explicit selector that is not found, and an ambiguous target, stay MISCONFIGURED.
- LadybugDB pool: a failed native open is cleaned up and its generation pin released after a cool-down (`ONTOINDEX_LBUG_FAILED_OPEN_RETRY_MS`, default 30000, range 1000..600000), at the next pool admission. Within the cool-down the cached failure is returned. Failed entries no longer exhaust the five-entry pool until the process restarts.
- Response paging: a custom `maxBytes` that cannot hold the envelope is raised to a 1024-byte floor instead of throwing; zero, negative and non-finite values use the default.
- `gn_ensure_fresh` embeddings status gains an additive `prerequisites` object (`urlConfigured`, `modelConfigured`, `modelHashConfigured`, `note`) so a missing-embeddings result says which of `ONTOINDEX_EMBEDDING_URL`, `ONTOINDEX_EMBEDDING_MODEL` and `ONTOINDEX_EMBEDDING_MODEL_HASH` is unset. Values are never returned.

## [2.2.28] - 2026-10-14

- Argument limits: the aggregate JSON cap is now `ONTOINDEX_MAX_ARG_TOTAL_BYTES` (default at least 4 MiB and always above the per-string cap), so a maximum-size `sourceText` or `pastedText` is no longer rejected. The default array cap is 1024 items (`ONTOINDEX_MAX_ARG_ITEMS` still overrides). Error messages name the variable to raise.
- Host gate: `ONTOINDEX_ALLOWED_HOSTS` lists extra trusted authorities (`host` or `host:port`, no wildcards) for reverse proxies and port forwards. `localhost.` with a trailing dot is accepted. `X-Forwarded-*` headers are still not trusted and the Origin policy is unchanged.
- `mcp-doctor`: more than one running MCP server with none bound to the target now reports `ambiguous` (DEGRADED) with at most 5 candidates, instead of blaming the first unrelated server as MISCONFIGURED. A single verified foreign server still reports a mismatch. Missing-embedding gaps list which prerequisites are unset (URL, model, `analyze --embeddings`) without printing values or probing the network.
- `ontoindex setup`: skills are installed with an `.ontoindex-managed` marker. Existing user-owned skills are skipped and reported, symlinked targets are skipped, and legacy `gitnexus-*` cleanup removes only a real directory that contains just an invalid `SKILL.md`.

## [2.2.27] - 2026-10-13

- LadybugDB buffer manager defaults to 64 MB when `ONTOINDEX_LBUG_BUFFER_MB` is unset, empty, `0` or invalid; valid values 1..16384 still override. This cuts per-server resident memory when many sessions run at once.
- Eval-server and REST API reject requests with an untrusted `Host` (loopback binds) or untrusted `Origin` before any handler runs, closing the cross-origin simple-POST and DNS-rebinding path. Origin matching is now exact and parsed (`http://localhost.evil.com` no longer passes a prefix check).
- Facade tool numeric arguments are clamped to the bounds declared in each tool schema; non-finite or non-numeric values are dropped. Shared argument limits add an array cap (`ONTOINDEX_MAX_ARG_ITEMS`, default 256) and a 1 MiB aggregate cap for MCP, REST search/query and eval-server.
- MCP server installs shutdown handlers before `server.connect`, also listens for stdin `close`, and shuts down at once if stdin is already ended.
- Reader pins whose PID now belongs to a younger process (PID reuse, Linux `/proc` start time) are swept as dead.

## [2.2.26] - 2026-10-13

### Fixed

- Plain `ontoindex analyze` now publishes the new index generation through the same transaction as managed analysis. Before, only managed analysis wrote the `.retention-managed` marker and pruned, so every command-line analyze left one more unmarked generation behind forever. Now each new generation gets a marker and old marked generations are pruned to the active one plus the two newest, with live reader pins respected. Generations created by earlier versions have no marker, so automatic pruning still never touches them; remove them with `ontoindex clean --generations`.
- `ontoindex clean --generations` ranks generations by the `.retention-managed` publication sequence, falling back to the leading number of the directory name. Before, it ranked by the name alone and could keep an older-named generation while treating the most recently published one as obsolete.
- `ontoindex clean --generations` no longer loses its report when one deletion fails. Each failed deletion is listed as skipped with a short reason, the remaining generations and repositories are still processed, and the command exits with code 1 only after printing everything (and only with `--force`).
- `ontoindex mcp-doctor` shows which informational runtime warnings sit behind the optional `runtime-warnings` gap. `capabilityGaps[].details` (JSON) and indented lines under "Optional capabilities" (text) list up to five distinct warnings, each cut at 200 characters, with a `+N more` line when there are more.

## [2.2.25] - 2026-10-13

### Added

- `ontoindex clean --generations [--force] [--keep <n>] [--all]` removes obsolete index generations. It prints a plan by default and deletes only with `--force`. It keeps the active generation and the `--keep` newest others (default 2, range 0 to 10) as rollback candidates, keeps any generation with a live reader pin, an incomplete generation (missing `meta.json`, `snapshot.json` or the database file), and everything while an analysis is running or when no active generation resolves. It runs under the generation pointer lock, re-checks each candidate before deleting, deletes at most 50 per run, and never removes the active index, writes markers, or unregisters a repository. Generations created by older versions have no retention marker, so ordinary pruning never removed them.

### Fixed

- `POST /api/search`, `POST /api/query` and the `eval-server` `/tool/:name` route reject string arguments longer than `ONTOINDEX_MAX_ARG_CHARS` (default 2,097,152) with HTTP 400 before any repository lookup or database work, matching the MCP tools.
- `mcp-doctor` expects the Codex skills directory `~/.agents/skills` only when `~/.codex/config.toml` or `~/.codex/hooks.json` exists, so an empty `~/.codex` no longer degrades the verdict.
- `mcp-doctor` lists a `runtime-warnings` reason as an optional capability gap when every warning is one of the known informational notices (untracked or dirty files absent from the graph, no embeddings). Any other warning still degrades the verdict.

### Documentation

- The README documents project selection for `ontoindex mcp`, the doctor verdicts and `capabilityGaps`, `ONTOINDEX_MAX_ARG_CHARS`, `ONTOINDEX_LBUG_BUFFER_MB` and `clean --generations`.

## [2.2.24] - 2026-10-13

### Fixed

- Reader pin files left by killed servers (`<generation>/.reader-<pid>-<rand>`) are now removed. Every open, release and publish sweeps pins whose process is definitely dead, on every generation including the active one and unmanaged legacy ones, at most 2000 per call. Generation directories are never removed by the sweep and retention policy is unchanged.
- `mcp-doctor` can now confirm a server that was started without `--project`. On Linux it reads the process working directory from `/proc/<pid>/cwd` and applies the server's own rule (git root of the cwd, else the cwd), so cwd-selected servers no longer report `process-project-binding-unverified`. Several servers bound to the same project by working directory (one per client session) count as `ok`; duplicates that all pass an explicit `--project` stay `ambiguous`.
- String tool arguments longer than 2,097,152 characters are rejected for every tool (super, facade and legacy) with `Invalid arguments for <tool>: <key>: string longer than <N> characters`. `ONTOINDEX_MAX_ARG_CHARS` (1024 to 67108864) changes the limit. A 10 MB query previously cost about 250 MB of server memory.
- Numeric arguments with a declared `minimum` or `maximum` are clamped into range before the handler runs instead of being passed through. Out-of-range values are not rejected, so existing clients keep working.

## [2.2.23] - 2026-10-13

### Fixed

- A clone made by 2.2.21 at its URL-hashed directory has no ownership marker, so re-analyzing it failed with "Refusing to replace an existing directory". `cloneFresh` now replaces that exact hashed directory when it is a real directory with a real `.git`, and writes the marker. The delete handler still keeps unmarked directories.
- `repoKey` and `availableRepos[].key` return the canonical id for same-name repositories, so a returned key can be passed back without becoming ambiguous. Unique names are unchanged.
- Docs evidence no longer falls back to a registry entry named `OntoIndex` when the repository selector is unknown or ambiguous; it reports `repo-not-registered`.
- `ontoindex setup` exits with code 1 when any client configuration fails, after printing the errors and finishing the remaining clients.
- The Claude pre-tool hook exits without running `ontoindex` when `timeout` is not installed, so it can never run unbounded.

### Added

- `ONTOINDEX_LBUG_BUFFER_MB` (integer 0..16384, default 0 = library default) sets the LadybugDB buffer pool for read-only opens, including the recovery open. On the 273 MiB ontocode index a 64 MB cap lowered RSS after open from about 426 MiB to 251 MiB with about 10% slower queries.

## [2.2.22] - 2026-10-13

### Fixed

- Delete a cloned repository's source only when it carries an ontoindex ownership marker (or is an exact legacy clone with a `.git` directory); a repo you placed under `~/.ontoindex/repos` is kept and the delete response reports `keptSource`. Refuse to replace an existing directory that ontoindex did not create, and sweep or restore stale clone staging directories.
- Resolve repositories through the shared resolver in the audit tools, `gn_explore`, `gn_propose_location` and docs evidence, so canonical ids for same-name repositories work and ambiguity is explicit. Compute canonical ids from the full registry even when the server is filtered to one project, and stop retiring a repository id from closing a live alias that shares its database. Ambiguous-repository hints now list the real candidate paths.
- `gn_safe_edit_check` no longer reports SAFE when the index is stale or the worktree is dirty; it reports CAUTION with a `freshness` object and warning.
- `setup` refuses to overwrite a client config that is not valid JSON, writes configs atomically with restrictive permissions, keeps a one-time backup, and handles a UTF-8 BOM.
- `mcp-doctor` no longer reports DEGRADED for missing optional capabilities (embeddings, optional language servers); they are listed under `capabilityGaps`.
- The Claude pre-tool hook no longer runs `npx -y`, uses a 2 second timeout, and fails open.

## [2.2.21] - 2026-10-13

### Fixed

- Recognise LadybugDB 0.17 `has not been installed` extension-load messages, preserve bundled extensions during tests, and use fresh validated clones with canonical-URL directories.
- Bound active analysis jobs and overlay-cache size, use order-independent repository IDs for duplicate names, and prune removed-repository state.
- Clear audit-report timers and reject backend operations while disposing.
- Report HTTP API bearer-token enforcement in diagnostics and cap concurrent heartbeat clients.
- Build before running the test suite.

## [2.2.20] - 2026-10-13

### Fixed

- Reject credentialed clone URLs and run Git with isolated configuration; replace pulls with fresh validated clones.
- Stream process listings in doctor to avoid degraded results on busy hosts.
- Keep failed native-open pins and report restart-required capacity; bound shutdown and startup-timeout cleanup with `ONTOINDEX_MCP_SHUTDOWN_GRACE_MS`.
- Mark additional refusals as errors and repair the generation-retention test.

## [2.2.19] - 2026-10-13

### Fixed

- Redact diagnostic environment values by key name; fail closed after lazy native-open failures, enforce the five-database pool cap, and clean dead reader pins across generations.
- Handle setup TOML header comments, avoid flagging ordinary paths in doctor, and use one repository identity resolver.
- Honor `ONTOINDEX_HOME` in ensure-fresh, mark returned invocation errors as errors, and accept `session` or `sessionId` in session tools.
- Resolve clone DNS and pin public addresses.

## [2.2.10] - 2026-10-12

### Fixed

- Mark dirty graph result entries stale without mutating shared results, including files beyond the capped dirty-path summary.
- Restrict automatically detected verification symbols to explicitly selected files before impact analysis; an empty selection yields no ambient changes.
- Pin published database generations opened through alternate aliases and make concurrent reader-pin release idempotent while preserving failure retries.

### Performance

- Reuse the singleton's held generation pin for warm queries, avoiding repeated reader-file writes and retention scans.

## [2.2.9] - 2026-10-12

### Security

- Reject descendant symlinks in metadata stores while accepting repository root aliases.
- Validate persisted analysis-job and audit-session identity before reading or updating records.
- Contain audit input files to the requested repository.
- Reject process-wide quality-mode mutation through shared HTTP MCP sessions.

### Fixed

- Serialize session updates with ownership-checked locks and atomic writes, preserving own-property keys.
- Pin published database generations while readers use them and retain the current generation and two predecessors.
- Preserve Git revision-search syntax and the advertised audit session alias.
- Open new unmanaged databases through canonical repository aliases.
- Preserve analysis-job root aliases during abandoned-job completion and reread expired records before cleanup.
- Clear the thorough-mode vector setting when selecting a lower quality mode.

## [2.2.8] - 2026-10-12

### Security

- Resolved caller-supplied git revisions and ranges to commit IDs before invoking git, so values such as `--output=<path>` can no longer be parsed as git options in `gn_verify_diff`, `gn_test_gap`, `gn_diff_impact`, `gn_review_diff`, `detect_changes`, and audit-lifecycle git lookups.
- Resolved memory files through real-path containment, so symlinks in `.ontoindex/memories/` can no longer expose files outside the repository.
- Enabled MCP HTTP DNS-rebinding protection when the server binds to a loopback host, and denied `.git/` paths in `/api/file`.

### Fixed

- Validated `gn_*` super-tool arguments against their advertised schemas, and required exact `true` for `autoAnalyze`, `killMcpForLock`, and `force`; audit `persist` accepts only omitted or `true`.
- Accepted `impact` calls that identify the symbol only by `target_uid` or `nodeId`.
- Bounded successful resource responses to the MCP response budget with a visible truncation marker.
- Forwarded search options to every member of `@group` searches and reported options that cannot apply.
- Applied the documented `impact_batch` default `minConfidence` of 0.7.
- Returned 413 for oversized HTTP request bodies and 400 for malformed JSON instead of 500.

## [2.2.7] - 2026-10-12

### Fixed

- Read the active index generation everywhere instead of a stale root database copy, kept root compatibility aliases repaired on every publish, and rolled back the pointer if alias repair fails. A dangling generation pointer no longer lets alias repair overwrite the only legacy index copy.
- Validated internal tool arguments against their schemas before dispatch, reconciled schema drift with advertised tool inputs, and defaulted omitted impact `direction` to `upstream`.
- Required `confirm` to be exactly `true` for symbol mutations and for `gn_safe_refactor` apply. Sandbox apply now reports that it is unavailable.
- Made the rename text-search fallback work without the `rg` binary by falling back to a bounded built-in search.
- Built the vendored `tree-sitter` runtime during install when no native binary is present, so packed installs start the MCP server.
- Masked string literals and comments before detecting Cypher write keywords.
- Gave same-name repositories collision-free path-digest IDs.
- Exposed `Mcp-Session-Id` to browser CORS clients and bounded resource error responses, including the echoed URI.
- Reported mutation result paths with forward slashes on Windows and made Windows-specific tests portable.

## [2.2.6] - 2026-10-11

### Fixed

- Made rename preview-only: apply now fails closed instead of writing broad text replacements, and tool descriptions, hints, and skills describe the preview workflow.
- Restricted `extract_function` to validated same-file top-level JavaScript/TypeScript named functions and showed the real resulting source in dry runs.
- Reported `contextCompleteness.truncated` and query-failure reasons when context results are clipped or partial.
- Returned resource MIME types from resource declarations instead of always reporting `text/yaml`.
- Admitted HTTP MCP sessions only after SDK validation, preserved existing sessions on invalid or disconnected initialization, returned 503 during shutdown, and drained pending initialization on cleanup.
- Raised the minimum `@modelcontextprotocol/sdk` version to 1.30.0, the first release with closed-transport guards.

## [2.2.2] - 2026-10-11

### Fixed

- Required explicit write authorization for rename operations and reported partial apply failures.
- Resolved symlinks before checking containment for repository file operations.
- Improved MCP transport compatibility, HTTP diagnostics, graph-walk initialization, facade mapping, and response pagination.

### Added

- Added `ontoindex watch` and `analyze --dirty-overlay` to refresh symbols from dirty source files without rebuilding the base graph.
- Added overlay-aware search, symbol resolution, context, and status reporting. Overlay impact reports unknown risk because relationship evidence and embeddings remain in the base index.
- Added optional document and query prefixes for remote embedding models.

### Fixed

- Closed native query results before publishing immutable index generations, preventing file growth and native file locks after publication.
- Resolved NodeNext JavaScript import specifiers to TypeScript source files.
- Guarded source mutations against dirty base-index ranges.
- Isolated MCP doctor verdict tests from host setup and stabilized watcher shutdown assertions.

### Changed

- Verified checksum-pinned native extensions before bundling, including offline builds.
- Added cross-process overlay validation to the platform test matrix. Release packages are distributed through GitHub.

## [2.2.0] - 2026-08-18

### Added

- Added tamper-evident audit event chains and the read-only `ontoindex audit integrity` verification command, with an explicitly acknowledged archive-and-reset recovery path.
- Added job-bound managed-analysis publication receipts covering repository identity, target HEAD, source manifest, requested capabilities, generation identity, analyzer contract, and publication time.
- Added capability-aware terminal recovery results to `gn_analyze_job`: `REFRESH_RUNNING`, `REFRESHED`, `FAILED`, and `FRESHNESS_UNCONFIRMED`.

### Changed

- Split managed freshness recovery responsibilities: `gn_ensure_fresh` owns prerequisite classification and exact job submission or reuse, while `gn_analyze_job` owns receipt validation and the final capability-aware post-check.
- Made managed job reuse identity include the target commit, source snapshot, requested graph and embedding capabilities, and analysis options.
- Serialized generation activation, publication commit, and rollback under one owner-checked generation-pointer lock.
- Made legacy audit stores read-only and made trust-sensitive dispatch fail closed unless the complete retained integrity chain verifies.

### Fixed

- Prevented exit code zero or a copied active generation ID from being treated as proof that a managed job published the requested graph.
- Made missing required embeddings actionable even when the indexed commit already matches HEAD.
- Prevented same-HEAD job reuse when the source manifest or requested capabilities differ.
- Made active-job conflicts, analyzer-lock conflicts, and pre-job submission failures return structured outcomes without asking clients to delete analyzer locks.
- Made generation publication transactional: failed coordinator commits restore the exact previous generation, first-generation failures remove the active pointer, concurrent activation is fenced, and failed generations remain available for diagnostics.
- Surfaced owner-lock cleanup failures and rejected rollback through substituted generation symlinks.
- Closed audit-store downgrade and laundering paths that could otherwise hide or re-sign tampered history.

## [2.1.5] - 2026-08-06

### Added

- Added source-manifest and immutable-generation authority metadata so graph-backed review surfaces can distinguish current, stale, degraded, and uncovered evidence.
- Added structural conformance evaluation support, including frozen-path and dependency-boundary oracles with explicit degraded outcomes when evidence is unavailable.
- Added bounded MCP response pagination with continuation cursors for responses that exceed the transport-safe byte budget.
- Added broader PHP import resolution and Rust associated-call extraction coverage.

### Changed

- Moved `gn_ensure_fresh` analysis refreshes onto durable asynchronous jobs that can be observed with `gn_analyze_job` instead of blocking the MCP request lifecycle.
- Made pre-commit and diff review results fail closed or require review when graph authority cannot be established for the current source manifest.
- Improved release-candidate version resolution, resumable publication markers, public release-state verification, and release artifact checks.

### Fixed

- Prevented analysis-job submission from synchronously walking dirty worktree paths, avoiding `EISDIR` failures from untracked embedded repositories and related path races.
- Preserved structured MCP output across response-size boundaries instead of returning truncated or invalid JSON.
- Improved dirty-worktree source-only impact fallback and reduced false cross-language call resolution.

## [2.1.4] - 2026-07-26

### Fixed

- Fixed MCP shutdown on `SIGINT` and `SIGTERM` so cleanup completes with a numeric exit code instead of throwing before LadybugDB resources are released.
- Batched dead-code candidate verification queries, cutting the full local audit runtime from about 17 seconds to 8 seconds on the OntoIndex repository.
- Made dead-code reachability totals count the same symbol kinds as `totalSymbols`.
- Added confidence-aware cycle detection: reports now expose the weakest edge confidence and can exclude name-only global call-resolution edges with `min_confidence`.

## [2.1.3] - 2026-07-26

### Added

- Added bounded degraded-file aggregates, relationship provenance distributions, graph-first evaluation metrics, richer query-log operational fields, and a 14-language call-resolution precision baseline.
- Added a pinned benchmark scenario manifest, optional peak-RSS thresholds, and live GitHub release-asset verification before npm publication.

### Changed

- Replaced the simulated benchmark gate with real Vitest benchmark output and tightened generated agent guidance around graph-first exploration, impact checks, indexed-commit freshness, and diff verification.
- Hardened semantic-cache persistence with atomic writes and byte-bounded eviction, and added shebang fallback for supported extensionless executables.
- Made analyze-lock recovery PID-reuse aware with archived diagnostics, exposed structured runtime repair actions, and made delete-safety checks fail closed when evidence is incomplete or stale.

## [2.1.2] - 2026-07-25

### Fixed

- GitHub releases now include the built `ontoindex-X.Y.Z.tgz` package required by the Linux/macOS and Windows installers.
- GitHub release creation now runs before npm publication so registry failures cannot leave the latest release without its installer asset.

## [2.1.1] - 2026-07-25

### Added

- Added comprehensive MCP test suites and plans for model validation (Kimi K3, Grok 4.5, GLM-5.2-Max).
- Added refactoring plans for system warning hooks, context transaction barriers, and hook augmentation diagnostics separation.

### Changed

- Updated release documentation and pinned version strings to v2.1.1.

## [2.0.11] - 2026-07-24

### Added

- Added a deterministic Kimi K3 MCP smoke harness with repository, tool-call, evidence, and answer-grounding gates.

### Changed

- MCP repository selection now uses the active project path to disambiguate legacy duplicate labels and reports every candidate when ambiguity remains.
- Repository registration now canonicalizes symlinked paths and rejects new duplicate labels, including the deprecated `--allow-duplicate-name` bypass.
- Hook augmentation output now uses an explicit sentinel frame so operational diagnostics stay on stderr instead of leaking into agent context.

### Fixed

- LadybugDB pool startup now tries the resolved cached FTS extension path before falling back to `LOAD EXTENSION fts`.

## [2.0.10] - 2026-07-08

### Fixed

- Made the local Hugging Face embedding and CE reranking runtime optional for global installs, preventing `onnxruntime-node` downloads from exhausting disk space during `npm install -g ontoindex`.
- Added runtime guidance for local embedding/reranking initialization when optional packages are not installed, while keeping HTTP embedding mode usable without those native dependencies.

## [2.0.9] - 2026-07-07

### Fixed

- Repaired `ontoindex setup` hook installation lint fallout by keeping the parsed settings payload immutable after load.
- Restored repo-wide Prettier compliance for the stable publish workflow by formatting the checked `ontoindex` source/test files and excluding donor snapshots under `tmp/` from release-time formatting checks.
- Normalized MCP doctor setup-path output to forward slashes so stale `.claude/settings.local.json` diagnostics stay readable and testable across platforms.
- Made target-context and diagnose repo-path matching case-insensitive on Windows-style paths, preventing false scope-confidence downgrades and misconfiguration warnings when only path casing differs.

## [2.0.8] - 2026-07-07

### Fixed

- Repaired `ontoindex setup` TOML MCP upserts so rerunning setup replaces the full
  `[mcp_servers.ontoindex]` block instead of leaving duplicate `args` keys behind in
  Codex-compatible `config.toml` files.

### Changed

- Updated public install examples and release metadata for the `2.0.8` release.

## [2.0.6] - 2026-07-04

### Added

- Setup CLI now configures native PreToolUse and PostToolUse integration hooks across Codex and Ontocode (in addition to Claude Code) for automatic index augmentation and freshness checks.

### Changed

- Filtered `minimum`, `maximum`, and `default` boundaries out of the MCP tools JSON schema broadcast, mitigating hallucination issues with strict LLM clients like Gemini without compromising server-side validation.

## [2.0.5] - 2026-07-04

### Added

- `ontoindex setup` now writes `ONTOINDEX.md` guidance into Claude Code, Codex, and Ontocode
  home directories and adds a single `@ONTOINDEX.md` include when the client instruction file does
  not already reference OntoIndex guidance.

### Changed

- Installer scripts and `ontoindex setup` help text now point users to rerun `ontoindex setup`
  after installation or upgrades, and explicitly describe the setup step as idempotent.

## [2.0.4] - 2026-07-04

### Added

- Added `ontoindex duplicate-code --mode exact`, a CLI-only advisory wrapper around pinned
  `jscpd@5.0.11` that reports exact duplicate-code groups as bounded summaries or normalized JSON.
- Added duplicate-code ADR and implementation-plan documentation covering the exact-mode scope and
  the proof gate for future semantic duplicate candidates.

### Changed

- Updated public install examples and release metadata for the `2.0.4` release.

## [1.9.29] - 2026-06-27

### Added

- Added `markdown-tracker-state` frontmatter facts and surfaced them through `gn_docs` readiness and
  context responses, including open tasks, blocked reasons, no-dispatch reasons, reopen criteria,
  and next-action hints.
- Added `includePath` / `include_paths` support for review, diff-impact, pre-commit audit, and
  detect-changes flows so agents can limit analysis to repository-relative path prefixes in dirty
  worktrees.

### Changed

- `ontoindex status`, `mcp-doctor`, and audit failure handling now share the same diagnostic
  reporting path for freshness, embeddings, audit freshness, MCP resource exposure, Ladybug store
  support, and extension timeout hints.
- MCP/CLI setup and help text now describe `list_repos` as an MCP tool with `ontoindex list` as the
  CLI equivalent.

## [1.9.27] - 2026-06-25

### Changed

- Switched the Linux/macOS and Windows release installers to use `wget` for release metadata,
  release asset, and LadybugDB extension downloads.

### Fixed

- Persisted `model_hash` into `.ontoindex/meta.json` during analyze so diagnostics can distinguish
  present embeddings from missing embedding metadata.
- Stopped `gn_ensure_fresh` from degrading a populated embedding index solely because the MCP
  process environment does not define `ONTOINDEX_EMBEDDING_MODEL_HASH`.

## [1.9.26] - 2026-06-25

### Added

- Added audit freshness and MCP resource bridge reporting to existing diagnostics surfaces:
  `status`, `mcp-doctor`, and `gn_diagnose`.
- Added bundled LadybugDB `fts` and `vector` extension packaging from the local extension cache
  into release builds, with runtime lookup support for packaged Linux and Windows artifacts.

### Changed

- Windows release installs now prefetch LadybugDB `fts` and `vector` extensions into the local
  cache before npm installation when available from the LadybugDB extension host.

### Fixed

- Stale audit repair guidance in `gn_diagnose` now points to audit replay rather than incorrectly
  suggesting `audit verify` as the repair path.

## [1.9.25] - 2026-06-21

### Added

- Added target-mode test evidence discovery to `gn_test_gap` for symbols, files, and behavior
  queries.
- Added `gn_test_gap` to `gn_test_suggestions` handoff so existing targeted tests are reused before
  suggesting a new test file.
- Added read-first/files-only projection surfaces for exploration and module-neighborhood MCP tools.

### Changed

- Improved embedding, zvec, LadybugDB, runtime-health, and tree-sitter compatibility paths behind
  the existing MCP/CLI surfaces.

## [1.9.21] - 2026-06-20

### Fixed

- Removed vendored grammar package dependency metadata so npm no longer creates nested
  `vendor/tree-sitter-*/node_modules` directories during global installs or upgrades.

## [1.9.20] - 2026-06-20

### Fixed

- Removed install-time `tree-sitter` peer override warnings by vendoring all grammar packages that
  depend on the patched vendored runtime.
- Disabled grammar package install scripts inside vendored grammars so npm installs use shipped
  prebuilds instead of trying brittle nested `node-gyp` rebuilds.

## [1.9.19] - 2026-06-20

### Changed

- Vendored the `tree-sitter` Node runtime source and patched native builds to use C++20, enabling
  published installs on Node.js 24 and 25 when prebuilds are unavailable.

## [1.9.18] - 2026-06-20

### Added

- Added an opt-in zvec semantic vector backend behind the existing semantic search contract, with
  LadybugDB fallback, mirror freshness checks, and diagnostics.
- Added replay-gate evidence for vector backend comparisons: candidate backends must show at least
  2x median direct vector-query speedup and no expected-anchor regression.
- Added ADR 0097 to document the narrowed zvec integration boundary.

## [1.9.17] - 2026-06-18

### Added

- Added MCP runtime diagnostics for generated agent setup and response-budget health.
- Added byte-stable response anchors and bounded expansion contracts for docs, audit, and diff surfaces.
- Added opt-in retrieval diagnostics for semantic search and `gn_explore` so agents can inspect lane contribution and warnings.
- Added embedding status reporting in `gn_diagnose` and `gn_ensure_fresh`, including missing, unavailable, and drifted states with repair guidance.

### Changed

- Wiki generation now emits more deterministic metadata and prompt surfaces for release documentation.
- Added LLM-free retrieval regression fixtures for ADR/code-anchor expectations.

## [1.9.16] - 2026-06-17

### Added

- `gn_diff_impact({ profile: "pr-pack" })` now returns a compact PR readiness summary with a
  `READY` / `REVIEW` / `BLOCKED` verdict, stop conditions, sensitive-path hints, test-gap counts,
  related-doc counts, and next validation commands.
- `gn_review_diff` now includes response-local evidence trajectory metadata so agents can see
  candidate, curated, pruned, verification, and pruning-reason facts without another graph query.
- `gn_review_diff` now includes `contextCost` telemetry with emitted JSON size and known
  candidate/emitted/pruned item counts.

### Fixed

- Added a package-local Prettier config for `ontoindex/` so CLI/core TypeScript formatting does not
  inherit the root web Tailwind Prettier plugin.

## [1.9.11] - 2026-06-16

### Added

- Shared runtime-health reporting for status and MCP response metadata, including dirty, stale,
  failed, and unclean-lock states with repair guidance.
- Recoverable MCP runtime states for not-indexed, wrong-repo, stale/degraded, and truncated-output
  paths.
- Setup and `mcp-doctor` validation for configured client commands, cwd/repo binding, and process
  liveness.

### Changed

- Diff-impact responses now use a bounded summary-first output profile for dirty or broad
  worktrees.
- ADR 0086 is marked implemented for the narrowed core runtime-health and budget contract.

## [1.9.10] - 2026-06-14

### Fixed

- MCP audit/runtime hardening: inline audit verification now normalizes partial findings, `gn_audit_session_start({ persist: false })` no longer tries to create a persisted session lock, and `gn_propose_location` resolves registry repo labels correctly.
- `inspect({ action: "ipc" })` now uses language-neutral symbol labels instead of reporting non-JavaScript symbols as JavaScript.
- Audit reports now use bounded backend runtime handling, and diff-impact responses include summary-first truncation for dirty worktrees.
- CLI analyze skips the risky native LadybugDB close path by default before process exit, avoiding late `free()` / `double free` crashes after successful graph writes. Set `ONTOINDEX_ANALYZE_NATIVE_CLOSE=1` to force the old close path for diagnostics.
- `tree-sitter-c-sharp` now loads through its explicit `bindings/node/index.js` entrypoint and postinstall patches its package metadata, removing Node ESM `DEP0151` warning spam.

## [1.9.9] - 2026-06-14

### Added

- `ontoindex mcp --project <path>` so MCP startup can bind directly to a target repository without relying on env-only harness wiring.
- MCP misconfiguration hardening docs: `ontoindex mcp-doctor` now documents repo-label/path resolution, `READY` / `DEGRADED` / `MISCONFIGURED` verdicts, and the restart hint for project-target mismatches.

### Changed

- MCP repo resolution now prefers explicit startup args and cwd-derived project scope before env fallback, reducing cross-repo miswiring in multi-repo workspaces.
- `ontoindex setup`, repo-resolution errors, `mcp-doctor`, and `gn_diagnose` now emit arg-first repair commands based on `ontoindex mcp --project ...`.
- MCP reference and setup docs now describe repo identity on scoped responses, the `gn_diagnose` misconfiguration branch, and the `ONTOINDEX_MCP_ALLOW_REPO_MISMATCH=1` override.
- Bridge DB overwrite now waits until the promoted `bridge.lbug` is queryable before returning and preserves `.wal` / `.lock` sidecars during atomic swaps, removing intermittent `Table Contract does not exist` failures in native child-process coverage.

## [1.9.5] - 2026-06-13

### Added

- **SummaryNode persistence support** — added `SummaryNode` node schema and `SUMMARIZES` relationship support across shared graph types, Ladybug CSV/schema import, and native graph serialization so repository/community/concept summary trees persist cleanly into the local graph store.

## [1.9.4] - 2026-06-13

### Fixed

- **External MCP repo targeting** — `ontoindex setup` no longer hard-pins `ONTOINDEX_MCP_REPO` to the setup checkout, and MCP runtime now defaults no-`repo` calls to the configured target project path instead of filtering the registry down to the tool repository.

## [1.9.3] - 2026-06-10

### Changed

- Added `docs/README.md`, moved the MCP reference into `docs/reference/mcp.md`, and marked ADR 0082 implemented for the shipped opt-in frontier.
- Added `ontoindex analyze --ann-neighbors` to materialize retrieval-only `ANN_NEIGHBOR` edges during analyze after embeddings are available.
- Added `scripts/install-ontoindex-latest.sh` for installing the newest GitHub release tarball without hard-coding the version.
- Reviewed ADR implementation status against the current codebase and updated implemented/partially implemented records and the ADR index.
- Reworked ADR 0019 to keep only new core retrieval replay functionality and reject logging/MCP capture sprawl.

## [1.9.1] - 2026-06-09

### Added

- **Semantic ANN frontier retrieval** — added retrieval-only `ANN_NEIGHBOR` edge support, one-shot neighborhood search, and opt-in typed backend integration through `retrieval_policy: "symbol-neighborhood"`.
- **Semantic ANN benchmark gate** — added a realistic code-symbol fixture and threshold flags for recall/visited-node validation.

### Changed

- Updated agent skill guidance and public install examples for the `1.9.1` release.

## [1.9.0] - 2026-06-09

### Added

- **Audit lifecycle workflow** — expanded the audit suite with `ontoindex audit ingest`, `verify`, `lint`, and `bundle`, plus corresponding audit/systems-audit MCP surfaces for turning reports into verified implementation bundles and CI-friendly outputs.
- **Typed structured retrieval lane** — `ontoindex query --typed` and MCP semantic search now preserve typed-query documents through backend routing, with optional structured retrieval output and replay-backed regression coverage.
- **Advisory memory and diagnostics surfaces** — added local `ontoindex memory <name>` skeleton authoring, advisory memory context/readiness support for `gn_docs`, an authenticated `/api/mcp/diagnostics` endpoint, and the web settings diagnostics panel.
- **MCP runtime hardening** — `ontoindex setup` now records the intended project path for external tool checkouts, MCP startup reports executable cwd/project/repo scope, and `gn_tool_contract` distinguishes internal callable tools from host-visible wrappers.
- **Release documentation refresh** — rebuilt the public README, added full MCP tool documentation, and aligned package metadata with the `ontograph/ontoindex` repository.

### Fixed

- **Advisory memory validation hardening** — local memory files now reject unsafe paths, invalid freshness/source metadata, oversized payloads, and non-advisory shapes before they cross the resource boundary.
- **Organic recommendation compatibility** — `gn_diff_impact` and `gn_pre_commit_audit` now add evidence-backed recommendations without breaking legacy response fields.
- **Cross-repo MCP safeguards** — `gn_taint_trace` resolves repo-relative paths against the selected repo and rejects paths outside the repo; MCP startup can warn or fail on explicit repo/project mismatches before returning misleading results.
- **MCP packaging guard** — build and smoke tests now verify advertised super-functions resolve to emitted `dist/mcp/super/*.js` modules, preventing missing-module failures such as `gn_pre_commit_audit`.
- **Package release artifacts** — npm dry-run packaging now includes package-local AGPL license and attribution notice files.

### Changed

- **Diagnostics trust boundary** — diagnostics remain redacted at the API layer, and the web settings surface exposes operational metadata without raw session identifiers or audit evidence.
- **Architecture record coverage** — the ADR index now tracks the audit lifecycle, MCP trust contract, structured retrieval, and memory/diagnostics follow-up decisions behind this release surface.
- **License** — the project now ships as `AGPL-3.0-or-later`; prior GitNexus attribution remains in `NOTICE`.

### Performance

- **`analyze` ~33% faster** — moved FTS index creation from the analyze pipeline to first-use lazy initialisation. The 5 `CREATE_FTS_INDEX` calls cost ~440 ms each in LadybugDB regardless of table size (≈2 s fixed overhead) and dominated runtime on small repos and slow CI runners. The cost now amortises across the first `query`/`context` call in a session via a new `ensureFTSIndex` helper. Mini-repo `analyze` measured locally on Windows: 6.4 s → 4.0 s warm; on CI Windows runners (≈3× slower) restores comfortable headroom against the 30 s e2e test budget.

## [1.6.2] - 2026-04-18

### Added

- **Docker support** — containerized ingestion and MCP serving for reproducible runs on CI and container platforms (#848)
- **Language-agnostic heritage extractor** — config+factory pattern for class-heritage extraction (EXTENDS / IMPLEMENTS), completing the extractor refactor alongside method/field/call/variable (#890)
- **Language-agnostic call extractor** — config+factory pattern that collapses ~225 lines of inline parse-worker logic into declarative per-language configs (#877)
- **Language-agnostic variable extractor** — structured metadata for `Const` / `Static` / `Variable` nodes via config+factory pattern (#878)
- **AST-aware embedding chunking** — offset-based splitting preserves symbol boundaries, improving semantic search precision on large files (#889)
- **HTTP consumer detection for jQuery and axios object-form** — `$.ajax` / `$.get` / `$.post` and `axios({ url, method })` now recognized as HTTP call sites (#887)

### Fixed

- **Python external dotted imports** — avoid spurious same-file matches when an import path like `foo.bar.baz` refers to a third-party module (#899)
- **Worker warnings no longer terminate ingestion** — non-fatal parser warnings keep the pipeline running instead of aborting the run (#900, #261)
- **Global-install upgrade `ENOTEMPTY`** — devendored `tree-sitter-proto` install lifecycle + preinstall cleanup so `npm i -g ontoindex@latest` succeeds on top of an older install (#843, #846)
- **`env.cacheDir`** now defaults to a user-writable location, unblocking ingestion on systems where the install directory is read-only (#845)
- **Content-hash staleness detection for embeddings** — zero-node rebuilds no longer skip vector-index creation, fixing semantic search after selective re-analysis (#831)
- **`tree-sitter-c-sharp` version pin** — locked to 0.23.1 to avoid a breaking change in a transitive prerelease (#834)
- **`release-drafter` v7 CI** — replaced the removed `disable-releaser` flag with `dry-run` so release-note drafts still work
- **`npm arborist` crash from `tree-sitter-dart`** — switched the dependency URL format so `npm install` no longer crashes on clean installs
- **Service-group `ManifestExtractor`** — `config.links` now wires the manifest extractor properly, restoring cross-link discovery that had silently dropped to zero

### Changed

- **SemanticModel wired as a first-class resolution input (SM-20)** — `call-processor`, `resolution-context`, `type-env`, and `heritage-map` now consult `table.model.*` directly; 37 internal call sites migrated off the SymbolTable wrapper (#885)
- **Per-strategy `ImportSemantics` hooks** — `named` / `wildcard-transitive` / `wildcard-leaf` / `namespace` strategies split into composable hooks, replacing the monolithic conditional (Strategies 1–4 of #886)
- **Class extraction configs moved to `configs/` subdirectory** — per-language class configs now co-locate with the other extractor configs, completing the extractor layer's directory convention (#879)
- **CLI AI-context trimmed** — duplicated CLAUDE.md block removed from the shipped context, reducing token usage in LLM-consuming workflows (#904)
- **LLM context files optimized** — AI-consumed documentation tuned for accuracy and token efficiency (#857)
- **Workflow concurrency standardized** — all CI workflows adopt the consistent concurrency key pattern documented in CONTRIBUTING.md; release-note labeling automated (#837)
- **E2E status-ready timeout raised** — 45s accommodates parallel-worker startup variance on CI (#908)

### Chore / Dependencies

- **tree-sitter 0.25 upgrade readiness** — daily Dependabot monitor for the upcoming major-version bump (#847)
- Dependency bumps: `glob` 11.1.0 → 13.0.6 (#867), `commander` 12.1.0 → 14.0.3 (#868), `@huggingface/transformers` (#869), `@modelcontextprotocol/sdk` (#866), `lru-cache` 11.2.7 → 11.3.5 (#870), `mnemonist` 0.39.8 → 0.40.3 (#871), `@ladybugdb/core` (#873)
- ontoindex-web dependency bumps: `mermaid` 11.12.2 → 11.14.0 (#860), `tailwindcss` (#861), `jsdom` 29.0.0 → 29.0.2 (#863), `wait-on` 8.0.5 → 9.0.5 (#859), `@vitest/coverage-v8` (#864)
- GitHub Actions bumps: `actions/checkout` 4.3.1 → 6.0.2 (#842), `actions/upload-artifact` 4.6.2 → 7.0.1 (#838), `actions/setup-node` 4.4.0 → 6.3.0 (#841), `actions/cache` 5.0.4 → 5.0.5 (#840), `actions/github-script` 7.0.1 → 9.0.0 (#850), `dorny/paths-filter` 3.0.2 → 4.0.1 (#839), `amannn/action-semantic-pull-request` 6.1.1 (#853), `release-drafter/release-drafter` 6.0.0 → 7.2.0 (#852), `marocchino/sticky-pull-request-comment` 3.0.4 (#851), `softprops/action-gh-release` 2.5.0 → 3.0.0 (#849)

## [1.6.1] - 2026-04-13

### Added

- **Service group extractor expansion** — manifest extractor and broader extractor coverage (2/4 of #606 split) (#796)
- **Dart call patterns** for `await`, cascade, lambda, and widget-tree contexts (#801)

### Fixed

- **Stack overflow and memory exhaustion** on large repository analysis (#814)
- **`tree-sitter-dart` install crash** — switched from git URL to npm tarball (#811)
- **Generic TypeScript awaited function calls** missing from the call graph (#804)
- **Runtime dependency on `file:../ontoindex-shared`** removed from the published package (#803)
- **Ruby `singleton_class` context** preserved during sequential parsing (#774)

### Changed

- **DAG-based ingestion pipeline architecture** — pipeline phases now declare typed dependencies and run via a topologically sorted DAG; container-node logic extracted to `LanguageProvider`. Includes hardened lifecycle (try/finally cleanup, error wrapping, cycle reporting), tightened `ParseOutput.exportedTypeMap` immutability, and corrected phase dependencies (#809)

## [1.6.0] - 2026-04-12

### Added

- **SemanticModel architecture refactor (SM-8 through SM-19)** — extracted registries into `model/` module with ISP-compliant interfaces: TypeRegistry, MethodRegistry, FieldRegistry, RegistrationTable, ResolutionContext (#786)
  - HeritageMap built from accumulated `ExtractedHeritage[]` for MRO-aware resolution (#739)
  - `lookupMethodByOwnerWithMRO` using HeritageMap for cross-class method dispatch (#740)
  - MRO fast path before D2 fuzzy widening in call resolution (#741)
  - BindingAccumulator for cross-file return type propagation (#743, #763)
  - Restructured `resolveUncached` replacing `lookupFuzzy` data source for all tiers (#764)
  - Deleted `lookupFuzzy`, `lookupFuzzyCallable`, `globalIndex`, `callableIndex` — replaced with structured lookups (#769)
  - Deleted `resolveCallTarget` god-method — replaced with thin dispatcher delegating to `resolveMemberCall` (#744), `resolveStaticCall` (#754), `resolveFreeCall` (#756) (#770)
- **Service group infrastructure** — service boundary detection, contract extractors, sync pipeline, CLI/MCP tools, monorepo fixture; bridge.lbug storage and contract matching expansion (#795)
- **C# interface-to-interface heritage** capture (#789)
- **Vue SFC support** with destructured call result tracking (#604)
- **Java method reference** resolution — `obj::method` as call sites (#622)
- **C/C++ MethodExtractor** config with pure virtual detection (#617)
- **MethodExtractor configs** for Python, PHP, Swift, Dart, Rust, Ruby (#624)
- **METHOD_IMPLEMENTS edges** with overload disambiguation and MethodExtractor unification (#642)
- **Same-arity overload disambiguation** via type-hash suffix (#658)
- **`ONTOINDEX_HOME` env var** to customize global directory (#746)
- **Verbose analyze output** prints skipped large file paths (#745)
- **Class name lookup index** for O(1) qualified lookups (#707, #716)
- **`lookupMethodByOwner` index** for O(1) cross-class chain resolution (#665)
- **Fuzzy lookup counters** for performance visibility (#708)

### Fixed

- **Stack overflow on large PHP files** — iterative AST traversal (#783)
- **Large repository graph loading** failure (#732)
- **Windows multi-repo switching** — false 404 errors and stale repo context (#633)
- **`detect_changes` diff mapping** — map diff hunks to symbol line ranges (#779)
- **HTTP client vs Express route detection** and Spring interface attribution (#780)
- **VECTOR extension** not loaded during DB init for semantic search (#782)
- **tree-sitter-swift** postinstall patch for macOS ARM64 (#788)
- **tree-sitter-c** peer dependency conflict pinned (#723)
- **Constructor indexing** in methodByOwner (#694, #753)
- **Named binding processor** — `lookupExact` replaced with `lookupExactAll` (#755)
- **`.ontoindexignore` negation patterns** now respected (#654)
- **MCP setup** prefers global ontoindex binary over npx (#653)
- **CORS rejection** returns clean error instead of 500 (#646)
- **Array.push stack overflow** — replaced spread with loop (#650)
- **MCP stdout silencing** prevents embedder/pool-adapter conflicts (#645)
- **Web heartbeat** — graceful reconnection replaces aggressive disconnect (#643)
- **Web repo scoping** — backend calls scoped to active repo (#644)
- **OpenCode config path** and FTS extension load order (#781)
- **OnboardingGuide** dev-mode serve command corrected (#725)
- **Security issues** and critical bugs from code review (#709)

### Changed

- Replaced class-type fuzzy lookups with structured indices in type-env (#733, #734, #736)
- Extracted `CLASS_LIKE_TYPES` constant (#693)

## [1.5.3] - 2026-04-01

### Added

- **TypeScript/JavaScript MethodExtractor** config (#588)

### Fixed

- **Wiki Azure OpenAI** compat and HTML viewer script injection (#618)

## [1.5.2] - 2026-04-01

### Fixed

- **`ontoindex-shared` module not found** — `ontoindex-shared` was a `file:` workspace dependency never published to npm, causing `ERR_MODULE_NOT_FOUND` when installing `ontoindex` globally. The build now bundles shared code into `dist/_shared/` and rewrites imports to relative paths (#613)
- **v1.5.1 publish regression** — npm's `prepare` lifecycle ran `tsc` after `prepack`, overwriting the rewritten imports before packing; both scripts now run the full build so the final tarball is always correct

## [1.5.1] - 2026-04-01 [YANKED]

### Fixed

- Incomplete fix for `ontoindex-shared` bundling — `prepare` script overwrote rewritten imports during publish

## [1.5.0] - 2026-04-01

### Added

- **Repo landing screen** — when the backend detects indexed repositories, the web UI now shows a landing page with selectable repo cards (name, stats, indexed date) instead of auto-loading the first repo; users can also analyze new repos directly from the landing screen (#607)
- **Unified web & CLI ingestion pipeline** — complete architectural migration of the web app from a self-contained WASM browser app to a thin client backed by the CLI server; new `ontoindex-shared` package for cross-package type unification (#536)
  - New server endpoints: `/api/heartbeat` (SSE liveness), `/api/info`, `/api/repos`, `/api/file`, `/api/grep`, `/api/analyze` (SSE progress), `/api/embed`, `/api/mcp` (MCP-over-StreamableHTTP)
  - Onboarding flow: auto-detect server → connect → repo landing or analyze
  - Header repo dropdown: switch, re-analyze, or delete repos
- **Azure OpenAI support for wiki command** — fixed broken Azure auth (`api-key` header), `api-version` URL parameter, reasoning model handling (`max_completion_tokens`, no `temperature`), content filter error messages; added interactive setup wizard, `--api-version` and `--reasoning-model` CLI flags (#562)
- **Java method references & interface dispatch** — `obj::method` treated as call sites, overload selection via typed variable args (not just literals), interface dispatch emits additional CALLS edges to implementing classes (#540)
- **MethodExtractor abstraction** — structured method metadata extraction (isAbstract, isFinal, annotations, visibility, parameter types) with config-driven factory pattern (#576)
  - Java and Kotlin configs with overload-safe `methodInfoCache` keyed by `name:line`
  - C# config with `sealed`, `params`/`out`/`ref`/optional parameters, `[Attribute]` syntax, `internal` visibility (#582)
- **`--skip-agents-md` CLI flag** — opt out of overwriting OntoIndex-managed sections in AGENTS.md and CLAUDE.md during `ontoindex analyze` (#517)
- **Prettier** — monorepo-wide code formatter with lint-staged + Husky pre-commit hook, `.prettierrc` config, Tailwind CSS v4 plugin, `endOfLine: "lf"` + `.gitattributes` for Windows consistency (#563)
- **ESLint v9** — flat config with `unused-imports` auto-removal, `@typescript-eslint` rules, React hooks rules, CI `lint` job (#564)

### Fixed

- **OpenCode MCP configuration** — corrected README MCP setup for OpenCode which requires `command` as an array containing both executable and arguments (#363)
- **litellm security** — excluded vulnerable versions 1.82.7 and 1.82.8 in eval harness `pyproject.toml` (#580)

### Changed

- **Reduced explicit `any` types** — 128 `no-explicit-any` warnings eliminated (689 → 561, 19% reduction) across `NodeProperties` index signature, ~80 `SyntaxNode` substitutions, typed worker protocol, and graphology community detection (#566)

### Docs

- Added `ontoindex-shared` build step to web UI quick start instructions (#585)
- Added enterprise offering section to README (#579)

## [1.4.10] - 2026-03-27

### Fixed

- **MCP server install via npx** — resolve tree-sitter peer dependency conflicts that broke `npx -y ontoindex@latest mcp` (#537, #538)
  - Downgrade tree-sitter from ^0.25.0 to ^0.21.1 (only npm version where all 14 parsers agree)
  - Align all parser versions to their highest ^0.21.x-compatible releases
  - Remove tree-sitter override (only applies to root packages, ignored by npx)
  - Pin tree-sitter-dart to correct ABI-14-compatible commit
  - Exact pins for tree-sitter-c (0.23.2), tree-sitter-python (0.23.4), tree-sitter-rust (0.23.1) where next patch requires ^0.22.x

## [1.4.9] - 2026-03-26

### Added

- **COBOL language support** — standalone regex processor for fixed-format and free-format COBOL, JCL, COPY/REPLACING with pseudotext (#498)
  - 95% language feature coverage: CALL USING, EXEC SQL/CICS/DLI, DECLARATIVES, SET, INSPECT, INITIALIZE, STRING/UNSTRING, SORT/MERGE with INPUT/OUTPUT PROCEDURE, GO TO DEPENDING ON, MOVE CORRESPONDING, nested programs with per-program scoping
  - 90+ review findings resolved across 20 review cycles with 241 tests (180 unit + 61 integration)
  - Benchmarked: CardDemo 12,349 nodes / 9,773 edges in 7.4s; ACAS 14,017 nodes / 15,659 edges in 9.3s
- **Dart language support** — tree-sitter grammar, type extractors, import/call resolution, Flutter/Riverpod framework detection (#204)
- **Field type extraction** — Phase 8 & 9: per-language field extractors with generic table-driven factory + TypeScript hand-written extractor, return-type binding in call-processor (#494)
  - 14 language configs (TS/JS, Python, Go, Rust, C/C++, C#, Java, Kotlin, PHP, Ruby, Swift, Dart)
  - `FieldVisibility` union type, `extractNames` hook for Ruby multi-attribute
  - 46 field extraction tests across 5 languages
- **ORM dataflow detection** for Prisma and Supabase (#511)
- **Expo Router** file-based route detection (#503)
- **PHP response shape extraction** for `json_encode` patterns (#502)
- **Next.js middleware.ts** linked to routes at project level (#504)
- **Filter panel** — additional node types (#519)

### Changed

- **BUILT_IN_NAMES** split into per-language provider fields (#523)
- **tree-sitter** upgraded to 0.25.0 with all grammar packages (#516)
- **Impact tool** — batched chunking and entry-point grouping for enrichment (#507)

### Fixed

- **COBOL CRLF** — all `split('\n')` calls use `/\r?\n/` for Windows compatibility
- **COBOL nested programs** — all graph edges (CALL, CANCEL, CICS, ENTRY, SQL, SEARCH) use `owningModuleId()` for correct attribution
- **COBOL callAccum** — multi-line CALL USING with verb boundary detection, Area A paragraph guard, EXEC entry flush, division/END PROGRAM flush
- **Dart language gaps** closed (#524)
- **Shape check false positives** — quoted keys, DOM leaks, errorKeys (#501)
- **Python alias gaps** resolved (#505)
- **Cypher write-detection regex** false positive fixed (#507)
- **CI** — shape-check-regression test moved to lbug-db project (#518)

## [1.4.8] - 2026-03-23

### Added

- **Type resolution Milestone D — Phases 10–13** consolidated into a single milestone with full integration test coverage across 11 languages (#387)
  - Phase A/B/C: overload disambiguation via argument literal types, constructor-visible virtual dispatch via `constructorTypeMap`, `parameterTypes` extraction in `extractMethodSignature`
  - Phase 14 enhancements: single-pass seeding, Tarjan's SCC for cyclic resolution, cross-file return types
  - Optional parameter arity resolution
  - Per-language cross-file binding tests and resolver fixes
  - Store all overloads in `fileIndex` instead of last-write-wins
- **Cross-file binding propagation** for multiple languages
- **HTTP embedding backend** for self-hosted/remote endpoints with dynamic dimensions, batch guards, and dimension mismatch handling (#395)
- **Markdown file indexing** — headings and cross-links as graph nodes (#399)
- **MiniMax provider support** (#224)
- **Codex MCP and skills support** with CLI setup flow and e2e tests
- **HelpPanel UI** — built-in help for the web interface (#465)
- **Section node type** registered in `NODE_TABLES` and `NODE_SCHEMA_QUERIES` (#401)
- **Community and Process node properties** documented in cypher tool description (#411)
- **Server-mode hydration regression tests**
- **Pre-commit hooks** via husky for typecheck + unit tests

### Fixed

- **Python import alias resolution** — `import X as Y` now routes module aliases directly to `moduleAliasMap` in import processor (#417, #461)
- **Python module-qualified calls** resolved via `moduleAliasMap` (#337)
- **Python module-qualified constructor calls** (Issue #337)
- **Heritage/MRO edges** now calculate confidence per resolution tier (#412)
- **LadybugDB lock** — retry on DB lock with session-safe cleanup (#325)
- **CORS** — allow private/LAN network origins (#390)
- **Analyze without git** — allow indexing folders without a `.git` directory (#384)
- **Web: LadybugDB** — `getAllRows`, `loadServerGraph`, BM25, highlight clearing (#474)
- **Server-mode hydration** — await server connect hydration flow (#398, #404)
- **Embedding dimensions** — validate on every vector, not just the first; hard-throw on mismatch
- **Timeout detection** — always-on dim validation, test hardening
- **ONNX CUDA** — prevent uncatchable native crash when CUDA libs present but ORT lacks CUDA provider; clarify linux/x64-only
- **CLI** — run codex mcp add via shell on Windows; write tool output to stdout via fd 1
- **Stale progress, cross-platform prepare, DEV log** fixes
- **Import resolution API** simplified per PR #409 review findings (P0–P3)
- **Auto-labeling** — switched from clustering to z-score method; multi-dim aware Mahalanobis threshold
- **PR/issue filtering** — fixed prop cutoff issue
- **Sequential enrichment queries** + stale data detection
- **package-lock.json** synced with `onnxruntime-node ^1.24.0`

### Changed

- **Unified language dispatch** with compile-time exhaustive tables
- **Prepare script simplified** — removed `scripts/prepare.cjs`
- **Switched from .githooks to husky** for pre-commit hooks
- **`@claude` workflow** restricted to maintainers and above via `author_association` check

### Performance

- **O(1) per-chunk synthesis guard** using `boolean[]` instead of Set
- **`sizeBefore` optimization** in type resolution
- **Token truncation** improvements

### Chore

- Strengthened Python module-import tests, un-skipped match/case, added perf guard
- Added positive and negative tests for all 4 bug fixes
- E2e tests for stale detection, sequential enrichment, stability (#396)
- Integration tests for Milestone D across all 11 languages
- `ontoindex-stable-ops` added to community integrations
- `.env.example` added for embedding backend configuration

## [1.4.7] - 2026-03-19

### Added

- **Phase 8 field/property type resolution** — ACCESSES edges with `declaredType` for field reads/writes (#354)
- **Phase 9 return-type variable binding** — call-result variable binding across 11 languages (#379)
  - `extractPendingAssignment` in per-language type extractors captures `let x = getUser()` patterns
  - Unified fixpoint loop resolves variable types from function return types after initial walk
  - Field access on call-result variables: `user.name` resolves `name` via return type's class definition
  - Method-call-result chaining: `user.getProfile().bio` resolves through intermediate return types
  - 22 new test fixtures covering call-result and method-chain binding across all supported languages
  - Integration tests added for all 10 language resolver suites
- **ACCESSES edge type** with read/write field access tracking (#372)
- **Python `enumerate()` for-loop support** with nested tuple patterns (#356)
- **MCP tool/resource descriptions** updated to reflect Phase 9 ACCESSES edge semantics and `declaredType` property

### Fixed

- **mcp**: server crashes under parallel tool calls (#326, #349)
- **parsing**: undefined error on languages missing from call routers (#364)
- **web**: add missing Kotlin entries to `Record<SupportedLanguages>` maps
- **rust**: `await` expression unwrapping in `extractPendingAssignment` for async call-result binding
- **tests**: update property edge and write access expectations across multiple language tests
- **docs**: corrected stale "single-pass" type-resolution claims to reflect walk+fixpoint architecture

### Changed

- **Upgrade `@ladybugdb/core` to 0.15.2** and remove segfault workarounds (#374)
- **Type-resolution roadmap** overhauled — completed phases condensed to summaries, Phases 10–14 added with full engineering specs

## [1.4.6] - 2026-03-18

### Added

- **Phase 7 type resolution** — return-aware loop inference for call-expression iterables (#341)
  - `ReturnTypeLookup` interface with `lookupReturnType` / `lookupRawReturnType` split
  - `ForLoopExtractorContext` context object replacing positional `(node, env)` signature
  - Call-expression iterable resolution across 8 languages (TS/JS, Java, Kotlin, C#, Go, Rust, Python, PHP)
  - PHP `$this->property` foreach via `@var` class property scan (Strategy C)
  - PHP `function_call_expression` and `member_call_expression` foreach paths
  - `extractElementTypeFromString` as canonical raw-string container unwrapper in `shared.ts`
  - `extractReturnTypeName` deduplicated from `call-processor.ts` into `shared.ts` (137 lines removed)
  - `SKIP_SUBTREE_TYPES` performance optimization with documented `template_string` exclusion
  - `pendingCallResults` infrastructure (dormant — Phase 9 work)

### Fixed

- **impact**: return structured error + partial results instead of crashing (#345)
- **impact**: add `HAS_METHOD` and `OVERRIDES` to `VALID_RELATION_TYPES` (#350)
- **cli**: write tool output to stdout via fd 1 instead of stderr (#346)
- **postinstall**: add permission fix for CLI and hook scripts (#348)
- **workflow**: use prefixed temporary branch name for fork PRs to prevent overwriting real branches
- **test**: add `--repo` to CLI e2e tool tests for multi-repo environment
- **php**: add `declaration_list` type guard on `findClassPropertyElementType` fallback
- **docs**: correct `pendingCallResults` description in roadmap and system docs

### Chore

- Add `.worktrees/` to `.gitignore`

## [1.4.5] - 2026-03-17

### Added

- **Ruby language support** for CLI and web (#111)
- **TypeEnvironment API** with constructor inference, self/this/super resolution (#274)
- **Return type inference** with doc-comment parsing (JSDoc, PHPDoc, YARD) and per-language type extractors (#284)
- **Phase 4 type resolution** — nullable unwrapping, for-loop typing, assignment chain propagation (#310)
- **Phase 5 type resolution** — chained calls, pattern matching, class-as-receiver (#315)
- **Phase 6 type resolution** — for-loop Tier 1c, pattern matching, container descriptors, 10-language coverage (#318)
  - Container descriptor table for generic type argument resolution (Map keys vs values)
  - Method-aware for-loop extractors with integration tests for all languages
  - Recursive pattern binding (C# `is` patterns, Kotlin `when/is` smart casts)
  - Class field declaration unwrapping for C#/Java
  - PHP `$this->property` foreach member access
  - C++ pointer dereference range-for
  - Java `this.data.values()` field access patterns
  - Position-indexed when/is bindings for branch-local narrowing
- **Type resolution system documentation** with architecture guide and roadmap
- `.gitignore` and `.ontoindexignore` support during file discovery (#231)
- Codex MCP configuration documentation in README (#236)
- `skipGraphPhases` pipeline option to skip MRO/community/process phases for faster test runs
- `hookTimeout: 120000` in vitest config for CI beforeAll hooks

### Changed

- **Migrated from KuzuDB to LadybugDB v0.15** (#275)
- Dynamically discover and install agent skills in CLI (#270)

### Performance

- Worker pool threshold — skip worker creation for small repos (<15 files or <512KB total)
- AST walk pruning via `SKIP_SUBTREE_TYPES` for leaf-only nodes (string, comment, number literals)
- Pre-computed `interestingNodeTypes` set — single Set.has() replaces 3 checks per AST node
- `fastStripNullable` — skip full nullable parsing for simple identifiers (90%+ case)
- Replace `.children?.find()` with manual for loops in `extractFunctionName` to eliminate array allocations

### Fixed

- Same-directory Python import resolution (#328)
- Ruby method-level call resolution, HAS_METHOD edges, and dispatch table (#278)
- C++ fixture file casing for case-sensitive CI
- Template string incorrectly included in AST pruning set (contains interpolated expressions)

## [1.4.0] - Previous release
