/**
 * Unit tests: HTTP embedder error-in-200 guard
 *
 * Verifies that httpEmbed / httpEmbedQuery throw a proper Error when the remote
 * provider returns HTTP 200 with an error payload instead of embedding data.
 * Confirmed failure pattern: routerai.ru with mistral-embed-2312 returns
 * {"error":"No successful provider responses."} wrapped in HTTP 200.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';

const ENV_KEYS = [
  'ONTOINDEX_EMBEDDING_URL',
  'ONTOINDEX_EMBEDDING_MODEL',
  'ONTOINDEX_EMBEDDING_API_KEY',
  'ONTOINDEX_EMBEDDING_DIMS',
] as const;

/** 384-dimensional mock vector matching the default schema dimensions. */
const mockVec = Array.from({ length: 384 }, (_, i) => i / 384);

/** Build a mock fetch that returns status 200 with the given JSON body. */
const mockFetch200 = (jsonBody: unknown) =>
  vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => jsonBody,
  });

describe('http-client error-in-200 guard', () => {
  const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
  });

  const setupEnv = () => {
    process.env.ONTOINDEX_EMBEDDING_URL = 'http://test:8080/v1';
    process.env.ONTOINDEX_EMBEDDING_MODEL = 'test-model';
    process.env.ONTOINDEX_EMBEDDING_API_KEY = 'test-key';
    process.env.ONTOINDEX_EMBEDDING_DIMS = '384';
  };

  // -------------------------------------------------------------------------
  // httpEmbed (batch path)
  // -------------------------------------------------------------------------

  describe('httpEmbed — batch path', () => {
    it('throws on {"error":"..."} body with status 200', async () => {
      setupEnv();
      vi.stubGlobal('fetch', mockFetch200({ error: 'No successful provider responses.' }));

      const { httpEmbed } = await import('../../src/core/embeddings/http-client.js');
      await expect(httpEmbed(['hello'])).rejects.toThrow(
        'HTTP embedder error (status 200): No successful provider responses.',
      );
    });

    it('throws on {"errors":[{"message":"..."}]} body with status 200', async () => {
      setupEnv();
      vi.stubGlobal(
        'fetch',
        mockFetch200({ errors: [{ message: 'quota exceeded' }, { message: 'rate limited' }] }),
      );

      const { httpEmbed } = await import('../../src/core/embeddings/http-client.js');
      await expect(httpEmbed(['hello'])).rejects.toThrow(
        'HTTP embedder errors (status 200): quota exceeded; rate limited',
      );
    });

    it('throws on {"detail":"..."} body with status 200', async () => {
      setupEnv();
      vi.stubGlobal('fetch', mockFetch200({ detail: 'Service temporarily unavailable' }));

      const { httpEmbed } = await import('../../src/core/embeddings/http-client.js');
      await expect(httpEmbed(['hello'])).rejects.toThrow(
        'HTTP embedder error (status 200): Service temporarily unavailable',
      );
    });

    it('resolves normally on valid {"data":[...]} response (no regression)', async () => {
      setupEnv();
      vi.stubGlobal('fetch', mockFetch200({ data: [{ embedding: mockVec }] }));

      const { httpEmbed } = await import('../../src/core/embeddings/http-client.js');
      const result = await httpEmbed(['hello']);
      expect(result).toHaveLength(1);
      expect(result[0]).toBeInstanceOf(Float32Array);
      expect(result[0].length).toBe(384);
    });
  });

  // -------------------------------------------------------------------------
  // httpEmbedQuery (single-query path)
  // -------------------------------------------------------------------------

  describe('httpEmbedQuery — single query path', () => {
    it('throws on {"error":"..."} body with status 200', async () => {
      setupEnv();
      vi.stubGlobal('fetch', mockFetch200({ error: 'No successful provider responses.' }));

      const { httpEmbedQuery } = await import('../../src/core/embeddings/http-client.js');
      await expect(httpEmbedQuery('hello')).rejects.toThrow(
        'HTTP embedder error (status 200): No successful provider responses.',
      );
    });

    it('throws on {"errors":[{"message":"..."}]} body with status 200', async () => {
      setupEnv();
      vi.stubGlobal('fetch', mockFetch200({ errors: [{ message: 'upstream failure' }] }));

      const { httpEmbedQuery } = await import('../../src/core/embeddings/http-client.js');
      await expect(httpEmbedQuery('hello')).rejects.toThrow(
        'HTTP embedder errors (status 200): upstream failure',
      );
    });

    it('resolves normally on valid {"data":[...]} response (no regression)', async () => {
      setupEnv();
      vi.stubGlobal('fetch', mockFetch200({ data: [{ embedding: mockVec }] }));

      const { httpEmbedQuery } = await import('../../src/core/embeddings/http-client.js');
      const result = await httpEmbedQuery('hello');
      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBe(384);
    });
  });
});
