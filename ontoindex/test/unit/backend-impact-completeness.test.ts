import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/core/lbug/pool-adapter.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/core/lbug/pool-adapter.js')>()),
  executeParameterized: vi.fn(),
}));

import { executeParameterized } from '../../src/core/lbug/pool-adapter.js';
import { impactResultCompleteness, runImpact } from '../../src/mcp/local/backend-impact.js';

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
