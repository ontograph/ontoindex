import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/core/lbug/pool-adapter.js', () => ({
  executeParameterized: vi.fn(),
}));

vi.mock('../../src/mcp/local/backend-query.js', () => ({
  bm25Search: vi.fn(),
  semanticSearch: vi.fn(),
}));

vi.mock('../../src/core/search/symbol-merge.js', () => ({
  mergeSymbolsWithRRF: vi.fn(),
}));

vi.mock('../../src/core/search/per-intent-ensemble.js', () => ({
  MIN_VEC_POOL_SIZE: 5,
  applyEnsemble: vi.fn(),
}));

vi.mock('../../src/core/search/graph-traversal-rank.js', () => ({
  graphTraversalRank: vi.fn(),
}));

vi.mock('../../src/mcp/local/query-log.js', () => ({
  appendQueryLog: vi.fn(),
}));

vi.mock('../../src/core/search/skeleton.js', () => ({
  getFileSkeleton: vi.fn(),
}));

vi.mock('../../src/core/search/intent-classifier.js', () => ({
  classifyIntent: vi.fn(),
}));

vi.mock('../../src/core/search/graph-path.js', () => ({
  computeGraphPath: vi.fn(),
}));

vi.mock('../../src/core/lsp/bridge.js', () => ({
  lspBridge: {
    resolveSymbol: vi.fn(),
  },
}));

vi.mock('../../src/mcp/shared/target-context.js', () => ({
  resolveTargetContext: vi.fn(),
}));

vi.mock('../../src/core/embeddings/ann-neighbor-store.js', () => ({
  adaptAnnNeighborEdgesForFrontier: vi.fn((edges) => edges),
  loadAnnNeighborEdges: vi.fn(),
}));

vi.mock('../../src/mcp/core/embedder.js', () => ({
  embedQuery: vi.fn(),
  isEmbedderReady: vi.fn(),
}));

import { executeParameterized } from '../../src/core/lbug/pool-adapter.js';
import { bm25Search, semanticSearch } from '../../src/mcp/local/backend-query.js';
import { mergeSymbolsWithRRF, type EnrichedSymbolRow } from '../../src/core/search/symbol-merge.js';
import { applyEnsemble } from '../../src/core/search/per-intent-ensemble.js';
import { graphTraversalRank } from '../../src/core/search/graph-traversal-rank.js';
import { getFileSkeleton } from '../../src/core/search/skeleton.js';
import { appendQueryLog } from '../../src/mcp/local/query-log.js';
import { resolveTargetContext } from '../../src/mcp/shared/target-context.js';
import { query } from '../../src/mcp/local/backend-search.js';
import { embedQuery, isEmbedderReady } from '../../src/mcp/core/embedder.js';
import { loadAnnNeighborEdges, adaptAnnNeighborEdgesForFrontier } from '../../src/core/embeddings/ann-neighbor-store.js';
import { classifyIntent } from '../../src/core/search/intent-classifier.js';
import { SemanticRetrievalCache } from '../../src/core/search/semantic-cache.js';

const mockExecuteParameterized = vi.mocked(executeParameterized);
const mockBm25Search = vi.mocked(bm25Search);
const mockSemanticSearch = vi.mocked(semanticSearch);
const mockMergeSymbolsWithRRF = vi.mocked(mergeSymbolsWithRRF);
const mockApplyEnsemble = vi.mocked(applyEnsemble);
const mockGraphTraversalRank = vi.mocked(graphTraversalRank);
const mockGetFileSkeleton = vi.mocked(getFileSkeleton);
const mockAppendQueryLog = vi.mocked(appendQueryLog);
const mockClassifyIntent = vi.mocked(classifyIntent);
const mockResolveTargetContext = vi.mocked(resolveTargetContext);
const mockLoadAnnNeighborEdges = vi.mocked(loadAnnNeighborEdges);
const mockAdaptAnnNeighborEdgesForFrontier = vi.mocked(adaptAnnNeighborEdgesForFrontier);
const mockEmbedQuery = vi.mocked(embedQuery);
const mockIsEmbedderReady = vi.mocked(isEmbedderReady);

function symbolRow(overrides: Partial<EnrichedSymbolRow> = {}): EnrichedSymbolRow {
  return {
    nodeId: 'Function:src/core/cache.ts:CacheStore',
    name: 'CacheStore',
    type: 'Function',
    filePath: 'src/core/cache.ts',
    startLine: 10,
    endLine: 40,
    ...overrides,
  };
}

function mergedRows(rows: EnrichedSymbolRow[], limit: number) {
  const seen = new Set<string>();
  const merged: Array<[string, { score: number; data: EnrichedSymbolRow }]> = [];
  for (const row of rows) {
    const key = row.nodeId || row.filePath;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    merged.push([key, { score: 1 / (60 + merged.length + 1), data: row }]);
  }
  return merged.slice(0, limit);
}

function targetContext(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    status: 'ok',
    repoKey: 'repo-1',
    repoPath: '/repo',
    branch: 'main',
    targetRef: 'HEAD',
    targetHead: 'abc123',
    currentHead: 'abc123',
    indexedHead: 'abc123',
    dirtyWorktree: false,
    changedSinceIndex: false,
    snapshotMode: 'committed-head',
    qualityMode: 'balanced',
    embeddings: { status: 'available', count: 10 },
    lsp: { status: 'unknown', reason: 'not-probed' },
    sidecar: { status: 'unknown', reason: 'not-probed' },
    policy: { status: 'unknown', reason: 'not-probed' },
    warnings: [],
    ...overrides,
  };
}

describe('backend-search typed input', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockClassifyIntent.mockReturnValue({
      intent: 'identifier',
      confidence: 0.8,
      matchedKeywords: [],
    });
    mockExecuteParameterized.mockResolvedValue([]);
    mockBm25Search.mockResolvedValue({ results: [], ftsUsed: true });
    mockSemanticSearch.mockResolvedValue([]);
    mockGraphTraversalRank.mockResolvedValue([]);
    mockMergeSymbolsWithRRF.mockImplementation((bm25Results, semanticResults, limit) =>
      mergedRows(
        [...(bm25Results as EnrichedSymbolRow[]), ...(semanticResults as EnrichedSymbolRow[])],
        limit,
      ),
    );
    mockApplyEnsemble.mockImplementation(
      (_intent, bm25Results, semanticResults, limit, _confidence, graphResults = []) =>
        mergedRows(
          [
            ...(graphResults as EnrichedSymbolRow[]),
            ...(bm25Results as EnrichedSymbolRow[]),
            ...(semanticResults as EnrichedSymbolRow[]),
          ],
          limit,
        ),
    );
    mockAppendQueryLog.mockResolvedValue(undefined);
    mockGetFileSkeleton.mockResolvedValue('');
    mockResolveTargetContext.mockResolvedValue(targetContext());
    mockLoadAnnNeighborEdges.mockResolvedValue([]);
    mockAdaptAnnNeighborEdgesForFrontier.mockImplementation((edges) => edges);
    mockEmbedQuery.mockResolvedValue([0.11, 0.22, 0.33]);
    mockIsEmbedderReady.mockReturnValue(true);
  });

  it('keeps plain query callers working unchanged', async () => {
    const result = await query({ id: 'repo-1', repoPath: '/repo', lastCommit: 'abc123' } as any, {
      query: 'symbol: CacheStore',
      limit: 3,
    });

    expect(mockClassifyIntent).toHaveBeenCalledWith('symbol: CacheStore');
    expect(mockBm25Search).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'repo-1' }),
      expect.any(String),
      expect.any(Number),
    );
    expect(mockSemanticSearch).toHaveBeenCalledWith(
      { id: 'repo-1', repoPath: '/repo', lastCommit: 'abc123' } as any,
      'symbol: CacheStore',
      30,
      undefined,
    );
    expect(result).toMatchObject({
      processes: [],
      process_symbols: [],
      definitions: [],
      query_intent: 'identifier',
    });
    expect(result.warning).toBeUndefined();
    expect(mockLoadAnnNeighborEdges).not.toHaveBeenCalled();
    expect(mockEmbedQuery).not.toHaveBeenCalled();
  });

  it('opt-in symbol-neighborhood retrieval policy engages frontier search on plain queries', async () => {
    mockBm25Search.mockResolvedValue({
      results: [symbolRow()],
      ftsUsed: true,
    });
    mockExecuteParameterized.mockImplementation(async (_repoId, statement) => {
      if (String(statement).includes('MATCH (e:CodeEmbedding)')) {
        return [
          {
            nodeId: symbolRow().nodeId,
            embedding: [0.11, 0.22, 0.33],
          },
        ];
      }
      return [];
    });
    mockLoadAnnNeighborEdges.mockResolvedValue([]);

    const result = await query({ id: 'repo-1', repoPath: '/repo', lastCommit: 'abc123' } as any, {
      query: 'symbol: CacheStore',
      limit: 3,
      retrieval_policy: 'symbol-neighborhood',
    });

    expect(mockEmbedQuery).toHaveBeenCalledTimes(1);
    expect(mockLoadAnnNeighborEdges).toHaveBeenCalledTimes(1);
    expect(result.warning).toContain('symbol-neighborhood skipped: no ANN edges found for retrieved seeds');
    expect(result).toMatchObject({
      processes: [],
      process_symbols: [],
      definitions: [{ name: 'CacheStore', filePath: 'src/core/cache.ts' }],
      query_intent: 'identifier',
    });
    expect(mockLoadAnnNeighborEdges).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({
        sourceIds: [
          'Function:src/core/cache.ts:CacheStore',
        ],
      }),
    );
  });

  it('uses request-level intent for classification without overriding lex routing', async () => {
    const lexicalHit = symbolRow({
      nodeId: 'Function:src/cache.ts:invalidateCache',
      name: 'invalidateCache',
    });
    mockBm25Search.mockResolvedValue({ results: [lexicalHit], ftsUsed: true });

    const result = await query({ id: 'repo-1', repoPath: '/repo', lastCommit: 'abc123' } as any, {
      typedQuery: {
        intent: 'cross-file impact',
        lines: [{ type: 'lex', query: 'cache invalidation', lineNumber: 2 }],
      },
      limit: 2,
    });

    expect(mockClassifyIntent).toHaveBeenCalledWith('cross-file impact');
    expect(mockBm25Search).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'repo-1' }),
      'cache invalidation',
      20,
    );
    expect(mockSemanticSearch).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      query_intent: 'identifier',
      definitions: [{ name: 'invalidateCache', filePath: 'src/core/cache.ts' }],
    });
  });

  it('downgrades vec lines with a warning when embeddings are unavailable', async () => {
    mockExecuteParameterized.mockImplementation(async (_repoId, statement) => {
      if (String(statement).includes('MATCH (e:CodeEmbedding)')) {
        return [];
      }
      return [];
    });

    const result = await query({ id: 'repo-1', repoPath: '/repo', lastCommit: 'abc123' } as any, {
      typedQuery: {
        lines: [{ type: 'vec', query: 'semantic cache invalidation', lineNumber: 2 }],
      },
    });

    expect(mockSemanticSearch).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      warning: expect.stringContaining('Typed vec line 2 downgraded: embeddings unavailable.'),
      definitions: [],
    });
  });

  it('keeps hyde on the vector path and downgrades with a warning when embeddings are unavailable', async () => {
    mockExecuteParameterized.mockImplementation(async (_repoId, statement) => {
      if (String(statement).includes('MATCH (e:CodeEmbedding)')) {
        return [];
      }
      return [];
    });

    const result = await query({ id: 'repo-1', repoPath: '/repo', lastCommit: 'abc123' } as any, {
      typedQuery: {
        lines: [{ type: 'hyde', query: 'explain graph load failure modes', lineNumber: 4 }],
      },
    });

    expect(mockSemanticSearch).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      warning: expect.stringContaining('Typed hyde line 4 downgraded: embeddings unavailable.'),
      definitions: [],
    });
  });

  it('keeps exact symbol hits ahead of unrelated semantic-only results', async () => {
    const exactSymbol = symbolRow();
    const unrelatedSemantic = symbolRow({
      nodeId: 'Function:src/semantic.ts:SemanticOnlyHit',
      name: 'SemanticOnlyHit',
      filePath: 'src/semantic.ts',
    });

    mockExecuteParameterized.mockImplementation(async (_repoId, statement) => {
      const sql = String(statement);
      if (sql.includes('MATCH (e:CodeEmbedding)')) {
        return [{ nodeId: 'embedding:1' }];
      }
      if (sql.includes('WHERE n.id = $symbolQuery OR n.name = $symbolQuery')) {
        return [
          {
            id: exactSymbol.nodeId,
            name: exactSymbol.name,
            type: exactSymbol.type,
            filePath: exactSymbol.filePath,
            startLine: exactSymbol.startLine,
            endLine: exactSymbol.endLine,
          },
        ];
      }
      return [];
    });
    mockSemanticSearch.mockResolvedValue([unrelatedSemantic]);

    const result = await query({ id: 'repo-1', repoPath: '/repo', lastCommit: 'abc123' } as any, {
      typedQuery: {
        lines: [
          { type: 'symbol', query: 'CacheStore', lineNumber: 1 },
          { type: 'vec', query: 'semantic cache storage', lineNumber: 2 },
        ],
      },
    });

    expect(mockBm25Search).not.toHaveBeenCalled();
    expect(mockSemanticSearch).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      definitions: [
        { name: 'CacheStore', filePath: 'src/core/cache.ts' },
        { name: 'SemanticOnlyHit', filePath: 'src/semantic.ts' },
      ],
    });
  });

  it('uses exact file lookup before BM25 and preserves skeleton lookup', async () => {
    const fileHit = symbolRow({
      nodeId: 'File:src/core/cache.ts',
      name: 'cache.ts',
      type: 'File',
      filePath: 'src/core/cache.ts',
      startLine: 1,
      endLine: 120,
    });

    mockExecuteParameterized.mockImplementation(async (_repoId, statement) => {
      if (String(statement).includes('MATCH (n:File)')) {
        return [
          {
            id: fileHit.nodeId,
            name: fileHit.name,
            type: fileHit.type,
            filePath: fileHit.filePath,
            startLine: fileHit.startLine,
            endLine: fileHit.endLine,
          },
        ];
      }
      return [];
    });
    mockGetFileSkeleton.mockResolvedValue(
      'Symbols in src/core/cache.ts:\n  - function CacheStore (lines 10-40)',
    );

    const result = await query({ id: 'repo-1', repoPath: '/repo', lastCommit: 'abc123' } as any, {
      typedQuery: {
        lines: [{ type: 'file', query: 'src/core/cache.ts', lineNumber: 3 }],
      },
      include_skeleton: true,
    });

    expect(mockBm25Search).not.toHaveBeenCalled();
    expect(mockGetFileSkeleton).toHaveBeenCalledWith(
      'repo-1',
      'src/core/cache.ts',
      expect.any(Number),
    );
    expect(result).toMatchObject({
      definitions: [{ name: 'cache.ts', filePath: 'src/core/cache.ts' }],
      skeletons: {
        'src/core/cache.ts': expect.stringContaining('Symbols in src/core/cache.ts'),
      },
    });
  });

  it('routes graph lines to graph traversal when intent and confidence allow it', async () => {
    const seedRow = symbolRow({
      nodeId: 'Function:src/core/cache.ts:findCacheStore',
      name: 'findCacheStore',
    });
    const graphHit = symbolRow({
      nodeId: 'Function:src/core/cache.ts:cacheCallers',
      name: 'cacheCallers',
      filePath: 'src/core/cache.ts',
    });

    mockClassifyIntent.mockReturnValue({
      intent: 'calls-of',
      confidence: 0.9,
      matchedKeywords: [],
    });
    mockBm25Search.mockResolvedValue({ results: [seedRow], ftsUsed: true });
    mockGraphTraversalRank.mockResolvedValue([graphHit]);

    const result = await query({ id: 'repo-1', repoPath: '/repo', lastCommit: 'abc123' } as any, {
      typedQuery: {
        intent: 'calls of cache store',
        lines: [{ type: 'graph', query: 'upstream callers', lineNumber: 2 }],
      },
      intent_ensemble: true,
    });

    expect(mockGraphTraversalRank).toHaveBeenCalledWith('repo-1', [seedRow], ['CALLS'], 2, 50);
    expect(mockApplyEnsemble).toHaveBeenCalled();
    expect(result).toMatchObject({
      definitions: [{ name: 'cacheCallers', filePath: 'src/core/cache.ts' }],
    });
  });

  it('surfaces graph fallback warnings when traversal returns no hits', async () => {
    const seedRow = symbolRow({
      nodeId: 'Function:src/core/cache.ts:findCacheStore',
      name: 'findCacheStore',
    });

    mockClassifyIntent.mockReturnValue({
      intent: 'calls-of',
      confidence: 0.9,
      matchedKeywords: [],
    });
    mockBm25Search.mockResolvedValue({ results: [seedRow], ftsUsed: true });
    mockGraphTraversalRank.mockResolvedValue([]);

    const result = await query({ id: 'repo-1', repoPath: '/repo', lastCommit: 'abc123' } as any, {
      typedQuery: {
        intent: 'calls of cache store',
        lines: [{ type: 'graph', query: 'upstream callers', lineNumber: 5 }],
      },
      intent_ensemble: true,
    });

    expect(result).toMatchObject({
      warning: expect.stringContaining(
        'Typed graph line 5 produced no traversal hits; falling back to BM25 seeds.',
      ),
      definitions: [{ name: 'findCacheStore', filePath: 'src/core/cache.ts' }],
    });
  });

  it('rejects an empty typed request after flattening', async () => {
    await expect(
      query({ id: 'repo-1', repoPath: '/repo', lastCommit: 'abc123' } as any, {
        typedQuery: {
          intent: 'release blocker diagnosis',
          lines: [],
        },
      }),
    ).resolves.toEqual({
      error: 'query parameter is required and cannot be empty.',
    });

    expect(mockBm25Search).not.toHaveBeenCalled();
    expect(mockSemanticSearch).not.toHaveBeenCalled();
  });

  it('emits structured retrieval candidates with ids and evidence references when requested', async () => {
    const exactSymbol = symbolRow();
    const semanticHit = symbolRow({
      nodeId: 'Function:src/semantic.ts:SemanticOnlyHit',
      name: 'SemanticOnlyHit',
      filePath: 'src/semantic.ts',
    });

    mockExecuteParameterized.mockImplementation(async (_repoId, statement) => {
      const sql = String(statement);
      if (sql.includes('MATCH (e:CodeEmbedding)')) {
        return [{ nodeId: 'embedding:1' }];
      }
      if (sql.includes('WHERE n.id = $symbolQuery OR n.name = $symbolQuery')) {
        return [
          {
            id: exactSymbol.nodeId,
            name: exactSymbol.name,
            type: exactSymbol.type,
            filePath: exactSymbol.filePath,
            startLine: exactSymbol.startLine,
            endLine: exactSymbol.endLine,
          },
        ];
      }
      return [];
    });
    mockSemanticSearch.mockResolvedValue([semanticHit]);

    const result = await query({ id: 'repo-1', repoPath: '/repo', lastCommit: 'abc123' } as any, {
      typedQuery: {
        lines: [
          { type: 'symbol', query: 'CacheStore', lineNumber: 1 },
          { type: 'vec', query: 'semantic cache storage', lineNumber: 2 },
        ],
      },
      structured_output: true,
    });

    expect(result).toMatchObject({
      definitions: [
        { name: 'CacheStore', filePath: 'src/core/cache.ts' },
        { name: 'SemanticOnlyHit', filePath: 'src/semantic.ts' },
      ],
      structured_retrieval: {
        candidates: [
          {
            id: expect.stringContaining('Function:src/core/cache.ts:CacheStore'),
            source: 'symbol',
            evidence: [
              {
                kind: 'typed-query-line',
                query: 'CacheStore',
                lineNumber: 1,
                retrieval: 'exact',
              },
            ],
          },
          {
            id: expect.stringContaining('Function:src/semantic.ts:SemanticOnlyHit'),
            source: 'vec',
            evidence: [
              {
                kind: 'typed-query-line',
                query: 'semantic cache storage',
                lineNumber: 2,
                retrieval: 'vector',
              },
            ],
          },
        ],
        capabilityState: {
          tokenCost: {
            status: 'unavailable',
            reason: 'token-cost-metadata-not-supplied',
            warnings: ['Token/USD cost unavailable: token-cost-metadata-not-supplied.'],
          },
          warnings: expect.arrayContaining([
            'Token/USD cost unavailable: token-cost-metadata-not-supplied.',
          ]),
        },
      },
    });
  });

  it('preserves configured token cost metadata in structured retrieval diagnostics', async () => {
    const exactSymbol = symbolRow();

    mockExecuteParameterized.mockImplementation(async (_repoId, statement) => {
      if (String(statement).includes('WHERE n.id = $symbolQuery OR n.name = $symbolQuery')) {
        return [
          {
            id: exactSymbol.nodeId,
            name: exactSymbol.name,
            type: exactSymbol.type,
            filePath: exactSymbol.filePath,
            startLine: exactSymbol.startLine,
            endLine: exactSymbol.endLine,
          },
        ];
      }
      return [];
    });

    const result = await query({ id: 'repo-1', repoPath: '/repo', lastCommit: 'abc123' } as any, {
      typedQuery: {
        lines: [{ type: 'symbol', query: 'CacheStore', lineNumber: 1 }],
      },
      structured_output: true,
      token_cost: {
        usage: {
          inputTokens: 400,
          outputTokens: 100,
          source: 'provider-usage',
        },
        pricing: {
          inputUsdPerMillionTokens: 3,
          outputUsdPerMillionTokens: 15,
          source: 'test-pricing',
          model: 'named-model',
        },
      },
    });

    expect(result.structured_retrieval?.capabilityState.tokenCost).toEqual({
      status: 'available',
      reason: 'token-cost-computed-from-config',
      usage: {
        inputTokens: 400,
        outputTokens: 100,
        totalTokens: 500,
        source: 'provider-usage',
      },
      pricing: {
        inputUsdPerMillionTokens: 3,
        outputUsdPerMillionTokens: 15,
        currency: 'USD',
        source: 'test-pricing',
        model: 'named-model',
      },
      costUsd: 0.0027,
      warnings: [],
    });
    expect(result.structured_retrieval?.candidates[0].label).toBe('CacheStore');
  });

  it('reports stale freshness and missing embeddings in structured capability state', async () => {
    mockExecuteParameterized.mockImplementation(async (_repoId, statement) => {
      if (String(statement).includes('MATCH (e:CodeEmbedding)')) {
        return [];
      }
      return [];
    });
    mockResolveTargetContext.mockResolvedValue(
      targetContext({
        targetHead: 'def456',
        currentHead: 'def456',
        indexedHead: 'abc123',
        changedSinceIndex: true,
        embeddings: { status: 'unavailable', reason: 'embedding-stats-unavailable' },
      }),
    );

    const result = await query({ id: 'repo-1', repoPath: '/repo', lastCommit: 'abc123' } as any, {
      typedQuery: {
        lines: [{ type: 'vec', query: 'semantic cache invalidation', lineNumber: 2 }],
      },
      structured_output: true,
    });

    expect(result).toMatchObject({
      warning: expect.stringContaining('Typed vec line 2 downgraded: embeddings unavailable.'),
      structured_retrieval: {
        candidates: [],
        capabilityState: {
          freshness: {
            status: 'stale',
            indexedHead: 'abc123',
            targetHead: 'def456',
          },
          capabilitiesMissing: expect.arrayContaining(['embeddings']),
          warnings: expect.arrayContaining([
            'Embeddings unavailable; typed retrieval downgraded vector lanes.',
            'Index freshness stale: indexedHead != targetHead.',
          ]),
        },
      },
    });
  });

  it('filters structured retrieval candidates and derives rows', async () => {
    const symbolHit = symbolRow();
    const fileHit = symbolRow({
      nodeId: 'File:src/semantic.ts',
      name: 'semantic.ts',
      type: 'File',
      filePath: 'src/semantic.ts',
    });

    mockExecuteParameterized.mockImplementation(async (_repoId, statement) => {
      const sql = String(statement);
      if (sql.includes('WHERE n.id = $symbolQuery OR n.name = $symbolQuery')) {
        return [
          {
            id: symbolHit.nodeId,
            name: symbolHit.name,
            type: symbolHit.type,
            filePath: symbolHit.filePath,
            startLine: symbolHit.startLine,
            endLine: symbolHit.endLine,
          },
        ];
      }
      if (sql.includes('MATCH (n:File)')) {
        return [
          {
            id: fileHit.nodeId,
            name: fileHit.name,
            type: fileHit.type,
            filePath: fileHit.filePath,
            startLine: fileHit.startLine,
            endLine: fileHit.endLine,
          },
        ];
      }
      return [];
    });

    const result = await query({ id: 'repo-1', repoPath: '/repo', lastCommit: 'abc123' } as any, {
      typedQuery: {
        filters: [{ field: 'kind', operator: '=', value: 'file', lineNumber: 1 }],
        lines: [
          { type: 'symbol', query: 'CacheStore', lineNumber: 2 },
          { type: 'file', query: 'src/semantic.ts', lineNumber: 3 },
        ],
      },
      structured_output: true,
    });

    expect(result.structured_retrieval?.candidates).toHaveLength(1);
    expect(result.structured_retrieval?.candidates[0].id).toContain('File:src/semantic.ts');
    expect(result.structured_retrieval?.rows).toHaveLength(1);
    expect(result.structured_retrieval?.rows[0]).toMatchObject({
      id: expect.stringContaining('File:src/semantic.ts'),
      kind: 'file',
      label: 'semantic.ts',
      source: 'file',
    });
  });

  it('preserves candidate order after filtering', async () => {
    const symbol1 = symbolRow({
      nodeId: 'Function:src/core/cache.ts:CacheStore1',
      name: 'CacheStore1',
    });
    const symbol2 = symbolRow({
      nodeId: 'Function:src/core/cache.ts:CacheStore2',
      name: 'CacheStore2',
    });
    const symbol3 = symbolRow({
      nodeId: 'Function:src/core/cache.ts:CacheStore3',
      name: 'CacheStore3',
    });

    mockExecuteParameterized.mockImplementation(async (_repoId, statement) => {
      const sql = String(statement);
      if (sql.includes('WHERE n.id = $symbolQuery OR n.name = $symbolQuery')) {
        const queryVal = (vi.mocked(executeParameterized).mock.calls.at(-1)?.[2] as any)
          ?.symbolQuery;
        const mapSymbol = (s: any) => ({
          id: s.nodeId,
          name: s.name,
          type: s.type,
          filePath: s.filePath,
          startLine: s.startLine,
          endLine: s.endLine,
        });
        if (queryVal === 'CacheStore1') return [mapSymbol(symbol1)];
        if (queryVal === 'CacheStore2') return [mapSymbol(symbol2)];
        if (queryVal === 'CacheStore3') return [mapSymbol(symbol3)];
      }
      return [];
    });

    const result = await query({ id: 'repo-1', repoPath: '/repo', lastCommit: 'abc123' } as any, {
      typedQuery: {
        filters: [{ field: 'kind', operator: '=', value: 'symbol', lineNumber: 1 }],
        lines: [
          { type: 'symbol', query: 'CacheStore1', lineNumber: 2 },
          { type: 'symbol', query: 'CacheStore2', lineNumber: 3 },
          { type: 'symbol', query: 'CacheStore3', lineNumber: 4 },
        ],
      },
      structured_output: true,
    });

    const candidates = result.structured_retrieval?.candidates;
    expect(candidates).toHaveLength(3);
    expect(candidates![0].id).toContain('CacheStore1');
    expect(candidates![1].id).toContain('CacheStore2');
    expect(candidates![2].id).toContain('CacheStore3');

    const rows = result.structured_retrieval?.rows;
    expect(rows).toHaveLength(3);
    expect(rows![0].id).toEqual(candidates![0].id);
    expect(rows![1].id).toEqual(candidates![1].id);
    expect(rows![2].id).toEqual(candidates![2].id);
  });

  it('returns row-normalized structured retrieval results from fresh cache hits', async () => {
    const timestamp = Date.now() - 250;
    const lookupSpy = vi.spyOn(SemanticRetrievalCache.prototype, 'lookup').mockResolvedValue({
      status: 'hit',
      ageMs: 250,
      result: {
        candidates: [
          {
            id: 'retrieval:Function:src/core/cache.ts:CacheStore',
            kind: 'symbol',
            label: 'CacheStore',
            filePath: 'src/core/cache.ts',
            startLine: 10,
            endLine: 40,
            source: 'symbol',
            rawScore: 0.5,
            evidence: [],
            freshness: 'fresh',
          },
        ],
        diagnostics: {
          timing: { cache: 1 },
          capabilityHealth: {
            capabilitiesUsed: ['typed-query'],
            capabilitiesMissing: [],
            warnings: [],
            tokenCost: {
              status: 'available',
              reason: 'token-cost-computed-from-config',
              usage: {
                inputTokens: 10,
                outputTokens: 5,
                totalTokens: 15,
                source: 'provider-usage',
              },
              pricing: {
                inputUsdPerMillionTokens: 2,
                outputUsdPerMillionTokens: 8,
                currency: 'USD',
                source: 'test-pricing',
                model: 'named-model',
              },
              costUsd: 0.00006,
              warnings: [],
            },
          },
          freshness: {
            status: 'fresh',
            actionable: false,
            reason: 'indexedHead == targetHead',
          },
        },
        timestamp,
        indexedHead: 'abc123',
      },
    });
    const setSpy = vi.spyOn(SemanticRetrievalCache.prototype, 'set');

    const result = await query({ id: 'repo-1', repoPath: '/repo', lastCommit: 'abc123' } as any, {
      typedQuery: {
        filters: [{ field: 'kind', operator: '=', value: 'symbol', lineNumber: 1 }],
        lines: [{ type: 'symbol', query: 'CacheStore', lineNumber: 2 }],
      },
      structured_output: true,
    });

    expect(lookupSpy).toHaveBeenCalledWith(expect.any(String), 'abc123');
    expect(setSpy).not.toHaveBeenCalled();
    expect(mockBm25Search).not.toHaveBeenCalled();
    expect(result.structured_retrieval?.rows).toEqual([
      {
        id: 'retrieval:Function:src/core/cache.ts:CacheStore',
        kind: 'symbol',
        label: 'CacheStore',
        source: 'symbol',
        freshness: 'fresh',
        filePath: 'src/core/cache.ts',
        startLine: 10,
        endLine: 40,
        rawScore: 0.5,
      },
    ]);
    expect(result.definitions).toEqual([
      {
        id: 'Function:src/core/cache.ts:CacheStore',
        name: 'CacheStore',
        type: 'Function',
        filePath: 'src/core/cache.ts',
        startLine: 10,
        endLine: 40,
      },
    ]);
    expect(result.structured_retrieval?.capabilityState).toMatchObject({
      freshness: { status: 'fresh' },
      cacheHit: true,
      cacheStatus: 'hit',
      cacheAgeMs: 250,
      tokenCost: {
        status: 'available',
        costUsd: 0.00006,
        pricing: { source: 'test-pricing' },
      },
    });

    lookupSpy.mockRestore();
    setSpy.mockRestore();
  });

  it('does not cache stale structured retrieval results', async () => {
    const symbolHit = symbolRow();
    const lookupSpy = vi.spyOn(SemanticRetrievalCache.prototype, 'lookup').mockResolvedValue({
      status: 'miss',
      result: null,
    });
    const setSpy = vi.spyOn(SemanticRetrievalCache.prototype, 'set');

    mockExecuteParameterized.mockImplementation(async (_repoId, statement) => {
      if (String(statement).includes('WHERE n.id = $symbolQuery OR n.name = $symbolQuery')) {
        return [
          {
            id: symbolHit.nodeId,
            name: symbolHit.name,
            type: symbolHit.type,
            filePath: symbolHit.filePath,
            startLine: symbolHit.startLine,
            endLine: symbolHit.endLine,
          },
        ];
      }
      return [];
    });
    mockResolveTargetContext.mockResolvedValue(
      targetContext({
        targetHead: 'def456',
        currentHead: 'def456',
        indexedHead: 'abc123',
        changedSinceIndex: true,
      }),
    );

    const result = await query({ id: 'repo-1', repoPath: '/repo', lastCommit: 'abc123' } as any, {
      typedQuery: {
        lines: [{ type: 'symbol', query: 'CacheStore', lineNumber: 1 }],
      },
      structured_output: true,
    });

    expect(result.structured_retrieval?.capabilityState.freshness.status).toBe('stale');
    expect(result.structured_retrieval?.capabilityState).toMatchObject({
      cacheHit: false,
      cacheStatus: 'miss',
    });
    expect(lookupSpy).toHaveBeenCalledWith(expect.any(String), 'abc123');
    expect(setSpy).not.toHaveBeenCalled();

    lookupSpy.mockRestore();
    setSpy.mockRestore();
  });

  it('reports expired cache lookups and eviction counts on refreshed structured results', async () => {
    const symbolHit = symbolRow({ name: 'ExpiredRefresh' });
    const lookupSpy = vi.spyOn(SemanticRetrievalCache.prototype, 'lookup').mockResolvedValue({
      status: 'expired',
      result: null,
      ageMs: 1_500,
    });
    const setSpy = vi
      .spyOn(SemanticRetrievalCache.prototype, 'set')
      .mockResolvedValue({ evicted: 2 });

    mockExecuteParameterized.mockImplementation(async (_repoId, statement) => {
      if (String(statement).includes('WHERE n.id = $symbolQuery OR n.name = $symbolQuery')) {
        return [
          {
            id: symbolHit.nodeId,
            name: symbolHit.name,
            type: symbolHit.type,
            filePath: symbolHit.filePath,
            startLine: symbolHit.startLine,
            endLine: symbolHit.endLine,
          },
        ];
      }
      return [];
    });

    const result = await query({ id: 'repo-1', repoPath: '/repo', lastCommit: 'abc123' } as any, {
      typedQuery: {
        lines: [{ type: 'symbol', query: 'ExpiredRefresh', lineNumber: 1 }],
      },
      structured_output: true,
    });

    expect(result.structured_retrieval?.candidates[0].label).toBe('ExpiredRefresh');
    expect(result.structured_retrieval?.capabilityState).toMatchObject({
      cacheHit: false,
      cacheStatus: 'expired',
      cacheAgeMs: 1_500,
      cacheEvictedEntries: 2,
    });
    expect(setSpy).toHaveBeenCalled();

    lookupSpy.mockRestore();
    setSpy.mockRestore();
  });

  it('does not use cached candidates whose stored freshness is stale', async () => {
    const freshHit = symbolRow({ name: 'FreshRefresh' });
    const lookupSpy = vi.spyOn(SemanticRetrievalCache.prototype, 'lookup').mockResolvedValue({
      status: 'hit',
      ageMs: 100,
      result: {
        candidates: [
          {
            id: 'retrieval:stale',
            kind: 'symbol',
            label: 'CachedStale',
            filePath: 'src/core/cache.ts',
            source: 'symbol',
            evidence: [],
            freshness: 'stale',
          },
        ],
        diagnostics: {
          capabilityHealth: {
            capabilitiesUsed: ['typed-query'],
            capabilitiesMissing: [],
            warnings: [],
          },
          freshness: {
            status: 'stale',
            actionable: true,
            reason: 'indexedHead != targetHead',
          },
        },
        timestamp: Date.now() - 100,
        indexedHead: 'abc123',
      },
    });
    const setSpy = vi
      .spyOn(SemanticRetrievalCache.prototype, 'set')
      .mockResolvedValue({ evicted: 0 });

    mockExecuteParameterized.mockImplementation(async (_repoId, statement) => {
      if (String(statement).includes('WHERE n.id = $symbolQuery OR n.name = $symbolQuery')) {
        return [
          {
            id: freshHit.nodeId,
            name: freshHit.name,
            type: freshHit.type,
            filePath: freshHit.filePath,
            startLine: freshHit.startLine,
            endLine: freshHit.endLine,
          },
        ];
      }
      return [];
    });

    const result = await query({ id: 'repo-1', repoPath: '/repo', lastCommit: 'abc123' } as any, {
      typedQuery: {
        lines: [{ type: 'symbol', query: 'FreshRefresh', lineNumber: 1 }],
      },
      structured_output: true,
    });

    expect(result.structured_retrieval?.candidates.map((candidate) => candidate.label)).toEqual([
      'FreshRefresh',
    ]);
    expect(result.structured_retrieval?.capabilityState).toMatchObject({
      cacheHit: false,
      cacheStatus: 'stale',
      cacheAgeMs: 100,
    });
    expect(setSpy).toHaveBeenCalled();

    lookupSpy.mockRestore();
    setSpy.mockRestore();
  });
});
