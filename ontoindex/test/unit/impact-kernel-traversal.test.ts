import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runImpactKernel } from '../../src/core/impact/impact-kernel.js';
import { impactResultCompleteness, runImpactBFS } from '../../src/mcp/local/backend-impact.js';
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

  it('admits no query for a pre-aborted signal', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      runImpactKernel(
        repo,
        { id: 'target', type: 'Function' },
        {
          ...traversalOptions,
          signal: controller.signal,
        },
      ),
    ).rejects.toThrow('aborted');
    expect(executeParameterized).not.toHaveBeenCalled();
  });

  it('retains prior depths when an admitted depth returns after cancellation', async () => {
    const controller = new AbortController();
    executeParameterized
      .mockResolvedValueOnce([impactedRow('caller')])
      .mockImplementationOnce(async () => {
        controller.abort();
        return [impactedRow('later')];
      });
    const result = await runImpactKernel(
      repo,
      { id: 'target', type: 'Function' },
      {
        ...traversalOptions,
        maxDepth: 3,
        signal: controller.signal,
      },
    );
    expect(result).toMatchObject({
      partial: true,
      traversalFailed: true,
      impacted: [{ id: 'caller' }],
      rawCounts: { total: 1, direct: 1, byDepth: { 1: 1 }, riskReasons: ['traversal_partial'] },
    });
    expect(result.warnings.join(' ')).toContain('aborted');
    expect(executeParameterized).toHaveBeenCalledTimes(2);
  });

  it('retains processed rows at a bounded cancellation checkpoint', async () => {
    const controller = new AbortController();
    const rows = Array.from({ length: 150 }, (_, index) => impactedRow(`caller-${index}`));
    Object.defineProperty(rows[5], 'filePath', {
      get() {
        controller.abort();
        return 'src/impacted.ts';
      },
    });
    executeParameterized.mockResolvedValueOnce(rows);
    const result = await runImpactKernel(
      repo,
      { id: 'target', type: 'Function' },
      {
        ...traversalOptions,
        maxDepth: 3,
        signal: controller.signal,
      },
    );
    expect(result.partial).toBe(true);
    expect(result.traversalFailed).toBe(true);
    expect(result.impacted).toHaveLength(100);
    expect(result.rawCounts.total).toBe(100);
    expect(result.rawCounts.riskReasons).toContain('traversal_partial');
    expect(executeParameterized).toHaveBeenCalledTimes(1);
  });

  it.each(['EMFILE', 'ENOMEM'])(
    'preserves %s identity after known nodes and cancellation',
    async (code) => {
      const controller = new AbortController();
      const resource = Object.assign(new Error('native resource failure'), { code });
      executeParameterized
        .mockResolvedValueOnce([impactedRow('caller')])
        .mockImplementationOnce(async () => {
          controller.abort();
          throw resource;
        });
      await expect(
        runImpactKernel(
          repo,
          { id: 'target', type: 'Function' },
          {
            ...traversalOptions,
            maxDepth: 3,
            signal: controller.signal,
          },
        ),
      ).rejects.toBe(resource);
      expect(executeParameterized).toHaveBeenCalledTimes(2);
    },
  );

  it.each(['EMFILE', 'ENOMEM'])(
    'awaits seed siblings and prioritizes %s over abort',
    async (code) => {
      const controller = new AbortController();
      const resource = Object.assign(new Error('native resource failure'), { code });
      let release!: () => void;
      let started!: () => void;
      const admitted = new Promise<void>((resolve) => {
        started = resolve;
      });
      const sibling = new Promise<void>((resolve) => {
        release = resolve;
      });
      executeParameterized.mockImplementation(async (_repoId, query) => {
        if (query.includes(':Constructor)')) {
          await sibling;
          throw resource;
        }
        started();
        controller.abort();
        throw new Error('Impact analysis aborted');
      });
      let settled = false;
      const pending = runImpactKernel(
        repo,
        { id: 'class', type: 'Class' },
        {
          ...traversalOptions,
          classSeedExpansion: true,
          signal: controller.signal,
        },
      );
      void pending.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      await admitted;
      await Promise.resolve();
      expect(settled).toBe(false);
      expect(executeParameterized).toHaveBeenCalledTimes(2);
      release();
      await expect(pending).rejects.toBe(resource);
    },
  );

  it.each(['Constructor', 'File'])('marks a rejected %s seed query partial', async (seedType) => {
    executeParameterized.mockImplementation(async (_repoId, query) => {
      if (query.includes(`:${seedType})`)) throw new Error('seed query unavailable');
      return [];
    });
    const symbol = { id: 'Class:src/target.ts:Target', name: 'Target', filePath: 'src/target.ts' };
    const kernel = await runImpactKernel(
      repo,
      { ...symbol, type: 'Class' },
      {
        ...traversalOptions,
        classSeedExpansion: true,
      },
    );
    expect(kernel.partial).toBe(true);
    expect(kernel.traversalFailed).toBe(true);
    expect(kernel.warnings).toContain('class seed expansion failed: seed query unavailable');

    const impact = await runImpactBFS(
      repo as Parameters<typeof runImpactBFS>[0],
      symbol,
      'Class',
      'upstream',
      { maxDepth: 1, relationTypes: ['CALLS'], includeTests: false, minConfidence: 0 },
    );
    expect(impact.partial).toBe(true);
    expect(impact.risk).toBe('UNKNOWN');
    expect(impactResultCompleteness(impact)).toBe('failed');
  });

  it.each(['Constructor', 'File'])(
    'rethrows resource errors from the %s seed query',
    async (seedType) => {
      const error = new Error(
        'Buffer manager exception: buffer pool is full and no memory could be freed',
      );
      executeParameterized.mockImplementation(async (_repoId, query) => {
        if (query.includes(`:${seedType})`)) throw error;
        return [];
      });
      await expect(
        runImpactKernel(
          repo,
          { id: 'Class:src/target.ts:Target', type: 'Class' },
          {
            ...traversalOptions,
            classSeedExpansion: true,
          },
        ),
      ).rejects.toBe(error);
    },
  );

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
      repo as Parameters<typeof runImpactBFS>[0],
      { id: 'Function:src/target.ts:target', name: 'target', type: 'Function' },
      traversalOptions,
    );

    expect(kernel.traversalFailed).toBe(true);
    expect(kernel.warnings.join(' ')).toContain('depth traversal failed: row unreadable');
  });

  it('marks a failed depth query and resulting risk UNKNOWN, never LOW', async () => {
    executeParameterized.mockRejectedValueOnce(new Error('traversal unavailable'));

    const kernel = await runImpactKernel(
      repo as Parameters<typeof runImpactBFS>[0],
      { id: 'Function:src/target.ts:target', name: 'target', type: 'Function' },
      traversalOptions,
    );
    expect(kernel.traversalFailed).toBe(true);

    executeParameterized.mockReset();
    executeParameterized.mockRejectedValueOnce(new Error('traversal unavailable'));
    const impact = await runImpactBFS(
      repo as Parameters<typeof runImpactBFS>[0],
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
