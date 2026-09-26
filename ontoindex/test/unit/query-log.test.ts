import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { appendQueryLog, type QueryLogEntry } from '../../src/mcp/local/query-log.js';

describe('appendQueryLog', () => {
  let tmp: string;
  let prevDirEnv: string | undefined;
  let prevLogEnv: string | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'ontoindex-querylog-'));
    prevDirEnv = process.env.ONTOINDEX_QUERY_LOG_DIR;
    prevLogEnv = process.env.ONTOINDEX_QUERY_LOG;
    process.env.ONTOINDEX_QUERY_LOG_DIR = tmp;
    delete process.env.ONTOINDEX_QUERY_LOG;
  });

  afterEach(() => {
    if (prevDirEnv === undefined) delete process.env.ONTOINDEX_QUERY_LOG_DIR;
    else process.env.ONTOINDEX_QUERY_LOG_DIR = prevDirEnv;
    if (prevLogEnv === undefined) delete process.env.ONTOINDEX_QUERY_LOG;
    else process.env.ONTOINDEX_QUERY_LOG = prevLogEnv;
    rmSync(tmp, { recursive: true, force: true });
  });

  it('writes a single JSONL entry per call', async () => {
    await appendQueryLog('test-repo', {
      query: 'mergeWithRRF',
      resultIds: ['n1', 'n2', 'n3'],
      phases: { bm25: 5, vector: 10, wall: 20 },
      ftsUsed: true,
    });

    const files = readDir(tmp);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^queries-test-repo-\d{8}\.jsonl$/);

    const lines = readFileSync(join(tmp, files[0]), 'utf-8').split('\n').filter(Boolean);
    expect(lines).toHaveLength(1);

    const entry = JSON.parse(lines[0]) as QueryLogEntry;
    expect(entry.repoId).toBe('test-repo');
    expect(entry.query).toBe('mergeWithRRF');
    expect(entry.resultIds).toEqual(['n1', 'n2', 'n3']);
    expect(entry.ftsUsed).toBe(true);
    expect(entry.queryId).toMatch(/^[0-9a-f-]{36}$/);
    expect(typeof entry.ts).toBe('number');
  });

  it('appends additional entries to the same daily file', async () => {
    await appendQueryLog('test-repo', { query: 'q1', resultIds: ['a'] });
    await appendQueryLog('test-repo', { query: 'q2', resultIds: ['b'] });
    const files = readDir(tmp);
    expect(files).toHaveLength(1);
    const lines = readFileSync(join(tmp, files[0]), 'utf-8').split('\n').filter(Boolean);
    expect(lines).toHaveLength(2);
  });

  it('truncates query strings longer than 256 chars', async () => {
    const long = 'a'.repeat(500);
    await appendQueryLog('test-repo', { query: long, resultIds: [] });
    const files = readDir(tmp);
    const entry = JSON.parse(readFileSync(join(tmp, files[0]), 'utf-8').trim()) as QueryLogEntry;
    expect(entry.query.length).toBe(256);
  });

  it('caps resultIds at 10', async () => {
    const ids = Array.from({ length: 25 }, (_, i) => `n${i}`);
    await appendQueryLog('test-repo', { query: 'q', resultIds: ids });
    const files = readDir(tmp);
    const entry = JSON.parse(readFileSync(join(tmp, files[0]), 'utf-8').trim()) as QueryLogEntry;
    expect(entry.resultIds).toHaveLength(10);
    expect(entry.resultIds[0]).toBe('n0');
    expect(entry.resultIds[9]).toBe('n9');
  });

  it('records definition ids and result count separately from process symbols', async () => {
    const definitionIds = Array.from({ length: 12 }, (_, i) => `Function:src/a.ts:f${i}`);
    await appendQueryLog('test-repo', {
      query: 'q',
      resultIds: [],
      definitionIds,
      resultCount: 12,
    });
    const files = readDir(tmp);
    const entry = JSON.parse(readFileSync(join(tmp, files[0]), 'utf-8').trim()) as QueryLogEntry;
    expect(entry.resultIds).toEqual([]);
    expect(entry.definitionIds).toHaveLength(10);
    expect(entry.definitionIds?.[0]).toBe('Function:src/a.ts:f0');
    expect(entry.resultCount).toBe(12);
  });

  it('does not write when ONTOINDEX_QUERY_LOG=0', async () => {
    process.env.ONTOINDEX_QUERY_LOG = '0';
    await appendQueryLog('test-repo', { query: 'q', resultIds: ['a'] });
    expect(readDir(tmp)).toHaveLength(0);
  });

  it('does not write when ONTOINDEX_QUERY_LOG=false', async () => {
    process.env.ONTOINDEX_QUERY_LOG = 'false';
    await appendQueryLog('test-repo', { query: 'q', resultIds: ['a'] });
    expect(readDir(tmp)).toHaveLength(0);
  });

  it('writes when ONTOINDEX_QUERY_LOG is unset (opt-out default)', async () => {
    delete process.env.ONTOINDEX_QUERY_LOG;
    await appendQueryLog('test-repo', { query: 'q', resultIds: ['a'] });
    expect(readDir(tmp)).toHaveLength(1);
  });

  it('swallows errors silently when sink path is invalid', async () => {
    // NUL byte in path is rejected synchronously by node fs.
    process.env.ONTOINDEX_QUERY_LOG_DIR = '/tmp/invalid\u0000sink';
    // Should not throw
    await expect(
      appendQueryLog('test-repo', { query: 'q', resultIds: ['a'] }),
    ).resolves.toBeUndefined();
  });

  it('segments by repoId in the filename', async () => {
    await appendQueryLog('repo-a', { query: 'q1', resultIds: [] });
    await appendQueryLog('repo-b', { query: 'q2', resultIds: [] });
    const files = readDir(tmp);
    expect(files).toHaveLength(2);
    expect(files.some((f) => f.includes('repo-a'))).toBe(true);
    expect(files.some((f) => f.includes('repo-b'))).toBe(true);
  });

  it('records cache status, retrieval mode, and retrieval policy verbatim', async () => {
    await appendQueryLog('test-repo', {
      query: 'q',
      resultIds: ['a'],
      cacheStatus: 'stale',
      retrievalMode: 'typed',
      retrievalPolicy: 'symbol-neighborhood',
    });
    const files = readDir(tmp);
    const entry = JSON.parse(readFileSync(join(tmp, files[0]), 'utf-8').trim()) as QueryLogEntry;
    expect(entry.cacheStatus).toBe('stale');
    expect(entry.retrievalMode).toBe('typed');
    expect(entry.retrievalPolicy).toBe('symbol-neighborhood');
  });

  it('accepts every cache status including disabled and expired', async () => {
    const statuses = ['hit', 'miss', 'stale', 'expired', 'disabled'] as const;
    for (const status of statuses) {
      await appendQueryLog('test-repo', { query: 'q', resultIds: [], cacheStatus: status });
    }
    const files = readDir(tmp);
    const lines = readFileSync(join(tmp, files[0]), 'utf-8').split('\n').filter(Boolean);
    expect(lines.map((line) => (JSON.parse(line) as QueryLogEntry).cacheStatus)).toEqual([
      ...statuses,
    ]);
  });

  it('bounds responseBytes to a non-negative integer and drops non-finite values', async () => {
    await appendQueryLog('test-repo', { query: 'q', resultIds: [], responseBytes: 12.9 });
    await appendQueryLog('test-repo', { query: 'q', resultIds: [], responseBytes: -5 });
    await appendQueryLog('test-repo', { query: 'q', resultIds: [], responseBytes: Infinity });
    const files = readDir(tmp);
    const entries = readFileSync(join(tmp, files[0]), 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as QueryLogEntry);
    expect(entries[0].responseBytes).toBe(12);
    expect(entries[1].responseBytes).toBe(0);
    expect(entries[2].responseBytes).toBeUndefined();
  });

  it('measures responseBytes in UTF-8 bytes for multibyte content', async () => {
    // '★' is 3 UTF-8 bytes; simulate a caller measuring its own serialized payload.
    const payload = JSON.stringify({ label: '★★★' });
    await appendQueryLog('test-repo', {
      query: 'q',
      resultIds: [],
      responseBytes: Buffer.byteLength(payload, 'utf8'),
    });
    const files = readDir(tmp);
    const entry = JSON.parse(readFileSync(join(tmp, files[0]), 'utf-8').trim()) as QueryLogEntry;
    expect(entry.responseBytes).toBe(Buffer.byteLength(payload, 'utf8'));
    expect(entry.responseBytes).toBeGreaterThan(payload.length);
  });

  it('dedupes and bounds truncated reasons and only marks truncated when reasons exist', async () => {
    await appendQueryLog('test-repo', {
      query: 'q',
      resultIds: [],
      truncated: true,
      truncatedReasons: ['a', 'a', 'b'],
    });
    await appendQueryLog('test-repo', { query: 'q', resultIds: [], truncatedReasons: [] });
    const files = readDir(tmp);
    const entries = readFileSync(join(tmp, files[0]), 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as QueryLogEntry);
    expect(entries[0].truncatedReasons).toEqual(['a', 'b']);
    expect(entries[1].truncatedReasons).toBeUndefined();
  });
});

function readDir(dir: string): string[] {
  if (!existsSync(dir)) return [];

  const fs = require('fs');
  return (fs.readdirSync(dir) as string[]).sort();
}
