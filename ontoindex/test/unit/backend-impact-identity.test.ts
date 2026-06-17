import { describe, it, expect, vi, beforeEach } from 'vitest';

const { lbugMocks, resolveMocks } = vi.hoisted(() => ({
  lbugMocks: {
    executeParameterized: vi.fn(),
    executeQuery: vi.fn(),
  },
  resolveMocks: {
    resolveSymbolCandidates: vi.fn(),
  },
}));

vi.mock('../../src/core/lbug/pool-adapter.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, ...lbugMocks };
});

vi.mock('../../src/mcp/local/backend-symbol-resolution.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, ...resolveMocks };
});

describe('backend impact identity ergonomics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    lbugMocks.executeParameterized.mockResolvedValue([]);
    lbugMocks.executeQuery.mockResolvedValue([]);
  });

  it('accepts nodeId as a target_uid alias', async () => {
    resolveMocks.resolveSymbolCandidates.mockResolvedValue({
      kind: 'ok',
      resolvedLabel: 'Function',
      symbol: {
        id: 'Function:src/auth.ts:login',
        name: 'login',
        type: 'Function',
        filePath: 'src/auth.ts',
        startLine: 10,
        endLine: 20,
      },
    });

    const { runImpact } = await import('../../src/mcp/local/backend-impact.js');
    const result = await runImpact(
      { id: 'repo', name: 'repo' },
      {
        target: 'login',
        nodeId: 'Function:src/auth.ts:login',
        direction: 'upstream',
      },
    );

    expect(resolveMocks.resolveSymbolCandidates).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ uid: 'Function:src/auth.ts:login', name: 'login' }),
      expect.anything(),
    );
    expect(result).toMatchObject({
      target: {
        id: 'Function:src/auth.ts:login',
        name: 'login',
        type: 'Function',
        filePath: 'src/auth.ts',
      },
    });
  });

  it('normalizes ambiguous candidates with nodeId and retry calls', async () => {
    resolveMocks.resolveSymbolCandidates.mockResolvedValue({
      kind: 'ambiguous',
      candidates: [
        {
          id: 'Function:src/auth.ts:login',
          name: 'login',
          type: 'Function',
          filePath: 'src/auth.ts',
          startLine: 10,
          endLine: 20,
          score: 0.91,
        },
      ],
    });

    const { runImpact } = await import('../../src/mcp/local/backend-impact.js');
    const result = await runImpact(
      { id: 'repo', name: 'repo' },
      {
        target: 'login',
        direction: 'upstream',
      },
    );

    expect(result).toMatchObject({
      status: 'ambiguous',
      candidates: [
        {
          nodeId: 'Function:src/auth.ts:login',
          uid: 'Function:src/auth.ts:login',
          displayName: 'login',
          name: 'login',
          kind: 'Function',
          suggestedNextCalls: expect.arrayContaining([
            'impact({ action: "symbol", repo: "repo", target_uid: "Function:src/auth.ts:login", target: "login" })',
          ]),
        },
      ],
    });
  });
});
