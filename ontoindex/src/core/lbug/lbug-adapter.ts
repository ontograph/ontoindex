import fs from 'fs/promises';
import { createReadStream, createWriteStream } from 'fs';
import { createInterface } from 'readline';
import { once } from 'events';
import { finished } from 'stream/promises';
import path from 'path';
import lbug, { type LbugValue } from '@ladybugdb/core';
import { KnowledgeGraph } from '../graph/types.js';
import {
  NODE_TABLES,
  REL_TABLE_NAME,
  SCHEMA_QUERIES,
  RELATION_SCHEMA,
  EMBEDDING_TABLE_NAME,
  STALE_HASH_SENTINEL,
  NodeTableName,
} from './schema.js';

// ---------------------------------------------------------------------------
// Preflight relationship label-pair coverage
// ---------------------------------------------------------------------------

const getValidRelPairs = (): Set<string> => {
  const pairs = new Set<string>();
  const matches = RELATION_SCHEMA.matchAll(/FROM\s+(`?\w+`?)\s+TO\s+(`?\w+`?)/g);
  for (const match of matches) {
    const from = match[1].replace(/`/g, '');
    const to = match[2].replace(/`/g, '');
    pairs.add(`${from}|${to}`);
  }
  return pairs;
};

const validRelPairs = getValidRelPairs();

import { streamAllCSVsToDisk } from './csv-generator.js';
import type { CachedEmbedding } from '../embeddings/types.js';

export type LbugProjectionRow = {
  [field: string]: unknown;
  [index: number]: unknown;
  count?: number;
  cnt?: number;
};

export type LbugProjectionRows<TRow extends LbugProjectionRow = LbugProjectionRow> = TRow[];
export type LbugQueryParams = Readonly<Record<string, unknown>>;

type LbugNodeProperties = Readonly<Record<string, unknown>>;
type LbugQueryResultOrResults = lbug.QueryResult | lbug.QueryResult[];
type CachedEmbeddingRow = LbugProjectionRow & {
  nodeId?: unknown;
  chunkIndex?: unknown;
  startLine?: unknown;
  endLine?: unknown;
  embedding?: unknown;
  contentHash?: unknown;
};
type FTSNode = {
  [key: string]: unknown;
  nodeId?: unknown;
  id?: unknown;
  name?: unknown;
  filePath?: unknown;
};
type FTSQueryRow = LbugProjectionRow & {
  node?: unknown;
  score?: unknown;
};
type FTSQueryResult = {
  [key: string]: unknown;
  nodeId: string;
  name: string;
  filePath: string;
  score: number;
};

const isPlainObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  Object.prototype.toString.call(value) === '[object Object]';

const isLbugValue = (value: unknown): value is LbugValue => {
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
};

const toLbugParams = (params: LbugQueryParams): Record<string, LbugValue> => {
  const out: Record<string, LbugValue> = {};
  for (const [key, value] of Object.entries(params)) {
    if (!isLbugValue(value)) {
      throw new TypeError(`Invalid LadybugDB query parameter "${key}"`);
    }
    out[key] = value;
  }
  return out;
};

const isArrayLikeEmbedding = (value: unknown): value is ArrayLike<unknown> => {
  if (value === null || value === undefined || typeof value !== 'object') return false;
  const length = (value as { length?: unknown }).length;
  return typeof length === 'number' && Number.isSafeInteger(length) && length >= 0;
};

const isIterableEmbedding = (value: unknown): value is Iterable<unknown> => {
  if (value === null || value === undefined) return false;
  const iterator = (Object(value) as { [Symbol.iterator]?: unknown })[Symbol.iterator];
  return typeof iterator === 'function';
};

const toEmbeddingNumbers = (embedding: unknown): number[] | undefined => {
  if (Array.isArray(embedding)) return embedding.map(Number);
  if (isIterableEmbedding(embedding) || isArrayLikeEmbedding(embedding)) {
    return Array.from(embedding).map(Number);
  }
  return undefined;
};

// ---------------------------------------------------------------------------
// Relationship CSV splitting — extracted for testability (PR #818)
// ---------------------------------------------------------------------------

/** Factory for creating WriteStreams — injectable for testing. */
type WriteStreamFactory = (filePath: string) => import('fs').WriteStream;

/** Result of splitting the relationship CSV into per-label-pair files. */
interface RelCsvSplitResult {
  relHeader: string;
  relsByPairMeta: Map<string, { csvPath: string; rows: number }>;
  pairWriteStreams: Map<string, import('fs').WriteStream>;
  skippedRels: number;
  totalValidRels: number;
}

/**
 * Split a relationship CSV into per-label-pair files on disk.
 *
 * Streams the CSV line-by-line, routing each relationship to a file named
 * `rel_{fromLabel}_{toLabel}.csv`. Handles backpressure correctly: only one
 * drain listener per stream at a time, and readline resumes only when ALL
 * backpressured streams have drained.
 *
 * @param csvPath       Path to the combined relationship CSV
 * @param csvDir        Directory to write per-pair CSV files
 * @param validTables   Set of valid node table names
 * @param getNodeLabel  Function to extract the label from a node ID
 * @param wsFactory     Optional WriteStream factory (defaults to fs.createWriteStream)
 */
export const splitRelCsvByLabelPair = async (
  csvPath: string,
  csvDir: string,
  validTables: Set<string>,
  getNodeLabel: (id: string) => string,
  wsFactory: WriteStreamFactory = (p) => createWriteStream(p, 'utf-8'),
): Promise<RelCsvSplitResult> => {
  let relHeader = '';
  const relsByPairMeta = new Map<string, { csvPath: string; rows: number }>();
  const pairWriteStreams = new Map<string, import('fs').WriteStream>();
  let skippedRels = 0;
  let totalValidRels = 0;

  const inputStream = createReadStream(csvPath, 'utf-8');
  const rl = createInterface({ input: inputStream, crlfDelay: Infinity });

  // If any pair WriteStream errors (disk full, EMFILE, etc.) or the input
  // stream fails, we need to abort the pending `once(ws, 'drain')` await.
  // An AbortController gives us one signal to cancel all pending waits
  // without a custom state machine.
  const abortOnError = new AbortController();
  let streamError: Error | null = null;
  const markStreamError = (err: Error): void => {
    streamError ??= err;
    abortOnError.abort(err);
  };

  try {
    // `for await (const line of rl)` replaces the old manual
    // on('line')/pause()/resume()/waitingForDrain state machine: readline's
    // async iterator naturally serializes line delivery with our awaits, so
    // at most one ws can be in backpressure at a time and we just await its
    // 'drain' event.
    let isFirst = true;
    for await (const line of rl) {
      if (streamError) throw streamError;
      if (isFirst) {
        relHeader = line;
        isFirst = false;
        continue;
      }
      if (!line.trim()) continue;
      const match = line.match(/"([^"]*)","([^"]*)"/);
      if (!match) {
        skippedRels++;
        continue;
      }
      const fromLabel = getNodeLabel(match[1]);
      const toLabel = getNodeLabel(match[2]);
      if (!validTables.has(fromLabel) || !validTables.has(toLabel)) {
        skippedRels++;
        continue;
      }

      const pairKey = `${fromLabel}|${toLabel}`;
      let ws = pairWriteStreams.get(pairKey);
      if (!ws) {
        const pairCsvPath = path.join(csvDir, `rel_${fromLabel}_${toLabel}.csv`);
        ws = wsFactory(pairCsvPath);
        ws.on('error', markStreamError);
        pairWriteStreams.set(pairKey, ws);
        relsByPairMeta.set(pairKey, { csvPath: pairCsvPath, rows: 0 });
        if (!ws.write(relHeader + '\n')) {
          await once(ws, 'drain', { signal: abortOnError.signal });
        }
      }

      if (!ws.write(line + '\n')) {
        await once(ws, 'drain', { signal: abortOnError.signal });
      }
      relsByPairMeta.get(pairKey)!.rows++;
      totalValidRels++;
    }
    if (streamError) throw streamError;
  } catch (err) {
    // Tear down everything so no fd is left dangling. If the abort was caused
    // by a stream error, rethrow that error (more actionable than AbortError).
    for (const ws of pairWriteStreams.values()) ws.destroy();
    inputStream.destroy();
    throw streamError ?? err;
  } finally {
    // Readline 'close' fires before the underlying fs.ReadStream releases its
    // fd — on Windows that race caused ENOTEMPTY on the parent dir.
    // stream/promises.finished is the stdlib "wait until this stream is fully
    // closed" primitive and handles both success and error paths.
    await finished(inputStream).catch(() => {});
  }

  return { relHeader, relsByPairMeta, pairWriteStreams, skippedRels, totalValidRels };
};

let db: lbug.Database | null = null;
let conn: lbug.Connection | null = null;
let currentDbPath: string | null = null;
let ftsLoaded = false;
let vectorExtensionLoaded = false;

/**
 * In-process cache of FTS indexes that have been ensured against the current
 * connection. Prevents repeated `CALL CREATE_FTS_INDEX` round-trips inside a
 * single CLI/MCP session — the first call to `ensureFTSIndex` for a given
 * `(tableName, indexName)` pays the LadybugDB cost (~440 ms even when the
 * index already exists on disk), subsequent calls are a Set lookup. Cleared
 * by `closeLbug` so a re-init starts fresh.
 *
 * Key format: `${tableName}:${indexName}`.
 */
const ensuredFTSIndexes = new Set<string>();

/**
 * Check if an error indicates a missing column or table (schema-level problem)
 * rather than a transient/connection error. Used for legacy DB fallback logic.
 */
const isMissingColumnOrTableError = (msg: string): boolean =>
  msg.includes('does not exist') ||
  // Kuzu-specific: "(table|column|property) ... not found" — narrow enough to avoid
  // matching transient errors like "connection not found" or "key not found".
  /(table|column|property).*not found/i.test(msg);

const getThrownMessage = (err: unknown): string | undefined =>
  (err as { readonly message?: string }).message;

const getOptionalThrownMessage = (err: unknown): string | undefined =>
  err == null ? undefined : getThrownMessage(err);

// Maximum rows allowed from internal (non-exploratory) .getAll() calls.
// Exceeding this limit indicates an unexpectedly large result set; we throw
// rather than silently truncate to avoid data loss in callers that assume
// completeness.
const MAX_INTERNAL_ROWS = 50_000;
const MAX_CACHED_EMBEDDINGS = (() => {
  const raw = Number.parseInt(process.env.ONTOINDEX_MAX_CACHED_EMBEDDINGS ?? '', 10);
  return Number.isFinite(raw) ? Math.max(0, Math.min(raw, MAX_INTERNAL_ROWS - 1)) : 20_000;
})();
const MAX_EXISTING_EMBEDDING_HASHES = (() => {
  const raw = Number.parseInt(process.env.ONTOINDEX_MAX_EXISTING_EMBEDDING_HASHES ?? '', 10);
  return Number.isFinite(raw) ? Math.max(0, Math.min(raw, MAX_INTERNAL_ROWS - 1)) : 20_000;
})();

// Maximum time to wait for a single .getAll() call to return from the native
// driver. If the driver stalls (e.g. a hung query or native deadlock) without
// this boundary the process would hang forever.
const GET_ALL_TIMEOUT_MS = 30_000;

class LbugQueryTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LbugQueryTimeoutError';
  }
}

const retireTimedOutLbugSession = (): void => {
  const timedOutConn = conn;
  const timedOutDb = db;
  resetLbugSessionState(true);

  // Native getAll() cannot be cancelled. Quarantine the handles immediately so
  // later calls cannot reuse a connection that may still be busy, then close
  // them best-effort in the background.
  void (async () => {
    try {
      if (timedOutConn) await timedOutConn.close();
    } catch {
      /* best-effort */
    }
    try {
      if (timedOutDb) await timedOutDb.close();
    } catch {
      /* best-effort */
    }
  })();
};

async function withLbugNativeTimeout<T>(
  value: T | Promise<T>,
  label: string,
  timeoutMs = GET_ALL_TIMEOUT_MS,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  try {
    return await Promise.race([
      Promise.resolve(value).finally(() => {
        if (!timedOut) clearTimeout(timer);
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          reject(new LbugQueryTimeoutError(`[lbug] ${label} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } catch (err) {
    if (err instanceof LbugQueryTimeoutError) {
      retireTimedOutLbugSession();
    }
    throw err;
  }
}

async function getAllWithTimeout<TRow extends LbugProjectionRow = LbugProjectionRow>(
  result: lbug.QueryResult,
  label: string,
  timeoutMs = GET_ALL_TIMEOUT_MS,
): Promise<LbugProjectionRows<TRow>> {
  const rows = await withLbugNativeTimeout(result.getAll(), `${label} getAll`, timeoutMs);
  return rows as LbugProjectionRows<TRow>;
}

/** Expose the current Database for pool adapter reuse in tests. */
export const getDatabase = (): lbug.Database | null => db;

// Global session lock for operations that touch module-level lbug globals.
// This guarantees no DB switch can happen while an operation is running.
let sessionLock: Promise<void> = Promise.resolve();

/** Number of times to retry on a BUSY / lock-held error before giving up. */
const DB_LOCK_RETRY_ATTEMPTS = 3;
/** Base back-off in ms between BUSY retries (multiplied by attempt number). */
const DB_LOCK_RETRY_DELAY_MS = 500;

/**
 * Return true when the error message indicates that another process holds
 * an exclusive lock on the LadybugDB file (e.g. `ontoindex analyze` or
 * `ontoindex serve` running at the same time).
 */
export const isDbBusyError = (err: unknown): boolean => {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    msg.includes('busy') ||
    msg.includes('lock') ||
    msg.includes('already in use') ||
    msg.includes('could not set lock')
  );
};

const runWithSessionLock = async <T>(operation: () => Promise<T>): Promise<T> => {
  const previous = sessionLock;
  let release: (() => void) | null = null;
  sessionLock = new Promise<void>((resolve) => {
    release = resolve;
  });

  await previous;
  try {
    return await operation();
  } finally {
    release?.();
  }
};

const resetLbugSessionState = (clearEnsuredIndexes = false): void => {
  conn = null;
  db = null;
  currentDbPath = null;
  ftsLoaded = false;
  vectorExtensionLoaded = false;
  if (clearEnsuredIndexes) ensuredFTSIndexes.clear();
};

const closeActiveLbugHandles = async (clearEnsuredIndexes = false): Promise<void> => {
  try {
    if (conn) await conn.close();
  } catch {
    /* best-effort */
  }
  try {
    if (db) await db.close();
  } catch {
    /* best-effort */
  }
  resetLbugSessionState(clearEnsuredIndexes);
};

const normalizeCopyPath = (filePath: string): string => filePath.replace(/\\/g, '/');

export const initLbug = async (dbPath: string) => {
  return runWithSessionLock(() => ensureLbugInitialized(dbPath));
};

/**
 * Execute multiple queries against one repo DB atomically.
 * While the callback runs, no other request can switch the active DB.
 *
 * Automatically retries up to DB_LOCK_RETRY_ATTEMPTS times when the
 * database is busy (e.g. `ontoindex analyze` holds the write lock).
 * Each retry waits DB_LOCK_RETRY_DELAY_MS * attempt milliseconds.
 */
export const withLbugDb = async <T>(dbPath: string, operation: () => Promise<T>): Promise<T> => {
  let lastError: unknown;
  for (let attempt = 1; attempt <= DB_LOCK_RETRY_ATTEMPTS; attempt++) {
    try {
      return await runWithSessionLock(async () => {
        await ensureLbugInitialized(dbPath);
        return operation();
      });
    } catch (err) {
      lastError = err;
      if (!isDbBusyError(err) || attempt === DB_LOCK_RETRY_ATTEMPTS) {
        throw err;
      }
      // Close stale connection inside the session lock to prevent race conditions
      // with concurrent operations that might acquire the lock between cleanup steps
      await runWithSessionLock(async () => {
        await closeActiveLbugHandles();
      });
      // Sleep outside the lock — no need to block others while waiting
      await new Promise((resolve) => setTimeout(resolve, DB_LOCK_RETRY_DELAY_MS * attempt));
    }
  }
  // This line is unreachable — the loop either returns or throws inside,
  // but TypeScript needs an explicit throw to satisfy the return type.
  throw lastError;
};

const ensureLbugInitialized = async (dbPath: string) => {
  if (conn && currentDbPath === dbPath) {
    return { db, conn };
  }
  await doInitLbug(dbPath);
  return { db, conn };
};

const doInitLbug = async (dbPath: string) => {
  // Different database requested — close the old one first
  if (conn || db) {
    await closeActiveLbugHandles();
  }

  // LadybugDB stores the database as a single file (not a directory).
  // If the path already exists, it must be a valid LadybugDB database file.
  // Remove stale empty directories or files from older versions.
  try {
    const stat = await fs.lstat(dbPath);
    if (stat.isSymbolicLink()) {
      // Never follow symlinks — just remove the link itself
      await fs.unlink(dbPath);
    } else if (stat.isDirectory()) {
      // Verify path is within expected storage directory before deleting
      const realPath = await fs.realpath(dbPath);
      const parentDir = path.dirname(dbPath);
      const realParent = await fs.realpath(parentDir);
      if (!realPath.startsWith(realParent + path.sep) && realPath !== realParent) {
        throw new Error(
          `Refusing to delete ${dbPath}: resolved path ${realPath} is outside storage directory`,
        );
      }
      // Old-style directory database or empty leftover - remove it
      await fs.rm(dbPath, { recursive: true, force: true });
    }
    // If it's a file, assume it's an existing LadybugDB database - LadybugDB will open it
  } catch {
    // Path doesn't exist, which is what LadybugDB wants for a new database
  }

  // Ensure parent directory exists
  const parentDir = path.dirname(dbPath);
  await fs.mkdir(parentDir, { recursive: true });

  db = new lbug.Database(dbPath);
  conn = new lbug.Connection(db);

  for (const schemaQuery of SCHEMA_QUERIES) {
    try {
      await withLbugNativeTimeout(conn.query(schemaQuery), 'initLbug schema query');
    } catch (err) {
      if (err instanceof LbugQueryTimeoutError) throw err;
      // Only ignore "already exists" errors - log everything else
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes('already exists')) {
        console.warn(`⚠️ Schema creation warning: ${msg.slice(0, 120)}`);
      }
    }
  }

  // Load VECTOR extension for semantic search support
  await loadVectorExtension();

  currentDbPath = dbPath;
  return { db, conn };
};

export type LbugLoadProgressEvent =
  | {
      event: 'csv-start' | 'csv-end' | 'rel-split-start' | 'rel-split-end' | 'cleanup-start';
      durationMs?: number;
      nodeFileCount?: number;
      relationshipPairCount?: number;
      rows?: number;
      skippedRows?: number;
    }
  | {
      event: 'node-copy-start' | 'node-copy-end';
      table: string;
      rows: number;
      step: number;
      totalSteps: number;
      durationMs?: number;
    }
  | {
      event: 'edge-copy-start' | 'edge-copy-end';
      fromLabel: string;
      toLabel: string;
      rows: number;
      step: number;
      totalSteps: number;
      durationMs?: number;
    };

type LbugProgressCallback = (message: string, event?: LbugLoadProgressEvent) => void;

export const loadGraphToLbug = async (
  graph: KnowledgeGraph,
  repoPath: string,
  storagePath: string,
  onProgress?: LbugProgressCallback,
) => {
  if (!conn) {
    throw new Error('LadybugDB not initialized. Call initLbug first.');
  }

  const log = onProgress || (() => {});

  const csvDir = path.join(storagePath, 'csv');

  log('Streaming CSVs to disk...', { event: 'csv-start' });
  const csvStart = Date.now();
  const csvResult = await streamAllCSVsToDisk(graph, repoPath, csvDir);
  log('CSV streaming complete', {
    event: 'csv-end',
    durationMs: Date.now() - csvStart,
    nodeFileCount: csvResult.nodeFiles.size,
  });

  const validTables = new Set<string>(NODE_TABLES as readonly string[]);
  const getNodeLabel = (nodeId: string): string => {
    if (nodeId.startsWith('comm_')) return 'Community';
    if (nodeId.startsWith('proc_')) return 'Process';
    return nodeId.split(':')[0];
  };

  // Bulk COPY all node CSVs (sequential — LadybugDB allows only one write txn at a time)
  const nodeFiles = [...csvResult.nodeFiles.entries()];
  const totalSteps = nodeFiles.length + 1; // +1 for relationships
  let stepsDone = 0;

  for (const [table, { csvPath, rows }] of nodeFiles) {
    stepsDone++;
    log(`Loading nodes ${stepsDone}/${totalSteps}: ${table} (${rows.toLocaleString()} rows)`, {
      event: 'node-copy-start',
      table,
      rows,
      step: stepsDone,
      totalSteps,
    });
    const nodeCopyStart = Date.now();

    const normalizedPath = normalizeCopyPath(csvPath);
    const copyQuery = getCopyQuery(table, normalizedPath);

    try {
      await withLbugNativeTimeout(conn.query(copyQuery), `COPY ${table}`);
    } catch (err) {
      if (err instanceof LbugQueryTimeoutError) throw err;
      try {
        const retryQuery = copyQuery.replace(
          'auto_detect=false)',
          'auto_detect=false, IGNORE_ERRORS=true)',
        );
        await withLbugNativeTimeout(conn.query(retryQuery), `COPY ${table} retry`);
      } catch (retryErr) {
        const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
        throw new Error(`COPY failed for ${table}: ${retryMsg.slice(0, 200)}`);
      }
    }
    log(`Loaded nodes ${stepsDone}/${totalSteps}: ${table} (${rows.toLocaleString()} rows)`, {
      event: 'node-copy-end',
      table,
      rows,
      step: stepsDone,
      totalSteps,
      durationMs: Date.now() - nodeCopyStart,
    });
  }

  // Bulk COPY relationships — split by FROM→TO label pair (LadybugDB requires it)
  let finalRelsByPairMeta: Map<string, { csvPath: string; rows: number }>;
  let finalTotalValidRels: number;
  let finalRelHeader = 'fromId,toId,relType,confidence,reason,step';
  let finalSkippedRels = 0;

  if (csvResult.relCsvPath) {
    log('Splitting relationships by label pair...', { event: 'rel-split-start' });
    const relSplitStart = Date.now();
    const { relHeader, relsByPairMeta, pairWriteStreams, skippedRels, totalValidRels } =
      await splitRelCsvByLabelPair(csvResult.relCsvPath, csvDir, validTables, getNodeLabel);
    log('Relationship split complete', {
      event: 'rel-split-end',
      durationMs: Date.now() - relSplitStart,
      relationshipPairCount: relsByPairMeta.size,
      rows: totalValidRels,
      skippedRows: skippedRels,
    });

    // Close all per-pair write streams before COPY
    await Promise.all(
      Array.from(pairWriteStreams.values()).map(async (ws) => {
        ws.end();
        await finished(ws);
      }),
    );
    finalRelsByPairMeta = relsByPairMeta;
    finalTotalValidRels = totalValidRels;
    finalRelHeader = relHeader;
    finalSkippedRels = skippedRels;
  } else {
    // Native path: relationships are already split by the native writer.
    finalRelsByPairMeta = new Map();
    if (csvResult.relByPairMeta) {
      for (const [pairKey, rows] of csvResult.relByPairMeta) {
        const fromToSlug = pairKey.replace('|', '_to_');
        finalRelsByPairMeta.set(pairKey, {
          csvPath: path.join(csvDir, `rels_${fromToSlug}.csv`),
          rows,
        });
      }
    }
    finalTotalValidRels = csvResult.relRows;
  }

  const insertedRels = finalTotalValidRels;
  const warnings: string[] = [];
  if (insertedRels > 0) {
    log(`Loading edges: ${insertedRels.toLocaleString()} across ${finalRelsByPairMeta.size} types`);

    let pairIdx = 0;
    let failedPairEdges = 0;
    const failedPairCsvPaths = new Set<string>();

    for (const [pairKey, { csvPath: pairCsvPath, rows }] of finalRelsByPairMeta) {
      pairIdx++;
      const [fromLabel, toLabel] = pairKey.split('|');
      const normalizedPath = normalizeCopyPath(pairCsvPath);
      const copyQuery = `COPY ${REL_TABLE_NAME} FROM "${normalizedPath}" (from="${fromLabel}", to="${toLabel}", HEADER=true, ESCAPE='"', DELIM=',', QUOTE='"', PARALLEL=false, auto_detect=false)`;

      if (pairIdx % 5 === 0 || rows > 1000) {
        log(
          `Loading edges: ${pairIdx}/${finalRelsByPairMeta.size} types (${fromLabel} -> ${toLabel})`,
        );
      }
      log(`Loading edges: ${pairIdx}/${finalRelsByPairMeta.size} (${fromLabel} -> ${toLabel})`, {
        event: 'edge-copy-start',
        fromLabel,
        toLabel,
        rows,
        step: pairIdx,
        totalSteps: finalRelsByPairMeta.size,
      });
      const edgeCopyStart = Date.now();

      // Preflight check: if this pair is NOT in the schema, LadybugDB COPY will fail
      // with a cryptic internal error. Route directly to row-by-row fallback.
      if (!validRelPairs.has(pairKey)) {
        failedPairEdges += rows;
        failedPairCsvPaths.add(pairCsvPath);
        continue;
      }

      try {
        await withLbugNativeTimeout(conn.query(copyQuery), `COPY relationships ${pairKey}`);
      } catch (err) {
        if (err instanceof LbugQueryTimeoutError) throw err;
        try {
          const retryQuery = copyQuery.replace(
            'auto_detect=false)',
            'auto_detect=false, IGNORE_ERRORS=true)',
          );
          await withLbugNativeTimeout(
            conn.query(retryQuery),
            `COPY relationships ${pairKey} retry`,
          );
        } catch (retryErr) {
          const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
          warnings.push(`${fromLabel}->${toLabel} (${rows} edges): ${retryMsg.slice(0, 80)}`);
          failedPairEdges += rows;
          failedPairCsvPaths.add(pairCsvPath);
        }
      }
      // Only delete if not in failedPairCsvPaths (needed for fallback)
      if (!failedPairCsvPaths.has(pairCsvPath)) {
        try {
          await fs.unlink(pairCsvPath);
        } catch {}
      }
      log(`Loaded edges: ${pairIdx}/${finalRelsByPairMeta.size} (${fromLabel} -> ${toLabel})`, {
        event: 'edge-copy-end',
        fromLabel,
        toLabel,
        rows,
        step: pairIdx,
        totalSteps: finalRelsByPairMeta.size,
        durationMs: Date.now() - edgeCopyStart,
      });
    }

    if (failedPairCsvPaths.size > 0) {
      if (failedPairEdges > 1000) {
        throw new Error(
          `Bulk edge COPY failed for ${failedPairEdges} edges. Individual insert fallback is disabled for sets > 1000 to prevent extreme slowdown. ` +
            'Check your schema label-pairs or reduce the number of missing relationships.',
        );
      }

      log(`Inserting ${failedPairEdges} edges individually (missing schema pairs)`);
      // Read failed pair files and merge for fallback inserts
      const allLines: string[] = [finalRelHeader];
      for (const failedPath of failedPairCsvPaths) {
        try {
          const content = await fs.readFile(failedPath, 'utf-8');
          const lines = content.split('\n');
          // Skip header line (first) and empty lines
          for (let i = 1; i < lines.length; i++) {
            if (lines[i].trim()) allLines.push(lines[i]);
          }
        } catch {}
        try {
          await fs.unlink(failedPath);
        } catch {}
      }
      if (allLines.length > 1) {
        await fallbackRelationshipInserts(allLines, validTables, getNodeLabel);
      }
    }
  }

  // Cleanup all CSVs
  if (process.env.ONTOINDEX_DEBUG_LBUG !== '1') {
    log('Cleaning up CSVs...', { event: 'cleanup-start' });
    if (csvResult.relCsvPath) {
      try {
        await fs.unlink(csvResult.relCsvPath);
      } catch {}
    }
    for (const [, { csvPath }] of csvResult.nodeFiles) {
      try {
        await fs.unlink(csvPath);
      } catch {}
    }
    try {
      const remaining = await fs.readdir(csvDir);
      for (const f of remaining) {
        try {
          await fs.unlink(path.join(csvDir, f));
        } catch {}
      }
    } catch {}
    try {
      await fs.rmdir(csvDir);
    } catch {}
  } else {
    log(`[debug] Preservation mode: CSVs remain in ${csvDir}`);
  }

  return { success: true, insertedRels, skippedRels: finalSkippedRels, warnings };
};

// LadybugDB default ESCAPE is '\' (backslash), but our CSV uses RFC 4180 escaping ("" for literal quotes).
// Source code content is full of backslashes which confuse the auto-detection.
// We MUST explicitly set ESCAPE='"' to use RFC 4180 escaping, and disable auto_detect to prevent
// LadybugDB from overriding our settings based on sample rows.
const COPY_CSV_OPTS = `(HEADER=true, ESCAPE='"', DELIM=',', QUOTE='"', PARALLEL=false, auto_detect=false)`;

// Multi-language table names that were created with backticks in CODE_ELEMENT_BASE
// and must always be referenced with backticks in queries
const BACKTICK_TABLES = new Set([
  'Struct',
  'Enum',
  'Macro',
  'Typedef',
  'Union',
  'Namespace',
  'Trait',
  'Impl',
  'TypeAlias',
  'Const',
  'Static',
  'Property',
  'Record',
  'Delegate',
  'Annotation',
  'Constructor',
  'Template',
  'Module',
]);

const escapeTableName = (table: string): string => {
  return BACKTICK_TABLES.has(table) ? `\`${table}\`` : table;
};

/** Fallback: insert relationships one-by-one if COPY fails */
const fallbackRelationshipInserts = async (
  validRelLines: string[],
  validTables: Set<string>,
  getNodeLabel: (id: string) => string,
) => {
  if (!conn) return;
  const escapeLabel = (label: string): string => {
    return BACKTICK_TABLES.has(label) ? `\`${label}\`` : label;
  };

  for (let i = 1; i < validRelLines.length; i++) {
    const line = validRelLines[i];
    try {
      const match = line.match(/"([^"]*)","([^"]*)","([^"]*)",([0-9.]+),"([^"]*)",([0-9-]+)/);
      if (!match) continue;
      const [, fromId, toId, relType, confidenceStr, reason, stepStr] = match;
      const fromLabel = getNodeLabel(fromId);
      const toLabel = getNodeLabel(toId);
      if (!validTables.has(fromLabel) || !validTables.has(toLabel)) continue;

      const confidence = parseFloat(confidenceStr) || 1.0;
      const step = parseInt(stepStr) || 0;

      const esc = (s: string) =>
        s.replace(/'/g, "''").replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/\r/g, '\\r');
      await withLbugNativeTimeout(
        conn.query(`
          MATCH (a:${escapeLabel(fromLabel)} {id: '${esc(fromId)}' }),
                (b:${escapeLabel(toLabel)} {id: '${esc(toId)}' })
          CREATE (a)-[:${REL_TABLE_NAME} {type: '${esc(relType)}', confidence: ${confidence}, reason: '${esc(reason)}', step: ${step}}]->(b)
        `),
        'fallbackRelationshipInserts query',
      );
    } catch {
      // skip
    }
  }
};

/** Tables with isExported column (TypeScript/JS-native types) */
const TABLES_WITH_EXPORTED = new Set<string>([
  'Function',
  'Class',
  'Interface',
  'Method',
  'CodeElement',
  'Const',
]);

export const getCopyQuery = (table: NodeTableName, filePath: string): string => {
  const t = escapeTableName(table);
  if (table === 'File') {
    return `COPY ${t}(id, name, filePath, content) FROM "${filePath}" ${COPY_CSV_OPTS}`;
  }
  if (table === 'Folder') {
    return `COPY ${t}(id, name, filePath) FROM "${filePath}" ${COPY_CSV_OPTS}`;
  }
  if (table === 'Community') {
    return `COPY ${t}(id, label, heuristicLabel, keywords, description, enrichedBy, cohesion, symbolCount) FROM "${filePath}" ${COPY_CSV_OPTS}`;
  }
  if ((table as any) === 'Concept') {
    return `COPY ${t}(id, name, filePath, aliases, sourceDocuments, sourceFactKeys, resolutionKeys, authority, confidence, evidenceClass, freshness) FROM "${filePath}" ${COPY_CSV_OPTS}`;
  }
  if (table === 'Process') {
    return `COPY ${t}(id, label, heuristicLabel, processType, stepCount, communities, entryPointId, terminalId) FROM "${filePath}" ${COPY_CSV_OPTS}`;
  }
  if (table === 'Section') {
    return `COPY ${t}(id, name, filePath, startLine, endLine, level, content, description) FROM "${filePath}" ${COPY_CSV_OPTS}`;
  }
  if (table === 'Route') {
    return `COPY ${t}(id, name, filePath, responseKeys, errorKeys, middleware) FROM "${filePath}" ${COPY_CSV_OPTS}`;
  }
  if (table === 'Tool') {
    return `COPY ${t}(id, name, filePath, description) FROM "${filePath}" ${COPY_CSV_OPTS}`;
  }
  if (table === 'Method') {
    return `COPY ${t}(id, name, filePath, startLine, endLine, isExported, content, description, parameterCount, returnType, declarationFilePath, declarationStartLine, declarationEndLine, definitionFilePath, definitionStartLine, definitionEndLine) FROM "${filePath}" ${COPY_CSV_OPTS}`;
  }
  // TypeScript/JS code element tables have isExported; multi-language tables do not
  if (TABLES_WITH_EXPORTED.has(table)) {
    return `COPY ${t}(id, name, filePath, startLine, endLine, isExported, content, description) FROM "${filePath}" ${COPY_CSV_OPTS}`;
  }
  // Multi-language tables (Struct, Impl, Trait, Macro, etc.)
  return `COPY ${t}(id, name, filePath, startLine, endLine, content, description) FROM "${filePath}" ${COPY_CSV_OPTS}`;
};

/**
 * Insert a single node to LadybugDB
 * @param label - Node type (File, Function, Class, etc.)
 * @param properties - Node properties
 * @param dbPath - Path to LadybugDB database (optional if already initialized)
 */
const insertNodeToLbug = async (
  label: string,
  properties: LbugNodeProperties,
  dbPath?: string,
): Promise<boolean> => {
  // Use provided dbPath or fall back to module-level db
  const targetDbPath = dbPath || (db ? undefined : null);
  if (!targetDbPath && !db) {
    throw new Error('LadybugDB not initialized. Provide dbPath or call initLbug first.');
  }

  try {
    const escapeValue = (v: unknown): string => {
      if (v === null || v === undefined) return 'NULL';
      if (typeof v === 'number') return String(v);
      if (Array.isArray(v)) {
        return `[${v.map((item) => escapeValue(item)).join(', ')}]`;
      }
      // Escape backslashes first (for Windows paths), then single quotes
      return `'${String(v).replace(/\\/g, '\\\\').replace(/'/g, "''").replace(/\n/g, '\\n').replace(/\r/g, '\\r')}'`;
    };

    // Build INSERT query based on node type
    const t = escapeTableName(label);
    let query: string;

    if (label === 'File') {
      query = `CREATE (n:File {id: ${escapeValue(properties.id)}, name: ${escapeValue(properties.name)}, filePath: ${escapeValue(properties.filePath)}, content: ${escapeValue(properties.content || '')}})`;
    } else if (label === 'Folder') {
      query = `CREATE (n:Folder {id: ${escapeValue(properties.id)}, name: ${escapeValue(properties.name)}, filePath: ${escapeValue(properties.filePath)}})`;
    } else if (label === 'Concept') {
      query = `CREATE (n:Concept {id: ${escapeValue(properties.id)}, name: ${escapeValue(properties.name)}, aliases: ${escapeValue(properties.aliases || [])}, authority: ${escapeValue(properties.authority)}, confidence: ${escapeValue(properties.confidence)}, evidenceClass: ${escapeValue(properties.evidenceClass)}, freshness: ${escapeValue(properties.freshness)}})`;
    } else if (label === 'Section') {
      const descPart = properties.description
        ? `, description: ${escapeValue(properties.description)}`
        : '';
      query = `CREATE (n:Section {id: ${escapeValue(properties.id)}, name: ${escapeValue(properties.name)}, filePath: ${escapeValue(properties.filePath)}, startLine: ${properties.startLine || 0}, endLine: ${properties.endLine || 0}, level: ${properties.level || 1}, content: ${escapeValue(properties.content || '')}${descPart}})`;
    } else if (TABLES_WITH_EXPORTED.has(label)) {
      const descPart = properties.description
        ? `, description: ${escapeValue(properties.description)}`
        : '';
      query = `CREATE (n:${t} {id: ${escapeValue(properties.id)}, name: ${escapeValue(properties.name)}, filePath: ${escapeValue(properties.filePath)}, startLine: ${properties.startLine || 0}, endLine: ${properties.endLine || 0}, isExported: ${!!properties.isExported}, content: ${escapeValue(properties.content || '')}${descPart}})`;
    } else {
      // Multi-language tables (Struct, Impl, Trait, Macro, etc.) — no isExported
      const descPart = properties.description
        ? `, description: ${escapeValue(properties.description)}`
        : '';
      query = `CREATE (n:${t} {id: ${escapeValue(properties.id)}, name: ${escapeValue(properties.name)}, filePath: ${escapeValue(properties.filePath)}, startLine: ${properties.startLine || 0}, endLine: ${properties.endLine || 0}, content: ${escapeValue(properties.content || '')}${descPart}})`;
    }

    // Use per-query connection if dbPath provided (avoids lock conflicts)
    if (targetDbPath) {
      const tempDb = new lbug.Database(targetDbPath);
      const tempConn = new lbug.Connection(tempDb);
      try {
        await withLbugNativeTimeout(tempConn.query(query), 'insertNodeToLbug temp query');
        return true;
      } finally {
        try {
          await tempConn.close();
        } catch {}
        try {
          await tempDb.close();
        } catch {}
      }
    } else if (conn) {
      // Use existing persistent connection (when called from analyze)
      await withLbugNativeTimeout(conn.query(query), 'insertNodeToLbug query');
      return true;
    }

    return false;
  } catch (e: unknown) {
    // Node may already exist or other error
    console.error(`Failed to insert ${label} node:`, getThrownMessage(e));
    return false;
  }
};

export const executeQuery = async <TRow extends LbugProjectionRow = LbugProjectionRow>(
  cypher: string,
): Promise<LbugProjectionRows<TRow>> => {
  if (!conn) {
    throw new Error('LadybugDB not initialized. Call initLbug first.');
  }

  const queryResult = await withLbugNativeTimeout(conn.query(cypher), 'executeQuery query');
  // LadybugDB uses getAll() instead of hasNext()/getNext()
  // Query returns QueryResult for single queries, QueryResult[] for multi-statement
  const result = Array.isArray(queryResult) ? queryResult[0] : queryResult;
  const rows = await getAllWithTimeout<TRow>(result, 'executeQuery');
  if (rows.length >= MAX_INTERNAL_ROWS) {
    throw new Error(
      `[lbug] executeQuery result exceeded ${MAX_INTERNAL_ROWS} rows - refusing to truncate internal data.`,
    );
  }
  return rows as LbugProjectionRows<TRow>;
};

export const streamQuery = async <TRow extends LbugProjectionRow = LbugProjectionRow>(
  cypher: string,
  onRow: (row: TRow) => void | Promise<void>,
  signal?: AbortSignal,
): Promise<number> => {
  if (!conn) {
    throw new Error('LadybugDB not initialized. Call initLbug first.');
  }

  const throwIfAborted = () => {
    if (!signal?.aborted) return;
    const err = new Error('LadybugDB stream query aborted');
    err.name = 'AbortError';
    throw err;
  };

  throwIfAborted();
  const queryResult = await withLbugNativeTimeout(conn.query(cypher), 'streamQuery query');
  const result = Array.isArray(queryResult) ? queryResult[0] : queryResult;
  let rowCount = 0;

  try {
    while (await withLbugNativeTimeout(result.hasNext(), 'streamQuery hasNext')) {
      throwIfAborted();
      const row = await withLbugNativeTimeout(result.getNext(), 'streamQuery getNext');
      throwIfAborted();
      await onRow(row as unknown as TRow);
      rowCount++;
      throwIfAborted();
    }
    return rowCount;
  } finally {
    try {
      await withLbugNativeTimeout(result.close(), 'streamQuery close');
    } catch {
      // Best-effort cleanup only.
    }
  }
};

/**
 * Execute a single parameterized query (prepare/execute pattern).
 * Prevents Cypher injection by binding values as parameters.
 */
export const executePrepared = async <TRow extends LbugProjectionRow = LbugProjectionRow>(
  cypher: string,
  params: LbugQueryParams,
): Promise<LbugProjectionRows<TRow>> => {
  if (!conn) {
    throw new Error('LadybugDB not initialized. Call initLbug first.');
  }
  const stmt = await withLbugNativeTimeout(conn.prepare(cypher), 'executePrepared prepare');
  if (!stmt.isSuccess()) {
    const errMsg = await withLbugNativeTimeout(
      stmt.getErrorMessage(),
      'executePrepared prepare error message',
    );
    throw new Error(`Prepare failed: ${errMsg}`);
  }
  const queryResult = await withLbugNativeTimeout(
    conn.execute(stmt, toLbugParams(params)),
    'executePrepared execute',
  );
  const result = Array.isArray(queryResult) ? queryResult[0] : queryResult;
  const rows = await getAllWithTimeout<TRow>(result, 'executePrepared');
  if (rows.length >= MAX_INTERNAL_ROWS) {
    throw new Error(
      `[lbug] executePrepared result exceeded ${MAX_INTERNAL_ROWS} rows — refusing to truncate internal data.`,
    );
  }
  return rows;
};

export const executeWithReusedStatement = async (
  cypher: string,
  paramsList: ReadonlyArray<LbugQueryParams>,
): Promise<void> => {
  if (!conn) {
    throw new Error('LadybugDB not initialized. Call initLbug first.');
  }
  if (paramsList.length === 0) return;

  const SUB_BATCH_SIZE = 4;
  const batchErrors: unknown[] = [];
  for (let i = 0; i < paramsList.length; i += SUB_BATCH_SIZE) {
    const subBatch = paramsList.slice(i, i + SUB_BATCH_SIZE);
    const stmt = await withLbugNativeTimeout(
      conn.prepare(cypher),
      'executeWithReusedStatement prepare',
    );
    if (!stmt.isSuccess()) {
      const errMsg = await withLbugNativeTimeout(
        stmt.getErrorMessage(),
        'executeWithReusedStatement prepare error message',
      );
      throw new Error(`Prepare failed: ${errMsg}`);
    }
    try {
      for (const params of subBatch) {
        await withLbugNativeTimeout(
          conn.execute(stmt, toLbugParams(params)),
          'executeWithReusedStatement execute',
        );
      }
    } catch (e) {
      // Log the error and continue with next batch
      console.warn('Batch execution error:', e);
      batchErrors.push(e);
    }
    // Note: LadybugDB PreparedStatement doesn't require explicit close()
  }
  if (batchErrors.length > 0) {
    throw new Error(
      `[lbug] executeWithReusedStatement: ${batchErrors.length} of ${Math.ceil(paramsList.length / SUB_BATCH_SIZE)} sub-batch(es) failed`,
    );
  }
};

export const getLbugStats = async (): Promise<{ nodes: number; edges: number }> => {
  if (!conn) return { nodes: 0, edges: 0 };

  let totalNodes = 0;
  for (const tableName of NODE_TABLES) {
    try {
      const queryResult = await withLbugNativeTimeout(
        conn.query(`MATCH (n:${escapeTableName(tableName)}) RETURN count(n) AS cnt`),
        `getLbugStats nodes ${tableName}`,
      );
      const nodeResult = Array.isArray(queryResult) ? queryResult[0] : queryResult;
      const nodeRows = await getAllWithTimeout(nodeResult, 'getLbugStats/nodes');
      if (nodeRows.length > 0) {
        totalNodes += Number(nodeRows[0]?.cnt ?? nodeRows[0]?.[0] ?? 0);
      }
    } catch {
      // ignore
    }
  }

  let totalEdges = 0;
  try {
    const queryResult = await withLbugNativeTimeout(
      conn.query(`MATCH ()-[r:${REL_TABLE_NAME}]->() RETURN count(r) AS cnt`),
      'getLbugStats edges',
    );
    const edgeResult = Array.isArray(queryResult) ? queryResult[0] : queryResult;
    const edgeRows = await getAllWithTimeout(edgeResult, 'getLbugStats/edges');
    if (edgeRows.length > 0) {
      totalEdges = Number(edgeRows[0]?.cnt ?? edgeRows[0]?.[0] ?? 0);
    }
  } catch {
    // ignore
  }

  return { nodes: totalNodes, edges: totalEdges };
};

/**
 * Load cached embeddings from LadybugDB before a rebuild.
 * Returns all embedding vectors so they can be re-inserted after the graph is reloaded,
 * avoiding expensive re-embedding of unchanged nodes.
 *
 * Detects old schema (no chunkIndex column) and returns empty cache to trigger rebuild.
 */
export const loadCachedEmbeddings = async (): Promise<{
  embeddingNodeIds: Set<string>;
  embeddings: CachedEmbedding[];
}> => {
  if (!conn) {
    return { embeddingNodeIds: new Set(), embeddings: [] };
  }

  const embeddingNodeIds = new Set<string>();
  const embeddings: CachedEmbedding[] = [];
  try {
    // Schema migration detection: query with new columns to verify schema version.
    // Old schema only had (nodeId, embedding); new schema adds (id, chunkIndex, startLine, endLine, contentHash).
    // If the query fails (column missing), we return empty cache to force a full rebuild.
    try {
      const check = await withLbugNativeTimeout(
        conn.query(
          `MATCH (e:${EMBEDDING_TABLE_NAME}) RETURN e.nodeId AS nodeId, e.chunkIndex AS chunkIndex LIMIT 1`,
        ),
        'loadCachedEmbeddings check query',
      );
      const checkResult = Array.isArray(check) ? check[0] : check;
      const checkRows = await getAllWithTimeout(checkResult, 'loadCachedEmbeddings/check');
      if (checkRows.length >= MAX_INTERNAL_ROWS) {
        throw new Error(
          `[lbug] loadCachedEmbeddings(check) result exceeded ${MAX_INTERNAL_ROWS} rows — refusing to truncate internal data.`,
        );
      }
    } catch (e: unknown) {
      if (getOptionalThrownMessage(e)?.startsWith('[lbug]')) throw e;
      return { embeddingNodeIds: new Set(), embeddings: [] };
    }

    const countQuery = await withLbugNativeTimeout(
      conn.query(`MATCH (e:${EMBEDDING_TABLE_NAME}) RETURN count(e) AS count`),
      'loadCachedEmbeddings count query',
    );
    const countResult = Array.isArray(countQuery) ? countQuery[0] : countQuery;
    const countRows = await getAllWithTimeout(countResult, 'loadCachedEmbeddings/count');
    const cachedRowCount = Number(countRows[0]?.count ?? countRows[0]?.[0] ?? 0);
    if (cachedRowCount > MAX_CACHED_EMBEDDINGS) {
      console.warn(
        `[lbug] Skipping cached embedding restore for ${cachedRowCount} rows; cap is ${MAX_CACHED_EMBEDDINGS}. ` +
          'Re-embedding avoids loading all vectors into memory.',
      );
      return { embeddingNodeIds: new Set(), embeddings: [] };
    }

    // Try to read contentHash alongside chunk columns
    let rows: LbugQueryResultOrResults;
    let hasContentHash = true;
    try {
      rows = await withLbugNativeTimeout(
        conn.query(
          `MATCH (e:${EMBEDDING_TABLE_NAME}) RETURN e.nodeId AS nodeId, e.chunkIndex AS chunkIndex, e.startLine AS startLine, e.endLine AS endLine, e.embedding AS embedding, e.contentHash AS contentHash`,
        ),
        'loadCachedEmbeddings query',
      );
    } catch (err: unknown) {
      // Fallback for legacy DBs without contentHash column
      const msg = getOptionalThrownMessage(err) ?? '';
      if (isMissingColumnOrTableError(msg)) {
        hasContentHash = false;
        rows = await withLbugNativeTimeout(
          conn.query(
            `MATCH (e:${EMBEDDING_TABLE_NAME}) RETURN e.nodeId AS nodeId, e.chunkIndex AS chunkIndex, e.startLine AS startLine, e.endLine AS endLine, e.embedding AS embedding`,
          ),
          'loadCachedEmbeddings legacy query',
        );
      } else {
        throw err;
      }
    }
    const result = Array.isArray(rows) ? rows[0] : rows;
    const embeddingRows = await getAllWithTimeout<CachedEmbeddingRow>(
      result,
      'loadCachedEmbeddings',
    );
    if (embeddingRows.length >= MAX_INTERNAL_ROWS) {
      throw new Error(
        `[lbug] loadCachedEmbeddings result exceeded ${MAX_INTERNAL_ROWS} rows — refusing to truncate internal data.`,
      );
    }
    for (const row of embeddingRows) {
      const nodeId = String(row.nodeId ?? row[0] ?? '');
      if (!nodeId) continue;
      embeddingNodeIds.add(nodeId);
      const embedding = row.embedding ?? row[4];
      if (embedding) {
        const embeddingNumbers = toEmbeddingNumbers(embedding);
        if (!embeddingNumbers) continue;
        embeddings.push({
          nodeId,
          chunkIndex: Number(row.chunkIndex ?? row[1] ?? 0),
          startLine: Number(row.startLine ?? row[2] ?? 0),
          endLine: Number(row.endLine ?? row[3] ?? 0),
          embedding: embeddingNumbers,
          contentHash: hasContentHash
            ? ((row.contentHash ?? row[5] ?? undefined) as string | undefined)
            : undefined,
        });
      }
    }
  } catch {
    /* embedding table may not exist */
  }

  return { embeddingNodeIds, embeddings };
};

/**
 * Fetch existing embedding hashes from CodeEmbedding table for incremental embedding.
 * Returns a Map<nodeId, contentHash> suitable for passing to `runEmbeddingPipeline`.
 * Handles legacy DBs without the `contentHash` column (all rows treated as stale with empty hash).
 * Returns undefined if the CodeEmbedding table does not exist.
 *
 * @param execQuery - Cypher query executor (typically pool-adapter's `executeQuery`)
 */
export const fetchExistingEmbeddingHashes = async (
  execQuery: (cypher: string) => Promise<LbugProjectionRows>,
): Promise<Map<string, string> | undefined> => {
  try {
    const countRows = await execQuery(`MATCH (e:${EMBEDDING_TABLE_NAME}) RETURN count(e) AS count`);
    const existingRowCount = Number(
      countRows[0]?.count ?? countRows[0]?.cnt ?? countRows[0]?.[0] ?? 0,
    );
    if (existingRowCount > MAX_EXISTING_EMBEDDING_HASHES) {
      console.warn(
        `[embed] Skipping incremental hash lookup for ${existingRowCount} embedding rows; cap is ${MAX_EXISTING_EMBEDDING_HASHES}. ` +
          'Full re-embedding avoids loading all hashes into memory.',
      );
      return undefined;
    }

    const rows = await execQuery(
      `MATCH (e:${EMBEDDING_TABLE_NAME}) RETURN e.nodeId AS nodeId, e.chunkIndex AS chunkIndex, e.startLine AS startLine, e.endLine AS endLine, e.contentHash AS contentHash`,
    );
    if (!rows || rows.length === 0) return undefined;
    const map = new Map<string, string>();
    for (const r of rows) {
      const nodeId = r.nodeId ?? r[0];
      const chunkIndex = r.chunkIndex ?? r[1];
      const startLine = r.startLine ?? r[2];
      const endLine = r.endLine ?? r[3];
      const hash = r.contentHash ?? r[4] ?? STALE_HASH_SENTINEL;
      if (nodeId) {
        const hasChunkMetadata =
          chunkIndex !== undefined &&
          chunkIndex !== null &&
          startLine !== undefined &&
          startLine !== null &&
          endLine !== undefined &&
          endLine !== null;
        // Empty/null contentHash or missing chunk metadata means legacy row — treat as stale.
        map.set(
          nodeId as string,
          (hasChunkMetadata && hash ? hash : STALE_HASH_SENTINEL) as string,
        );
      }
    }
    return map;
  } catch (err: unknown) {
    const msg = getOptionalThrownMessage(err) ?? '';
    if (isMissingColumnOrTableError(msg)) {
      // Legacy rows missing chunk-aware columns — treat every row as stale.
      try {
        const rows = await execQuery(`MATCH (e:${EMBEDDING_TABLE_NAME}) RETURN e.nodeId AS nodeId`);
        if (!rows || rows.length === 0) return undefined;
        const map = new Map<string, string>();
        for (const r of rows) {
          const nodeId = r.nodeId ?? r[0];
          if (nodeId) map.set(nodeId as string, STALE_HASH_SENTINEL);
        }
        console.log(
          `[embed] ${map.size} nodes in legacy DB (missing chunk-aware columns) — all treated as stale`,
        );
        return map;
      } catch (fallbackErr: unknown) {
        const fallbackMsg = getOptionalThrownMessage(fallbackErr) ?? '';
        if (isMissingColumnOrTableError(fallbackMsg)) {
          console.log(
            `[embed] CodeEmbedding table not yet present — full embedding run (${fallbackMsg})`,
          );
          return undefined;
        }
        throw fallbackErr;
      }
    }
    throw err;
  }
};

export const closeLbug = async (): Promise<void> => {
  await closeActiveLbugHandles(true);
};

export const closeLbugForPath = async (dbPath: string): Promise<void> => {
  await runWithSessionLock(async () => {
    if (currentDbPath === dbPath) {
      await closeActiveLbugHandles(true);
    }
  });
};

export const isLbugReady = (): boolean => conn !== null && db !== null;

/**
 * Delete all nodes (and their relationships) for a specific file from LadybugDB
 * @param filePath - The file path to delete nodes for
 * @param dbPath - Optional path to LadybugDB for per-query connection
 * @returns Object with counts of deleted nodes
 */
export const deleteNodesForFile = async (
  filePath: string,
  dbPath?: string,
): Promise<{ deletedNodes: number }> => {
  const usePerQuery = !!dbPath;

  // Set up connection (either use existing or create per-query)
  let tempDb: lbug.Database | null = null;
  let tempConn: lbug.Connection | null = null;
  let targetConn: lbug.Connection | null = conn;

  if (usePerQuery) {
    tempDb = new lbug.Database(dbPath);
    tempConn = new lbug.Connection(tempDb);
    targetConn = tempConn;
  } else if (!conn) {
    throw new Error('LadybugDB not initialized. Provide dbPath or call initLbug first.');
  }

  try {
    let deletedNodes = 0;
    const escapedPath = filePath.replace(/'/g, "''");

    // Delete nodes from each table that has filePath
    // DETACH DELETE removes the node and all its relationships
    for (const tableName of NODE_TABLES) {
      // Skip tables that don't have filePath (Community, Process)
      if (tableName === 'Community' || tableName === 'Process') continue;

      try {
        // First count how many we'll delete
        const tn = escapeTableName(tableName);
        const countResult = await withLbugNativeTimeout(
          targetConn!.query(
            `MATCH (n:${tn}) WHERE n.filePath = '${escapedPath}' RETURN count(n) AS cnt`,
          ),
          `deleteNodesForFile count ${tableName}`,
        );
        const result = Array.isArray(countResult) ? countResult[0] : countResult;
        const deleteCountRows = await getAllWithTimeout(result, 'deleteNodesForFile');
        if (deleteCountRows.length >= MAX_INTERNAL_ROWS) {
          throw new Error(
            `[lbug] deleteNodesForFile result exceeded ${MAX_INTERNAL_ROWS} rows — refusing to truncate internal data.`,
          );
        }
        const count = Number(deleteCountRows[0]?.cnt ?? deleteCountRows[0]?.[0] ?? 0);

        if (count > 0) {
          // Delete nodes (and implicitly their relationships via DETACH)
          await withLbugNativeTimeout(
            targetConn!.query(
              `MATCH (n:${tn}) WHERE n.filePath = '${escapedPath}' DETACH DELETE n`,
            ),
            `deleteNodesForFile delete ${tableName}`,
          );
          deletedNodes += count;
        }
      } catch (e) {
        // Some tables may not support this query, skip
      }
    }

    // Also delete any embeddings for nodes in this file
    try {
      await withLbugNativeTimeout(
        targetConn!.query(
          `MATCH (e:${EMBEDDING_TABLE_NAME}) WHERE e.nodeId STARTS WITH '${escapedPath}' DELETE e`,
        ),
        'deleteNodesForFile embeddings',
      );
    } catch {
      // Embedding table may not exist or nodeId format may differ
    }

    return { deletedNodes };
  } finally {
    // Close per-query connection if used
    if (tempConn) {
      try {
        await tempConn.close();
      } catch {}
    }
    if (tempDb) {
      try {
        await tempDb.close();
      } catch {}
    }
  }
};

const getEmbeddingTableName = (): string => EMBEDDING_TABLE_NAME;

// ============================================================================
// Full-Text Search (FTS) Functions
// ============================================================================

/**
 * Load the FTS extension (required before using FTS functions).
 * Safe to call multiple times — tracks loaded state via module-level ftsLoaded.
 */
export const loadFTSExtension = async (): Promise<void> => {
  if (ftsLoaded) return;
  if (!conn) {
    throw new Error('LadybugDB not initialized. Call initLbug first.');
  }
  try {
    // Try loading locally first (no network required)
    await withLbugNativeTimeout(conn.query('LOAD EXTENSION fts'), 'LOAD EXTENSION fts');
    ftsLoaded = true;
  } catch (err) {
    if (err instanceof LbugQueryTimeoutError) throw err;
    // Fall back to install + load (requires network)
    try {
      await withLbugNativeTimeout(conn.query('INSTALL fts'), 'INSTALL fts');
      await withLbugNativeTimeout(conn.query('LOAD EXTENSION fts'), 'LOAD EXTENSION fts retry');
      ftsLoaded = true;
    } catch (err: unknown) {
      const msg = getOptionalThrownMessage(err) || '';
      if (
        msg.includes('already loaded') ||
        msg.includes('already installed') ||
        msg.includes('already exists')
      ) {
        ftsLoaded = true;
      } else {
        console.error('OntoIndex: FTS extension load failed:', msg);
      }
    }
  }
};
/**
 * Load the VECTOR extension (required before using QUERY_VECTOR_INDEX).
 * Safe to call multiple times -- tracks loaded state via module-level vectorExtensionLoaded.
 */
export const loadVectorExtension = async (): Promise<void> => {
  if (vectorExtensionLoaded) return;
  if (!conn) {
    throw new Error('LadybugDB not initialized. Call initLbug first.');
  }
  try {
    await withLbugNativeTimeout(conn.query('INSTALL VECTOR'), 'INSTALL VECTOR');
    await withLbugNativeTimeout(conn.query('LOAD EXTENSION VECTOR'), 'LOAD EXTENSION VECTOR');
    vectorExtensionLoaded = true;
  } catch (err: unknown) {
    if (err instanceof LbugQueryTimeoutError) throw err;
    const msg = getOptionalThrownMessage(err) || '';
    if (
      msg.includes('already loaded') ||
      msg.includes('already installed') ||
      msg.includes('already exists')
    ) {
      vectorExtensionLoaded = true;
    } else {
      console.error('OntoIndex: VECTOR extension load failed:', msg);
    }
  }
};
/**
 * Create a full-text search index on a table
 * @param tableName - The node table name (e.g., 'File', 'CodeSymbol')
 * @param indexName - Name for the FTS index
 * @param properties - List of properties to index (e.g., ['name', 'code'])
 * @param stemmer - Stemming algorithm (default: 'porter')
 */
export const createFTSIndex = async (
  tableName: string,
  indexName: string,
  properties: string[],
  stemmer: string = 'porter',
): Promise<void> => {
  if (!conn) {
    throw new Error('LadybugDB not initialized. Call initLbug first.');
  }

  await loadFTSExtension();

  const propList = properties.map((p) => `'${p}'`).join(', ');
  const query = `CALL CREATE_FTS_INDEX('${tableName}', '${indexName}', [${propList}], stemmer := '${stemmer}')`;

  try {
    await withLbugNativeTimeout(conn.query(query), `CREATE_FTS_INDEX ${tableName}:${indexName}`);
  } catch (e: unknown) {
    if (!getThrownMessage(e)?.includes('already exists')) {
      throw e;
    }
  }
};

/**
 * Lazy-create an FTS index, caching the fact in-process.
 *
 * Used by `queryFTS` so that `analyze` doesn't pay the ~440 ms × 5 fixed
 * LadybugDB cost up-front (it dominates analyze on small repos). Instead,
 * the cost is moved to the first `query`/`context` call in a session,
 * where it's amortised across many lookups.
 *
 * Safe to call repeatedly — the in-process Set guarantees only the first
 * call hits LadybugDB. `closeLbug` clears the cache so re-init starts fresh.
 */
export const ensureFTSIndex = async (
  tableName: string,
  indexName: string,
  properties: string[],
  stemmer: string = 'porter',
): Promise<void> => {
  const key = `${tableName}:${indexName}`;
  if (ensuredFTSIndexes.has(key)) return;
  await createFTSIndex(tableName, indexName, properties, stemmer);
  ensuredFTSIndexes.add(key);
};

/**
 * Query a full-text search index
 * @param tableName - The node table name
 * @param indexName - FTS index name
 * @param query - Search query string
 * @param limit - Maximum results
 * @param conjunctive - If true, all terms must match (AND); if false, any term matches (OR)
 * @returns Array of { node properties, score }
 */
export const queryFTS = async (
  tableName: string,
  indexName: string,
  query: string,
  limit: number = 20,
  conjunctive: boolean = false,
): Promise<FTSQueryResult[]> => {
  if (!conn) {
    throw new Error('LadybugDB not initialized. Call initLbug first.');
  }

  // Escape backslashes and single quotes to prevent Cypher injection
  const escapedQuery = query.replace(/\\/g, '\\\\').replace(/'/g, "''");

  const cypher = `
    CALL QUERY_FTS_INDEX('${tableName}', '${indexName}', '${escapedQuery}', conjunctive := ${conjunctive})
    RETURN node, score
    ORDER BY score DESC
    LIMIT ${limit}
  `;

  try {
    const queryResult = await withLbugNativeTimeout(conn.query(cypher), 'queryFTS query');
    const result = Array.isArray(queryResult) ? queryResult[0] : queryResult;
    const rows = await getAllWithTimeout<FTSQueryRow>(result, 'queryFTS');
    if (rows.length >= MAX_INTERNAL_ROWS) {
      throw new Error(
        `[lbug] queryFTS result exceeded ${MAX_INTERNAL_ROWS} rows — refusing to truncate internal data.`,
      );
    }

    return rows.map((row) => {
      const node = (row.node || row[0] || {}) as FTSNode;
      const score = row.score ?? row[1] ?? 0;
      return {
        nodeId: (node.nodeId || node.id || '') as string,
        name: (node.name || '') as string,
        filePath: (node.filePath || '') as string,
        score: typeof score === 'number' ? score : parseFloat(score as string) || 0,
        ...node,
      } as FTSQueryResult;
    });
  } catch (e: unknown) {
    // Return empty if index doesn't exist yet
    if (getThrownMessage(e)?.includes('does not exist')) {
      return [];
    }
    throw e;
  }
};

/**
 * Drop an FTS index
 */
export const dropFTSIndex = async (tableName: string, indexName: string): Promise<void> => {
  if (!conn) {
    throw new Error('LadybugDB not initialized. Call initLbug first.');
  }

  try {
    await withLbugNativeTimeout(
      conn.query(`CALL DROP_FTS_INDEX('${tableName}', '${indexName}')`),
      `DROP_FTS_INDEX ${tableName}:${indexName}`,
    );
  } catch (err) {
    if (err instanceof LbugQueryTimeoutError) throw err;
    // Index may not exist
  }
};
