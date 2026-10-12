# OntoIndex 2.2.16 local installation

Date: 2026-10-12
Outcome: Built, packaged, validated, and installed locally from the isolated shipping branch.

- Base: `f7858ef05514d53cca08e13b3b49758ef739085f`, version 2.2.15.
- Branch: `chore/mcp-fixes-2.2.16`; commit message includes `[skip ci]`.
- Scope: thirteen reviewed correction, test, contract, ADR, and evidence paths; two version manifests and this record. Shared checkout remains unchanged.
- Build: `ONTOINDEX_SKIP_EXT_FETCH=1 npm_config_offline=true JOBS=4 npm run build`, exit 0, in `/opt/d1/tmp/ontoindex-build-2.2.16/ontoindex`.
- Native check: `npm_config_offline=true JOBS=4 node scripts/build-vendored-natives.cjs`, exit 0.
- Validation: 100 files and 1,470 tests passed, exit 0. All 2,881 consumed input hashes remained unchanged.
- Packaging: `npm pack --ignore-scripts`, exit 0. Tarball SHA-256: `5b1ca46c63b39d83f37b3d4d761bdf361ee5be7c535735e6892ff2dfbc725ece`.
- Installation: offline global install with scripts disabled, followed by the existing LadybugDB installer and vendored native repair script using the isolated checkout's node-gyp; all exit 0.
- CLI: `/home/er77/.local/bin/ontoindex --version` returns 2.2.16.
- Installed smoke: native parser, bundled extensions, database query, reader-pin release, fresh SDK MCP startup, 62 public tools, tool contract, C/C++ scoped observations, YAML scalar roundtrips, and summary-query error forwarding passed, exit 0.
- Identity: 1,466 distribution files match build, tarball, and installed package. All 3,742 original tracked-file hashes remain unchanged.
- OntoIndex verification found no unexpected files across five source owners. Its symbol verification returned FAIL against the older shared HEAD, including prior uncommitted repairs, and capped impact scanning at 25 symbols. The isolated diff, copied-source hashes, independent scope review, and shipping tests establish actual commit scope. OntoIndex stale/degraded: uncommitted repairs and scan-cap omissions; source inspection is authority.
- Four read-only agents used gpt-6-luna and gpt-6.1-sol; command receipts reviewed. No release, tag, PR, workflow dispatch, CodeQL run, reindex, or existing-service restart.
- Initial validation lacked the compiled shared package; building resolved it. The installed smoke initially expected a clusters key, whereas the resource contract uses modules; correcting that assertion produced exit 0.

Evidence: `/opt/d1/tmp/ontoindex-2.2.16-artifacts/`.
Rollback: restore `rollback-installed-2.2.15.tar.gz` under the global node_modules directory while retaining the CLI link.
Remote commit identity and branch Actions outcomes are verified after push.
Knowledge handoff: none; existing build and validation-diagnosis rules cover the observed corrections.
