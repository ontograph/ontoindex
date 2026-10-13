# ADR: MCP review follow-ups (2.2.20)

Status: Accepted. Date: 2026-10-13. Follows `ADR_MCP_SERVICE_REVIEW_REPAIRS.md` (2.2.19).

## Decisions
1. Clone credentials: reject `user:pass@` URLs; redact URLs in progress, logs and errors. Public behavior change: such clone requests now fail.
2. Clone git config: run git with `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null` and no `GIT_CONFIG_*` injection, so `url.*.insteadOf` cannot bypass the address pin. Proxy and TLS variables are kept. Pull re-validates the checkout's origin URL.
3. Doctor: stream `ps` output and keep only candidate lines instead of buffering the whole table (64 KiB cap failed on hosts with ~1,200 processes).
4. Pool: a failed native open keeps its generation pin (the handle cannot be closed in-process); exhausted failed-open capacity returns a restart-required error; pin-release failures are logged and retried; a failed lock-file initialization removes the lock it created.
5. Shutdown: one grace deadline (`ONTOINDEX_MCP_SHUTDOWN_GRACE_MS`, default 5000 ms) for signal/EOF shutdown and for startup-timeout cleanup; expiry forces exit.
6. Errors: direct invocation refusals in analyze-job, write-through-verification and audit-session tools are marked (`isError: true`). Domain findings stay successes.
7. Test fix: the generation-retention test releases its gate while `closeLbug` runs.

## Deferred
- Enforcing `minimum`/`maximum` in the argument validator. About 45 properties declare bounds and many handlers clamp out-of-range values (for example `gn_docs` limit, `gn_graph_walk` step limits), so enforcement would reject calls that work today. Needs a per-handler audit first.

## Rejected
- Raising only the `ps` buffer (still host dependent).
- Releasing the pin of a failed open (allows pruning under a retained handle).
- Per-caller watchdogs (second shutdown owner).
- Marking by `ok:false`/`status:'error'` heuristics (turns findings into failures).

## Rollback
Reinstall `rollback-installed-2.2.19.tar.gz`; revert branch commit.
