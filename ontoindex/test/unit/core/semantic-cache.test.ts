import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SemanticRetrievalCache } from '../../../src/core/search/semantic-cache.js';

describe('SemanticRetrievalCache', () => {
  const repoPath = '.vitest-cache-test';
  const cacheDir = join(repoPath, '.ontoindex', 'cache', 'semantic');
  const entry = (indexedHead = 'head', label = '') => ({
    candidates: label ? ([{ id: label, label }] as any[]) : [],
    diagnostics: {},
    indexedHead,
  });
  const entryBytes = (timestamp: number, label = '') =>
    Buffer.byteLength(JSON.stringify({ ...entry('head', label), timestamp }), 'utf8');

  beforeEach(async () => {
    await mkdir(repoPath, { recursive: true });
  });

  afterEach(async () => {
    await rm(repoPath, { recursive: true, force: true });
  });

  it('computes stable deterministic keys', () => {
    const params = {
      query: 'test query',
      capabilities: ['vector', 'bm25'],
      indexedHead: 'abc',
    };
    const key1 = SemanticRetrievalCache.computeKey(params);
    const key2 = SemanticRetrievalCache.computeKey({
      ...params,
      capabilities: ['bm25', 'vector'], // sorted order
    });
    expect(key1).toBe(key2);
    expect(typeof key1).toBe('string');
    expect(key1.length).toBe(64);
  });

  it('keys policy, filters, embedding identity, and indexed head without mutating inputs', () => {
    const capabilities = ['vector', 'bm25'];
    const key = SemanticRetrievalCache.computeKey({
      query: 'test query',
      retrievalPolicy: 'graph-only',
      capabilities,
      indexedHead: 'abc',
      embeddingModelHash: 'model-a',
      filters: [
        { field: 'kind', operator: '=', value: 'symbol', lineNumber: 1 },
        { field: 'language', operator: '=', value: 'typescript', lineNumber: 2 },
      ],
    });

    expect(capabilities).toEqual(['vector', 'bm25']);
    expect(key).not.toBe(
      SemanticRetrievalCache.computeKey({
        query: 'test query',
        retrievalPolicy: 'graph-only',
        capabilities,
        indexedHead: 'abc',
        embeddingModelHash: 'model-b',
        filters: [
          { field: 'kind', operator: '=', value: 'symbol', lineNumber: 1 },
          { field: 'language', operator: '=', value: 'typescript', lineNumber: 2 },
        ],
      }),
    );
    expect(key).not.toBe(
      SemanticRetrievalCache.computeKey({
        query: 'test query',
        retrievalPolicy: 'graph-only',
        capabilities,
        indexedHead: 'abc',
        embeddingModelHash: 'model-a',
        filters: [{ field: 'kind', operator: '=', value: 'file', lineNumber: 1 }],
      }),
    );
    expect(key).not.toBe(
      SemanticRetrievalCache.computeKey({
        query: 'test query',
        retrievalPolicy: 'graph-only',
        capabilities,
        indexedHead: 'def',
        embeddingModelHash: 'model-a',
        filters: [
          { field: 'kind', operator: '=', value: 'symbol', lineNumber: 1 },
          { field: 'language', operator: '=', value: 'typescript', lineNumber: 2 },
        ],
      }),
    );
  });

  it('stores and retrieves results', async () => {
    const cache = new SemanticRetrievalCache(repoPath);
    const key = 'test-key';
    const head = 'commit-1';
    const result = {
      candidates: [{ id: '1', label: 'test' } as any],
      diagnostics: { truncated: true },
      indexedHead: head,
    };

    await cache.set(key, result);
    const retrieved = await cache.get(key, head);

    expect(retrieved).toMatchObject({
      candidates: result.candidates,
      diagnostics: result.diagnostics,
      indexedHead: head,
    });
    expect(retrieved?.timestamp).toBeLessThanOrEqual(Date.now());
  });

  it('atomically replaces an existing entry without leaving temporary files', async () => {
    let now = 1_000;
    const cache = new SemanticRetrievalCache(repoPath, { now: () => now });
    await cache.set('same-key', entry('head', 'old'));

    now += 1;
    await cache.set('same-key', entry('head', 'new'));

    await expect(cache.get('same-key', 'head')).resolves.toMatchObject({
      candidates: [{ id: 'new', label: 'new' }],
      timestamp: 1_001,
    });
    const files = await readdir(cacheDir);
    expect(files).toEqual(['same-key.json']);
    await expect(readFile(join(cacheDir, 'same-key.json'), 'utf8')).resolves.toContain('"new"');
  });

  it('invalidates on HEAD change', async () => {
    const cache = new SemanticRetrievalCache(repoPath);
    const key = 'test-key';
    await cache.set(key, {
      candidates: [],
      diagnostics: {},
      indexedHead: 'old-commit',
    });

    const retrieved = await cache.get(key, 'new-commit');
    expect(retrieved).toBeNull();
    await expect(cache.lookup(key, 'new-commit')).resolves.toMatchObject({
      status: 'stale',
      result: null,
    });
  });

  it('expires entries after TTL and reports cache age', async () => {
    let now = 1_000;
    const cache = new SemanticRetrievalCache(repoPath, { ttlMs: 100, now: () => now });
    const key = 'test-key';
    await cache.set(key, {
      candidates: [],
      diagnostics: {},
      indexedHead: 'head',
    });

    now = 1_050;
    await expect(cache.lookup(key, 'head')).resolves.toMatchObject({
      status: 'hit',
      ageMs: 50,
    });

    now = 1_101;
    await expect(cache.lookup(key, 'head')).resolves.toMatchObject({
      status: 'expired',
      result: null,
      ageMs: 101,
    });
    await expect(cache.get(key, 'head')).resolves.toBeNull();
  });

  it('evicts oldest entries when max entry count is exceeded', async () => {
    let now = 1_000;
    const cache = new SemanticRetrievalCache(repoPath, { maxEntries: 2, now: () => now });

    await cache.set('oldest', { candidates: [], diagnostics: {}, indexedHead: 'head' });
    now += 1;
    await cache.set('middle', { candidates: [], diagnostics: {}, indexedHead: 'head' });
    now += 1;
    const result = await cache.set('newest', {
      candidates: [],
      diagnostics: {},
      indexedHead: 'head',
    });

    expect(result.evicted).toBe(1);
    expect(await cache.get('oldest', 'head')).toBeNull();
    expect(await cache.get('middle', 'head')).not.toBeNull();
    expect(await cache.get('newest', 'head')).not.toBeNull();
    const cacheFiles = await readdir(cacheDir);
    expect(cacheFiles.filter((name) => name.endsWith('.json'))).toHaveLength(2);
  });

  it('does not evict an atomic replacement selected by an earlier scan', async () => {
    let now = 1_000;
    class ReplacingCache extends SemanticRetrievalCache {
      protected override async beforeEvictionCheck(path: string): Promise<void> {
        if (!path.endsWith('oldest.json')) return;
        const replacement = `${path}.replacement.tmp`;
        await writeFile(
          replacement,
          JSON.stringify({ ...entry('head', 'replacement'), timestamp: 2_000 }),
          'utf8',
        );
        await rename(replacement, path);
      }
    }
    const cache = new ReplacingCache(repoPath, { maxEntries: 1, now: () => now });
    await cache.set('oldest', entry('head', 'oldest'));
    now += 1;

    const result = await cache.set('newest', entry('head', 'newest'));

    expect(result.evicted).toBe(0);
    await expect(cache.get('oldest', 'head')).resolves.toMatchObject({
      candidates: [{ id: 'replacement', label: 'replacement' }],
      timestamp: 2_000,
    });
    await expect(cache.get('newest', 'head')).resolves.not.toBeNull();
  });

  it('ignores orphan temporary files', async () => {
    await mkdir(cacheDir, { recursive: true });
    await writeFile(join(cacheDir, 'orphan.json.partial.tmp'), '{"indexedHead":"head"', 'utf8');
    const cache = new SemanticRetrievalCache(repoPath, { maxEntries: 1 });

    const result = await cache.set('valid', entry());

    expect(result.evicted).toBe(0);
    await expect(cache.get('orphan.json.partial', 'head')).resolves.toBeNull();
    await expect(cache.get('valid', 'head')).resolves.not.toBeNull();
  });

  it('evicts by bytes when the count limit is not exceeded', async () => {
    let now = 1_000;
    const bytes = entryBytes(now, 'old') + entryBytes(now + 1, 'new') - 1;
    const cache = new SemanticRetrievalCache(repoPath, {
      maxEntries: 10,
      maxBytes: bytes,
      now: () => now,
    });
    await cache.set('old', entry('head', 'old'));
    now += 1;

    const result = await cache.set('new', entry('head', 'new'));

    expect(result.evicted).toBe(1);
    await expect(cache.get('old', 'head')).resolves.toBeNull();
    await expect(cache.get('new', 'head')).resolves.not.toBeNull();
  });

  it('honors count and byte limits together', async () => {
    let now = 1_000;
    const oldest = 'oldest';
    const middle = 'm'.repeat(100);
    const newest = 'n'.repeat(200);
    const maxBytes = Math.max(
      entryBytes(now, oldest) + entryBytes(now + 1, middle),
      entryBytes(now + 2, newest),
    );
    const cache = new SemanticRetrievalCache(repoPath, {
      maxEntries: 2,
      maxBytes,
      now: () => now,
    });
    await cache.set('oldest', entry('head', oldest));
    now += 1;
    await cache.set('middle', entry('head', middle));
    now += 1;

    const result = await cache.set('newest', entry('head', newest));

    expect(result.evicted).toBe(2);
    await expect(cache.get('oldest', 'head')).resolves.toBeNull();
    await expect(cache.get('middle', 'head')).resolves.toBeNull();
    await expect(cache.get('newest', 'head')).resolves.not.toBeNull();
  });

  it('accounts for replacement size during byte eviction', async () => {
    let now = 1_000;
    const largeLabel = 'x'.repeat(200);
    const cache = new SemanticRetrievalCache(repoPath, {
      maxBytes: entryBytes(now + 2, largeLabel),
      now: () => now,
    });
    await cache.set('same', entry('head', 'small'));
    now += 1;
    await cache.set('other', entry('head', 'other'));
    now += 1;

    const result = await cache.set('same', entry('head', largeLabel));

    expect(result.evicted).toBe(1);
    await expect(cache.get('other', 'head')).resolves.toBeNull();
    await expect(cache.get('same', 'head')).resolves.toMatchObject({ timestamp: 1_002 });
  });

  it('breaks equal-timestamp eviction ties by filename', async () => {
    const cache = new SemanticRetrievalCache(repoPath, { maxEntries: 2, now: () => 1_000 });
    await cache.set('z', entry());
    await cache.set('y', entry());

    const result = await cache.set('x', entry());

    expect(result.evicted).toBe(1);
    await expect(cache.get('x', 'head')).resolves.toBeNull();
    await expect(cache.get('y', 'head')).resolves.not.toBeNull();
    await expect(cache.get('z', 'head')).resolves.not.toBeNull();
  });

  it('counts malformed JSON bytes and prunes it before valid entries', async () => {
    await mkdir(cacheDir, { recursive: true });
    const malformedPath = join(cacheDir, 'malformed.json');
    await writeFile(malformedPath, `{${'x'.repeat(entryBytes(1_000))}`, 'utf8');
    const cache = new SemanticRetrievalCache(repoPath, {
      maxEntries: 10,
      maxBytes: entryBytes(1_000),
      now: () => 1_000,
    });

    await expect(cache.lookup('malformed', 'head')).resolves.toEqual({
      status: 'miss',
      result: null,
    });
    const result = await cache.set('valid', entry());
    expect(result.evicted).toBe(1);
    await expect(readFile(malformedPath, 'utf8')).rejects.toThrow();
    await expect(cache.get('valid', 'head')).resolves.not.toBeNull();
  });

  it('returns null on missing cache entry', async () => {
    const cache = new SemanticRetrievalCache(repoPath);
    const retrieved = await cache.get('missing', 'head');
    expect(retrieved).toBeNull();
    await expect(cache.lookup('missing', 'head')).resolves.toEqual({
      status: 'miss',
      result: null,
    });
  });
});
