import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { executeParameterized, isLbugReady } = vi.hoisted(() => ({
  executeParameterized: vi.fn(),
  isLbugReady: vi.fn(() => true),
}));

vi.mock('../../src/core/lbug/pool-adapter.js', () => ({
  executeParameterized,
  isLbugReady,
}));

import { runCouplingMatrix } from '../../src/mcp/local/backend-coupling-matrix.js';
import { runBoundaryViolations } from '../../src/mcp/local/backend-boundary-violations.js';

describe('backend coupling/boundary tools', () => {
  afterEach(() => vi.unstubAllEnvs());
  beforeEach(() => {
    executeParameterized.mockReset();
    isLbugReady.mockReset();
    isLbugReady.mockReturnValue(true);
  });

  it('coupling_matrix computes Ca/Ce/instability across communities', async () => {
    executeParameterized
      .mockResolvedValueOnce([
        { id: 'comm:browser', heuristicLabel: 'Browser', symbolCount: 10 },
        { id: 'comm:protocol', heuristicLabel: 'Protocol', symbolCount: 8 },
        { id: 'comm:data', heuristicLabel: 'Data', symbolCount: 7 },
      ])
      .mockResolvedValueOnce([
        {
          sourceCommunityId: 'comm:browser',
          sourceCommunity: 'Browser',
          sourceSymbolId: 'func:renderView',
          targetCommunityId: 'comm:protocol',
          targetCommunity: 'Protocol',
          targetSymbolId: 'func:callProtocol',
          edgeType: 'CALLS',
        },
        {
          sourceCommunityId: 'comm:protocol',
          sourceCommunity: 'Protocol',
          sourceSymbolId: 'func:callProtocol',
          targetCommunityId: 'comm:data',
          targetCommunity: 'Data',
          targetSymbolId: 'func:loadStore',
          edgeType: 'IMPORTS',
        },
      ]);

    const result = await runCouplingMatrix(
      { id: 'repo', name: 'test-repo' },
      { min_symbols: 1, include_cross_edges: true },
    );

    expect(result.status).toBe('success');
    expect(result.warnings).toEqual([]);
    expect(result.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ community: 'Browser', ca: 0, ce: 1, instability: 1 }),
        expect.objectContaining({ community: 'Protocol', ca: 1, ce: 1, instability: 0.5 }),
        expect.objectContaining({ community: 'Data', ca: 1, ce: 0, instability: 0 }),
      ]),
    );
  });

  it.each([undefined, 'invalid', '500000', '1000'])(
    'keeps the coupling limit below the adapter guard for override %s',
    async (override) => {
      vi.stubEnv('ONTOINDEX_COUPLING_MATRIX_MAX_EDGES', override);
      vi.resetModules();
      const { runCouplingMatrix: boundedMatrix } =
        await import('../../src/mcp/local/backend-coupling-matrix.js');
      const cap = override === '1000' ? 1000 : 49_999;
      executeParameterized.mockImplementation(async (_repo, query: string) => {
        if (!query.includes('LIMIT'))
          return [
            { id: 'a', symbolCount: 5 },
            { id: 'b', symbolCount: 5 },
          ];
        const limit = Number(query.match(/LIMIT\s+(\d+)/)?.[1]);
        expect(limit).toBe(cap);
        // Match the real pool adapter's exclusive safety boundary.
        if (limit >= 50_000) throw new Error('row safety limit');
        return Array.from({ length: limit }, () => ({
          sourceCommunityId: 'a',
          targetCommunityId: 'b',
          edgeType: 'CALLS',
        }));
      });
      const result = await boundedMatrix(
        { id: 'repo', name: 'test-repo' },
        { include_cross_edges: true },
      );
      expect(result.status).toBe('success');
      expect(result.warnings).toEqual([
        `Coupling edge scan reached ${cap} relationships; metrics may be incomplete`,
      ]);
      expect(result.rows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ community_id: 'a', ca: 0, ce: 1 }),
          expect.objectContaining({ community_id: 'b', ca: 1, ce: 0 }),
        ]),
      );
      expect(
        result.rows.find((row: { community_id: string }) => row.community_id === 'a').cross_edges,
      ).toHaveLength(5);
    },
  );

  it('preserves adapter failures as invocation errors', async () => {
    executeParameterized.mockRejectedValue(new Error('row safety limit'));
    const result = await runCouplingMatrix({ id: 'repo', name: 'test-repo' }, {});
    expect(result).toMatchObject({
      status: 'error',
      rows: [],
      error: expect.stringContaining('row safety limit'),
    });
  });

  it('boundary_violations finds offending edges for matching rules', async () => {
    executeParameterized.mockResolvedValueOnce([
      {
        sourceId: 'file:browser/index.ts',
        sourceName: 'index.ts',
        sourceFilePath: 'browser/index.ts',
        targetId: 'file:wsd/client.ts',
        targetName: 'client.ts',
        targetFilePath: 'wsd/client.ts',
        edgeType: 'IMPORTS',
      },
      {
        sourceId: 'file:common/index.ts',
        sourceName: 'index.ts',
        sourceFilePath: 'common/index.ts',
        targetId: 'file:protocol/client.ts',
        targetName: 'client.ts',
        targetFilePath: 'protocol/client.ts',
        edgeType: 'IMPORTS',
      },
    ]);

    const result = await runBoundaryViolations(
      { id: 'repo', name: 'test-repo', repoPath: '/tmp/test-repo' },
      {
        rules: [
          { from: 'browser/**', to: 'wsd/**', label: 'browser -> wsd' },
          { from: 'common/**', to: 'browser/**', label: 'common -> browser' },
        ],
      },
    );

    expect(result.status).toBe('success');
    expect(result.summary.rules_checked).toBe(2);
    expect(result.summary.rules_violated).toBe(1);
    expect(result.clean_rules).toEqual(['common -> browser']);
    expect(result.violations[0]).toMatchObject({
      rule_label: 'browser -> wsd',
      source_file: 'browser/index.ts',
      target_file: 'wsd/client.ts',
      edge_type: 'IMPORTS',
    });
  });
});
