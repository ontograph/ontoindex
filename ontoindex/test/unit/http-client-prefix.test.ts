/**
 * Unit tests: optional document/query prefixes for the HTTP embedder
 * (e.g. nomic-embed expects "search_document: " / "search_query: ").
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const KEYS = [
  'ONTOINDEX_EMBEDDING_URL',
  'ONTOINDEX_EMBEDDING_MODEL',
  'ONTOINDEX_EMBEDDING_DIMS',
  'ONTOINDEX_EMBEDDING_DOCUMENT_PREFIX',
  'ONTOINDEX_EMBEDDING_QUERY_PREFIX',
] as const;

const setup = (env: Partial<Record<(typeof KEYS)[number], string>>) => {
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, {
    ONTOINDEX_EMBEDDING_URL: 'http://x/v1',
    ONTOINDEX_EMBEDDING_MODEL: 'm',
    ONTOINDEX_EMBEDDING_DIMS: '2',
    ...env,
  });
  const inputs: string[][] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: { body: string }) => {
      const input = JSON.parse(init.body).input as string[];
      inputs.push(input);
      return { ok: true, status: 200, json: async () => ({ data: input.map(() => ({ embedding: [0, 1] })) }) };
    }),
  );
  return inputs;
};

describe('http-client prefixes', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
    for (const k of KEYS) delete process.env[k];
  });

  it('prepends the document prefix to batch texts', async () => {
    const inputs = setup({ ONTOINDEX_EMBEDDING_DOCUMENT_PREFIX: 'search_document: ' });
    const { httpEmbed } = await import('../../src/core/embeddings/http-client.js');
    await httpEmbed(['a', 'b']);
    expect(inputs).toEqual([['search_document: a', 'search_document: b']]);
  });

  it('prepends the query prefix to the query text only', async () => {
    const inputs = setup({
      ONTOINDEX_EMBEDDING_DOCUMENT_PREFIX: 'search_document: ',
      ONTOINDEX_EMBEDDING_QUERY_PREFIX: 'search_query: ',
    });
    const { httpEmbedQuery } = await import('../../src/core/embeddings/http-client.js');
    await httpEmbedQuery('q');
    expect(inputs).toEqual([['search_query: q']]);
  });

  it('sends texts unchanged when no prefix is configured', async () => {
    const inputs = setup({});
    const { httpEmbed, httpEmbedQuery } = await import('../../src/core/embeddings/http-client.js');
    await httpEmbed(['a']);
    await httpEmbedQuery('q');
    expect(inputs).toEqual([['a'], ['q']]);
  });
});
