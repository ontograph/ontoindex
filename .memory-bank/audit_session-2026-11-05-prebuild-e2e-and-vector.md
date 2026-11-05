# Prebuild end-to-end proof, VECTOR download fix (no build)

Date: 2026-11-05

## Prebuild end to end

The installed 2.5.1 build was tested in an isolated `HOME` and
`ONTOINDEX_HOME`, on a 10-file repository with `ONTOINDEX_WORKSPACE_MAX_FILES=3`
and one tracked and one untracked edit:

- The first MCP `inspect context` call answered from the committed index and
  started a background workspace-graph build.
- The background build logged `Workspace graph prepared; coverage: complete.`
  after about 6 s.
- A later call answered from `source: "workspace-graph"` and listed the
  uncommitted function as a caller.
- HEAD and the committed generation were unchanged.

Running the CLI from TypeScript sources cannot prepare a workspace graph,
because `workspace-build-child.js` exists only after a build. That is
expected; sources are not a shipped configuration.

## VECTOR extension download (fixed)

A committed read took 10.8 s with an empty `~/.lbdb` cache. CPU profiling
showed 0.5 s of work, and strace showed two HTTP GETs to the LadybugDB
extension server. The cause is that `loadExtensionsSilenced`
(`core/lbug/pool-adapter.ts`) always ran `INSTALL VECTOR`. It now follows the
policy of `loadVectorExtension`: load the bundled or cached file, then a bare
`LOAD`, and run `INSTALL` only when `ONTOINDEX_ALLOW_EXTENSION_INSTALL=1` is
set. With a warm cache, reads on this repository already took about 0.6 s.

## Also

- `isNameShadowed` treats `class_static_block` as a scope and a var-hoisting
  root. An adversarial review of the earlier scope fix found no P1 or P2
  issues; this static-block case was its only P3 finding.
- Correction: only a few tests load `dist/` code: `worker-pool` (skipped
  when there is no dist), `mcp-super-dispatch-packaging`, `skip-git-cli` and
  the benchmarks. My earlier "23 files" count included matches in fixture
  strings and in the tsx loader path.
