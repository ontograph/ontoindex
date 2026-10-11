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

vi.mock('../../src/mcp/local/backend-symbol-resolution.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, ...resolveMocks };
});

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
    expect(processQuery).toContain('LIMIT 51');
  });

  it('marks omitted rows from incoming, outgoing, process, and concept limits', async () => {
    lbugMocks.executeParameterized.mockImplementation(async (_repo: string, query: string) => {
      if (query.includes('STEP_IN_PROCESS'))
        return Array.from({ length: 51 }, (_, i) => ({ pid: `p${i}` }));
      if (query.includes('EXPLAINED_BY'))
        return Array.from({ length: 11 }, (_, i) => ({ id: `c${i}` }));
      if (query.includes('MATCH (caller)-[r:CodeRelation]->(n'))
        return Array.from({ length: 31 }, (_, i) => ({ relType: 'CALLS', uid: `in${i}` }));
      if (query.includes('MATCH (n {id: $symId})-[r:CodeRelation]->(target)'))
        return Array.from({ length: 31 }, (_, i) => ({ relType: 'CALLS', uid: `out${i}` }));
      return [];
    });

    const { context } = await import('../../src/mcp/local/backend-context.js');
    const result = (await context({ id: 'repo' }, { name: 'login' })) as any;

    expect(result.contextCompleteness.truncated).toBe(true);
    expect(Object.values(result.incoming).flat()).toHaveLength(30);
    expect(Object.values(result.outgoing).flat()).toHaveLength(30);
    expect(result.processes).toHaveLength(50);
    expect(result.concepts).toHaveLength(10);
  });

  it('does not mark exact evidence caps as truncated', async () => {
    lbugMocks.executeParameterized.mockImplementation(async (_repo: string, query: string) => {
      if (query.includes('STEP_IN_PROCESS'))
        return Array.from({ length: 50 }, (_, i) => ({ pid: `p${i}` }));
      if (query.includes('EXPLAINED_BY'))
        return Array.from({ length: 10 }, (_, i) => ({ id: `c${i}` }));
      if (query.includes('MATCH (caller)-[r:CodeRelation]->(n'))
        return Array.from({ length: 30 }, (_, i) => ({ relType: 'CALLS', uid: `in${i}` }));
      if (query.includes('MATCH (n {id: $symId})-[r:CodeRelation]->(target)'))
        return Array.from({ length: 30 }, (_, i) => ({ relType: 'CALLS', uid: `out${i}` }));
      return [];
    });

    const { context } = await import('../../src/mcp/local/backend-context.js');
    const result = (await context({ id: 'repo' }, { name: 'login' })) as any;

    expect(result.contextCompleteness.truncated).toBe(false);
  });

  it('marks class incoming expansion truncation across constructor and file queries', async () => {
    resolveMocks.resolveSymbolCandidates.mockResolvedValue({
      kind: 'ok',
      resolvedLabel: 'Class',
      symbol: {
        id: 'class-1',
        name: 'User',
        type: 'Class',
        filePath: 'src/user.ts',
        startLine: 1,
        endLine: 5,
      },
    });
    lbugMocks.executeParameterized.mockImplementation(async (_repo: string, query: string) => {
      if (query.includes('MATCH (caller)-[r:CodeRelation]->(n')) return [];
      if (query.includes('MATCH (n)-[hm:CodeRelation]->(ctor:Constructor)'))
        return Array.from({ length: 31 }, (_, i) => ({ relType: 'CALLS', uid: `ctor${i}` }));
      if (query.includes('MATCH (f:File)-[rel:CodeRelation]->(n)'))
        return Array.from({ length: 31 }, (_, i) => ({ relType: 'IMPORTS', uid: `file${i}` }));
      return [];
    });

    const { context } = await import('../../src/mcp/local/backend-context.js');
    const result = (await context({ id: 'repo' }, { name: 'User' })) as any;

    expect(result.contextCompleteness.truncated).toBe(true);
    expect(Object.values(result.incoming).flat()).toHaveLength(60);
  });

  it('keeps successful class expansion evidence when its sibling query fails', async () => {
    resolveMocks.resolveSymbolCandidates.mockResolvedValue({
      kind: 'ok',
      resolvedLabel: 'Class',
      symbol: {
        id: 'class-1',
        name: 'User',
        type: 'Class',
        filePath: 'src/user.ts',
        startLine: 1,
        endLine: 5,
      },
    });
    lbugMocks.executeParameterized.mockImplementation(async (_repo: string, query: string) => {
      if (query.includes('MATCH (caller)-[r:CodeRelation]->(n')) return [];
      if (query.includes('MATCH (n)-[hm:CodeRelation]->(ctor:Constructor)'))
        throw new Error('constructor evidence unavailable');
      if (query.includes('MATCH (f:File)-[rel:CodeRelation]->(n)'))
        return [{ relType: 'IMPORTS', uid: 'file-1' }];
      return [];
    });

    const { context } = await import('../../src/mcp/local/backend-context.js');
    const result = (await context({ id: 'repo' }, { name: 'User' })) as any;

    expect(result.incoming.imports).toHaveLength(1);
    expect(result.contextCompleteness).toMatchObject({
      truncated: false,
      missingReasons: expect.arrayContaining(['class-incoming-constructor-query-failed']),
    });
  });

  it('reports optional evidence query failures without marking results truncated', async () => {
    lbugMocks.executeParameterized.mockImplementation(async (_repo: string, query: string) => {
      if (query.includes('STEP_IN_PROCESS')) throw new Error('process unavailable');
      if (query.includes('EXPLAINED_BY')) throw new Error('concept unavailable');
      if (query.includes('RETURN n.visibility')) throw new Error('metadata unavailable');
      return [];
    });

    const { context } = await import('../../src/mcp/local/backend-context.js');
    const result = (await context({ id: 'repo' }, { name: 'login' })) as any;

    expect(result.contextCompleteness).toMatchObject({
      truncated: false,
      missingReasons: expect.arrayContaining([
        'source-not-requested',
        'process-participation-query-failed',
        'concept-lookup-query-failed',
        'method-metadata-query-failed',
      ]),
    });
  });

  it('adds context completeness when source was not requested', async () => {
    const { context } = await import('../../src/mcp/local/backend-context.js');
    const result = await context({ id: 'repo' }, { name: 'login' });

    expect(result).toMatchObject({
      status: 'found',
      contextCompleteness: {
        sourceIncluded: false,
        truncated: false,
        missingReasons: ['source-not-requested'],
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

    const { context } = await import('../../src/mcp/local/backend-context.js');
    const result = await context({ id: 'repo' }, { name: 'login' });

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
            'inspect({ action: "context", repo: "repo", uid: "Function:src/auth.ts:login" })',
          ]),
        },
      ],
      contextCompleteness: {
        sourceIncluded: false,
        truncated: false,
        missingReasons: ['ambiguous-symbol'],
      },
    });
  });
});
