import { describe, expect, it, vi } from 'vitest';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import { scanPhase } from '../../src/core/ingestion/pipeline-phases/scan.js';
import { walkRepositoryPaths } from '../../src/core/ingestion/filesystem-walker.js';

vi.mock('../../src/core/ingestion/filesystem-walker.js', () => ({
  walkRepositoryPaths: vi.fn(),
}));

describe('scanPhase', () => {
  it('orders scanned and skipped paths deterministically', async () => {
    vi.mocked(walkRepositoryPaths).mockImplementation(async (_repoPath, _progress, options) => {
      options?.onSkippedLargeFile?.({ path: 'z-large.ts', size: 20 });
      options?.onSkippedLargeFile?.({ path: 'A-large.ts', size: 10 });
      return [
        { path: 'z.ts', size: 3 },
        { path: 'a.ts', size: 2 },
        { path: 'A.ts', size: 1 },
      ];
    });

    const result = await scanPhase.execute(
      { repoPath: '/repo', graph: createKnowledgeGraph(), onProgress: () => {}, pipelineStart: 0 },
      new Map(),
    );

    expect(result.scannedFiles.map((file) => file.path)).toEqual(['A.ts', 'a.ts', 'z.ts']);
    expect(result.allPaths).toEqual(['A.ts', 'a.ts', 'z.ts']);
    expect(result.skippedLargeFiles.map((file) => file.path)).toEqual(['A-large.ts', 'z-large.ts']);
  });
});
