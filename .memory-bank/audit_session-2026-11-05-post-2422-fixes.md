# Post-2.4.22 fixes (no build)

Date: 2026-11-05
Authority: user asked to proceed without a build, version bump or install.

## Delivered on main

- `bb26529`, `9c1e333`: 2.4.22 qualification fixes. TS/JS shadowed-name
  inference, a 48 KiB budget-clamp ceiling, exact typed IDs and structured
  `readContext` on the symbols overlay, and the committed hints.
- `9c1e333`, `0197973`: a relationship read that falls back to the committed
  index on an oversized dirty workspace starts one background
  `analyze --workspace-graph`, using an 8 GB heap and keyed to the
  working-tree state.
- Dependency PRs #182 (js-yaml 5.5), #183 (p-limit 7.3.3) and #185
  (@langchain/core 1.3.2) were applied by hand. js-yaml 5 renamed the dump
  option `quotingType` to `quoteStyle`; the generated output is
  byte-identical (checked on 10 sample strings). #184 (docker buildx)
  was not applied because of the native-only policy.
- `ONTOINDEX_AUTO_WORKSPACE=0` was removed from `~/.ontocode/config.toml`
  (backup `config.toml.bak-auto-workspace-20261105`).

## Validation

tsc exit 0. Unit suite: 13,131 passed when run without
`ONTOINDEX_AUTO_REFRESH=0`. That variable disables the code
`auto-refresh.test.ts` covers, so 11 of its tests fail if it is set. Web
suite: 271 passed. Integration suite: see the commit message.

## Open

- Build and install, then confirm on this repository (2,094 files) that the
  background workspace prebuild completes and later reads include dirty
  files.
- The Ontocode session started on Nov 4 still runs 2.4.19 MCP servers with
  the old config. Delete 2.4.18 and 2.4.19 after it restarts.
- GN tracker: NEXT-3 blockers cite closed PRs #129, #130 and #134. `main`
  superseded the facade delivery path. Retiring or closing the tracker
  needs an owner decision.
- PR #127 (max_tokens cap) conflicts with master and has been stale since
  2026-10-15.
