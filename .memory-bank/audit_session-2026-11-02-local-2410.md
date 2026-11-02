# OntoIndex 2.4.10 local delivery

Date: 2026-11-02
Authority: user requested version bump, mainline commit/push, build and local installation; no release publication.
Product commit: `7b33dceb7afbde3f2ea7f2bb4afdef662b825ae7`.
Validated tree: `7cbfda475e6c9bdc72fae98d9e85799bfdd3040f`.

The delivery includes the pending 2.4.9 repairs and 2.4.10 generic binding,
public line projection, coupling-warning and batched search corrections.
Four preflight reviewers used gpt-6-luna and gpt-6.1-sol.

## Validation

- Native Linux build, unit and integration gate exited 0. Unit: 663 files
  passed, one skipped; 15,668 tests passed, one expected failure, 70 skipped.
  Integration: 131 files passed, two skipped; 3,044 tests passed, 234 skipped.
- Commit hooks passed formatting, lint and package typechecks; the committed
  tree equals the gate stamp. Clean-commit build exited 0.
- Native addon provenance names the product commit and `scopedDirty: false`.
- Local tarball installation and installed smoke exited 0. Version identity,
  generic shadowing/chains/cycles, public coordinates, JS/TS semantic repairs,
  native hash, FTS/vector loading, database query and fresh MCP startup passed.
  MCP reports 2.4.10 and advertises eight tools.
- OntoIndex's explicit 74-file scope audit passed. Impact was capped at 25
  changed symbols; no expected-symbol assertion or test execution was supplied
  by that audit. The committed graph excluded pending repairs, so current
  source and executable tests supplied their evidence.

Commands: repository-root `bash scripts/verify-release.sh`, then
`CARGO_BUILD_JOBS=4 npm run build` from `ontoindex/`, then the local install
driver using `npm pack --ignore-scripts` and the existing installer.
Gate test workers were capped at two. Two builds, one full gate, one package
installation and one installed smoke were used. No provider turns or publication.

Evidence: `/opt/d2/ontoindex-2410-delivery-20261102/`, including `gate.log`,
`commit.log`, `clean-build.log`, `install.log`, `installed-smoke.log`,
`graph-scope-audit.json`, `tarball.sha256` and `delivery.json`.

## Installation and limits

CLI and the existing Codex MCP entry select
`/home/er77/.local/opt/ontoindex-2.4.10/lib/node_modules/ontoindex/dist/cli/index.js`.
The Ontocode config has no explicit OntoIndex entry and was preserved. Config
backup suffix is `.before-ontoindex-2410`. Existing live MCP sessions retain 2.4.8.
Owned package staging was removed. No worktrees were created.

Older installations are retained: 2.4.8 has live references; 2.4.4–2.4.7 have
no observed references but nine same-user process maps are unreadable. Cleanup
recovered zero bytes. No sessions were killed.

This delivery does not close broader GN qualification, pinned buffer-exhaustion
measurement, frozen fixture gaps, or real second-caller timeout proof. Search
aggregation still scans edges; no universal memory or performance improvement
is claimed. Browser/web, standalone native and HTTP/Python supplemental families
were not rerun. Existing GN manager state remains blocked with active task null.
Remote mainline is named `master`; delivery commits use `[skip ci]` to suppress
automatic publication. No tag, GitHub release or npm publication is authorized.
