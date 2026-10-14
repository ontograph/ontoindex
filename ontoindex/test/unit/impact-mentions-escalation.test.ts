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

    // Depth traversal binds frontier ids through executeParameterized.
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

    // Return empty for subsequent depth queries and enrichment queries.
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
});
