# OntoIndex 2.4.16 local delivery

Date: 2026-11-03
Authority: user authorized patch version, commit/push to main, Linux build and
local installation without release publication.
Product commit: `39726cd651d8fb77f25f61f74ef33a1f1e73c0e0`.
Verified tree: `21d00374c70b07c2b3a0d04512b33ebfcae221d7`.

The five-file delivery fixes R1 from the 2.4.15 qualification report. The existing
Go receiver helper unwraps pointers and parentheses before collecting generic
parameter names. Sequential and compiled thread/process regressions prevent
false concrete method edges while retaining concrete receiver resolution.
Three package version records agree at 2.4.16. Four bounded Luna/Sol delivery
packets completed. No dependencies or suite configuration changed.

## Validation

- `bash scripts/verify-release.sh` exited 0 for the exact staged tree: 15,941
  unit passes, one expected failure and 70 skips; 3,055 integration passes and
  234 skips. Durations were 338.19 and 549.82 seconds.
- Normal commit hooks passed without changing the verified tree. Product commit
  was pushed to origin/main. GitHub listed no CI runs for that commit.
- From `ontoindex/`, `CARGO_BUILD_JOBS=4 JOBS=4 npm_config_jobs=4 ONTOINDEX_SKIP_EXT_FETCH=1 npm run build`
  exited 0 on the clean product commit. Artifacts are under `ontoindex/dist/`.
  Native provenance identifies the product commit with `scopedDirty: false`.
- Local pack, existing Linux installer, installed smoke and eight-case installed
  Go pipeline probe exited 0. Rust/TS/JS parsing, native provenance/hash, pinned
  FTS/vector loading, database query, fresh MCP identity and eight public tools
  passed. The Go probe requires full parsing and verifies exact concrete targets
  and abstention through parenthesized and nested generic receiver wrappers.
- Bounded OntoIndex five-file audit returned PASS; it executed no tests.
  Committed navigation excluded working-tree evidence; source and executable
  validation establish the repair.

One staged-tree gate, one clean-commit build, one install, one installed smoke
and one eight-case installed pipeline probe completed. Foreground sessions were
harvested. Owned package staging was removed. No broader qualification matrix
was repeated. Go compiler validation remains unavailable on this host.

## Installation and remaining limits

CLI and Codex MCP select
`/home/er77/.local/opt/ontoindex-2.4.16/lib/node_modules/ontoindex/dist/cli/index.js`.
CLI and fresh MCP report 2.4.16. The Ontocode configuration has no explicit
OntoIndex entry and was preserved. Codex configuration backup suffix is
`.before-ontoindex-2416`. Existing sessions may retain their loaded version.

Cleanup deferred 2.4.4, 2.4.5, 2.4.6, 2.4.7, 2.4.8, 2.4.10, 2.4.11, 2.4.12,
2.4.13, 2.4.14 and 2.4.15: the final scan recorded 59 unreadable reference
fields across 20 same-user processes. Non-use cannot be established. No processes
were killed; recovered installation space is zero bytes. Retained CLI/MCP targets
exist.

No tag, public release, npm publication or CI dispatch was performed. Existing
native naming, source-map and npm configuration warnings remain. Embedding
quality and receiving-client reload were not qualified. The unrelated GN
tracker remains unchanged.

Evidence: `/opt/d2/ontoindex-2416-delivery-WOsU8DqQ/`, including gate, commit,
clean-build and install logs/exit files, graph audit, installed smoke and Go
probe, package hash, selection log and installation reference reports.
