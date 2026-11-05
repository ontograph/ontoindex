# OntoIndex 2.5.3 local delivery

Date: 2026-11-05
Authority: user-authorized version bump, commit to main, native Linux build and
local installation without release publication.
Product commit: `b362591`, merged to master in PR #206.
Verified tree: `0614c10e109894a8b7d1374d81238e2be0c6dff5`.

## Validation

- `scripts/verify-release.sh` exit 0: build, 13,215 unit and 3,049 integration
  tests pass. Integration ran against the fresh 2.5.3 `dist`, closing the
  post-2.5.2 gap where dist-spawning suites used the 2.5.2 build.
- `npm pack --ignore-scripts`, then `scripts/install-ontoindex-latest.sh` with
  `ONTOINDEX_NPM_PREFIX=~/.local/opt/ontoindex-2.5.3` exit 0 (`--version` 2.5.3).
- Installed smoke: CLI 2.5.3, MCP server 2.5.3 with 8 tools, CLI `context` on
  this repository.

## Installation

CLI symlink, `~/.ontocode/config.toml`, `~/.codex/config.toml` and
`~/.local/bin/ontoindex-refresh-ontocode` select 2.5.3 (backups
`.bak-ontoindex-253`). Retained because live MCP processes map them:
2.4.19 (1), 2.5.1 (4), 2.5.2 (3); no configuration references remain.
Dependabot #201 (node-gyp 13) was not included: the repo pins node-gyp 12.2.0
via `overrides`, and the upgrade needs its own native-build qualification.
