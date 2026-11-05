# OntoIndex 2.4.21 local delivery

Date: 2026-11-05
Authority: user-authorized version bump, commit to main, native Linux build and
local installation without release publication.
Product commit: `fcb1455` (follow-ups `e0dc1df`, `e70ff60`).
Verified tree: `0f8fb287ff891539f96eec28e8cc4c80d3c25102`.

## Changes

- `response_budget_bytes` below the minimum returns the smallest safe projection.
- Argument type errors name the received type; string booleans stay rejected
  so a string cannot satisfy `confirm`.
- MCP shutdown logs its reason to stderr.
- On repositories above `ONTOINDEX_WORKSPACE_MAX_FILES`, `search` uses the
  symbols overlay before the committed fallback.

## Validation

- `scripts/verify-release.sh`: build, 13,073 unit (one expected failure) and
  3,033 integration tests pass.
- Full `eslint .` 0 errors and `prettier --check .` clean.
- Installed smoke: CLI 2.4.21, MCP server 2.4.21, 8 tools, committed `context`.

## Installation

CLI and both MCP configurations select `~/.local/opt/ontoindex-2.4.21`
(backups `.bak-ontoindex-2421`). 2.4.20 removed (about 500 MB). 2.4.18 and
2.4.19 retained: running MCP processes use them.
