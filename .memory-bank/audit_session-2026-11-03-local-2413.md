# OntoIndex 2.4.13 local delivery

Date: 2026-11-03
Authority: user authorized version bump, commit/push to main, native Linux build
and local installation without release publication.
Product commit: `1faf4b1d235a18b50573c182a39791b4e0704db7`.
Verified tree: `4b3493af3e017153ee14c5ee9d52f8fd37de2b9c`.

Qualification repairs and their regression tests are delivered in 2.4.13.
The 36-file commit includes audit failure propagation, unknown-receiver
abstention, constructor properties, Go receiver metadata, Swift caller identity,
refresh tests and formatting. All three version records agree. Four bounded
Luna/Sol delivery reviews completed before the release gate.

## Validation

- `bash scripts/verify-release.sh` exited 0 for the exact staged tree: build,
  15,914 unit passes, one expected failure and 70 skips; 3,053 integration passes
  and 234 skips. Unit files: 672 passed, one skipped. Integration files: 131
  passed, two skipped. Durations: 359.54 and 597.97 seconds respectively.
- Commit hooks exited 0 and preserved the stamped tree.
- From `ontoindex/`, `CARGO_BUILD_JOBS=4 JOBS=4 npm_config_jobs=4 ONTOINDEX_SKIP_EXT_FETCH=1 npm run build`
  exited 0. Artifacts are under `ontoindex/dist/`; native provenance identifies
  the product commit with `scopedDirty: false`.
- Local pack, installer, installed smoke and ten qualification probes exited 0.
  Rust/TS/JS parsing, semantic regressions, native hash/provenance, FTS/vector
  loading, database query and fresh MCP identity with eight tools passed.
  Qualification probes covered actual worker IPC, constructor properties,
  unknown-receiver abstention and incomplete audit reporting on database failure.
- OntoIndex explicit 36-file scope audit passed without unexpected files.
  Impact was capped at 25 changed symbols; expected-symbol scope was omitted.
  It executed no tests. Committed navigation excluded dirty source, so source
  and executed tests establish the repair evidence.
- Remote main matched the product commit; GitHub listed no runs for it.

One staged-tree gate, one clean-commit build, one install and one installed smoke
ran. No failed gate was bypassed or restarted. All command sessions were
harvested. Quiet validation incurred excess unchanged status observations before
compaction; this did not authorize replacement runs. Earlier full-backend and
broader Linux evidence remain historical; web, Python, standalone native-addon,
coverage and opt-in families were not repeated during this delivery.

## Installation and remaining limits

CLI and Codex MCP select
`/home/er77/.local/opt/ontoindex-2.4.13/lib/node_modules/ontoindex/dist/cli/index.js`.
Installed CLI reports 2.4.13. The Ontocode configuration has no explicit
OntoIndex entry and was preserved. Config backup suffix is
`.before-ontoindex-2413`. Existing sessions may retain their loaded version.

Owned package staging was removed. Cleanup deferred installations 2.4.4, 2.4.5,
2.4.6, 2.4.7, 2.4.8, 2.4.10, 2.4.11 and 2.4.12: the reference check found
65 unreadable fields across 22 same-user processes. Usage cannot be excluded.
No processes were killed; recovered installation space is zero bytes.

No tag, GitHub release, npm publication or CI dispatch was performed. Build
warnings include native naming, source maps and npm configuration/install-script
notices; installed runtime checks passed. Embeddings remain absent; MCP reports
BM25 availability. GN manager remains blocked with no eligible task and unchanged
tracker SHA-256 `47c4ef9f44a43a752683bf3955df8b0b1ab181199b2ef953d9f464157aa1785a`.
Its reopen gate requires a dependency-ready unfinished task without substantive
known blockers. The broader GN qualification scope is unchanged.

Evidence: `/opt/d2/ontoindex-2413-delivery-szk_uzt6/`, including `gate.log`,
`gate.exit`, `commit.log`, `clean-build.log`, `clean-build.exit`, `push.log`,
`product-ci-runs.json`, `install.log`, `installed-smoke.log`,
`qualification-probes.log`, `local-install.exit`, `graph-audit.json`,
`tarball.sha256`, `select-install.log` and `installation-postflight.json`.
