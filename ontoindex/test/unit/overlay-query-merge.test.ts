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
  afterEach(() => vi.restoreAllMocks());

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
        definitions: [{ name: clean.name }, { ...overlayRow, source: 'overlay' }],
        structured_retrieval: {
          candidates: [{ label: clean.name }, { label: overlayRow.name, source: 'overlay' }],
          rows: [{ label: clean.name }, { label: overlayRow.name, source: 'overlay' }],
        },
      });
      expect(JSON.stringify(result)).not.toContain(stale.name);
      expect(executeParameterized).not.toHaveBeenCalledWith(repo.id, expect.any(String), {
        nodeId: stale.nodeId,
      });
      expect(queryOverlay).toHaveBeenCalledWith(repo, expect.not.stringContaining('IN $paths'), {
        term0: 'cachestore',
      });
      expect(SemanticRetrievalCache.prototype.lookup).not.toHaveBeenCalled();
      expect(SemanticRetrievalCache.prototype.set).not.toHaveBeenCalled();
    },
  );

  it('keeps only rows from overlay paths and caps them at the search limit', async () => {
    vi.mocked(getOverlaySnapshot).mockResolvedValue(snapshot(true));
    vi.mocked(queryOverlay).mockResolvedValue([
      { ...overlayRow, id: 'x', name: 'Outside', filePath: 'src/other.ts' },
      overlayRow,
    ]);
    const result = await query(repo, { ...options, intent_ensemble: false });
    const json = JSON.stringify(result);
    expect(json).toContain(overlayRow.name);
    expect(json).not.toContain('Outside');
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
});
