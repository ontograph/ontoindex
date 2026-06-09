/**
 * Unit tests: HTTP embedder batching/windowing.
 *
 * The HTTP client sends embeddings in fixed-size batches with a bounded
 * request window. These tests guard ordering when requests finish out of order
 * and ensure later windows are not scheduled before the active window drains.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

const ENV_KEYS = [
  'ONTOINDEX_EMBEDDING_URL',
  'ONTOINDEX_EMBEDDING_MODEL',
  'ONTOINDEX_EMBEDDING_API_KEY',
  'ONTOINDEX_EMBEDDING_DIMS',
] as const;

const HTTP_BATCH_SIZE = 64;
const HTTP_EMBED_CONCURRENCY = 4;

type MockResponse = {
  ok: boolean;
  status: number;
  json: () => Promise<{ data: Array<{ embedding: number[] }> }>;
};

const waitUntil = async (predicate: () => boolean) => {
  for (let i = 0; i < 50; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('Timed out waiting for condition');
};

describe('http-client windowing', () => {
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
    process.env.ONTOINDEX_EMBEDDING_DIMS = '2';
  };

  it('preserves input order and waits for the current HTTP window before scheduling the next one', async () => {
    setupEnv();

    const texts = Array.from(
      { length: HTTP_BATCH_SIZE * (HTTP_EMBED_CONCURRENCY + 1) },
      (_, i) => `text-${i}`,
    );
    const startedBatches: number[] = [];
    const resolvers = new Map<number, () => void>();
    let activeRequests = 0;
    let maxActiveRequests = 0;

    vi.stubGlobal(
      'fetch',
      vi.fn((_: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { input: string[] };
        const firstInputIndex = Number(body.input[0].replace('text-', ''));
        const batchIndex = Math.floor(firstInputIndex / HTTP_BATCH_SIZE);
        startedBatches.push(batchIndex);
        activeRequests++;
        maxActiveRequests = Math.max(maxActiveRequests, activeRequests);

        return new Promise<MockResponse>((resolve) => {
          resolvers.set(batchIndex, () => {
            activeRequests--;
            resolve({
              ok: true,
              status: 200,
              json: async () => ({
                data: body.input.map((text) => {
                  const index = Number(text.replace('text-', ''));
                  return { embedding: [index, index + 0.5] };
                }),
              }),
            });
          });
        });
      }),
    );

    const { httpEmbed } = await import('../../src/core/embeddings/http-client.js');
    const resultPromise = httpEmbed(texts);

    await waitUntil(() => startedBatches.length === HTTP_EMBED_CONCURRENCY);
    expect(startedBatches).toEqual([0, 1, 2, 3]);
    expect(maxActiveRequests).toBe(HTTP_EMBED_CONCURRENCY);
    expect(resolvers.has(4)).toBe(false);

    resolvers.get(3)?.();
    resolvers.get(1)?.();
    resolvers.get(0)?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(startedBatches).toEqual([0, 1, 2, 3]);

    resolvers.get(2)?.();
    await waitUntil(() => startedBatches.length === HTTP_EMBED_CONCURRENCY + 1);
    expect(startedBatches).toEqual([0, 1, 2, 3, 4]);
    expect(maxActiveRequests).toBe(HTTP_EMBED_CONCURRENCY);

    resolvers.get(4)?.();
    const vectors = await resultPromise;

    expect(vectors).toHaveLength(texts.length);
    expect(vectors.map((vector) => Array.from(vector))).toEqual(
      texts.map((_, index) => [index, index + 0.5]),
    );
  });
});
