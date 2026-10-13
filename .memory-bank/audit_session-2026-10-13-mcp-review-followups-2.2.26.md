# MCP review follow-ups (2.2.26)

Date: 2026-10-13. Findings came from a read-only review of 2.2.25 (four reviewers plus live probes on the installed build).

## Changes
- Plain `ontoindex analyze` publishes through `publishIndexGenerationTransaction` with a no-op commit (`run-analyze.ts`), so every CLI analyze writes `.retention-managed` and prunes. Root cause of the unbounded growth seen in ontoindex (31 generations), essbase-foundation-tools (36) and hypbase (10): retention was added to the transaction wrapper in 93c4548 (2.2.9) but the non-managed branch kept calling `activateIndexGeneration`. Option chosen over moving retention into `activateIndexGenerationLocked` because pruning there would run before the managed receipt commit and could delete the rollback predecessor.
- `clean --generations`: marker-first ranking; per-candidate delete failures reported, remaining work continues, exit 1 after output (force only).
- `mcp-doctor`: `capabilityGaps[].details` for `runtime-warnings`.

## Policy kept
- Automatic pruning considers only marked generations. The legacy unmarked history (ontocode 16, ontoindex 30, essbase-foundation-tools 36, hypbase 10, others) is removed only by the explicit command.

## Client-visible changes
- New marker and pruning on every CLI analyze; optional `details` in doctor JSON; clean output when a deletion fails.

## Not done
- No generation was deleted on this host.
- A hand-edited tiny marker value can demote a real rollback candidate in `clean --generations` ranking (generated markers are always millisecond-scale).
- The shared-server idea, numeric clamping beyond super tools, eval-server paging, REST Host header check, pid-reuse pins, clone races, `ONTOINDEX_MCP_REPO` in the ocode configs, `ONTOINDEX_LBUG_BUFFER_MB` default (0), `~/.agents/skills` (run `ontoindex setup`).

## Validation
- `tsc --noEmit` 0; `git diff --check` 0; build 0 with both extension files.
- 133 test files, 1,830 tests pass.
- Artifacts: `/opt/d1/tmp/ontoindex-2.2.26-artifacts/`. Rollback: `rollback-installed-2.2.25.tar.gz`.
