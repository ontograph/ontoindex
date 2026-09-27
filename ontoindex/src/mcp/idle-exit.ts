/**
 * Opt-in idle exit for the stdio MCP server (ONTOINDEX_MCP_IDLE_EXIT_MS).
 *
 * LadybugDB keeps its buffer pool and allocator pages resident after the
 * Database closes, so a server that served one query holds hundreds of MB
 * until it exits. With this set, the server exits after the configured time
 * without a tool request and with no open repository pool; the MCP client
 * starts a fresh server on its next call. Only enable it for clients that
 * restart exited stdio servers. Ontocode (ontocode-mcp connection_manager.rs,
 * checked 2026-09-27) does not: an exited server's tools stay unavailable
 * until the session restarts, so leave this unset there.
 */

export const IDLE_EXIT_ENV = 'ONTOINDEX_MCP_IDLE_EXIT_MS';
/** Values below one minute would exit between the calls of a normal turn. */
export const MIN_IDLE_EXIT_MS = 60_000;

export function readIdleExitMs(env: NodeJS.ProcessEnv = process.env): number | null {
  const raw = env[IDLE_EXIT_ENV]?.trim();
  if (!raw) return null;
  const ms = Number.parseInt(raw, 10);
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return Math.max(ms, MIN_IDLE_EXIT_MS);
}

export interface IdleExitProbe {
  /** Epoch ms of the last tool request or pool query. */
  lastActivity(): number;
  /** Tool requests currently running. */
  inFlight(): number;
  /** Repositories with an open LadybugDB pool. */
  openPools(): number;
}

/** True when the server has been idle long enough and holds no work or pools. */
export function shouldExitForIdle(probe: IdleExitProbe, idleMs: number, now: number): boolean {
  return probe.inFlight() === 0 && probe.openPools() === 0 && now - probe.lastActivity() >= idleMs;
}

/**
 * Check every `min(idleMs / 4, 30 s)` and call `exit` once the server is idle.
 * The timer is unref'd, so it never keeps the process alive by itself.
 */
export function startIdleExitTimer(
  probe: IdleExitProbe,
  idleMs: number,
  exit: () => void,
  now: () => number = Date.now,
): () => void {
  const timer = setInterval(
    () => {
      if (shouldExitForIdle(probe, idleMs, now())) {
        clearInterval(timer);
        exit();
      }
    },
    Math.min(Math.floor(idleMs / 4), 30_000),
  );
  timer.unref();
  return () => clearInterval(timer);
}
