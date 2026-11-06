import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/core/lbug/pool-adapter.js', () => ({ executeParameterized: vi.fn() }));
vi.mock('../../src/mcp/local/backend-query.js', () => ({
  bm25Search: vi.fn(),
  semanticSearch: vi.fn(),
}));
vi.mock('../../src/core/search/symbol-merge.js', () => ({ mergeSymbolsWithRRF: vi.fn() }));
vi.mock('../../src/core/search/semantic-cache.js', () => ({
  SemanticRetrievalCache: class {
    static computeKey() {
      return 'batch-test';
    }
    async lookup() {
      return { status: 'miss' };
    }
    async set() {
      return { evicted: 0 };
    }
  },
}));
vi.mock('../../src/mcp/shared/target-context.js', () => ({
  resolveTargetContext: async () => ({ warnings: [], embeddings: { status: 'available' } }),
}));
vi.mock('../../src/mcp/shared/response-envelope.js', () => ({
  deriveEnvelopeFreshness: () => ({ status: 'unknown', actionable: false, reason: 'unit-test' }),
}));
vi.mock('../../src/mcp/local/backend-overlay.js', () => ({
  isAutomaticWorkspaceEnabled: () => false,
  getOverlaySnapshot: vi.fn(),
  getCommittedRead: vi.fn(),
}));
vi.mock('../../src/mcp/local/query-log.js', () => ({
  queryLogEnabled: () => false,
  MAX_RESULT_IDS: 10,
  MAX_QUERY_CHARS: 256,
}));
vi.mock('../../src/core/search/intent-classifier.js', () => ({
  classifyIntent: () => ({ intent: 'identifier', confidence: 0.8, matchedKeywords: [] }),
}));

import { executeParameterized } from '../../src/core/lbug/pool-adapter.js';
import { bm25Search, semanticSearch } from '../../src/mcp/local/backend-query.js';
import { mergeSymbolsWithRRF } from '../../src/core/search/symbol-merge.js';
import { query } from '../../src/mcp/local/backend-search.js';
import type { EnrichedSymbolRow } from '../../src/core/search/symbol-merge.js';

const repo = { id: 'batch-test', repoPath: '/repo', lastCommit: 'abc123' } as any;
const symbols = ['alpha', 'beta'].map((name, index) => ({
  nodeId: `Function:src/${name}.ts:${name}`,
  name,
  type: 'Function',
  filePath: `src/${name}.ts`,
  startLine: index + 1,
  endLine: index + 10,
}));
const nodeIds = symbols.map((symbol) => symbol.nodeId!);
const resourceErrors = [
  new Error('Unable to allocate memory! The buffer pool is full and no memory could be freed!'),
  Object.assign(new Error('query failed: private diagnostic'), { code: 'ENOMEM' }),
];
const options = {
  query: 'batch lookup',
  include_content: true,
  include_skeleton: false,
  include_citations: false,
  intent_ensemble: false,
};

function setResults(rows: EnrichedSymbolRow[]) {
  vi.mocked(mergeSymbolsWithRRF).mockReturnValue(
    rows.map((data, index) => [data.nodeId || data.filePath, { score: 1 - index * 0.1, data }]),
  );
}

function lookupRows(cypher: string, nodeId?: string): object[] {
  // Deliberately interleave node order and include a second first-row candidate.
  if (cypher.includes('STEP_IN_PROCESS'))
    return [
      {
        pid: 'p',
        label: 'Process',
        heuristicLabel: 'Pipeline',
        processType: 'flow',
        stepCount: 2,
        step: 2,
        nodeId: nodeIds[1],
      },
      {
        pid: 'p',
        label: 'Process',
        heuristicLabel: 'Pipeline',
        processType: 'flow',
        stepCount: 2,
        step: 1,
        nodeId: nodeIds[0],
      },
    ];
  if (cypher.includes('MEMBER_OF'))
    return [
      { cohesion: 0.5, module: 'Beta module', nodeId: nodeIds[1] },
      { cohesion: 0.2, module: 'Alpha module', nodeId: nodeIds[0] },
      { cohesion: 0.9, module: 'Ignored module', nodeId: nodeIds[0] },
    ].filter((row) => !nodeId || row.nodeId === nodeId);
  if (cypher.includes('n.content AS content'))
    return [
      { content: 'beta body', nodeId: nodeIds[1] },
      { content: 'alpha body', nodeId: nodeIds[0] },
    ];
  if (cypher.includes('callerPath'))
    return [
      { caller: 'main', type: 'CALLS', callerPath: 'src/main.ts', nodeId: nodeIds[0] },
      { caller: 'ignored', type: 'IMPORTS', callerPath: 'src/ignored.ts', nodeId: nodeIds[0] },
      { caller: 'betaMain', type: 'IMPORTS', callerPath: 'src/beta-main.ts', nodeId: nodeIds[1] },
    ].filter((row) => !nodeId || row.nodeId === nodeId);
  return [];
}

function enrichmentCalls() {
  return vi.mocked(executeParameterized).mock.calls.filter(([, , params]) => 'nodeIds' in params);
}

describe('batched search symbol lookup', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(bm25Search).mockResolvedValue({ results: [], ftsUsed: true });
    vi.mocked(semanticSearch).mockResolvedValue(symbols);
    setResults(symbols);
    vi.mocked(executeParameterized).mockImplementation(async (_repo, cypher, params) =>
      lookupRows(cypher, params.nodeId as string),
    );
  });

  it('batches all enrichment and keeps the first community and citation per node', async () => {
    const result = await query(repo, options);
    const calls = enrichmentCalls();
    expect(calls).toHaveLength(4);
    for (const kind of ['STEP_IN_PROCESS', 'MEMBER_OF', 'n.content AS content', 'callerPath']) {
      expect(calls.filter(([, cypher]) => cypher.includes(kind))).toHaveLength(1);
    }
    const citationQuery = calls.find(([, cypher]) => cypher.includes('callerPath'))![1];
    expect(citationQuery.match(/n\.id IN \$nodeIds/g)).toHaveLength(2);
    const perNodeCalls = vi
      .mocked(executeParameterized)
      .mock.calls.filter(([, , params]) => 'nodeId' in params);
    expect(perNodeCalls).toHaveLength(0);
    for (const kind of ['MEMBER_OF', 'callerPath']) {
      const reads = calls.filter(([, cypher]) => cypher.includes(kind));
      for (const [, cypher] of reads) {
        expect(cypher).toMatch(/min\(/i);
      }
    }
    for (const [id, cypher, params] of calls) {
      expect(id).toBe(repo.id);
      expect(cypher).toContain('n.id IN $nodeIds');
      expect(cypher).not.toMatch(/collect\s*\(|\bUNION\b/i);
      expect(params).toEqual({ nodeIds });
    }
    expect((result as unknown as Record<string, any>).processes).toEqual([
      {
        id: 'p',
        summary: 'Pipeline',
        priority: 1.95,
        symbol_count: 2,
        process_type: 'flow',
        step_count: 2,
      },
    ]);
    expect((result as unknown as Record<string, any>).process_symbols).toEqual(
      symbols.map((symbol, index) => ({
        id: symbol.nodeId,
        name: symbol.name,
        type: symbol.type,
        filePath: symbol.filePath,
        startLine: symbol.startLine,
        endLine: symbol.endLine,
        module: index === 0 ? 'Alpha module' : 'Beta module',
        content: `${symbol.name} body`,
        process_id: 'p',
        step_index: index + 1,
        citation_path:
          index === 0
            ? 'src/main.ts:main -> CALLS -> alpha'
            : 'src/beta-main.ts:betaMain -> IMPORTS -> beta',
      })),
    );
    expect((result as unknown as Record<string, any>).definitions).toEqual([]);
  });

  it.each(['STEP_IN_PROCESS', 'MEMBER_OF', 'n.content AS content', 'callerPath'])(
    'keeps other enrichment when the %s batch fails',
    async (failedKind) => {
      vi.mocked(executeParameterized).mockImplementation(async (_repo, cypher, params) => {
        if (cypher.includes(failedKind)) throw new Error('lookup unavailable');
        return lookupRows(cypher, params.nodeId as string);
      });
      const result = await query(repo, options);
      expect(enrichmentCalls()).toHaveLength(4);
      const output =
        failedKind === 'STEP_IN_PROCESS'
          ? (result as unknown as Record<string, any>).definitions
          : (result as unknown as Record<string, any>).process_symbols;
      expect(output).toHaveLength(2);
      const first = output![0];
      expect(first).toMatchObject({ id: nodeIds[0], name: 'alpha' });
      if (failedKind === 'MEMBER_OF') expect(first).not.toHaveProperty('module');
      else expect(first).toHaveProperty('module', 'Alpha module');
      if (failedKind === 'n.content AS content') expect(first).not.toHaveProperty('content');
      else expect(first).toHaveProperty('content', 'alpha body');
      if (failedKind === 'callerPath') expect(first).not.toHaveProperty('citation_path');
      else expect(first).toHaveProperty('citation_path', 'src/main.ts:main -> CALLS -> alpha');
    },
  );

  it.each(['MEMBER_OF', 'callerPath'])(
    'isolates an alpha %s failure from beta',
    async (failedKind) => {
      vi.mocked(executeParameterized).mockImplementation(async (_repo, cypher, params) => {
        if (cypher.includes(failedKind) && ('nodeIds' in params || params.nodeId === nodeIds[0])) {
          throw new Error('alpha unavailable');
        }
        return lookupRows(cypher, params.nodeId as string);
      });
      const result = await query(repo, options);
      expect((result as unknown as Record<string, any>).process_symbols![0]).not.toHaveProperty(
        failedKind === 'MEMBER_OF' ? 'module' : 'citation_path',
      );
      expect((result as unknown as Record<string, any>).process_symbols![1]).toMatchObject({
        id: nodeIds[1],
        module: 'Beta module',
        content: 'beta body',
        citation_path: 'src/beta-main.ts:betaMain -> IMPORTS -> beta',
      });
      expect(enrichmentCalls()).toHaveLength(4);
      const fallbackCalls = vi
        .mocked(executeParameterized)
        .mock.calls.filter(([, , params]) => 'nodeId' in params);
      expect(fallbackCalls.map(([, , params]) => params)).toEqual(
        nodeIds.map((nodeId) => ({ nodeId })),
      );
      for (const [, cypher] of fallbackCalls) expect(cypher).toContain('LIMIT 1');
    },
  );

  it('skips content when disabled and excludes overlay and missing ids from all batches', async () => {
    setResults([
      ...symbols,
      { ...symbols[0], nodeId: 'overlay-id', source: 'overlay' } as EnrichedSymbolRow,
      { ...symbols[0], nodeId: '', name: 'file', type: 'File' },
    ]);
    const result = await query(repo, { ...options, include_content: false });
    expect(enrichmentCalls()).toHaveLength(3);
    for (const [, , params] of enrichmentCalls()) expect(params).toEqual({ nodeIds });
    const perNodeCalls = vi
      .mocked(executeParameterized)
      .mock.calls.filter(([, , params]) => 'nodeId' in params);
    expect(perNodeCalls).toHaveLength(0);
    expect((result as unknown as Record<string, any>).process_symbols![0]).not.toHaveProperty(
      'content',
    );
    expect((result as unknown as Record<string, any>).definitions).toEqual([
      {
        id: 'overlay-id',
        name: 'alpha',
        type: 'Function',
        filePath: 'src/alpha.ts',
        startLine: 1,
        endLine: 10,
        source: 'overlay',
      },
      { name: 'file', type: 'File', filePath: 'src/alpha.ts' },
    ]);
  });

  it.each(['QueryTimeoutError', 'CheckoutTimeoutError'])(
    'does not amplify %s enrichment batches into per-node retries',
    async (name) => {
      vi.mocked(executeParameterized).mockImplementation(async (_repo, cypher, params) => {
        if (cypher.includes('MEMBER_OF') || cypher.includes('callerPath')) {
          throw Object.assign(new Error('Lookup timed out'), { name });
        }
        return lookupRows(cypher, params.nodeId as string);
      });
      const result = await query(repo, options);
      expect((result as unknown as Record<string, any>).process_symbols).toHaveLength(
        symbols.length,
      );
      expect((result as unknown as Record<string, any>).process_symbols![0]).toMatchObject({
        id: nodeIds[0],
        content: 'alpha body',
      });
      expect(enrichmentCalls()).toHaveLength(4);
      expect(
        vi.mocked(executeParameterized).mock.calls.filter(([, , params]) => 'nodeId' in params),
      ).toHaveLength(0);
    },
  );

  it.each(resourceErrors)('does not retry resource-exhausted batches: %s', async (error) => {
    vi.mocked(executeParameterized).mockImplementation(async (_repo, cypher, params) => {
      if (cypher.includes('MEMBER_OF') || cypher.includes('callerPath')) throw error;
      return lookupRows(cypher, params.nodeId as string);
    });

    const result = (await query(repo, options)) as Record<string, any>;

    expect(result.process_symbols).toHaveLength(symbols.length);
    expect(enrichmentCalls()).toHaveLength(4);
    expect(
      vi.mocked(executeParameterized).mock.calls.filter(([, , params]) => 'nodeId' in params),
    ).toHaveLength(0);
    expect(result.warning).toContain('Community enrichment unavailable');
    expect(result.warning).toContain('Citation enrichment unavailable');
    expect(result.warning).not.toContain(error.message);
  });

  it.each(['MEMBER_OF', 'callerPath'])(
    'stops %s compatibility fallback at resource exhaustion',
    async (failedKind) => {
      vi.mocked(executeParameterized).mockImplementation(async (_repo, cypher, params) => {
        if (cypher.includes(failedKind)) {
          if ('nodeIds' in params) throw new Error('unsupported batch');
          throw resourceErrors[0];
        }
        return lookupRows(cypher, params.nodeId as string);
      });

      const result = (await query(repo, options)) as Record<string, any>;

      expect(result.process_symbols).toHaveLength(symbols.length);
      const retries = vi
        .mocked(executeParameterized)
        .mock.calls.filter(([, , params]) => 'nodeId' in params);
      expect(retries.map(([, , params]) => params)).toEqual([{ nodeId: nodeIds[0] }]);
      expect(result.warning).toContain('enrichment unavailable');
    },
  );

  it.each([
    ['STEP_IN_PROCESS', 'Process'],
    ['MEMBER_OF', 'Community'],
    ['n.content AS content', 'Content'],
    ['callerPath', 'Citation'],
  ])('reports bounded %s failures through all warning channels', async (kind, label) => {
    vi.mocked(executeParameterized).mockImplementation(async (_repo, cypher, params) => {
      if (cypher.includes(kind)) throw resourceErrors[0];
      return lookupRows(cypher, params.nodeId as string);
    });

    const result = (await query(repo, {
      ...options,
      structured_output: true,
      retrieval_diagnostics: true,
    })) as Record<string, any>;
    const warning = `${label} enrichment unavailable; search results may be partial.`;

    expect([...result.process_symbols, ...result.definitions]).toHaveLength(symbols.length);
    expect(result.warning).toBe(warning);
    expect(
      result.structured_retrieval.capabilityState.warnings.filter(
        (message: string) => message === warning,
      ),
    ).toEqual([warning]);
    expect(
      result.retrieval_diagnostics.warnings.filter((message: string) => message === warning),
    ).toEqual([warning]);
    expect(result.warning).not.toContain(resourceErrors[0].message);
  });

  it.each([
    ['MEMBER_OF', 'QueryTimeoutError'],
    ['MEMBER_OF', 'CheckoutTimeoutError'],
    ['callerPath', 'QueryTimeoutError'],
    ['callerPath', 'CheckoutTimeoutError'],
  ])('stops %s fallback after a per-node %s', async (failedKind, name) => {
    vi.mocked(executeParameterized).mockImplementation(async (_repo, cypher, params) => {
      if (cypher.includes(failedKind)) {
        if ('nodeIds' in params) throw new Error('batch unavailable');
        throw Object.assign(new Error('Lookup timed out'), { name });
      }
      return lookupRows(cypher, params.nodeId as string);
    });
    const result = await query(repo, options);
    expect((result as unknown as Record<string, any>).process_symbols).toHaveLength(symbols.length);
    expect((result as unknown as Record<string, any>).process_symbols![1]).toMatchObject({
      id: nodeIds[1],
      content: 'beta body',
    });
    const retries = vi
      .mocked(executeParameterized)
      .mock.calls.filter(([, , params]) => 'nodeId' in params);
    expect(retries.map(([, , params]) => params)).toEqual([{ nodeId: nodeIds[0] }]);
  });

  it('does not query enrichment for an empty result set', async () => {
    setResults([]);
    const result = await query(repo, options);
    expect(enrichmentCalls()).toEqual([]);
    expect(executeParameterized).not.toHaveBeenCalled();
    expect((result as unknown as Record<string, any>).definitions).toEqual([]);
  });

  it('accepts empty first-enrichment batches without falling back', async () => {
    vi.mocked(executeParameterized).mockImplementation(async (_repo, cypher) =>
      cypher.includes('MEMBER_OF') || cypher.includes('callerPath') ? [] : lookupRows(cypher),
    );
    const result = await query(repo, options);
    expect(executeParameterized).toHaveBeenCalledTimes(4);
    expect(enrichmentCalls()).toHaveLength(4);
    expect((result as unknown as Record<string, any>).process_symbols).toHaveLength(symbols.length);
    for (const symbol of (result as unknown as Record<string, any>).process_symbols!) {
      expect(symbol).not.toHaveProperty('module');
      expect(symbol).not.toHaveProperty('citation_path');
      expect(symbol).toHaveProperty('content');
    }
  });

  it('deduplicates candidate ids before every enrichment batch', async () => {
    setResults([...symbols, { ...symbols[0], name: 'alpha duplicate' }]);
    await query(repo, options);
    expect(executeParameterized).toHaveBeenCalledTimes(4);
    for (const [, , params] of enrichmentCalls()) expect(params).toEqual({ nodeIds });
  });

  it('enriches all candidate ids when more than fifty are returned', async () => {
    const candidates = Array.from({ length: 61 }, (_, index) => ({
      ...symbols[0],
      nodeId: `Function:src/item${index}.ts:item${index}`,
      name: `item${index}`,
    }));
    setResults(candidates);
    vi.mocked(executeParameterized).mockImplementation(async (_repo, cypher, params) => {
      if (cypher.includes('MEMBER_OF')) {
        return (params.nodeIds as string[]).map((nodeId) => ({
          nodeId,
          cohesion: 0.5,
          module: nodeId,
        }));
      }
      return [];
    });
    const result = await query(repo, { ...options, limit: 100 });
    expect(executeParameterized).toHaveBeenCalledTimes(4);
    for (const [, , params] of enrichmentCalls()) {
      expect(params).toEqual({ nodeIds: candidates.map((candidate) => candidate.nodeId) });
    }
    expect((result as unknown as Record<string, any>).definitions).toHaveLength(20);
    expect((result as unknown as Record<string, any>).definitions![0]).toMatchObject({
      id: candidates[0].nodeId,
      module: candidates[0].nodeId,
    });
  });

  it.each(['caller', 'type', 'callerPath'])(
    'omits citation_path when the citation %s is null',
    async (field) => {
      vi.mocked(executeParameterized).mockImplementation(async (_repo, cypher) => {
        if (cypher.includes('callerPath')) {
          return [
            {
              caller: 'main',
              type: 'CALLS',
              callerPath: 'src/main.ts',
              nodeId: nodeIds[0],
              [field]: null,
            },
          ];
        }
        return lookupRows(cypher);
      });
      const result = await query(repo, options);
      expect((result as unknown as Record<string, any>).process_symbols![0]).not.toHaveProperty(
        'citation_path',
      );
      expect(enrichmentCalls()).toHaveLength(4);
    },
  );

  it('preserves tuple field offsets for process, community, content and citation rows', async () => {
    vi.mocked(executeParameterized).mockImplementation(async (_repo, cypher) => {
      if (cypher.includes('STEP_IN_PROCESS'))
        return [['p', 'Process', 'Pipeline', 'flow', 2, 1, nodeIds[0]]];
      if (cypher.includes('MEMBER_OF')) return [[0.2, 'Alpha module', nodeIds[0]]];
      if (cypher.includes('n.content AS content')) return [['alpha body', nodeIds[0]]];
      if (cypher.includes('callerPath')) return [['main', 'CALLS', 'src/main.ts', nodeIds[0]]];
      return [];
    });
    const result = await query(repo, options);
    expect((result as unknown as Record<string, any>).process_symbols![0]).toMatchObject({
      id: nodeIds[0],
      module: 'Alpha module',
      content: 'alpha body',
      step_index: 1,
      process_id: 'p',
      citation_path: 'src/main.ts:main -> CALLS -> alpha',
    });
    expect((result as unknown as Record<string, any>).definitions![0]).toMatchObject({
      id: nodeIds[1],
      name: 'beta',
    });
  });
});
