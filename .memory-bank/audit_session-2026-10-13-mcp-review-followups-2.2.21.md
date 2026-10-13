# MCP review follow-ups (2.2.21)

Date: 2026-10-13. Findings came from a read-only review of 2.2.20. No separate ADR; the decisions are recorded here.

## Changes
- Extension classifier (regression from 2.2.19): `isUnavailableExtension` now recognises LadybugDB 0.17 "has not been installed" and "neither an official extension, nor does the extension path ... exists". Without a local extension cache, 2.2.19 and 2.2.20 failed pool startup; 2.2.18 and 2.2.21 start. Other extension errors stay fatal. Verified against the real installed pool with a fresh HOME, with and without the bundled extensions.
- Packaging: `lbug-extension-cache.test.ts` deleted `dist/ladybugdb-extensions` after every run, so running tests before `npm pack` shipped a tarball without the bundled extensions (2.2.20 had none; 2.2.19 and 2.2.21 have both files). The test now seeds only missing files and removes only what it created.
- Clone: an existing checkout is no longer pulled and its git config is never read. Each request clones fresh into a staging directory with the caller's URL (validated, DNS-pinned, `--no-recurse-submodules`, `--template=`), then swaps it in; a failed clone leaves the old checkout intact. Clone directories are keyed `<name>-<12 hex of sha256(scheme+host+path)>`, so repos with the same basename no longer share a directory. Clones for one directory run one at a time. Deleting a repo removes the registered directory when it sits directly under the clone root, so hashed and legacy directories are both covered.
- Jobs: at most `ONTOINDEX_MAX_ACTIVE_ANALYZE_JOBS` (default 2, range 1..8) analyze jobs run at once; more distinct starts get HTTP 429 with `Retry-After: 30`. Same-input dedup is unchanged.
- Repository ids: when names collide, every colliding entry gets a path-hash suffix (assigned in sorted path order), so reordering the registry cannot change what an id means. A legacy bare id for a colliding name is reported as ambiguous.
- Backend state: removed-repo state (`initializedRepos`, `lastStalenessCheck`, overlay caches) is pruned after refresh and whenever the last operation settles; retired repos' pools are closed. Overlay snapshot cache is bounded (64) and evicted per repo. The audit-report timeout timer is cleared. `dispose` rejects new operations.
- Diagnose: `auth.enforcement` is `api-bearer-enforced` (was `metadata-only`); it describes the HTTP API, which does enforce the bearer token.
- HTTP: heartbeat clients capped (`ONTOINDEX_MAX_HEARTBEAT_CLIENTS`, default 64, 1..1024; 503 with `Retry-After: 5`).
- `pretest` runs `node scripts/build.js`; CHANGELOG now has 2.2.19 to 2.2.21 entries.

## Client-visible changes
- `gn_diagnose` / `mcp-doctor` `auth.enforcement` value; HTTP 429 and 503 responses; clone directory names; duplicate-name repo ids and ambiguity messages.

## Not done
- Argument validator `minimum`/`maximum` enforcement (see the 2.2.20 ADR).
- The 15-hour process at ~604 MB RSS is not explained: no confirmed growth source in a fixed registry. A heap snapshot of the live process is needed.
- Clone-directory disk quota.
- Native postinstall on an offline host without a toolchain is untested.
- Unmarked error returns in handlers beyond the reviewed list.

## Validation
- `tsc --noEmit` exit 0; `git diff --check` exit 0.
- 119 test files, 1,694 tests, all pass (`full2.log`), including the new extension-classifier, clone, id-order and state-retention tests.
- Installed smoke (`installed-smoke.log`) passed; fresh-HOME pool startup passed with and without bundled extensions.
- Artifacts: `/opt/d1/tmp/ontoindex-2.2.21-artifacts/`. Rollback: `rollback-installed-2.2.20.tar.gz`.
