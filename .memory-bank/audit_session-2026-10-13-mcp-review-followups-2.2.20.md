# MCP review follow-ups (2.2.20)

Date: 2026-10-13. Decision record: `ADR_MCP_REVIEW_FOLLOWUPS_2_2_20.md`. Findings came from a read-only review of 2.2.19.

## Changes
- Clone: URLs with `user:pass@` are rejected; URLs are redacted in progress, logs and errors (`redactGitUrl`). Git runs with an isolated config (`gitEnvironment`: no system/global config, no `GIT_CONFIG_*` injection, no SSH/proxy-command overrides; proxy and TLS variables kept; no-op askpass kept). A pull first reads and validates the checkout's origin URL. Caveat: the checkout's own local git config still applies on pull.
- Doctor: `ps` output is streamed; only ontoindex MCP candidate lines are kept (256 candidates, 16 KiB per line, 2 s timeout). The buffered 64 KiB capture failed on hosts with ~1,200 processes.
- Pool: a failed native open keeps its generation pin for the process lifetime; when failed opens use all pool slots the error says to restart the server; pin-release failures are logged to stderr and retried (idle timer, `closeLbug`); a lock file whose initialization fails is removed.
- Shutdown: signal/EOF shutdown and startup-timeout cleanup share one grace deadline (`ONTOINDEX_MCP_SHUTDOWN_GRACE_MS`, default 5000 ms, range 100..60000). On expiry the server logs to stderr and exits. Repeated signals do not cut cleanup short.
- Errors: analyze-job, worker-scope-review, and audit-session dispatch/manager refusals are marked (`isError: true`). Verification findings stay successes.
- Test: the generation-retention test no longer holds a gate while `closeLbug` waits; it now passes (it failed on 2.2.18 and 2.2.19).

## Not done
- Argument validator `minimum`/`maximum` enforcement: about 45 properties declare bounds and many handlers clamp, so enforcement needs a per-handler audit (see ADR).
- Eight or more handlers beyond those above may still return failures unmarked; the marked set follows the review list.
- `gn_graph_walk` is in the registry (62 tools) but not in the stable contract snapshot (61). Unchanged; decide whether that is intended.

## Validation
- `tsc --noEmit` exit 0; `git diff --check` exit 0.
- 114 test files, 1622 tests, all pass (`final.log`).
- Installed smoke passed (`installed-smoke.log`), including credential refusal, git isolation, error marker and shutdown grace.
- Installed `mcp-doctor` no longer fails on `ps` buffer size. It still reports DEGRADED: the running processes have no `--project` argument, and `~/.agents/skills` is missing.
- Artifacts: `/opt/d1/tmp/ontoindex-2.2.20-artifacts/`. Rollback: `rollback-installed-2.2.19.tar.gz`.

## Open
- The cause of the original handshake failures is unproven. About 233 leftover `lean-ctx` and Ghidra bridge processes on the host are the likeliest source of descriptor pressure; they were not touched.
