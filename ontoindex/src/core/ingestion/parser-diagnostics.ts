import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

export type ParserDiagnosticKind = 'parse-error' | 'degraded';

export interface ParserDiagnosticEntry {
  kind: ParserDiagnosticKind;
  filePath: string;
  reason: string;
  phase: string;
  reasonTruncated?: true;
  phaseTruncated?: true;
}

export interface ParserDiagnosticsSummary {
  version: 1;
  complete: true;
  chunkSize: number;
  parseErrorCount: number;
  degradedEntryCount: number;
  parseErrorChunkCount: number;
  degradedChunkCount: number;
}

export interface ParserDiagnosticsPage {
  generation: string;
  source: 'committed' | 'workspace-overlay';
  kind: 'all' | ParserDiagnosticKind;
  offset: number;
  limit: number;
  total: number;
  returned: number;
  truncated: boolean;
  nextOffset?: number;
  nextCursor?: string;
  complete: true;
  totals: { parseErrorCount: number; degradedEntryCount: number };
  items: ParserDiagnosticEntry[];
}

const DIRECTORY = 'parser-diagnostics';
const CHUNK_SIZE = 256;
const MAX_PAGE_SIZE = 100;
const MAX_FILE_PATH_BYTES = 16_384;
const MAX_REASON_CHARS = 512;
const MAX_PHASE_CHARS = 64;
const CURSOR_PREFIX = 'gn-parser-diagnostics-v1:';

export interface ParserDiagnosticsCursorState {
  source: 'committed' | 'workspace-overlay';
  generation: string;
  kind: 'all' | ParserDiagnosticKind;
  offset: number;
  limit: number;
}

function encodeCursor(state: ParserDiagnosticsCursorState): string {
  const payload = Buffer.from(JSON.stringify(state)).toString('base64url');
  const digest = createHash('sha256').update(`${CURSOR_PREFIX}${payload}`).digest('hex');
  return `${CURSOR_PREFIX}${payload}.${digest}`;
}

export function decodeParserDiagnosticsCursor(
  cursor: string,
  expected: {
    source?: ParserDiagnosticsCursorState['source'];
    kind?: ParserDiagnosticsCursorState['kind'];
    limit?: number;
  } = {},
): ParserDiagnosticsCursorState {
  if (cursor.length > 512 || !cursor.startsWith(CURSOR_PREFIX)) {
    throw new Error('Invalid parser diagnostics cursor.');
  }
  const match = /^gn-parser-diagnostics-v1:([A-Za-z0-9_-]+)\.([a-f0-9]{64})$/.exec(cursor);
  if (!match) throw new Error('Invalid parser diagnostics cursor.');
  const [, encoded, suppliedDigest] = match;
  const expectedDigest = createHash('sha256').update(`${CURSOR_PREFIX}${encoded}`).digest('hex');
  if (suppliedDigest !== expectedDigest) throw new Error('Invalid parser diagnostics cursor.');
  let parsed: unknown;
  try {
    const raw = Buffer.from(encoded, 'base64url');
    if (raw.toString('base64url') !== encoded) throw new Error('non-canonical cursor payload');
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    throw new Error('Invalid parser diagnostics cursor.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Invalid parser diagnostics cursor.');
  }
  const state = parsed as Record<string, unknown>;
  if (
    (state.source !== 'committed' && state.source !== 'workspace-overlay') ||
    (state.kind !== 'all' && state.kind !== 'parse-error' && state.kind !== 'degraded') ||
    typeof state.generation !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(state.generation) ||
    !Number.isSafeInteger(state.offset) ||
    (state.offset as number) < 0 ||
    !Number.isSafeInteger(state.limit) ||
    (state.limit as number) < 1 ||
    (state.limit as number) > MAX_PAGE_SIZE ||
    Object.keys(state).sort().join(',') !== 'generation,kind,limit,offset,source'
  ) {
    throw new Error('Invalid parser diagnostics cursor.');
  }
  const result = state as unknown as ParserDiagnosticsCursorState;
  if (
    (expected.source !== undefined && result.source !== expected.source) ||
    (expected.kind !== undefined && result.kind !== expected.kind) ||
    (expected.limit !== undefined && result.limit !== expected.limit)
  ) {
    throw new Error('Parser diagnostics cursor does not match this request.');
  }
  return result;
}

function normalizeFilePath(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  if (
    !normalized ||
    path.posix.isAbsolute(normalized) ||
    normalized.split('/').some((part) => part === '..')
  ) {
    throw new Error('Parser diagnostic file paths must be repository-relative.');
  }
  return normalized;
}

function chunkFilename(kind: ParserDiagnosticKind, index: number): string {
  return `${kind}-${String(index).padStart(8, '0')}.json`;
}

function isPlainDirectory(target: string): boolean {
  try {
    const stat = fs.lstatSync(target);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function validateEntry(value: unknown, kind: ParserDiagnosticKind): ParserDiagnosticEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid parser diagnostic entry.');
  }
  const entry = value as Record<string, unknown>;
  if (
    entry.kind !== kind ||
    typeof entry.filePath !== 'string' ||
    typeof entry.reason !== 'string' ||
    entry.reason.length > MAX_REASON_CHARS ||
    typeof entry.phase !== 'string' ||
    entry.phase.length > MAX_PHASE_CHARS
  ) {
    throw new Error('Invalid parser diagnostic entry.');
  }
  if (Buffer.byteLength(entry.filePath) > MAX_FILE_PATH_BYTES) {
    throw new Error('Parser diagnostic file path exceeds the storage bound.');
  }
  return {
    kind,
    filePath: normalizeFilePath(entry.filePath),
    reason: entry.reason,
    phase: entry.phase,
    ...(entry.reasonTruncated === true ? { reasonTruncated: true as const } : {}),
    ...(entry.phaseTruncated === true ? { phaseTruncated: true as const } : {}),
  };
}

export function isValidParserDiagnosticsSummary(value: unknown): value is ParserDiagnosticsSummary {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const summary = value as Record<string, unknown>;
  if (
    summary.version !== 1 ||
    summary.complete !== true ||
    summary.chunkSize !== CHUNK_SIZE ||
    !Number.isSafeInteger(summary.parseErrorCount) ||
    !Number.isSafeInteger(summary.degradedEntryCount) ||
    !Number.isSafeInteger(summary.parseErrorChunkCount) ||
    !Number.isSafeInteger(summary.degradedChunkCount) ||
    (summary.parseErrorCount as number) < 0 ||
    (summary.degradedEntryCount as number) < 0 ||
    (summary.parseErrorChunkCount as number) < 0 ||
    (summary.degradedChunkCount as number) < 0
  ) {
    return false;
  }
  return (
    summary.parseErrorChunkCount === Math.ceil((summary.parseErrorCount as number) / CHUNK_SIZE) &&
    summary.degradedChunkCount === Math.ceil((summary.degradedEntryCount as number) / CHUNK_SIZE) &&
    Number.isSafeInteger(
      (summary.parseErrorCount as number) + (summary.degradedEntryCount as number),
    )
  );
}

/** Writes bounded chunks into an unpublished index or overlay generation. */
export class ParserDiagnosticsWriter {
  readonly directoryPath: string;
  private readonly buffers: Record<ParserDiagnosticKind, ParserDiagnosticEntry[]> = {
    'parse-error': [],
    degraded: [],
  };
  private readonly counts: Record<ParserDiagnosticKind, number> = {
    'parse-error': 0,
    degraded: 0,
  };
  private readonly chunkCounts: Record<ParserDiagnosticKind, number> = {
    'parse-error': 0,
    degraded: 0,
  };
  private finished = false;

  constructor(generationPath: string) {
    if (!isPlainDirectory(generationPath)) throw new Error('Invalid diagnostics generation.');
    this.directoryPath = path.join(generationPath, DIRECTORY);
    fs.mkdirSync(this.directoryPath, { mode: 0o700 });
    if (!isPlainDirectory(this.directoryPath)) throw new Error('Invalid diagnostics directory.');
  }

  append(entry: ParserDiagnosticEntry): void {
    if (this.finished) throw new Error('Parser diagnostics writer is already finalized.');
    if (
      !entry ||
      (entry.kind !== 'parse-error' && entry.kind !== 'degraded') ||
      typeof entry.reason !== 'string' ||
      typeof entry.phase !== 'string' ||
      typeof entry.filePath !== 'string'
    ) {
      throw new Error('Invalid parser diagnostic kind.');
    }
    const normalized = validateEntry(
      {
        ...entry,
        reason: entry.reason.slice(0, MAX_REASON_CHARS),
        phase: entry.phase.slice(0, MAX_PHASE_CHARS),
        ...(entry.reason.length > MAX_REASON_CHARS ? { reasonTruncated: true } : {}),
        ...(entry.phase.length > MAX_PHASE_CHARS ? { phaseTruncated: true } : {}),
      },
      entry.kind,
    );
    this.buffers[entry.kind].push(normalized);
    this.counts[entry.kind]++;
    if (this.buffers[entry.kind].length === CHUNK_SIZE) this.flush(entry.kind);
  }

  async finish(): Promise<ParserDiagnosticsSummary> {
    if (this.finished) throw new Error('Parser diagnostics writer is already finalized.');
    this.flush('parse-error');
    this.flush('degraded');
    const directory = await fsp.open(this.directoryPath, 'r');
    try {
      await directory.sync();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!['EISDIR', 'EPERM', 'EINVAL', 'ENOTSUP'].includes(code ?? '')) throw error;
    } finally {
      await directory.close();
    }
    this.finished = true;
    return {
      version: 1,
      complete: true,
      chunkSize: CHUNK_SIZE,
      parseErrorCount: this.counts['parse-error'],
      degradedEntryCount: this.counts.degraded,
      parseErrorChunkCount: this.chunkCounts['parse-error'],
      degradedChunkCount: this.chunkCounts.degraded,
    };
  }

  private flush(kind: ParserDiagnosticKind): void {
    const entries = this.buffers[kind];
    if (entries.length === 0) return;
    const target = path.join(this.directoryPath, chunkFilename(kind, this.chunkCounts[kind]));
    const fd = fs.openSync(target, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(entries));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    this.chunkCounts[kind]++;
    entries.length = 0;
  }
}

async function readCategoryPage(
  generationPath: string,
  kind: ParserDiagnosticKind,
  total: number,
  offset: number,
  limit: number,
): Promise<ParserDiagnosticEntry[]> {
  const output: ParserDiagnosticEntry[] = [];
  if (offset >= total || limit === 0) return output;
  const directoryPath = path.join(generationPath, DIRECTORY);
  const directory = await fsp.lstat(directoryPath).catch(() => null);
  if (!directory?.isDirectory() || directory.isSymbolicLink()) {
    throw new Error('Parser diagnostics are unavailable for this generation.');
  }
  let remaining = Math.min(limit, total - offset);
  let position = offset;
  while (remaining > 0) {
    const chunkIndex = Math.floor(position / CHUNK_SIZE);
    const inChunkOffset = position % CHUNK_SIZE;
    const expectedChunkLength = Math.min(CHUNK_SIZE, total - chunkIndex * CHUNK_SIZE);
    const target = path.join(directoryPath, chunkFilename(kind, chunkIndex));
    const stat = await fsp.lstat(target).catch(() => null);
    if (!stat?.isFile() || stat.isSymbolicLink()) {
      throw new Error('Parser diagnostics chunk is missing or unsafe.');
    }
    const raw = JSON.parse(await fsp.readFile(target, 'utf8')) as unknown;
    if (!Array.isArray(raw) || raw.length !== expectedChunkLength) {
      throw new Error('Parser diagnostics chunk is incomplete.');
    }
    const chunk = raw.map((entry) => validateEntry(entry, kind));
    const take = Math.min(remaining, chunk.length - inChunkOffset);
    output.push(...chunk.slice(inChunkOffset, inChunkOffset + take));
    position += take;
    remaining -= take;
  }
  return output;
}

export async function readParserDiagnosticsPage(
  generationPath: string,
  generation: string,
  summaryValue: unknown,
  input: {
    source?: ParserDiagnosticsCursorState['source'];
    kind?: 'all' | ParserDiagnosticKind;
    offset?: number;
    limit?: number;
    cursor?: string;
  } = {},
): Promise<ParserDiagnosticsPage> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(generation)) {
    throw new Error('Invalid parser diagnostics generation id.');
  }
  if (!isValidParserDiagnosticsSummary(summaryValue)) {
    throw new Error('Complete parser diagnostics are unavailable for this generation.');
  }
  const source = input.source ?? 'committed';
  const cursor = input.cursor
    ? decodeParserDiagnosticsCursor(input.cursor, {
        source,
        kind: input.kind,
        limit: input.limit,
      })
    : undefined;
  if (cursor && cursor.generation !== generation) {
    throw new Error('Parser diagnostics cursor generation mismatch.');
  }
  if (cursor && input.offset !== undefined) {
    throw new Error('Do not combine a parser diagnostics cursor with offset.');
  }
  const kind = input.kind ?? cursor?.kind ?? 'all';
  const offset = cursor?.offset ?? input.offset ?? 0;
  const limit = cursor?.limit ?? input.limit ?? 50;
  if (
    (kind !== 'all' && kind !== 'parse-error' && kind !== 'degraded') ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > MAX_PAGE_SIZE
  ) {
    throw new Error('Invalid parser diagnostics page bounds.');
  }
  const total =
    kind === 'parse-error'
      ? summaryValue.parseErrorCount
      : kind === 'degraded'
        ? summaryValue.degradedEntryCount
        : summaryValue.parseErrorCount + summaryValue.degradedEntryCount;
  if (offset > total) throw new Error('Parser diagnostics offset exceeds the total.');
  const directoryPath = path.join(generationPath, DIRECTORY);
  const directoryStat = await fsp.lstat(directoryPath).catch(() => null);
  if (!directoryStat?.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new Error('Parser diagnostics are unavailable for this generation.');
  }
  const items: ParserDiagnosticEntry[] = [];
  let remaining = Math.min(limit, total - offset);
  if (kind === 'parse-error') {
    items.push(
      ...(await readCategoryPage(
        generationPath,
        'parse-error',
        summaryValue.parseErrorCount,
        offset,
        remaining,
      )),
    );
  } else if (kind === 'degraded') {
    items.push(
      ...(await readCategoryPage(
        generationPath,
        'degraded',
        summaryValue.degradedEntryCount,
        offset,
        remaining,
      )),
    );
  } else {
    let position = offset;
    if (position < summaryValue.parseErrorCount && remaining > 0) {
      const count = Math.min(remaining, summaryValue.parseErrorCount - position);
      const page = await readCategoryPage(
        generationPath,
        'parse-error',
        summaryValue.parseErrorCount,
        position,
        count,
      );
      items.push(...page);
      remaining -= page.length;
      position += page.length;
    }
    if (remaining > 0) {
      const degradedOffset = Math.max(0, position - summaryValue.parseErrorCount);
      items.push(
        ...(await readCategoryPage(
          generationPath,
          'degraded',
          summaryValue.degradedEntryCount,
          degradedOffset,
          remaining,
        )),
      );
    }
  }
  const nextOffset = offset + items.length;
  const truncated = nextOffset < total;
  return {
    generation,
    source,
    kind,
    offset,
    limit,
    total,
    returned: items.length,
    truncated,
    ...(truncated ? { nextOffset } : {}),
    ...(truncated
      ? {
          nextCursor: encodeCursor({
            source,
            generation,
            kind,
            offset: nextOffset,
            limit,
          }),
        }
      : {}),
    complete: true,
    totals: {
      parseErrorCount: summaryValue.parseErrorCount,
      degradedEntryCount: summaryValue.degradedEntryCount,
    },
    items,
  };
}
