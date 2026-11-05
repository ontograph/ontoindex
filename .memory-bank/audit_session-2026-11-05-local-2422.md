# OntoIndex 2.4.22 local delivery

Date: 2026-11-05
Authority: user-authorized version bump, commit to main, native Linux build and
local installation without release publication.
Product commit: `6e76840` (fix `0b43ebe`).
Verified tree: `47e61b4ff847bddbf2b05f3005f41a929db2fe5a`.

## Changes

The 2.4.21 symbols-overlay fallback never ran end to end. Fixed: MCP
`search/semantic` dispatches as `query` (now in the fallback set); a stale
overlay no longer forces a full workspace graph; dirty files over the scan
size cap are left out of the symbols capture instead of refusing it; a search
error on the overlay is reported as is.

## Validation

- First gate run failed 9 integration tests in
  `committed-navigation-sdk.test.ts`: the search-above-cap case still
  expected the committed fallback, and its overlay build tripped the
  no-analysis spy for the following tests. The test now asserts the overlay
  answer and resets the spy.
- `scripts/verify-release.sh` rerun: 13,075 unit (one expected failure) and
  3,033 integration tests pass.
- Installed smoke on `codex` (7,073 files): search finds
  `ensure_execution_not_recovered`, defined only in uncommitted files, with the
  overlay warning.

## Installation

CLI and both MCP configurations select `~/.local/opt/ontoindex-2.4.22`
(backups `.bak-ontoindex-2422`). 2.4.21 removed (503 MiB). 2.4.18 (1 process)
and 2.4.19 (3 processes) retained for running MCP sessions.

## Open

- `~/.ontocode/config.toml` still sets `ONTOINDEX_AUTO_WORKSPACE=0`, so the
  main client does not use automatic workspace reads; awaiting user decision.
- Overlay answers carry a prose warning, not a structured `readContext`.
