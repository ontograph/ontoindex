# Release readiness audit

Date: 2026-10-11
Candidate: `chore/release-readiness`, reviewed HEAD `3f14dbc` plus overlay corrections.

## Implemented

- Stable and candidate workflows pack once, smoke-test an installed tarball,
  and publish that same tarball.
- Candidate publication reconciliation rejects a mismatched npm SHA512 integrity.
- Cached Ladybug FTS/vector extensions are checked against pinned SHA256 hashes,
  including offline builds.
- CI includes cross-process overlay regression coverage and explicit PR permissions.
- Unreleased changelog records real-time overlay and release-hardening changes.

## Validation evidence

- Focused Vitest run after the implementation commit: 5 files, 45 tests passed
  in 29.27 seconds. Coverage: release workflow, extension fetching, MCP doctor,
  watcher save patterns, and cross-process overlay visibility.
- Earlier full unit log: 472 passing files, 7118 passing tests, one expected
  failure, 65 skipped tests, and one failing workflow assertion. The corrected
  assertion passes in the focused run; the full suite has not been rerun.
- Build, packed CLI startup/help smoke, formatting, typecheck, and lint were
  reported successful by the preceding task segment. Lint reported 4634 warnings;
  these results are inherited evidence, not freshly rerun checks.
- CI run `38114259149` passed for `3f14dbc`, including Linux, macOS, Windows,
  coverage, formatting, lint and typechecks. Browser E2E was skipped.
- Coordinator refreshed OntoIndex to `3f14dbc`; no embeddings are present.
  Context and impact inspection identified the shared overlay read owners.
- Overlay corrections filter symbol rows to snapshot-covered paths and propagate
  unavailable-store errors so callers preserve their base-result fallback.
- After formatting, focused Vitest validation passed: 4 files, 39 tests
  (`overlay-symbol-resolution`, `backend-overlay`, `overlay-query-merge`,
  `overlay-context-impact`). `npx tsc --noEmit` and `git diff --check` passed.
- The preceding segment reported installed-tarball CLI version, fixture analysis
  and MCP discovery of 62 tools passing. This is inherited runtime evidence;
  actual MCP symbol-query behavior remains unverified.

## Review findings

- Four read-only agents on `gpt-6.1-sol` and `gpt-6-luna` reviewed release
  identity, dependency security, overlay resolution and watcher/runtime behavior.
- The two overlay defects above have focused corrections and regression tests.
- `watch.ts` drops a pending refresh when `analyze.lock` is held, with no retry
  after release. Recovery needs regression proof before release acceptance.
- Dependency review reported vulnerable production lockfile versions, including
  `hono`, `ip-address` and `adm-zip`. Its bounded inventory covered 100 open
  alerts; shipped reachability and the remaining inventory need verification.
- Compared distribution options: GitHub-only, unified npm/GitHub, and independent
  channels. Prefer GitHub-only to match the latest release, pending maintainer
  confirmation; do not activate npm/container publication implicitly.

## Remaining release gates

- Review the entire integration branch, which includes the real-time overlay
  implementation stack in addition to release hardening.
- Obtain passing CI on the final corrected candidate; existing green CI does
  not cover the uncommitted overlay corrections.
- Reconcile package version `2.1.5` with latest GitHub release tag
  `github-release/2.2.1` and registry state before selecting a release version.
- Resolve watcher lock recovery and production dependency-security findings.
- Confirm GitHub-only versus npm/container distribution before version changes.
- Validate the final versioned artifact, including actual MCP symbol queries.
- Obtain explicit merge/publication approval. No release was published by this task.

Authenticated real-time task statuses remain unchanged.
