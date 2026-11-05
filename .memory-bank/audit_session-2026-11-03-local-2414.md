# OntoIndex 2.4.14 local delivery

Date: 2026-11-03
Authority: user authorized version bump, commit/push to main, native Linux build
and local installation without release publication.
Product commit: `b2159cbfc9432afce968a7aa000d23b6ba1e4e79`.
Verified tree: `786f487d0b65b112d04e6b8c1485698fa4d5e922`.

The five-file delivery includes the workspace-search warning repair, regression
tests and three consistent version records. Warnings use the existing admitted
graph authority, and explore/related attach them inside the prepared read.
Four bounded Luna/Sol delivery reviews completed.

## Validation

- `bash scripts/verify-release.sh` exited 0: 15,922 unit passes, one expected
  failure and 70 skips; 3,053 integration passes and 234 skips. Durations were
  344.37 and 559.05 seconds. The exact staged tree was stamped.
- Commit hooks passed without changing the verified tree. Remote main matched
  the product commit. GitHub listed no CI runs for that commit at verification.
- From `ontoindex/`, `CARGO_BUILD_JOBS=4 JOBS=4 npm_config_jobs=4 ONTOINDEX_SKIP_EXT_FETCH=1 npm run build`
  exited 0. Artifacts are under `ontoindex/dist/`; native provenance identifies
  the product commit with `scopedDirty: false`.
- Local pack, installer and installed native/database/MCP smoke exited 0.
  Rust/TS/JS parsing, native provenance/hash, FTS/vector loading, database query
  and fresh MCP identity with eight public tools passed.
- Twelve installed MCP calls passed using the retained Rust/TS/JS dirty fixtures:
  per language, current semantic search, committed semantic search, explore and
  related-symbol inspection. Current reads found the dirty symbol without the
  contradictory warning; committed search excluded it with explicit provenance.
  Fixture source and registry hashes stayed unchanged. The MCP process exited 0.
  Committed explore/related were not separately exercised by this installed check.
- Bounded OntoIndex five-file audit returned PASS. It executed no tests.
  Navigation used committed fallback because of `workspace_too_large`; source
  and executed tests establish evidence for the dirty changes.

One staged-tree gate, one clean-commit build, one install, one installed smoke
and one twelve-call MCP acceptance run completed. No failed gate was bypassed.
Command sessions were harvested. No broader qualification matrix was repeated.

## Installation and remaining limits

CLI and Codex MCP select
`/home/er77/.local/opt/ontoindex-2.4.14/lib/node_modules/ontoindex/dist/cli/index.js`.
CLI reports 2.4.14. The Ontocode configuration has no explicit OntoIndex entry
and was preserved. Config backup suffix is `.before-ontoindex-2414`.
Existing sessions may retain their loaded version.

Owned package staging was removed. Cleanup deferred 2.4.4, 2.4.5, 2.4.6, 2.4.7,
2.4.8, 2.4.10, 2.4.11, 2.4.12 and 2.4.13: 62 unreadable reference fields across
21 same-user processes prevent establishing non-use. No processes were killed;
recovered installation space is zero bytes. Retained CLI/MCP files exist.

No tag, public release, npm publication or CI dispatch was performed. Expected
native naming, source-map and npm configuration warnings remain. Embedding
quality was not qualified. The unrelated GN tracker remains unchanged.

Evidence: `/opt/d2/ontoindex-2414-delivery-ueHniwAt/`, including gate, commit,
clean-build and install logs/exit files, graph audit, installed smoke,
warning responses/summary/identity/process exit, tarball hash and installation
reference reports.
