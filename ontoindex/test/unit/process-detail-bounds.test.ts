import { describe, it, expect, vi, beforeEach } from 'vitest';

const { lbugMocks } = vi.hoisted(() => ({
  lbugMocks: {
    executeQuery: vi.fn(),
    executeParameterized: vi.fn(),
  },
}));

vi.mock('../../src/core/lbug/pool-adapter.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, ...lbugMocks };
});

describe('process detail bounds', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('aggregates clusters by display label with filtering, sorting, and weighted cohesion', async () => {
    const { aggregateClusters } = await import('../../src/mcp/local/backend-resources.js');

    const clusters = aggregateClusters([
      { id: 'auth-small', label: 'Auth A', heuristicLabel: 'Auth', cohesion: 0.5, symbolCount: 4 },
      { id: 'auth-large', label: 'Auth B', heuristicLabel: 'Auth', cohesion: 1, symbolCount: 6 },
      {
        id: 'billing',
        label: 'Billing',
        heuristicLabel: undefined,
        cohesion: 0.25,
        symbolCount: 7,
      },
      { id: 'tiny', label: 'Tiny', heuristicLabel: 'Tiny', cohesion: 1, symbolCount: 4 },
    ]);

    expect(clusters).toEqual([
      {
        id: 'auth-large',
        label: 'Auth',
        heuristicLabel: 'Auth',
        symbolCount: 10,
        cohesion: 0.8,
        subCommunities: 2,
      },
      {
        id: 'billing',
        label: 'Billing',
        heuristicLabel: 'Billing',
        symbolCount: 7,
        cohesion: 0.25,
        subCommunities: 1,
      },
    ]);
  });

  it('maps cluster rows using object fields or tuple indexes with || fallback', async () => {
    lbugMocks.executeQuery.mockResolvedValueOnce([
      {
        id: '',
        0: 'cluster-from-index',
        label: '',
        1: 'Label from index',
        heuristicLabel: '',
        2: 'Auth from index',
        cohesion: 0,
        3: 0.6,
        symbolCount: 0,
        4: 6,
      },
      ['payments-id', 'Payments', undefined, 0.25, 7],
    ]);

    const { queryClusters } = await import('../../src/mcp/local/backend-resources.js');
    const result = await queryClusters({ id: 'repo' }, 10);

    expect(result.clusters).toEqual([
      {
        id: 'payments-id',
        label: 'Payments',
        heuristicLabel: 'Payments',
        symbolCount: 7,
        cohesion: 0.25,
        subCommunities: 1,
      },
      {
        id: 'cluster-from-index',
        label: 'Auth from index',
        heuristicLabel: 'Auth from index',
        symbolCount: 6,
        cohesion: 0.6,
        subCommunities: 1,
      },
    ]);
  });

  it('maps process rows using object fields or tuple indexes with || fallback', async () => {
    lbugMocks.executeQuery.mockResolvedValueOnce([
      {
        id: '',
        0: 'process-from-index',
        label: '',
        1: 'Process from index',
        heuristicLabel: '',
        2: 'Heuristic from index',
        processType: '',
        3: 'workflow',
        stepCount: 0,
        4: 12,
      },
      ['tuple-process', 'Tuple Process', 'Tuple Heuristic', 'flow', 5],
    ]);

    const { queryProcesses } = await import('../../src/mcp/local/backend-resources.js');
    const result = await queryProcesses({ id: 'repo' }, 10);

    expect(result.processes).toEqual([
      {
        id: 'process-from-index',
        label: 'Process from index',
        heuristicLabel: 'Heuristic from index',
        processType: 'workflow',
        stepCount: 12,
      },
      {
        id: 'tuple-process',
        label: 'Tuple Process',
        heuristicLabel: 'Tuple Heuristic',
        processType: 'flow',
        stepCount: 5,
      },
    ]);
  });

  it('returns empty cluster and process arrays when summary queries throw', async () => {
    const { queryClusters, queryProcesses } =
      await import('../../src/mcp/local/backend-resources.js');

    lbugMocks.executeQuery.mockRejectedValueOnce(new Error('cluster query failed'));
    await expect(queryClusters({ id: 'repo' })).resolves.toEqual({ clusters: [] });

    lbugMocks.executeQuery.mockRejectedValueOnce(new Error('process query failed'));
    await expect(queryProcesses({ id: 'repo' })).resolves.toEqual({ processes: [] });
  });

  it('returns stable not-found errors for missing cluster and process detail', async () => {
    const { queryClusterDetail, queryProcessDetail } =
      await import('../../src/mcp/local/backend-resources.js');

    lbugMocks.executeParameterized.mockResolvedValueOnce([]);
    await expect(queryClusterDetail({ id: 'repo' }, 'MissingCluster')).resolves.toEqual({
      error: "Cluster 'MissingCluster' not found",
    });

    lbugMocks.executeParameterized.mockResolvedValueOnce([]);
    await expect(queryProcessDetail({ id: 'repo' }, 'MissingProcess')).resolves.toEqual({
      error: "Process 'MissingProcess' not found",
    });
  });

  it('shapes cluster detail members from object fallback, tuple rows, and weighted aggregate metadata', async () => {
    lbugMocks.executeParameterized
      .mockResolvedValueOnce([
        { id: 'c-small', label: 'Auth A', heuristicLabel: 'Auth', cohesion: 0.5, symbolCount: 4 },
        { id: 'c-large', label: 'Auth B', heuristicLabel: 'Auth', cohesion: 1, symbolCount: 6 },
      ])
      .mockResolvedValueOnce([
        { name: '', 0: 'login', type: '', 1: 'Function', filePath: '', 2: 'src/auth.ts' },
        ['logout', 'Function', 'src/logout.ts'],
      ]);

    const { queryClusterDetail } = await import('../../src/mcp/local/backend-resources.js');
    const result = await queryClusterDetail({ id: 'repo' }, 'Auth');
    if ('error' in result) throw new Error(result.error);

    expect(result.cluster).toEqual({
      id: 'c-small',
      label: 'Auth',
      heuristicLabel: 'Auth',
      cohesion: 0.8,
      symbolCount: 10,
      subCommunities: 2,
    });
    expect(result.members).toEqual([
      { name: 'login', type: 'Function', filePath: 'src/auth.ts' },
      { name: 'logout', type: 'Function', filePath: 'src/logout.ts' },
    ]);
  });

  it('shapes process detail steps using object fields or tuple indexes with || fallback', async () => {
    lbugMocks.executeParameterized
      .mockResolvedValueOnce([
        {
          id: '',
          0: 'process-from-index',
          label: '',
          1: 'Process from index',
          heuristicLabel: '',
          2: 'Heuristic from index',
          processType: '',
          3: 'workflow',
          stepCount: 0,
          4: 2,
        },
      ])
      .mockResolvedValueOnce([
        {
          name: '',
          0: 'step-from-index',
          type: '',
          1: 'Function',
          filePath: '',
          2: 'src/step.ts',
          step: 0,
          3: 4,
        },
        ['tuple-step', 'Class', 'src/tuple.ts', 5],
      ]);

    const { queryProcessDetail } = await import('../../src/mcp/local/backend-resources.js');
    const result = await queryProcessDetail({ id: 'repo' }, 'Process from index');
    if ('error' in result) throw new Error(result.error);

    expect(lbugMocks.executeParameterized.mock.calls[1][2]).toEqual({
      procId: 'process-from-index',
    });
    expect(result.process).toEqual({
      id: 'process-from-index',
      label: 'Process from index',
      heuristicLabel: 'Heuristic from index',
      processType: 'workflow',
      stepCount: 2,
      truncated: false,
    });
    expect(result.steps).toEqual([
      { name: 'step-from-index', type: 'Function', filePath: 'src/step.ts', step: 4 },
      { name: 'tuple-step', type: 'Class', filePath: 'src/tuple.ts', step: 5 },
    ]);
  });

  it('caps MCP resource process steps and reports truncation', async () => {
    lbugMocks.executeParameterized
      .mockResolvedValueOnce([
        {
          id: 'p1',
          label: 'LoginFlow',
          heuristicLabel: 'LoginFlow',
          processType: 'flow',
          stepCount: 1500,
        },
      ])
      .mockResolvedValueOnce([
        { name: 'login', type: 'Function', filePath: 'src/auth.ts', step: 1 },
      ]);

    const { queryProcessDetail } = await import('../../src/mcp/local/backend-resources.js');
    const result = await queryProcessDetail({ id: 'repo' }, 'LoginFlow');

    expect(result.truncated).toBe(true);
    expect(result.stepLimit).toBe(1000);
    expect(lbugMocks.executeParameterized.mock.calls[1][1]).toContain('LIMIT 1000');
  });

  it('reports truncation when returned process steps reach the detail limit', async () => {
    lbugMocks.executeParameterized
      .mockResolvedValueOnce([
        {
          id: 'p1',
          label: 'HugeFlow',
          heuristicLabel: 'HugeFlow',
          processType: 'flow',
          stepCount: 1000,
        },
      ])
      .mockResolvedValueOnce(
        Array.from({ length: 1000 }, (_, index) => ({
          name: `step${index}`,
          type: 'Function',
          filePath: 'src/flow.ts',
          step: index + 1,
        })),
      );

    const { queryProcessDetail } = await import('../../src/mcp/local/backend-resources.js');
    const result = await queryProcessDetail({ id: 'repo' }, 'HugeFlow');

    expect(result.truncated).toBe(true);
    expect(result.steps).toHaveLength(1000);
  });
});
