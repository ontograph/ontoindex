/**
 * Unit Test: Embeddings Guard (T-1.3.03)
 *
 * Verifies that the analyzer refuses to run if the embedding model hash
 * in meta.json doesn't match the current environment.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runFullAnalysis } from '../../src/core/run-analyze.js';
import * as repoManager from '../../src/storage/repo-manager.js';

vi.mock('../../src/storage/repo-manager.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...(actual as any),
    loadMeta: vi.fn(),
    saveMeta: vi.fn(),
    registerRepo: vi.fn(),
    addToGitignore: vi.fn(),
    clearCheckpoint: vi.fn(),
  };
});

vi.mock('../../src/core/analysis-setup.js', () => ({
  runSetupPhase: vi.fn().mockResolvedValue({
    storagePath: '/mock/storage',
    lbugPath: '/mock/lbug',
    shadowLbugPath: '/mock/shadow',
    currentCommit: 'abc',
    filesToParse: [],
    cachedEmbeddingNodeIds: new Set(),
  }),
}));

// Mock lbug-adapter to avoid native calls
vi.mock('../../src/core/lbug/lbug-adapter.js', () => ({
  initLbug: vi.fn(),
  loadGraphToLbug: vi.fn(),
  getLbugStats: vi.fn().mockResolvedValue({ nodes: 0, edges: 0 }),
  executeQuery: vi.fn().mockResolvedValue([]),
  closeLbug: vi.fn(),
  swapLbugDb: vi.fn(),
}));

describe('Embeddings Guard (Model Hash Mismatch)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('refuses to analyze if model hash mismatched and embeddings enabled', async () => {
    // Existing index has hash "aaa"
    (repoManager.loadMeta as any).mockResolvedValue({
      model_hash: 'aaa',
    });

    // Current environment has hash "bbb"
    process.env.ONTOINDEX_EMBEDDING_MODEL_HASH = 'bbb';

    const options = { embeddings: true };
    const callbacks = { onProgress: vi.fn() };

    await expect(runFullAnalysis('/mock/repo', options, callbacks)).rejects.toThrow(
      /Embedding model mismatch/,
    );
  });

  it('allows analysis if model hash matches', async () => {
    (repoManager.loadMeta as any).mockResolvedValue({
      model_hash: 'aaa',
    });
    process.env.ONTOINDEX_EMBEDDING_MODEL_HASH = 'aaa';

    // This will still fail later because our mock is incomplete,
    // but it should get PAST the guard.
    try {
      await runFullAnalysis('/mock/repo', { embeddings: true }, { onProgress: vi.fn() });
    } catch (err: any) {
      expect(err.message).not.toMatch(/Embedding model mismatch/);
    }
  });
});
