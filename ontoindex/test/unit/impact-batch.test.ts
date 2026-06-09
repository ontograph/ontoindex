import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../src/mcp/local/backend-impact.js', () => ({
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
  beforeEach(() => {
    impactMock.mockReset();
  });

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
    // Error entries must still appear in perSymbol so callers can inspect them.
    const errorEntry = result.perSymbol.find((e) => e.target === 'missing');
    expect(errorEntry?.result?.error).toMatch(/not found/i);
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
