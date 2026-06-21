import { describe, expect, it, vi } from 'vitest';
import { STALE_HASH_SENTINEL } from '../../src/core/lbug/schema.js';
import { fetchExistingEmbeddingHashes } from '../../src/core/lbug/lbug-adapter.js';

describe('fetchExistingEmbeddingHashes', () => {
  it('uses node-level contentHash when chunk metadata is absent', async () => {
    const execQuery = vi
      .fn()
      .mockResolvedValueOnce([{ count: 1 }])
      .mockResolvedValueOnce([
        {
          nodeId: 'Function:src/main.ts:foo',
          chunkIndex: null,
          startLine: null,
          endLine: null,
          contentHash: 'abcdef1234567890abcdef1234567890abcdef12',
        },
      ]);

    const result = await fetchExistingEmbeddingHashes(execQuery);

    expect(result?.get('Function:src/main.ts:foo')).toBe(
      'abcdef1234567890abcdef1234567890abcdef12',
    );
  });

  it('promotes chunk-aware rows to chunkContentHashes', async () => {
    const hash = 'abcdef1234567890abcdef1234567890abcdef12';
    const chunkHash = 'chunk-hash-1';
    const execQuery = vi
      .fn()
      .mockResolvedValueOnce([{ count: 1 }])
      .mockResolvedValueOnce([
        {
          nodeId: 'Function:src/main.ts:foo',
          chunkIndex: 0,
          startLine: 10,
          endLine: 12,
          contentHash: hash,
          chunkContentHash: chunkHash,
        },
      ]);

    const result = await fetchExistingEmbeddingHashes(execQuery);

    const first = result?.get('Function:src/main.ts:foo');
    expect(first).toEqual({
      contentHash: hash,
      chunkContentHashes: new Map([[0, chunkHash]]),
    });
  });

  it('treats malformed chunk metadata as node-level content-hash mode', async () => {
    const hash = 'abcdef1234567890abcdef1234567890abcdef12';
    const execQuery = vi
      .fn()
      .mockResolvedValueOnce([{ count: 1 }])
      .mockResolvedValueOnce([
        {
          nodeId: 'Function:src/main.ts:foo',
          chunkIndex: 0,
          startLine: null,
          endLine: null,
          contentHash: hash,
          chunkContentHash: 'chunk-only-hash',
        },
      ]);

    const result = await fetchExistingEmbeddingHashes(execQuery);

    expect(result?.get('Function:src/main.ts:foo')).toBe(hash);
  });

  it('falls back to stale hashes when chunk-aware schema is missing', async () => {
    const execQuery = vi
      .fn()
      .mockResolvedValueOnce([{ count: 1 }])
      .mockRejectedValueOnce(new Error('Binder exception: column chunkContentHash does not exist'))
      .mockResolvedValueOnce([{ nodeId: 'Function:src/main.ts:foo' }]);

    const result = await fetchExistingEmbeddingHashes(execQuery);

    expect(result?.get('Function:src/main.ts:foo')).toBe(STALE_HASH_SENTINEL);
    expect(execQuery).toHaveBeenCalledTimes(3);
  });

  it('falls back to stale hashes when contentHash is missing from the schema', async () => {
    const execQuery = vi
      .fn()
      .mockResolvedValueOnce([{ count: 1 }])
      .mockRejectedValueOnce(new Error('Binder exception: column contentHash does not exist'))
      .mockResolvedValueOnce([{ nodeId: 'Function:src/main.ts:foo' }]);

    const result = await fetchExistingEmbeddingHashes(execQuery);

    expect(result?.get('Function:src/main.ts:foo')).toBe(STALE_HASH_SENTINEL);
    expect(execQuery).toHaveBeenCalledTimes(3);
  });

  it('skips incremental hash loading when the embedding table exceeds the cap', async () => {
    const execQuery = vi.fn().mockResolvedValueOnce([{ count: 50_000 }]);

    const result = await fetchExistingEmbeddingHashes(execQuery);

    expect(result).toBeUndefined();
    expect(execQuery).toHaveBeenCalledTimes(1);
  });
});
