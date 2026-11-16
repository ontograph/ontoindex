import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../src/mcp/local/backend-impact.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/mcp/local/backend-impact.js')>()),
  runImpact: vi.fn(),
}));

import { runImpact } from '../../src/mcp/local/backend-impact.js';
import { runImpactBatch } from '../../src/mcp/local/backend-impact-batch.js';

const impactMock = runImpact as unknown as ReturnType<typeof vi.fn>;

function makeRepo(): any {
  return {
    id: 'impact-batch-test',
    name: 'impact-batch-test',
    repoPath: '/tmp/does-not-matter',
  };
}

describe('impact_batch', () => {
  it('forwards the documented confidence default and preserves zero', async () => {
    await runImpactBatch(makeRepo(), { targets: ['x'] });
    expect(impactMock).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ minConfidence: 0.7 }),
    );
    await runImpactBatch(makeRepo(), { targets: ['x'], minConfidence: 0 });
    expect(impactMock).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ minConfidence: 0 }),
    );
  });
  beforeEach(() => {
    impactMock.mockReset();
  });

  const target = {
    id: 'Function:src/auth.ts:login',
    name: 'login',
    type: 'Function',
    filePath: 'src/auth.ts',
  };
  const traversalFailure = {
    target,
    direction: 'upstream',
    impactedCount: 0,
    risk: 'UNKNOWN',
    partial: true,
    warnings: ['Impact traversal failed at depth 1: DB unavailable'],
    summary: { direct: 0, processes_affected: 0, modules_affected: 0 },
    affected_processes: [],
    affected_modules: [],
    byDepth: {},
  };

  it.each([
    ['first traversal failure', traversalFailure],
    [
      'ambiguous match',
      {
        status: 'ambiguous',
        message:
          "Found 2 symbols matching 'login'. Use target_uid, file_path, or kind to disambiguate.",
        target: { name: 'login' },
        direction: 'upstream',
        impactedCount: 0,
        risk: 'UNKNOWN',
        resolutionReason: 'ambiguous',
        candidates: [],
      },
    ],
    [
      'overlay unavailable',
      {
        target: { ...target, startLine: 1, endLine: 2, source: 'overlay' },
        direction: 'upstream',
        source: 'overlay',
        risk: 'UNKNOWN',
        graphImpactAvailable: false,
        impactedCount: 0,
        impacted: [],
        byDepth: {},
        message:
          'Graph impact is unavailable for uncommitted symbols: the overlay contains symbols only. Empty results do not mean zero callers or zero impact.',
      },
    ],
    [
      'source-only match',
      {
        target,
        direction: 'upstream',
        impactedCount: 0,
        risk: 'UNKNOWN',
        resolutionStatus: 'source-only',
        graphImpactAvailable: false,
        resolutionReason: 'untracked-file-not-indexed',
        sourceIdentity: {
          nodeId: target.id,
          name: target.name,
          kind: target.type,
          filePath: target.filePath,
          sourceDigest: 'abc',
        },
        suggestion:
          'Current source proves symbol identity, but graph impact is unavailable. Re-analyze this repository before treating impact as authoritative.',
      },
    ],
  ])('classifies %s as failed even without an error property', async (_label, failure) => {
    impactMock.mockResolvedValue(failure);
    const result = await runImpactBatch(makeRepo(), { targets: ['login'] });
    expect(result.status).toBe('error');
    expect(result.union).toEqual({
      totalAffectedNodes: 0,
      totalRelationships: 0,
      maxDepth: 0,
      risk: 'UNKNOWN',
      failedTargets: ['login'],
      sharedNodes: 0,
    });
    expect(result.perSymbol[0].result).toBe(failure);
  });

  it.each([{ partial: true }, { traversalComplete: false }])(
    'preserves usable nodes and reports incomplete targets for %j',
    async (flags) => {
      const partial = {
        ...traversalFailure,
        ...flags,
        partial: 'partial' in flags ? true : undefined,
        risk: 'LOW',
        impactedCount: 1,
        summary: { direct: 1, processes_affected: 0, modules_affected: 0 },
        byDepth: {
          1: [
            {
              id: 'caller',
              name: 'caller',
              type: 'Function',
              filePath: 'src/caller.ts',
              depth: 1,
              relationType: 'CALLS',
              confidence: 1,
            },
          ],
        },
      };
      impactMock.mockResolvedValueOnce(traversalFailure).mockResolvedValueOnce(partial);
      const result = await runImpactBatch(makeRepo(), { targets: ['failed', 'partial'] });
      expect(result.status).toBe('success');
      expect(result.union).toEqual({
        totalAffectedNodes: 1,
        totalRelationships: 1,
        maxDepth: 1,
        risk: 'UNKNOWN',
        failedTargets: ['failed'],
        incompleteTargets: ['partial'],
        sharedNodes: 0,
      });
      impactMock.mockResolvedValue(partial);
      const onlyPartial = await runImpactBatch(makeRepo(), { targets: ['partial'] });
      expect(onlyPartial.status).toBe('success');
      expect(onlyPartial.union.risk).toBe('UNKNOWN');
      expect(onlyPartial.union.incompleteTargets).toEqual(['partial']);
      expect(onlyPartial.union.failedTargets).toBeUndefined();
    },
  );

  it('returns error when targets is missing or empty', async () => {
    const repo = makeRepo();
    const missing = await runImpactBatch(repo, { direction: 'upstream' });
    expect(missing.status).toBe('error');
    expect(missing.error).toMatch(/targets/i);

    const empty = await runImpactBatch(repo, { targets: [], direction: 'upstream' });
    expect(empty.status).toBe('error');

    const allBlank = await runImpactBatch(repo, { targets: ['', '  '], direction: 'upstream' });
    expect(allBlank.status).toBe('error');
    expect(impactMock).not.toHaveBeenCalled();
  });

  it('rejects oversized target batches before running impact analysis', async () => {
    const repo = makeRepo();
    const result = await runImpactBatch(repo, {
      targets: Array.from({ length: 51 }, (_, i) => `target_${i}`),
      direction: 'upstream',
    });

    expect(result.status).toBe('error');
    expect(result.error).toMatch(/at most 50 targets/i);
    expect(impactMock).not.toHaveBeenCalled();
  });

  it('aggregates per-symbol impact results and reports shared nodes', async () => {
    // alpha reaches A,B; beta reaches B,C — so B is shared (hits=2).
    impactMock.mockImplementation(async (_repo, params) => {
      if (params.target === 'alpha') {
        return {
          target: { name: 'alpha' },
          direction: params.direction,
          impactedCount: 2,
          impacted: [
            { depth: 1, id: 'A', name: 'A' },
            { depth: 2, id: 'B', name: 'B' },
          ],
        };
      }
      return {
        target: { name: 'beta' },
        direction: params.direction,
        impactedCount: 2,
        impacted: [
          { depth: 1, id: 'B', name: 'B' },
          { depth: 3, id: 'C', name: 'C' },
        ],
      };
    });

    const repo = makeRepo();
    const result = await runImpactBatch(repo, {
      targets: ['alpha', 'beta'],
      direction: 'upstream',
    });
    expect(result.status).toBe('success');
    expect(result.perSymbol).toHaveLength(2);
    expect(result.union.totalAffectedNodes).toBe(3); // A, B, C distinct
    expect(result.union.totalRelationships).toBe(4); // 2 + 2
    expect(result.union.sharedNodes).toBe(1); // only B
    expect(result.union.maxDepth).toBe(3);
    expect(result.union.risk).toBe('LOW');
  });

  it('classifies risk bucket from union size', async () => {
    impactMock.mockResolvedValue({
      target: { name: 'x' },
      direction: 'upstream',
      impactedCount: 150,
      impacted: Array.from({ length: 150 }, (_, i) => ({
        depth: 1,
        id: `n_${i}`,
        name: `n${i}`,
      })),
    });
    const repo = makeRepo();
    const result = await runImpactBatch(repo, { targets: ['x'], direction: 'upstream' });
    expect(result.status).toBe('success');
    expect(result.union.totalAffectedNodes).toBe(150);
    expect(result.union.risk).toBe('CRITICAL');
  });

  it('ignores per-symbol error entries when computing the union', async () => {
    impactMock.mockImplementation(async (_repo, params) => {
      if (params.target === 'missing') {
        return { error: "Target 'missing' not found", target: { name: 'missing' } };
      }
      return {
        target: { name: 'ok' },
        direction: params.direction,
        impactedCount: 1,
        impacted: [{ depth: 1, id: 'Z', name: 'Z' }],
      };
    });
    const repo = makeRepo();
    const result = await runImpactBatch(repo, {
      targets: ['missing', 'ok'],
      direction: 'downstream',
    });
    expect(result.status).toBe('success');
    expect(result.perSymbol).toHaveLength(2);
    expect(result.union.totalAffectedNodes).toBe(1);
    expect(result.union.totalRelationships).toBe(1);
    expect(result.union.risk).toBe('UNKNOWN');
    expect(result.union.failedTargets).toEqual(['missing']);
    // Error entries must still appear in perSymbol so callers can inspect them.
    const errorEntry = result.perSymbol.find((e) => e.target === 'missing');
    expect(errorEntry?.result?.error).toMatch(/not found/i);
  });

  it('keeps successful targets when another target throws a resource failure', async () => {
    const message = 'Buffer manager exception: buffer pool is full and no memory could be freed';
    const success = {
      target: { name: 'ok' },
      direction: 'upstream',
      impactedCount: 1,
      byDepth: { 1: [{ id: 'Z', depth: 1 }] },
    };
    impactMock.mockImplementation(async (_repo, params) => {
      if (params.target === 'failed') throw new Error(message);
      return success;
    });
    const result = await runImpactBatch(makeRepo(), { targets: ['failed', 'ok'] });
    expect(result.status).toBe('success');
    expect(result.perSymbol).toEqual([
      {
        target: 'failed',
        result: {
          error: message,
          target: { name: 'failed' },
          direction: 'upstream',
          impactedCount: 0,
          risk: 'UNKNOWN',
          suggestion: 'The graph query failed — try ontoindex context <symbol> as a fallback',
        },
      },
      { target: 'ok', result: success },
    ]);
    expect(result.union).toEqual({
      totalAffectedNodes: 1,
      totalRelationships: 1,
      maxDepth: 1,
      risk: 'UNKNOWN',
      failedTargets: ['failed'],
      sharedNodes: 0,
    });
  });

  it('returns an error and UNKNOWN risk when every target fails', async () => {
    impactMock.mockImplementation(async (_repo, params) => {
      if (params.target === 'resource') {
        throw new Error(
          'Buffer manager exception: buffer pool is full and no memory could be freed',
        );
      }
      return { error: 'Target not found', target: { name: params.target } };
    });
    const result = await runImpactBatch(makeRepo(), { targets: ['resource', 'missing'] });
    expect(result.status).toBe('error');
    expect(result.error).toMatch(/every target/i);
    expect(result.perSymbol).toHaveLength(2);
    expect(result.perSymbol.every(({ result }) => Boolean(result.error))).toBe(true);
    expect(result.union).toEqual({
      totalAffectedNodes: 0,
      totalRelationships: 0,
      maxDepth: 0,
      risk: 'UNKNOWN',
      failedTargets: ['resource', 'missing'],
      sharedNodes: 0,
    });
  });

  it('defaults direction to upstream and maxDepth to 3', async () => {
    impactMock.mockResolvedValue({
      target: { name: 't' },
      direction: 'upstream',
      impactedCount: 0,
      impacted: [],
    });
    const repo = makeRepo();
    const result = await runImpactBatch(repo, { targets: ['t'] } as any);
    expect(result.status).toBe('success');
    expect(result.direction).toBe('upstream');
    expect(result.maxDepth).toBe(3);
    expect(impactMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ direction: 'upstream', maxDepth: 3 }),
    );
  });

  it('caps maxDepth at the tool schema maximum', async () => {
    impactMock.mockResolvedValue({
      target: { name: 't' },
      direction: 'upstream',
      impactedCount: 0,
      impacted: [],
    });
    const repo = makeRepo();
    const result = await runImpactBatch(repo, { targets: ['t'], maxDepth: 99 } as any);
    expect(result.status).toBe('success');
    expect(result.maxDepth).toBe(32);
    expect(impactMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ maxDepth: 32 }),
    );
  });

  it('computes union stats from runImpact byDepth results', async () => {
    impactMock.mockImplementation(async (_repo, params) => {
      if (params.target === 'alpha') {
        return {
          target: { name: 'alpha' },
          direction: params.direction,
          impactedCount: 2,
          byDepth: {
            1: [{ id: 'A', name: 'A', depth: 1 }],
            2: [{ id: 'B', name: 'B', depth: 2 }],
          },
        };
      }
      return {
        target: { name: 'beta' },
        direction: params.direction,
        impactedCount: 2,
        byDepth: {
          1: [{ id: 'B', name: 'B' }],
          3: [{ id: 'C', name: 'C' }],
        },
      };
    });

    const repo = makeRepo();
    const result = await runImpactBatch(repo, {
      targets: ['alpha', 'beta'],
      direction: 'upstream',
    });

    expect(result.status).toBe('success');
    expect(result.union.totalAffectedNodes).toBe(3);
    expect(result.union.totalRelationships).toBe(4);
    expect(result.union.sharedNodes).toBe(1);
    expect(result.union.maxDepth).toBe(3);
    expect(result.union.risk).toBe('LOW');
  });
});
