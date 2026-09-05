# Changelog

All notable changes to OntoIndex will be documented in this file.

## [Unreleased]

### Added

- `ontoindex setup` now installs skills into `~/.ontocode/skills/` for Ontocode, which previously
  received MCP configuration, agent guidance, and hooks but never had its skill copies refreshed.
- The Linux/macOS and Windows installers now run `ontoindex setup` after a validated install, so
  skills and MCP client configuration are in place without a second manual command. Setup failures
  are reported as warnings and do not fail the install. Set `ONTOINDEX_SKIP_SETUP=1` to opt out.

### Fixed

- Corrected the OntoIndex skills to use callable tool names. They documented `ontoindex_query`,
  `ontoindex_context`, `ontoindex_impact`, `ontoindex_rename`, and `ontoindex_detect_changes`,
  none of which exist in the 2.x MCP surface. They now use the `search`, `inspect`, `impact`, and
  `refactor` facades and the `gn_*` tools, verified against `gn_tool_contract`.
- Replaced the "WILL BREAK" label on direct dependents in impact and PR-review guidance. Dependency
  distance is review priority, not proof of breakage, and the previous wording caused agents to
  report unverified regressions.
- Added explicit missing-tool handling to the skills so an agent reports an unavailable OntoIndex
  tool instead of presenting grep results as graph-backed evidence.
- Documented that the `ontoindex` facade dispatcher is advertised but not callable in the default
  `public-full` startup profile.

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

- Added a deterministic Kimi K3 MCP smoke harness for validating repository-scoped tool use and grounded responses.

### Changed

- Hardened MCP repository selection, duplicate-label handling, canonical repository paths, and hook augmentation framing.

### Fixed

- Loaded cached LadybugDB FTS extensions before the bare extension fallback in pooled database startup.

## [2.0.8] - 2026-07-07

### Fixed
- Repaired `ontoindex setup` TOML MCP upserts so rerunning setup replaces the full
  `[mcp_servers.ontoindex]` block instead of leaving duplicate `args` keys behind in
  Codex-compatible `config.toml` files.

### Changed
- Updated public install examples and release metadata for the `2.0.8` release.

## [2.0.7] - 2026-07-07

### Added
- Added MCP client call-shape troubleshooting so Ontocode-style users can distinguish client-router `unsupported call: mcp__ontoindex__...` failures from OntoIndex server or index issues.

### Changed
- Generated MCP function ADR pages now include the canonical Ontocode-style `namespace="mcp__ontoindex", name="<tool>"` call identity and flattened-name troubleshooting guidance.

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

- Added tracker-state Markdown sidecar facts so docs readiness/context surfaces can expose open
  tasks, block reasons, no-dispatch gates, reopen criteria, and next actions through the existing
  `gn_docs` contract.
- Added repository-relative path scoping to diff review surfaces so dirty worktrees can be audited
  or reviewed without introducing a separate workflow.

### Changed

- Unified diagnostic freshness, embedding, audit, resource-bridge, and Ladybug support reporting
  across `status`, `mcp-doctor`, and audit failure paths.
- Clarified CLI and MCP discovery text so `list_repos` points users to the existing `ontoindex list`
  CLI equivalent instead of implying a missing command.

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

## [1.9.24] - 2026-06-20

### Fixed

- Loaded cached LadybugDB `vector` extensions from the installer-populated GitHub release cache
  before falling back to LadybugDB network installation.
- Skipped Linux extension-cache downloads when both cached extension binaries already exist.

## [1.9.23] - 2026-06-20

### Fixed

- Loaded cached LadybugDB `fts` extensions from the installer-populated GitHub release cache before
  falling back to LadybugDB network installation.
- Added a runtime hint for `libfts.lbug_extension` cache paths when FTS extension loading fails.

### Changed

- Added timestamped progress logs to the Linux installer so release lookup, extension prefetch,
  npm install, and validation no longer appear to hang silently.

## [1.9.22] - 2026-06-20

### Changed

- Clarified installer behavior for third-party runtime packages: default installers keep npm-based
  dependency resolution instead of shipping a large offline dependency bundle.
- Added installer guidance for non-fatal transitive npm deprecation warnings and air-gapped
  installs.

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

## [1.9.15] - 2026-06-17

### Added

- Added display-only graph-fact provenance classification and surfaced optional provenance on impact kernel nodes.
- Added deterministic wiki navigation markdown helpers for community overview pages.

### Changed

- Graph HTML export payloads now preserve allowlisted metadata fields for provenance, truncation, omitted counts, and community labels.
- `ontoindex status` now reports an existing passive `.ontoindex/needs_update` marker with repair guidance.

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

- MCP startup now supports `ontoindex mcp --project <path>` so clients can target a repo directly without env-only harness wiring.
- MCP misconfiguration hardening docs: `ontoindex mcp-doctor` now documents repo-label/path resolution, `READY` / `DEGRADED` / `MISCONFIGURED` verdicts, and the restart hint for project-target mismatches.

### Changed

- MCP repo resolution now prefers explicit startup args and cwd-derived project scope before env fallback, reducing cross-repo miswiring in multi-repo workspaces.
- `ontoindex setup`, repo-resolution errors, `mcp-doctor`, and `gn_diagnose` now emit arg-first repair commands based on `ontoindex mcp --project ...`.
- MCP reference and setup docs now describe repo identity on scoped responses, the `gn_diagnose` misconfiguration branch, and the `ONTOINDEX_MCP_ALLOW_REPO_MISMATCH=1` override.
- Bridge DB overwrite now waits until the promoted `bridge.lbug` is queryable before returning and preserves `.wal` / `.lock` sidecars during atomic swaps, removing intermittent `Table Contract does not exist` failures in native child-process coverage.

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

- **Audit lifecycle workflow** — expanded OntoIndex with audit ingest, verify, lint, and bundle flows, plus the corresponding audit/systems-audit MCP surfaces for turning findings into verified implementation bundles.
- **Typed structured retrieval and recommendations** — semantic search now supports typed-query documents end-to-end, structured retrieval output, replay-backed regression gates, and additive organic recommendations in diff/pre-commit review flows.
- **Advisory memory and diagnostics workflow** — added local advisory memory skeleton authoring, advisory memory context/readiness support, an authenticated MCP diagnostics API, and a web settings diagnostics panel.
- **MCP runtime hardening** — setup now records the intended project path for external tool checkouts, startup reports executable cwd/project/repo scope, and tool-contract output distinguishes internal callable tools from host-visible wrappers.
- **Release documentation refresh** — rebuilt the public README, added full MCP tool documentation, and aligned package metadata with the `ontograph/ontoindex` repository.

### Fixed

- **Memory trust-boundary hardening** — advisory memory parsing now rejects unsafe names, path traversal, malformed freshness/source metadata, oversized files, and non-advisory shapes.
- **Cross-repo MCP safeguards** — `gn_taint_trace` resolves repo-relative paths against the selected repo and rejects paths outside the repo; MCP startup can warn or fail on explicit repo/project mismatches before returning misleading results.
- **MCP packaging guard** — build and smoke tests now verify advertised super-functions resolve to emitted `dist/mcp/super/*.js` modules, preventing missing-module failures such as `gn_pre_commit_audit`.
- **Package release artifacts** — npm dry-run packaging now includes package-local AGPL license and attribution notice files.

### Changed

- Migrated from KuzuDB to LadybugDB v0.15 (`@ladybugdb/core`, `@ladybugdb/wasm-core`)
- Renamed all internal paths from `kuzu` to `lbug` (storage: `.ontoindex/kuzu` → `.ontoindex/lbug`)
- Added automatic cleanup of stale KuzuDB index files
- LadybugDB v0.15 requires explicit VECTOR extension loading for semantic search
- Expanded ADR coverage for the audit lifecycle, trust-contract, structured-retrieval, and memory/diagnostics follow-up tracks.
- Relicensed the project as `AGPL-3.0-or-later`; prior GitNexus attribution remains in `NOTICE`.

## [1.5.3] - 2026-04-01

### Added

- **TypeScript/JavaScript MethodExtractor config** — shared extraction config covering abstract methods, visibility modifiers, async/override keywords, decorators, rest/optional/destructured parameters, and return types (#588) — @compound-ai

### Fixed

- **Azure OpenAI compatibility** — use `max_completion_tokens` instead of deprecated `max_tokens` (newer models reject `max_tokens`); skip `temperature` for Azure provider (some models reject non-default values) (#618)
- **Simplified Azure interactive setup** — 3 prompts (endpoint, deployment, key) instead of 7 (#618)
- **Wiki HTML viewer script injection** — escape `</script>` in embedded JSON so LLM-generated markdown no longer breaks the viewer (#618)
- Ensure import rewrites survive npm publish lifecycle

## [1.4.0] - 2026-03-13

### Added

- **Language-aware symbol resolution engine** with 3-tier resolver: exact FQN → scope-walk → guarded fuzzy fallback that refuses ambiguous matches (#238) — @magyargergo
- **Method Resolution Order (MRO)** with 5 language-specific strategies: C++ leftmost-base, C#/Java class-over-interface, Python C3 linearization, Rust qualified syntax, default BFS (#238) — @magyargergo
- **Constructor & struct literal resolution** across all languages — `new Foo()`, `User{...}`, C# primary constructors, target-typed new (#238) — @magyargergo
- **Receiver-constrained resolution** using per-file TypeEnv — disambiguates `user.save()` vs `repo.save()` via `ownerId` matching (#238) — @magyargergo
- **Heritage & ownership edges** — HAS_METHOD, OVERRIDES, Go struct embedding, Swift extension heritage, method signatures (`parameterCount`, `returnType`) (#238) — @magyargergo
- **Language-specific resolver directory** (`resolvers/`) — extracted JVM, Go, C#, PHP, Rust resolvers from monolithic import-processor (#238) — @magyargergo
- **Type extractor directory** (`type-extractors/`) — per-language type binding extraction with `Record<SupportedLanguages, Handler>` + `satisfies` dispatch (#238) — @magyargergo
- **Export detection dispatch table** — compile-time exhaustive `Record` + `satisfies` pattern replacing switch/if chains (#238) — @magyargergo
- **Language config module** (`language-config.ts`) — centralized tsconfig, go.mod, composer.json, .csproj, Swift package config loaders (#238) — @magyargergo
- **Optional skill generation** via `npx ontoindex analyze --skills` — generates AI agent skills from KuzuDB knowledge graph (#171) — @zander-raycraft
- **First-class C# support** — sibling-based modifier scanning, record/delegate/property/field/event declaration types (#163, #170, #178 via #237) — @Alice523, @benny-yamagata, @jnMetaCode
- **C/C++ support fixes** — `.h` → C++ mapping, static-linkage export detection, qualified/parenthesized declarators, 48 entry point patterns (#163, #227 via #237) — @Alice523, @bitgineer
- **Rust support fixes** — sibling-based `visibility_modifier` scanning for `pub` detection (#227 via #237) — @bitgineer
- **Adaptive tree-sitter buffer sizing** — `Math.min(Math.max(contentLength * 2, 512KB), 32MB)` (#216 via #237) — @JasonOA888
- **Call expression matching** in tree-sitter queries (#234 via #237) — @ex-nihilo-jg
- **DeepSeek model configurations** (#217) — @JasonOA888
- 282+ new unit tests, 178 integration resolver tests across 9 languages, 53 test files, 1146 total tests passing

### Fixed

- Skip unavailable native Swift parsers in sequential ingestion (#188) — @Gujiassh
- Heritage heuristic language-gated — no longer applies class/interface rules to wrong languages (#238) — @magyargergo
- C# `base_list` distinguishes EXTENDS vs IMPLEMENTS via symbol table + `I[A-Z]` heuristic (#238) — @magyargergo
- Go `qualified_type` (`models.User`) correctly unwrapped in TypeEnv (#238) — @magyargergo
- Global tier no longer blocks resolution when kind/arity filtering can narrow to 1 candidate (#238) — @magyargergo

### Changed

- `import-processor.ts` reduced from 1412 → 711 lines (50% reduction) via resolver and config extraction (#238) — @magyargergo
- `type-env.ts` reduced from 635 → ~125 lines via type-extractor extraction (#238) — @magyargergo
- CI/CD workflows hardened with security fixes and fork PR support (#222, #225) — @magyargergo

## [1.3.11] - 2026-03-08

### Security

- Fix FTS Cypher injection by escaping backslashes in search queries (#209) — @magyargergo

### Added

- Auto-reindex hook that runs `ontoindex analyze` after commits and merges, with automatic embeddings preservation (#205) — @L1nusB
- 968 integration tests (up from ~840) covering unhappy paths across search, enrichment, CLI, pipeline, worker pool, and KuzuDB (#209) — @magyargergo
- Coverage auto-ratcheting so thresholds bump automatically on CI (#209) — @magyargergo
- Rich CI PR report with coverage bars, test counts, and threshold tracking (#209) — @magyargergo
- Modular CI workflow architecture with separate unit-test, integration-test, and orchestrator jobs (#209) — @magyargergo

### Fixed

- KuzuDB native addon crashes on Linux/macOS by running integration tests in isolated vitest processes with `--pool=forks` (#209) — @magyargergo
- Worker pool `MODULE_NOT_FOUND` crash when script path is invalid (#209) — @magyargergo

### Changed

- Added macOS to the cross-platform CI test matrix (#208) — @magyargergo

## [1.3.10] - 2026-03-07

### Security

- **MCP transport buffer cap**: Added 10 MB `MAX_BUFFER_SIZE` limit to prevent out-of-memory attacks via oversized `Content-Length` headers or unbounded newline-delimited input
- **Content-Length validation**: Reject `Content-Length` values exceeding the buffer cap before allocating memory
- **Stack overflow prevention**: Replaced recursive `readNewlineMessage` with iterative loop to prevent stack overflow from consecutive empty lines
- **Ambiguous prefix hardening**: Tightened `looksLikeContentLength` to require 14+ bytes before matching, preventing false framing detection on short input
- **Closed transport guard**: `send()` now rejects with a clear error when called after `close()`, with proper write-error propagation

### Added

- **Dual-framing MCP transport** (`CompatibleStdioServerTransport`): Auto-detects Content-Length (Codex/OpenCode) and newline-delimited JSON (Cursor/Claude Code) framing on the first message, responds in the same format (#207)
- **Lazy CLI module loading**: All CLI subcommands now use `createLazyAction()` to defer heavy imports (tree-sitter, ONNX, KuzuDB) until invocation, significantly improving `ontoindex mcp` startup time (#207)
- **Type-safe lazy actions**: `createLazyAction` uses constrained generics to validate export names against module types at compile time
- **Regression test suite**: 13 unit tests covering transport framing, security hardening, buffer limits, and lazy action loading

### Fixed

- **CALLS edge sourceId alignment**: `findEnclosingFunctionId` now generates IDs with `:startLine` suffix matching node creation format, fixing process detector finding 0 entry points (#194)
- **LRU cache zero maxSize crash**: Guard `createASTCache` against `maxSize=0` when repos have no parseable files (#144)

### Changed

- Transport constructor accepts `NodeJS.ReadableStream` / `NodeJS.WritableStream` (widened from concrete `ReadStream`/`WriteStream`)
- `processReadBuffer` simplified to break on first error instead of stale-buffer retry loop

## [1.3.9] - 2026-03-06

### Fixed

- Aligned CALLS edge sourceId with node ID format in parse worker (#194)

## [1.3.8] - 2026-03-05

### Fixed

- Force-exit after analyze to prevent KuzuDB native cleanup hang (#192)
