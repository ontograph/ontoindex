import { beforeEach, describe, expect, it, vi } from 'vitest';

const { pool, overlay } = vi.hoisted(() => ({
  pool: { executeParameterized: vi.fn() },
  overlay: {
    getOverlaySnapshot: vi.fn(),
    isDirtyPath: vi.fn((snapshot: { dirtyPaths: Set<string> }, filePath?: string) =>
      Boolean(filePath && snapshot.dirtyPaths.has(filePath)),
    ),
    queryOverlay: vi.fn(),
  },
}));

vi.mock('../../src/core/lbug/pool-adapter.js', () => pool);
vi.mock('../../src/mcp/local/backend-overlay.js', () => overlay);

import { resolveSymbolCandidates } from '../../src/mcp/local/backend-symbol-resolution.js';

const repo = { id: 'repo', repoPath: '/repo', storagePath: '/store' };
const usable = {
  usable: true,
  dirtyPaths: new Set(['src/dirty.ts']),
  overlayPaths: new Set(['src/dirty.ts']),
};
const unusable = { usable: false, dirtyPaths: new Set(['src/dirty.ts']) };

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
  beforeEach(() => {
    vi.clearAllMocks();
    pool.executeParameterized.mockResolvedValue([]);
    overlay.getOverlaySnapshot.mockResolvedValue(usable);
    overlay.queryOverlay.mockResolvedValue([]);
  });

  it('resolves a name defined only in a dirty file from the overlay', async () => {
    overlay.queryOverlay.mockResolvedValue([row('overlay-id', 'src/dirty.ts')]);

    const result = await resolveSymbolCandidates(repo, { name: 'lookup' }, {});

    expect(result).toMatchObject({
      kind: 'ok',
      symbol: { id: 'overlay-id', filePath: 'src/dirty.ts', source: 'overlay' },
    });
    expect(pool.executeParameterized).toHaveBeenCalledTimes(1);
    expect(overlay.queryOverlay).toHaveBeenCalledWith(
      expect.objectContaining({
        id: repo.id,
        repoPath: repo.repoPath,
        storagePath: repo.storagePath,
      }),
      expect.stringContaining('WHERE n.name = $symName'),
      { symName: 'lookup' },
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

  it('preserves base candidates when the overlay disappears after the snapshot', async () => {
    pool.executeParameterized.mockResolvedValue([row('base-id', 'src/dirty.ts')]);
    overlay.queryOverlay.mockRejectedValueOnce(new Error('no published overlay'));

    const result = await resolveSymbolCandidates(repo, { name: 'lookup' }, {});

    expect(result).toMatchObject({ kind: 'ok', symbol: { id: 'base-id' } });
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
});
