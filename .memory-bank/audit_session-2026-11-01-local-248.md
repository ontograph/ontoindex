# OntoIndex 2.4.8 local delivery

Date: 2026-11-01
Authority: user requested version, commit, push, local build and installation.
Product commit: `103228d3c3333c5fa9dcb6a4a1ec302d6539c852`.
Branch: `fix/244-qualification`; existing PR181 targets master.

## Changes and review

Ambient exports, route binding identity and parameter writes, 128-bit ABI
precision reporting, coupling cap boundaries, installer cleanup and workspace
test shutdown are repaired. Four read-only explorers (two Luna, two Sol)
reviewed version ownership, installation, gates and pending source.

Release review found parameter initializers could write an outer handler while
the extractor resolved the write to a body-local var. Three alternatives were
challenged twice: separate parameter/body environments; conservatively refuse
shapes for parameter-written names; revert shared body scopes. The second was
selected: it reuses the existing traversal, adds constant-time checks, preserves
public APIs and introduces no dependency. Reverting scope sharing alone leaves
var resolution incorrect. Full environment modeling expands the semantic change.
The conservative fix can omit valid same-named shadowed shapes. JS/TS direct,
closure, destructuring and unaffected-name cases passed all 27 focused tests.

## Local validation

- Release gate: exit 0, 659 unit files passed, one skipped; 15,546 tests passed,
  one expected failure, 70 skips. Integration: 130 files passed, two skipped;
  3,039 tests passed, 234 skips.
- Validated tree: `9e29ae6412a922360cde8c3e2638b0821fd9ece0`, identical to the
  release commit tree. Commit hooks passed, including typecheck.
- Clean-commit build: exit 0; native provenance names the product commit above
  and records `scopedDirty: false`.
- Package/install and installed smoke: exit 0. Native addon hash, JS/TS semantic
  boundaries, parameter-write regression, 128-bit ABI, FTS/vector extensions,
  database query and fresh MCP 2.4.8 identity passed; eight tools advertised.
- OntoIndex 21-file scope audit passed; scan capped at 25 symbols, without an
  expected-symbol assertion. Dirty edits were excluded from the graph, so source
  inspection supplied current-code evidence.

Commands ran natively from the repository root, or `ontoindex/` for the build:
`bash scripts/verify-release.sh`, `npm run build`, then the local install driver
using `npm pack --ignore-scripts` and `scripts/install-ontoindex-latest.sh`.
Compiler parallelism was capped with `CARGO_BUILD_JOBS=4`; test workers at two.
Bundled Ladybug extensions came from the verified 2.4.7 installation.

Evidence logs under `/tmp/`: `ontoindex-248-release-gate2-20261101.log`,
`ontoindex-248-commit.log`, `ontoindex-248-clean-build-20261101.log`,
`ontoindex-248-install-20261101.log`,
`ontoindex-248-installed-smoke-20261101.log`, and
`ontoindex-248-cleanup-evidence.json`.
Tarball SHA-256: `c5b39f68e682bbc0546d77589eba1c39d839e6aa03a3fcae8d697ac9756471cb`.

## Installation and residual work

CLI and Codex/Ontocode MCP configs select
`/home/er77/.local/opt/ontoindex-2.4.8/lib/node_modules/ontoindex/dist/cli/index.js`.
Config backups use suffix `.before-ontoindex-248`. Existing sessions retain their
loaded versions. Managed copies 2.4.4 and 2.4.7 remain live; 2.4.5 and 2.4.6 have
no visible references but nine same-user process maps were unreadable. All are
retained; no installation directories removed, zero bytes recovered. Owned staging
`/opt/d1/tmp/ontoindex-248-release.wulRFO` was removed and absence verified.
No task-created worktrees remain. No remote build or release publication requested.

Both 247 follow-up managers are closed, active task null. Pinned buffer-exhaustion
measurements and broader GN qualification remain open. The 49,999 cap does not
prove a memory/performance repair; no measured speedup is claimed.

Original allowance was two builds and one gate. Review caught a concrete defect
after gate1's build; its unit run was terminated (exit -1). The authorized
release/fix scope added a native probe, 27-case focused suite and replacement
gate/build. Actual totals: three builds including the clean-commit build, two
gates (one interrupted), one focused suite, one package/install and one installed
smoke. Earlier budget overruns remain in the closed trackers.
