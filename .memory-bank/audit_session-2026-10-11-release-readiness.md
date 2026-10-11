# Release readiness audit

Date: 2026-10-11
Candidate: `chore/release-readiness`, implementation commit `edc472d`.

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
- OntoIndex status confirmed indexed/current commit `edc472d`, clean graph,
  and no embeddings. Detect-changes reported no changes before this audit.

## Remaining release gates

- Review the entire integration branch, which includes the real-time overlay
  implementation stack in addition to release hardening.
- Obtain passing CI, including supported-platform runtime checks and full tests.
- Reconcile package version `2.1.5` with latest GitHub release tag
  `github-release/2.2.1` and registry state before selecting a release version.
- Validate the final versioned artifact; installed CLI help does not prove
  installed analyze/MCP behavior.
- Obtain explicit merge/publication approval. No release was published by this task.

Authenticated real-time task statuses remain unchanged.
