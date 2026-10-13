# MCP review follow-ups (2.2.23)

Date: 2026-10-13. Findings came from a read-only review of 2.2.22 (three reviewers, black-box probes). One reviewer's stream failed twice; its scope (clone and delete code) was read directly.

## Changes
- Upgrade path (P1): clones made by 2.2.21 at `<name>-<12 hex>` have no marker, so `cloneFresh` refused to refresh them. It now replaces the exact URL-derived hashed directory when it is a real directory with a real `.git` (no symlinks), then writes the marker. `canRemoveClone` and `isManagedClone` are unchanged, so delete still keeps unmarked directories.
- Canonical keys (P2): `repoKey` and `availableRepos[].key` use the canonical id for colliding names and keep the registry spelling for unique names.
- Docs evidence (P2): removed the fallback to a registry entry named `OntoIndex`; unknown or ambiguous selectors report `repo-not-registered`.
- Setup (P2): exit code 1 when any client fails.
- Hook: exits 0 without running the CLI when `timeout` is missing.
- Memory: opt-in `ONTOINDEX_LBUG_BUFFER_MB` for both read-only opens. Default stays 0. Measured on the live 273 MiB ontocode generation, read-only, child process per size: RSS after open 426 MiB (default), 251 MiB at 64/128/256/512 MB; query time +10.6% at 64 MB, single run.

## Client-visible changes
- `repoKey` values for same-name repositories; setup exit code; new env var; docs evidence reason for unknown repos.

## Not done
- Default buffer cap not enabled (one measurement, one index). Set `ONTOINDEX_LBUG_BUFFER_MB=64` per server to try it.
- Symlink-swap races and `.old-` restore over an intentionally deleted target in the clone code were not tested.
- Setup replaces a symlinked config with a regular file (target unchanged); documented, not changed.
- Argument validator `minimum`/`maximum` enforcement; clone disk quota; offline postinstall without a toolchain.
- Remaining name-only lookups in `src/server/api.ts` (~l.1053, 1109, 1129) were read, not changed.

## Validation
- `tsc --noEmit` 0; `git diff --check` 0; build 0 with both extension files.
- 123 test files, 1,729 tests pass.
- Artifacts: `/opt/d1/tmp/ontoindex-2.2.23-artifacts/`. Rollback: `rollback-installed-2.2.22.tar.gz`.
