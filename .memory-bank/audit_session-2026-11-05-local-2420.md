# OntoIndex 2.4.20 local delivery

Date: 2026-11-05
Authority: user authorized version bump, commit of all changes to main, native
Linux build and local installation without release publication.
Product commit: `c0d765f32a1aa5d403c77af4e7dd71a75becc07e`.
Verified tree: `5ceea3fbcdc57e07ebadf1fc59e6f9667defe270`.

The commit carries the accumulated parser-coverage, retained-replay,
workspace read-mode and deletion-coverage work plus the R1–R4 corrections from
`ontocode/docs/review/ONTOINDEX_2_4_20_QUALIFICATION_2026_11_04.md`. The strict
TypeScript/JavaScript unknown-receiver guard stays; factory return inference,
const call-result for-of binding and JavaScript constructor fields supply the
receiver types the seven failing resolver assertions needed.

## Validation

- `scripts/verify-release.sh` on the staged tree: build, 13,059 unit tests
  (one expected failure) and 3,030 integration tests pass.
- Clean committed build: native provenance `c0d765f`, `scopedDirty: false`.
- Installed smoke: package and MCP server 2.4.20, 8 tools, pinned FTS/vector
  extensions, database query, factory inference and workspace hints.

## Installation

CLI `/home/er77/.local/bin/ontoindex` and both MCP configurations select
`/home/er77/.local/opt/ontoindex-2.4.20`. Configuration backups use the suffix
`.bak-ontoindex-2420`. Copies 2.4.18 and 2.4.19 are retained because running
MCP processes use them (1 and 6 processes, 503 MB each).

## Remaining

- The workspace graph refuses repositories above 1,600 indexed files, so dirty
  coverage is unavailable for this repository (2,153 files) and `codex`.
- GN tracker tasks remain blocked on external PR and CI state.
