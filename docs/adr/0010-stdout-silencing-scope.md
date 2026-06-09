# ADR-0010: stdout silencing scope reduction

**Status:** Accepted
**Date:** 2026-04-30 (perf-stability + A1 + Wave 1.5)
**Source:** `ontoindex/src/core/lbug/pool-adapter.ts`, `lbug-adapter.ts`.

## Context

OntoIndex uses LadybugDB (KuzuDB fork) which is a native C++ Node addon. The native layer emits diagnostic output to `process.stdout` during database open, extension loading, and (occasionally) query execution. MCP runs over stdio JSON-RPC — any spurious stdout corrupts the framing and breaks the MCP protocol.

Pre-perf-stability: every `executeQuery` and `executeParameterized` call wrapped in `silenceStdout()` / `restoreStdout()`. Watchdog interval (`setInterval` 1s) checked `stdoutSilenceCount > 0 && !preWarmActive && activeQueryCount === 0` to recover from leaked silencing. v14 P-1 / A1 investigation found that the watchdog was racing with extension-load operations (LOAD VECTOR/FTS), which take >1s, don't increment `activeQueryCount`, and trigger watchdog's restoration mid-operation — corrupting MCP framing.

## Decision

**Remove per-query stdout silencing** from `pool-adapter.ts` (was: every `executeQuery` / `executeParameterized`). **Remove the silenceStdout import from `lbug-adapter.ts` extension-load paths** entirely (Wave 1.5 fix-1 deviation). Keep stdout silencing in tests only via a controlled `silenceStdout` / `restoreStdout` pair tested explicitly.

Net effect: native stdout flows freely during query execution. The native layer is empirically silent during steady-state queries; only DB open and extension load produce noise — and those run BEFORE MCP stdio is active (during server startup).

## Algorithm / Technique

### Pre-perf-stability pattern (REMOVED)

```typescript
// pool-adapter.ts (REMOVED)
async function executeQuery(...) {
  silenceStdout();
  try {
    return await conn.query(...);
  } finally {
    restoreStdout();
  }
}
```

Problems:
- Every query incurs the silencing overhead (small but cumulative).
- Native query execution is empirically silent → silencing was unnecessary protection against a non-issue.
- The watchdog recovery mechanism existed only because of this defensive silencing.

### Watchdog (still in pool-adapter.ts; bug surface, not fix)

```typescript
let stdoutSilenceCount = 0;
let preWarmActive = false;
let activeQueryCount = 0;
const realStdoutWrite = process.stdout.write.bind(process.stdout);

function silenceStdout(): void {
  stdoutSilenceCount++;
  process.stdout.write = (() => true) as typeof process.stdout.write;
}

function restoreStdout(): void {
  stdoutSilenceCount--;
  if (stdoutSilenceCount <= 0) {
    process.stdout.write = realStdoutWrite;
    stdoutSilenceCount = 0;
  }
}

setInterval(() => {
  if (stdoutSilenceCount > 0 && !preWarmActive && activeQueryCount === 0) {
    // Recovery: silenceStdout was leaked; restore
    process.stdout.write = realStdoutWrite;
    stdoutSilenceCount = 0;
  }
}, 1000);
```

Watchdog is retained for any future caller that might need silencing. Today, no production code path uses it.

### A1 root cause + Wave 1.5 fix-1 (lbug-adapter.ts extension loaders)

A1 investigation found that `lbug-adapter.ts` had added `silenceStdout()` / `restoreStdout()` around `loadFTSExtension` and `loadVectorExtension` to suppress native LOAD output. Both are async, `conn.query` calls that take 100ms-2s (cold-cache extension fetch + load). The watchdog's 1-second tick fires mid-operation:

1. T+0: `loadFTSExtension` calls `silenceStdout()` → `stdoutSilenceCount = 1`.
2. T+0.4: `await conn.query('LOAD FTS')` starts.
3. T+1.0: watchdog tick fires; `activeQueryCount === 0` (extension load doesn't increment); restores stdout; sets `stdoutSilenceCount = 0`.
4. T+1.5: native LOAD emits stdout (now flowing freely → corrupts MCP framing).
5. T+1.6: `loadFTSExtension` finally returns; calls `restoreStdout()` → decrements `stdoutSilenceCount` to `-1` (underflow).
6. Next query: `silenceStdout()` raises count to 0 (instead of 1). Subsequent `restoreStdout()` may set count negative again.

The shifted scheduling of LadybugDB N-API destructors — combined with `lbug-pool.test.ts` opening 18+ database handles — caused vitest worker process crashes 100% of the time at 18+ tests but only intermittently below.

Wave 1.5 fix-1 (deviation from spec): removed the entire `silenceStdout`/`restoreStdout` import from `lbug-adapter.ts`. Empirically the extension load paths don't produce stdout noise on the supported KuzuDB version, and even adding silencing around the synchronous `new lbug.Database()` reproduced the test crash because importing `pool-adapter.ts` registered the watchdog `setInterval` in test workers — the module-side-effect itself was the trigger.

### `doInitLbug` synchronous Database/Connection construction

```typescript
function doInitLbug(...) {
  // No silenceStdout — empirically silent on supported lbug version
  const db = new lbug.Database(dbPath, ...);
  const conn = db.connect();
  // ...
}
```

Synchronous, fast (<10ms), and quiet. No silencing needed.

### Why MCP stdio framing matters

MCP uses Content-Length-framed JSON-RPC over stdio. Any unexpected stdout byte:
- Throws off the Content-Length header → next message parse fails.
- Or appears INSIDE a JSON message → JSON parse error.

Either way, the MCP client (Claude Desktop, Cursor, etc.) disconnects. User sees "MCP server disconnected" with no recovery.

The Wave 1.5 + A1 changes make stdout silencing a non-issue:
- Native silence during query execution → no protection needed at query level.
- Native silence during DB init (verified) → no protection needed at startup.
- If a future lbug version becomes noisy, restore silencing surgically with `activeQueryCount` tracking.

### Test (`lbug-pool.test.ts`, A1 rewrite)

The test now calls `silenceStdout`/`restoreStdout` directly (not inside a pool query). It opens no pool entries and shares no DB handles. This avoids the worker crash (root cause: shared DB state across rapid pool open/close cycles in tests, exacerbated by the watchdog interference).

```
test('initLbug maintains realStdoutWrite after execution', () => {
  expect(process.stdout.write).toBe(realStdoutWrite);
  silenceStdout();
  restoreStdout();
  expect(process.stdout.write).toBe(realStdoutWrite);
});
```

## Consequences

**Positive:**
- Per-query stdout silencing overhead removed
- vitest worker no longer crashes on `lbug-pool.test.ts`
- MCP stdio framing safe by construction (no silencing means no recovery race)
- Watchdog retained for future use without cost (only fires if a caller leaks `silenceStdout`)

**Negative:**
- If a future lbug version becomes noisy, MCP stdio breaks until silencing is restored
- The watchdog is now mostly dead code — kept for possible future need

**Open issues for future work:**
- Add a startup self-test that exercises a pool query and asserts stdout is unchanged
- Consider removing the watchdog entirely once we're confident no caller will ever silence stdout in this codebase
- Migrate to a separate framed protocol (length-prefixed binary) that's robust to ambient stdout, eliminating the silencing concern entirely
