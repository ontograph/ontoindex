# OntoIndex 2.1.5

OntoIndex 2.1.5 focuses on evidence integrity, non-blocking analysis recovery,
and release reliability.

## Highlights

- Graph-backed review and evaluation surfaces now carry source-manifest and
  immutable-generation authority, and degrade instead of claiming a clean
  result when the active graph cannot be proven to represent the current
  source scope.
- `gn_ensure_fresh` submits durable asynchronous analysis jobs rather than
  blocking the MCP request lifecycle. Jobs can be observed with
  `gn_analyze_job`.
- Large MCP results use bounded response pages and continuation cursors so
  callers receive valid structured JSON across transport-size boundaries.
- Structural conformance evaluation can check frozen paths and dependency
  boundaries while preserving explicit degraded outcomes when evidence is not
  available.
- PHP import resolution, Rust associated-call extraction, and dirty-worktree
  source-only impact handling have broader coverage.
- Release-candidate publication is resumable and verifies npm metadata, dist
  tags, GitHub prereleases, and packaged release assets before marking an RC
  complete.

## Fixed

- Analysis-job submission no longer synchronously scans dirty worktree paths,
  preventing `EISDIR` failures when Git reports an untracked embedded
  repository.
- Oversized MCP responses no longer rely on truncated output that can corrupt
  structured results.
- Graph-backed pre-commit and diff review surfaces no longer present stale or
  mismatched evidence as authoritative.

## Release Gate

This file is a release draft. Do not create the stable `v2.1.5` tag until all
of the following are true:

- the full CI workflow passes from a clean checkout;
- the high-impact `LocalBackend` changes receive manual review;
- unit and integration tests covering MCP response pagination, local backend
  dispatch, analysis jobs, source-manifest authority, and release verification
  pass;
- `npm run build` and `npm publish --dry-run` pass in `ontoindex/`;
- the worktree contains no untracked source files or unrelated changes;
- `package.json` and `package-lock.json` are bumped together to `2.1.5` in the
  stable release commit;
- the `[Unreleased]` changelog contents are moved to a dated `[2.1.5]` section
  before tagging.
