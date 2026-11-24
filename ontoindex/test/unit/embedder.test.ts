import { describe, it, expect, vi } from 'vitest';

const { mockTransformerPipeline } = vi.hoisted(() => ({
  mockTransformerPipeline: vi.fn(),
}));

vi.mock('@huggingface/transformers', () => ({
  pipeline: (...args: unknown[]) => mockTransformerPipeline(...args),
  env: { allowLocalModels: true },
}));

import {
  disposeEmbedder,
  getEmbeddingDims,
  getMcpEmbeddingModelId,
  initEmbedder,
  isEmbedderReady,
} from '../../src/mcp/core/embedder.js';

describe('embedder', () => {
  describe('getEmbeddingDims', () => {
    it('returns 384 (MiniLM default)', () => {
      expect(getEmbeddingDims()).toBe(384);
    });
  });

  describe('isEmbedderReady', () => {
    it('returns false before initialization', () => {
      expect(isEmbedderReady()).toBe(false);
    });
  });

  it('uses the call-time model selection before the embedder is initialized', async () => {
    const previousModel = process.env.ONTOINDEX_EMBEDDING_MODEL;
    try {
      await disposeEmbedder();
      process.env.ONTOINDEX_EMBEDDING_MODEL = 'intent/selected-model';
      expect(getMcpEmbeddingModelId()).toBe('intent/selected-model');
    } finally {
      if (previousModel === undefined) delete process.env.ONTOINDEX_EMBEDDING_MODEL;
      else process.env.ONTOINDEX_EMBEDDING_MODEL = previousModel;
      await disposeEmbedder();
    }
  });

  it('rejects a concurrent initialization that requests a different model', async () => {
    const previousModel = process.env.ONTOINDEX_EMBEDDING_MODEL;
    const previousUrl = process.env.ONTOINDEX_EMBEDDING_URL;
    const fakeEmbedder = Object.assign(async () => ({ data: [0.5] }), { dispose: vi.fn() });
    let releasePipeline: ((value: typeof fakeEmbedder) => void) | undefined;
    const pipelineLoad = new Promise<typeof fakeEmbedder>((resolve) => {
      releasePipeline = resolve;
    });

    await disposeEmbedder();
    delete process.env.ONTOINDEX_EMBEDDING_URL;
    process.env.ONTOINDEX_EMBEDDING_MODEL = 'configured-model';
    mockTransformerPipeline.mockReset().mockReturnValue(pipelineLoad);

    let firstInitialization: Promise<unknown> | undefined;
    try {
      firstInitialization = initEmbedder('intent/model-a');
      await vi.waitFor(() => expect(mockTransformerPipeline).toHaveBeenCalledTimes(1));

      await expect(initEmbedder('intent/model-b')).rejects.toThrow(
        'Embedding model mismatch: the singleton uses "intent/model-a" but this request requires "intent/model-b".',
      );

      releasePipeline!(fakeEmbedder);
      await expect(firstInitialization).resolves.toBe(fakeEmbedder);
      expect(getMcpEmbeddingModelId()).toBe('intent/model-a');

      await expect(initEmbedder('intent/model-b')).rejects.toThrow(
        'Embedding model mismatch: the singleton uses "intent/model-a" but this request requires "intent/model-b".',
      );
      expect(mockTransformerPipeline).toHaveBeenCalledTimes(1);
    } finally {
      releasePipeline?.(fakeEmbedder);
      await firstInitialization?.catch(() => {});
      await disposeEmbedder();
      mockTransformerPipeline.mockReset();
      if (previousModel === undefined) delete process.env.ONTOINDEX_EMBEDDING_MODEL;
      else process.env.ONTOINDEX_EMBEDDING_MODEL = previousModel;
      if (previousUrl === undefined) delete process.env.ONTOINDEX_EMBEDDING_URL;
      else process.env.ONTOINDEX_EMBEDDING_URL = previousUrl;
    }
  });
});
