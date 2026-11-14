import { appendFile, mkdir, readFile, rename, stat } from 'node:fs/promises';
import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

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

async function rotateIfNeeded(telemetryPath: string): Promise<void> {
  try {
    const s = await stat(telemetryPath);
    if (s.size >= ROTATE_BYTES) {
      await rename(telemetryPath, telemetryPath + '.1');
    }
  } catch {
    // file doesn't exist yet — nothing to rotate
  }
}

export function recordToolCall(record: TelemetryRecord): void {
  // Fire-and-forget: telemetry must never fail a tool call
  void (async () => {
    try {
      const telemetryDir = process.env.ONTOINDEX_TELEMETRY_DIR ?? join(homedir(), '.ontoindex');
      const telemetryPath = join(telemetryDir, 'telemetry.jsonl');
      await mkdir(telemetryDir, { recursive: true });
      await rotateIfNeeded(telemetryPath);
      await appendFile(telemetryPath, JSON.stringify(record) + '\n', 'utf8');
    } catch {
      // intentionally swallowed
    }
  })();
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
