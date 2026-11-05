# OntoIndex 2.5.4 local delivery

Date: 2026-11-06
Authority: user-authorized version bump, commit to main, native Linux build and
local installation without release publication.
Product commit: `fbfbb72`, merged to master in PR #214 (merge `1cd4728`).
Verified tree: `c74167fa15e02695f407a835e2f395dc3b86a4b4`.

## Validation

- `scripts/verify-release.sh` exit 0: build, 13,242 unit and 3,049 integration
  tests pass (integration ran against the fresh 2.5.4 `dist`).
- `npm pack --ignore-scripts`, then `scripts/install-ontoindex-latest.sh` with
  `ONTOINDEX_LOCAL_ASSET` set to the packed tarball and
  `ONTOINDEX_NPM_PREFIX=~/.local/opt/ontoindex-2.5.4`, exit 0.
- Installed smoke: CLI 2.5.4, MCP server 2.5.4 with 8 tools, CLI `context` on
  this repository.

## Installation

CLI symlink, `~/.ontocode/config.toml`, `~/.codex/config.toml` and
`~/.local/bin/ontoindex-refresh-ontocode` select 2.5.4 (backups
`.bak-ontoindex-254`). 2.5.3 (504 MiB) is retained because four live MCP
server processes map it; no configuration references remain. Remove it once
those sessions restart.
