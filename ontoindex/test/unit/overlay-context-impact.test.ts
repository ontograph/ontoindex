import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { pool, overlay, execFileText } = vi.hoisted(() => ({
  pool: { executeParameterized: vi.fn(), executeQuery: vi.fn() },
  overlay: {
    getOverlaySnapshot: vi.fn(),
    isDirtyPath: vi.fn((snapshot: { dirtyPaths: Set<string> }, filePath?: string) =>
      Boolean(filePath && snapshot.dirtyPaths.has(filePath.replace(/\\/g, '/'))),
    ),
    isOverlayReplacedPath: vi.fn(
      (
        snapshot: { overlayPaths: Set<string>; tombstones: Set<string> },
        filePath?: string | null,
      ) => {
        if (!filePath) return false;
        const normalized = filePath.replace(/\\/g, '/');
        return snapshot.overlayPaths.has(normalized) || snapshot.tombstones.has(normalized);
      },
    ),
    isAuthoritativePath: vi.fn(
      (snapshot: { parseErrorPaths: Set<string> }, filePath: string) =>
        !snapshot.parseErrorPaths.has(filePath.replace(/\\/g, '/')),
    ),
    queryOverlay: vi.fn(),
  },
  execFileText: vi.fn(),
}));

vi.mock('../../src/core/lbug/pool-adapter.js', () => pool);
vi.mock('../../src/mcp/local/backend-overlay.js', () => overlay);
vi.mock('../../src/core/process/exec-file.js', async (importOriginal) => ({
  ...(await importOriginal()),
  execFileText,
}));

import { context } from '../../src/mcp/local/backend-context.js';
import { runImpact } from '../../src/mcp/local/backend-impact.js';

const repo = { id: 'repo', name: 'repo', repoPath: '/repo', storagePath: '/store' };
const usable = {
  usable: true,
  reason: null,
  dirtyPaths: new Set(['src/dirty.ts']),
  overlayPaths: new Set(['src/dirty.ts']),
  uncoveredPaths: new Set<string>(),
  tombstones: new Set<string>(),
};

function symbol(filePath = 'src/dirty.ts', name = 'lookup') {
  return {
    id: `Function:${filePath}:${name}`,
    name,
    type: 'Function',
    filePath,
    startLine: 1,
    endLine: 2,
    content: `export function ${name}() {}`,
  };
}

describe('overlay context and impact', () => {
  afterEach(() => vi.unstubAllEnvs());
  beforeEach(() => {
    vi.stubEnv('ONTOINDEX_AUTO_WORKSPACE', '0');
    vi.resetAllMocks();
    overlay.isDirtyPath.mockImplementation((snapshot, filePath) =>
      Boolean(filePath && snapshot.dirtyPaths.has(filePath.replace(/\\/g, '/'))),
    );
    overlay.isOverlayReplacedPath.mockImplementation((snapshot, filePath) => {
      if (!filePath) return false;
      const normalized = filePath.replace(/\\/g, '/');
      return snapshot.overlayPaths.has(normalized) || snapshot.tombstones.has(normalized);
    });
    overlay.isAuthoritativePath.mockImplementation(
      (snapshot, filePath) => !snapshot.parseErrorPaths.has(filePath.replace(/\\/g, '/')),
    );
    pool.executeParameterized.mockResolvedValue([]);
    pool.executeQuery.mockResolvedValue([]);
    overlay.getOverlaySnapshot.mockResolvedValue(usable);
    overlay.queryOverlay.mockResolvedValue([]);
    execFileText.mockResolvedValue('');
  });

  it.each(['name', 'uid'] as const)(
    'returns overlay context by %s without base relationship or process queries',
    async (selector) => {
      const current = symbol();
      // A matching stale base ID must not resurrect its relationships.
      pool.executeParameterized.mockResolvedValue([current]);
      overlay.queryOverlay.mockResolvedValue([current]);

      const result = await context(repo, {
        [selector]: selector === 'uid' ? current.id : current.name,
        include_content: true,
      });

      expect(result).toMatchObject({
        status: 'found',
        source: 'overlay',
        symbol: {
          nodeId: current.id,
          uid: current.id,
          name: current.name,
          filePath: current.filePath,
          startLine: 1,
          endLine: 2,
          content: current.content,
          source: 'overlay',
        },
        incoming: {},
        outgoing: {},
        processes: [],
        concepts: [],
        warnings: [expect.stringMatching(/relationships.*unavailable.*uncommitted/i)],
        contextCompleteness: {
          sourceIncluded: true,
          missingReasons: ['relationships-unavailable-for-uncommitted-symbols'],
        },
      });
      expect(pool.executeParameterized).toHaveBeenCalledTimes(1);
      expect(pool.executeParameterized.mock.calls[0][1]).not.toContain('CodeRelation');
      expect(overlay.queryOverlay).toHaveBeenCalledWith(
        { id: repo.id, repoPath: repo.repoPath, storagePath: repo.storagePath },
        expect.any(String),
        expect.any(Object),
        undefined,
      );
    },
  );

  it.each([false, true])(
    'uses workspace graph relationships (parse error: %s)',
    async (parseError) => {
      vi.stubEnv('ONTOINDEX_AUTO_WORKSPACE', '1');
      const current = symbol();
      overlay.getOverlaySnapshot.mockResolvedValue({
        ...usable,
        capability: 'workspace-graph',
        coverage: parseError ? 'partial' : 'complete',
        generation: 'workspace-generation',
        parseErrorPaths: new Set(parseError ? [current.filePath] : []),
      });
      overlay.queryOverlay.mockImplementation(async (_repo, query: string) => {
        if (query.includes('AS startLine')) return [current];
        if (query.includes('AS relType'))
          return [
            {
              relType: 'CALLS',
              uid: 'neighbor',
              name: 'neighbor',
              filePath: 'src/other.ts',
              kind: 'Function',
            },
          ];
        return [];
      });
      const result = await context(repo, { name: current.name });
      expect(result).toMatchObject({
        source: 'workspace-graph',
        graphImpactAvailable: !parseError,
        incoming: { calls: [{ uid: 'neighbor' }] },
        outgoing: { calls: [{ uid: 'neighbor' }] },
      });
      expect(pool.executeParameterized).not.toHaveBeenCalled();
      expect(overlay.queryOverlay).toHaveBeenCalledWith(
        expect.objectContaining({ id: repo.id }),
        expect.stringContaining('AS relType'),
        { symId: current.id },
        'workspace-generation',
      );
      if (parseError)
        expect(result).toMatchObject({
          warnings: ['Symbol file failed to parse; relationships may be incomplete'],
          contextCompleteness: { missingReasons: expect.arrayContaining(['parse-error-file']) },
        });
    },
  );

  it.each(['upstream', 'downstream'] as const)(
    'reports UNKNOWN for an overlay-only %s target before source fallback or BFS',
    async (direction) => {
      const current = symbol();
      overlay.queryOverlay.mockResolvedValue([current]);
      // If the source fallback runs first, this returns deleted-file instead.
      execFileText.mockResolvedValue(' D src/dirty.ts\n');

      const result = await runImpact(repo, {
        target: current.name,
        file_path: current.filePath,
        direction,
      });

      expect(result).toMatchObject({
        target: { id: current.id, filePath: current.filePath, source: 'overlay' },
        source: 'overlay',
        direction,
        risk: 'UNKNOWN',
        graphImpactAvailable: false,
        impacted: [],
        byDepth: {},
        message: expect.stringMatching(/unavailable.*uncommitted.*not mean zero callers/i),
      });
      expect(result).not.toHaveProperty('summary');
      expect(result).not.toHaveProperty('rawCounts');
      expect(execFileText).not.toHaveBeenCalled();
      expect(pool.executeQuery).not.toHaveBeenCalled();
      expect(pool.executeParameterized).toHaveBeenCalledTimes(1);
    },
  );

  it('preserves overlay provenance on ambiguous context and impact candidates', async () => {
    pool.executeParameterized.mockResolvedValue([symbol('src/clean.ts')]);
    overlay.queryOverlay.mockResolvedValue([symbol()]);

    for (const result of [
      await context(repo, { name: 'lookup' }),
      await runImpact(repo, { target: 'lookup', direction: 'upstream' }),
    ]) {
      expect(result).toMatchObject({
        status: 'ambiguous',
        candidates: [{ filePath: 'src/clean.ts' }, { filePath: 'src/dirty.ts', source: 'overlay' }],
      });
    }
    expect(pool.executeQuery).not.toHaveBeenCalled();
  });

  it('keeps base rows for uncovered dirty paths and drops overlay-covered base rows', async () => {
    const uncovered = symbol('src/dirty.ts');
    const replaced = symbol('src/replaced.ts');
    overlay.getOverlaySnapshot.mockResolvedValue({
      ...usable,
      dirtyPaths: new Set(['src/dirty.ts', 'src/replaced.ts']),
      overlayPaths: new Set(['src/replaced.ts']),
      uncoveredPaths: new Set(['src/dirty.ts']),
    });
    pool.executeParameterized.mockImplementation(async (_id, query: string) =>
      query.includes('AS startLine') ? [uncovered, replaced] : [],
    );

    const result = await context(repo, { name: 'lookup' });

    expect(result).toMatchObject({ status: 'found', symbol: { filePath: 'src/dirty.ts' } });
    expect(result).not.toMatchObject({ symbol: { filePath: 'src/replaced.ts' } });
  });

  it.each(['object', 'tuple'] as const)(
    'keeps source overlay on %s neighbor identities',
    async (format) => {
      const current = symbol('src/clean.ts');
      const neighbor =
        format === 'object'
          ? {
              relType: 'CALLS',
              uid: 'neighbor',
              name: 'neighbor',
              filePath: 'src/dirty.ts',
              kind: 'Function',
              source: 'overlay',
            }
          : ['CALLS', 'neighbor', 'neighbor', 'src/dirty.ts', 'Function', 'overlay'];
      pool.executeParameterized.mockImplementation(async (_id, query: string) =>
        query.includes('AS relType') ? [neighbor] : query.includes('AS startLine') ? [current] : [],
      );

      expect(await context(repo, { name: current.name })).toMatchObject({
        incoming: { calls: [{ uid: 'neighbor', source: 'overlay' }] },
        outgoing: { calls: [{ uid: 'neighbor', source: 'overlay' }] },
      });
    },
  );

  it('keeps clean-path context and impact results identical to base-only results', async () => {
    const current = symbol('src/clean.ts');
    pool.executeParameterized.mockImplementation(async (_id, query: string) =>
      query.includes('AS startLine') ? [current] : [],
    );

    const overlayContext = await context(repo, { name: current.name });
    const overlayImpact = await runImpact(repo, { target: current.name, direction: 'upstream' });
    overlay.getOverlaySnapshot.mockResolvedValue({ ...usable, usable: false });

    expect(await context(repo, { name: current.name })).toEqual(overlayContext);
    expect(await runImpact(repo, { target: current.name, direction: 'upstream' })).toEqual(
      overlayImpact,
    );
    expect(overlayContext).not.toHaveProperty('source');
    expect(overlayImpact).toMatchObject({ risk: 'LOW', byDepth: {} });
    expect(overlayImpact).not.toHaveProperty('source');
  });

  it('retains the source fallback before resolution when the snapshot is unusable', async () => {
    overlay.getOverlaySnapshot.mockResolvedValue({ ...usable, usable: false });
    execFileText.mockResolvedValue(' D src/dirty.ts\n');

    expect(
      await runImpact(repo, {
        target: 'lookup',
        file_path: 'src/dirty.ts',
        direction: 'upstream',
      }),
    ).toMatchObject({
      risk: 'UNKNOWN',
      graphImpactAvailable: false,
      resolutionReason: 'deleted-file',
    });
    expect(pool.executeParameterized).not.toHaveBeenCalled();
    expect(pool.executeQuery).not.toHaveBeenCalled();
    expect(overlay.queryOverlay).not.toHaveBeenCalled();
  });

  it('degrades snapshot errors to base behavior', async () => {
    const current = symbol();
    pool.executeParameterized.mockImplementation(async (_id, query: string) =>
      query.includes('AS startLine') ? [current] : [],
    );
    overlay.getOverlaySnapshot.mockResolvedValue({ ...usable, usable: false });
    const baseContext = await context(repo, { name: current.name });
    const baseImpact = await runImpact(repo, { target: current.name, direction: 'upstream' });
    overlay.getOverlaySnapshot.mockRejectedValue(new Error('snapshot'));

    expect(await context(repo, { name: current.name })).toEqual(baseContext);
    expect(await runImpact(repo, { target: current.name, direction: 'upstream' })).toEqual(
      baseImpact,
    );
  });

  it('fails closed on automatic snapshot errors before base resolution', async () => {
    vi.stubEnv('ONTOINDEX_AUTO_WORKSPACE', '1');
    overlay.getOverlaySnapshot.mockRejectedValue(new Error('captured graph unavailable'));

    await expect(context(repo, { name: 'lookup' })).rejects.toThrow('captured graph unavailable');
    expect(await runImpact(repo, { target: 'lookup', direction: 'upstream' })).toMatchObject({
      risk: 'UNKNOWN',
      error: 'captured graph unavailable',
    });
    expect(pool.executeParameterized).not.toHaveBeenCalled();
    expect(execFileText).not.toHaveBeenCalled();
  });

  it.each(['source', 'configuration'])(
    'fails closed when automatic snapshot preparation omitted dirty %s',
    async (change) => {
      vi.stubEnv('ONTOINDEX_AUTO_WORKSPACE', '1');
      overlay.getOverlaySnapshot.mockResolvedValue({
        ...usable,
        usable: false,
        reason: 'snapshot unavailable',
        dirtyPaths: new Set(change === 'source' ? ['src/dirty.ts'] : []),
        configPaths: new Set(change === 'configuration' ? ['tsconfig.json'] : []),
      });
      await expect(context(repo, { name: 'lookup' })).rejects.toThrow('snapshot unavailable');
      expect(await runImpact(repo, { target: 'lookup', direction: 'upstream' })).toMatchObject({
        risk: 'UNKNOWN',
        error: 'snapshot unavailable',
      });
      expect(pool.executeParameterized).not.toHaveBeenCalled();
      expect(execFileText).not.toHaveBeenCalled();
    },
  );

  it.each(['missing', 'deleted', 'parse-error'])(
    'does not resolve automatic %s targets from later live files',
    async (failure) => {
      vi.stubEnv('ONTOINDEX_AUTO_WORKSPACE', '1');
      const current = symbol();
      overlay.getOverlaySnapshot.mockResolvedValue({
        ...usable,
        capability: 'workspace-graph',
        coverage: failure === 'parse-error' ? 'partial' : 'complete',
        generation: 'captured-A',
        parseErrorPaths: new Set(failure === 'parse-error' ? [current.filePath] : []),
        tombstones: new Set(failure === 'deleted' ? [current.filePath] : []),
      });
      overlay.queryOverlay.mockImplementation(async (_repo, query: string) =>
        failure === 'parse-error' && query.includes('AS startLine') ? [current] : [],
      );
      execFileText.mockResolvedValue(' M src/dirty.ts\n');
      expect(
        await runImpact(repo, {
          target: current.name,
          file_path: current.filePath,
          direction: 'upstream',
        }),
      ).toMatchObject({ risk: 'UNKNOWN', graphImpactAvailable: false });
      expect(execFileText).not.toHaveBeenCalled();
      expect(pool.executeParameterized).not.toHaveBeenCalled();
    },
  );

  it('keeps captured context content and edges on the selected generation after publication', async () => {
    vi.stubEnv('ONTOINDEX_AUTO_WORKSPACE', '1');
    const captured = { ...symbol(), content: 'export function lookup() { return "A"; }' };
    const snapshot = {
      ...usable,
      capability: 'workspace-graph',
      coverage: 'complete',
      generation: 'captured-A',
      parseErrorPaths: new Set<string>(),
    };
    overlay.getOverlaySnapshot.mockResolvedValue(snapshot);
    overlay.queryOverlay.mockImplementation(async (_repo, query: string, _params, generation) => {
      expect(generation).toBe('captured-A');
      overlay.getOverlaySnapshot.mockResolvedValue({ ...snapshot, generation: 'published-C' });
      if (query.includes('AS startLine')) return [captured];
      if (query.includes('AS relType'))
        return [
          {
            relType: 'CALLS',
            uid: 'captured-neighbor',
            name: 'capturedNeighbor',
            filePath: 'src/neighbor.ts',
            kind: 'Function',
          },
        ];
      return [];
    });
    expect(await context(repo, { name: captured.name, include_content: true })).toMatchObject({
      symbol: { content: captured.content },
      incoming: { calls: [{ uid: 'captured-neighbor' }] },
    });
    expect(pool.executeParameterized).not.toHaveBeenCalled();
    expect(overlay.getOverlaySnapshot).toHaveBeenCalledTimes(1);
    expect(execFileText).not.toHaveBeenCalled();
  });

  it('rejects instead of returning stale base answers when a usable overlay query fails', async () => {
    const current = symbol();
    pool.executeParameterized.mockImplementation(async (_id, query: string) =>
      query.includes('AS startLine') ? [current] : [],
    );
    overlay.getOverlaySnapshot.mockResolvedValue(usable);
    overlay.queryOverlay.mockRejectedValue(new Error('overlay query'));

    // Context rejects; impact reports the same failure as an error response. Neither returns
    // the stale base answer.
    await expect(context(repo, { name: current.name })).rejects.toThrow('overlay query');
    expect(await runImpact(repo, { target: current.name, direction: 'upstream' })).toMatchObject({
      error: 'overlay query',
    });
  });
});
