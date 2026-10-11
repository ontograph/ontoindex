# OntoIndex 2.2.2

OntoIndex 2.2.2 improves MCP compatibility, mutation authorization, and repository
path containment.

## Changes

- Rename operations require explicit write authorization and report partial
  failures and the files actually changed.
- Repository file operations resolve symlinks before checking path containment.
- MCP transport, HTTP diagnostics, graph-walk initialization, facade operation
  mapping, and response pagination have additional regression coverage.
- Includes dirty-worktree overlays, source-manifest evidence, and compatible
  dependency security updates from the release preparation branch.

## Distribution

Install the GitHub release asset `ontoindex-2.2.2.tgz` from tag
`github-release/2.2.2` with npm. This release uses the established GitHub package
distribution channel.
