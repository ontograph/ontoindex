import { describe, expect, it } from 'vitest';
import { resolveEmbeddingLifecycleMode } from '../../src/core/run-analyze.js';

describe('embedding lifecycle mode mapping', () => {
  it('maps missing embedding flags to off', () => {
    expect(resolveEmbeddingLifecycleMode()).toBe('off');
    expect(resolveEmbeddingLifecycleMode({ force: true })).toBe('off');
  });

  it('maps embedding requests to preserve by default', () => {
    expect(resolveEmbeddingLifecycleMode({ embeddings: true })).toBe('preserve');
    expect(resolveEmbeddingLifecycleMode({ annNeighbors: true })).toBe('preserve');
  });

  it('maps forced embedding requests to refresh', () => {
    expect(resolveEmbeddingLifecycleMode({ embeddings: true, force: true })).toBe('refresh');
    expect(resolveEmbeddingLifecycleMode({ annNeighbors: true, force: true })).toBe('refresh');
  });
});
