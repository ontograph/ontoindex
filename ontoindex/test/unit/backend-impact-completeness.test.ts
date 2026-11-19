import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/core/lbug/pool-adapter.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/core/lbug/pool-adapter.js')>()),
  executeParameterized: vi.fn(),
}));

import { executeParameterized } from '../../src/core/lbug/pool-adapter.js';
import {
  impactByUid,
  impactResultCompleteness,
  runImpact,
  runImpactBFS,
} from '../../src/mcp/local/backend-impact.js';

describe('impact result completeness', () => {
  it.each([
    'impact:process-chunk',
    'impact:process-chunk-backfill',
    'impact:module-chunk',
    'impact:direct-module-chunk',
  ])('reports ordinary %s failures as partial with UNKNOWN risk', async (context) => {
    mockEnrichmentFailure(context, new Error('query unavailable'));
    const result = await runImpact(
      { id: 'repo', name: 'repo' },
      { target: 'login', target_uid: targetUid, direction: 'upstream', maxDepth: 1 },
    );
    expect(result).toMatchObject({ impactedCount: 1, risk: 'UNKNOWN', partial: true });
    expect((result as { warnings?: string[] }).warnings).toContain(
      `${context} query failed: query unavailable`,
    );
    expect(impactResultCompleteness(result)).toBe('partial');
  });

  it.each([
    'impact:process-chunk',
    'impact:process-chunk-backfill',
    'impact:module-chunk',
    'impact:direct-module-chunk',
  ])('rethrows resource failures from %s', async (context) => {
    const error = new Error(
      'Buffer manager exception: buffer pool is full and no memory could be freed',
    );
    mockEnrichmentFailure(context, error);
    await expect(
      runImpact(
        { id: 'repo', name: 'repo' },
        { target: 'login', target_uid: targetUid, direction: 'upstream', maxDepth: 1 },
      ),
    ).rejects.toBe(error);
  });

  it('recognizes the real first-traversal failure without an error property', async () => {
    const uid = 'Function:src/auth.ts:login';
    vi.mocked(executeParameterized).mockImplementation(async (_repo, _query, params) => {
      if (params?.uid === uid) {
        return [
          {
            id: uid,
            name: 'login',
            type: 'Function',
            filePath: 'src/auth.ts',
            startLine: 1,
            endLine: 2,
          },
        ];
      }
      throw new Error('DB unavailable');
    });
    const result = await runImpact(
      { id: 'repo', name: 'repo' },
      { target: 'login', target_uid: uid, direction: 'upstream' },
    );
    expect(result).toMatchObject({
      target: { id: uid },
      impactedCount: 0,
      risk: 'UNKNOWN',
      partial: true,
      summary: { direct: 0, processes_affected: 0, modules_affected: 0 },
      affected_processes: [],
      affected_modules: [],
      byDepth: {},
    });
    expect(result.error).toBeUndefined();
    expect(impactResultCompleteness(result)).toBe('failed');
  });
});

const targetUid = 'Function:src/auth.ts:login';

describe('module membership completeness', () => {
  it.each([
    'complete',
    'hits-abort',
    'direct-failure',
    'direct-abort',
    'second-chunk-failure',
    'capped',
    'partial-kernel',
  ])('preserves positive membership without inventing negatives: %s', async (mode) => {
    const controller = new AbortController();
    const many = mode === 'second-chunk-failure' || mode === 'capped';
    const oldCap = process.env.IMPACT_MAX_CHUNKS;
    if (mode === 'capped') process.env.IMPACT_MAX_CHUNKS = '1';
    let directQueries = 0;
    const query = vi.fn(async (cypher: string, params: Record<string, unknown>) => {
      if (params.frontierIds) {
        if (!(params.frontierIds as string[]).includes(targetUid)) {
          return [
            {
              id: 'Function:src/other.ts:other',
              name: 'other',
              type: 'Function',
              filePath: 'src/other.ts',
              relType: 'CALLS',
              confidence: 0.95,
            },
          ];
        }
        return Array.from({ length: many ? 101 : 1 }, (_, i) => ({
          id: `Function:src/caller.ts:caller${i}`,
          name: `caller${i}`,
          type: 'Function',
          filePath: 'src/caller.ts',
          relType: 'CALLS',
          confidence: 0.95,
        }));
      }
      if (cypher.includes('RETURN DISTINCT c.heuristicLabel')) {
        directQueries++;
        if (mode === 'direct-failure' || (mode === 'second-chunk-failure' && directQueries === 2))
          throw new Error('direct lookup unavailable');
        if (mode === 'direct-abort') controller.abort();
        return [{ name: 'Direct' }];
      }
      if (cypher.includes('c.heuristicLabel AS name')) {
        if (mode === 'hits-abort') controller.abort();
        const ids = params.ids as string[];
        return [
          ...(ids.some((id) => id.includes('caller')) ? [{ name: 'Direct', hits: 1 }] : []),
          ...(ids.includes('Function:src/other.ts:other') ? [{ name: 'Other', hits: 1 }] : []),
        ];
      }
      return [];
    });
    try {
      const result = await runImpactBFS(
        { id: 'repo', name: 'repo' },
        { id: targetUid, name: 'login', type: 'Function', filePath: 'src/auth.ts' },
        'Function',
        'upstream',
        {
          maxDepth: 2,
          relationTypes: ['CALLS'],
          includeTests: false,
          minConfidence: 0,
          query,
          signal: controller.signal,
          ...(mode === 'partial-kernel' && { dirtyPaths: new Set(['src/other.ts']) }),
        },
      );
      const labels = Object.fromEntries(
        result.affected_modules.map((row) => [row.name, row.impact]),
      );
      expect(labels).toEqual({
        Direct: mode === 'hits-abort' || mode === 'direct-failure' ? 'unknown' : 'direct',
        ...(mode !== 'capped' && {
          Other: mode === 'complete' || mode === 'direct-abort' ? 'indirect' : 'unknown',
        }),
      });
      if (mode === 'hits-abort') expect(directQueries).toBe(0);
      if (controller.signal.aborted)
        expect(result).toMatchObject({ partial: true, risk: 'UNKNOWN' });
    } finally {
      if (oldCap === undefined) delete process.env.IMPACT_MAX_CHUNKS;
      else process.env.IMPACT_MAX_CHUNKS = oldCap;
    }
  });
});

describe('UID impact failures', () => {
  const repo = { id: 'repo', name: 'repo' };
  const opts = { maxDepth: 1, relationTypes: ['CALLS'], minConfidence: 0, includeTests: false };

  it('starts no lookup for a pre-aborted signal', async () => {
    vi.mocked(executeParameterized).mockReset();
    const controller = new AbortController();
    controller.abort();
    await expect(
      impactByUid(repo, targetUid, 'upstream', { ...opts, signal: controller.signal }),
    ).rejects.toThrow('aborted');
    expect(executeParameterized).not.toHaveBeenCalled();
  });

  it.each([false, true])('stops after UID lookup (resource failure: %s)', async (resource) => {
    const controller = new AbortController();
    const error = Object.assign(new Error('query unavailable'), { code: 'ENOMEM' });
    vi.mocked(executeParameterized)
      .mockReset()
      .mockImplementation(async () => {
        controller.abort();
        if (resource) throw error;
        return [{ id: targetUid, name: 'login', type: 'Function', filePath: 'src/auth.ts' }];
      });
    const result = impactByUid(repo, targetUid, 'upstream', { ...opts, signal: controller.signal });
    if (resource) await expect(result).rejects.toBe(error);
    else await expect(result).rejects.toThrow('aborted');
    expect(executeParameterized).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])('stops after enrichment (resource failure: %s)', async (resource) => {
    const controller = new AbortController();
    const error = Object.assign(new Error('query unavailable'), { code: 'EMFILE' });
    const query = vi.fn(async (_cypher: string, params: Record<string, unknown>) => {
      if (params.frontierIds)
        return [
          {
            id: 'Function:src/caller.ts:caller',
            name: 'caller',
            type: 'Function',
            filePath: 'src/caller.ts',
            relType: 'CALLS',
            confidence: 0.95,
          },
        ];
      controller.abort();
      if (resource) throw error;
      return [];
    });
    const result = runImpactBFS(
      repo,
      {
        id: targetUid,
        name: 'login',
        type: 'Function',
        filePath: 'src/auth.ts',
      },
      'Function',
      'upstream',
      { ...opts, query, signal: controller.signal },
    );
    if (resource) await expect(result).rejects.toBe(error);
    else {
      const retained = await result;
      expect(retained).toMatchObject({
        impactedCount: 1,
        risk: 'UNKNOWN',
        partial: true,
        traversalComplete: false,
        byDepth: { 1: [{ id: 'Function:src/caller.ts:caller' }] },
        rawCounts: { total: 1, direct: 1, byDepth: { 1: 1 } },
      });
      expect(retained.rawCounts.riskReasons).toContain('traversal_partial');
      expect(retained.warnings?.join(' ')).toContain('aborted');
    }
    expect(query).toHaveBeenCalledTimes(2);
  });

  it.each(['ENOMEM', 'EMFILE', 'ENFILE'])('preserves %s lookup errors', async (code) => {
    const error = Object.assign(new Error('query unavailable'), { code });
    vi.mocked(executeParameterized).mockRejectedValue(error);
    await expect(impactByUid(repo, targetUid, 'upstream', opts)).rejects.toBe(error);
  });

  it('preserves resource errors from BFS', async () => {
    const error = new Error('Buffer pool is full and no memory could be freed');
    vi.mocked(executeParameterized)
      .mockReset()
      .mockResolvedValueOnce([
        { id: targetUid, name: 'login', type: 'Function', filePath: 'src/auth.ts' },
      ])
      .mockRejectedValue(error);
    await expect(impactByUid(repo, targetUid, 'upstream', opts)).rejects.toBe(error);
  });

  it('returns null for ordinary lookup errors', async () => {
    vi.mocked(executeParameterized).mockRejectedValue(new Error('query unavailable'));
    await expect(impactByUid(repo, targetUid, 'upstream', opts)).resolves.toBeNull();
  });

  it('returns null for a missing UID', async () => {
    vi.mocked(executeParameterized).mockResolvedValue([]);
    await expect(impactByUid(repo, targetUid, 'upstream', opts)).resolves.toBeNull();
  });
});

function mockEnrichmentFailure(context: string, error: Error): void {
  vi.mocked(executeParameterized).mockImplementation(async (_repo, query, params) => {
    if (params?.uid === targetUid) {
      return [{ id: targetUid, name: 'login', type: 'Function', filePath: 'src/auth.ts' }];
    }
    if (query.includes('frontierIds')) {
      return [
        {
          id: 'Function:src/caller.ts:caller',
          name: 'caller',
          type: 'Function',
          filePath: 'src/caller.ts',
          relType: 'CALLS',
          confidence: 0.95,
        },
      ];
    }
    let queryContext: string;
    if (query.includes('p.id AS pId')) queryContext = 'impact:process-chunk';
    else if (query.includes('p.id AS pid')) queryContext = 'impact:process-chunk-backfill';
    else if (query.includes('RETURN DISTINCT c.heuristicLabel'))
      queryContext = 'impact:direct-module-chunk';
    else if (query.includes('c.heuristicLabel AS name')) queryContext = 'impact:module-chunk';
    else return [];
    if (queryContext === context) throw error;
    if (queryContext === 'impact:process-chunk') {
      return [{ pId: 'process', entryPointId: targetUid, hits: 1, minStep: null }];
    }
    return [];
  });
}
