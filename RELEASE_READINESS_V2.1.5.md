# OntoIndex 2.1.5 Release Readiness

Status: **READY FOR LOCAL RELEASE COMMIT; TAG PENDING CLEAN-COMMIT REINDEX**

Prepared: 2026-08-06
Target: `v2.1.5`
Current package version: `2.1.5`

## Selected Release Scope

The prepared candidate is the full `2.1.5` release described by the changelog
and release notes. The earlier focused patch set was rejected because
`gn_analyze_job`, response pagination, graph-authority behavior, and release
workflow coverage depend on broader registry, dispatch, evaluation, and test
changes.

The full candidate is staged as a bounded 129-path release diff. There are no
unstaged or untracked paths. The staged paths were classified as implementation,
tests, evaluation assets, architecture docs, release notes, or release/Ontocode
handoff reports. The generated `.post-authority.json` test-result dump is
explicitly ignored.

## Completed

- `ontoindex` build completed successfully after the analysis-job changes.
- Focused analysis coordinator, `gn_ensure_fresh`, and response pagination tests
  passed: 3 files, 39 tests.
- The graph-linked `LocalBackend` gate passed: 6 files, 136 tests.
- Manual review of the HIGH-impact `LocalBackend` change is complete. An added
  regression proves repository initialization opens the active immutable
  generation path; the focused post-review gate passed: 3 files, 56 tests.
- The full unit suite passed: 454 files, 6,876 tests passed and 64 skipped.
- The full integration suite passed: 83 files passed, 4 skipped; 2,598 tests
  passed and 244 skipped.
- `npx tsc --noEmit`, `ontoindex-shared` build, and the `ontoindex` package build
  passed.
- Root ESLint completed with zero errors. Existing warnings remain advisory.
- `npm publish --dry-run` completed for the bumped `2.1.5` package, producing a
  29.5 MB tarball with 2,004 files.
- Root Prettier checking passes.
- Focused MCP response pagination coverage is present in
  `ontoindex/test/unit/response-pages.test.ts`, including UTF-8 reconstruction,
  serialized byte limits, request binding, and cursor integrity.
- An end-to-end built-artifact probe submitted an analysis job successfully in
  a repository containing an untracked embedded repository and dangling
  symlink.
- Current source confirms `submitAnalysisJob` no longer computes a synchronous
  dirty-source snapshot. Coordinator regression tests cover an embedded
  repository, a directory symlink, and a dangling symlink.
- Current source also confirms response pagination is wired through
  `createMCPServer`, with request-bound integrity cursors and UTF-8 byte-bounded
  pages implemented in `response-pages.ts`.
- Draft changelog and release notes are present.
- Root and package changelogs contain dated `2.1.5` sections. The package
  changelog used by the stable publish workflow also restores the missing
  `2.1.4` history.
- `ontoindex/package.json` and `ontoindex/package-lock.json` are both `2.1.5`.
- The release-candidate workflow already owns RC version calculation, package
  versioning, npm publication, GitHub prerelease creation, and public release
  verification.

## Blocking Gates

- Source review and the graph-linked `LocalBackend` tests found no blocking
  defect: telemetry is isolated in `finally`, enrichment remains opt-in, and
  initialization retains repository locking.
- The staged OntoIndex pre-commit audit reports `DO-NOT-COMMIT` only for the
  HIGH-impact `LocalBackend` change. Manual source review is complete, the added
  active-generation regression covers the risky branch, and the focused
  `LocalBackend` gate passed. This is an acknowledged owner gate rather than an
  unresolved product defect.
- The full 129-path release candidate is staged, with no unstaged or untracked
  paths. Graph authority remains in `review` state because the staged source
  manifest differs from the index at the current `v2.1.4` commit.
- Authoritative graph-linked coverage claims remain pending until the release
  commit is created and reindexed exactly once.
- The Markdown docs sidecar is missing, so docs readiness is unavailable.
- Direct current-source and diff reads remain authoritative for untracked and
  modified files until the selected clean release commit is reindexed.

## Required Commands

The listed commands passed against the staged `2.1.5` candidate:

```bash
npx vitest run \
  test/unit/analysis-coordinator.test.ts \
  test/unit/super/ensure-fresh.test.ts \
  test/unit/response-pages.test.ts
npx tsc --noEmit
npx vitest run \
  test/integration/local-backend-calltool.test.ts \
  test/integration/mcp-security.test.ts \
  test/integration/mcp-tools-pilot.test.ts \
  test/unit/calltool-dispatch.test.ts \
  test/unit/mcp/local-backend-global-tools.test.ts \
  test/unit/sidecar-local-backend-enrichment.test.ts

cd ..
npm install
npm run format:check
npm run lint

cd ontoindex-shared
npm install
npm run build

cd ../ontoindex
npm ci
npm run build
npm run test:unit
npm run test:integration
npm publish --dry-run
```

Then run:

```bash
node dist/cli/index.js analyze
```

After committing, reindex exactly once and rerun `gn_diagnose`,
`gn_pre_commit_audit`, and `gn_verify_diff` against the clean release commit.
Do not create the tag until those post-commit gates are reviewed.

## Release Owner Sequence

1. Create the local `release: v2.1.5` commit from the staged candidate.
2. Reindex that clean commit exactly once.
3. Rerun `gn_diagnose`, `gn_pre_commit_audit`, and `gn_verify_diff` against the
   clean commit and review any remaining policy warnings.
4. Refresh the Markdown docs sidecar only if docs readiness is a release
   requirement.
5. Create the local annotated `v2.1.5` tag only after the post-commit gates are
   accepted.

## Stable Release Commit

Once the post-commit graph gates are cleared:

1. The changelog entries and package versions are prepared in the worktree.
2. The accepted release scope is staged and its build, tests, formatting, lint,
   and `npm publish --dry-run` gates have passed.
3. Create the local release commit, reindex it, and review the final graph gates.
4. Create an annotated `v2.1.5` tag only from that verified commit.
