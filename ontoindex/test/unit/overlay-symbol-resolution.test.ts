import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { pool, overlay } = vi.hoisted(() => ({
  pool: { executeParameterized: vi.fn() },
  overlay: {
    getOverlaySnapshot: vi.fn(),
    isDirtyPath: vi.fn((snapshot: { dirtyPaths: Set<string> }, filePath?: string) =>
      Boolean(filePath && snapshot.dirtyPaths.has(filePath)),
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
}));

vi.mock('../../src/core/lbug/pool-adapter.js', () => pool);
vi.mock('../../src/mcp/local/backend-overlay.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/mcp/local/backend-overlay.js')>()),
  ...overlay,
}));

import {
  readNodeContent,
  resolveSymbolCandidates,
} from '../../src/mcp/local/backend-symbol-resolution.js';
import { CONTENT_NODE_TABLES, SCHEMA_QUERIES } from '../../src/core/lbug/schema.js';
import type { OverlaySnapshot } from '../../src/mcp/local/backend-overlay.js';

const repo = { id: 'repo', repoPath: '/repo', storagePath: '/store' };
const usable = {
  usable: true,
  reason: undefined,
  dirtyPaths: new Set(['src/dirty.ts']),
  overlayPaths: new Set(['src/dirty.ts']),
  uncoveredPaths: new Set<string>(),
  tombstones: new Set<string>(),
};
const unusable = {
  usable: false,
  reason: undefined,
  dirtyPaths: new Set(['src/dirty.ts']),
  overlayPaths: new Set<string>(),
  uncoveredPaths: new Set(['src/dirty.ts']),
  tombstones: new Set<string>(),
};

function row(id: string, filePath: string, name = 'lookup') {
  return {
    id,
    name,
    type: 'Function',
    filePath,
    startLine: 1,
    endLine: 2,
  };
}

describe('symbol resolution with a dirty overlay', () => {
  afterEach(() => vi.unstubAllEnvs());
  beforeEach(() => {
    vi.stubEnv('ONTOINDEX_AUTO_WORKSPACE', '0');
    vi.clearAllMocks();
    pool.executeParameterized.mockResolvedValue([]);
    overlay.getOverlaySnapshot.mockResolvedValue(usable);
    overlay.queryOverlay.mockResolvedValue([]);
  });

  it('keeps the content table allowlist aligned with the node DDL', () => {
    const tables = SCHEMA_QUERIES.filter(
      (ddl) => /CREATE NODE TABLE\b/.test(ddl) && /\bcontent\s+STRING\b/.test(ddl),
    ).map((ddl) => ddl.match(/CREATE NODE TABLE\s+`?(\w+)`?\s*\(/)![1]);
    expect([...CONTENT_NODE_TABLES].sort()).toEqual(tables.sort());
  });

  it.each([{ uid: 'base-id' }, { name: 'lookup' }])(
    'resolves %o without an unlabeled content projection',
    async (query) => {
      pool.executeParameterized.mockImplementation(async (_repo, cypher) => {
        if (cypher.includes('.content') && !cypher.includes('(n:`Function`')) {
          throw new Error(
            'Buffer manager exception: buffer pool is full and no memory could be freed',
          );
        }
        return cypher.includes('.content')
          ? [{ content: 'function lookup() { return 1; }' }]
          : [row('base-id', 'src/clean.ts')];
      });

      const result = await resolveSymbolCandidates(repo, { ...query, include_content: true }, {});

      expect(result).toMatchObject({
        kind: 'ok',
        symbol: { id: 'base-id', content: 'function lookup() { return 1; }' },
      });
      expect(pool.executeParameterized).toHaveBeenCalledTimes(2);
      expect(pool.executeParameterized.mock.calls[0][1]).not.toContain('.content');
      expect(pool.executeParameterized.mock.calls[1]).toEqual([
        repo.id,
        'MATCH (n:`Function` {id: $id}) RETURN n.content AS content LIMIT 1',
        { id: 'base-id' },
      ]);
    },
  );

  it.each([{ uid: 'base-id' }, { name: 'lookup' }])(
    'does not hydrate a single candidate for %o without requested content',
    async (query) => {
      pool.executeParameterized.mockResolvedValue([row('base-id', 'src/clean.ts')]);
      const result = await resolveSymbolCandidates(repo, { ...query, include_content: false }, {});
      expect(result).toMatchObject({ kind: 'ok', symbol: { id: 'base-id' } });
      if (result.kind === 'ok') expect(result.symbol).not.toHaveProperty('content');
      expect(pool.executeParameterized).toHaveBeenCalledTimes(1);
      expect(
        [...pool.executeParameterized.mock.calls, ...overlay.queryOverlay.mock.calls].every(
          (call) => !call[1].includes('.content'),
        ),
      ).toBe(true);
    },
  );

  it.each([false, true])(
    'hydrates ranking through each candidate executor once (include_content=%s)',
    async (include_content) => {
      const snapshot: OverlaySnapshot = {
        ...usable,
        reason: null,
        parseErrorPaths: new Set(),
        generation: 'pinned-content',
      };
      pool.executeParameterized.mockImplementation(async (_repo, cypher) =>
        cypher.includes('.content')
          ? [{ content: 'function lookup();' }]
          : [row('base-id', 'src/clean.ts')],
      );
      overlay.queryOverlay.mockImplementation(async (_repo, cypher) =>
        cypher.includes('.content')
          ? [{ content: 'function lookup() { return 1; }' }]
          : [row('overlay-id', 'src/dirty.ts')],
      );

      const result = await resolveSymbolCandidates(
        repo,
        { name: 'lookup', include_content },
        {},
        { snapshot },
      );

      expect(result.kind).toBe('ambiguous');
      if (result.kind !== 'ambiguous') throw new Error('expected ranked candidates');
      expect(result.candidates.map((candidate) => candidate.id)).toEqual(['overlay-id', 'base-id']);
      expect(result.candidates[0].score).toBeGreaterThan(result.candidates[1].score);
      if (include_content) {
        expect(result.candidates.map((candidate) => candidate.content)).toEqual([
          'function lookup() { return 1; }',
          'function lookup();',
        ]);
      } else {
        expect(result.candidates.every((candidate) => !('content' in candidate))).toBe(true);
      }
      expect(pool.executeParameterized).toHaveBeenCalledTimes(2);
      expect(overlay.queryOverlay).toHaveBeenCalledTimes(2);
      expect(pool.executeParameterized.mock.calls[1][2]).toEqual({ id: 'base-id' });
      expect(overlay.queryOverlay.mock.calls[1]).toEqual([
        repo,
        'MATCH (n:`Function` {id: $id}) RETURN n.content AS content LIMIT 1',
        { id: 'overlay-id' },
        snapshot.generation,
      ]);
      expect(overlay.queryOverlay.mock.calls.every((call) => call[3] === snapshot.generation)).toBe(
        true,
      );
    },
  );

  it.each(['Class', 'Interface'])(
    'hydrates the preferred %s when content is requested',
    async (type) => {
      pool.executeParameterized.mockImplementation(async (_repo, cypher) => {
        if (cypher.includes('.content')) return [{ content: `${type} Widget {}` }];
        if (cypher.includes('candidateIds'))
          return cypher.includes(`\`${type}\``) ? [{ id: 'preferred' }] : [];
        return [
          { ...row('preferred', 'src/clean.ts', 'Widget'), type },
          { ...row('constructor', 'src/clean.ts', 'Widget'), type: 'Constructor' },
        ];
      });
      const result = await resolveSymbolCandidates(
        repo,
        { name: 'Widget', include_content: true },
        {},
      );
      expect(result).toMatchObject({
        kind: 'ok',
        symbol: { id: 'preferred', content: `${type} Widget {}` },
      });
      expect(
        pool.executeParameterized.mock.calls.filter((call) => call[1].includes('.content')),
      ).toHaveLength(1);
    },
  );

  it.each([{ uid: 'overlay-id' }, { name: 'lookup' }])(
    'hydrates a sole overlay candidate for %o using its pinned generation',
    async (query) => {
      const snapshot: OverlaySnapshot = {
        ...usable,
        reason: null,
        parseErrorPaths: new Set(),
        generation: 'overlay-content',
      };
      overlay.queryOverlay.mockImplementation(async (_repo, cypher) =>
        cypher.includes('.content')
          ? [{ content: 'overlay body' }]
          : [row('overlay-id', 'src/dirty.ts')],
      );
      const result = await resolveSymbolCandidates(
        repo,
        { ...query, include_content: true },
        {},
        { snapshot },
      );
      expect(result).toMatchObject({
        kind: 'ok',
        symbol: { source: 'overlay', content: 'overlay body' },
      });
      expect(overlay.queryOverlay).toHaveBeenCalledTimes(2);
      expect(overlay.queryOverlay.mock.calls.every((call) => call[3] === snapshot.generation)).toBe(
        true,
      );
      expect(pool.executeParameterized).toHaveBeenCalledTimes(1);
    },
  );

  it('does not query content for a label without that column or an untrusted label', async () => {
    const run = vi.fn();
    expect(await readNodeContent(run, 'Route', 'route-id')).toBeUndefined();
    expect(await readNodeContent(run, 'Function`) RETURN n //', 'bad-id')).toBeUndefined();
    expect(run).not.toHaveBeenCalled();
    pool.executeParameterized.mockResolvedValue([
      { ...row('route-id', 'src/clean.ts'), type: 'Route' },
    ]);
    await expect(
      resolveSymbolCandidates(repo, { name: 'lookup', include_content: true }, {}),
    ).resolves.toMatchObject({ kind: 'ok', symbol: { id: 'route-id', content: undefined } });
    expect(pool.executeParameterized).toHaveBeenCalledTimes(1);
  });

  it('reads positional content rows and handles a missing content row', async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce([['body']])
      .mockResolvedValueOnce([]);
    expect(await readNodeContent(run, 'Function', 'id')).toBe('body');
    expect(await readNodeContent(run, 'Function', 'missing')).toBeUndefined();
  });

  it('resolves a name defined only in a dirty file from the overlay', async () => {
    overlay.queryOverlay.mockResolvedValue([row('overlay-id', 'src/dirty.ts')]);

    const result = await resolveSymbolCandidates(repo, { name: 'lookup' }, {});

    expect(result).toMatchObject({
      kind: 'ok',
      symbol: { id: 'overlay-id', type: 'Function', filePath: 'src/dirty.ts', source: 'overlay' },
      resolvedLabel: 'Function',
    });
    expect(pool.executeParameterized).toHaveBeenCalledTimes(1);
    expect(overlay.queryOverlay).toHaveBeenCalledWith(
      expect.objectContaining({
        id: repo.id,
        repoPath: repo.repoPath,
        storagePath: repo.storagePath,
      }),
      expect.stringContaining('label(n) AS type'),
      { symName: 'lookup' },
      undefined,
    );
  });

  it('returns not_found when a dirty base symbol is tombstoned and absent from overlay', async () => {
    pool.executeParameterized.mockResolvedValue([row('deleted-id', 'src/dirty.ts')]);

    const result = await resolveSymbolCandidates(repo, { name: 'lookup' }, {});

    expect(result).toEqual({ kind: 'not_found' });
  });

  it('reports ambiguity between a clean base symbol and a dirty overlay symbol', async () => {
    pool.executeParameterized.mockResolvedValue([row('base-id', 'src/clean.ts')]);
    overlay.queryOverlay.mockResolvedValue([row('overlay-id', 'src/dirty.ts')]);

    const result = await resolveSymbolCandidates(repo, { name: 'lookup' }, {});

    expect(result).toMatchObject({ kind: 'ambiguous' });
    if (result.kind === 'ambiguous') {
      expect(result.candidates.map(({ id, source }) => ({ id, source }))).toEqual([
        { id: 'base-id', source: undefined },
        { id: 'overlay-id', source: 'overlay' },
      ]);
    }
  });

  it('ignores overlay symbols from a reverted file while another file remains dirty', async () => {
    pool.executeParameterized.mockResolvedValue([row('base-id', 'src/clean.ts')]);
    overlay.queryOverlay.mockResolvedValue([row('phantom-id', 'src/clean.ts')]);

    const result = await resolveSymbolCandidates(repo, { name: 'lookup' }, {});

    expect(result).toMatchObject({ kind: 'ok', symbol: { id: 'base-id' } });
  });

  it('rejects when the overlay disappears after a usable snapshot', async () => {
    pool.executeParameterized.mockResolvedValue([row('base-id', 'src/dirty.ts')]);
    overlay.queryOverlay.mockRejectedValueOnce(new Error('no published overlay'));

    await expect(resolveSymbolCandidates(repo, { name: 'lookup' }, {})).rejects.toThrow(
      'no published overlay',
    );
  });

  it.each([{ name: 'lookup' }, { uid: 'overlay-id' }])(
    'uses the explicit snapshot for %o without rereading CURRENT',
    async (query) => {
      const snapshot: OverlaySnapshot = {
        ...usable,
        reason: null,
        parseErrorPaths: new Set(),
        generation: 'pinned-generation',
      };
      overlay.queryOverlay.mockResolvedValue([row('overlay-id', 'src/dirty.ts')]);

      const result = await resolveSymbolCandidates(repo, query, {}, { snapshot });

      expect(result).toMatchObject({ kind: 'ok', symbol: { id: 'overlay-id', source: 'overlay' } });
      expect(overlay.getOverlaySnapshot).not.toHaveBeenCalled();
      expect(overlay.queryOverlay.mock.calls[0][3]).toBe('pinned-generation');
    },
  );

  it('resolves only the new name of a renamed symbol in the explicit snapshot', async () => {
    const snapshot: OverlaySnapshot = {
      ...usable,
      reason: null,
      parseErrorPaths: new Set(),
      tombstones: new Set(['src/old.ts']),
    };
    pool.executeParameterized.mockImplementation(async (_repo, _cypher, params) =>
      params.symName === 'oldName' ? [row('old-id', 'src/old.ts', 'oldName')] : [],
    );
    overlay.queryOverlay.mockImplementation(async (_repo, _cypher, params) =>
      params.symName === 'newName' ? [row('new-id', 'src/dirty.ts', 'newName')] : [],
    );

    await expect(
      resolveSymbolCandidates(repo, { name: 'oldName' }, {}, { snapshot }),
    ).resolves.toEqual({ kind: 'not_found', warning: 'Deleted source path(s): src/old.ts' });
    await expect(
      resolveSymbolCandidates(repo, { name: 'newName' }, {}, { snapshot }),
    ).resolves.toMatchObject({ kind: 'ok', symbol: { id: 'new-id', name: 'newName' } });
  });

  it('propagates a generation mismatch instead of returning a base identity', async () => {
    pool.executeParameterized.mockResolvedValue([row('base-id', 'src/clean.ts')]);
    overlay.queryOverlay.mockRejectedValue(
      new Error('overlay generation changed since the snapshot was validated'),
    );
    const snapshot: OverlaySnapshot = {
      ...usable,
      reason: null,
      parseErrorPaths: new Set(),
      generation: 'pinned',
    };

    await expect(
      resolveSymbolCandidates(repo, { name: 'lookup' }, {}, { snapshot }),
    ).rejects.toThrow('overlay generation changed since the snapshot was validated');
  });

  it('keeps base-only resolution for an explicit unusable snapshot without querying overlay', async () => {
    const snapshot: OverlaySnapshot = { ...unusable, reason: null, parseErrorPaths: new Set() };
    pool.executeParameterized.mockResolvedValue([row('base-id', 'src/dirty.ts')]);
    overlay.queryOverlay.mockRejectedValue(new Error('no published overlay'));

    await expect(
      resolveSymbolCandidates(repo, { name: 'lookup' }, {}, { snapshot }),
    ).resolves.toMatchObject({ kind: 'ok', symbol: { id: 'base-id' } });
    expect(overlay.getOverlaySnapshot).not.toHaveBeenCalled();
    expect(overlay.queryOverlay).not.toHaveBeenCalled();
  });

  it('preserves base-only behavior for an unusable snapshot', async () => {
    pool.executeParameterized.mockResolvedValue([row('base-id', 'src/dirty.ts')]);
    overlay.getOverlaySnapshot.mockResolvedValue(unusable);

    const result = await resolveSymbolCandidates(repo, { name: 'lookup' }, {});

    expect(result).toMatchObject({
      kind: 'ok',
      symbol: { id: 'base-id', filePath: 'src/dirty.ts' },
    });
    expect(overlay.queryOverlay).not.toHaveBeenCalled();
  });

  it('removes a deleted base candidate even for an unusable snapshot', async () => {
    pool.executeParameterized.mockResolvedValue([row('deleted-id', 'src/deleted.ts')]);
    overlay.getOverlaySnapshot.mockResolvedValue({
      ...unusable,
      tombstones: new Set(['src/deleted.ts']),
    });

    const result = await resolveSymbolCandidates(repo, { name: 'lookup' }, {});

    expect(result).toMatchObject({
      kind: 'not_found',
      warning: expect.stringContaining('src/deleted.ts'),
    });
  });
  it.each([{ name: 'lookup' }, { uid: 'workspace-id' }])(
    'uses the complete workspace graph for %o and drops all base rows',
    async (query) => {
      vi.stubEnv('ONTOINDEX_AUTO_WORKSPACE', '1');
      const snapshot: OverlaySnapshot = {
        ...usable,
        reason: null,
        parseErrorPaths: new Set(),
        capability: 'workspace-graph',
        generation: 'workspace-generation',
      };
      pool.executeParameterized.mockResolvedValue([row('stale-id', 'src/clean.ts')]);
      overlay.queryOverlay.mockResolvedValue([row('workspace-id', 'src/clean.ts')]);
      const result = await resolveSymbolCandidates(repo, query, {}, { snapshot });
      expect(result).toMatchObject({
        kind: 'ok',
        symbol: {
          id: 'workspace-id',
          source: 'overlay',
          graph: 'workspace-graph',
        },
      });
      if (result.kind === 'ok') expect(result.snapshot).toBe(snapshot);
      expect(pool.executeParameterized).not.toHaveBeenCalled();
    },
  );

  it('prefers a new workspace Class over its Constructor using the workspace graph', async () => {
    vi.stubEnv('ONTOINDEX_AUTO_WORKSPACE', '1');
    const snapshot: OverlaySnapshot = {
      ...usable,
      reason: null,
      parseErrorPaths: new Set(),
      capability: 'workspace-graph',
      generation: 'workspace-generation',
    };
    pool.executeParameterized.mockResolvedValue([]);
    overlay.queryOverlay.mockImplementation(async (_repo, cypher, params) => {
      if (params.symName)
        return [
          { ...row('Class:new', 'src/dirty.ts', 'Widget'), type: 'Class' },
          { ...row('Constructor:new', 'src/dirty.ts', 'Widget'), type: 'Constructor' },
        ];
      if (cypher.includes('`Class`')) return [{ id: 'Class:new' }];
      return [];
    });
    const result = await resolveSymbolCandidates(repo, { name: 'Widget' }, {}, { snapshot });
    expect(result).toMatchObject({
      kind: 'ok',
      symbol: { id: 'Class:new' },
      resolvedLabel: 'Class',
    });
  });

  it('excludes tombstones from the complete workspace graph with a deletion warning', async () => {
    const snapshot: OverlaySnapshot = {
      ...usable,
      reason: null,
      parseErrorPaths: new Set(),
      capability: 'workspace-graph',
      tombstones: new Set(['src/deleted.ts']),
    };
    pool.executeParameterized.mockResolvedValue([row('deleted-id', 'src/deleted.ts')]);
    overlay.queryOverlay.mockResolvedValue([row('deleted-id', 'src/deleted.ts')]);
    await expect(
      resolveSymbolCandidates(repo, { name: 'lookup' }, {}, { snapshot }),
    ).resolves.toEqual({ kind: 'not_found', warning: 'Deleted source path(s): src/deleted.ts' });
  });

  it('excludes tombstones from the automatic workspace graph without querying base', async () => {
    vi.stubEnv('ONTOINDEX_AUTO_WORKSPACE', '1');
    const snapshot: OverlaySnapshot = {
      ...usable,
      reason: null,
      parseErrorPaths: new Set(),
      capability: 'workspace-graph',
      tombstones: new Set(['src/deleted.ts']),
    };
    pool.executeParameterized.mockResolvedValue([row('deleted-id', 'src/deleted.ts')]);
    overlay.queryOverlay.mockResolvedValue([row('deleted-id', 'src/deleted.ts')]);

    await expect(
      resolveSymbolCandidates(repo, { name: 'lookup' }, {}, { snapshot }),
    ).resolves.toEqual({ kind: 'not_found' });
    expect(pool.executeParameterized).not.toHaveBeenCalled();
    expect(overlay.queryOverlay).toHaveBeenCalled();
  });

  it('traverses workspace callers of an unchanged symbol through the pinned graph', async () => {
    vi.stubEnv('ONTOINDEX_AUTO_WORKSPACE', '1');
    const { runImpact } = await import('../../src/mcp/local/backend-impact.js');
    const snapshot: OverlaySnapshot = {
      ...usable,
      reason: null,
      parseErrorPaths: new Set(),
      capability: 'workspace-graph',
      generation: 'workspace-generation',
    };
    overlay.getOverlaySnapshot.mockResolvedValue(snapshot);
    pool.executeParameterized.mockResolvedValue([row('base-id', 'src/clean.ts')]);
    overlay.queryOverlay.mockImplementation(async (_repo, cypher, params) => {
      if (params.symName) return [row('workspace-id', 'src/clean.ts')];
      if (cypher.includes('RETURN n.id AS sourceId'))
        return [
          {
            sourceId: 'workspace-id',
            id: 'caller-id',
            name: 'caller',
            type: 'Function',
            filePath: 'src/dirty.ts',
            relType: 'CALLS',
            confidence: 0.9,
          },
        ];
      return [];
    });
    const result = await runImpact(
      { ...repo, name: 'repo' },
      {
        target: 'lookup',
        direction: 'upstream',
        maxDepth: 1,
      },
    );
    expect(result).toMatchObject({
      source: 'workspace-graph',
      graphImpactAvailable: true,
      impactedCount: 1,
      byDepth: { 1: [{ id: 'caller-id' }] },
    });
    expect(overlay.queryOverlay.mock.calls.every((call) => call[3] === snapshot.generation)).toBe(
      true,
    );
    expect(pool.executeParameterized).not.toHaveBeenCalled();
  });

  it('refuses authoritative impact when a workspace target failed parsing', async () => {
    vi.stubEnv('ONTOINDEX_AUTO_WORKSPACE', '1');
    const { runImpact } = await import('../../src/mcp/local/backend-impact.js');
    overlay.getOverlaySnapshot.mockResolvedValue({
      ...usable,
      capability: 'workspace-graph',
      parseErrorPaths: new Set(['src/dirty.ts']),
    });
    overlay.queryOverlay.mockResolvedValue([row('workspace-id', 'src/dirty.ts')]);
    const result = await runImpact(
      { ...repo, name: 'repo' },
      {
        target: 'lookup',
        direction: 'upstream',
      },
    );
    expect(result).toMatchObject({
      source: 'workspace-graph',
      risk: 'UNKNOWN',
      graphImpactAvailable: false,
      error: expect.stringContaining('not proof of zero impact'),
    });
  });
});
