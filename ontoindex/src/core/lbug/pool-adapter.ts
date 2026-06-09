/**
 * LadybugDB connection pool (core). Used by MCP, sync, search, wiki, etc.
 *
 * LadybugDB Adapter (Connection Pool)
 *
 * Manages a pool of LadybugDB databases keyed by repoId, each with
 * multiple Connection objects for safe concurrent query execution.
 *
 * LadybugDB Connections are NOT thread-safe — a single Connection
 * segfaults if concurrent .query() calls hit it simultaneously.
 * This adapter provides a checkout/return connection pool so each
 * concurrent query gets its own Connection from the same Database.
 *
 * @see https://docs.ladybugdb.com/concurrency — multiple Connections
 * from the same Database is the officially supported concurrency pattern.
 */

import fs from 'fs/promises';
import lbug, { type LbugValue } from '@ladybugdb/core';

export type LbugQueryRow = {
  readonly [field: string]: unknown;
  readonly [index: number]: unknown;
  readonly id?: string;
  readonly name?: string;
  readonly kind?: string;
  readonly type?: string;
  readonly filePath?: string;
  readonly path?: string;
  readonly nodeId?: string;
  readonly label?: string;
  readonly sourceId?: string;
  readonly sourceName?: string;
  readonly sourceFilePath?: string;
  readonly sourceCommunity?: string;
  readonly sourceCommunityId?: string;
  readonly sourceSymbolId?: string;
  readonly targetId?: string;
  readonly targetName?: string;
  readonly targetFilePath?: string;
  readonly targetCommunity?: string;
  readonly targetCommunityId?: string;
  readonly targetSymbolId?: string;
  readonly fromFile?: string;
  readonly fromName?: string;
  readonly toFile?: string;
  readonly toName?: string;
  readonly community?: string;
  readonly communityId?: string;
  readonly heuristicLabel?: string;
  readonly startLine?: number;
  readonly endLine?: number;
  readonly step?: number;
  readonly symbolCount?: number;
  readonly confidence?: number;
  readonly coupling?: number;
  readonly cohesion?: number;
  readonly edgeType?: string;
  readonly hits?: number;
  readonly stepCount?: number;
  readonly callerCount?: number;
};
export type LbugQueryResult<TRow extends object = LbugQueryRow> = TRow[];
export type LbugRow = LbugQueryRow;
export type LbugQueryParams = Readonly<Record<string, unknown>>;

type RecoveryDatabaseConstructor = new (
  databasePath?: string,
  bufferManagerSize?: number,
  enableCompression?: boolean,
  readOnly?: boolean,
  maxDBSize?: number,
  autoCheckpoint?: boolean,
  checkpointThreshold?: number,
  throwOnWalReplayFailure?: boolean,
) => lbug.Database;

/** Per-repo pool: one Database, many Connections */
interface PoolWaiter {
  resolve: (conn: lbug.Connection) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface PoolEntry {
  db: lbug.Database;
  /** Available connections ready for checkout */
  available: lbug.Connection[];
  /** Number of connections currently checked out */
  checkedOut: number;
  /** Queued waiters for when all connections are busy */
  waiters: PoolWaiter[];
  lastUsed: number;
  dbPath: string;
  /** Set to true when the pool entry is closed — checkin will close orphaned connections */
  closed: boolean;
  /** Set while explicit close waits for active checkouts to finish */
  closing: boolean;
}

const pool = new Map<string, PoolEntry>();

/**
 * Listeners notified when a pool entry is torn down (LRU eviction, idle
 * timeout, explicit close). Used by upper layers (e.g. the BM25 search
 * module) to invalidate per-repo caches that must not outlive the pool
 * entry that produced them.
 *
 * Listeners run synchronously inside `closeOne` after the pool entry has
 * been removed; throwing listeners are isolated so one bad listener does
 * not prevent others from firing or break teardown.
 */
type PoolCloseListener = (repoId: string) => void;
const poolCloseListeners = new Set<PoolCloseListener>();

/**
 * Subscribe to pool-close events. Returns a disposer that removes the
 * listener (handy for tests).
 */
export function addPoolCloseListener(listener: PoolCloseListener): () => void {
  poolCloseListeners.add(listener);
  return () => {
    poolCloseListeners.delete(listener);
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Object.prototype.toString.call(value) === '[object Object]';
}

function isLbugValue(value: unknown): value is LbugValue {
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'number' ||
    typeof value === 'bigint' ||
    typeof value === 'string' ||
    value instanceof Date
  ) {
    return true;
  }

  if (Array.isArray(value)) {
    return value.every(isLbugValue);
  }

  if (!isPlainObject(value)) return false;

  for (const child of Object.values(value)) {
    if (!isLbugValue(child)) return false;
  }
  return true;
}

function toLbugParams(params: LbugQueryParams): Record<string, LbugValue> {
  const out: Record<string, LbugValue> = {};
  for (const [key, value] of Object.entries(params)) {
    if (!isLbugValue(value)) {
      throw new TypeError(`Invalid LadybugDB query parameter "${key}"`);
    }
    out[key] = value;
  }
  return out;
}

/**
 * Shared Database cache keyed by resolved dbPath.
 * Multiple repoIds pointing to the same path share one native Database
 * object to avoid exhausting the buffer manager's mmap budget.
 */
interface SharedDB {
  db: lbug.Database;
  refCount: number;
  ftsLoaded: boolean;
  vectorLoaded: boolean;
  /** When true, closeOne skips db.close() — the Database is owned externally. */
  external?: boolean;
}
const dbCache = new Map<string, SharedDB>();

/** Max repos in the pool (LRU eviction) */
const MAX_POOL_SIZE = 5;
/** Idle timeout before closing a repo's connections */
const IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
/** Max connections per repo (caps concurrent queries per repo) */
const MAX_CONNS_PER_REPO = readBoundedIntEnv('ONTOINDEX_LBUG_POOL_SIZE', 2, 1, 16);

let idleTimer: ReturnType<typeof setInterval> | null = null;

type PreparedStmt = Awaited<ReturnType<lbug.Connection['prepare']>>;
/** Per-connection prepared-statement cache. Keyed by Cypher text; invalidated on execute error. */
const connStmtCaches = new WeakMap<lbug.Connection, Map<string, PreparedStmt>>();
const MAX_PREPARED_STMTS_PER_CONN = readBoundedIntEnv(
  'ONTOINDEX_LBUG_PREPARED_CACHE_SIZE',
  256,
  0,
  2048,
);
const MAX_PREPARED_STMT_CHARS = readBoundedIntEnv(
  'ONTOINDEX_LBUG_PREPARED_CACHE_MAX_CHARS',
  16_384,
  1024,
  1_000_000,
);

/** Saved real stdout/stderr write — used to silence native module output without race conditions */
export const realStdoutWrite = process.stdout.write.bind(process.stdout);
export const realStderrWrite = process.stderr.write.bind(process.stderr);
// WARNING: this counter gates process.stdout.write for the entire Node.js process, not just
// the calling async context. Any concurrent output from unrelated modules (loggers, debug
// probes, etc.) will be silently dropped while the count is non-zero. Acceptable here because
// the MCP server must keep stdout clean for JSON-RPC framing, and LadybugDB's native extension
// loader is the only source of stray output we cannot otherwise suppress.
let stdoutSilenceCount = 0;
/** True while pre-warming connections — prevents watchdog from prematurely restoring stdout */
let preWarmActive = false;

/**
 * Start the idle cleanup timer (runs every 60s)
 */
function ensureIdleTimer(): void {
  if (idleTimer) return;
  idleTimer = setInterval(() => {
    const now = Date.now();
    for (const [repoId, entry] of pool) {
      if (now - entry.lastUsed > IDLE_TIMEOUT_MS && entry.checkedOut === 0) {
        closeOne(repoId);
      }
    }
  }, 60_000);
  if (idleTimer && typeof idleTimer === 'object' && 'unref' in idleTimer) {
    (idleTimer as NodeJS.Timeout).unref();
  }
}

/**
 * Touch a repo to reset its idle timeout.
 * Call this during long-running operations to prevent the connection from being closed.
 */
export const touchRepo = (repoId: string): void => {
  const entry = pool.get(repoId);
  if (entry) {
    entry.lastUsed = Date.now();
  }
};

/**
 * Evict the least-recently-used repo if pool is at capacity
 */
function evictLRU(): void {
  if (pool.size < MAX_POOL_SIZE) return;

  let oldestId: string | null = null;
  let oldestTime = Infinity;
  for (const [id, entry] of pool) {
    if (entry.checkedOut === 0 && entry.lastUsed < oldestTime) {
      oldestTime = entry.lastUsed;
      oldestId = id;
    }
  }
  if (oldestId) {
    closeOne(oldestId);
  }
}

/**
 * Remove a repo from the pool, close its connections, and release its
 * shared Database ref.  Only closes the Database when no other repoIds
 * reference it (refCount === 0).
 */
function closeOne(repoId: string): void {
  const entry = pool.get(repoId);
  if (!entry) return;

  entry.closed = true;
  entry.closing = true;

  for (const waiter of entry.waiters.splice(0)) {
    clearTimeout(waiter.timer);
    waiter.reject(new Error(`LadybugDB pool closed for repo "${repoId}"`));
  }

  // Close available connections — fire-and-forget with .catch() to prevent
  // unhandled rejections.  Native close() returns Promise<void> but can crash
  // the N-API destructor on macOS/Windows; deferring to process exit lets
  // dangerouslyIgnoreUnhandledErrors absorb the crash.
  for (const conn of entry.available) {
    conn.close().catch(() => {});
  }
  entry.available.length = 0;

  // Checked-out connections can't be closed here — they're in-flight.
  // The checkin() function detects entry.closed and closes them on return.

  // Only close the Database when no other repoIds reference it.
  // External databases (injected via initLbugWithDb) are never closed here;
  // the core adapter owns their lifecycle. Once no pool entries reference one,
  // remove it from this cache so injected DB objects do not stay pinned.
  const shared = dbCache.get(entry.dbPath);
  if (shared) {
    shared.refCount--;
    if (shared.refCount === 0) {
      if (shared.external) {
        dbCache.delete(entry.dbPath);
      } else {
        shared.db.close().catch(() => {});
        dbCache.delete(entry.dbPath);
      }
    }
  }

  pool.delete(repoId);

  // Notify listeners AFTER the pool entry is gone so any cache-invalidation
  // they perform is consistent with `isLbugReady(repoId) === false`.
  for (const listener of poolCloseListeners) {
    try {
      listener(repoId);
    } catch {
      // Isolate listener failures — teardown must complete.
    }
  }
}

function releaseSharedDbAfterFailedInit(dbPath: string, shared: SharedDB): void {
  shared.refCount = Math.max(0, shared.refCount - 1);
  if (shared.refCount > 0) return;

  if (shared.external) {
    dbCache.delete(dbPath);
    return;
  }

  shared.db.close().catch(() => {});
  dbCache.delete(dbPath);
}

function closePrewarmedConnections(connections: lbug.Connection[]): void {
  for (const conn of connections) {
    conn.close().catch(() => {});
  }
  connections.length = 0;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForCheckedOutConnections(repoId: string, entry: PoolEntry): Promise<void> {
  const started = Date.now();
  while (entry.checkedOut > 0) {
    if (Date.now() - started >= CLOSE_WAIT_TIMEOUT_MS) {
      throw new Error(
        `Timed out waiting for ${entry.checkedOut} active LadybugDB quer${entry.checkedOut === 1 ? 'y' : 'ies'} to finish for repo "${repoId}"`,
      );
    }
    await sleep(CLOSE_WAIT_POLL_MS);
  }
}

async function closeOneWhenIdle(repoId: string): Promise<void> {
  const entry = pool.get(repoId);
  if (!entry) return;
  entry.closing = true;
  for (const waiter of entry.waiters.splice(0)) {
    clearTimeout(waiter.timer);
    waiter.reject(new Error(`LadybugDB pool is closing for repo "${repoId}"`));
  }
  try {
    await waitForCheckedOutConnections(repoId, entry);
    closeOne(repoId);
  } catch (err) {
    const current = pool.get(repoId);
    if (current === entry && !entry.closed) {
      entry.closing = false;
    }
    throw err;
  }
}

/**
 * Create a new Connection from a repo's Database.
 * Silences stdout to prevent native module output from corrupting MCP stdio.
 */
let activeQueryCount = 0;

/**
 * Silence stdout by replacing process.stdout.write with a no-op.
 * Uses a reference counter so nested silence/restore pairs are safe.
 * Exported so other modules (e.g. embedder) use the same mechanism instead
 * of independently patching stdout, which causes restore-order conflicts.
 */
export function silenceStdout(): void {
  if (stdoutSilenceCount++ === 0) {
    process.stdout.write = ((...args: Parameters<typeof process.stdout.write>) => {
      const maybeCallback = args[args.length - 1];
      if (typeof maybeCallback === 'function') {
        maybeCallback();
      }
      return true;
    }) as typeof process.stdout.write;
  }
}

export function restoreStdout(): void {
  if (--stdoutSilenceCount <= 0) {
    stdoutSilenceCount = 0;
    process.stdout.write = realStdoutWrite;
  }
}

// Safety watchdog: restore stdout if it gets stuck silenced (e.g. native crash
// inside createConnection before restoreStdout runs).
// Exempts active queries and pre-warm — these legitimately hold silence for
// longer than 1 second (queries can take up to QUERY_TIMEOUT_MS = 30s).
setInterval(() => {
  if (stdoutSilenceCount > 0 && !preWarmActive && activeQueryCount === 0) {
    stdoutSilenceCount = 0;
    process.stdout.write = realStdoutWrite;
  }
}, 1000).unref();

function createConnection(db: lbug.Database): lbug.Connection {
  silenceStdout();
  try {
    return new lbug.Connection(db);
  } finally {
    restoreStdout();
  }
}

/**
 * Load FTS and VECTOR extensions on a connection with stdout silenced.
 *
 * Native LadybugDB extension loads can write to stdout, which would corrupt
 * MCP JSON-RPC framing. activeQueryCount is bumped so the 1s watchdog
 * timer doesn't prematurely restore stdout while loads are in flight.
 */
async function loadExtensionsSilenced(conn: lbug.Connection, shared: SharedDB): Promise<void> {
  silenceStdout();
  activeQueryCount++;
  try {
    if (!shared.ftsLoaded) {
      try {
        await withTimeout(conn.query('LOAD EXTENSION fts'), QUERY_TIMEOUT_MS, 'LOAD EXTENSION fts');
        shared.ftsLoaded = true;
      } catch (err) {
        if (err instanceof QueryTimeoutError) throw err;
        // FTS extension may not be installed — FTS queries will fail gracefully
      }
    }
    if (!shared.vectorLoaded) {
      try {
        await withTimeout(conn.query('INSTALL VECTOR'), QUERY_TIMEOUT_MS, 'INSTALL VECTOR');
        await withTimeout(
          conn.query('LOAD EXTENSION VECTOR'),
          QUERY_TIMEOUT_MS,
          'LOAD EXTENSION VECTOR',
        );
        shared.vectorLoaded = true;
      } catch (err) {
        if (err instanceof QueryTimeoutError) throw err;
        // VECTOR extension may not be available
      }
    }
  } finally {
    activeQueryCount--;
    restoreStdout();
  }
}

/** Query timeout in milliseconds */
const QUERY_TIMEOUT_MS = 30_000;
/** Waiter queue timeout in milliseconds */
const WAITER_TIMEOUT_MS = 15_000;
/** Explicit close waits for active checked-out connections up to this long. */
const CLOSE_WAIT_TIMEOUT_MS = 10_000;
const CLOSE_WAIT_POLL_MS = 50;
const MAX_RESULT_ROWS = 50_000;

const LOCK_RETRY_ATTEMPTS = 3;
const LOCK_RETRY_DELAY_MS = 2000;

/** Deduplicates concurrent initLbug calls for the same repoId */
const initPromises = new Map<string, Promise<void>>();

function readBoundedIntEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

/**
 * Initialize (or reuse) a Database + connection pool for a specific repo.
 * Retries on lock errors (e.g., when `ontoindex analyze` is running).
 *
 * Concurrent calls for the same repoId are deduplicated — the second caller
 * awaits the first's in-progress init rather than starting a redundant one.
 */
export const initLbug = async (repoId: string, dbPath: string): Promise<void> => {
  const existing = pool.get(repoId);
  if (existing) {
    existing.lastUsed = Date.now();
    return;
  }

  // Deduplicate concurrent init calls for the same repoId —
  // prevents double-init race when multiple parallel tool calls
  // trigger initialization for the same repo simultaneously.
  const pending = initPromises.get(repoId);
  if (pending) return pending;

  const promise = doInitLbug(repoId, dbPath);
  initPromises.set(repoId, promise);
  try {
    await promise;
  } finally {
    initPromises.delete(repoId);
  }
};

/**
 * Internal init — creates DB, pre-warms connections, loads FTS, then registers pool.
 * Pool entry is registered LAST so concurrent executeQuery calls see either
 * "not initialized" (and throw) or a fully ready pool — never a half-built one.
 */
async function doInitLbug(repoId: string, dbPath: string): Promise<void> {
  // Check if database exists
  try {
    await fs.stat(dbPath);
  } catch {
    throw new Error(`LadybugDB not found at ${dbPath}. Run: ontoindex analyze`);
  }

  evictLRU();

  // Reuse an existing native Database if another repoId already opened this path.
  // This prevents buffer manager exhaustion from multiple mmap regions on the same file.
  let shared = dbCache.get(dbPath);
  if (!shared) {
    // Open in read-only mode — MCP server never writes to the database.
    // This allows multiple MCP server instances to read concurrently, and
    // avoids lock conflicts when `ontoindex analyze` is writing.
    let lastError: Error | null = null;
    let isLockError = false;
    for (let attempt = 1; attempt <= LOCK_RETRY_ATTEMPTS; attempt++) {
      silenceStdout();
      try {
        const db = new lbug.Database(
          dbPath,
          0, // bufferManagerSize (default)
          false, // enableCompression (default)
          true, // readOnly
        );
        restoreStdout();
        shared = { db, refCount: 0, ftsLoaded: false, vectorLoaded: false };
        dbCache.set(dbPath, shared);
        break;
      } catch (err: unknown) {
        restoreStdout();
        lastError = err instanceof Error ? err : new Error(String(err));
        isLockError =
          lastError.message.includes('Could not set lock') || lastError.message.includes('lock');
        if (!isLockError || attempt === LOCK_RETRY_ATTEMPTS) break;
        await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_DELAY_MS * attempt));
      }
    }

    // WAL recovery: if the open failed with a non-lock error, attempt to re-open
    // with throwOnWalReplayFailure=false so LadybugDB silently discards the corrupt
    // WAL tail and replays up to the last valid checkpoint.  This recovers from
    // process-kill-mid-write scenarios without losing data past the last checkpoint.
    //
    // We only attempt recovery when:
    //   - The DB file exists (so it's not a "DB not found" case)
    //   - The error was not a file-lock error (lock errors are handled by the retry loop above)
    //
    // LadybugDB Database constructor arg positions:
    //   (path, bufferManagerSize, enableCompression, readOnly, maxDBSize,
    //    autoCheckpoint, checkpointThreshold, throwOnWalReplayFailure, enableChecksums)
    if (!shared && lastError !== null && !isLockError) {
      silenceStdout();
      try {
        const RecoveryDatabase = lbug.Database as unknown as RecoveryDatabaseConstructor;
        const db = new RecoveryDatabase(
          dbPath,
          0, // bufferManagerSize
          false, // enableCompression
          true, // readOnly
          0, // maxDBSize
          true, // autoCheckpoint
          -1, // checkpointThreshold
          false, // throwOnWalReplayFailure — discard corrupt WAL tail instead of throwing
        );
        restoreStdout();
        // WAL was corrupt — warn on stderr (process.stderr.write avoids corrupting MCP stdout).
        process.stderr.write(
          '[ontoindex] WARNING: WAL corruption detected on open; discarding corrupt WAL tail. ' +
            'Data since last checkpoint may be lost. Re-run `ontoindex analyze` if index appears incomplete.\n',
        );
        shared = { db, refCount: 0, ftsLoaded: false, vectorLoaded: false };
        dbCache.set(dbPath, shared);
      } catch {
        restoreStdout();
        // Recovery also failed — the database is unrecoverable.
        throw new Error(
          'OntoIndex index unrecoverable due to WAL corruption. ' +
            'Run `ontoindex clean --force && ontoindex analyze` to rebuild.',
        );
      }
    }

    if (!shared) {
      throw new Error(
        `LadybugDB unavailable for ${repoId}. Another process may be rebuilding the index. ` +
          `Retry later. (${lastError?.message || 'unknown error'})`,
      );
    }
  }

  shared.refCount++;
  const db = shared.db;

  // Pre-create the full pool upfront so createConnection() (which silences
  // stdout) is never called lazily during active query execution.
  // Mark preWarmActive so the watchdog timer doesn't interfere.
  const available: lbug.Connection[] = [];
  try {
    preWarmActive = true;
    try {
      for (let i = 0; i < MAX_CONNS_PER_REPO; i++) {
        available.push(createConnection(db));
      }
    } finally {
      preWarmActive = false;
    }

    // Load FTS and VECTOR extensions once per shared Database.
    // Done BEFORE pool registration so no concurrent checkout can grab
    // the connection while the async load is in progress.
    await loadExtensionsSilenced(available[0], shared);
  } catch (err) {
    closePrewarmedConnections(available);
    releaseSharedDbAfterFailedInit(dbPath, shared);
    throw err;
  }

  // Register pool entry only after all connections are pre-warmed and FTS is
  // loaded.  Concurrent executeQuery calls see either "not initialized"
  // (and throw cleanly) or a fully ready pool — never a half-built one.
  pool.set(repoId, {
    db,
    available,
    checkedOut: 0,
    waiters: [],
    lastUsed: Date.now(),
    dbPath,
    closed: false,
    closing: false,
  });
  ensureIdleTimer();
}

/**
 * Initialize a pool entry from a pre-existing Database object.
 *
 * Used in tests to avoid the writable→close→read-only cycle that crashes
 * on macOS due to N-API destructor segfaults.  The pool adapter reuses
 * the core adapter's writable Database instead of opening a new read-only one.
 *
 * The Database is registered in the shared dbCache so closeOne() decrements
 * the refCount correctly.  If the Database is already cached (e.g. another
 * repoId already injected it), the existing entry is reused.
 */
export async function initLbugWithDb(
  repoId: string,
  existingDb: lbug.Database,
  dbPath: string,
): Promise<void> {
  const existing = pool.get(repoId);
  if (existing) {
    existing.lastUsed = Date.now();
    return;
  }

  // Register in dbCache with external: true so other initLbug() calls
  // for the same dbPath reuse this Database instead of trying to open
  // a new one (which would fail with a file lock error).
  // closeOne() respects the external flag and skips db.close().
  let shared = dbCache.get(dbPath);
  if (!shared) {
    shared = { db: existingDb, refCount: 0, ftsLoaded: false, vectorLoaded: false, external: true };
    dbCache.set(dbPath, shared);
  }
  shared.refCount++;

  const available: lbug.Connection[] = [];
  try {
    preWarmActive = true;
    try {
      for (let i = 0; i < MAX_CONNS_PER_REPO; i++) {
        available.push(createConnection(existingDb));
      }
    } finally {
      preWarmActive = false;
    }

    // Load FTS and VECTOR extensions if not already loaded on this Database.
    await loadExtensionsSilenced(available[0], shared);
  } catch (err) {
    closePrewarmedConnections(available);
    releaseSharedDbAfterFailedInit(dbPath, shared);
    throw err;
  }

  pool.set(repoId, {
    db: existingDb,
    available,
    checkedOut: 0,
    waiters: [],
    lastUsed: Date.now(),
    dbPath,
    closed: false,
    closing: false,
  });
  ensureIdleTimer();
}

/**
 * Checkout a connection from the pool.
 * Returns an available connection, or creates a new one if under the cap.
 * If all connections are busy and at cap, queues the caller until one is returned.
 */
function checkout(entry: PoolEntry): Promise<lbug.Connection> {
  if (entry.closed || entry.closing) {
    return Promise.reject(new Error('LadybugDB pool is closing for this repository'));
  }

  // Fast path: grab an available connection
  if (entry.available.length > 0) {
    entry.checkedOut++;
    return Promise.resolve(entry.available.pop()!);
  }

  // Pool was pre-warmed to MAX_CONNS_PER_REPO during init.  If we're here
  // with fewer total connections, something leaked — surface the bug rather
  // than silently creating a connection (which would silence stdout mid-query).
  const totalConns = entry.available.length + entry.checkedOut;
  if (totalConns < MAX_CONNS_PER_REPO) {
    throw new Error(
      `Connection pool integrity error: expected ${MAX_CONNS_PER_REPO} ` +
        `connections but found ${totalConns} (${entry.available.length} available, ` +
        `${entry.checkedOut} checked out)`,
    );
  }

  // At capacity — queue the caller with a timeout.
  return new Promise<lbug.Connection>((resolve, reject) => {
    const timer = setTimeout(() => {
      const idx = entry.waiters.indexOf(waiter);
      if (idx !== -1) entry.waiters.splice(idx, 1);
      reject(
        new Error(
          `Connection pool exhausted: timed out after ${WAITER_TIMEOUT_MS}ms waiting for a free connection`,
        ),
      );
    }, WAITER_TIMEOUT_MS);
    const waiter: PoolWaiter = { resolve, reject, timer };
    entry.waiters.push(waiter);
  });
}

/**
 * Return a connection to the pool after use.
 * If the pool entry was closed while the connection was checked out (e.g.
 * LRU eviction), close the orphaned connection instead of returning it.
 * If there are queued waiters, hand the connection directly to the next one
 * instead of putting it back in the available array (avoids race conditions).
 */
function checkin(entry: PoolEntry, conn: lbug.Connection): void {
  if (entry.closed || entry.closing) {
    entry.checkedOut = Math.max(0, entry.checkedOut - 1);
    // Pool entry was deleted during checkout — close the orphaned connection
    conn.close().catch(() => {});
    return;
  }
  if (entry.waiters.length > 0) {
    // Hand directly to the next waiter — no intermediate available state
    const waiter = entry.waiters.shift()!;
    clearTimeout(waiter.timer);
    waiter.resolve(conn);
  } else {
    entry.checkedOut--;
    entry.available.push(conn);
  }
}

function retireConnection(entry: PoolEntry, conn: lbug.Connection): void {
  connStmtCaches.delete(conn);
  entry.checkedOut = Math.max(0, entry.checkedOut - 1);
  conn.close().catch(() => {});

  if (entry.closed || entry.closing) return;

  while (entry.waiters.length > 0) {
    const totalConns = entry.available.length + entry.checkedOut;
    if (entry.available.length > 0) {
      const waiter = entry.waiters.shift()!;
      clearTimeout(waiter.timer);
      entry.checkedOut++;
      waiter.resolve(entry.available.pop()!);
      continue;
    }
    if (totalConns >= MAX_CONNS_PER_REPO) break;

    const waiter = entry.waiters.shift()!;
    clearTimeout(waiter.timer);
    try {
      entry.checkedOut++;
      waiter.resolve(createConnection(entry.db));
    } catch (err: unknown) {
      entry.checkedOut = Math.max(0, entry.checkedOut - 1);
      waiter.reject(err instanceof Error ? err : new Error(String(err)));
    }
  }
}

/**
 * Execute a query on a specific repo's connection pool.
 * Automatically checks out a connection, runs the query, and returns it.
 */
/** Race a promise against a timeout */
class QueryTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QueryTimeoutError';
  }
}

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
  onTimeout?: () => void,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  let timedOut = false;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      onTimeout?.();
      reject(new QueryTimeoutError(`${label} timed out after ${ms}ms`));
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (!timedOut) clearTimeout(timer);
  });
}

async function getAllWithTimeout(
  result: lbug.QueryResult,
  label: string,
  onTimeout?: (pending: Promise<LbugQueryResult>) => void,
): Promise<LbugQueryResult> {
  const pending = result.getAll();
  const rows = await withTimeout(pending, QUERY_TIMEOUT_MS, `${label} getAll`, () =>
    onTimeout?.(pending as Promise<LbugQueryResult>),
  );
  if (rows.length >= MAX_RESULT_ROWS) {
    throw new Error(
      `${label} returned ${rows.length} rows, exceeding the ${MAX_RESULT_ROWS} row safety limit`,
    );
  }
  return rows as LbugQueryResult;
}

function retireWhenSettled(
  entry: PoolEntry,
  conn: lbug.Connection,
  pending: Promise<unknown> | null,
): void {
  if (!pending) {
    retireConnection(entry, conn);
    return;
  }
  void pending
    .catch(() => {})
    .finally(() => {
      retireConnection(entry, conn);
    });
}

function shouldCachePreparedStatement(cypher: string): boolean {
  return MAX_PREPARED_STMTS_PER_CONN > 0 && cypher.length <= MAX_PREPARED_STMT_CHARS;
}

function getPreparedStatement(
  stmtMap: Map<string, PreparedStmt>,
  cypher: string,
): PreparedStmt | undefined {
  const stmt = stmtMap.get(cypher);
  if (!stmt) return undefined;
  // Refresh insertion order so the oldest Map entry is the least recently used.
  stmtMap.delete(cypher);
  stmtMap.set(cypher, stmt);
  return stmt;
}

function cachePreparedStatement(
  stmtMap: Map<string, PreparedStmt>,
  cypher: string,
  stmt: PreparedStmt,
): void {
  if (!shouldCachePreparedStatement(cypher)) return;
  while (stmtMap.size >= MAX_PREPARED_STMTS_PER_CONN) {
    const oldest = stmtMap.keys().next().value;
    if (oldest === undefined) break;
    stmtMap.delete(oldest);
  }
  stmtMap.set(cypher, stmt);
}

export const executeQuery = async <TRow extends object = LbugQueryRow>(
  repoId: string,
  cypher: string,
): Promise<LbugQueryResult<TRow>> => {
  const entry = pool.get(repoId);
  if (!entry) {
    throw new Error(`LadybugDB not initialized for repo "${repoId}". Call initLbug first.`);
  }

  if (isWriteQuery(cypher)) {
    throw new Error('Write operations are not allowed. The pool adapter is read-only.');
  }

  entry.lastUsed = Date.now();

  const conn = await checkout(entry);
  activeQueryCount++;
  let retire = false;
  let retireAfter: Promise<unknown> | null = null;
  try {
    const queryPromise = conn.query(cypher);
    const queryResult = await withTimeout(queryPromise, QUERY_TIMEOUT_MS, 'Query', () => {
      retireAfter = queryPromise;
    });
    const result = Array.isArray(queryResult) ? queryResult[0] : queryResult;
    const rows = await getAllWithTimeout(result, 'Query', (pending) => {
      retireAfter = pending;
    });
    return rows as LbugQueryResult<TRow>;
  } catch (err) {
    retire = err instanceof QueryTimeoutError;
    throw err;
  } finally {
    activeQueryCount--;
    if (retire) {
      retireWhenSettled(entry, conn, retireAfter);
    } else {
      checkin(entry, conn);
    }
  }
};

/**
 * Execute a parameterized query on a specific repo's connection pool.
 * Uses prepare/execute pattern to prevent Cypher injection.
 */
export const executeParameterized = async <TRow extends object = LbugQueryRow>(
  repoId: string,
  cypher: string,
  params: LbugQueryParams,
): Promise<LbugQueryResult<TRow>> => {
  const entry = pool.get(repoId);
  if (!entry) {
    throw new Error(`LadybugDB not initialized for repo "${repoId}". Call initLbug first.`);
  }

  entry.lastUsed = Date.now();

  const conn = await checkout(entry);
  activeQueryCount++;
  let retire = false;
  let retireAfter: Promise<unknown> | null = null;
  try {
    let stmtMap = connStmtCaches.get(conn);
    if (!stmtMap) {
      stmtMap = new Map();
      connStmtCaches.set(conn, stmtMap);
    }
    let stmt = getPreparedStatement(stmtMap, cypher);
    if (!stmt) {
      const preparePromise = conn.prepare(cypher);
      const prepared = await withTimeout(preparePromise, QUERY_TIMEOUT_MS, 'Prepare', () => {
        retireAfter = preparePromise;
      });
      if (!prepared.isSuccess()) {
        const errMsg = await prepared.getErrorMessage();
        throw new Error(`Prepare failed: ${errMsg}`);
      }
      stmt = prepared;
      cachePreparedStatement(stmtMap, cypher, stmt);
    }
    let queryResult: lbug.QueryResult | lbug.QueryResult[];
    try {
      const executePromise = conn.execute(stmt, toLbugParams(params));
      queryResult = await withTimeout(executePromise, QUERY_TIMEOUT_MS, 'Execute', () => {
        retireAfter = executePromise;
      });
    } catch (executeErr) {
      stmtMap.delete(cypher);
      throw executeErr;
    }
    const result = Array.isArray(queryResult) ? queryResult[0] : queryResult;
    const rows = await getAllWithTimeout(result, 'Execute', (pending) => {
      retireAfter = pending;
    });
    return rows as LbugQueryResult<TRow>;
  } catch (err) {
    retire = err instanceof QueryTimeoutError;
    throw err;
  } finally {
    activeQueryCount--;
    if (retire) {
      retireWhenSettled(entry, conn, retireAfter);
    } else {
      checkin(entry, conn);
    }
  }
};

/**
 * Close one or all repo pools.
 * If repoId is provided, close only that repo's connections.
 * If omitted, close all repos.
 */
export const closeLbug = async (repoId?: string): Promise<void> => {
  if (repoId) {
    await closeOneWhenIdle(repoId);
    return;
  }

  for (const id of [...pool.keys()]) {
    await closeOneWhenIdle(id);
  }

  if (idleTimer) {
    clearInterval(idleTimer);
    idleTimer = null;
  }
};

/**
 * Check if a specific repo's pool is active
 */
export const isLbugReady = (repoId: string): boolean => pool.has(repoId);

export const isLbugDbPathReady = (dbPath: string): boolean => dbCache.has(dbPath);

/** Regex to detect write operations in user-supplied Cypher queries.
 * Note: CALL is NOT blocked — it's used for read-only FTS (CALL QUERY_FTS_INDEX)
 * and vector search (CALL QUERY_VECTOR_INDEX). The database is opened in
 * read-only mode as defense-in-depth against write procedures. */
export const CYPHER_WRITE_RE =
  /(?<!:)\b(CREATE|DELETE|SET|MERGE|REMOVE|DROP|ALTER|COPY|DETACH|FOREACH|INSTALL|LOAD)\b/i;

/** Check if a Cypher query contains write operations */
export function isWriteQuery(query: string): boolean {
  return CYPHER_WRITE_RE.test(query);
}
