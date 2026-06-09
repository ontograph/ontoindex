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
  /** Populated by a later labeler pass; null at write-time. */
  intentLabel?: string;
  intentConfidence?: number;
}

const MAX_QUERY_CHARS = 256;
const MAX_RESULT_IDS = 10;

function logsEnabled(): boolean {
  const raw = (process.env.ONTOINDEX_QUERY_LOG ?? '').toLowerCase();
  return !(raw === '0' || raw === 'false' || raw === 'off' || raw === 'no');
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
    };
    await appendFile(file, JSON.stringify(entry) + '\n', 'utf-8');
  } catch {
    // Logging must never break a query — swallow all errors.
  }
}
