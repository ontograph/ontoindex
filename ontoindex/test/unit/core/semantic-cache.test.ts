import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { SemanticRetrievalCache } from '../../../src/core/search/semantic-cache.js';

describe('SemanticRetrievalCache', () => {
  const repoPath = '.vitest-cache-test';

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
    const cacheFiles = await readdir(join(repoPath, '.ontoindex', 'cache', 'semantic'));
    expect(cacheFiles.filter((name) => name.endsWith('.json'))).toHaveLength(2);
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
