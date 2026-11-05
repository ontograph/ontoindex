# OntoIndex 2.4.15 local delivery

Date: 2026-11-03
Authority: user authorized patch version, commit/push to main, Linux build and
local installation without release publication.
Product commit: `89adee73d38353701ed9a7a8a61bdd8924b2c638`.
Verified tree: `6b06f6c6b1c39fae9cc19bfb20ef4dcb70eff6dd`.

The five-file delivery fixes Go generic indexed receivers at the existing
binding extractor. Function parameters and generic method receiver parameters
remain distinct from concrete types, including shadowed names. Concrete indexed
receivers retain their method targets. Source and actual thread/process worker
regressions cover the repair. Three consistent package version records identify
2.4.15. Four bounded Luna/Sol delivery packets completed.

## Validation

- `bash scripts/verify-release.sh` exited 0 for the exact staged tree: 15,933
  unit passes, one expected failure and 70 skips; 3,055 integration passes and
  234 skips. Durations were 339.82 and 556.91 seconds.
- Commit hooks passed without changing the verified tree. Product commit was
  pushed to origin/main. GitHub listed no CI runs for that commit.
- From `ontoindex/`, `CARGO_BUILD_JOBS=4 JOBS=4 npm_config_jobs=4 ONTOINDEX_SKIP_EXT_FETCH=1 npm run build`
  exited 0 on the clean product commit. Artifacts are under `ontoindex/dist/`.
  Native provenance identifies the product commit with `scopedDirty: false`.
- Local pack, existing Linux installer, installed smoke and installed Go
  pipeline probe exited 0. Rust/TS/JS parsing, native provenance/hash, pinned
  FTS/vector loading, database query, fresh MCP identity and eight public tools
  passed. The Go probe resolves both concrete controls to `User.Save` and emits
  no false edges for either reported generic negative.
- Bounded OntoIndex five-file audit returned PASS; it executed no tests.
  Committed navigation excluded working-tree evidence; source and executable
  validation establish the repair.

One staged-tree gate, one clean-commit build, one install, one installed smoke
and one four-case installed pipeline probe completed. No failed gate was
bypassed. Foreground command sessions were harvested. Owned package staging was
removed. No broader qualification matrix was repeated.

## Installation and remaining limits

CLI and Codex MCP select
`/home/er77/.local/opt/ontoindex-2.4.15/lib/node_modules/ontoindex/dist/cli/index.js`.
CLI reports 2.4.15. The Ontocode configuration has no explicit OntoIndex entry
and was preserved. Config backup suffix is `.before-ontoindex-2415`.
Existing sessions may retain their loaded version.

Cleanup deferred 2.4.4, 2.4.5, 2.4.6, 2.4.7, 2.4.8, 2.4.10, 2.4.11, 2.4.12,
2.4.13 and 2.4.14: the final scan recorded 59 unreadable reference fields across
20 same-user processes. Non-use cannot be established. No processes were killed;
recovered installation space is zero bytes. Retained CLI/MCP targets exist.
An initial cleanup summary incorrectly asserted the earlier process count;
it was corrected from the saved final scan without repeating installation.

No tag, public release, npm publication or CI dispatch was performed. Expected
native naming, source-map and npm configuration warnings remain. Embedding
quality and receiving-client reload were not qualified. The unrelated GN
tracker remains unchanged.

Evidence: `/opt/d2/ontoindex-2415-delivery-kux2u9xj/`, including gate, commit,
clean-build and install logs/exit files, graph audit, installed smoke and Go
probe, package hash, selection log and installation reference reports.
