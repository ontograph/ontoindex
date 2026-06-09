import { appendFile, mkdir, rename, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const TELEMETRY_DIR = join(homedir(), '.ontoindex');
const TELEMETRY_PATH = join(TELEMETRY_DIR, 'telemetry.jsonl');
const ROTATE_BYTES = 10 * 1024 * 1024;

interface TelemetryRecord {
  ts: string;
  method: string;
  repo: string;
  durationMs: number;
  responseSizeBytes: number;
  ok: boolean;
}

async function rotateIfNeeded(): Promise<void> {
  try {
    const s = await stat(TELEMETRY_PATH);
    if (s.size >= ROTATE_BYTES) {
      await rename(TELEMETRY_PATH, TELEMETRY_PATH + '.1');
    }
  } catch {
    // file doesn't exist yet — nothing to rotate
  }
}

export function recordToolCall(record: TelemetryRecord): void {
  // Fire-and-forget: telemetry must never fail a tool call
  void (async () => {
    try {
      await mkdir(TELEMETRY_DIR, { recursive: true });
      await rotateIfNeeded();
      await appendFile(TELEMETRY_PATH, JSON.stringify(record) + '\n', 'utf8');
    } catch {
      // intentionally swallowed
    }
  })();
}
