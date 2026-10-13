# OntoIndex 2.2.18 local installation

Date: 2026-10-13
Outcome: Built, packaged, validated, and installed locally.

- Base: `e6cc714be4e7195e6c2c63dbde7d5900f52267dc`, version 2.2.17.
- Branch: `chore/mcp-fixes-2.2.18`; commit includes `[skip ci]`.
- Scope: 26 approved repair, documentation, ADR and test paths, two version
  manifests, and this evidence record. Concurrent shared checkout is preserved.
- Build: `ONTOINDEX_SKIP_EXT_FETCH=1 npm_config_offline=true JOBS=4 npm run build`,
  exit 0 in `/opt/d1/tmp/ontoindex-build-2.2.18/ontoindex`.
- Native validation: `npm_config_offline=true JOBS=4 node scripts/build-vendored-natives.cjs`, exit 0.
- Shipping validation: 109 selected suites, 1,535 tests passed; exit 0.
- Package: `npm pack --ignore-scripts --pack-destination /opt/d1/tmp/ontoindex-2.2.18-artifacts`, exit 0.
- Tarball SHA-256: `5aceb7183fca149f510eb5ab36a3793f24278b2fa59eb686004adcdf7dffc676`.
- Installation: offline global install with lifecycle scripts disabled, then
  existing LadybugDB installer and vendored native repair; all exit 0. An initial
  CLI check before native repair failed for the missing LadybugDB binary; the
  repair and installed smoke resolved it.
- Installed CLI `/home/er77/.local/bin/ontoindex --version`: 2.2.18.
- Installed smoke: native parser, extensions, database query, reader-pin release,
  fresh MCP handshake, 62 public tools, tool contract, resource protocol errors,
  trusted diagnostics, bounded memories and existing scope/YAML checks passed.
- Identity: 1,495 distribution files match build, tarball and installation;
  all 3,742 original tracked-file hashes remain unchanged.
- OntoIndex bounded supplied-scope verification: PASS. Indexed HEAD belongs to
  the shared checkout; isolated source/hash comparison establishes actual scope.

Evidence: `/opt/d1/tmp/ontoindex-2.2.18-artifacts/`.
Rollback: restore `rollback-installed-2.2.17.tar.gz` under the global node_modules
directory while retaining the existing CLI link.

Four read-only Luna/Sol agents reviewed installation, workflow rules, scope and
version owners. No release, tag, PR, GitHub CI, CodeQL, reindex or existing-service
restart. Branch-only push and remote SHA/Actions checks follow this commit;
their receipts are stored in the evidence directory.
