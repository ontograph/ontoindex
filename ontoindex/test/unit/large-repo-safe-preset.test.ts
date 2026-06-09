import { describe, expect, it } from 'vitest';
import {
  applyLargeRepoSafeAnalyzePreset,
  formatHugeRepoNote,
  formatLargeRepoSafeNote,
  LARGE_REPO_SAFE_ENV_DEFAULTS,
} from '../../src/cli/analyze-large-repo-safe.js';
import { createWorkerSubBatches } from '../../src/core/ingestion/workers/worker-pool.js';

describe('large repo safe analyze preset', () => {
  it('sets conservative defaults only for unset env values', () => {
    const env: NodeJS.ProcessEnv = {
      ONTOINDEX_MAX_WORKERS: '4',
      ONTOINDEX_WORKER_SUB_BATCH_TIMEOUT_MS: '',
    };

    const applied = applyLargeRepoSafeAnalyzePreset({ largeRepoSafe: true }, env);

    expect(env.ONTOINDEX_MAX_WORKERS).toBe('4');
    expect(env.ONTOINDEX_WORKER_SUB_BATCH_SIZE).toBe(
      LARGE_REPO_SAFE_ENV_DEFAULTS.ONTOINDEX_WORKER_SUB_BATCH_SIZE,
    );
    expect(env.ONTOINDEX_WORKER_SUB_BATCH_TIMEOUT_MS).toBe(
      LARGE_REPO_SAFE_ENV_DEFAULTS.ONTOINDEX_WORKER_SUB_BATCH_TIMEOUT_MS,
    );
    expect(env.ONTOINDEX_WORKER_SUB_BATCH_MAX_BYTES).toBe(
      LARGE_REPO_SAFE_ENV_DEFAULTS.ONTOINDEX_WORKER_SUB_BATCH_MAX_BYTES,
    );
    expect(applied).toEqual([
      'ONTOINDEX_WORKER_SUB_BATCH_SIZE',
      'ONTOINDEX_WORKER_SUB_BATCH_TIMEOUT_MS',
      'ONTOINDEX_WORKER_SUB_BATCH_MAX_BYTES',
    ]);
  });

  it('does nothing when the flag is not enabled', () => {
    const env: NodeJS.ProcessEnv = {};

    expect(applyLargeRepoSafeAnalyzePreset({}, env)).toEqual([]);
    expect(env).toEqual({});
  });

  it('applies the same conservative defaults for huge-repo mode', () => {
    const env: NodeJS.ProcessEnv = {};

    const applied = applyLargeRepoSafeAnalyzePreset({ hugeRepo: true }, env);

    expect(applied).toEqual(Object.keys(LARGE_REPO_SAFE_ENV_DEFAULTS));
    expect(env.ONTOINDEX_MAX_WORKERS).toBe(LARGE_REPO_SAFE_ENV_DEFAULTS.ONTOINDEX_MAX_WORKERS);
  });

  it('reports embedding behavior in the console note', () => {
    expect(formatLargeRepoSafeNote(['ONTOINDEX_MAX_WORKERS'], {})).toContain(
      'embeddings remain disabled unless --embeddings is set',
    );
    expect(formatLargeRepoSafeNote([], { embeddings: true })).toContain(
      '--embeddings was requested',
    );
  });

  it('reports huge-repo mode honestly as degraded symbols-only indexing', () => {
    expect(formatHugeRepoNote()).toContain('symbols-only index');
    expect(formatHugeRepoNote()).toContain('degraded capability metadata');
  });

  it('bounds worker sub-batches by byte budget without splitting a single oversized item', () => {
    const batches = createWorkerSubBatches(
      [
        { path: 'a.ts', content: '12345' },
        { path: 'b.ts', content: '12345' },
        { path: 'c.ts', content: '12345678901234567890' },
      ],
      100,
      16,
    );

    expect(batches).toEqual([
      [{ path: 'a.ts', content: '12345' }],
      [{ path: 'b.ts', content: '12345' }],
      [{ path: 'c.ts', content: '12345678901234567890' }],
    ]);
  });
});
