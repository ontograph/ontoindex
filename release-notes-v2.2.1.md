# OntoIndex 2.2.1

OntoIndex 2.2.1 fixes managed analysis for repositories with uncommitted
changes. A dirty worktree can now be refreshed without falsely identifying its
indexed bytes as a clean commit.

## Highlights

- Dirty-worktree analysis uses `worktree:<source-manifest-digest>` as its source
  identity. The digest represents the exact file contents submitted for
  analysis.
- Clean analysis retains the existing `commit:<HEAD>` identity.
- `gn_ensure_fresh({ autoAnalyze: true })` can submit analysis for a dirty
  worktree instead of blocking it solely because uncommitted changes exist.
- Dirty source is considered refreshable even when the graph already targets
  the current commit.
- The source identity is validated consistently across job submission, runner
  environment, publication receipts, and `gn_analyze_job` recovery.
- Recovery still fails closed when a source identity does not match either the
  target commit or the analyzed source-manifest digest.

## Distribution

This release is distributed as the installable GitHub asset
`ontoindex-2.2.1.tgz` under the GitHub-only tag `github-release/2.2.1`. It is not
published to the public npm registry and does not create new container tags.
