# OntoIndex 2.4.12 local delivery

Date: 2026-11-02
Authority: user requested version bump, commit/push to main, native Linux build and local install without release publication.
Product commit: `8a51cbb4c8613aa6d51217645353e3695558f9e2`.
Verified tree: `583c83092bd8d4d0d2d21a67b0c0967b98ab70e6`.

The accumulated declared-field, resolver, audit-error, pool-lifecycle, native
ABI/build and installer-prefix repairs are committed and pushed to `origin/main`.
All three version records select 2.4.12. Commit hooks passed without changing
the verified tree. Four bounded Luna/Sol agents reviewed delivery prerequisites.

## Validation

- `bash scripts/verify-release.sh` exited 0: build, 15,800 ordinary unit passes,
  one expected failure and 70 skips; 3,046 integration passes and 234 skips.
  Unit files: 670 passed, one skipped. Integration files: 131 passed, two skipped.
- Clean-commit `CARGO_BUILD_JOBS=4 JOBS=4 npm_config_jobs=4 ONTOINDEX_SKIP_EXT_FETCH=1 npm run build`
  from `ontoindex/` exited 0. Output is `ontoindex/dist/`; native provenance
  records the product commit and `scopedDirty: false`.
- Local pack, existing installer and installed smoke exited 0. Rust/TS/JS parsing,
  semantic regressions, native hash/provenance, FTS/vector loading, database
  query and fresh MCP identity with eight public tools passed.
- OntoIndex explicit 51-file audit passed with no unexpected files. Impact was
  HIGH and capped at 25 changed symbols; expected-symbol checks and test
  execution are outside that audit. Committed graph evidence excluded dirty
  source; source and executable tests supply current-code evidence.
- Earlier full Linux results remain at
  `/opt/d2/ontoindex-full-current-5QrET9Wq/REPORT.md`: web 271, Rust 11,
  Python 146, HTTP five, Chromium 28 and native/opt-in suites passed.
  Those supplemental families were not rerun during delivery.

One staged-tree gate, one clean-commit build, one pack/install and one installed
smoke ran. Quiet integration output required activity checks; new workers
confirmed progress. No gate was restarted or bypassed. All runners were harvested.
The external smoke script's unsupported `tree.delete()` call was removed before
execution after checking the native binding API; product source was unchanged.

## Installation and limits

CLI and Codex MCP select
`/home/er77/.local/opt/ontoindex-2.4.12/lib/node_modules/ontoindex/dist/cli/index.js`.
The Ontocode config has no explicit OntoIndex entry and was preserved. Config
backup suffix: `.before-ontoindex-2412`. Installed CLI reports 2.4.12.
Owned package staging was removed; no worktree was created or process killed.

Cleanup deferred 2.4.4, 2.4.5, 2.4.6, 2.4.7, 2.4.8, 2.4.10 and 2.4.11. No direct
references were observed, but 22 same-user processes have unreadable reference
fields, so usage could not be excluded. Recovered installation space: zero bytes.

No tag, GitHub release, npm publication or CI dispatch occurred. GitHub listed
no runs for the product commit. Source-map and npm configuration warnings did
not fail validation. Embeddings remain absent; the installed MCP reports BM25
search availability. Existing GN manager state and broader qualification scope
are unchanged. Default skips remain explicit, predominantly postponed Kotlin/Dart.

Evidence: `/opt/d2/ontoindex-2412-delivery-20261102/`, including `gate.log`,
`gate.exit`, `commit.log`, `clean-build.log`, `clean-build.exit`, `install.log`,
`installed-smoke.log`, `local-install.exit`, `push.log`, `graph-audit.json`,
`tarball.sha256`, `select-install.log` and `installation-postflight.json`.
