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
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import lbug, { type LbugValue } from '@ladybugdb/core';
import { quoteLbugString, resolveLocalLbugExtensionPath } from './lbug-adapter.js';
import {
  LbugOpenError,
  classifyLbugOpenDiagnostic as classifyLbugOpenError,
} from './open-error.js';
import { acquireIndexGenerationPin, type IndexGenerationPin } from '../../storage/repo-manager.js';

export { classifyLbugOpenDiagnostic as classifyLbugOpenError } from './open-error.js';

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
  /**
   * Identity of the database file this entry was opened against. `dbPath` is a
   * stable path (`.ontoindex/current/lbug` is a symlink into a generation
   * directory), so `ontoindex analyze` can swap the underlying file without
   * changing the key. Cached handles would then read a replaced file and fail
   * with "Corrupted wal file" until the process restarted.
   */
  dbIdentity: string | null;
  /** Set to true when the pool entry is closed — checkin will close orphaned connections */
  closed: boolean;
  /** Set while explicit close waits for active checkouts to finish */
  closing: boolean;
  /** Retired native connections still closing after query timeout. */
  pendingRetirements: Set<Promise<void>>;
}

const pool = new Map<string, PoolEntry>();
const closePromises = new Map<string, Promise<void>>();
const pinnedContext = new AsyncLocalStorage<ReadonlyMap<string, string>>();
const pinnedReferences = new Map<string, number>();

export function getPinnedRepoId(repoId: string): string | undefined {
  return pinnedContext.getStore()?.get(repoId);
}

/** True when a request scope still holds a pin on an entry sharing this database. */
function hasLivePin(shared: SharedDB | undefined): boolean {
  if (!shared) return false;
  for (const [id, count] of pinnedReferences) {
    if (count > 0 && dbCache.get(pool.get(id)?.dbPath ?? '') === shared) return true;
  }
  return false;
}

/** Keep every query in one request on the generation resolved at admission. */
export async function withPinnedGeneration<T>(
  repoId: string,
  databasePath: string,
  fn: () => Promise<T>,
): Promise<T> {
  const realDbPath = await fs.realpath(databasePath);
  const pinnedId = `${repoId}\u0000pin\u0000${realDbPath}`;
  if (getPinnedRepoId(repoId) === pinnedId) return fn();

  // Reserve before awaiting initialization so concurrent scopes and eviction see it.
  pinnedReferences.set(pinnedId, (pinnedReferences.get(pinnedId) ?? 0) + 1);
  try {
    // A previous final release may still be draining this immutable entry.
    await closePromises.get(pinnedId);
    await initLbug(pinnedId, realDbPath);
    const context = new Map(pinnedContext.getStore());
    context.set(repoId, pinnedId);
    return await pinnedContext.run(context, fn);
  } finally {
    const remaining = (pinnedReferences.get(pinnedId) ?? 1) - 1;
    if (remaining > 0) {
      pinnedReferences.set(pinnedId, remaining);
    } else {
      // Keep the entry identified as a pin until closeLbug has selected its
      // narrow close path; ordinary aliases retain their existing semantics.
      pinnedReferences.set(pinnedId, 0);
      try {
        await closeLbug(pinnedId);
      } catch (error) {
        realStderrWrite(`LadybugDB request pin release failed: ${String(error)}\n`);
      } finally {
        if (pinnedReferences.get(pinnedId) === 0) pinnedReferences.delete(pinnedId);
      }
    }
  }
}
let admissionTail: Promise<void> = Promise.resolve();
// Failed opens remain fenced until their retry cooldown expires and cleanup succeeds.
const failedNativeOpens = new Map<
  string,
  { shared: SharedDB; failedAt: number; error: LbugOpenError }
>();
const unreleasedPins = new Set<IndexGenerationPin>();

function retainFailedNativeOpen(
  dbPath: string,
  db: lbug.Database,
  generationPin: IndexGenerationPin,
  error: unknown,
): void {
  // The driver retains its rejected init promise. Public close() awaits that
  // promise before disposing the uninitialized native wrapper, so clear only
  // this completed failure before handing cleanup back to the public API.
  if ('_initPromise' in db)
    (db as lbug.Database & { _initPromise: Promise<void> | null })._initPromise = null;
  failedNativeOpens.set(dbPath, {
    shared: newSharedDb({ db, generationPin, refCount: 0, ftsLoaded: false, vectorLoaded: false }),
    failedAt: Date.now(),
    error: new LbugOpenError(
      dbPath,
      error instanceof LbugOpenError ? error.cause : error,
      `LadybugDB native initialization failed: ${String(error)}`,
    ),
  });
}

async function retryUnreleasedPins(): Promise<void> {
  for (const pin of unreleasedPins) {
    try {
      await pin.release();
      unreleasedPins.delete(pin);
    } catch (error) {
      process.stderr.write(
        `LadybugDB generation pin release failed for ${pin.dbPath}: ${String(error)}\n`,
      );
    }
  }
}

async function serializeAdmission(open: () => Promise<void>): Promise<void> {
  const previous = admissionTail;
  let release!: () => void;
  admissionTail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    await open();
  } finally {
    release();
  }
}

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

/** Return the published generation directory held open for a repo, if any. */
export function getPinnedGenerationDir(repoId: string): string | undefined {
  const entry = pool.get(getPinnedRepoId(repoId) ?? repoId);
  const generationPin = entry && dbCache.get(entry.dbPath)?.generationPin;
  return generationPin?.published ? path.dirname(generationPin.dbPath) : undefined;
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
  generationPin?: IndexGenerationPin;
  db: lbug.Database;
  refCount: number;
  ftsLoaded: boolean;
  vectorLoaded: boolean;
  /** When true, closeOne skips db.close() — the Database is owned externally. */
  external?: boolean;
  closed?: boolean;
  closing?: boolean;
  closeRequested?: boolean;
  /** Connections remain owned here until native close succeeds. */
  pendingConnections: Set<lbug.Connection>;
  connectionCloses: Map<lbug.Connection, Promise<void>>;
  failedInitRepos: Set<string>;
  databaseClose?: Promise<void>;
  pinRelease?: Promise<void>;
  pinReleased?: boolean;
}
const dbCache = new Map<string, SharedDB>();
const failedInitShares = new Map<
  string,
  {
    shared: SharedDB;
    dbPath: string;
    connections: lbug.Connection[];
    cleanup?: Promise<void>;
  }
>();

function newSharedDb(
  values: Pick<SharedDB, 'db' | 'refCount' | 'ftsLoaded' | 'vectorLoaded'> &
    Partial<Pick<SharedDB, 'generationPin' | 'external'>>,
): SharedDB {
  return {
    ...values,
    pendingConnections: new Set(),
    connectionCloses: new Map(),
    failedInitRepos: new Set(),
  };
}

function isAdmissionClosed(entry: PoolEntry): boolean {
  const shared = dbCache.get(entry.dbPath);
  return (
    entry.closed || entry.closing || !!(shared?.closed || shared?.closing || shared?.closeRequested)
  );
}

function rejectPoolWaiters(repoId: string, entry: PoolEntry): void {
  for (const waiter of entry.waiters.splice(0)) {
    clearTimeout(waiter.timer);
    waiter.reject(new Error(`LadybugDB pool is closing for repo "${repoId}"`));
  }
}

function fenceSharedPools(shared: SharedDB): void {
  for (const [repoId, entry] of pool) {
    if (dbCache.get(entry.dbPath) !== shared) continue;
    entry.closing = true;
    rejectPoolWaiters(repoId, entry);
  }
}

function requestSharedClose(shared: SharedDB): void {
  shared.closeRequested = true;
  shared.closing = true;
  fenceSharedPools(shared);
}

function trackConnectionClose(shared: SharedDB, conn: lbug.Connection): Promise<void> {
  shared.pendingConnections.add(conn);
  const pending = shared.connectionCloses.get(conn);
  if (pending) return pending;
  const close = Promise.resolve()
    .then(() => conn.close())
    .then(() => {
      shared.pendingConnections.delete(conn);
    })
    .finally(() => {
      shared.connectionCloses.delete(conn);
    });
  shared.connectionCloses.set(conn, close);
  return close;
}

async function closeSharedConnections(
  shared: SharedDB,
  connections: Iterable<lbug.Connection>,
): Promise<void> {
  const outcomes = await withTimeout(
    Promise.allSettled([...new Set(connections)].map((conn) => trackConnectionClose(shared, conn))),
    CLOSE_WAIT_TIMEOUT_MS,
    'Native connection cleanup',
  );
  const failure = outcomes.find((outcome) => outcome.status === 'rejected');
  if (failure?.status === 'rejected') throw failure.reason;
}

async function closeSharedDatabase(shared: SharedDB): Promise<void> {
  if (shared.external) return;
  if (!shared.closed) {
    shared.databaseClose ??= Promise.resolve()
      .then(() => shared.db.close())
      .then(() => {
        shared.closed = true;
      });
    const pending = shared.databaseClose;
    void pending.catch(() => {
      if (shared.databaseClose === pending) shared.databaseClose = undefined;
    });
    await withTimeout(pending, CLOSE_WAIT_TIMEOUT_MS, 'Native database cleanup');
  }
  if (!shared.pinReleased) {
    shared.pinRelease ??= Promise.resolve()
      .then(() => shared.generationPin?.release())
      .then(() => {
        shared.pinReleased = true;
      });
    const pending = shared.pinRelease;
    void pending.catch(() => {
      if (shared.pinRelease === pending) shared.pinRelease = undefined;
    });
    await withTimeout(pending, CLOSE_WAIT_TIMEOUT_MS, 'Generation pin cleanup');
  }
}

/** Max repos in the pool (LRU eviction) */
const MAX_POOL_SIZE = 5;
const FAILED_OPEN_RETRY_MS = readBoundedIntEnv(
  'ONTOINDEX_LBUG_FAILED_OPEN_RETRY_MS',
  30_000,
  1000,
  600_000,
);
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
    void retryUnreleasedPins();
    const now = Date.now();
    for (const [repoId, entry] of pool) {
      if (
        !pinnedReferences.has(repoId) &&
        now - entry.lastUsed > IDLE_TIMEOUT_MS &&
        entry.checkedOut === 0
      ) {
        void closeOneWhenIdle(repoId).catch((err) =>
          realStderrWrite(`LadybugDB idle close failed: ${String(err)}\n`),
        );
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
  const entry = pool.get(getPinnedRepoId(repoId) ?? repoId);
  if (entry) {
    entry.lastUsed = Date.now();
  }
};

/**
 * Evict the least-recently-used repo if pool is at capacity
 */
async function evictLRU(): Promise<void> {
  for (const [dbPath, failed] of failedNativeOpens) {
    if (Date.now() - failed.failedAt < FAILED_OPEN_RETRY_MS) continue;
    try {
      await closeSharedDatabase(failed.shared);
      failedNativeOpens.delete(dbPath);
    } catch (error) {
      failed.error = new LbugOpenError(dbPath, error);
    }
  }
  const occupied = () => pool.size + failedInitShares.size + failedNativeOpens.size;
  if (occupied() < MAX_POOL_SIZE) return;

  let oldestId: string | null = null;
  let oldestTime = Infinity;
  for (const [id, entry] of pool) {
    if (
      !pinnedReferences.has(id) &&
      entry.checkedOut === 0 &&
      entry.pendingRetirements.size === 0 &&
      !isAdmissionClosed(entry) &&
      entry.lastUsed < oldestTime
    ) {
      oldestTime = entry.lastUsed;
      oldestId = id;
    }
  }
  if (oldestId) {
    await closeOneWhenIdle(oldestId);
  }
  if (occupied() >= MAX_POOL_SIZE) {
    throw new Error('LadybugDB pool is busy at capacity. Retry later.');
  }
}

/**
 * Remove a repo from the pool, close its connections, and release its
 * shared Database ref.  Only closes the Database when no other repoIds
 * reference it (refCount === 0).
 */
async function closeOne(repoId: string): Promise<void> {
  const entry = pool.get(repoId);
  if (!entry) return;

  entry.closed = true;
  entry.closing = true;
  const shared = dbCache.get(entry.dbPath);
  if (shared?.refCount === 1) shared.closing = true;

  for (const waiter of entry.waiters.splice(0)) {
    clearTimeout(waiter.timer);
    waiter.reject(new Error(`LadybugDB pool closed for repo "${repoId}"`));
  }

  // Keep failed handles registered so deletion cannot mistake failure for closure.
  const connections = entry.available;
  if (shared) {
    try {
      await closeSharedConnections(shared, [...connections, ...shared.pendingConnections]);
      entry.available = [];
    } catch (err) {
      entry.available = connections.filter((conn) => shared.pendingConnections.has(conn));
      throw err;
    }
  } else {
    const outcomes = await Promise.allSettled(connections.map((conn) => conn.close()));
    entry.available = connections.filter((_, index) => outcomes[index].status === 'rejected');
    const failure = outcomes.find((outcome) => outcome.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
  }

  // Checked-out connections can't be closed here — they're in-flight.
  // The checkin() function detects entry.closed and closes them on return.

  // Only close the Database when no other repoIds reference it.
  // External databases (injected via initLbugWithDb) are never closed here;
  // the core adapter owns their lifecycle. Once no pool entries reference one,
  // remove it from this cache so injected DB objects do not stay pinned.
  if (shared) {
    if (shared.refCount === 1) {
      if (!shared.external) {
        await closeSharedConnections(shared, shared.pendingConnections);
        await closeSharedDatabase(shared);
      }
      dbCache.delete(entry.dbPath);
    }
    shared.refCount--;
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

async function releaseSharedDbAfterFailedInit(
  repoId: string,
  dbPath: string,
  shared: SharedDB,
  connections: lbug.Connection[],
): Promise<void> {
  let failed = failedInitShares.get(repoId);
  if (!failed) {
    failed = { shared, dbPath, connections };
    failedInitShares.set(repoId, failed);
    shared.failedInitRepos.add(repoId);
    for (const conn of connections) shared.pendingConnections.add(conn);
  }
  if (failed.cleanup) return failed.cleanup;
  shared.closing = true;
  for (const [id, entry] of pool) {
    if (dbCache.get(entry.dbPath) === shared) rejectPoolWaiters(id, entry);
  }
  const cleanup = (async () => {
    await closeSharedConnections(
      shared,
      failed.connections.filter((conn) => shared.pendingConnections.has(conn)),
    );
    // Keep this initialization's reference until database and pin cleanup succeed.
    if (shared.refCount === 1) {
      await closeSharedConnections(shared, shared.pendingConnections);
      if (!shared.external) {
        await closeSharedDatabase(shared);
      }
      dbCache.delete(dbPath);
    }
    shared.refCount--;
    shared.failedInitRepos.delete(repoId);
    failedInitShares.delete(repoId);
    shared.closing = shared.closeRequested === true || shared.failedInitRepos.size > 0;
  })();
  failed.cleanup = cleanup;
  try {
    await cleanup;
  } finally {
    failed.cleanup = undefined;
  }
}

async function closePrewarmedConnections(
  repoId: string,
  dbPath: string,
  shared: SharedDB,
  connections: lbug.Connection[],
): Promise<void> {
  await releaseSharedDbAfterFailedInit(repoId, dbPath, shared, connections);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForCheckedOutConnections(repoId: string, entry: PoolEntry): Promise<void> {
  const started = Date.now();
  while (entry.checkedOut > 0 || entry.pendingRetirements.size > 0) {
    if (Date.now() - started >= CLOSE_WAIT_TIMEOUT_MS) {
      throw new Error(
        `Timed out waiting for ${entry.checkedOut} active LadybugDB quer${entry.checkedOut === 1 ? 'y' : 'ies'} to finish for repo "${repoId}"`,
      );
    }
    await sleep(CLOSE_WAIT_POLL_MS);
  }
}

function closeOneWhenIdle(repoId: string): Promise<void> {
  const pending = closePromises.get(repoId);
  if (pending) return pending;
  const entry = pool.get(repoId);
  if (!entry) return Promise.resolve();
  entry.closing = true;
  rejectPoolWaiters(repoId, entry);
  const promise = (async () => {
    try {
      await waitForCheckedOutConnections(repoId, entry);
      await closeOne(repoId);
    } catch (err) {
      const current = pool.get(repoId);
      const shared = dbCache.get(entry.dbPath);
      if (
        current === entry &&
        !entry.closed &&
        !shared?.closing &&
        !shared?.closed &&
        !shared?.closeRequested
      ) {
        entry.closing = false;
      }
      throw err;
    }
  })();
  closePromises.set(repoId, promise);
  void promise.then(
    () => closePromises.delete(repoId),
    () => closePromises.delete(repoId),
  );
  return promise;
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
    // Bound per-query native working memory across every pool connection.
    return new lbug.Connection(db, 4);
  } finally {
    restoreStdout();
  }
}

/**
 * Whether an extension load error means the extension is simply absent, so search
 * degrades to BM25 instead of failing pool startup. The patterns are the texts the
 * LadybugDB 0.17 binder emits for official extensions that were never installed and
 * for paths that do not exist; any other error (corruption, ABI, runtime) stays fatal.
 */
export function isUnavailableExtension(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    /has not been installed/i.test(message) ||
    /neither an official extension, nor does the extension path/i.test(message) ||
    /extension.*(?:not found|not installed|not available|unsupported|does not exist)|(?:cannot|could not|failed to) (?:find|download).*extension/i.test(
      message,
    )
  );
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
        const localFtsPath = await resolveLocalLbugExtensionPath('fts');
        if (localFtsPath) {
          try {
            const loadQuery = `LOAD EXTENSION '${quoteLbugString(localFtsPath)}'`;
            await runStatement(conn, loadQuery);
            shared.ftsLoaded = true;
          } catch {
            // A failed explicit-path load falls through to the bare LOAD below, which
            // applies the strict classifier to the final error.
          }
        }
        if (!shared.ftsLoaded) {
          await runStatement(conn, 'LOAD EXTENSION fts');
          shared.ftsLoaded = true;
        }
      } catch (err) {
        if (!isUnavailableExtension(err)) throw err;
        // FTS extension may not be installed — FTS queries will fail gracefully
      }
    }
    if (!shared.vectorLoaded) {
      try {
        await runStatement(conn, 'INSTALL VECTOR');
        await runStatement(conn, 'LOAD EXTENSION VECTOR');
        shared.vectorLoaded = true;
      } catch (err) {
        if (!isUnavailableExtension(err)) throw err;
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
/** Pending initialization references and explicit-close routes retained until shared cleanup. */
const initializingShares = new Map<string, { shared: SharedDB; dbPath: string }>();

function releaseInitializationRoute(repoId: string): void {
  const state = initializingShares.get(repoId);
  if (state && (!state.shared.closeRequested || dbCache.get(state.dbPath) !== state.shared)) {
    initializingShares.delete(repoId);
  }
}

function pruneInitializationRoutes(): void {
  for (const [repoId, state] of initializingShares) {
    if (dbCache.get(state.dbPath) !== state.shared) initializingShares.delete(repoId);
  }
}

function readBoundedIntEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

/** Working-tree graphs hold the whole repository and run the heaviest read queries. */
const OVERLAY_BUFFER_BYTES = 256 * 1048576;

/** True for `<storage>/overlay/<generation>/lbug`, where workspace graphs are published. */
function isOverlayGenerationPath(dbPath: string): boolean {
  return path.basename(path.dirname(path.dirname(dbPath))) === 'overlay';
}

/**
 * Buffer for a read-only open. An explicit `ONTOINDEX_LBUG_BUFFER_MB` applies to every database;
 * otherwise workspace generations get 256 MiB and the committed index keeps 64 MiB.
 */
export function readBufferManagerSize(dbPath?: string): number {
  const raw = process.env.ONTOINDEX_LBUG_BUFFER_MB;
  if (raw === undefined || raw === '' || raw === '0') {
    return dbPath && isOverlayGenerationPath(dbPath) ? OVERLAY_BUFFER_BYTES : 64 * 1048576;
  }
  if (
    !/^\d+$/.test(raw) ||
    !Number.isSafeInteger(Number(raw)) ||
    Number(raw) < 1 ||
    Number(raw) > 16384
  ) {
    console.error(
      '[ontoindex] Invalid ONTOINDEX_LBUG_BUFFER_MB; expected an integer from 1 to 16384; using default 64 MB.',
    );
    return 64 * 1048576;
  }
  return Number(raw) * 1048576;
}

/**
 * Resolve the identity of the database file behind `dbPath`. The path is stable
 * across reindexes, so identity is taken from the resolved real path plus
 * inode/size/mtime. Returns null when the file cannot be inspected, in which
 * case the caller keeps the existing handle rather than churning the pool.
 */
async function readDbIdentity(dbPath: string): Promise<string | null> {
  try {
    const realPath = await fs.realpath(dbPath);
    const stat = await fs.stat(realPath);
    return `${realPath}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
  } catch {
    return null;
  }
}

/**
 * Initialize (or reuse) a Database + connection pool for a specific repo.
 * Retries on lock errors (e.g., when `ontoindex analyze` is running).
 *
 * Concurrent calls for the same repoId are deduplicated — the second caller
 * awaits the first's in-progress init rather than starting a redundant one.
 */
export const initLbug = async (repoId: string, dbPath: string): Promise<void> => {
  if (failedInitShares.has(repoId)) throw new Error('LadybugDB database is closing');
  const pending = initPromises.get(repoId);
  if (pending) return pending;

  const promise = (async () => {
    if (failedInitShares.has(repoId)) {
      throw new Error('LadybugDB database is closing');
    }
    const existing = pool.get(repoId);
    if (existing) {
      const identity = await readDbIdentity(dbPath);
      if (existing.closing || existing.closed || dbCache.get(existing.dbPath)?.closing)
        throw new Error('LadybugDB database is closing');
      if (identity !== null && existing.dbIdentity !== null && identity !== existing.dbIdentity) {
        // Drain the old generation before opening its replacement.
        await closeOneWhenIdle(repoId);
      } else {
        existing.lastUsed = Date.now();
        return;
      }
    }
    // Fail fast while the same native database is draining; queueing behind its
    // cleanup would hide the closing state from this caller.
    if (dbCache.get(dbPath)?.closing) throw new Error('LadybugDB database is closing');
    await serializeAdmission(() => doInitLbug(repoId, dbPath));
  })();
  initPromises.set(repoId, promise);
  try {
    await promise;
  } finally {
    initPromises.delete(repoId);
    releaseInitializationRoute(repoId);
  }
};

/**
 * Internal init — creates DB, pre-warms connections, loads FTS, then registers pool.
 * Pool entry is registered LAST so concurrent executeQuery calls see either
 * "not initialized" (and throw) or a fully ready pool — never a half-built one.
 */
async function doInitLbug(repoId: string, dbPath: string): Promise<void> {
  const generationPin = await acquireIndexGenerationPin(dbPath);
  dbPath = generationPin.dbPath;
  let nativeOwnsPin = false;
  try {
    // Check if database exists
    try {
      await fs.stat(dbPath);
    } catch {
      throw new Error(`LadybugDB not found at ${dbPath}. Run: ontoindex analyze`);
    }

    const failed = failedNativeOpens.get(dbPath);
    if (failed && Date.now() - failed.failedAt < FAILED_OPEN_RETRY_MS) throw failed.error;
    await evictLRU();
    if (failedNativeOpens.has(dbPath)) throw failedNativeOpens.get(dbPath)!.error;

    // Reuse an existing native Database if another repoId already opened this path.
    // This prevents buffer manager exhaustion from multiple mmap regions on the same file.
    let shared = dbCache.get(dbPath);
    if (
      shared?.closing ||
      shared?.closed ||
      [...pool.values()].some((entry) => entry.dbPath === dbPath && (entry.closing || entry.closed))
    ) {
      throw new Error('LadybugDB database is closing');
    }
    if (!shared) {
      // Open in read-only mode — MCP server never writes to the database.
      // This allows multiple MCP server instances to read concurrently, and
      // avoids lock conflicts when `ontoindex analyze` is writing.
      let lastError: Error | null = null;
      let isLockError = false;
      const bufferManagerSize = readBufferManagerSize(dbPath);
      for (let attempt = 1; attempt <= LOCK_RETRY_ATTEMPTS; attempt++) {
        silenceStdout();
        try {
          const db = new lbug.Database(
            dbPath,
            bufferManagerSize,
            false, // enableCompression (default)
            true, // readOnly
          );
          try {
            await db.init();
          } catch (error) {
            const openError = new LbugOpenError(dbPath, error);
            const message = error instanceof Error ? error.message : String(error);
            const errorClass = classifyLbugOpenError(message);
            const lockError = errorClass === 'lock';
            if (lockError && attempt === LOCK_RETRY_ATTEMPTS) {
              retainFailedNativeOpen(dbPath, db, generationPin, openError);
              nativeOwnsPin = true;
            } else {
              if ('_initPromise' in db)
                (db as lbug.Database & { _initPromise: Promise<void> | null })._initPromise = null;
              try {
                await db.close();
              } catch {
                retainFailedNativeOpen(dbPath, db, generationPin, openError);
                nativeOwnsPin = true;
              }
            }
            if (errorClass === 'other' && !nativeOwnsPin) {
              retainFailedNativeOpen(dbPath, db, generationPin, openError);
              nativeOwnsPin = true;
            }
            throw openError;
          }
          restoreStdout();
          shared = newSharedDb({
            db,
            refCount: 0,
            ftsLoaded: false,
            vectorLoaded: false,
            generationPin,
          });
          nativeOwnsPin = true;
          dbCache.set(dbPath, shared);
          break;
        } catch (err: unknown) {
          restoreStdout();
          lastError = err instanceof LbugOpenError ? err : new LbugOpenError(dbPath, err);
          if (failedNativeOpens.has(dbPath)) throw lastError;
          isLockError = classifyLbugOpenError(lastError.message) === 'lock';
          if (!isLockError || attempt === LOCK_RETRY_ATTEMPTS) break;
          await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_DELAY_MS * attempt));
        }
      }

      // WAL recovery: if the open failed with a WAL replay error, attempt to re-open
      // with throwOnWalReplayFailure=false so LadybugDB silently discards the corrupt
      // WAL tail and replays up to the last valid checkpoint.  This recovers from
      // process-kill-mid-write scenarios without losing data past the last checkpoint.
      //
      // We only attempt recovery when:
      //   - The DB file exists (so it's not a "DB not found" case)
      //   - The error explicitly identifies WAL corruption or replay failure
      //
      // LadybugDB Database constructor arg positions:
      //   (path, bufferManagerSize, enableCompression, readOnly, maxDBSize,
      //    autoCheckpoint, checkpointThreshold, throwOnWalReplayFailure, enableChecksums)
      if (!shared && lastError !== null && classifyLbugOpenError(lastError.message) === 'wal') {
        silenceStdout();
        try {
          const RecoveryDatabase = lbug.Database as unknown as RecoveryDatabaseConstructor;
          const db = new RecoveryDatabase(
            dbPath,
            bufferManagerSize,
            false, // enableCompression
            true, // readOnly
            0, // maxDBSize
            true, // autoCheckpoint
            -1, // checkpointThreshold
            false, // throwOnWalReplayFailure — discard corrupt WAL tail instead of throwing
          );
          try {
            await db.init();
          } catch (error) {
            retainFailedNativeOpen(dbPath, db, generationPin, error);
            nativeOwnsPin = true;
            throw error;
          }
          restoreStdout();
          // WAL was corrupt — warn on stderr (process.stderr.write avoids corrupting MCP stdout).
          process.stderr.write(
            '[ontoindex] WARNING: WAL corruption detected on open; discarding corrupt WAL tail. ' +
              'Data since last checkpoint may be lost. Re-run `ontoindex analyze` if index appears incomplete.\n',
          );
          shared = newSharedDb({
            db,
            refCount: 0,
            ftsLoaded: false,
            vectorLoaded: false,
            generationPin,
          });
          nativeOwnsPin = true;
          dbCache.set(dbPath, shared);
        } catch (error) {
          restoreStdout();
          const cause = error instanceof Error ? error.message : String(error);
          // Recovery also failed — the database is unrecoverable.
          throw new LbugOpenError(
            dbPath,
            error,
            'OntoIndex index unrecoverable due to WAL corruption. ' +
              `Run \`ontoindex clean --force && ontoindex analyze\` to rebuild. Cause: ${cause}`,
          );
        }
      }

      if (!shared) {
        throw new LbugOpenError(
          dbPath,
          lastError instanceof LbugOpenError ? lastError.cause : lastError,
          `LadybugDB unavailable for ${repoId}. Another process may be rebuilding the index. ` +
            `Retry later. (${lastError?.message || 'unknown error'})`,
        );
      }
    }

    if (shared.closing || shared.closed) throw new Error('LadybugDB database is closing');
    shared.refCount++;
    initializingShares.set(repoId, { shared, dbPath });
    const db = shared.db;

    // Pre-create the full pool upfront so createConnection() (which silences
    // stdout) is never called lazily during active query execution.
    // Mark preWarmActive so the watchdog timer doesn't interfere.
    const available: lbug.Connection[] = [];
    try {
      if (shared.generationPin !== generationPin) await generationPin.release();
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
      const dbIdentity = await readDbIdentity(dbPath);
      if (shared.closing || shared.closed) throw new Error('LadybugDB database is closing');
      pool.set(repoId, {
        db,
        available,
        checkedOut: 0,
        waiters: [],
        lastUsed: Date.now(),
        dbPath,
        dbIdentity,
        closed: false,
        closing: false,
        pendingRetirements: new Set(),
      });
    } catch (err) {
      await closePrewarmedConnections(repoId, dbPath, shared, available);
      throw err;
    }

    // Register pool entry only after all connections are pre-warmed and FTS is
    // loaded.  Concurrent executeQuery calls see either "not initialized"
    // (and throw cleanly) or a fully ready pool — never a half-built one.
    ensureIdleTimer();
  } catch (err) {
    if (!nativeOwnsPin) {
      try {
        await generationPin.release();
      } catch (error) {
        unreleasedPins.add(generationPin);
        process.stderr.write(
          `LadybugDB generation pin release failed for ${dbPath}: ${String(error)}\n`,
        );
        ensureIdleTimer();
      }
    }
    throw err;
  }
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
  const pending = initPromises.get(repoId);
  if (pending) return pending;
  const promise = serializeAdmission(() => doInitLbugWithDb(repoId, existingDb, dbPath));
  initPromises.set(repoId, promise);
  try {
    await promise;
  } finally {
    initPromises.delete(repoId);
    releaseInitializationRoute(repoId);
  }
}

async function doInitLbugWithDb(
  repoId: string,
  existingDb: lbug.Database,
  dbPath: string,
): Promise<void> {
  if (failedInitShares.has(repoId)) throw new Error('LadybugDB database is closing');
  const existing = pool.get(repoId);
  if (existing) {
    if (existing.closing || existing.closed || dbCache.get(existing.dbPath)?.closing)
      throw new Error('LadybugDB database is closing');
    existing.lastUsed = Date.now();
    return;
  }

  // Register in dbCache with external: true so other initLbug() calls
  const failed = failedNativeOpens.get(dbPath);
  if (failed && Date.now() - failed.failedAt < FAILED_OPEN_RETRY_MS) throw failed.error;
  await evictLRU();
  if (failedNativeOpens.has(dbPath)) throw failedNativeOpens.get(dbPath)!.error;
  // for the same dbPath reuse this Database instead of trying to open
  // a new one (which would fail with a file lock error).
  // closeOne() respects the external flag and skips db.close().
  let shared = dbCache.get(dbPath);
  if (
    shared?.closing ||
    shared?.closed ||
    [...pool.values()].some((entry) => entry.dbPath === dbPath && (entry.closing || entry.closed))
  ) {
    throw new Error('LadybugDB database is closing');
  }
  if (!shared) {
    shared = newSharedDb({
      db: existingDb,
      refCount: 0,
      ftsLoaded: false,
      vectorLoaded: false,
      external: true,
    });
    dbCache.set(dbPath, shared);
  }
  shared.refCount++;
  initializingShares.set(repoId, { shared, dbPath });

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
    const dbIdentity = await readDbIdentity(dbPath);
    if (shared.closing || shared.closed) throw new Error('LadybugDB database is closing');
    pool.set(repoId, {
      db: existingDb,
      available,
      checkedOut: 0,
      waiters: [],
      lastUsed: Date.now(),
      dbPath,
      dbIdentity,
      closed: false,
      closing: false,
      pendingRetirements: new Set(),
    });
  } catch (err) {
    await closePrewarmedConnections(repoId, dbPath, shared, available);
    throw err;
  }

  ensureIdleTimer();
}

/**
 * Checkout a connection from the pool.
 * Returns an available connection, or creates a new one if under the cap.
 * If all connections are busy and at cap, queues the caller until one is returned.
 */
function checkout(entry: PoolEntry): Promise<lbug.Connection> {
  if (isAdmissionClosed(entry)) {
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
  const totalConns = entry.available.length + entry.checkedOut + entry.pendingRetirements.size;
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
  if (entry.closed) {
    entry.checkedOut = Math.max(0, entry.checkedOut - 1);
    // Pool entry was deleted during checkout — close the orphaned connection
    const shared = dbCache.get(entry.dbPath);
    if (shared) void trackConnectionClose(shared, conn).catch(() => {});
    else void conn.close().catch(() => {});
    return;
  }
  if (isAdmissionClosed(entry)) {
    entry.checkedOut--;
    entry.available.push(conn);
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
  const shared = dbCache.get(entry.dbPath);
  const close = shared
    ? trackConnectionClose(shared, conn)
    : Promise.resolve().then(() => conn.close());
  const retirement = close.then(() => {
    if (isAdmissionClosed(entry) || ![...pool.values()].includes(entry)) return;
    const replacement = createConnection(entry.db);
    const waiter = entry.waiters.shift();
    if (waiter) {
      clearTimeout(waiter.timer);
      entry.checkedOut++;
      waiter.resolve(replacement);
    } else {
      entry.available.push(replacement);
    }
  });
  entry.pendingRetirements.add(retirement);
  void retirement
    .catch((error) => {
      if (shared) {
        shared.closing = true;
        fenceSharedPools(shared);
      }
      realStderrWrite(`LadybugDB retired connection close failed: ${String(error)}\n`);
    })
    .finally(() => entry.pendingRetirements.delete(retirement));
  entry.checkedOut = Math.max(0, entry.checkedOut - 1);
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

function closeQueryResults(queryResult: lbug.QueryResult | lbug.QueryResult[]): void {
  for (const result of Array.isArray(queryResult) ? queryResult : [queryResult]) {
    try {
      result.close();
    } catch {
      // Closing is best-effort housekeeping.
    }
  }
}

async function runStatement(conn: lbug.Connection, statement: string): Promise<void> {
  const pending = conn.query(statement).then((result) => {
    try {
      return;
    } finally {
      closeQueryResults(result);
    }
  });
  await withTimeout(pending, QUERY_TIMEOUT_MS, statement);
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
  const entry = pool.get(getPinnedRepoId(repoId) ?? repoId);
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
  let queryResults: lbug.QueryResult | lbug.QueryResult[] | undefined;
  try {
    const queryPromise = conn.query(cypher).then((results) => (queryResults = results));
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
    if (retireAfter) {
      retireAfter = retireAfter
        .catch(() => {})
        .finally(() => {
          if (queryResults) closeQueryResults(queryResults);
        });
    } else if (queryResults) {
      closeQueryResults(queryResults);
    }
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
  const entry = pool.get(getPinnedRepoId(repoId) ?? repoId);
  if (!entry) {
    throw new Error(`LadybugDB not initialized for repo "${repoId}". Call initLbug first.`);
  }

  entry.lastUsed = Date.now();

  const conn = await checkout(entry);
  activeQueryCount++;
  let retire = false;
  let retireAfter: Promise<unknown> | null = null;
  let queryResults: lbug.QueryResult | lbug.QueryResult[] | undefined;
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
      const executePromise = conn
        .execute(stmt, toLbugParams(params))
        .then((results) => (queryResults = results));
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
    if (retireAfter) {
      retireAfter = retireAfter
        .catch(() => {})
        .finally(() => {
          if (queryResults) closeQueryResults(queryResults);
        });
    } else if (queryResults) {
      closeQueryResults(queryResults);
    }
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
  if (repoId && pinnedReferences.has(repoId)) {
    await closeOneWhenIdle(repoId);
    return;
  }
  // Start the retry without awaiting it: close must fence the pool synchronously.
  void retryUnreleasedPins();
  if (repoId) {
    const state = initializingShares.get(repoId);
    const initializingShare =
      state && dbCache.get(state.dbPath) === state.shared ? state : undefined;
    const knownPath =
      pool.get(repoId)?.dbPath ?? failedInitShares.get(repoId)?.dbPath ?? initializingShare?.dbPath;
    const knownShared =
      initializingShare?.shared ?? (knownPath ? dbCache.get(knownPath) : undefined);
    if (hasLivePin(knownShared)) {
      // A live request scope owns this database; its final release closes it.
      await closeOneWhenIdle(repoId);
      return;
    }
    if (knownShared) requestSharedClose(knownShared);
    const initializing = initPromises.get(repoId);
    if (initializing)
      await withTimeout(
        initializing.catch(() => {}),
        CLOSE_WAIT_TIMEOUT_MS,
        'Pool initialization drain',
      );
    if (knownShared && dbCache.get(knownPath!) !== knownShared) {
      pruneInitializationRoutes();
      return;
    }
    const failed = failedInitShares.get(repoId);
    const dbPath = knownShared
      ? knownPath
      : (pool.get(repoId)?.dbPath ?? failed?.dbPath ?? knownPath);
    const shared = dbPath ? dbCache.get(dbPath) : undefined;
    if (shared) {
      requestSharedClose(shared);
      // Aliases may own a native reference before their pool entry is published.
      await withTimeout(
        Promise.allSettled([...initPromises.values()]),
        CLOSE_WAIT_TIMEOUT_MS,
        'Pool initialization drain',
      );
      if (dbCache.get(dbPath!) !== shared) {
        pruneInitializationRoutes();
        return;
      }
    }
    const ids = dbPath
      ? [...pool].filter(([, entry]) => entry.dbPath === dbPath).map(([id]) => id)
      : [repoId];
    for (const id of ids) {
      if (shared && (dbCache.get(dbPath!) !== shared || pool.get(id)?.db !== shared.db)) continue;
      await closeOneWhenIdle(id);
    }
    for (const [id, state] of [...failedInitShares]) {
      if (shared ? state.shared === shared : id === repoId || state.dbPath === dbPath)
        await closePrewarmedConnections(id, state.dbPath, state.shared, state.connections);
    }
    pruneInitializationRoutes();
    return;
  }

  for (const shared of dbCache.values()) {
    if (!hasLivePin(shared)) requestSharedClose(shared);
  }
  await withTimeout(
    Promise.allSettled([...initPromises.values()]),
    CLOSE_WAIT_TIMEOUT_MS,
    'Pool initialization drain',
  );
  for (const id of [...pool.keys()]) {
    if (hasLivePin(dbCache.get(pool.get(id)?.dbPath ?? ''))) continue;
    await closeOneWhenIdle(id);
  }
  for (const [id, state] of [...failedInitShares]) {
    await closePrewarmedConnections(id, state.dbPath, state.shared, state.connections);
  }
  for (const [dbPath, failed] of [...failedNativeOpens]) {
    try {
      await closeSharedDatabase(failed.shared);
      failedNativeOpens.delete(dbPath);
    } catch (error) {
      failed.error = new LbugOpenError(dbPath, error);
    }
  }
  pruneInitializationRoutes();

  if (idleTimer) {
    clearInterval(idleTimer);
    idleTimer = null;
  }
};

/**
 * Check if a specific repo's pool is active
 */
/** Read the database path for a live repository alias without changing pool state. */
export const getLbugDbPath = (repoId: string): string | undefined => pool.get(repoId)?.dbPath;

export const isLbugReady = (repoId: string): boolean => pool.has(repoId);

/** Number of repositories with an open read-only connection pool. */
export const openPoolCount = (): number => pool.size;

export const isLbugDbPathReady = (dbPath: string): boolean => dbCache.has(dbPath);

/** Regex to detect write operations in user-supplied Cypher queries.
 * Note: CALL is NOT blocked — it's used for read-only FTS (CALL QUERY_FTS_INDEX)
 * and vector search (CALL QUERY_VECTOR_INDEX). The database is opened in
 * read-only mode as defense-in-depth against write procedures. */
export const CYPHER_WRITE_RE =
  /(?<!:)\b(CREATE|DELETE|SET|MERGE|REMOVE|DROP|ALTER|COPY|DETACH|FOREACH|INSTALL|LOAD)\b/i;

/** Check if a Cypher query contains write operations */
export function isWriteQuery(query: string): boolean {
  const code: string[] = [];
  let start = 0;
  for (let i = 0; i < query.length; i++) {
    const quote = query[i];
    const lineComment = quote === '/' && query[i + 1] === '/';
    const blockComment = quote === '/' && query[i + 1] === '*';
    if (quote !== "'" && quote !== '"' && quote !== '`' && !lineComment && !blockComment) {
      continue;
    }
    code.push(query.slice(start, i), ' ');
    if (lineComment) {
      while (i < query.length && query[i] !== '\n' && query[i] !== '\r') i++;
    } else if (blockComment) {
      const end = query.indexOf('*/', i + 2);
      if (end === -1) return true;
      i = end + 1;
    } else {
      let closed = false;
      while (++i < query.length) {
        if (query[i] === '\\' && quote !== '`') {
          i++;
        } else if (query[i] === quote) {
          if (quote === '`' && query[i + 1] === '`') {
            i++;
            continue;
          }
          closed = true;
          break;
        }
      }
      if (!closed) return true;
    }
    start = i + 1;
  }
  code.push(query.slice(start));
  return CYPHER_WRITE_RE.test(code.join(''));
}
