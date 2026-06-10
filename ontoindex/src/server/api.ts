/**
 * HTTP API Server
 *
 * REST API for browser-based clients to query the local .ontoindex/ index.
 * Also hosts the MCP server over StreamableHTTP for remote AI tool access.
 *
 * Security: binds to localhost by default (use --host to override).
 * CORS is restricted to loopback origins and the deployed site.
 */

import express from 'express';
import cors from 'cors';
import path from 'path';
import { createReadStream } from 'fs';
import { createInterface } from 'readline';
import fs from 'fs/promises';
import { createRequire } from 'node:module';
import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import {
  loadMeta,
  listRegisteredRepos,
  getStoragePath,
  getGlobalDir,
  type RegistryEntry,
} from '../storage/repo-manager.js';
import {
  executeQuery,
  executePrepared,
  streamQuery,
  closeLbug,
  closeLbugForPath,
  withLbugDb,
  type LbugProjectionRow,
  type LbugProjectionRows,
  type LbugQueryParams,
} from '../core/lbug/lbug-adapter.js';
import { isWriteQuery } from '../core/lbug/pool-adapter.js';
import { NODE_TABLES, type GraphNode, type GraphRelationship } from 'ontoindex-shared';
import { searchFTSFromLbug, type BM25SearchResult } from '../core/search/bm25-index.js';
import { mergeWithRRF, type HybridSearchResult } from '../core/search/hybrid-search.js';
import { findTopLevelResultLimit } from '../core/cypher-limit.js';
import type { SemanticSearchResult } from '../core/embeddings/types.js';
// Embedding imports are lazy (dynamic import) to avoid loading onnxruntime-node
// at server startup — crashes on unsupported Node ABI versions (#89)
import { LocalBackend } from '../mcp/local/local-backend.js';
import { mountMCPEndpoints, type MCPDiagnosticsSnapshot } from './mcp-http.js';
import {
  type EvidenceReadSummary,
  recordEvidenceReadSafe,
} from '../core/runtime/evidence-read-ledger.js';
import {
  getRuntimeDiagnosticsSnapshot,
  type RuntimeDiagnosticsSnapshot,
} from '../core/runtime/runtime-diagnostics.js';
import { JobManager } from './analyze-job.js';
import { getCloneDir } from './git-clone.js';
import { mountAnalyzeRoutes } from './api-analyze-routes.js';
import { mountEmbedRoutes } from './api-embed-routes.js';
import safeRegex from 'safe-regex';

const _require = createRequire(import.meta.url);
const pkg = _require('../../package.json');
const SEARCH_ENRICHMENT_CONCURRENCY = 5;
const GREP_FILE_CONCURRENCY = 8;
const MAX_API_FILE_BYTES = 2 * 1024 * 1024;
const MAX_API_RANGE_FILE_BYTES = 25 * 1024 * 1024;
const MAX_GREP_FILE_BYTES = 1024 * 1024;
const MAX_GREP_FILES_TO_SCAN = 5_000;
const MAX_API_QUERY_LIMIT = (() => {
  const raw = Number.parseInt(process.env.ONTOINDEX_API_QUERY_LIMIT_MAX ?? '', 10);
  return Number.isFinite(raw) && raw > 0 ? Math.min(raw, 50_000) : 5_000;
})();
const BACKEND_INIT_TIMEOUT_MS = (() => {
  const raw = Number.parseInt(
    process.env.ONTOINDEX_BACKEND_INIT_TIMEOUT_MS ??
      process.env.ONTOINDEX_MCP_STARTUP_TIMEOUT_MS ??
      '',
    10,
  );
  return Number.isFinite(raw) && raw > 0 ? raw : 30_000;
})();

type SearchResultSource = 'bm25' | 'semantic';

type ApiSemanticSearchResult = SemanticSearchResult & {
  score?: number;
};

type ApiSearchResult = HybridSearchResult & {
  id?: string;
  nodeIds?: string[];
  distance?: number;
  sources: SearchResultSource[];
};

type SearchConnection = {
  name?: string;
  type?: string;
  confidence?: number;
  [field: string]: unknown;
};

type SearchConnections = {
  outgoing: SearchConnection[];
  incoming: SearchConnection[];
};

type SearchProcess = {
  id?: unknown;
  label?: unknown;
  step?: unknown;
  stepCount?: unknown;
};

type SearchEnrichment = {
  connections?: SearchConnections;
  cluster?: unknown;
  processes?: SearchProcess[];
};

export type ApiSearchPassiveRetrievalOptions = {
  consume_enrichment_facts: boolean;
  include_passive_related_facts: boolean;
  include_markdown_context: boolean;
  include_markdown_ppr: boolean;
};

export type ParsedApiSearchRequest = {
  query: string;
  limit: number;
  mode: 'hybrid' | 'semantic' | 'bm25';
  enrich: boolean;
  passive: ApiSearchPassiveRetrievalOptions;
};

type ApiSearchResponse = {
  results: unknown[];
};

const asBooleanOption = (value: unknown): boolean => value === true;

export function parseApiSearchRequestBody(body: Record<string, unknown>): ParsedApiSearchRequest {
  const query = String(body.query ?? '').trim();
  const parsedLimit = Number(body.limit ?? 10);
  const mode = body.mode === 'semantic' || body.mode === 'bm25' ? body.mode : 'hybrid';

  return {
    query,
    limit: Number.isFinite(parsedLimit) ? Math.max(1, Math.min(100, Math.trunc(parsedLimit))) : 10,
    mode,
    enrich: body.enrich !== false,
    passive: {
      consume_enrichment_facts: asBooleanOption(body.consume_enrichment_facts),
      include_passive_related_facts: asBooleanOption(body.include_passive_related_facts),
      include_markdown_context: asBooleanOption(body.include_markdown_context),
      include_markdown_ppr: asBooleanOption(body.include_markdown_ppr),
    },
  };
}

export function buildApiSearchResponse(results: unknown[]): ApiSearchResponse {
  return { results };
}

type SearchConnectionRow = LbugProjectionRow & {
  outgoing?: SearchConnection[];
  incoming?: SearchConnection[];
};

type SearchClusterRow = LbugProjectionRow & {
  label?: unknown;
};

type SearchProcessRow = LbugProjectionRow & {
  id?: unknown;
  label?: unknown;
  step?: unknown;
  stepCount?: unknown;
};

type GrepFileRow = LbugProjectionRow & {
  filePath?: string;
};

type ResolvedRepoEntry = RegistryEntry & {
  __timedOut?: boolean;
  repoName?: string;
};

const namedSearchConnections = (value: unknown): SearchConnection[] => {
  const connections = value || [];
  return (connections as SearchConnection[]).filter((connection) => connection?.name).slice(0, 5);
};

const searchRowValue = (row: LbugProjectionRow, field: string, tupleIndex: number): unknown =>
  Array.isArray(row) ? row[tupleIndex] : row[field];

const generateLocalSessionToken = (): string => randomBytes(32).toString('base64url');

const resolveLocalSessionToken = (): { token: string; source: 'env' | 'generated' } => {
  const configured = process.env.ONTOINDEX_HTTP_TOKEN?.trim();
  if (configured) {
    return { token: configured, source: 'env' };
  }
  return { token: generateLocalSessionToken(), source: 'generated' };
};

function initBackendWithTimeout(backend: LocalBackend, label: string): Promise<boolean> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`${label} timed out after ${BACKEND_INIT_TIMEOUT_MS}ms`);
      err.name = 'AbortError';
      controller.abort(err);
      reject(err);
    }, BACKEND_INIT_TIMEOUT_MS);
  });

  return Promise.race([backend.init({ signal: controller.signal }), timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export function validateApiQueryLimit(cypher: string): string | null {
  const resultLimit = findTopLevelResultLimit(cypher);
  if (resultLimit.kind === 'missing') {
    return `HTTP API queries must include LIMIT ${MAX_API_QUERY_LIMIT} or lower`;
  }

  if (resultLimit.kind === 'invalid') {
    return 'HTTP API query LIMIT must be a positive integer';
  }

  if (resultLimit.limit > MAX_API_QUERY_LIMIT) {
    return `HTTP API query LIMIT ${resultLimit.limit} exceeds maximum ${MAX_API_QUERY_LIMIT}`;
  }

  return null;
}

type ApiQueryRouteResponse = {
  status: number;
  body: { error: string } | { result: unknown };
};

export async function runApiQueryWithGuards(
  cypher: string,
  execute: () => Promise<ApiQueryRouteResponse>,
): Promise<ApiQueryRouteResponse> {
  if (isWriteQuery(cypher)) {
    return { status: 403, body: { error: 'Write queries are not allowed via the HTTP API' } };
  }

  const limitError = validateApiQueryLimit(cypher);
  if (limitError) {
    return { status: 400, body: { error: limitError } };
  }

  return execute();
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(concurrency, items.length);

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const currentIndex = nextIndex++;
        results[currentIndex] = await mapper(items[currentIndex], currentIndex);
      }
    }),
  );

  return results;
}

const hasNestedRegexQuantifier = (pattern: string): boolean =>
  /\((?:[^()\\]|\\.|\([^)]*\))*[*+{][^)]*\)\s*[*+{?]/.test(pattern);

const hasAmbiguousAlternation = (pattern: string): boolean =>
  /\([^()]*\|[^()]*\)[+*]/.test(pattern);

export const isSafeGrepPattern = (pattern: string): boolean => {
  if (pattern.length > 200) return false;
  if (/\\[1-9]/.test(pattern)) return false;
  if (/\(\?<?[=!]/.test(pattern)) return false;
  if (!safeRegex(pattern)) return false;
  if (hasAmbiguousAlternation(pattern)) return false;
  return !hasNestedRegexQuantifier(pattern);
};

async function readLineRange(
  fullPath: string,
  startLine: number,
  endLine: number,
): Promise<{
  content: string;
  scannedLines: number;
  endLine: number;
  totalLines: number | null;
}> {
  const lines: string[] = [];
  let scannedLines = 0;
  let stoppedAtRequestedEnd = false;
  const input = createReadStream(fullPath, { encoding: 'utf-8' });
  const rl = createInterface({
    input,
    crlfDelay: Infinity,
  });

  try {
    for await (const line of rl) {
      if (scannedLines >= startLine && scannedLines <= endLine) {
        lines.push(line);
      }
      scannedLines++;
      if (scannedLines > endLine) {
        stoppedAtRequestedEnd = true;
        break;
      }
    }
  } finally {
    rl.close();
    input.destroy();
  }

  return {
    content: lines.join('\n'),
    scannedLines,
    endLine: Math.min(endLine, scannedLines - 1),
    totalLines: stoppedAtRequestedEnd ? null : scannedLines,
  };
}

async function grepFileLines(
  fullPath: string,
  filePath: string,
  pattern: string,
  limit: number,
  signal: AbortSignal,
): Promise<Array<{ filePath: string; line: number; text: string }>> {
  const fileRegex = new RegExp(pattern, 'gim');
  const fileResults: { filePath: string; line: number; text: string }[] = [];
  const input = createReadStream(fullPath, { encoding: 'utf-8' });
  const rl = createInterface({
    input,
    crlfDelay: Infinity,
  });
  let lineNo = 0;

  try {
    for await (const line of rl) {
      if (signal.aborted) throw new ClientDisconnectedError();
      lineNo++;
      if (line.length > 20_000) continue;
      fileRegex.lastIndex = 0;
      if (fileRegex.test(line)) {
        fileResults.push({ filePath, line: lineNo, text: line.trim().slice(0, 200) });
        if (fileResults.length >= limit) break;
      }
    }
  } finally {
    rl.close();
    input.destroy();
  }

  return fileResults;
}

/**
 * Determine whether an HTTP Origin header value is allowed by CORS policy.
 *
 * Permitted origins:
 * - No origin (non-browser requests such as curl or server-to-server calls)
 * - http://localhost:<port> — local development
 * - http://127.0.0.1:<port> — loopback alias
 * - https://ontoindex.vercel.app — the deployed OntoIndex web UI
 *
 * @param origin - The value of the HTTP `Origin` request header, or `undefined`
 *                 when the header is absent (non-browser request).
 * @returns `true` if the origin is allowed, `false` otherwise.
 */
export const isAllowedOrigin = (origin: string | undefined): boolean => {
  if (origin === undefined) {
    // Non-browser requests (curl, server-to-server) have no Origin header
    return true;
  }

  if (
    origin.startsWith('http://localhost:') ||
    origin === 'http://localhost' ||
    origin.startsWith('http://127.0.0.1:') ||
    origin === 'http://127.0.0.1' ||
    origin.startsWith('http://[::1]:') ||
    origin === 'http://[::1]' ||
    origin === 'https://ontoindex.vercel.app'
  ) {
    return true;
  }

  try {
    const parsed = new URL(origin);
    return parsed.protocol === 'https:' && parsed.origin === 'https://ontoindex.vercel.app';
  } catch {
    // Malformed origin — reject
    return false;
  }
};

export const shouldAllowPrivateNetworkAccess = (origin: string | undefined): boolean =>
  origin !== undefined && isAllowedOrigin(origin);

export const isPublicApiRoute = (method: string, requestPath: string): boolean => {
  if (method.toUpperCase() === 'OPTIONS') return true;

  let pathname: string;
  try {
    pathname = new URL(requestPath, 'http://ontoindex.local').pathname;
  } catch {
    return false;
  }

  return (
    method.toUpperCase() === 'GET' && (pathname === '/api/heartbeat' || pathname === '/api/info')
  );
};

const constantTimeEquals = (a: string, b: string): boolean => {
  if (a.length > 4096 || b.length > 4096) return false;
  const aBytes = Buffer.from(a);
  const bBytes = Buffer.from(b);
  if (aBytes.length !== bBytes.length) return false;
  return timingSafeEqual(aBytes, bBytes);
};

export const isAuthorizedApiRequest = (
  authorizationHeader: string | string[] | undefined,
  sessionToken: string,
): boolean => {
  const authorization = Array.isArray(authorizationHeader)
    ? authorizationHeader[0]
    : authorizationHeader;
  if (!authorization || !sessionToken) return false;

  const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  if (!match) return false;

  return constantTimeEquals(match[1], sessionToken);
};

export type ApiMcpSessionDiagnostics = {
  sessionIdHash: string;
  ageMs: number;
  lastActivityAt: number;
  requestCount: number;
  errorCount: number;
};

export type ApiMcpDiagnosticsResponse = {
  activeSessions: ApiMcpSessionDiagnostics[];
  activeSessionCount: number;
  totalSessionsCreated: number;
  totalIdleEvictions: number;
  totalCapEvictions: number;
  capturedAt: number;
  evidenceReadLedger?: Omit<EvidenceReadSummary, 'recentTargets'>;
};

const hashMcpSessionId = (sessionId: string): string =>
  createHash('sha256').update(sessionId).digest('hex').slice(0, 16);

export const buildApiMcpDiagnosticsResponse = (
  snapshot: MCPDiagnosticsSnapshot | RuntimeDiagnosticsSnapshot,
): ApiMcpDiagnosticsResponse => {
  const mcp = 'mcp' in snapshot ? snapshot.mcp : snapshot;
  const ledger = 'evidenceReadLedger' in snapshot ? snapshot.evidenceReadLedger : undefined;

  let minimizedLedger: Omit<EvidenceReadSummary, 'recentTargets'> | undefined;
  if (ledger) {
    const { recentTargets, ...rest } = ledger;
    minimizedLedger = rest;
  }

  return {
    activeSessions: mcp.activeSessions.map((session) => ({
      sessionIdHash: hashMcpSessionId(session.sessionId),
      ageMs: Math.max(0, mcp.capturedAt - session.createdAt),
      lastActivityAt: session.lastActivity,
      requestCount: session.requestCount,
      errorCount: session.errorCount,
    })),
    activeSessionCount: mcp.activeSessionCount,
    totalSessionsCreated: mcp.totalSessionsCreated,
    totalIdleEvictions: mcp.totalEvictions,
    totalCapEvictions: mcp.totalCapEvictions,
    capturedAt: mcp.capturedAt,
    evidenceReadLedger: minimizedLedger,
  };
};

type GraphStreamRecord =
  | { type: 'node'; data: GraphNode }
  | { type: 'relationship'; data: GraphRelationship }
  | { type: 'error'; error: string };

export class ClientDisconnectedError extends Error {
  constructor() {
    super('Client disconnected during graph stream');
    this.name = 'ClientDisconnectedError';
  }
}

const errorMessage = (err: unknown): unknown => {
  if (err && (typeof err === 'object' || typeof err === 'function') && 'message' in err) {
    return (err as { readonly message?: unknown }).message;
  }
  return undefined;
};

const errorMessageOr = (err: unknown, fallback: string): unknown => errorMessage(err) || fallback;

const errorCodeIs = (err: unknown, code: string): boolean => {
  if (!err || typeof err !== 'object' || !('code' in err)) return false;
  return err.code === code;
};

const isIgnorableGraphQueryError = (err: unknown): boolean => {
  const message = err instanceof Error ? err.message : String(err);
  return (
    message.includes('does not exist') ||
    message.includes('not found') ||
    message.includes('No table named')
  );
};

const ensureStreamIsWritable = (res: express.Response, signal?: AbortSignal): void => {
  if (signal?.aborted || res.destroyed || res.writableEnded) {
    throw new ClientDisconnectedError();
  }
};

const waitForDrain = async (res: express.Response, signal?: AbortSignal): Promise<void> => {
  ensureStreamIsWritable(res, signal);

  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      res.off('drain', onDrain);
      res.off('close', onClose);
      signal?.removeEventListener('abort', onAbort);
    };

    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onClose = () => {
      cleanup();
      reject(new ClientDisconnectedError());
    };
    const onAbort = () => {
      cleanup();
      reject(new ClientDisconnectedError());
    };

    res.once('drain', onDrain);
    res.once('close', onClose);
    signal?.addEventListener('abort', onAbort, { once: true });

    if (signal?.aborted || res.destroyed || res.writableEnded) {
      onAbort();
    }
  });

  ensureStreamIsWritable(res, signal);
};

const isClientDisconnectWriteError = (err: unknown): boolean => {
  if (!(err instanceof Error)) return false;
  return (
    (err as NodeJS.ErrnoException).code === 'ERR_STREAM_DESTROYED' ||
    (err as NodeJS.ErrnoException).code === 'EPIPE' ||
    (err as NodeJS.ErrnoException).code === 'ECONNRESET' ||
    err.message.includes('write after end')
  );
};

const writeNdjsonRecord = async (
  res: express.Response,
  record: GraphStreamRecord,
  signal?: AbortSignal,
): Promise<void> => {
  ensureStreamIsWritable(res, signal);

  try {
    const canContinue = res.write(JSON.stringify(record) + '\n');
    if (!canContinue) {
      await waitForDrain(res, signal);
    }
  } catch (err) {
    if (isClientDisconnectWriteError(err)) {
      throw new ClientDisconnectedError();
    }
    throw err;
  }
};

const SUMMARY_NODE_TABLES = ['Folder', 'File', 'Community', 'Process', 'Module'];
const SUMMARY_REL_TYPES = ['CONTAINS', 'IMPORTS'];
const MAX_GRAPH_JSON_BYTES = 50 * 1024 * 1024; // 50 MB
const MAX_LEGACY_GRAPH_RECORDS = (() => {
  const raw = Number.parseInt(process.env.ONTOINDEX_LEGACY_GRAPH_RECORD_LIMIT ?? '', 10);
  return Number.isFinite(raw) && raw > 0 ? Math.min(raw, 100_000) : 25_000;
})();
const ESTIMATED_GRAPH_RECORD_BYTES = 700;

const buildGraph = async (
  includeContent = false,
  summary = false,
): Promise<{ nodes: GraphNode[]; relationships: GraphRelationship[] }> => {
  const nodes: GraphNode[] = [];
  const allowedTables = summary ? SUMMARY_NODE_TABLES : NODE_TABLES;

  for (const table of allowedTables) {
    try {
      const rows = await executeQuery<GraphNodeRow>(getNodeQuery(table, includeContent));
      for (const row of rows) {
        nodes.push(mapGraphNodeRow(table, row, includeContent));
      }
    } catch (err) {
      if (!isIgnorableGraphQueryError(err)) {
        throw err;
      }
    }
  }

  const relationships: GraphRelationship[] = [];
  const summaryLabelList = SUMMARY_NODE_TABLES.map((t) => `'${t}'`).join(', ');
  const relQuery = summary
    ? `MATCH (a)-[r:CodeRelation]->(b) WHERE r.type IN [${SUMMARY_REL_TYPES.map((t) => `'${t}'`).join(', ')}] AND a.label IN [${summaryLabelList}] AND b.label IN [${summaryLabelList}] RETURN a.id AS sourceId, b.id AS targetId, r.type AS type, r.confidence AS confidence, r.reason AS reason, r.step AS step`
    : GRAPH_RELATIONSHIP_QUERY;

  const relRows = await executeQuery<GraphRelationshipRow>(relQuery);
  for (const row of relRows) {
    relationships.push(mapGraphRelationshipRow(row));
  }

  return { nodes, relationships };
};

const GRAPH_RELATIONSHIP_QUERY =
  `MATCH (a)-[r:CodeRelation]->(b) RETURN a.id AS sourceId, b.id AS targetId, ` +
  `r.type AS type, r.confidence AS confidence, r.reason AS reason, r.step AS step`;

type GraphCountRow = LbugProjectionRow & {
  count?: number | bigint | string | null;
  COUNT?: number | bigint | string | null;
  'count(n)'?: number | bigint | string | null;
};

type GraphNodeRow = LbugProjectionRow & {
  id?: GraphNode['id'];
  name?: GraphNode['properties']['name'];
  label?: GraphNode['properties']['name'];
  filePath?: GraphNode['properties']['filePath'];
  startLine?: GraphNode['properties']['startLine'];
  endLine?: GraphNode['properties']['endLine'];
  content?: string;
  responseKeys?: unknown;
  errorKeys?: unknown;
  middleware?: unknown;
  heuristicLabel?: GraphNode['properties']['heuristicLabel'];
  cohesion?: GraphNode['properties']['cohesion'];
  symbolCount?: GraphNode['properties']['symbolCount'];
  description?: GraphNode['properties']['description'];
  processType?: GraphNode['properties']['processType'];
  stepCount?: GraphNode['properties']['stepCount'];
  communities?: GraphNode['properties']['communities'];
  entryPointId?: GraphNode['properties']['entryPointId'];
  terminalId?: GraphNode['properties']['terminalId'];
};

type GraphRelationshipRow = LbugProjectionRow & {
  sourceId?: GraphRelationship['sourceId'];
  targetId?: GraphRelationship['targetId'];
  type?: GraphRelationship['type'];
  confidence?: GraphRelationship['confidence'];
  reason?: GraphRelationship['reason'];
  step?: GraphRelationship['step'];
};

const rowCountValue = (row: GraphCountRow | undefined): number => {
  const raw = row?.count ?? row?.COUNT ?? row?.['count(n)'] ?? row?.[0] ?? 0;
  if (typeof raw === 'bigint') return Number(raw);
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : 0;
};

export const getLegacyGraphRecordLimit = (): number => MAX_LEGACY_GRAPH_RECORDS;

export const estimateLegacyGraphRecordCount = async (summary = false): Promise<number> => {
  const allowedTables = summary ? SUMMARY_NODE_TABLES : NODE_TABLES;
  let total = 0;
  for (const table of allowedTables) {
    try {
      const rows = await executeQuery<GraphCountRow>(
        `MATCH (n:${quoteNodeTable(table)}) RETURN count(n) AS count`,
      );
      total += rowCountValue(rows[0]);
    } catch (err) {
      if (!isIgnorableGraphQueryError(err)) throw err;
    }
  }

  const summaryLabelList = SUMMARY_NODE_TABLES.map((t) => `'${t}'`).join(', ');
  const relQuery = summary
    ? `MATCH (a)-[r:CodeRelation]->(b) WHERE r.type IN [${SUMMARY_REL_TYPES.map((t) => `'${t}'`).join(', ')}] AND a.label IN [${summaryLabelList}] AND b.label IN [${summaryLabelList}] RETURN count(r) AS count`
    : `MATCH ()-[r:CodeRelation]->() RETURN count(r) AS count`;
  const relRows = await executeQuery<GraphCountRow>(relQuery);
  total += rowCountValue(relRows[0]);
  return total;
};

const quoteNodeTable = (table: string): string => `\`${table.replace(/`/g, '``')}\``;

const getNodeQuery = (table: string, includeContent: boolean): string => {
  const tableLabel = quoteNodeTable(table);

  if (table === 'File') {
    return includeContent
      ? `MATCH (n:${tableLabel}) RETURN n.id AS id, n.name AS name, n.filePath AS filePath, n.content AS content`
      : `MATCH (n:${tableLabel}) RETURN n.id AS id, n.name AS name, n.filePath AS filePath`;
  }
  if (table === 'Folder') {
    return `MATCH (n:${tableLabel}) RETURN n.id AS id, n.name AS name, n.filePath AS filePath`;
  }
  if (table === 'Community') {
    return `MATCH (n:${tableLabel}) RETURN n.id AS id, n.label AS label, n.heuristicLabel AS heuristicLabel, n.cohesion AS cohesion, n.symbolCount AS symbolCount`;
  }
  if (table === 'Process') {
    return `MATCH (n:${tableLabel}) RETURN n.id AS id, n.label AS label, n.heuristicLabel AS heuristicLabel, n.processType AS processType, n.stepCount AS stepCount, n.communities AS communities, n.entryPointId AS entryPointId, n.terminalId AS terminalId`;
  }
  if (table === 'Route') {
    return `MATCH (n:${tableLabel}) RETURN n.id AS id, n.name AS name, n.filePath AS filePath, n.responseKeys AS responseKeys, n.errorKeys AS errorKeys, n.middleware AS middleware`;
  }
  if (table === 'Tool') {
    return `MATCH (n:${tableLabel}) RETURN n.id AS id, n.name AS name, n.filePath AS filePath, n.description AS description`;
  }
  return includeContent
    ? `MATCH (n:${tableLabel}) RETURN n.id AS id, n.name AS name, n.filePath AS filePath, n.startLine AS startLine, n.endLine AS endLine, n.content AS content`
    : `MATCH (n:${tableLabel}) RETURN n.id AS id, n.name AS name, n.filePath AS filePath, n.startLine AS startLine, n.endLine AS endLine`;
};

const mapGraphNodeRow = (table: string, row: GraphNodeRow, includeContent: boolean): GraphNode => ({
  id: (row.id ?? row[0]) as GraphNode['id'],
  label: table as GraphNode['label'],
  properties: {
    name: row.name ?? row.label ?? row[1],
    filePath: row.filePath ?? row[2],
    startLine: row.startLine,
    endLine: row.endLine,
    content: includeContent ? row.content : undefined,
    responseKeys: row.responseKeys,
    errorKeys: row.errorKeys,
    middleware: row.middleware,
    heuristicLabel: row.heuristicLabel,
    cohesion: row.cohesion,
    symbolCount: row.symbolCount,
    description: row.description,
    processType: row.processType,
    stepCount: row.stepCount,
    communities: row.communities,
    entryPointId: row.entryPointId,
    terminalId: row.terminalId,
  } as GraphNode['properties'],
});

const mapGraphRelationshipRow = (row: GraphRelationshipRow): GraphRelationship => ({
  id: `${row.sourceId}_${row.type}_${row.targetId}`,
  type: row.type as GraphRelationship['type'],
  sourceId: row.sourceId as GraphRelationship['sourceId'],
  targetId: row.targetId as GraphRelationship['targetId'],
  confidence: row.confidence as GraphRelationship['confidence'],
  reason: row.reason as GraphRelationship['reason'],
  step: row.step,
});

export const streamGraphNdjson = async (
  res: express.Response,
  includeContent = false,
  signal?: AbortSignal,
  summary = false,
  runQuery: <T>(operation: () => Promise<T>) => Promise<T> = (operation) => operation(),
): Promise<void> => {
  const allowedTables = summary ? SUMMARY_NODE_TABLES : NODE_TABLES;
  const executeStreamQuery = <TRow extends LbugProjectionRow>(
    query: string,
    onRow: (row: TRow) => void | Promise<void>,
  ): Promise<number> =>
    signal ? streamQuery<TRow>(query, onRow, signal) : streamQuery<TRow>(query, onRow);

  for (const table of allowedTables) {
    try {
      await runQuery(() =>
        executeStreamQuery<GraphNodeRow>(getNodeQuery(table, includeContent), async (row) => {
          await writeNdjsonRecord(
            res,
            {
              type: 'node',
              data: mapGraphNodeRow(table, row, includeContent),
            },
            signal,
          );
        }),
      );
    } catch (err) {
      if (signal?.aborted) throw new ClientDisconnectedError();
      if (!isIgnorableGraphQueryError(err)) {
        throw err;
      }
    }
  }

  const summaryLabelListStream = SUMMARY_NODE_TABLES.map((t) => `'${t}'`).join(', ');
  const relQuery = summary
    ? `MATCH (a)-[r:CodeRelation]->(b) WHERE r.type IN [${SUMMARY_REL_TYPES.map((t) => `'${t}'`).join(', ')}] AND a.label IN [${summaryLabelListStream}] AND b.label IN [${summaryLabelListStream}] RETURN a.id AS sourceId, b.id AS targetId, r.type AS type, r.confidence AS confidence, r.reason AS reason, r.step AS step`
    : GRAPH_RELATIONSHIP_QUERY;

  try {
    await runQuery(() =>
      executeStreamQuery<GraphRelationshipRow>(relQuery, async (row) => {
        await writeNdjsonRecord(
          res,
          {
            type: 'relationship',
            data: mapGraphRelationshipRow(row),
          },
          signal,
        );
      }),
    );
  } catch (err) {
    if (signal?.aborted) throw new ClientDisconnectedError();
    throw err;
  }
};

/**
 * Mount an SSE progress endpoint for a JobManager.
 * Handles: initial state, terminal events, heartbeat, event IDs, client disconnect.
 */
const mountSSEProgress = (app: express.Express, routePath: string, jm: JobManager) => {
  app.get(routePath, (req, res) => {
    const jobId = Array.isArray(req.params.jobId) ? req.params.jobId[0] : req.params.jobId;
    const job = jm.getJob(jobId);
    if (!job) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }

    let eventId = 0;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    // Send current state immediately
    eventId++;
    res.write(`id: ${eventId}\ndata: ${JSON.stringify(job.progress)}\n\n`);

    // If already terminal, send event and close
    if (job.status === 'complete' || job.status === 'failed') {
      eventId++;
      res.write(
        `id: ${eventId}\nevent: ${job.status}\ndata: ${JSON.stringify({
          repoName: job.repoName,
          error: job.error,
        })}\n\n`,
      );
      res.end();
      return;
    }

    // Heartbeat to detect zombie connections
    const heartbeat = setInterval(() => {
      try {
        res.write(':heartbeat\n\n');
      } catch {
        clearInterval(heartbeat);
        unsubscribe();
      }
    }, 30_000);

    // Subscribe to progress updates
    const unsubscribe = jm.onProgress(job.id, (progress) => {
      try {
        eventId++;
        if (progress.phase === 'complete' || progress.phase === 'failed') {
          const eventJob = jm.getJob(jobId);
          res.write(
            `id: ${eventId}\nevent: ${progress.phase}\ndata: ${JSON.stringify({
              repoName: eventJob?.repoName,
              error: eventJob?.error,
            })}\n\n`,
          );
          clearInterval(heartbeat);
          res.end();
          unsubscribe();
        } else {
          res.write(`id: ${eventId}\ndata: ${JSON.stringify(progress)}\n\n`);
        }
      } catch {
        clearInterval(heartbeat);
        unsubscribe();
      }
    });

    req.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });
};

const statusFromError = (err: unknown): number => {
  const msg = String(errorMessage(err) ?? '');
  if (msg.includes('No indexed repositories') || msg.includes('not found')) return 404;
  if (msg.includes('Multiple repositories')) return 400;
  return 500;
};

const requestedRepo = (req: express.Request): string | undefined => {
  const fromQuery = typeof req.query.repo === 'string' ? req.query.repo : undefined;
  if (fromQuery) return fromQuery;

  if (req.body && typeof req.body === 'object' && typeof req.body.repo === 'string') {
    return req.body.repo;
  }

  return undefined;
};

const createRepoLockManager = () => {
  interface RepoWriteLock {
    repoPath: string;
    token: symbol;
  }

  const activeRepoPaths = new Map<string, { readers: number; writer: symbol | null }>();
  const WRITE_LOCK_WAIT_TIMEOUT_MS = 10_000;
  const WRITE_LOCK_WAIT_POLL_MS = 50;

  const getState = (repoPath: string) =>
    activeRepoPaths.get(repoPath) ?? { readers: 0, writer: null };

  const acquireRepoLock = (repoPath: string): RepoWriteLock | string => {
    const state = getState(repoPath);
    if (state.writer || state.readers > 0) {
      return 'Another job or read request is already active for this repository';
    }
    const lock = { repoPath, token: Symbol(repoPath) };
    activeRepoPaths.set(repoPath, { readers: 0, writer: lock.token });
    return lock;
  };

  const releaseRepoLock = (lock: RepoWriteLock): void => {
    const state = activeRepoPaths.get(lock.repoPath);
    if (!state) return;
    if (state.writer !== lock.token) return;
    state.writer = null;
    if (state.readers === 0) activeRepoPaths.delete(lock.repoPath);
  };

  const waitForLockPoll = (signal?: AbortSignal): Promise<'ready' | 'aborted'> => {
    if (signal?.aborted) return Promise.resolve('aborted');
    return new Promise((resolve) => {
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      };
      const onAbort = () => {
        cleanup();
        resolve('aborted');
      };
      const timer = setTimeout(() => {
        cleanup();
        resolve('ready');
      }, WRITE_LOCK_WAIT_POLL_MS);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  };

  const createRequestAbortTracker = (
    req: express.Request,
  ): { signal: AbortSignal; cleanup: () => void } => {
    const controller = new AbortController();
    const abort = () => {
      if (!controller.signal.aborted) controller.abort();
    };
    req.once('aborted', abort);
    req.once('close', abort);
    if (req.aborted || req.destroyed) {
      abort();
    }
    return {
      signal: controller.signal,
      cleanup: () => {
        req.off('aborted', abort);
        req.off('close', abort);
      },
    };
  };

  const acquireRepoLockWhenAvailable = async (
    repoPath: string,
    signal?: AbortSignal,
  ): Promise<RepoWriteLock | string> => {
    const started = Date.now();
    while (true) {
      if (signal?.aborted) {
        return 'Request aborted while waiting for repository lock';
      }
      const lock = acquireRepoLock(repoPath);
      if (typeof lock !== 'string') return lock;
      if (Date.now() - started >= WRITE_LOCK_WAIT_TIMEOUT_MS) {
        return lock;
      }
      if ((await waitForLockPoll(signal)) === 'aborted') {
        return 'Request aborted while waiting for repository lock';
      }
    }
  };

  const acquireRepoReadLock = (repoPath: string): string | null => {
    const state = getState(repoPath);
    if (state.writer) {
      return 'A write job is already active for this repository';
    }
    state.readers++;
    activeRepoPaths.set(repoPath, state);
    return null;
  };

  const releaseRepoReadLock = (repoPath: string): void => {
    const state = activeRepoPaths.get(repoPath);
    if (!state) return;
    state.readers = Math.max(0, state.readers - 1);
    if (!state.writer && state.readers === 0) activeRepoPaths.delete(repoPath);
  };

  return {
    acquireRepoLock,
    acquireRepoLockWhenAvailable,
    createRequestAbortTracker,
    releaseRepoLock,
    acquireRepoReadLock,
    releaseRepoReadLock,
  };
};

export const createServer = async (port: number, host: string = '127.0.0.1') => {
  const app = express();
  app.disable('x-powered-by');
  const auth = resolveLocalSessionToken();

  // Support Chromium Private Network Access (required since Chrome 130+).
  // This must run before CORS because the cors middleware may terminate OPTIONS.
  app.use((req, res, next) => {
    if (shouldAllowPrivateNetworkAccess(req.headers.origin)) {
      res.setHeader('Access-Control-Allow-Private-Network', 'true');
    }
    next();
  });

  // CORS: allow loopback/browser-development origins and the deployed site.
  // Non-browser requests (curl, server-to-server) have no origin and are allowed.
  // Disallowed origins get the response without Access-Control-Allow-Origin,
  // so the browser blocks it. We pass `false` instead of throwing an Error to
  // avoid crashing into Express's default error handler (which returned 500).
  app.use(
    cors({
      origin: (origin, callback) => {
        callback(null, isAllowedOrigin(origin));
      },
    }),
  );
  app.use(express.json({ limit: '10mb' }));

  // Handle PNA preflight: Chromium sends Access-Control-Request-Private-Network
  // on OPTIONS requests and expects the allow header in the response.
  // The header is set before CORS so it survives cors-owned preflight responses.
  app.options('*', (_req, res, next) => {
    next();
  });

  app.use('/api', (req, res, next) => {
    if (isPublicApiRoute(req.method, req.originalUrl)) {
      next();
      return;
    }
    if (isAuthorizedApiRequest(req.headers.authorization, auth.token)) {
      next();
      return;
    }

    res.setHeader('WWW-Authenticate', 'Bearer realm="ontoindex"');
    res.status(401).json({ error: 'Unauthorized' });
  });

  console.log(
    auth.source === 'env'
      ? 'OntoIndex HTTP API auth enabled via ONTOINDEX_HTTP_TOKEN'
      : `OntoIndex HTTP API bearer token: ${auth.token}`,
  );
  console.log('Non-static /api routes require Authorization: Bearer <token>');

  // Initialize MCP backend (multi-repo, shared across all MCP sessions)
  const backend = new LocalBackend();
  try {
    await initBackendWithTimeout(backend, 'backend.init startup');
  } catch (err) {
    console.warn(
      `[server] backend init timed out during startup; continuing with lazy refresh: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const { cleanup: cleanupMcp, getDiagnostics } = mountMCPEndpoints(app, backend);

  const globalDir = getGlobalDir();
  const jobManager = new JobManager(globalDir);
  await jobManager.init();

  // Shared repo lock — prevents concurrent analyze + embed on the same repo path,
  // which would corrupt LadybugDB (analyze calls closeLbug + initLbug while embed has queries in flight).
  const {
    acquireRepoLock,
    acquireRepoLockWhenAvailable,
    createRequestAbortTracker,
    releaseRepoLock,
    acquireRepoReadLock,
    releaseRepoReadLock,
  } = createRepoLockManager();

  const acquireReadAccess = (repoPath: string, res: express.Response): (() => void) | null => {
    const lockErr = acquireRepoReadLock(repoPath);
    if (lockErr) {
      res.status(409).json({ error: lockErr });
      return null;
    }
    return () => releaseRepoReadLock(repoPath);
  };

  const withResolvedRepoReadAccess = async <T>(
    req: express.Request,
    res: express.Response,
    operation: (entry: ResolvedRepoEntry) => Promise<T>,
  ): Promise<T | undefined> => {
    const entry = await resolveRepo(requestedRepo(req));
    if (!entry) {
      res.status(404).json({ error: 'Repository not found' });
      return undefined;
    }
    const releaseRead = acquireReadAccess(getStoragePath(entry.path), res);
    if (!releaseRead) return undefined;
    try {
      return await operation(entry);
    } finally {
      releaseRead();
    }
  };

  /**
   * Maximum time the hold-queue will wait for an active analysis job to complete.
   * Must stay in sync with the frontend's `fetchRepoInfo({ awaitAnalysis: true })` timeout.
   */
  const HOLD_QUEUE_TIMEOUT_SECS = 300; // 5 minutes

  // Helper: resolve a repo by name from the global registry, or default to first.
  // Pass `req` to enable early exit if the client disconnects during the hold-queue wait.
  const resolveRepo = async (
    repoName?: string,
    isRetry = false,
    req?: express.Request,
  ): Promise<ResolvedRepoEntry | null> => {
    const repos = await listRegisteredRepos();
    let found: ResolvedRepoEntry | null = null;

    // Normalize: if a full path is passed, extract just the basename.
    // e.g. "C:\Users\LENOVO\.ontoindex\repos\todo.txt-cli" -> "todo.txt-cli"
    const normalizedName = repoName ? path.basename(repoName) : undefined;

    if (normalizedName) {
      found =
        repos.find((r) => r.name === normalizedName) ||
        repos.find((r) => r.name.toLowerCase() === normalizedName.toLowerCase()) ||
        null;
    } else if (repos.length > 0) {
      found = repos[0]; // default to first repo
    }

    // If not yet in the registry, check whether a background job is actively cloning or
    // analyzing this repo. Hold the connection open (up to 5 minutes) until it completes.
    // We only wait for in-progress jobs ('queued'|'cloning'|'analyzing') — a 'complete' job
    // whose repo is still missing means the registry sync failed; the fallback below handles it.
    if (!found && normalizedName) {
      const lower = normalizedName.toLowerCase();

      // Track client disconnect to cancel the wait early
      let clientGone = false;
      req?.on('close', () => {
        clientGone = true;
      });

      for (const job of jobManager.listJobs()) {
        const isMatch =
          job.repoName?.toLowerCase() === lower ||
          (job.repoUrl && path.basename(job.repoUrl).replace('.git', '').toLowerCase() === lower) ||
          (job.repoPath && path.basename(job.repoPath).toLowerCase() === lower);

        if (isMatch && ['queued', 'cloning', 'analyzing'].includes(job.status)) {
          if (process.env.DEBUG) {
            console.log(
              `[debug] resolveRepo waiting for active job ${job.id} (${normalizedName})...`,
            );
          }

          // Use jobManager.onProgress to wait for completion instead of polling
          const result = await new Promise<ResolvedRepoEntry | null>((resolve) => {
            let settled = false;
            const done = (val: ResolvedRepoEntry | null) => {
              if (settled) return;
              settled = true;
              clearTimeout(timeout);
              unsubscribe();
              resolve(val);
            };

            const timeout = setTimeout(() => {
              console.error(
                `[resolveRepo] hold-queue timed out after ${HOLD_QUEUE_TIMEOUT_SECS}s waiting for repo "${normalizedName}" (job ${job.id})`,
              );
              done(null);
            }, HOLD_QUEUE_TIMEOUT_SECS * 1000);

            const unsubscribe = jobManager.onProgress(job.id, async (progress) => {
              if (progress.phase === 'complete') {
                try {
                  await initBackendWithTimeout(backend, 'backend.init hold-queue');
                  const freshRepos = await listRegisteredRepos();
                  done(freshRepos.find((r) => r.name === normalizedName) || null);
                } catch (err) {
                  console.warn(
                    `[server] backend refresh failed after job completion: ${err instanceof Error ? err.message : String(err)}`,
                  );
                  done(null);
                }
              } else if (progress.phase === 'failed') {
                done(null);
              }
            });

            req?.on('close', () => done(null));

            // Race check: job might have finished between the loop check and our listener attach
            const current = jobManager.getJob(job.id);
            if (!current || current.status === 'failed') {
              done(null);
            } else if (current.status === 'complete') {
              listRegisteredRepos().then((fresh) => {
                done(fresh.find((r) => r.name === normalizedName) || null);
              });
            }
          });

          if (result) return result;
        }
      }
    }

    // Emergency fallback: re-sync the registry to handle Windows file-system race conditions
    // (e.g. registry file not yet flushed after clone completes).
    if (!found && normalizedName && !isRetry) {
      if (process.env.DEBUG) {
        console.log(`[debug] resolveRepo 404 for "${normalizedName}". Triggering deep init...`);
      }
      try {
        await initBackendWithTimeout(backend, 'backend.init resolveRepo');
      } catch (err) {
        console.warn(
          `[server] backend refresh failed while resolving "${normalizedName}": ${err instanceof Error ? err.message : String(err)}`,
        );
        return null;
      }
      return await resolveRepo(normalizedName, true, req);
    }

    return found;
  };

  // SSE heartbeat — clients connect to detect server liveness instantly.
  // When the server shuts down, the TCP connection drops and the client's
  // EventSource fires onerror immediately (no polling delay).
  app.get('/api/heartbeat', (_req, res) => {
    // Use res.set() instead of res.writeHead() to preserve CORS headers from middleware
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.flushHeaders();
    // Send initial ping so the client knows it connected
    res.write(':ok\n\n');

    // Keep-alive ping every 15s to prevent proxy/firewall timeout
    const interval = setInterval(() => res.write(':ping\n\n'), 15_000);

    _req.on('close', () => clearInterval(interval));
  });

  // Server info: version and launch context (npx / global / local dev)
  app.get('/api/info', (_req, res) => {
    const execPath = process.env.npm_execpath ?? '';
    const argv0 = process.argv[1] ?? '';
    let launchContext: 'npx' | 'global' | 'local';
    if (
      execPath.includes('npx') ||
      argv0.includes('_npx') ||
      process.env.npm_config_prefix?.includes('_npx')
    ) {
      launchContext = 'npx';
    } else if (argv0.includes('node_modules')) {
      launchContext = 'local';
    } else {
      launchContext = 'global';
    }
    res.json({ version: pkg.version, launchContext, nodeVersion: process.version });
  });

  app.get('/api/mcp/diagnostics', (_req, res) => {
    const mcpDiag = getDiagnostics();
    const snapshot = getRuntimeDiagnosticsSnapshot(mcpDiag);

    recordEvidenceReadSafe({
      readClass: 'runtime_diagnostic',
      surface: 'api:mcp:diagnostics',
      target: 'runtime-diagnostics-snapshot',
      targetType: 'snapshot',
    });

    res.json(buildApiMcpDiagnosticsResponse(snapshot));
  });

  // List all registered repos
  app.get('/api/repos', async (_req, res) => {
    try {
      const repos = await listRegisteredRepos();
      res.json(
        repos.map((r) => ({
          name: r.name,
          path: r.path,
          indexedAt: r.indexedAt,
          lastCommit: r.lastCommit,
          stats: r.stats,
        })),
      );
    } catch (err: unknown) {
      res.status(500).json({ error: errorMessageOr(err, 'Failed to list repos') });
    }
  });

  // Get repo info
  app.get('/api/repo', async (req, res) => {
    try {
      const entry = await resolveRepo(requestedRepo(req), false, req);
      if (!entry) {
        res.status(404).json({ error: 'Repository not found. Run: ontoindex analyze' });
        return;
      }
      // Timed out waiting for an active analysis job
      if (entry.__timedOut) {
        res.status(503).json({
          error: `Repository analysis for "${entry.repoName}" is taking longer than expected. Please try again in a moment.`,
        });
        return;
      }
      const meta = await loadMeta(entry.storagePath);
      res.json({
        name: entry.name,
        repoPath: entry.path,
        indexedAt: meta?.indexedAt ?? entry.indexedAt,
        stats: meta?.stats ?? entry.stats ?? {},
      });
    } catch (err: unknown) {
      res.status(500).json({ error: errorMessageOr(err, 'Failed to get repo info') });
    }
  });

  // Delete a repo — removes index, clone dir (if any), and unregisters it
  app.delete('/api/repo', async (req, res) => {
    try {
      const repoName = requestedRepo(req);
      if (!repoName) {
        res.status(400).json({ error: 'Missing repo name' });
        return;
      }
      const entry = await resolveRepo(repoName);
      if (!entry) {
        res.status(404).json({ error: 'Repository not found' });
        return;
      }

      // Acquire repo lock — prevents deleting while analyze/embed is in flight
      const lockKey = getStoragePath(entry.path);
      const requestAbort = createRequestAbortTracker(req);
      const lock = await acquireRepoLockWhenAvailable(lockKey, requestAbort.signal);
      requestAbort.cleanup();
      if (requestAbort.signal.aborted) {
        return;
      }
      if (typeof lock === 'string') {
        res.status(409).json({ error: lock });
        return;
      }

      try {
        // Close this repo's open LadybugDB handle before deleting files
        try {
          await closeLbugForPath(path.join(entry.storagePath, 'lbug'));
        } catch {}
        await backend.closeRepoConnections(entry.name, entry.path);

        // 1. Delete the .ontoindex index/storage directory
        const storagePath = getStoragePath(entry.path);
        await fs.rm(storagePath, { recursive: true, force: true }).catch(() => {});

        // 2. Delete the cloned repo dir if it lives under ~/.ontoindex/repos/
        const cloneDir = getCloneDir(entry.name);
        try {
          const stat = await fs.stat(cloneDir);
          if (stat.isDirectory()) {
            await fs.rm(cloneDir, { recursive: true, force: true });
          }
        } catch {
          /* clone dir may not exist (local repos) */
        }

        // 3. Unregister from the global registry
        const { unregisterRepo } = await import('../storage/repo-manager.js');
        await unregisterRepo(entry.path);

        // 4. Reinitialize backend to reflect the removal
        await initBackendWithTimeout(backend, 'backend.init deleteRepo').catch((err) => {
          console.warn(
            `[server] backend refresh failed after delete: ${err instanceof Error ? err.message : String(err)}`,
          );
        });

        res.json({ deleted: entry.name });
      } finally {
        releaseRepoLock(lock);
      }
    } catch (err: unknown) {
      res.status(500).json({ error: errorMessageOr(err, 'Failed to delete repo') });
    }
  });

  // Get full graph
  app.get('/api/graph', async (req, res) => {
    try {
      const entry = await resolveRepo(requestedRepo(req));
      if (!entry) {
        res.status(404).json({ error: 'Repository not found' });
        return;
      }
      const lbugPath = path.join(entry.storagePath, 'lbug');
      const includeContent = req.query.includeContent === 'true';
      const stream = req.query.stream === 'true';
      const summary = req.query.summary === 'true';
      const lockKey = getStoragePath(entry.path);
      const releaseRead = acquireReadAccess(lockKey, res);
      if (!releaseRead) return;

      try {
        if (!stream && includeContent) {
          res.status(413).json({
            error:
              'Graph with file content is too large for legacy JSON mode. Use the NDJSON streaming endpoint (stream=true).',
          });
          return;
        }

        if (stream) {
          const abortController = new AbortController();
          let responseFinished = false;
          const markFinished = () => {
            responseFinished = true;
          };
          const abortStreaming = () => {
            if (!responseFinished) {
              abortController.abort();
            }
          };

          res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
          res.setHeader('Cache-Control', 'no-cache');
          res.flushHeaders();

          req.once('aborted', abortStreaming);
          res.once('finish', markFinished);
          res.once('close', abortStreaming);

          try {
            await streamGraphNdjson(res, includeContent, abortController.signal, summary, (op) =>
              withLbugDb(lbugPath, op),
            );
            if (!abortController.signal.aborted && !res.writableEnded) {
              res.end();
            }
          } finally {
            req.off('aborted', abortStreaming);
            res.off('finish', markFinished);
            res.off('close', abortStreaming);
          }
          return;
        }

        const estimatedRecords = await withLbugDb(lbugPath, async () =>
          estimateLegacyGraphRecordCount(summary),
        );
        if (estimatedRecords > MAX_LEGACY_GRAPH_RECORDS) {
          res.status(413).json({
            error:
              'Graph too large for legacy JSON mode. Use the NDJSON streaming endpoint (stream=true).',
            estimatedRecords,
          });
          return;
        }
        const estimatedBytes = estimatedRecords * ESTIMATED_GRAPH_RECORD_BYTES;
        if (estimatedBytes > MAX_GRAPH_JSON_BYTES) {
          res.status(413).json({
            error:
              'Graph likely too large for legacy JSON mode. Use the NDJSON streaming endpoint (stream=true).',
            estimatedRecords,
            estimatedBytes,
          });
          return;
        }

        const graph = await withLbugDb(lbugPath, async () => buildGraph(includeContent, summary));
        const graphJson = JSON.stringify(graph);
        if (graphJson.length > MAX_GRAPH_JSON_BYTES) {
          res.status(413).json({
            error:
              'Graph too large for legacy JSON mode. Use the NDJSON streaming endpoint (stream=true).',
          });
          return;
        }
        res.setHeader('Content-Type', 'application/json');
        res.end(graphJson);
      } finally {
        releaseRead();
      }
    } catch (err: unknown) {
      if (err instanceof ClientDisconnectedError) {
        return;
      }
      const message = errorMessageOr(err, 'Failed to build graph');
      if (res.headersSent) {
        try {
          res.write(JSON.stringify({ type: 'error', error: message }) + '\n');
        } catch {
          // Best-effort only after streaming has started.
        }
        res.end();
        return;
      }
      res.status(500).json({ error: message });
    }
  });

  // Execute Cypher query
  app.post('/api/query', async (req, res) => {
    try {
      const cypher = req.body.cypher as string;
      if (!cypher) {
        res.status(400).json({ error: 'Missing "cypher" in request body' });
        return;
      }

      const response = await runApiQueryWithGuards(cypher, async () => {
        const entry = await resolveRepo(requestedRepo(req));
        if (!entry) {
          return { status: 404, body: { error: 'Repository not found' } };
        }

        const repoStoragePath = getStoragePath(entry.path);
        const lockErr = acquireRepoReadLock(repoStoragePath);
        if (lockErr) {
          return { status: 409, body: { error: lockErr } };
        }

        try {
          const lbugPath = path.join(entry.storagePath, 'lbug');
          const result = await withLbugDb(lbugPath, () => executeQuery(cypher));
          return { status: 200, body: { result } };
        } finally {
          releaseRepoReadLock(repoStoragePath);
        }
      });

      res.status(response.status).json(response.body);
    } catch (err: unknown) {
      res.status(500).json({ error: errorMessageOr(err, 'Query failed') });
    }
  });

  // Search (supports mode: 'hybrid' | 'semantic' | 'bm25', and optional enrichment)
  app.post('/api/search', async (req, res) => {
    try {
      const searchRequest = parseApiSearchRequestBody((req.body ?? {}) as Record<string, unknown>);
      const { query, limit, mode, enrich } = searchRequest;
      if (!query) {
        res.status(400).json({ error: 'Missing "query" in request body' });
        return;
      }

      const entry = await resolveRepo(requestedRepo(req));
      if (!entry) {
        res.status(404).json({ error: 'Repository not found' });
        return;
      }
      const lbugPath = path.join(entry.storagePath, 'lbug');

      const releaseRead = acquireReadAccess(getStoragePath(entry.path), res);
      if (!releaseRead) return;
      try {
        const executeScopedQuery = (cypher: string) =>
          withLbugDb(lbugPath, () => executeQuery(cypher));
        const executeScopedPrepared = <TRow extends LbugProjectionRow>(
          cypher: string,
          params: LbugQueryParams,
        ): Promise<LbugProjectionRows<TRow>> =>
          withLbugDb(lbugPath, () => executePrepared<TRow>(cypher, params));
        let searchResults: ApiSearchResult[];

        if (mode === 'semantic') {
          const { isEmbedderReady } = await import('../core/embeddings/embedder.js');
          if (!isEmbedderReady()) {
            searchResults = [];
          } else {
            const { semanticSearch: semSearch } =
              await import('../core/embeddings/embedding-pipeline.js');
            const semanticResults: ApiSemanticSearchResult[] = await semSearch(
              executeScopedQuery,
              query,
              limit,
            );
            // Normalize semantic results to HybridSearchResult shape
            searchResults = semanticResults.map((result, index) => ({
              ...result,
              score: result.score ?? 1 - (result.distance ?? 0),
              rank: index + 1,
              sources: ['semantic'],
            }));
          }
        } else if (mode === 'bm25') {
          const bm25Results: BM25SearchResult[] = await withLbugDb(lbugPath, () =>
            searchFTSFromLbug(query, limit),
          );
          searchResults = bm25Results.map((result, index) => ({
            ...result,
            rank: index + 1,
            sources: ['bm25'],
          }));
        } else {
          // hybrid (default). Keep embedding/model work outside the singleton
          // LadybugDB session lock; only individual DB calls are scoped.
          const bm25Results: BM25SearchResult[] = await withLbugDb(lbugPath, () =>
            searchFTSFromLbug(query, limit),
          );
          const { isEmbedderReady } = await import('../core/embeddings/embedder.js');
          if (isEmbedderReady()) {
            const { semanticSearch: semSearch } =
              await import('../core/embeddings/embedding-pipeline.js');
            const semanticResults: SemanticSearchResult[] = await semSearch(
              executeScopedQuery,
              query,
              limit,
            );
            searchResults = mergeWithRRF(bm25Results, semanticResults, limit);
          } else {
            searchResults = bm25Results.map((result, index) => ({
              ...result,
              rank: index + 1,
              sources: ['bm25'],
            }));
          }
        }

        let results = searchResults;

        if (enrich) {
          // Server-side enrichment: add connections, cluster, processes per result
          // Uses parameterized queries to prevent Cypher injection via nodeId
          const validLabel = (label: string): boolean =>
            (NODE_TABLES as readonly string[]).includes(label);

          results = await mapWithConcurrency(
            searchResults.slice(0, limit),
            SEARCH_ENRICHMENT_CONCURRENCY,
            async (r) => {
              const nodeId: string = r.nodeId || r.id || '';
              const nodeLabel = nodeId.split(':')[0];
              const enrichment: SearchEnrichment = {};

              if (!nodeId || !validLabel(nodeLabel)) return { ...r, ...enrichment };

              // Run connections, cluster, and process queries in parallel
              // Label is validated against NODE_TABLES (compile-time safe identifiers);
              // nodeId uses $nid parameter binding to prevent injection
              const [connRes, clusterRes, procRes] = await Promise.all([
                executeScopedPrepared<SearchConnectionRow>(
                  `
              MATCH (n:${nodeLabel} {id: $nid})
              OPTIONAL MATCH (n)-[r1:CodeRelation]->(dst)
              OPTIONAL MATCH (src)-[r2:CodeRelation]->(n)
              RETURN
                collect(DISTINCT {name: dst.name, type: r1.type, confidence: r1.confidence}) AS outgoing,
                collect(DISTINCT {name: src.name, type: r2.type, confidence: r2.confidence}) AS incoming
              LIMIT 1
            `,
                  { nid: nodeId },
                ).catch(() => []),
                executeScopedPrepared<SearchClusterRow>(
                  `
              MATCH (n:${nodeLabel} {id: $nid})
              MATCH (n)-[:CodeRelation {type: 'MEMBER_OF'}]->(c:Community)
              RETURN c.label AS label, c.description AS description
              LIMIT 1
            `,
                  { nid: nodeId },
                ).catch(() => []),
                executeScopedPrepared<SearchProcessRow>(
                  `
              MATCH (n:${nodeLabel} {id: $nid})
              MATCH (n)-[rel:CodeRelation {type: 'STEP_IN_PROCESS'}]->(p:Process)
              RETURN p.id AS id, p.label AS label, rel.step AS step, p.stepCount AS stepCount
              ORDER BY rel.step
              LIMIT 20
            `,
                  { nid: nodeId },
                ).catch(() => []),
              ]);

              if (connRes.length > 0) {
                const row = connRes[0];
                const outgoing = namedSearchConnections(Array.isArray(row) ? row[0] : row.outgoing);
                const incoming = namedSearchConnections(Array.isArray(row) ? row[1] : row.incoming);
                enrichment.connections = { outgoing, incoming };
              }

              if (clusterRes.length > 0) {
                const row = clusterRes[0];
                enrichment.cluster = searchRowValue(row, 'label', 0);
              }

              if (procRes.length > 0) {
                enrichment.processes = procRes
                  .map((row) => ({
                    id: searchRowValue(row, 'id', 0),
                    label: searchRowValue(row, 'label', 1),
                    step: searchRowValue(row, 'step', 2),
                    stepCount: searchRowValue(row, 'stepCount', 3),
                  }))
                  .filter((process) => process.id && process.label);
              }

              return { ...r, ...enrichment };
            },
          );
        }
        res.json(buildApiSearchResponse(results));
      } finally {
        releaseRead();
      }
    } catch (err: unknown) {
      res.status(500).json({ error: errorMessageOr(err, 'Search failed') });
    }
  });

  // Read file — with path traversal guard
  app.get('/api/file', async (req, res) => {
    try {
      const entry = await resolveRepo(requestedRepo(req));
      if (!entry) {
        res.status(404).json({ error: 'Repository not found' });
        return;
      }
      const filePath = req.query.path as string;
      if (!filePath) {
        res.status(400).json({ error: 'Missing path' });
        return;
      }

      // Prevent path traversal — resolve and verify the path stays within the repo root
      const repoRoot = path.resolve(entry.path);
      const fullPath = path.resolve(repoRoot, filePath);
      if (!fullPath.startsWith(repoRoot + path.sep) && fullPath !== repoRoot) {
        res.status(403).json({ error: 'Path traversal denied' });
        return;
      }

      const releaseRead = acquireReadAccess(getStoragePath(entry.path), res);
      if (!releaseRead) return;
      try {
        // Optional line-range support: ?startLine=10&endLine=50
        // Returns only the requested slice (0-indexed), plus metadata.
        const startLine =
          req.query.startLine !== undefined ? Number(req.query.startLine) : undefined;
        const endLine = req.query.endLine !== undefined ? Number(req.query.endLine) : undefined;

        if (startLine !== undefined && Number.isFinite(startLine)) {
          const fileStat = await fs.stat(fullPath);
          if (fileStat.size > MAX_API_RANGE_FILE_BYTES) {
            res.status(413).json({ error: 'File too large for line-range read' });
            return;
          }
          const start = Math.max(0, startLine);
          const end =
            endLine !== undefined && Number.isFinite(endLine)
              ? Math.max(start, endLine)
              : Math.min(start + 499, Number.MAX_SAFE_INTEGER);
          const range = await readLineRange(fullPath, start, end);
          res.json({
            content: range.content,
            startLine: start,
            endLine: range.endLine,
            totalLines: range.totalLines,
            totalLinesKnown: range.totalLines !== null,
            scannedLines: range.scannedLines,
          });
        } else {
          const fileStat = await fs.stat(fullPath);
          if (fileStat.size > MAX_API_FILE_BYTES) {
            res.status(413).json({
              error: `File too large to read fully; use startLine/endLine for files over ${MAX_API_FILE_BYTES} bytes`,
            });
            return;
          }
          const raw = await fs.readFile(fullPath, 'utf-8');
          res.json({ content: raw, totalLines: raw.split('\n').length });
        }
      } finally {
        releaseRead();
      }
    } catch (err: unknown) {
      if (errorCodeIs(err, 'ENOENT')) {
        res.status(404).json({ error: 'File not found' });
      } else {
        res.status(500).json({ error: errorMessageOr(err, 'Failed to read file') });
      }
    }
  });

  // Grep — regex search across file contents in the indexed repo
  // Uses filesystem-based search for memory efficiency (never loads all files into memory)
  app.get('/api/grep', async (req, res) => {
    try {
      const entry = await resolveRepo(requestedRepo(req));
      if (!entry) {
        res.status(404).json({ error: 'Repository not found' });
        return;
      }
      const pattern = req.query.pattern as string;
      if (!pattern) {
        res.status(400).json({ error: 'Missing "pattern" query parameter' });
        return;
      }

      // ReDoS protection: reject overly long or dangerous patterns
      if (!isSafeGrepPattern(pattern)) {
        res.status(400).json({ error: 'Pattern too long or unsafe (ReDoS risk)' });
        return;
      }

      // Validate regex syntax
      try {
        new RegExp(pattern, 'gim');
      } catch {
        res.status(400).json({ error: 'Invalid regex pattern' });
        return;
      }

      const parsedLimit = Number(req.query.limit ?? 50);
      const limit = Number.isFinite(parsedLimit)
        ? Math.max(1, Math.min(200, Math.trunc(parsedLimit)))
        : 50;

      const results: { filePath: string; line: number; text: string }[] = [];
      const repoRoot = path.resolve(entry.path);

      // Get file paths from the graph (lightweight — no content loaded)
      const lbugPath = path.join(entry.storagePath, 'lbug');
      const releaseRead = acquireReadAccess(getStoragePath(entry.path), res);
      if (!releaseRead) return;
      const abortController = new AbortController();
      const abortSearch = () => abortController.abort();
      req.once('aborted', abortSearch);
      res.once('close', abortSearch);

      try {
        const fileRows = await withLbugDb(lbugPath, () =>
          executeQuery<GrepFileRow>(
            `MATCH (n:File) WHERE n.content IS NOT NULL RETURN n.filePath AS filePath LIMIT ${MAX_GREP_FILES_TO_SCAN}`,
          ),
        );

        const searchFile = async (
          row: GrepFileRow,
        ): Promise<Array<{ filePath: string; line: number; text: string }>> => {
          if (abortController.signal.aborted) throw new ClientDisconnectedError();
          const filePath: string = row.filePath || '';
          const fullPath = path.resolve(repoRoot, filePath);

          // Path traversal guard
          if (!fullPath.startsWith(repoRoot + path.sep) && fullPath !== repoRoot) return [];

          try {
            const stat = await fs.stat(fullPath);
            if (stat.size > MAX_GREP_FILE_BYTES) return [];
          } catch {
            return []; // File may have been deleted since indexing
          }
          if (abortController.signal.aborted) throw new ClientDisconnectedError();
          return grepFileLines(fullPath, filePath, pattern, limit, abortController.signal);
        };

        // Search files in small batches. This keeps memory bounded while avoiding
        // one-file-at-a-time disk latency on large repositories.
        for (
          let start = 0;
          start < fileRows.length && results.length < limit;
          start += GREP_FILE_CONCURRENCY
        ) {
          if (abortController.signal.aborted) throw new ClientDisconnectedError();
          const batch = fileRows.slice(start, start + GREP_FILE_CONCURRENCY);
          const batchResults = await Promise.all(batch.map(searchFile));
          for (const matches of batchResults) {
            if (results.length >= limit) break;
            results.push(...matches.slice(0, limit - results.length));
          }
        }

        res.json({ results });
      } finally {
        releaseRead();
        req.off('aborted', abortSearch);
        res.off('close', abortSearch);
      }
    } catch (err: unknown) {
      if (err instanceof ClientDisconnectedError) return;
      res.status(500).json({ error: errorMessageOr(err, 'Grep failed') });
    }
  });

  // List all processes
  app.get('/api/processes', async (req, res) => {
    try {
      const result = await withResolvedRepoReadAccess(req, res, (entry) =>
        backend.queryProcesses(entry.path),
      );
      if (result === undefined) return;
      res.json(result);
    } catch (err: unknown) {
      res
        .status(statusFromError(err))
        .json({ error: errorMessageOr(err, 'Failed to query processes') });
    }
  });

  // Process detail
  app.get('/api/process', async (req, res) => {
    try {
      const name = String(req.query.name ?? '').trim();
      if (!name) {
        res.status(400).json({ error: 'Missing "name" query parameter' });
        return;
      }

      const result = await withResolvedRepoReadAccess(req, res, (entry) =>
        backend.queryProcessDetail(name, entry.path),
      );
      if (result === undefined) return;
      if (result?.error) {
        res.status(404).json({ error: result.error });
        return;
      }
      res.json(result);
    } catch (err: unknown) {
      res
        .status(statusFromError(err))
        .json({ error: errorMessageOr(err, 'Failed to query process detail') });
    }
  });

  // List all clusters
  app.get('/api/clusters', async (req, res) => {
    try {
      const result = await withResolvedRepoReadAccess(req, res, (entry) =>
        backend.queryClusters(entry.path),
      );
      if (result === undefined) return;
      res.json(result);
    } catch (err: unknown) {
      res
        .status(statusFromError(err))
        .json({ error: errorMessageOr(err, 'Failed to query clusters') });
    }
  });

  // Cluster detail
  app.get('/api/cluster', async (req, res) => {
    try {
      const name = String(req.query.name ?? '').trim();
      if (!name) {
        res.status(400).json({ error: 'Missing "name" query parameter' });
        return;
      }

      const result = await withResolvedRepoReadAccess(req, res, (entry) =>
        backend.queryClusterDetail(name, entry.path),
      );
      if (result === undefined) return;
      if (result?.error) {
        res.status(404).json({ error: result.error });
        return;
      }
      res.json(result);
    } catch (err: unknown) {
      res
        .status(statusFromError(err))
        .json({ error: errorMessageOr(err, 'Failed to query cluster detail') });
    }
  });

  // ── Analyze API ──────────────────────────────────────────────────────

  mountAnalyzeRoutes(app, jobManager, backend, acquireRepoLock, releaseRepoLock);

  // ── Embedding endpoints ────────────────────────────────────────────

  const embedJobManager = new JobManager(path.join(globalDir, 'embed'));
  await embedJobManager.init();

  mountEmbedRoutes(
    app,
    embedJobManager,
    resolveRepo,
    requestedRepo,
    acquireRepoLock,
    releaseRepoLock,
  );

  // Global error handler — catch anything the route handlers miss
  app.use(
    (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      console.error('Unhandled error:', err);
      res.status(500).json({ error: 'Internal server error' });
    },
  );

  // Wrap listen in a promise so errors (EADDRINUSE, EACCES, etc.) propagate
  // to the caller instead of crashing with an unhandled 'error' event.
  await new Promise<void>((resolve, reject) => {
    const server = app.listen(port, host, () => {
      const displayHost = host === '::' || host === '0.0.0.0' ? 'localhost' : host;
      console.log(`OntoIndex server running on http://${displayHost}:${port}`);
      resolve();
    });
    server.on('error', (err) => reject(err));

    // Graceful shutdown — close Express + LadybugDB cleanly
    const shutdown = async () => {
      console.log('\nShutting down...');
      server.close();
      await jobManager.dispose();
      await embedJobManager.dispose();
      await cleanupMcp();
      await closeLbug();
      await backend.dispose();
      process.exit(0);
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  });
};
