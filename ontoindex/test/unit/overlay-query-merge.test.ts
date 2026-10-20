import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/core/lbug/pool-adapter.js', () => ({
  executeParameterized: vi.fn(),
}));
vi.mock('../../src/mcp/local/backend-query.js', () => ({
  bm25Search: vi.fn(),
  semanticSearch: vi.fn(),
}));
vi.mock('../../src/mcp/local/backend-overlay.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/mcp/local/backend-overlay.js')>()),
  getOverlaySnapshot: vi.fn(),
  queryOverlay: vi.fn(),
}));
vi.mock('../../src/core/search/graph-traversal-rank.js', () => ({
  graphTraversalRank: vi.fn(),
}));
vi.mock('../../src/core/search/skeleton.js', () => ({
  getFileSkeleton: vi.fn(),
}));
vi.mock('../../src/mcp/local/query-log.js', () => ({
  queryLogEnabled: () => false,
}));
vi.mock('../../src/core/search/intent-classifier.js', () => ({
  classifyIntent: vi.fn(),
}));
vi.mock('../../src/mcp/shared/target-context.js', () => ({
  resolveTargetContext: vi.fn(),
}));
vi.mock('../../src/storage/repo-manager.js', () => ({
  loadMeta: vi.fn(async () => null),
}));

import { executeParameterized } from '../../src/core/lbug/pool-adapter.js';
import { SemanticRetrievalCache } from '../../src/core/search/semantic-cache.js';
import type { EnrichedSymbolRow } from '../../src/core/search/symbol-merge.js';
import { graphTraversalRank } from '../../src/core/search/graph-traversal-rank.js';
import { getFileSkeleton } from '../../src/core/search/skeleton.js';
import { classifyIntent } from '../../src/core/search/intent-classifier.js';
import {
  getOverlaySnapshot,
  queryOverlay,
  type OverlaySnapshot,
} from '../../src/mcp/local/backend-overlay.js';
import { bm25Search, semanticSearch } from '../../src/mcp/local/backend-query.js';
import { query } from '../../src/mcp/local/backend-search.js';
import type { RepoHandle } from '../../src/mcp/local/tool-params.js';
import { resolveTargetContext } from '../../src/mcp/shared/target-context.js';

const repo: RepoHandle = {
  id: 'overlay-query-test',
  name: 'overlay-query-test',
  repoPath: '/repo',
  path: '/repo',
  storagePath: '/repo/.ontoindex',
  lbugPath: '/repo/.ontoindex/lbug',
  indexedAt: '',
  lastCommit: 'abc123',
};
const stale: EnrichedSymbolRow = {
  nodeId: 'Function:src/dirty.ts:CacheStore',
  name: 'OldCacheStore',
  type: 'Function',
  filePath: 'src/dirty.ts',
  startLine: 1,
  endLine: 5,
};
const clean: EnrichedSymbolRow = {
  ...stale,
  nodeId: 'Function:src/clean.ts:CacheStore',
  name: 'CleanCacheStore',
  filePath: 'src/clean.ts',
};
const overlayRow = {
  id: stale.nodeId,
  name: 'NewCacheStore',
  type: 'Function',
  filePath: 'src/dirty.ts',
  startLine: 10,
  endLine: 20,
};
function snapshot(usable: boolean, dirtyPaths = ['src/dirty.ts']): OverlaySnapshot {
  return {
    usable,
    reason: usable ? null : 'overlay not built',
    dirtyPaths: new Set(dirtyPaths),
    overlayPaths: new Set(dirtyPaths),
    tombstones: new Set(),
  };
}
const options = {
  query: 'CacheStore',
  include_skeleton: false,
  intent_ensemble: false,
};

describe('query dirty-overlay merge', () => {
  beforeEach(() => {
    vi.stubEnv('ONTOINDEX_AUTO_WORKSPACE', '0');
    vi.resetAllMocks();
    // Hold timing constant so equality checks cover the whole serialized response.
    vi.spyOn(performance, 'now').mockReturnValue(100);
    vi.spyOn(SemanticRetrievalCache.prototype, 'lookup').mockResolvedValue({
      status: 'miss',
      result: null,
    });
    vi.spyOn(SemanticRetrievalCache.prototype, 'set').mockResolvedValue({ evicted: 0 });
    vi.mocked(classifyIntent).mockReturnValue({
      intent: 'identifier',
      confidence: 0.8,
      matchedKeywords: [],
    });
    vi.mocked(executeParameterized).mockResolvedValue([]);
    vi.mocked(graphTraversalRank).mockResolvedValue([]);
    vi.mocked(getFileSkeleton).mockResolvedValue('');
    vi.mocked(bm25Search).mockResolvedValue({ results: [stale, clean], ftsUsed: true });
    vi.mocked(semanticSearch).mockResolvedValue([stale]);
    vi.mocked(getOverlaySnapshot).mockResolvedValue(snapshot(false, []));
    vi.mocked(queryOverlay).mockResolvedValue([overlayRow]);
    vi.mocked(resolveTargetContext).mockResolvedValue({
      status: 'ok',
      repoKey: repo.id,
      repoPath: repo.repoPath,
      targetHead: repo.lastCommit,
      currentHead: repo.lastCommit,
      indexedHead: repo.lastCommit,
      dirtyWorktree: false,
      embeddings: { status: 'available', count: 1 },
      warnings: [],
    } as Awaited<ReturnType<typeof resolveTargetContext>>);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it.each([false, true])(
    'replaces dirty base symbols before ranking (ensemble=%s)',
    async (ensemble) => {
      vi.mocked(getOverlaySnapshot).mockResolvedValue(snapshot(true));
      vi.mocked(bm25Search).mockResolvedValue({
        results: [{ ...stale, filePath: 'src\\dirty.ts' }, clean],
        ftsUsed: true,
      });
      const result = await query(repo, {
        ...options,
        intent_ensemble: ensemble,
        structured_output: true,
        include_content: true,
        include_citations: true,
      });
      expect(result).toMatchObject({
        definitions: [{ ...overlayRow, source: 'overlay' }, { name: clean.name }],
        structured_retrieval: {
          candidates: [{ label: overlayRow.name, source: 'overlay' }, { label: clean.name }],
          rows: [{ label: overlayRow.name, source: 'overlay' }, { label: clean.name }],
        },
      });
      expect(JSON.stringify(result)).not.toContain(stale.name);
      expect(executeParameterized).not.toHaveBeenCalledWith(repo.id, expect.any(String), {
        nodeId: stale.nodeId,
      });
      expect(queryOverlay).toHaveBeenCalledWith(
        repo,
        expect.not.stringContaining('IN $paths'),
        {
          path0: 'src/dirty.ts',
          limit: 50,
          term0: 'cachestore',
        },
        undefined,
      );
      expect(vi.mocked(queryOverlay).mock.calls[0][1]).toContain('n.filePath = $path0');
      expect(vi.mocked(queryOverlay).mock.calls[0][1]).toContain('LIMIT $limit');
      expect(SemanticRetrievalCache.prototype.lookup).not.toHaveBeenCalled();
      expect(SemanticRetrievalCache.prototype.set).not.toHaveBeenCalled();
    },
  );

  it.each([
    [false, false],
    [false, true],
    [true, false],
    [true, true],
  ])(
    'ranks overlay matches before trimming a full clean pool (ensemble=%s, structured=%s)',
    async (ensemble, structured) => {
      vi.mocked(getOverlaySnapshot).mockResolvedValue(snapshot(true));
      vi.mocked(bm25Search).mockResolvedValue({
        results: [
          stale,
          ...Array.from({ length: 50 }, (_, index) => ({
            ...clean,
            nodeId: `Function:src/clean-${index}.ts:CleanCacheStore${index}`,
            name: `CleanCacheStore${index}`,
            filePath: `src/clean-${index}.ts`,
          })),
        ],
        ftsUsed: true,
      });
      const exactOverlay = { ...overlayRow, name: 'CacheStore' };
      vi.mocked(queryOverlay).mockResolvedValue([exactOverlay]);

      const result = await query(repo, {
        ...options,
        intent_ensemble: ensemble,
        structured_output: structured,
      });

      expect(result.definitions).toHaveLength(20);
      expect(result.definitions).toEqual(
        expect.arrayContaining([expect.objectContaining({ ...exactOverlay, source: 'overlay' })]),
      );
      expect(JSON.stringify(result)).not.toContain(stale.name);
      if (structured) {
        expect(result.structured_retrieval.candidates).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ label: exactOverlay.name, source: 'overlay' }),
          ]),
        );
      }
    },
  );

  it('keeps only rows from overlay paths and caps them at the search limit', async () => {
    vi.mocked(getOverlaySnapshot).mockResolvedValue(
      snapshot(true, ['src/dirty.ts', 'src/other.ts']),
    );
    vi.mocked(queryOverlay).mockResolvedValue([
      { ...overlayRow, id: 'outside', name: 'Outside', filePath: 'src/untracked.ts' },
      ...Array.from({ length: 60 }, (_, index) => ({
        ...overlayRow,
        id: `overlay-${index}`,
        name: `CacheStore${index}`,
        filePath: index % 2 === 0 ? 'src/dirty.ts' : 'src/other.ts',
      })),
    ]);
    const result = await query(repo, { ...options, intent_ensemble: false });
    const json = JSON.stringify(result);
    expect(json).toContain('CacheStore0');
    expect(json).not.toContain('Outside');
    expect(result.definitions).toHaveLength(20);
    expect(queryOverlay).toHaveBeenCalledWith(
      repo,
      expect.any(String),
      {
        path0: 'src/dirty.ts',
        path1: 'src/other.ts',
        limit: 50,
        term0: 'cachestore',
      },
      undefined,
    );
    expect(vi.mocked(queryOverlay).mock.calls[0][1]).toContain('n.filePath = $path0');
    expect(vi.mocked(queryOverlay).mock.calls[0][1]).toContain('n.filePath = $path1');
    expect(vi.mocked(queryOverlay).mock.calls[0][1]).toContain('LIMIT $limit');
  });

  it('suppresses dirty graph and locked exact candidates as well', async () => {
    vi.mocked(getOverlaySnapshot).mockResolvedValue(snapshot(true));
    vi.mocked(classifyIntent).mockReturnValue({
      intent: 'calls-of',
      confidence: 0.8,
      matchedKeywords: [],
    });
    vi.mocked(graphTraversalRank).mockResolvedValue([stale]);
    vi.mocked(executeParameterized).mockImplementation(async (_repoId, cypher) =>
      cypher.includes('n.name = $symbolQuery') ? [{ ...overlayRow, name: stale.name }] : [],
    );
    const result = await query(repo, {
      typedQuery: {
        lines: [
          { type: 'symbol', query: 'CacheStore', lineNumber: 1 },
          { type: 'graph', query: 'CacheStore', lineNumber: 2 },
        ],
        filters: [],
      },
      intent_ensemble: true,
      structured_output: true,
      include_skeleton: false,
    });
    expect(JSON.stringify(result)).not.toContain(stale.name);
    expect(executeParameterized).toHaveBeenCalledWith(
      repo.id,
      expect.stringContaining('n.name = $symbolQuery'),
      { symbolQuery: 'CacheStore' },
    );
    expect(graphTraversalRank).toHaveBeenCalled();
    expect(result).toMatchObject({
      definitions: expect.arrayContaining([{ ...overlayRow, source: 'overlay' }]),
      structured_retrieval: {
        candidates: expect.arrayContaining([expect.objectContaining({ source: 'overlay' })]),
      },
    });
  });

  it('does not reintroduce stale dirty symbols through base skeletons', async () => {
    vi.mocked(getOverlaySnapshot).mockResolvedValue(snapshot(true));
    vi.mocked(getFileSkeleton).mockImplementation(async (_repoId, filePath) =>
      filePath === stale.filePath ? stale.name! : clean.name!,
    );
    const result = await query(repo, { ...options, include_skeleton: true });
    expect(JSON.stringify(result)).not.toContain(stale.name);
    expect(getFileSkeleton).not.toHaveBeenCalledWith(repo.id, stale.filePath, expect.anything());
    expect(result).toMatchObject({ skeletons: { [clean.filePath]: clean.name } });
  });

  it('keeps base skeletons when the overlay query fails', async () => {
    vi.mocked(getOverlaySnapshot).mockResolvedValue(snapshot(true));
    vi.mocked(queryOverlay).mockRejectedValue(new Error('overlay failed'));
    await query(repo, { ...options, include_skeleton: true });
    expect(getFileSkeleton).toHaveBeenCalledWith(repo.id, stale.filePath, expect.anything());
  });

  it('suppresses deleted paths without querying an empty overlay', async () => {
    vi.mocked(getOverlaySnapshot).mockResolvedValue({
      ...snapshot(true),
      overlayPaths: new Set(),
      tombstones: new Set(['src/dirty.ts']),
    });
    const result = await query(repo, options);
    expect(result).toMatchObject({ definitions: [expect.objectContaining({ name: clean.name })] });
    expect(JSON.stringify(result)).not.toContain(stale.name);
    expect(queryOverlay).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'keeps unusable-but-dirty output byte-identical (structured=%s)',
    async (structured) => {
      const baseline = await query(repo, { ...options, structured_output: structured });
      vi.mocked(getOverlaySnapshot).mockResolvedValue(snapshot(false));
      const dirty = await query(repo, { ...options, structured_output: structured });
      expect(JSON.stringify(dirty)).toBe(JSON.stringify(baseline));
      expect(queryOverlay).not.toHaveBeenCalled();
      expect(SemanticRetrievalCache.prototype.lookup).toHaveBeenCalledTimes(structured ? 2 : 0);
      expect(SemanticRetrievalCache.prototype.set).toHaveBeenCalledTimes(structured ? 2 : 0);
    },
  );

  it('preserves structured cache hits when the dirty snapshot is unusable', async () => {
    await query(repo, { ...options, structured_output: true });
    const cached = vi.mocked(SemanticRetrievalCache.prototype.set).mock.calls[0][1];
    vi.mocked(SemanticRetrievalCache.prototype.lookup).mockResolvedValue({
      status: 'hit',
      ageMs: 25,
      result: { ...cached, timestamp: 100 },
    });
    const baseline = await query(repo, { ...options, structured_output: true });
    vi.mocked(getOverlaySnapshot).mockResolvedValue(snapshot(false));
    const dirty = await query(repo, { ...options, structured_output: true });
    expect(JSON.stringify(dirty)).toBe(JSON.stringify(baseline));
    expect(dirty).toMatchObject({ structured_retrieval: { capabilityState: { cacheHit: true } } });
    expect(queryOverlay).not.toHaveBeenCalled();
    expect(bm25Search).toHaveBeenCalledTimes(1);
  });

  it.each(['query', 'snapshot'])(
    'degrades an overlay %s error to base results with a warning',
    async (failure) => {
      const baseline = await query(repo, { ...options, structured_output: true });
      vi.mocked(getOverlaySnapshot).mockResolvedValue(snapshot(true));
      if (failure === 'query')
        vi.mocked(queryOverlay).mockRejectedValue(new Error('overlay failed'));
      else vi.mocked(getOverlaySnapshot).mockRejectedValue(new Error('overlay failed'));
      vi.mocked(SemanticRetrievalCache.prototype.lookup).mockClear();
      vi.mocked(SemanticRetrievalCache.prototype.set).mockClear();
      const result = await query(repo, { ...options, structured_output: true });
      expect(result).toMatchObject({
        definitions: baseline.definitions,
        warning: expect.stringContaining('Overlay unavailable; using base results: overlay failed'),
        structured_retrieval: {
          candidates: baseline.structured_retrieval.candidates,
          capabilityState: {
            warnings: expect.arrayContaining([expect.stringContaining('overlay failed')]),
          },
        },
      });
      expect(SemanticRetrievalCache.prototype.lookup).not.toHaveBeenCalled();
      expect(SemanticRetrievalCache.prototype.set).not.toHaveBeenCalled();
    },
  );

  it('reuses only the same automatic workspace generation', async () => {
    vi.stubEnv('ONTOINDEX_AUTO_WORKSPACE', '1');
    const selected = {
      ...snapshot(true),
      generation: 'generation-a',
      capability: 'symbols' as const,
      coverage: 'complete' as const,
    };
    vi.mocked(getOverlaySnapshot).mockResolvedValue(selected);
    await query(repo, { ...options, structured_output: true });
    const cached = vi.mocked(SemanticRetrievalCache.prototype.set).mock.calls[0][1];
    const identity = JSON.stringify(['generation-a', 'symbols', 'complete']);
    expect(cached.snapshotIdentity).toBe(identity);
    expect(queryOverlay).toHaveBeenCalledWith(
      repo,
      expect.any(String),
      expect.any(Object),
      'generation-a',
    );
    vi.mocked(SemanticRetrievalCache.prototype.lookup).mockImplementation(
      async (_key, _head, requested) =>
        requested === cached.snapshotIdentity
          ? { status: 'hit', ageMs: 25, result: { ...cached, timestamp: 100 } }
          : { status: 'miss', result: null },
    );
    const hit = await query(repo, { ...options, structured_output: true });
    expect(hit.structured_retrieval.capabilityState.cacheHit).toBe(true);
    vi.mocked(getOverlaySnapshot).mockResolvedValue({ ...selected, generation: 'generation-b' });
    await query(repo, { ...options, structured_output: true });
    const keys = vi.mocked(SemanticRetrievalCache.prototype.lookup).mock.calls.map(([key]) => key);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[2]).not.toBe(keys[0]);
    expect(bm25Search).toHaveBeenCalledTimes(2);
  });

  it.each(['snapshot', 'dirty', 'config', 'generation', 'query'])(
    'rejects automatic workspace %s failure before returning base success',
    async (failure) => {
      vi.stubEnv('ONTOINDEX_AUTO_WORKSPACE', '1');
      vi.mocked(getOverlaySnapshot).mockResolvedValue({
        ...snapshot(true),
        generation: 'generation-a',
      });
      if (failure === 'snapshot')
        vi.mocked(getOverlaySnapshot).mockRejectedValue(new Error('snapshot failed'));
      if (failure === 'dirty') vi.mocked(getOverlaySnapshot).mockResolvedValue(snapshot(false));
      if (failure === 'config')
        vi.mocked(getOverlaySnapshot).mockResolvedValue({
          ...snapshot(false, []),
          configPaths: new Set(['tsconfig.json']),
        });
      if (failure === 'generation') vi.mocked(getOverlaySnapshot).mockResolvedValue(snapshot(true));
      if (failure === 'query')
        vi.mocked(queryOverlay).mockRejectedValue(new Error('overlay failed'));
      await expect(query(repo, { ...options, structured_output: true })).rejects.toThrow();
      expect(SemanticRetrievalCache.prototype.set).not.toHaveBeenCalled();
      if (failure !== 'query')
        expect(SemanticRetrievalCache.prototype.lookup).not.toHaveBeenCalled();
    },
  );

  it.each([
    { include_content: true },
    { include_skeleton: true },
    { include_citations: true },
    { include_lsp_refs: true },
  ])('bypasses candidate-only automatic cache for enrichment %j', async (enrichment) => {
    vi.stubEnv('ONTOINDEX_AUTO_WORKSPACE', '1');
    vi.mocked(getOverlaySnapshot).mockResolvedValue({
      ...snapshot(true),
      generation: 'generation-a',
    });
    await query(repo, { ...options, ...enrichment, structured_output: true });
    expect(SemanticRetrievalCache.prototype.lookup).not.toHaveBeenCalled();
    expect(SemanticRetrievalCache.prototype.set).not.toHaveBeenCalled();
  });
});
