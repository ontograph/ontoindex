import { beforeEach, describe, expect, it, vi } from 'vitest';

const executeParameterized = vi.fn();
const executeQuery = vi.fn();
const semanticSearch = vi.fn();
const runImpactKernel = vi.fn();

vi.mock('../../../src/core/lbug/pool-adapter.js', () => ({
  executeParameterized,
  executeQuery,
}));

vi.mock('../../../src/mcp/local/backend-query.js', () => ({
  semanticSearch,
}));

vi.mock('../../../src/core/impact/impact-kernel.js', async () => {
  const actual = await vi.importActual<typeof import('../../../src/core/impact/impact-kernel.js')>(
    '../../../src/core/impact/impact-kernel.js',
  );
  return {
    ...actual,
    runImpactKernel,
  };
});

const { gnTestGap } = await import('../../../src/mcp/super/write-through-verification.js');

describe('gn_test_gap target mode', () => {
  beforeEach(() => {
    executeParameterized.mockReset();
    executeQuery.mockReset();
    semanticSearch.mockReset();
    runImpactKernel.mockReset();
  });

  it('uses graph-resolved symbol ids for linked test evidence', async () => {
    executeParameterized.mockResolvedValueOnce([
      {
        id: 'Function:src/process.ts:spawnChild',
        name: 'spawnChild',
        type: 'Function',
        filePath: 'src/process.ts',
        startLine: 1,
        endLine: 3,
      },
    ]);
    runImpactKernel.mockResolvedValueOnce({
      impacted: [{ filePath: 'test/process.test.ts' }],
      warnings: [],
    });

    const result = await gnTestGap('/repo', {
      repo: '/repo',
      symbol: 'spawnChild',
    });

    expect(result).toMatchObject({
      mode: 'target',
      status: 'PASS',
      targetedCoverage: 'found',
      resolvedSymbols: [
        {
          id: 'Function:src/process.ts:spawnChild',
          name: 'spawnChild',
          filePath: 'src/process.ts',
          type: 'Function',
        },
      ],
      evidence: [
        expect.objectContaining({
          testFile: 'test/process.test.ts',
          evidenceClass: 'graph',
        }),
      ],
    });
    expect(runImpactKernel).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: 'Function:src/process.ts:spawnChild' }),
      expect.objectContaining({ includeTests: true }),
    );
  });

  it('expands query targets through semantic search when available', async () => {
    semanticSearch.mockResolvedValueOnce([
      {
        nodeId: 'Function:src/auth.ts:authorize',
        name: 'authorize',
        type: 'Function',
        filePath: 'src/auth.ts',
      },
    ]);
    runImpactKernel.mockResolvedValueOnce({
      impacted: [{ filePath: 'test/auth.test.ts' }],
      warnings: [],
    });

    const result = await gnTestGap('/repo', {
      repo: '/repo',
      query: 'auth guard',
    });

    expect(semanticSearch).toHaveBeenCalledWith(expect.anything(), 'auth guard', 25);
    expect(result).toMatchObject({
      mode: 'target',
      status: 'PASS',
      targetedCoverage: 'found',
      resolvedSymbols: [expect.objectContaining({ id: 'Function:src/auth.ts:authorize' })],
      evidence: [expect.objectContaining({ testFile: 'test/auth.test.ts' })],
    });
  });

  it('falls back to target mode when semantic search is unavailable', async () => {
    semanticSearch.mockRejectedValueOnce(new Error('semantic backend offline'));

    const result = await gnTestGap('/repo', {
      repo: '/repo',
      query: 'zzzzzzzzzzzz',
    });

    expect(semanticSearch).toHaveBeenCalledWith(expect.anything(), 'zzzzzzzzzzzz', 25);
    expect(result).toMatchObject({
      mode: 'target',
      status: 'NEEDS-VERIFY',
      targetedCoverage: 'unknown',
      evidence: [],
      nextTools: ['gn_test_suggestions'],
    });
    expect(result).toMatchObject({
      warnings: ['Semantic query expansion unavailable: semantic backend offline'],
    });
  });
});
