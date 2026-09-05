# OntoIndex 2.2.0 Release Readiness

Status: **READY FOR RELEASE**

Prepared: 2026-08-18
Target package version: `2.2.0`
Distribution tag: `github-release/2.2.0`

## Selected Scope

This minor release combines tamper-evident audit event integrity with the
managed-analysis freshness recovery contract. The release includes exact job
reuse identity, job-bound publication receipts, capability-aware terminal
post-checks, missing-embedding recovery, structured submission and lock
conflicts, and transactional generation publication and rollback.

`STALLED` worker replacement remains deferred. Heartbeats, renewable leases,
attempt epochs, replacement authority, and stale-worker publication fencing
require a separate ADR before they can become a supported lifecycle state.

## Distribution Safety

- Do not create or push a stable `v*` tag. `.github/workflows/publish.yml`
  publishes matching stable tags to npm.
- Do not dispatch the release-candidate workflow; it publishes npm RC packages
  and container images.
- Build and verify `ontoindex-2.2.0.tgz` locally.
- Push the release commit to `feat/audit-event-integrity`.
- Create the GitHub release from `github-release/2.2.0` and attach the verified
  tarball. This tag does not match the npm publish workflow.

## Required Gates

- TypeScript type-check.
- Focused managed-analysis and publication tests.
- Complete unit and integration suites.
- Root Prettier and ESLint.
- `ontoindex-shared` build.
- `ontoindex` production build.
- `npm publish --dry-run` only; never run a real npm publish.
- `npm pack` and tarball structure/version/bin verification.
- Built CLI smoke test.
- `git diff --check`, scope review, and clean release commit.
- Exactly one clean-commit reindex followed by `gn_diagnose`,
  `gn_pre_commit_audit`, and `gn_verify_diff`.

## Validation Results

Completed on 2026-08-18:

- TypeScript type-check passed with `npx tsc --noEmit --pretty false`.
- Focused managed-analysis matrix passed: 8 files, 223 tests.
- Complete unit suite passed: 456 files, 6,983 tests; 64 tests skipped.
- Complete integration suite passed: 83 files, 2,606 tests; 4 files and
  244 tests skipped by their existing environment/fixture conditions.
- Prettier check passed.
- ESLint passed with 0 errors; 4,706 pre-existing warnings remain advisory.
- `ontoindex-shared` and `ontoindex` production builds passed.
- `git diff --check` passed.
- `npm publish --dry-run` passed without publishing: 29.6 MB compressed,
  379.4 MB unpacked, 2,006 files.
- `npm pack --pack-destination ..` produced `ontoindex-2.2.0.tgz` with
  SHA-256
  `4d2cbb3a0a82c2a55da7eb0059ace8bc3e9eada935ea38c98023b47b424192cc`.
- Tarball verification passed for package version `2.2.0`, bin mapping
  `ontoindex -> dist/cli/index.js`, and `package/dist/cli/index.js` presence.
- A normal isolated consumer install of the tarball passed; the packaged CLI
  reported `2.2.0` and completed `ontoindex --help`.

Installing with `--ignore-scripts` is not a supported smoke path because it
prevents `@ladybugdb/core` from installing its native binary. The normal npm
installation path was tested and passed.

The remaining release gates are the clean release commit, exactly one
post-commit reindex, graph-aware post-commit verification, branch/tag push,
GitHub release creation, and public-asset verification.

## Release Sequence

1. Complete all validation and record results in this file.
2. Commit as `release: v2.2.0`.
3. Reindex the clean commit exactly once.
4. Review the post-commit graph gates.
5. Push the feature branch.
6. Create and push annotated tag `github-release/2.2.0`.
7. Create the GitHub release and attach `ontoindex-2.2.0.tgz`.
8. Verify the public asset can be downloaded and reports version `2.2.0`.
