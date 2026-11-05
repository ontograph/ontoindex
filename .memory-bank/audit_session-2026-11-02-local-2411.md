# OntoIndex 2.4.11 local delivery

Date: 2026-11-02
Authority: user requested version bump, commit and push to main, build and local installation; no release publication.
Product commit: `0fc971a510ffd50f0a6542710b1bfefa7fe15173`.
Validated tree: `7cb19a619b569ec95d6a0ed3446788e0bd773df8`.

The patch separates TypeScript class fields from lexical bindings, resolves
nullable generic constraints, and prevents unknown receivers from producing
name-only call edges. It corrects grouped impact line coordinates, reports marked
audit failures as incomplete, and stops timeout amplification in optional search
enrichment while preserving deterministic compatibility fallbacks.

## Validation

- Corrected full Linux gate exited 0: 663 unit files passed, one skipped;
  15,703 tests passed, one expected failure, 70 skipped. Integration: 131 files
  passed, two skipped; 3,044 tests passed, 234 skipped.
- The first gate exited 1 on two fixture assertions that inferred nonexistent
  fields from same-named parameters. The test-only correction requires both
  methods to exist and rejects every outgoing save call edge; declared-field
  positive coverage remains. Focused TypeScript integration passed 220 tests.
- Formatting, lint, typechecks and commit hooks passed. The product tree matches
  the verification stamp. The clean-commit build exited 0.
- Local tarball installation and installed smoke exited 0. Version identity,
  semantic regressions, native addon hash and clean source provenance, FTS/vector
  loading, database query, and fresh MCP startup with eight tools passed.
- OntoIndex's bounded 18-file audit passed. Impact was capped at 25 changed
  symbols; expected-symbol assertions and executed tests were not supplied by
  the audit. Committed graph evidence excludes pending edits. Fixture impact
  returned not-in-index; source and executable tests supplied that evidence.

Commands: repository-root `bash scripts/verify-release.sh`; from `ontoindex/`,
`CARGO_BUILD_JOBS=4 npm run build`; local packaging with
`npm pack --ignore-scripts` and the existing installer. Full gates used two test
workers. Two full gates, one focused integration run, three builds, one local
installation and one installed smoke were executed. One corrective round was
used. Repeated quiet-output waits occurred while the gate was running; no
replacement or overlapping validation was launched, and fresh workers confirmed
progress. All started commands were harvested.

Evidence: `/opt/d2/ontoindex-2411-delivery-20261102/`, including `gate.log`,
`gate-corrected.log`, `typescript-correction.log`, `commit.log`, `push.log`,
`clean-build.log`, `install.log`, `installed-smoke.log`,
`graph-scope-audit-corrected.json`, `tarball.sha256` and `installation-final.json`.

## Delivery and retained installations

Product commit is pushed to `origin/main`. Remote default branch `master` remains
unchanged. The previous local main is preserved at
`recovery/main-before-2411-20261102`. No tag, GitHub release, npm publication or CI
dispatch was made; the branch workflow query returned no runs.

CLI and the Codex MCP entry select
`/home/er77/.local/opt/ontoindex-2.4.11/lib/node_modules/ontoindex/dist/cli/index.js`.
The Ontocode config has no explicit OntoIndex entry and was preserved. Config
backup suffix is `.before-ontoindex-2411`. Existing live MCP sessions retain
2.4.8. Owned package staging was removed. No worktrees were created.

Cleanup recovered zero bytes. Version 2.4.8 has live references; 2.4.4–2.4.7 and
2.4.10 have no observed references, but nine same-user processes have unreadable
maps/cwd/exe fields, so usage cannot be excluded. Those copies were retained.
No sessions were killed.

Broader GN qualification, pinned buffer-exhaustion measurement, frozen fixture
gaps and real second-caller timeout proof remain open. Browser/web, standalone
native and HTTP/Python supplemental families were not rerun. The existing GN
manager state is unchanged. Search aggregation still scans edges; this delivery
does not establish a universal memory or performance improvement.
