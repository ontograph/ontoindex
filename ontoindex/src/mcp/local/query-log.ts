/**
 * Durable per-query log for v6 production-data collection.
 *
 * Appends one JSONL line per MCP query to `~/.ontoindex/logs/queries-{repoId}-{yyyymmdd}.jsonl`.
 * Default: enabled. Disable with `ONTOINDEX_QUERY_LOG=0` (or `false` / `off` / `no`).
 * Override sink dir with `ONTOINDEX_QUERY_LOG_DIR=/path/to/dir`.
 *
 * Designed for v6 W2b (intent-router diagnostic on production queries) and W3
 * (post-swap embedder validation). The on-disk format is intentionally minimal —
 * a later labeler pass annotates each entry with `intentLabel` / `intentConfidence`.
 *
 * Errors are swallowed: logging MUST NOT break a query.
 */

import { appendFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import { randomUUID } from 'crypto';

export interface QueryLogEntry {
  queryId: string;
  ts: number;
  repoId: string;
  query: string;
  resultIds: string[];
  resultScores?: number[];
  phases?: Record<string, number>;
  ftsUsed?: boolean;
  /** Cache outcome for this structured search exit. */
  cacheStatus?: CacheStatus;
  /**
   * UTF-8 byte size of the pre-guard serialized search result
   * (`JSON.stringify(result)` before the MCP response-size guard trims it),
   * bounded to a non-negative integer.
   */
  responseBytes?: number;
  /** True when the response was truncated by any bound. */
  truncated?: boolean;
  /** Bounded, deduped reasons explaining the truncation. */
  truncatedReasons?: string[];
  /** Retrieval input shape: plain string vs typed document. */
  retrievalMode?: RetrievalMode;
  /** Named retrieval expansion policy when supplied by the caller. */
  retrievalPolicy?: string;
  /** Populated by a later labeler pass; null at write-time. */
  intentLabel?: string;
  intentConfidence?: number;
}

export type CacheStatus = 'hit' | 'miss' | 'stale' | 'expired' | 'disabled';
export type RetrievalMode = 'plain' | 'typed';

export const MAX_QUERY_CHARS = 256;
export const MAX_RESULT_IDS = 10;
const MAX_TRUNCATED_REASONS = 10;
const MAX_REASON_CHARS = 120;

function boundResponseBytes(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value)) return undefined;
  return Math.max(0, Math.floor(value));
}

function boundReasons(reasons: string[] | undefined): string[] | undefined {
  if (!reasons || reasons.length === 0) return undefined;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of reasons) {
    if (typeof raw !== 'string' || !raw) continue;
    const reason = raw.length > MAX_REASON_CHARS ? raw.slice(0, MAX_REASON_CHARS) : raw;
    if (seen.has(reason)) continue;
    seen.add(reason);
    out.push(reason);
    if (out.length >= MAX_TRUNCATED_REASONS) break;
  }
  return out.length > 0 ? out : undefined;
}

function logsEnabled(): boolean {
  const raw = (process.env.ONTOINDEX_QUERY_LOG ?? '').toLowerCase();
  return !(raw === '0' || raw === 'false' || raw === 'off' || raw === 'no');
}

/** Opt-out check shared with callers so they can skip response serialization when disabled. */
export function queryLogEnabled(): boolean {
  return logsEnabled();
}

function logsDir(): string {
  return process.env.ONTOINDEX_QUERY_LOG_DIR ?? join(homedir(), '.ontoindex', 'logs');
}

function todayStamp(): string {
  const d = new Date();
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}${mm}${dd}`;
}

export async function appendQueryLog(
  repoId: string,
  data: {
    query: string;
    resultIds: string[];
    resultScores?: number[];
    phases?: Record<string, number>;
    ftsUsed?: boolean;
    cacheStatus?: CacheStatus;
    responseBytes?: number;
    truncated?: boolean;
    truncatedReasons?: string[];
    retrievalMode?: RetrievalMode;
    retrievalPolicy?: string;
  },
): Promise<void> {
  if (!logsEnabled()) return;
  try {
    const dir = logsDir();
    await mkdir(dir, { recursive: true });
    const file = join(dir, `queries-${repoId}-${todayStamp()}.jsonl`);
    const entry: QueryLogEntry = {
      queryId: randomUUID(),
      ts: Date.now(),
      repoId,
      query:
        data.query.length > MAX_QUERY_CHARS ? data.query.slice(0, MAX_QUERY_CHARS) : data.query,
      resultIds: (data.resultIds ?? []).slice(0, MAX_RESULT_IDS),
      resultScores: data.resultScores ? data.resultScores.slice(0, MAX_RESULT_IDS) : undefined,
      phases: data.phases,
      ftsUsed: data.ftsUsed,
      cacheStatus: data.cacheStatus,
      responseBytes: boundResponseBytes(data.responseBytes),
      truncated: data.truncated,
      truncatedReasons: boundReasons(data.truncatedReasons),
      retrievalMode: data.retrievalMode,
      retrievalPolicy: data.retrievalPolicy,
    };
    await appendFile(file, JSON.stringify(entry) + '\n', 'utf-8');
  } catch {
    // Logging must never break a query — swallow all errors.
  }
}
