# MCP review follow-ups (2.2.24)

Date: 2026-10-13. Findings came from a read-only review of 2.2.23 (three reviewers, a 40-case argument matrix, clone repros). The clone reviewer lost its stream a third time; its scope was checked directly.

## Changes
- Dead reader pins: `sweepDeadReaderPins` runs under the pointer lock at pin acquisition and at the start of prune. It unlinks only regular `.reader-<pid>-<rand>` files whose pid is definitely dead, in every safe generation directory (active, retained and unmanaged included), capped at 2000 per call. It never removes a generation directory. Cause: prune ran only after publish or clean release and skipped retained and unmanaged generations before scanning pins; a killed server never released. Live: 297 dead pins in ontocode, 93 in hypbase, 7 in llm.
- Doctor: servers launched without `--project` are bound through `/proc/<pid>/cwd` (Linux), git root else cwd. Failure leaves the candidate unbound as before. Live check found 21 cwd-bound servers reported `ambiguous`; several cwd-bound servers for one project (one per client session) now count as `ok`, explicit `--project` duplicates stay `ambiguous`.
- Arguments: string cap (default 2,097,152 chars, `ONTOINDEX_MAX_ARG_CHARS`) enforced in the CallTool handler in `server.ts` through `shared/arg-limits.ts`, so facade and legacy tools are covered too (live check showed the first version, which lived only in `validateSuperParams`, let a 3 MB query through `search`). Numeric `minimum`/`maximum` are clamped in `dispatchSuper` for super tools only. Not rejected, because `relaxSchemaForClient` hides bounds from clients.

## Client-visible changes
- New validation error for oversize strings; out-of-range numbers are clamped; `mcp-doctor` liveness for cwd-selected servers; new env var `ONTOINDEX_MAX_ARG_CHARS`.

## Not done
- 4.9 GB of legacy generations under ontocode (16, none carries `.retention-managed`) are not adopted or removed; that needs a separate, explicitly authorized migration.
- Pid reuse can still keep a dead pin alive (no start-time token).
- Config: `ONTOINDEX_MCP_REPO` is still set in both ontocode configs although unread; the config files were not edited.
- `ONTOINDEX_LBUG_BUFFER_MB` default stays 0.
- Symlink-swap races and `.old-` restore over an intentionally deleted target in clone code are untested.
- Clone-directory disk quota; offline postinstall without a toolchain.

## Validation
- `tsc --noEmit` 0; `git diff --check` 0; build 0 with both extension files.
- 125 test files, 1,748 tests pass.
- Facade tools (`search`, `inspect`, `impact`, `audit`, `docs`) and legacy tools do not get numeric clamping; they keep their own schemas.
- Artifacts: `/opt/d1/tmp/ontoindex-2.2.24-artifacts/`. Rollback: `rollback-installed-2.2.23.tar.gz`.
