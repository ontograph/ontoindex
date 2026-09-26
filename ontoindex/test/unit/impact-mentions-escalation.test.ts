import { describe, it, expect, vi } from 'vitest';
import { runImpactBFS } from '../../src/mcp/local/backend-impact.js';
import * as poolAdapter from '../../src/core/lbug/pool-adapter.js';

vi.mock('../../src/core/lbug/pool-adapter.js', () => ({
  executeQuery: vi.fn(),
  executeParameterized: vi.fn().mockResolvedValue([]),
  isLbugReady: vi.fn().mockReturnValue(true),
  isWriteQuery: vi.fn().mockReturnValue(false),
}));

describe('Impact MENTIONS Escalation', () => {
  it('ignores low-confidence MENTIONS edges when building the next frontier', async () => {
    const mockRepo = { id: 'test-repo' } as any;

    // Depth traversal binds frontier ids as a parameter, so it runs through
    // executeParameterized. The first call returns the depth-1 related nodes.
    const mockExecuteParameterized = vi.mocked(poolAdapter.executeParameterized);
    mockExecuteParameterized.mockReset();
    mockExecuteParameterized.mockResolvedValueOnce([
      {
        id: 'func:safe',
        name: 'safeFunc',
        type: 'Function',
        filePath: 'src/safe.ts',
        relType: 'CALLS',
        confidence: 1.0,
      },
      {
        id: 'func:mentioned',
        name: 'mentionedFunc',
        type: 'Function',
        filePath: 'src/mentioned.ts',
        relType: 'MENTIONS',
        confidence: 0.4, // Below the 0.5 threshold
      },
      {
        id: 'func:strong_mention',
        name: 'strongMentionFunc',
        type: 'Function',
        filePath: 'src/strong.ts',
        relType: 'MENTIONS',
        confidence: 0.9, // Above the threshold
      },
    ]);

    // Return empty for subsequent depth queries
    mockExecuteParameterized.mockResolvedValue([]);

    const sym = {
      id: 'target:symbol',
      name: 'targetSymbol',
      type: 'Function',
      filePath: 'src/target.ts',
    };

    const result = await runImpactBFS(mockRepo, sym, 'Function', 'upstream', {
      maxDepth: 1,
      relationTypes: ['CALLS', 'MENTIONS'],
      minConfidence: 0,
      includeTests: false,
    });

    // Check that 'func:mentioned' was filtered out, while the others were included
    const d1 = result.byDepth[1] || [];
    expect(d1.find((n: any) => n.id === 'func:safe')).toBeDefined();
    expect(d1.find((n: any) => n.id === 'func:strong_mention')).toBeDefined();
    expect(d1.find((n: any) => n.id === 'func:mentioned')).toBeUndefined();
  });

  it('stops processing depth results when the abort signal fires after a query returns', async () => {
    const mockRepo = { id: 'test-repo' } as any;
    const controller = new AbortController();

    const mockExecuteParameterized = vi.mocked(poolAdapter.executeParameterized);
    mockExecuteParameterized.mockReset();
    mockExecuteParameterized.mockImplementationOnce(async () => {
      controller.abort('timeout');
      return [
        {
          id: 'func:late',
          name: 'lateFunc',
          type: 'Function',
          filePath: 'src/late.ts',
          relType: 'CALLS',
          confidence: 1.0,
        },
      ];
    });
    mockExecuteParameterized.mockResolvedValue([]);

    await expect(
      runImpactBFS(
        mockRepo,
        {
          id: 'target:symbol',
          name: 'targetSymbol',
          type: 'Function',
          filePath: 'src/target.ts',
        },
        'Function',
        'upstream',
        {
          maxDepth: 1,
          relationTypes: ['CALLS'],
          minConfidence: 0,
          includeTests: false,
          signal: controller.signal,
        },
      ),
    ).rejects.toThrow('Impact analysis aborted: timeout');
  });

  it('binds frontier ids as a parameter instead of splicing them into Cypher', async () => {
    const mockExecuteParameterized = vi.mocked(poolAdapter.executeParameterized);
    mockExecuteParameterized.mockReset();
    mockExecuteParameterized.mockResolvedValue([]);
    const hostileId = "File:docs/install.md'] DETACH DELETE n //";

    await runImpactBFS(
      { id: 'test-repo' } as any,
      { id: hostileId, name: 'install.md', type: 'File', filePath: 'docs/install.md' },
      'File',
      'upstream',
      { maxDepth: 1, relationTypes: ['CALLS'], minConfidence: 0, includeTests: false },
    );

    const traversal = mockExecuteParameterized.mock.calls.find(([, cypher]) =>
      String(cypher).includes('$frontierIds'),
    );
    expect(traversal).toBeDefined();
    expect(String(traversal?.[1])).not.toContain(hostileId);
    expect(traversal?.[2]).toEqual({ frontierIds: [hostileId] });
  });

  it('reports UNKNOWN risk when a depth query fails instead of LOW', async () => {
    const mockExecuteParameterized = vi.mocked(poolAdapter.executeParameterized);
    mockExecuteParameterized.mockReset();
    mockExecuteParameterized.mockRejectedValueOnce(new Error('query failed'));
    mockExecuteParameterized.mockResolvedValue([]);

    const result = (await runImpactBFS(
      { id: 'test-repo' } as any,
      { id: 'target:symbol', name: 'targetSymbol', type: 'Function', filePath: 'src/target.ts' },
      'Function',
      'upstream',
      { maxDepth: 2, relationTypes: ['CALLS'], minConfidence: 0, includeTests: false },
    )) as any;

    expect(result.risk).toBe('UNKNOWN');
    expect(result.partial).toBe(true);
    expect(result.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining('depth traversal failed')]),
    );
  });
});
