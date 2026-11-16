import { readFile } from 'node:fs/promises';
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';

interface ToolCallTelemetryScope {
  closed: boolean;
  fail(error: unknown): void;
  setResponseSize(bytes: number): void;
}

const toolCallScope = new AsyncLocalStorage<ToolCallTelemetryScope>();
let toolCallTelemetryCounter = 0;

export function hasToolCallTelemetryScope(): boolean {
  const scope = toolCallScope.getStore();
  return scope !== undefined && !scope.closed;
}

export function toolCallErrorFields(error: unknown): { code?: string; reason?: string } {
  const candidate =
    error !== null && typeof error === 'object'
      ? (error as { code?: unknown; diagnostics?: { reason?: unknown } })
      : undefined;
  const valid = (value: unknown): value is string =>
    typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(value);
  return {
    ...(valid(candidate?.code) ? { code: candidate.code } : {}),
    ...(valid(candidate?.diagnostics?.reason) ? { reason: candidate.diagnostics.reason } : {}),
  };
}

export async function withToolCallTelemetry<T>(
  method: string,
  params: unknown,
  operation: (scope: ToolCallTelemetryScope) => Promise<T>,
): Promise<T> {
  const normalized =
    params !== null && typeof params === 'object' ? (params as Record<string, unknown>) : {};
  const repo =
    typeof normalized.repo === 'string' && !normalized.repo.startsWith('@') ? normalized.repo : '';
  const readMode =
    normalized.read_mode === 'committed' || normalized.read_mode === 'workspace'
      ? normalized.read_mode
      : undefined;
  const id = `${process.pid}-${++toolCallTelemetryCounter}`;
  const start = Date.now();
  let ok = true;
  let error: unknown;
  let responseSizeBytes = 0;
  const scope: ToolCallTelemetryScope = {
    closed: false,
    fail(failure) {
      if (!scope.closed) {
        ok = false;
        error = failure;
      }
    },
    setResponseSize(bytes) {
      if (!scope.closed) responseSizeBytes = bytes;
    },
  };
  recordToolCallStart({
    phase: 'start',
    ts: new Date().toISOString(),
    id,
    method,
    repo,
    ...(readMode ? { readMode } : {}),
  });
  return toolCallScope.run(scope, async () => {
    try {
      return await operation(scope);
    } catch (failure) {
      scope.fail(failure);
      throw failure;
    } finally {
      scope.closed = true;
      recordToolCall({
        ts: new Date().toISOString(),
        id,
        method,
        repo,
        durationMs: Date.now() - start,
        responseSizeBytes,
        ok,
        ...toolCallErrorFields(error),
      });
    }
  });
}

const ROTATE_BYTES = 10 * 1024 * 1024;

interface TelemetryRecord {
  ts: string;
  method: string;
  repo: string;
  durationMs: number;
  responseSizeBytes: number;
  ok: boolean;
  id?: string;
  code?: string;
  reason?: string;
}

interface ToolCallStartRecord {
  phase: 'start';
  ts: string;
  id: string;
  method: string;
  repo: string;
  readMode?: 'committed' | 'workspace';
}

export const TOOL_TELEMETRY_OVERSIZED_BYTES = 512 * 1024;

export function recordToolCallStart(record: ToolCallStartRecord): void {
  try {
    const telemetryDir = process.env.ONTOINDEX_TELEMETRY_DIR ?? join(homedir(), '.ontoindex');
    const telemetryPath = join(telemetryDir, 'telemetry.jsonl');
    mkdirSync(telemetryDir, { recursive: true });
    appendFileSync(telemetryPath, JSON.stringify(record) + '\n', 'utf8');
  } catch {
    // A start record must never fail a tool call.
  }
}

function rotateIfNeeded(telemetryPath: string): void {
  try {
    const s = statSync(telemetryPath);
    if (s.size >= ROTATE_BYTES) {
      renameSync(telemetryPath, telemetryPath + '.1');
    }
  } catch {
    // file doesn't exist yet — nothing to rotate
  }
}

export function recordToolCall(record: TelemetryRecord): void {
  try {
    const telemetryDir = process.env.ONTOINDEX_TELEMETRY_DIR ?? join(homedir(), '.ontoindex');
    const telemetryPath = join(telemetryDir, 'telemetry.jsonl');
    mkdirSync(telemetryDir, { recursive: true });
    rotateIfNeeded(telemetryPath);
    appendFileSync(telemetryPath, JSON.stringify(record) + '\n', 'utf8');
  } catch {
    // intentionally swallowed
  }
}

export async function readRecentOversizedToolCalls(
  options: { limit?: number } = {},
): Promise<string[]> {
  const limit = Math.max(1, Math.min(options.limit ?? 5, 20));
  try {
    const telemetryDir = process.env.ONTOINDEX_TELEMETRY_DIR ?? join(homedir(), '.ontoindex');
    const content = await readFile(join(telemetryDir, 'telemetry.jsonl'), 'utf8');
    const seen = new Set<string>();
    const result: string[] = [];
    const lines = content.trim().split('\n').reverse();
    for (const line of lines) {
      if (result.length >= limit) break;
      const parsed = JSON.parse(line) as Partial<TelemetryRecord> & { phase?: string };
      if (
        parsed.phase !== 'start' &&
        typeof parsed.method === 'string' &&
        typeof parsed.responseSizeBytes === 'number' &&
        parsed.responseSizeBytes >= TOOL_TELEMETRY_OVERSIZED_BYTES &&
        !seen.has(parsed.method)
      ) {
        seen.add(parsed.method);
        result.push(parsed.method);
      }
    }
    return result;
  } catch {
    return [];
  }
}

export interface ToolTelemetrySummary {
  recentOversizedCount: number;
  recentOversizedTools: string[];
}

export async function readToolTelemetrySummary(
  options: { limit?: number } = {},
): Promise<ToolTelemetrySummary> {
  const recentOversizedTools = await readRecentOversizedToolCalls(options);
  return {
    recentOversizedCount: recentOversizedTools.length,
    recentOversizedTools,
  };
}
