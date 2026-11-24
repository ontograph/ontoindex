import { afterEach, describe, expect, it } from 'vitest';
import {
  getConfiguredEmbeddingRevision,
  getEmbeddingRevisionMismatch,
} from '../../src/core/embeddings/embedding-revision.js';

const MODEL = 'Snowflake/snowflake-arctic-embed-xs';
const REVISION = 'd8c86521100d3556476a063fc2342036d45c106f';
const LEGACY_IDENTITY = `${MODEL}@${REVISION}`;

afterEach(() => {
  delete process.env.ONTOINDEX_EMBEDDING_MODEL;
  delete process.env.ONTOINDEX_EMBEDDING_MODEL_HASH;
  delete process.env.ONTOINDEX_EMBEDDING_REVISION;
  delete process.env.ONTOINDEX_EMBEDDING_URL;
});

describe('embedding revision compatibility', () => {
  it('accepts a legacy model hash only when the full model and revision match', () => {
    expect(
      getEmbeddingRevisionMismatch(undefined, REVISION, LEGACY_IDENTITY, LEGACY_IDENTITY, MODEL),
    ).toBeUndefined();
  });

  it.each([
    ['a different model', `other/model@${REVISION}`],
    ['a different revision', `${MODEL}@different-revision`],
    ['an empty identity', ''],
    ['an unavailable identity', undefined],
  ])('rejects legacy metadata with %s', (_description, indexedModelHash) => {
    expect(
      getEmbeddingRevisionMismatch(
        undefined,
        REVISION,
        indexedModelHash,
        LEGACY_IDENTITY,
        MODEL,
      ),
    ).toMatch(/Embedding (?:model|revision) mismatch/);
  });

  it('does not let a matching legacy hash override a conflicting explicit revision', () => {
    expect(
      getEmbeddingRevisionMismatch('different-revision', REVISION, LEGACY_IDENTITY, LEGACY_IDENTITY, MODEL),
    ).toContain('Embedding revision mismatch');
  });

  it('checks the configured model when the explicit revision matches', () => {
    expect(
      getEmbeddingRevisionMismatch(
        REVISION,
        REVISION,
        `other/model@${REVISION}`,
        null,
        MODEL,
      ),
    ).toContain('Embedding model mismatch');
  });

  it('requires a runtime model identity for opaque hashes with explicit revisions', () => {
    expect(
      getEmbeddingRevisionMismatch(REVISION, REVISION, 'opaque-hash', undefined, MODEL),
    ).toContain('Embedding model identity is unverified');
  });

  it('fails closed when the indexed model hash conflicts with the configured identity', () => {
    expect(
      getEmbeddingRevisionMismatch(REVISION, REVISION, LEGACY_IDENTITY, 'other-model', MODEL),
    ).toContain('Embedding model mismatch');
  });

  it('does not infer an HTTP provider revision from a legacy model hash', () => {
    process.env.ONTOINDEX_EMBEDDING_URL = 'https://embeddings.example/v1';
    process.env.ONTOINDEX_EMBEDDING_MODEL = MODEL;
    process.env.ONTOINDEX_EMBEDDING_MODEL_HASH = LEGACY_IDENTITY;

    expect(getConfiguredEmbeddingRevision()).toBeUndefined();
    expect(
      getEmbeddingRevisionMismatch(undefined, getConfiguredEmbeddingRevision(), LEGACY_IDENTITY),
    ).toContain('Embedding revision mismatch');
    expect(
      getEmbeddingRevisionMismatch(REVISION, getConfiguredEmbeddingRevision(), LEGACY_IDENTITY),
    ).toContain('Embedding revision mismatch');
  });
});
