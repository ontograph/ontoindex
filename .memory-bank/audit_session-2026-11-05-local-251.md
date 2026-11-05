# OntoIndex 2.5.1 local delivery

Date: 2026-11-05
Authority: user-authorized version bump, commit to main, native Linux build and
local installation without release publication.
Product commit: `1f513f2`. Verified tree: `e824e410afd9193cc721053ca7fcf17e8ff03588`.

## Contents

Everything under 2.5.1 in `ontoindex/CHANGELOG.md`: shadowed-name TS/JS
inference, the 48 KiB budget ceiling, exact typed IDs and `readContext` on
the symbols overlay, the background workspace-graph prebuild with an 8 GB heap,
and js-yaml 5.5.

## Validation

- `scripts/verify-release.sh` exit 0: build, 13,131 unit and 3,048
  integration tests pass.
- Clean build, `npm pack --ignore-scripts`, then
  `scripts/install-ontoindex-latest.sh` with
  `ONTOINDEX_NPM_PREFIX=~/.local/opt/ontoindex-2.5.1` exit 0. The installer
  passed its native dependency smoke test and `--version` check.
- Installed smoke: CLI 2.5.1, MCP server 2.5.1, 8 tools, CLI `context` on
  this repository.

## Installation

CLI symlink, `~/.ontocode/config.toml` and `~/.codex/config.toml` select
2.5.1 (backups `.bak-ontoindex-251`). `~/.local/bin/ontoindex-refresh-ontocode`
moved from 2.4.18 to 2.5.1. 2.4.18, 2.4.19 and 2.4.22 are retained because
each still serves a live `ontocode` session over MCP.
