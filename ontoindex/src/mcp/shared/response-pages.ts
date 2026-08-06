import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const MCP_RESPONSE_MAX_BYTES = 48 * 1024;
const PAGE_TTL_MS = 15 * 60 * 1000;
const MAX_STORED_RESULTS = 64;
const MAX_STORED_BYTES = 64 * 1024 * 1024;
const CURSOR_PREFIX = 'gn-result-v1';

interface StoredResponsePage {
  version: 1;
  id: string;
  tool: string;
  requestHash: string;
  resultHash: string;
  createdAt: number;
  expiresAt: number;
  identity: Record<string, string>;
  text: string;
}

interface CursorState {
  id: string;
  offset: number;
  token: string;
}

export interface ResponsePageEnvelope {
  truncated: true;
  responsePage: {
    version: 1;
    encoding: 'utf8-json-text';
    offset: number;
    returnedBytes: number;
    totalBytes: number;
    sha256: string;
    identity: Record<string, string>;
    nextCursor?: string;
  };
  chunk: string;
}

export async function pageMcpResponse(input: {
  tool: string;
  args: Record<string, unknown>;
  text?: string;
  cursor?: string;
  maxBytes?: number;
}): Promise<{ text: string; paged: boolean }> {
  const maxBytes = input.maxBytes ?? MCP_RESPONSE_MAX_BYTES;
  const args = withoutCursor(input.args);
  const requestHash = digest(stableJson({ tool: input.tool, args }));

  if (input.cursor) {
    const cursor = parseCursor(input.cursor);
    const stored = await readStored(cursor.id);
    validateStored(stored, input.tool, requestHash, cursor);
    const page = buildPage(stored, cursor.offset, maxBytes);
    return {
      text: JSON.stringify(page),
      paged: true,
    };
  }

  const text = input.text ?? '';
  if (serializedMcpToolResultBytes(text) <= maxBytes) return { text, paged: false };

  const now = Date.now();
  const stored: StoredResponsePage = {
    version: 1,
    id: randomUUID(),
    tool: input.tool,
    requestHash,
    resultHash: digest(text),
    createdAt: now,
    expiresAt: now + PAGE_TTL_MS,
    identity: extractIdentity(text),
    text,
  };
  await writeStored(stored);
  const page = buildPage(stored, 0, maxBytes);
  return {
    text: JSON.stringify(page),
    paged: true,
  };
}

function buildPage(
  stored: StoredResponsePage,
  offset: number,
  maxBytes: number,
): ResponsePageEnvelope {
  const totalBytes = Buffer.byteLength(stored.text, 'utf8');
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > totalBytes) {
    throw new Error('Invalid response cursor offset.');
  }

  const source = Buffer.from(stored.text, 'utf8');
  let low = Math.min(source.length, offset + 1);
  let high = source.length;
  let best: ResponsePageEnvelope | undefined;
  while (low <= high) {
    const requestedEnd = Math.floor((low + high) / 2);
    const safeEnd = utf8Boundary(source, offset, requestedEnd);
    const candidate = createPageEnvelope(stored, source, offset, safeEnd, totalBytes);
    if (serializedMcpToolResultBytes(JSON.stringify(candidate)) <= maxBytes) {
      best = candidate;
      low = requestedEnd + 1;
    } else {
      high = requestedEnd - 1;
    }
  }
  if (!best || best.responsePage.returnedBytes === 0) {
    throw new Error('MCP response byte limit is too small for the paging envelope.');
  }
  return best;
}

export function serializedMcpToolResultBytes(text: string): number {
  return Buffer.byteLength(JSON.stringify({ content: [{ type: 'text', text }] }), 'utf8');
}

function utf8Boundary(source: Buffer, offset: number, requestedEnd: number): number {
  if (requestedEnd >= source.length) return source.length;
  let end = requestedEnd;
  while (end > offset && (source[end] & 0b1100_0000) === 0b1000_0000) end--;
  if (end > offset) return end;
  end = requestedEnd;
  while (end < source.length && (source[end] & 0b1100_0000) === 0b1000_0000) end++;
  return end;
}

function createPageEnvelope(
  stored: StoredResponsePage,
  source: Buffer,
  offset: number,
  end: number,
  totalBytes: number,
): ResponsePageEnvelope {
  const nextCursor = end < source.length ? encodeCursor(stored, end) : undefined;
  return {
    truncated: true,
    responsePage: {
      version: 1,
      encoding: 'utf8-json-text',
      offset,
      returnedBytes: end - offset,
      totalBytes,
      sha256: stored.resultHash,
      identity: stored.identity,
      ...(nextCursor ? { nextCursor } : {}),
    },
    chunk: source.subarray(offset, end).toString('utf8'),
  };
}

function encodeCursor(stored: StoredResponsePage, offset: number): string {
  const token = digest(`${stored.id}\0${offset}\0${stored.requestHash}\0${stored.resultHash}`);
  return `${CURSOR_PREFIX}:${stored.id}:${offset}:${token}`;
}

function parseCursor(value: string): CursorState {
  const match = /^gn-result-v1:([0-9a-f-]+):(\d+):([0-9a-f]{64})$/.exec(value);
  if (!match) throw new Error('Invalid response cursor.');
  return { id: match[1], offset: Number.parseInt(match[2], 10), token: match[3] };
}

function validateStored(
  stored: StoredResponsePage,
  tool: string,
  requestHash: string,
  cursor: CursorState,
): void {
  if (stored.expiresAt <= Date.now()) throw new Error('Response cursor expired.');
  if (stored.tool !== tool || stored.requestHash !== requestHash) {
    throw new Error('Response cursor does not match this tool request.');
  }
  const expected = digest(
    `${stored.id}\0${cursor.offset}\0${stored.requestHash}\0${stored.resultHash}`,
  );
  if (cursor.token !== expected) throw new Error('Response cursor integrity check failed.');
}

function withoutCursor(args: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...args };
  delete copy.response_cursor;
  return copy;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function extractIdentity(text: string): Record<string, string> {
  try {
    const value = JSON.parse(text) as Record<string, unknown>;
    const identity: Record<string, string> = {};
    copyString(value, identity, 'repoLabel');
    copyString(value, identity, 'repoPath');
    const freshness = asRecord(value.freshness);
    const targetContext = asRecord(value.targetContext);
    const graphAuthority = asRecord(targetContext?.graphAuthority);
    copyString(freshness, identity, 'graphGenerationId');
    copyString(freshness, identity, 'graphManifestDigest');
    copyString(targetContext, identity, 'graphIndexId');
    copyString(graphAuthority, identity, 'generationId');
    copyString(graphAuthority, identity, 'manifestDigest');
    return identity;
  } catch {
    return {};
  }
}

function copyString(
  source: Record<string, unknown> | undefined,
  target: Record<string, string>,
  key: string,
): void {
  const value = source?.[key];
  if (typeof value === 'string' && value) target[key] = value;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function storeDir(): string {
  return (
    process.env.ONTOINDEX_MCP_RESULT_DIR ?? path.join(os.homedir(), '.ontoindex', 'mcp-results')
  );
}

async function writeStored(stored: StoredResponsePage): Promise<void> {
  const dir = storeDir();
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const serialized = JSON.stringify(stored);
  const incomingBytes = Buffer.byteLength(serialized, 'utf8');
  if (incomingBytes > MAX_STORED_BYTES)
    throw new Error('MCP response exceeds the persisted result limit.');
  await cleanupExpired(dir, incomingBytes, 1);
  const finalPath = path.join(dir, `${stored.id}.json`);
  const tempPath = `${finalPath}.${process.pid}.tmp`;
  await fs.writeFile(tempPath, serialized, { encoding: 'utf8', mode: 0o600 });
  await fs.rename(tempPath, finalPath);
  await cleanupExpired(dir, 0, 0, finalPath);
}

async function readStored(id: string): Promise<StoredResponsePage> {
  const filePath = path.join(storeDir(), `${id}.json`);
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8')) as StoredResponsePage;
  } catch {
    throw new Error('Response cursor is unknown or expired.');
  }
}

async function cleanupExpired(
  dir: string,
  incomingBytes = 0,
  incomingCount = 0,
  protectedPath?: string,
): Promise<void> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const now = Date.now();
  const files = (
    await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
        .map(async (entry) => {
          const filePath = path.join(dir, entry.name);
          const stat = await fs.stat(filePath).catch(() => null);
          return stat ? { filePath, mtimeMs: stat.mtimeMs, size: stat.size } : null;
        }),
    )
  ).filter((file): file is { filePath: string; mtimeMs: number; size: number } => Boolean(file));

  const retained = files.filter((file) => now - file.mtimeMs <= PAGE_TTL_MS);
  await Promise.all(
    files
      .filter((file) => now - file.mtimeMs > PAGE_TTL_MS)
      .map((file) => fs.rm(file.filePath, { force: true })),
  );

  retained.sort((left, right) => {
    if (left.filePath === protectedPath) return 1;
    if (right.filePath === protectedPath) return -1;
    return left.mtimeMs - right.mtimeMs;
  });
  let totalBytes = retained.reduce((sum, file) => sum + file.size, 0);
  while (
    retained.length + incomingCount > MAX_STORED_RESULTS ||
    totalBytes + incomingBytes > MAX_STORED_BYTES
  ) {
    const oldest = retained.shift();
    if (!oldest) break;
    totalBytes -= oldest.size;
    await fs.rm(oldest.filePath, { force: true });
  }
}
