import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runImpactKernel } from '../../src/core/impact/impact-kernel.js';
import { runImpactBFS } from '../../src/mcp/local/backend-impact.js';
import * as poolAdapter from '../../src/core/lbug/pool-adapter.js';

vi.mock('../../src/core/lbug/pool-adapter.js', () => ({
  executeParameterized: vi.fn(),
  executeQuery: vi.fn(),
}));

const executeParameterized = vi.mocked(poolAdapter.executeParameterized);
const repo = { id: 'traversal-test' };
const traversalOptions = {
  direction: 'upstream' as const,
  maxDepth: 1,
  relationTypes: ['CALLS'],
  classSeedExpansion: false,
};

function impactedRow(id: string) {
  return {
    id,
    name: 'impacted',
    type: 'Function',
    filePath: 'src/impacted.ts',
    relType: 'CALLS',
    confidence: 0.95,
  };
}

describe('impact kernel traversal', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    executeParameterized.mockResolvedValue([]);
  });

  it.each(['Function:src/delete.ts:remove', "Function:src/file's.ts:lookup"])(
    'binds keyword-like or quoted frontier id %s outside query text and traverses it',
    async (frontierId) => {
      executeParameterized.mockResolvedValueOnce([impactedRow('Function:src/caller.ts:caller')]);

      const result = await runImpactKernel(
        repo,
        { id: frontierId, type: 'Function' },
        traversalOptions,
      );

      expect(result.impacted.map(({ id }) => id)).toEqual(['Function:src/caller.ts:caller']);
      const [repoId, query, params] = executeParameterized.mock.calls[0];
      expect(repoId).toBe(repo.id);
      expect(query).toContain('n.id IN $frontierIds');
      expect(query).not.toContain(frontierId);
      expect(params).toEqual({ frontierIds: [frontierId] });
      expect(result.traversalFailed).toBe(false);
    },
  );

  it('marks the traversal failed when a returned row cannot be processed', async () => {
    const poisoned = {
      ...impactedRow('Function:src/caller.ts:caller'),
      get filePath(): string {
        throw new Error('row unreadable');
      },
    };
    executeParameterized.mockResolvedValueOnce([poisoned]);

    const kernel = await runImpactKernel(
      repo,
      { id: 'Function:src/target.ts:target', name: 'target', type: 'Function' },
      traversalOptions,
    );

    expect(kernel.traversalFailed).toBe(true);
    expect(kernel.warnings.join(' ')).toContain('depth traversal failed: row unreadable');
  });

  it('marks a failed depth query and resulting risk UNKNOWN, never LOW', async () => {
    executeParameterized.mockRejectedValueOnce(new Error('traversal unavailable'));

    const kernel = await runImpactKernel(
      repo,
      { id: 'Function:src/target.ts:target', name: 'target', type: 'Function' },
      traversalOptions,
    );
    expect(kernel.traversalFailed).toBe(true);

    executeParameterized.mockReset();
    executeParameterized.mockRejectedValueOnce(new Error('traversal unavailable'));
    const impact = await runImpactBFS(
      repo,
      { id: 'Function:src/target.ts:target', name: 'target', filePath: 'src/target.ts' },
      'Function',
      'upstream',
      {
        maxDepth: 1,
        relationTypes: ['CALLS'],
        includeTests: false,
        minConfidence: 0,
      },
    );

    expect(impact.risk).toBe('UNKNOWN');
    expect(impact.risk).not.toBe('LOW');
    expect(impact.partial).toBe(true);
  });
});
