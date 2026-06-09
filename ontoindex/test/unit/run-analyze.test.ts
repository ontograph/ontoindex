import { describe, it, expect, vi } from 'vitest';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import type { PipelineResult } from '../../src/types/pipeline.js';

describe('run-analyze module', () => {
  it('exports runFullAnalysis as a function', async () => {
    const mod = await import('../../src/core/run-analyze.js');
    expect(typeof mod.runFullAnalysis).toBe('function');
  }, 60_000);

  it('exports PHASE_LABELS', async () => {
    const mod = await import('../../src/core/run-analyze.js');
    expect(mod.PHASE_LABELS).toBeDefined();
    expect(mod.PHASE_LABELS.parsing).toBe('Parsing code');
  });

  it('delegates runAnalysisPipeline through an injected AnalyzeRuntime', async () => {
    const mod = await import('../../src/core/run-analyze.js');
    const onProgress = vi.fn();
    const options = { skipWorkers: true };
    const result: PipelineResult = {
      graph: createKnowledgeGraph(),
      repoPath: '/repo',
      totalFileCount: 1,
      usedWorkerPool: false,
    };
    const analyzeRuntime = {
      analyzeRepo: vi.fn().mockResolvedValue(result),
    };

    await expect(
      mod.runAnalysisPipeline('/repo', onProgress, options, analyzeRuntime),
    ).resolves.toBe(result);

    expect(analyzeRuntime.analyzeRepo).toHaveBeenCalledWith({
      repoPath: '/repo',
      onProgress,
      options,
    });
  });
});
