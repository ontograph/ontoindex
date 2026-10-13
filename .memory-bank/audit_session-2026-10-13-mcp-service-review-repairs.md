# MCP service review repairs (2.2.19)

Date: 2026-10-13. Decision record: `ADR_MCP_SERVICE_REVIEW_REPAIRS.md`.

## Changes
- `doctor --json` and `gn_diagnose` redact `ONTOINDEX_*` values whose key name looks secret (token, secret, password, credential, cookie, bearer, auth, api key). Keys and `version: 1` are unchanged.
- LadybugDB pool: a timed-out connection is replaced after its native close succeeds, so `ONTOINDEX_LBUG_POOL_SIZE=1` no longer ends with an empty pool. The driver's lazy open is awaited (`db.init()`) before a pool is published; a failed open stays fenced. The five-database cap is enforced by serialized admission and returns a retryable error when all are busy.
- Dead `.reader-*` pins are removed from every managed generation, not only the first match.
- `setup` TOML edits recognize headers with trailing comments and refuse ambiguous structure. `mcp-doctor` inspects only binding positions when it looks for stale repo paths.
- One repository id function and one selector matcher (`target-context.ts`) serve ensure-fresh, systems tools, docs, can-delete, explain-module and the backend. `ensure-fresh` reads the registry through `getGlobalRegistryPath` (honors `ONTOINDEX_HOME`).
- Per-repo backend maps are pruned on refresh and cleared on dispose.
- Invocation errors marked with a reserved symbol (`shared/invocation-error.ts`) return `isError: true`; unmarked results are unchanged.
- Session tools advertise `session` or `sessionId` through `anyOf`; the argument validator checks array items and min/max. Public tool count stays at 61 in the contract snapshot (62 with the facade).
- Clone: hostnames are resolved, every answer must be public, and the vetted addresses are pinned with `http.curloptResolve`. Redirects and non-HTTP protocols are disabled.
- `server.connect` start and failure are traced under `ONTOINDEX_MCP_STARTUP_TRACE`.

## Validation
- `tsc --noEmit`: exit 0. `git diff --check`: exit 0.
- 116 test files, 1624 tests: 1623 pass. `index-generation-retention > holds a native pool reader until its database closes` fails the same way on the untouched 2.2.18 files (drain timeout), so it predates this change and is not fixed here.
- Installed smoke (`installed-smoke.log`): passed, including redaction and clone refusal.
- Artifacts: `/opt/d1/tmp/ontoindex-2.2.19-artifacts/`. Rollback: `rollback-installed-2.2.18.tar.gz`.

## Open
- The cause of the original handshake failures is not proven; no EMFILE reproduction was run.
- Clone pinning relies on git 2.43 `http.curloptResolve`; hosts with older git are not covered.
