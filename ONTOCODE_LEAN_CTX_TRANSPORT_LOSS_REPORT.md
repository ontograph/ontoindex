# Ontocode Bug Report: lean-ctx MCP server dies on detached background launch and never recovers

Date: 2026-08-06
Reporter: Codex session, OntoIndex workspace
Component: lean-ctx MCP server (`ctx_shell`, `ctx_execute`, `ctx_read`)
Severity: High — unrecoverable loss of the agent's only shell mid-session
Observed runtime: Node.js `v22.22.3`, Linux, workspace `/opt/demodb/_workfolder/OntoIndex`

Latest probe: 2026-08-06 — `ctx_shell`, `ctx_execute`, `ctx_read`, and
`ctx_compose` initially still failed with `Transport closed`. The lean-ctx
server later recovered without a workspace restart, and managed foreground and
background commands completed successfully.

## Summary

The lean-ctx MCP server terminated during a `ctx_execute` call that launched a
long-running test suite as a detached background process. Every subsequent
lean-ctx tool call fails with `Transport closed`. The server did not restart and
did not recover across repeated probes spanning several minutes.

Because the operating environment routes all shell access through lean-ctx, the
agent lost the ability to run tests, linters, builds, and git commands for the
remainder of the session, with no in-session remediation available.

## Impact

- Total loss of lean-ctx MCP shell, file-read, code-composition, and search
  capability for the session.
- The separate native bounded `lctx__read` path remained available for
  workspace-relative reads, but it cannot run tests, builds, linters, git
  commands, or inspect `/tmp` artifacts. It is not a shell recovery path.
- Work in progress could not be verified, and a possibly still-running detached
  `vitest` process could not be observed or reaped.
- The failure is silent from the caller's perspective until the next tool call.

## Trigger Sequence

The failure followed a specific and reproducible-looking pattern.

1. A normal foreground call was issued to run the full unit suite:

   ```
   ctx_shell(command="cd .../ontoindex && npx vitest run test/unit 2>&1 | tail -25")
   ```

   This failed with a client-side timeout, not a server crash:

   ```text
   tool call failed for `lean-ctx/ctx_shell`
   Caused by:
       timed out awaiting tools/call after 40s
   ```

2. The same command was retried through `ctx_execute` with an explicit
   `timeout: 1800`. It failed identically at 40s, indicating the documented
   per-call `timeout` parameter does not raise the effective MCP ceiling:

   ```text
   tool call failed for `lean-ctx/ctx_execute`
   Caused by:
       timed out awaiting tools/call after 40s
   ```

3. To work around the 40s ceiling, the suite was launched detached so the call
   could return immediately:

   ```bash
   cd /opt/demodb/_workfolder/OntoIndex/ontoindex
   rm -f /tmp/unit.log /tmp/unit.done
   nohup bash -c 'npx vitest run test/unit > /tmp/unit.log 2>&1; echo $? > /tmp/unit.done' >/dev/null 2>&1 &
   sleep 2; echo "launched"; tail -3 /tmp/unit.log 2>/dev/null
   ```

   This call did not time out. It returned:

   ```text
   tool call failed for `lean-ctx/ctx_execute`
   Caused by:
       Transport closed
   ```

4. Every lean-ctx call after that point returned `Transport closed`, including
   trivial ones:

   ```
   ctx_shell(command="echo probe")            -> Transport closed
   ctx_execute(language="shell", code="echo alive") -> Transport closed
   ctx_read(path="/tmp/unit.done", mode="raw")      -> Transport closed
   ```

   Note the elapsed time reported for these failures dropped to ~0.0004s,
   versus ~0.03-0.07s for healthy calls, consistent with the client failing
   fast against a dead transport rather than attempting real work.

## Analysis

Two distinct defects are visible, and the second is the serious one.

### Defect 1: per-call `timeout` does not extend the MCP call ceiling

`ctx_execute` advertises a `timeout` parameter documented as "Timeout in seconds
(default: 30)". Supplying `timeout: 1800` still aborted at 40s with
`timed out awaiting tools/call after 40s`. The parameter appears to govern only
the inner child process, while an outer MCP `tools/call` deadline of 40s remains
fixed. Any legitimately long command — a full test suite, a large build, an
analyze run — is therefore unreachable through the documented interface.

This is what pushes callers toward backgrounding work, which leads directly to
the second defect.

### Defect 2: detached background launch kills the server

Spawning a `nohup ... &` background job caused the server process itself to
terminate. The most likely mechanisms, in rough order of probability:

- The server's command executor waits on the whole process group or keeps the
  stdio pipes open until all descendants exit. A detached child that inherits or
  holds those descriptors can wedge or tear down the parent's transport.
- The child was spawned into the server's own process group, so a cleanup or
  timeout path signalled the group and killed the server along with the child.
- An unhandled rejection or `EPIPE` on the stdio transport when the detached
  child's redirection interacted with the server's pipe handling, crashing the
  Node process without a restart.

Regardless of mechanism, a user-supplied command must never be able to terminate
the MCP server hosting it. That is a containment failure at the boundary between
the executor and the transport.

### Defect 3: no supervision or auto-restart

After the crash the server stayed down. There is no visible supervisor,
reconnect, or lazy re-spawn on the next `tools/call`. Since the environment's
own guidance makes lean-ctx the mandatory path for shell, reads, and search,
its death is a hard stop for the session with no documented recovery short of
the human restarting the server.

## Suggested Reproduction

In any workspace with the lean-ctx MCP server attached:

```bash
# via ctx_execute(language="shell")
nohup bash -c 'sleep 60; echo done > /tmp/probe.done' >/dev/null 2>&1 &
sleep 2; echo launched
```

Then issue any follow-up lean-ctx call and observe whether it returns
`Transport closed`. Vary the redirection (`>/dev/null 2>&1` vs inherited stdio)
and `setsid` vs plain `&` to isolate whether descriptor inheritance or process
group signalling is responsible.

## Recommendations

1. Contain the executor. Spawn user commands with `detached: true` and their own
   process group, fully redirect child stdio away from the server's transport
   pipes, and never signal the shared group on cleanup. A child must not be able
   to take the server down.
2. Add a top-level `uncaughtException` / `unhandledRejection` guard on the server
   so a failure in one tool call is reported as a tool error instead of exiting
   the process.
3. Make the effective call ceiling honest. Either respect the documented
   `timeout` parameter up to the MCP deadline, or document the real 40s ceiling
   and provide a supported async job API — submit, poll, fetch output — so long
   builds and test suites do not require ad-hoc backgrounding.
4. Supervise the server, or lazily re-spawn it on the next `tools/call` after an
   unexpected exit, so a single crash is not session-fatal.
5. Return a distinguishable error. `Transport closed` should carry a hint that
   the server died and needs restarting, rather than reading like a transient
   network blip.
6. Provide a supported status/restart operation for the lean-ctx MCP server so
   an agent can recover without restarting the whole user session.

## Current Session State

- lean-ctx: recovered without a workspace restart. Foreground calls and the
  supported `ctx_shell(run_in_background=true)` submit/status workflow now work.
- OntoIndex MCP: healthy and responding; used to confirm workspace state
  and release gates after recovery.
- No orphaned test process from the original incident remains.

## Release Work Blocked By This Incident

The transport loss delayed the `v2.1.5` release gates documented in
`RELEASE_READINESS_V2.1.5.md`. After recovery, focused Vitest coverage,
TypeScript checking, graph-linked `LocalBackend` tests, full unit/integration
suites, lint, builds, and `npm publish --dry-run` completed. Root formatting
also passes after the full release scope was selected and formatted.

The code defect that originally motivated the release (`gn_ensure_fresh`
analysis-job submission failing with `EISDIR`) is fixed in current source and
has passing regression coverage. The release remains blocked only because the
broad worktree has not been reviewed and reduced to a bounded staged release
diff.
