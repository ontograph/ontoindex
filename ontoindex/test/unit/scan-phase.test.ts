import { describe, expect, it, vi } from 'vitest';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import { scanPhase } from '../../src/core/ingestion/pipeline-phases/scan.js';
import { walkRepositoryPaths } from '../../src/core/ingestion/filesystem-walker.js';

vi.mock('../../src/core/ingestion/filesystem-walker.js', () => ({
  walkRepositoryPaths: vi.fn(),
}));

describe('scanPhase', () => {
  it('orders scanned paths deterministically and retains an empty skipped list', async () => {
    vi.mocked(walkRepositoryPaths).mockResolvedValue([
      { path: 'z.ts', size: 3 },
      { path: 'a.ts', size: 2 },
      { path: 'A.ts', size: 1 },
    ]);

    const result = await scanPhase.execute(
      { repoPath: '/repo', graph: createKnowledgeGraph(), onProgress: () => {}, pipelineStart: 0 },
      new Map(),
    );

    expect(result.scannedFiles.map((file) => file.path)).toEqual(['A.ts', 'a.ts', 'z.ts']);
    expect(result.allPaths).toEqual(['A.ts', 'a.ts', 'z.ts']);
    expect(result.skippedLargeFiles).toEqual([]);
  });
});
