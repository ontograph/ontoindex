# OntoIndex 2.2.17 local installation

Date: 2026-10-12
Outcome: Built, packaged, validated, and installed locally from the isolated shipping branch.

- Base: `f6fcd2f7a682011b4bac04c8e9aa2715597c6b57`, version 2.2.16.
- Branch: `chore/mcp-fixes-2.2.17`; commit includes `[skip ci]`.
- Scope: approved boundary, selected audit root, and bounded memory repairs,
  regression tests, stable contract snapshot, ADR, two version manifests, and
  evidence records. Shared checkout remains unchanged.
- Build: `ONTOINDEX_SKIP_EXT_FETCH=1 npm_config_offline=true JOBS=4 npm run build`,
  exit 0, in `/opt/d1/tmp/ontoindex-build-2.2.17/ontoindex`.
- Native check: `npm_config_offline=true JOBS=4 node scripts/build-vendored-natives.cjs`, exit 0.
- Validation: 106 suites and 1485 tests passed; one suite initially failed to
  load while native compilation was unfinished. After native completion that
  suite passed all 28 tests, exit 0. Total: 107 suites and 1513 tests. All 2845
  consumed source, test, and fixture hashes remained unchanged.
- Packaging: offline `npm pack --ignore-scripts`, exit 0. Tarball SHA-256:
  `8f493ae05546f913c754d99d1392f3de4861398dc58946079f8f043d61e38528`.
- Installation: offline global install with scripts disabled, followed by the
  existing LadybugDB installer and vendored native repair; all exit 0.
- CLI: `/home/er77/.local/bin/ontoindex --version` returns `2.2.17`.
- Installed smoke: native parser, bundled extensions, database query and reader
  pin release, SDK MCP startup, 62 public tools, tool contract, boundary aliases
  and caller facts, bounded memory metadata, preferred onboarding, partial docs
  summaries, selected audit root and containment, prior C/C++ scoped observations,
  YAML scalar roundtrips, and query failure forwarding passed, exit 0.
- Identity: 1466 distribution files match build, tarball, and installed package.
  All 3742 original tracked-file hashes remain unchanged.
- OntoIndex bounded verification: PASS for explicit source/test file scope.
  Empty symbol lists limit this to file-scope agreement. OntoIndex stale/degraded:
  dirty shared checkout, scan-cap omissions, and metadata query failures; current
  source, isolated branch diff, and input hashes are authority for shipping scope.
- Four read-only shipping agents used `gpt-6-luna` and `gpt-6.1-sol`.
- No release, tag, PR, workflow dispatch, CodeQL, reindex, or service restart.
  PR creation is omitted because `pull_request_target` automation can run despite
  `[skip ci]`. Remote SHA and Actions outcomes are checked after push.
- Commit hooks may rewrite validated inputs; the per-command hook override
  preserves the frozen build. Native build/typechecking, scoped formatting,
  regression tests, and `git diff --check` supply the local checks.

Evidence: `/opt/d1/tmp/ontoindex-2.2.17-artifacts/`.
Rollback: restore `rollback-installed-2.2.16.tar.gz` under the global node_modules
directory while retaining the CLI link.
The separate audit PR-marker containment finding remains open as recorded in
`audit_session-2026-10-12-mcp-bounded-memory-closeout.md`.
Knowledge handoff: none; existing build and validation rules cover the observations.
