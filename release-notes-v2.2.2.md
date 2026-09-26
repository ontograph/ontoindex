# OntoIndex 2.2.2

OntoIndex 2.2.2 keeps the graph usable while it is being refreshed. Reads keep
serving the last published index during analysis, parallel refresh requests wait
on one running job, and edits made before or during analysis no longer fail it.

## Highlights

- MCP reads use the last published generation while `analyze` runs. Queued
  queries move to a newly published generation; queries already running finish
  on the previous one, whose database closes only after they return.
- `gn_ensure_fresh` accepts `waitForFreshMs` to wait, within a bounded budget
  (`ONTOINDEX_FRESH_WAIT_MAX_MS`, default 55000), for the single running refresh.
  Parallel callers join that job instead of starting another.
- Managed analysis runs on a frozen source snapshot. Edits during analysis no
  longer fail publication, and a working-tree job whose files changed before it
  started analyzes the new files under their own digest.
- A dirty tree whose exact bytes are already published reports
  `dirtyWorktreeIndexed: true` and does not submit another analysis. Background
  jobs no longer rewrite `AGENTS.md`, `CLAUDE.md`, or skill files, which caused
  endless resubmission.
- `gn_analyze_job` reports `REFRESHED` for working-tree jobs when the current
  files match the published digest. Deterministically skipped inputs are reported
  as `coverage: "degraded"` with reason `PUBLICATION_VERIFIED_DEGRADED_COVERAGE`.
- FTS and VECTOR extensions download over the network only with
  `ONTOINDEX_ALLOW_EXTENSION_INSTALL=1`. Without FTS, analysis publishes without
  full-text indexes and logs a warning instead of failing.
- Old generations are deleted after each publish, keeping two previous ones
  (`ONTOINDEX_KEEP_GENERATIONS`) for at least ten minutes after replacement
  (`ONTOINDEX_GENERATION_GRACE_MS`). Staging copies left by crashed analyzers are
  reclaimed.
- Audit events omit `undefined` fields, and audit ingest resolves repository
  aliases strictly.

## Upgrade notes

- Restart running `ontoindex mcp` servers after upgrading; they keep the previous
  code in memory.
- Hosts without network access should prefetch `libfts` and `libvector` with the
  installer. Missing FTS now degrades keyword search instead of failing analysis.

## Distribution

This release is distributed as the installable GitHub asset
`ontoindex-2.2.2.tgz` under the GitHub-only tag `github-release/2.2.2`. It is not
published to the public npm registry and does not create new container tags.
