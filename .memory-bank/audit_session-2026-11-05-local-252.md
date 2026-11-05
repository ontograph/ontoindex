# OntoIndex 2.5.2 local delivery

Date: 2026-11-05
Authority: user-authorized version bump, commit to main, native Linux build and
local installation without release publication.
Product commit: `19c793c`, merged to master in PR #194 (`7a24646`).
Verified tree: `5a35819c53989e5802f1306d0e364542d72920af`.

## Validation

- `scripts/verify-release.sh` exit 0: build, 13,180 unit and 3,048
  integration tests pass.
- `npm pack --ignore-scripts`, then `scripts/install-ontoindex-latest.sh` with
  `ONTOINDEX_NPM_PREFIX=~/.local/opt/ontoindex-2.5.2` exit 0 (`--version` 2.5.2).
- Installed smoke: CLI 2.5.2, MCP server 2.5.2 with 8 tools, CLI `context` on
  this repository.

## Installation

CLI symlink, `~/.ontocode/config.toml` and `~/.codex/config.toml` and
`~/.local/bin/ontoindex-refresh-ontocode` select 2.5.2 (backups
`.bak-ontoindex-252`). 2.5.1 (5 MCP processes) and 2.4.19 (1 MCP process)
are retained while live sessions still run them; remove them once those
sessions exit.
