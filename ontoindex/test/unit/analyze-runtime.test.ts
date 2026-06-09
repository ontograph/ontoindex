import { describe, expect, it, vi } from 'vitest';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import { createTypeScriptAnalyzeRuntime } from '../../src/core/ingestion/runtime/index.js';
import type { PipelineResult } from '../../src/types/pipeline.js';

describe('TypeScriptAnalyzeRuntime', () => {
  it('delegates analyzeRepo to the injected TypeScript pipeline runner', async () => {
    const onProgress = vi.fn();
    const options = { skipWorkers: true, skipGraphPhases: true };
    const result: PipelineResult = {
      graph: createKnowledgeGraph(),
      repoPath: '/repo',
      totalFileCount: 2,
      usedWorkerPool: false,
    };
    const runPipeline = vi.fn().mockResolvedValue(result);
    const runtime = createTypeScriptAnalyzeRuntime({ runPipeline });

    await expect(
      runtime.analyzeRepo({
        repoPath: '/repo',
        onProgress,
        options,
      }),
    ).resolves.toBe(result);

    expect(runPipeline).toHaveBeenCalledWith('/repo', onProgress, options);
  });
});
