import { describe, it, expect, vi, beforeEach } from 'vitest';

const { lbugMocks, resolveMocks } = vi.hoisted(() => ({
  lbugMocks: {
    executeParameterized: vi.fn(),
  },
  resolveMocks: {
    resolveSymbolCandidates: vi.fn(),
  },
}));

vi.mock('../../src/core/lbug/pool-adapter.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, ...lbugMocks };
});

vi.mock('../../src/mcp/local/backend-symbol-resolution.js', () => resolveMocks);

describe('backend context bounds', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveMocks.resolveSymbolCandidates.mockResolvedValue({
      kind: 'ok',
      resolvedLabel: 'Function',
      symbol: {
        id: 'sym-1',
        name: 'login',
        type: 'Function',
        filePath: 'src/auth.ts',
        startLine: 1,
        endLine: 5,
      },
    });
    lbugMocks.executeParameterized.mockResolvedValue([]);
  });

  it('caps process participation rows for hot symbols', async () => {
    const { context } = await import('../../src/mcp/local/backend-context.js');
    await context({ id: 'repo' }, { name: 'login' });

    const processQuery = lbugMocks.executeParameterized.mock.calls
      .map((call) => String(call[1]))
      .find((query) => query.includes('STEP_IN_PROCESS'));

    expect(processQuery).toContain('ORDER BY p.stepCount DESC');
    expect(processQuery).toContain('LIMIT 50');
  });
});
