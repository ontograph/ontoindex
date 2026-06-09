/**
 * Consolidated HTTP client for the OntoIndex backend server.
 *
 * Replaces backend.ts, server-connection.ts, and worker HTTP helpers
 * with a single typed module. All graph queries, search, embeddings,
 * and file operations go through this client.
 */

import type { GraphNode, GraphRelationship } from 'ontoindex-shared';
import { HUGE_GRAPH_THRESHOLD } from '../lib/constants';

// ── Types ──────────────────────────────────────────────────────────────────

export interface BackendRepo {
  name: string;
  path: string;
  repoPath?: string; // git HEAD returns "repoPath"; older versions return "path"
  indexedAt: string;
  lastCommit?: string;
  stats?: {
    files?: number;
    nodes?: number;
    edges?: number;
    communities?: number;
    processes?: number;
  };
}

export interface EnrichedSearchResult {
  filePath: string;
  score: number;
  rank?: number;
  sources?: string[];
  nodeId?: string;
  name?: string;
  label?: string;
  startLine?: number;
  endLine?: number;
  // Enrichment (server-side)
  connections?: {
    outgoing: Array<{ name: string; type: string; confidence?: number }>;
    incoming: Array<{ name: string; type: string; confidence?: number }>;
  };
  cluster?: string;
  processes?: Array<{ id: string; label: string; step?: number; stepCount?: number }>;
}

export interface GrepResult {
  filePath: string;
  line: number;
  text: string;
}

export interface JobProgress {
  phase: string;
  percent: number;
  message: string;
}

export interface JobStatus {
  id: string;
  status: 'queued' | 'cloning' | 'analyzing' | 'loading' | 'complete' | 'failed';
  repoUrl?: string;
  repoPath?: string;
  repoName?: string;
  progress: JobProgress;
  error?: string;
  startedAt: number;
  completedAt?: number;
}

export interface McpSessionDiagnostics {
  sessionIdHash: string;
  ageMs: number;
  lastActivityAt: number;
  requestCount: number;
  errorCount: number;
}

export interface EvidenceReadSummary {
  total: number;
  byClass: Record<string, number>;
  bySurface: Record<string, number>;
  byRepo: Record<string, number>;
  droppedOverCap: number;
  recorderErrors: number;
}

export interface McpDiagnosticsResponse {
  activeSessions: McpSessionDiagnostics[];
  activeSessionCount: number;
  totalSessionsCreated: number;
  totalIdleEvictions: number;
  totalCapEvictions: number;
  capturedAt: number;
  freshness?: string;
  degraded?: boolean;
  evidenceReadLedger?: EvidenceReadSummary;
}

export class BackendError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: 'network' | 'server' | 'client' | 'not_found' | 'timeout',
  ) {
    super(message);
    this.name = 'BackendError';
  }
}

// ── Runtime response guards ────────────────────────────────────────────────

const isObjectRecord = (x: unknown): x is Record<string, unknown> =>
  typeof x === 'object' && x !== null;

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

function isBackendRepo(x: unknown): x is BackendRepo {
  return isObjectRecord(x) && 'name' in x && 'path' in x && 'indexedAt' in x;
}

function isBackendRepoArray(x: unknown): x is BackendRepo[] {
  return Array.isArray(x) && (x.length === 0 || isBackendRepo(x[0]));
}

function isGraphResponse(x: unknown): x is { nodes: unknown[]; relationships: unknown[] } {
  return (
    isObjectRecord(x) &&
    'nodes' in x &&
    'relationships' in x &&
    Array.isArray((x as Record<string, unknown>).nodes) &&
    Array.isArray((x as Record<string, unknown>).relationships)
  );
}

function isReadFileResult(x: unknown): x is ReadFileResult {
  return (
    isObjectRecord(x) &&
    'content' in x &&
    'totalLines' in x &&
    typeof (x as Record<string, unknown>).content === 'string'
  );
}

const parseMcpSessionDiagnostics = (x: unknown): McpSessionDiagnostics | null => {
  if (!isObjectRecord(x)) return null;

  const sessionIdHash = x.sessionIdHash;
  const ageMs = x.ageMs;
  const lastActivityAt = x.lastActivityAt;
  const requestCount = x.requestCount;
  const errorCount = x.errorCount;

  if (
    typeof sessionIdHash !== 'string' ||
    sessionIdHash.length === 0 ||
    !isFiniteNumber(ageMs) ||
    !isFiniteNumber(lastActivityAt) ||
    !isFiniteNumber(requestCount) ||
    !isFiniteNumber(errorCount)
  ) {
    return null;
  }

  return {
    sessionIdHash,
    ageMs,
    lastActivityAt,
    requestCount,
    errorCount,
  };
};

const parseMcpDiagnosticsResponse = (x: unknown): McpDiagnosticsResponse | null => {
  if (!isObjectRecord(x) || !Array.isArray(x.activeSessions)) {
    return null;
  }

  const activeSessions = x.activeSessions
    .map(parseMcpSessionDiagnostics)
    .filter((session): session is McpSessionDiagnostics => session !== null);

  if (
    activeSessions.length !== x.activeSessions.length ||
    !isFiniteNumber(x.activeSessionCount) ||
    !isFiniteNumber(x.totalSessionsCreated) ||
    !isFiniteNumber(x.totalIdleEvictions) ||
    !isFiniteNumber(x.totalCapEvictions) ||
    !isFiniteNumber(x.capturedAt)
  ) {
    return null;
  }

  return {
    activeSessions,
    activeSessionCount: x.activeSessionCount,
    totalSessionsCreated: x.totalSessionsCreated,
    totalIdleEvictions: x.totalIdleEvictions,
    totalCapEvictions: x.totalCapEvictions,
    capturedAt: x.capturedAt,
    freshness: typeof x.freshness === 'string' ? x.freshness : undefined,
    degraded: typeof x.degraded === 'boolean' ? x.degraded : undefined,
    evidenceReadLedger: isObjectRecord(x.evidenceReadLedger)
      ? (x.evidenceReadLedger as unknown as EvidenceReadSummary)
      : undefined,
  };
};

// ── SSE Utility ────────────────────────────────────────────────────────────

export interface SSEHandlers<T = unknown> {
  onMessage?: (data: T) => void;
  onComplete?: (data: T) => void;
  onError?: (error: string) => void;
}

/**
 * Generic SSE stream consumer using fetch + ReadableStream.
 * Returns an AbortController to cancel the stream.
 * Automatically reconnects on network drops (up to 3 retries with backoff).
 */
export function streamSSE<T = unknown>(url: string, handlers: SSEHandlers<T>): AbortController {
  const controller = new AbortController();
  const MAX_RETRIES = 3;
  const BASE_DELAY_MS = 1_000;

  let lastEventId = '';
  const retryTimers = new Set<ReturnType<typeof setTimeout>>();

  const clearRetryTimers = () => {
    for (const timer of retryTimers) {
      clearTimeout(timer);
    }
    retryTimers.clear();
  };
  controller.signal.addEventListener('abort', clearRetryTimers, { once: true });

  const scheduleReconnect = (retryCount: number) => {
    const timer = setTimeout(
      () => {
        retryTimers.delete(timer);
        connect(retryCount);
      },
      BASE_DELAY_MS * 2 ** (retryCount - 1),
    );
    retryTimers.add(timer);
  };

  function connect(retryCount: number) {
    if (controller.signal.aborted) return;

    (async () => {
      try {
        const headers: Record<string, string> = {};
        if (lastEventId) {
          headers['Last-Event-ID'] = lastEventId;
        }

        const response = await fetch(
          url,
          withBackendAuth(url, { signal: controller.signal, headers }),
        );
        if (!response.ok) {
          handlers.onError?.(`Server returned ${response.status}`);
          return;
        }

        const reader = response.body?.getReader();
        if (!reader) {
          handlers.onError?.('No response body');
          return;
        }

        // Reset retry count on successful connection
        retryCount = 0;

        const decoder = new TextDecoder();
        let buffer = '';
        let eventType = 'message';

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            if (buffer.length > MAX_SSE_BUFFER_CHARS) {
              throw new Error(`SSE buffer exceeded ${MAX_SSE_BUFFER_CHARS} characters`);
            }
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
              if (line.trim() === '') {
                eventType = 'message';
                continue;
              }
              if (line.startsWith('id: ')) {
                lastEventId = line.slice(4).trim();
                continue;
              }
              if (line.startsWith(':')) {
                // SSE comment (heartbeat) — skip
                continue;
              }
              if (line.startsWith('event: ')) {
                eventType = line.slice(7).trim();
              } else if (line.startsWith('data: ')) {
                let parsed: T;
                try {
                  parsed = JSON.parse(line.slice(6)) as T;
                } catch {
                  // Skip malformed JSON
                  eventType = 'message';
                  continue;
                }
                const currentEventType = eventType;
                eventType = 'message';
                if (currentEventType === 'complete') {
                  handlers.onComplete?.(parsed);
                  await reader.cancel().catch(() => {});
                  return;
                } else if (currentEventType === 'failed') {
                  const errData = parsed as any;
                  handlers.onError?.(errData?.error || 'Job failed');
                  await reader.cancel().catch(() => {});
                  return;
                } else {
                  handlers.onMessage?.(parsed);
                }
              }
            }
          }
        } finally {
          reader.releaseLock();
        }

        // Stream ended without terminal event — try to reconnect
        if (!controller.signal.aborted && retryCount < MAX_RETRIES) {
          scheduleReconnect(retryCount + 1);
        }
      } catch (err: unknown) {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        if (err instanceof Error && err.message.includes('SSE buffer exceeded')) {
          handlers.onError?.(err.message);
          return;
        }
        // Network error — attempt reconnect with backoff
        if (!controller.signal.aborted && retryCount < MAX_RETRIES) {
          scheduleReconnect(retryCount + 1);
        } else {
          handlers.onError?.(err instanceof Error ? err.message : 'Stream error');
        }
      }
    })();
  }

  connect(0);
  return controller;
}

const MAX_GRAPH_JSON_BYTES = 50 * 1024 * 1024; // 50 MB

// ── Configuration ──────────────────────────────────────────────────────────

let _backendUrl = 'http://localhost:4747';
let _backendAuthToken: string | null = null;
let _authTokenUrlInitialized = false;

const AUTH_QUERY_PARAM = 'ontoindexToken';
const AUTH_SESSION_STORAGE_KEY = 'ontoindex.httpToken';
const AUTH_LOCAL_STORAGE_KEY = 'ontoindex.httpToken';

type BackendAuthStorage = 'session' | 'local';

const getBrowserStorage = (kind: BackendAuthStorage): Storage | null => {
  if (typeof window === 'undefined') return null;
  try {
    return kind === 'session' ? window.sessionStorage : window.localStorage;
  } catch {
    return null;
  }
};

const storeBackendAuthToken = (token: string, storage: BackendAuthStorage): void => {
  getBrowserStorage(storage)?.setItem(
    storage === 'session' ? AUTH_SESSION_STORAGE_KEY : AUTH_LOCAL_STORAGE_KEY,
    token,
  );
};

const readStoredBackendAuthToken = (): string | null => {
  const sessionToken = getBrowserStorage('session')?.getItem(AUTH_SESSION_STORAGE_KEY)?.trim();
  if (sessionToken) return sessionToken;
  const localToken = getBrowserStorage('local')?.getItem(AUTH_LOCAL_STORAGE_KEY)?.trim();
  return localToken || null;
};

const removeStoredBackendAuthToken = (): void => {
  getBrowserStorage('session')?.removeItem(AUTH_SESSION_STORAGE_KEY);
  getBrowserStorage('local')?.removeItem(AUTH_LOCAL_STORAGE_KEY);
};

const consumeAuthTokenFromUrl = (url: URL, scrubBrowserUrl: boolean): void => {
  const token = url.searchParams.get(AUTH_QUERY_PARAM)?.trim();
  if (!token) return;

  setBackendAuthToken(token);
  url.searchParams.delete(AUTH_QUERY_PARAM);

  if (scrubBrowserUrl && typeof window !== 'undefined' && window.history?.replaceState) {
    const next = `${url.pathname}${url.search}${url.hash}`;
    window.history.replaceState(window.history.state, document.title, next);
  }
};

const initializeAuthTokenFromBrowserUrl = (): void => {
  if (_authTokenUrlInitialized || typeof window === 'undefined') return;
  _authTokenUrlInitialized = true;
  try {
    consumeAuthTokenFromUrl(new URL(window.location.href), true);
  } catch {
    // Ignore malformed browser URLs.
  }
};

const consumeAuthTokenFromBackendUrlInput = (input: string): void => {
  try {
    let url = input.trim();
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      url =
        url.startsWith('localhost') || url.startsWith('127.0.0.1')
          ? `http://${url}`
          : `https://${url}`;
    }
    consumeAuthTokenFromUrl(new URL(url), false);
  } catch {
    // Ignore malformed user-entered URLs; normalizeServerUrl handles the final shape.
  }
};

export const setBackendAuthToken = (
  token: string | null | undefined,
  opts?: { storage?: BackendAuthStorage },
): void => {
  const nextToken = token?.trim() || null;
  _backendAuthToken = nextToken;
  removeStoredBackendAuthToken();
  if (!nextToken) return;
  storeBackendAuthToken(nextToken, opts?.storage ?? 'session');
};

export const clearBackendAuthToken = (): void => {
  _backendAuthToken = null;
  _authTokenUrlInitialized = false;
  removeStoredBackendAuthToken();
};

export const getBackendAuthToken = (): string | null => {
  initializeAuthTokenFromBrowserUrl();
  if (_backendAuthToken) return _backendAuthToken;
  _backendAuthToken = readStoredBackendAuthToken();
  return _backendAuthToken;
};

export const setBackendUrl = (url: string): void => {
  consumeAuthTokenFromBackendUrlInput(url);
  _backendUrl = normalizeServerUrl(url);
};

export const getBackendUrl = (): string => _backendUrl;

/**
 * Normalize a user-entered server URL into a base URL suitable for setBackendUrl().
 * Adds protocol if missing, strips trailing slashes, and strips a trailing /api suffix
 * (since all API methods append their own /api/... paths to _backendUrl).
 */
export function normalizeServerUrl(input: string): string {
  let url = input.trim().replace(/\/+$/, '');

  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    if (url.startsWith('localhost') || url.startsWith('127.0.0.1')) {
      url = `http://${url}`;
    } else {
      url = `https://${url}`;
    }
  }

  try {
    const parsed = new URL(url);
    if (parsed.pathname.replace(/\/+$/, '') === '/api') {
      parsed.pathname = '/';
    }
    parsed.search = '';
    parsed.hash = '';
    url = parsed.toString().replace(/\/$/, '');
  } catch {
    // Strip /api suffix if present — _backendUrl stores the base, not the /api path
    url = url.replace(/\/api$/, '');
    // Keep the best-effort normalized string for user-entered values.
  }

  return url;
}

// ── Internal Helpers ───────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 30_000;
const PROBE_TIMEOUT_MS = 2_000;
const MAX_NDJSON_GRAPH_BYTES = 50 * 1024 * 1024;
const MAX_NDJSON_LINE_CHARS = 5 * 1024 * 1024;
const MAX_SSE_BUFFER_CHARS = 1024 * 1024;
const FETCH_TIMEOUT_CLEANUP = Symbol('ontoindex.fetchTimeoutCleanup');

type TimedResponse = Response & { [FETCH_TIMEOUT_CLEANUP]?: () => void };

const cleanupTimedResponse = (response: Response): void => {
  (response as TimedResponse)[FETCH_TIMEOUT_CLEANUP]?.();
};

const attachTimeoutCleanup = (response: Response, cleanup: () => void): Response => {
  let cleaned = false;
  const cleanupOnce = () => {
    if (cleaned) return;
    cleaned = true;
    cleanup();
  };
  (response as TimedResponse)[FETCH_TIMEOUT_CLEANUP] = cleanupOnce;

  const wrapBodyMethod = <K extends 'arrayBuffer' | 'blob' | 'formData' | 'json' | 'text'>(
    method: K,
  ) => {
    const original = response[method].bind(response);
    response[method] = (async () => {
      try {
        return await original();
      } finally {
        cleanupOnce();
      }
    }) as Response[K];
  };

  wrapBodyMethod('arrayBuffer');
  wrapBodyMethod('blob');
  wrapBodyMethod('formData');
  wrapBodyMethod('json');
  wrapBodyMethod('text');
  return response;
};

const isPublicBackendRequest = (url: string, method: string): boolean => {
  if (method.toUpperCase() !== 'GET') return false;
  try {
    const pathname = new URL(url, _backendUrl).pathname;
    return pathname === '/api/heartbeat' || pathname === '/api/info';
  } catch {
    return false;
  }
};

const isProtectedBackendRequest = (url: string, method: string): boolean => {
  try {
    const pathname = new URL(url, _backendUrl).pathname;
    return pathname.startsWith('/api/') && !isPublicBackendRequest(url, method);
  } catch {
    return false;
  }
};

const withBackendAuth = (url: string, init: RequestInit = {}): RequestInit => {
  const method = init.method ?? 'GET';
  if (!isProtectedBackendRequest(url, method)) return init;

  const token = getBackendAuthToken();
  if (!token) return init;

  const headers = new Headers(init.headers);
  if (!headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${token}`);
  }
  return { ...init, headers };
};

const fetchWithTimeout = async (
  url: string,
  init: RequestInit = {},
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<Response> => {
  const requestInit = withBackendAuth(url, init);
  const controller = new AbortController();
  // Merge external signal if provided
  const externalSignal = requestInit.signal;
  const onExternalAbort = () => controller.abort();
  if (externalSignal) {
    externalSignal.addEventListener('abort', onExternalAbort, { once: true });
  }
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const cleanup = () => {
    if (externalSignal) {
      externalSignal.removeEventListener('abort', onExternalAbort);
    }
    clearTimeout(timer);
  };

  try {
    const response = await fetch(url, { ...requestInit, signal: controller.signal });
    return attachTimeoutCleanup(response, cleanup);
  } catch (error: unknown) {
    cleanup();
    if (error instanceof DOMException && error.name === 'AbortError') {
      if (externalSignal?.aborted) {
        throw new BackendError('Request aborted', 0, 'network');
      }
      throw new BackendError(`Request to ${url} timed out after ${timeoutMs}ms`, 0, 'timeout');
    }
    if (error instanceof TypeError) {
      throw new BackendError(
        `Network error reaching OntoIndex backend at ${_backendUrl}: ${error.message}`,
        0,
        'network',
      );
    }
    throw error;
  }
};

const assertOk = async (response: Response): Promise<void> => {
  if (response.ok) return;

  let message = response.statusText;
  try {
    const body = await response.json();
    if (body && typeof body.error === 'string') {
      message = body.error;
    } else if (body && typeof body.message === 'string') {
      message = body.message;
    }
  } catch {
    // Response body was not JSON
  }

  const code =
    response.status === 404
      ? 'not_found'
      : response.status >= 400 && response.status < 500
        ? 'client'
        : 'server';
  throw new BackendError(message, response.status, code);
};

const repoParam = (repo?: string): string => (repo ? `repo=${encodeURIComponent(repo)}` : '');

// ── API Methods ────────────────────────────────────────────────────────────

/** Contract version bundle returned by /api/info. */
export interface ServerContractVersions {
  graph_schema: string;
  meta_json: string;
  mcp_tools: string;
  web_api: string;
}

/** Server info from /api/info. */
export interface ServerInfo {
  version: string;
  launchContext: 'npx' | 'global' | 'local';
  nodeVersion: string;
  /** Optional contract version bundle (present when server exposes it). */
  contract?: ServerContractVersions;
}

/** Fetch server info (version, launch context). */
export const fetchServerInfo = async (): Promise<ServerInfo> => {
  const response = await fetchWithTimeout(`${_backendUrl}/api/info`);
  await assertOk(response);
  return response.json() as Promise<ServerInfo>;
};

/** Fetch a bounded, redacted runtime snapshot for MCP sessions. */
export const fetchMcpDiagnostics = async (): Promise<McpDiagnosticsResponse> => {
  const response = await fetchWithTimeout(`${_backendUrl}/api/mcp/diagnostics`);
  await assertOk(response);
  const data: unknown = await response.json();
  const diagnostics = parseMcpDiagnosticsResponse(data);
  if (!diagnostics) {
    throw new BackendError('Unexpected server response shape', response.status, 'server');
  }
  return diagnostics;
};

/**
 * Connect an SSE heartbeat to the backend. Retries indefinitely with capped
 * exponential backoff so transient hiccups don't reset the UI.
 *
 * - `onConnect` fires on every successful (re)connection.
 * - `onReconnecting` fires on the first retry after a drop — use it to show
 *   a "reconnecting" banner while keeping the current view intact.
 *
 * Returns a cleanup function that tears down the EventSource and timers.
 */
export const connectHeartbeat = (
  onConnect: () => void,
  onReconnecting: () => void,
): (() => void) => {
  let closed = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let es: EventSource | null = null;
  let attempt = 0;
  /** Whether we've already fired onReconnecting for the current drop. */
  let notifiedReconnecting = false;
  const MAX_BACKOFF_MS = 15_000;

  const connect = () => {
    if (closed) return;
    es = new EventSource(`${_backendUrl}/api/heartbeat`);
    es.onopen = () => {
      if (!closed) {
        attempt = 0;
        notifiedReconnecting = false;
        onConnect();
      }
    };
    es.onerror = () => {
      es?.close();
      es = null;
      if (closed) return;

      if (!notifiedReconnecting) {
        notifiedReconnecting = true;
        onReconnecting();
      }

      const delay = Math.min(1_000 * Math.pow(2, attempt), MAX_BACKOFF_MS);
      attempt++;
      retryTimer = setTimeout(connect, delay);
    };
  };

  connect();

  return () => {
    closed = true;
    es?.close();
    if (retryTimer) clearTimeout(retryTimer);
  };
};

/** Delete a repo's index and unregister it. */
export const deleteRepo = async (repoName: string): Promise<void> => {
  const response = await fetchWithTimeout(
    `${_backendUrl}/api/repo?repo=${encodeURIComponent(repoName)}`,
    {
      method: 'DELETE',
    },
  );
  try {
    await assertOk(response);
  } finally {
    cleanupTimedResponse(response);
  }
};

/** Probe the backend. Returns true if reachable. */
export const probeBackend = async (): Promise<boolean> => {
  try {
    const response = await fetchWithTimeout(`${_backendUrl}/api/info`, {}, PROBE_TIMEOUT_MS);
    try {
      return response.status === 200;
    } finally {
      cleanupTimedResponse(response);
    }
  } catch {
    return false;
  }
};

/** Fetch list of indexed repositories. */
export const fetchRepos = async (): Promise<BackendRepo[]> => {
  const response = await fetchWithTimeout(`${_backendUrl}/api/repos`);
  await assertOk(response);
  const data: unknown = await response.json();
  if (!isBackendRepoArray(data)) {
    throw new BackendError('Unexpected server response shape', response.status, 'server');
  }
  return data;
};

/** Fetch repo metadata.
 * Pass `awaitAnalysis: true` when connecting to a repo that may still be cloning/analyzing —
 * this enables the backend's hold-queue and uses a 5-minute timeout to match.
 * Normal calls (e.g. repo switching between already-indexed repos) use the default 10s timeout.
 *
 * Must stay in sync with HOLD_QUEUE_TIMEOUT_SECS in ontoindex/src/server/api.ts.
 */
const HOLD_QUEUE_TIMEOUT_MS = 300_000; // 5 minutes — matches backend HOLD_QUEUE_TIMEOUT_SECS

export const fetchRepoInfo = async (
  repo?: string,
  opts?: { awaitAnalysis?: boolean },
): Promise<BackendRepo> => {
  const url = `${_backendUrl}/api/repo${repo ? `?${repoParam(repo)}` : ''}`;
  const timeout = opts?.awaitAnalysis ? HOLD_QUEUE_TIMEOUT_MS : undefined;
  const response = await fetchWithTimeout(url, {}, timeout);
  await assertOk(response);
  const data: unknown = await response.json();
  if (!isBackendRepo(data)) {
    throw new BackendError('Unexpected server response shape', response.status, 'server');
  }
  return { ...data, repoPath: data.repoPath ?? data.path };
};

/** Fetch the graph (nodes + relationships). Content stripped by default. */
export const fetchGraph = async (
  repo?: string,
  opts?: {
    includeContent?: boolean;
    signal?: AbortSignal;
    onProgress?: (downloaded: number, total: number | null) => void;
    summary?: boolean;
  },
): Promise<{ nodes: GraphNode[]; relationships: GraphRelationship[] }> => {
  const params = [
    repoParam(repo),
    opts?.includeContent ? 'includeContent=true' : '',
    'stream=true',
    opts?.summary ? 'summary=true' : '',
  ]
    .filter(Boolean)
    .join('&');
  const url = `${_backendUrl}/api/graph${params ? `?${params}` : ''}`;
  // Large repos can take a while to serialize the graph — use an elevated timeout
  const response = await fetchWithTimeout(url, { signal: opts?.signal }, 120_000);
  await assertOk(response);

  const contentType = response.headers.get('Content-Type') || '';
  if (contentType.includes('application/x-ndjson')) {
    return parseNdjsonGraphResponse(response, opts?.onProgress);
  }

  if (!opts?.onProgress || !response.body) {
    const data: unknown = await response.json();
    if (!isGraphResponse(data)) {
      throw new BackendError('Unexpected server response shape', response.status, 'server');
    }
    return data as { nodes: GraphNode[]; relationships: GraphRelationship[] };
  }

  return downloadGraphJsonWithProgress(response, opts.onProgress);
};

const downloadGraphJsonWithProgress = async (
  response: Response,
  onProgress: (downloaded: number, total: number | null) => void,
): Promise<{ nodes: GraphNode[]; relationships: GraphRelationship[] }> => {
  if (!response.body) {
    return response.json() as Promise<{ nodes: GraphNode[]; relationships: GraphRelationship[] }>;
  }

  // Streaming decode: avoids allocating a second combined Uint8Array buffer
  const contentLength = response.headers.get('Content-Length');
  const total = contentLength ? parseInt(contentLength, 10) : null;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      if (text.length > MAX_GRAPH_JSON_BYTES) {
        reader.cancel().catch(() => {});
        throw new BackendError('Graph response too large for legacy JSON mode', 0, 'client');
      }
      onProgress(text.length, total);
    }
    text += decoder.decode(); // flush
    return JSON.parse(text);
  } finally {
    cleanupTimedResponse(response);
    reader.releaseLock();
  }
};

const parseGraphStreamRecord = (
  line: string,
  status: number,
  nodes: GraphNode[],
  relationships: GraphRelationship[],
): void => {
  const trimmed = line.trim();
  if (!trimmed) return;

  const record = JSON.parse(trimmed) as
    | { type: 'node'; data: GraphNode }
    | { type: 'relationship'; data: GraphRelationship }
    | { type: 'error'; error: string };

  if (record.type === 'node') {
    nodes.push(record.data);
    return;
  }
  if (record.type === 'relationship') {
    relationships.push(record.data);
    return;
  }
  if (record.type === 'error') {
    throw new BackendError(record.error, status || 500, 'server');
  }
};

const parseNdjsonGraphResponse = async (
  response: Response,
  onProgress?: (downloaded: number, total: number | null) => void,
): Promise<{ nodes: GraphNode[]; relationships: GraphRelationship[] }> => {
  if (!response.body) {
    throw new BackendError('No response body', response.status, 'server');
  }

  const contentLength = response.headers.get('Content-Length');
  const total = contentLength ? parseInt(contentLength, 10) : null;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const nodes: GraphNode[] = [];
  const relationships: GraphRelationship[] = [];
  let buffer = '';
  let downloaded = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      downloaded += value.length;
      if (downloaded > MAX_NDJSON_GRAPH_BYTES) {
        reader.cancel().catch(() => {});
        throw new BackendError('Graph stream too large', response.status || 0, 'client');
      }
      onProgress?.(downloaded, total);
      buffer += decoder.decode(value, { stream: true });
      if (buffer.length > MAX_NDJSON_LINE_CHARS) {
        reader.cancel().catch(() => {});
        throw new BackendError('Graph stream line too large', response.status || 0, 'client');
      }

      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        parseGraphStreamRecord(line, response.status, nodes, relationships);
      }
    }

    buffer += decoder.decode();
    if (buffer.length > MAX_NDJSON_LINE_CHARS) {
      throw new BackendError('Graph stream line too large', response.status || 0, 'client');
    }
    parseGraphStreamRecord(buffer, response.status, nodes, relationships);

    return { nodes, relationships };
  } finally {
    cleanupTimedResponse(response);
    reader.releaseLock();
  }
};

/** Execute a Cypher query. Returns rows. */
export const runQuery = async (
  cypher: string,
  repo?: string,
): Promise<Record<string, unknown>[]> => {
  const response = await fetchWithTimeout(`${_backendUrl}/api/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cypher, repo }),
  });
  await assertOk(response);
  const body = await response.json();
  return (body.result ?? body) as Record<string, unknown>[];
};

/** Search with optional enrichment and mode selection. */
export const search = async (
  query: string,
  opts?: { limit?: number; mode?: 'hybrid' | 'semantic' | 'bm25'; enrich?: boolean; repo?: string },
): Promise<EnrichedSearchResult[]> => {
  const response = await fetchWithTimeout(`${_backendUrl}/api/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query,
      limit: opts?.limit,
      mode: opts?.mode,
      enrich: opts?.enrich,
      repo: opts?.repo,
    }),
  });
  await assertOk(response);
  const body = await response.json();
  return (body.results ?? []) as EnrichedSearchResult[];
};

/** Grep across file contents in the indexed repo. */
export const grep = async (
  pattern: string,
  repo?: string,
  limit?: number,
): Promise<GrepResult[]> => {
  const params = [
    `pattern=${encodeURIComponent(pattern)}`,
    repoParam(repo),
    limit ? `limit=${limit}` : '',
  ]
    .filter(Boolean)
    .join('&');
  const response = await fetchWithTimeout(`${_backendUrl}/api/grep?${params}`);
  await assertOk(response);
  const body = await response.json();
  return (body.results ?? []) as GrepResult[];
};

/** Result from reading a file, optionally with line range. */
export interface ReadFileResult {
  content: string;
  startLine?: number;
  endLine?: number;
  totalLines: number | null;
  totalLinesKnown?: boolean;
  scannedLines?: number;
}

/** Read a file's content. Supports optional line range (0-indexed). */
export const readFile = async (
  filePath: string,
  options?: { startLine?: number; endLine?: number; repo?: string },
): Promise<ReadFileResult> => {
  const params = [
    `path=${encodeURIComponent(filePath)}`,
    repoParam(options?.repo),
    options?.startLine !== undefined ? `startLine=${options.startLine}` : '',
    options?.endLine !== undefined ? `endLine=${options.endLine}` : '',
  ]
    .filter(Boolean)
    .join('&');
  const response = await fetchWithTimeout(`${_backendUrl}/api/file?${params}`);
  await assertOk(response);
  const data: unknown = await response.json();
  if (!isReadFileResult(data)) {
    throw new BackendError('Unexpected server response shape', response.status, 'server');
  }
  return data;
};

/** Fetch all processes for a repo. */
export const fetchProcesses = async (repo?: string): Promise<unknown> => {
  const response = await fetchWithTimeout(
    `${_backendUrl}/api/processes${repo ? `?${repoParam(repo)}` : ''}`,
  );
  await assertOk(response);
  return response.json();
};

/** Fetch detail for a single process. */
export const fetchProcessDetail = async (repo: string, name: string): Promise<unknown> => {
  const response = await fetchWithTimeout(
    `${_backendUrl}/api/process?${repoParam(repo)}&name=${encodeURIComponent(name)}`,
  );
  await assertOk(response);
  return response.json();
};

/** Fetch all clusters for a repo. */
export const fetchClusters = async (repo?: string): Promise<unknown> => {
  const response = await fetchWithTimeout(
    `${_backendUrl}/api/clusters${repo ? `?${repoParam(repo)}` : ''}`,
  );
  await assertOk(response);
  return response.json();
};

/** Fetch detail for a single cluster. */
export const fetchClusterDetail = async (repo: string, name: string): Promise<unknown> => {
  const response = await fetchWithTimeout(
    `${_backendUrl}/api/cluster?${repoParam(repo)}&name=${encodeURIComponent(name)}`,
  );
  await assertOk(response);
  return response.json();
};

// ── Analyze API ────────────────────────────────────────────────────────────

/** Start a server-side analysis job. */
export const startAnalyze = async (request: {
  url?: string;
  path?: string;
  force?: boolean;
  embeddings?: boolean;
}): Promise<{ jobId: string; status: string }> => {
  const response = await fetchWithTimeout(
    `${_backendUrl}/api/analyze`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    },
    30_000,
  );
  await assertOk(response);
  return response.json() as Promise<{ jobId: string; status: string }>;
};

/** Poll analysis job status. */
export const getAnalyzeStatus = async (jobId: string): Promise<JobStatus> => {
  const response = await fetchWithTimeout(
    `${_backendUrl}/api/analyze/${encodeURIComponent(jobId)}`,
  );
  await assertOk(response);
  return response.json() as Promise<JobStatus>;
};

/** Cancel a running analysis job. */
export const cancelAnalyze = async (jobId: string): Promise<void> => {
  const response = await fetchWithTimeout(
    `${_backendUrl}/api/analyze/${encodeURIComponent(jobId)}`,
    { method: 'DELETE' },
  );
  try {
    await assertOk(response);
  } finally {
    cleanupTimedResponse(response);
  }
};

/** Stream analysis progress via SSE. */
export const streamAnalyzeProgress = (
  jobId: string,
  onProgress: (progress: JobProgress) => void,
  onComplete: (data: { repoName?: string }) => void,
  onError: (error: string) => void,
): AbortController => {
  return streamSSE<JobProgress>(
    `${_backendUrl}/api/analyze/${encodeURIComponent(jobId)}/progress`,
    {
      onMessage: onProgress,
      onComplete: onComplete as (data: unknown) => void,
      onError,
    },
  );
};

// ── Embed API ──────────────────────────────────────────────────────────────

/** Start server-side embedding generation. */
export const startEmbeddings = async (repo: string): Promise<{ jobId: string; status: string }> => {
  const response = await fetchWithTimeout(
    `${_backendUrl}/api/embed`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo }),
    },
    30_000,
  );
  await assertOk(response);
  return response.json() as Promise<{ jobId: string; status: string }>;
};

/** Poll embedding job status. */
export const getEmbedStatus = async (jobId: string): Promise<JobStatus> => {
  const response = await fetchWithTimeout(`${_backendUrl}/api/embed/${encodeURIComponent(jobId)}`);
  await assertOk(response);
  return response.json() as Promise<JobStatus>;
};

/** Cancel a running embedding job. */
export const cancelEmbeddings = async (jobId: string): Promise<void> => {
  const response = await fetchWithTimeout(`${_backendUrl}/api/embed/${encodeURIComponent(jobId)}`, {
    method: 'DELETE',
  });
  try {
    await assertOk(response);
  } finally {
    cleanupTimedResponse(response);
  }
};

/** Stream embedding progress via SSE. */
export const streamEmbeddingProgress = (
  jobId: string,
  onProgress: (progress: JobProgress) => void,
  onComplete: (data: { repoName?: string }) => void,
  onError: (error: string) => void,
): AbortController => {
  return streamSSE<JobProgress>(`${_backendUrl}/api/embed/${encodeURIComponent(jobId)}/progress`, {
    onMessage: onProgress,
    onComplete: onComplete as (data: unknown) => void,
    onError,
  });
};

// ── Convenience: connect to server ─────────────────────────────────────────

export interface ConnectResult {
  nodes: GraphNode[];
  relationships: GraphRelationship[];
  repoInfo: BackendRepo;
  isSummary: boolean;
}

/**
 * Connect to a server: validate, fetch repo info, download graph.
 * Content is NOT included (use readFile/grep for file access).
 * Pass `awaitAnalysis: true` when the repo may still be cloning/analyzing —
 * this enables the backend hold-queue and a 5-minute fetch timeout.
 */
export async function connectToServer(
  url: string,
  onProgress?: (phase: string, downloaded: number, total: number | null) => void,
  signal?: AbortSignal,
  repoName?: string,
  opts?: { awaitAnalysis?: boolean; forceFull?: boolean },
): Promise<ConnectResult> {
  const baseUrl = normalizeServerUrl(url);
  setBackendUrl(baseUrl);

  onProgress?.('validating', 0, null);
  const repoInfo = await fetchRepoInfo(repoName, { awaitAnalysis: opts?.awaitAnalysis });

  const nodeCount = repoInfo.stats?.nodes ?? 0;
  const isHuge = nodeCount > HUGE_GRAPH_THRESHOLD && !opts?.forceFull;

  onProgress?.('downloading', 0, null);
  const { nodes, relationships } = await fetchGraph(repoName, {
    signal,
    onProgress: (downloaded, total) => onProgress?.('downloading', downloaded, total),
    summary: isHuge,
  });

  return { nodes, relationships, repoInfo, isSummary: isHuge };
}
