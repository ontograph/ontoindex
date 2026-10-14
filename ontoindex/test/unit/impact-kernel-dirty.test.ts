import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  runImpactKernel,
  type RunImpactKernelOptions,
} from '../../src/core/impact/impact-kernel.js';
import {
  runImpact,
  findDirtyMentions,
  DIRTY_MENTION_MAX_BYTES,
  DIRTY_MENTION_MAX_FILES,
} from '../../src/mcp/local/backend-impact.js';
import * as poolAdapter from '../../src/core/lbug/pool-adapter.js';
import { getOverlaySnapshot } from '../../src/mcp/local/backend-overlay.js';
import { resolveSymbolCandidates } from '../../src/mcp/local/backend-symbol-resolution.js';

vi.mock('../../src/core/lbug/pool-adapter.js', () => ({
  executeQuery: vi.fn(),
  executeParameterized: vi.fn(),
}));
vi.mock('../../src/mcp/local/backend-overlay.js', () => ({ getOverlaySnapshot: vi.fn() }));
vi.mock('../../src/mcp/local/backend-symbol-resolution.js', () => ({
  resolveSymbolCandidates: vi.fn(),
  toSymbolIdentity: vi.fn(),
}));

const repo = { id: 'repo', name: 'repo', repoPath: '/repo', storagePath: '/store' };
const target = { id: 'target', name: 'target', type: 'Function', filePath: 'src/target.ts' };
const options: RunImpactKernelOptions = { direction: 'upstream', maxDepth: 3 };
const query = vi.mocked(poolAdapter.executeParameterized);

function row(id: string, filePath = `src/${id}.ts`) {
  return { id, name: id, type: 'Function', filePath, relType: 'CALLS', confidence: 0.95 };
}

describe('impact kernel dirty traversal boundaries', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    query.mockResolvedValue([]);
    vi.mocked(poolAdapter.executeParameterized).mockResolvedValue([]);
  });

  it.each(['upstream', 'downstream'] as const)(
    'retains dirty %s rows without expanding them while clean branches continue',
    async (direction) => {
      query.mockResolvedValueOnce([row('dirty'), row('clean')]);
      query.mockResolvedValueOnce([row('cleanChild')]);

      const result = await runImpactKernel(repo, target, {
        ...options,
        direction,
        dirtyPaths: new Set(['src/dirty.ts']),
      });

      expect(result.impacted.map(({ id }) => id)).toEqual(['dirty', 'clean', 'cleanChild']);
      expect(result.byDepth[1][0]).toMatchObject({
        id: 'dirty',
        filePath: 'src/dirty.ts',
        relationType: 'CALLS',
        depth: 1,
        dirty: true,
      });
      expect(result.byDepth[1][1]).not.toHaveProperty('dirty');
      expect(result.byDepth[2][0]).not.toHaveProperty('dirty');
      expect(result.rawCounts).toMatchObject({
        total: 3,
        direct: 2,
        byDepth: { 1: 2, 2: 1 },
        riskReasons: ['traversal_partial'],
      });
      expect(result.partial).toBe(true);
      expect(result.warnings).toEqual([
        'Impact traversal stopped at dirty paths with stale graph IDs: src/dirty.ts',
      ]);
      expect(query).toHaveBeenCalledTimes(3);
      expect(query.mock.calls[1][2]).toEqual({ frontierIds: ['clean'] });
      expect(query.mock.calls[2][2]).toEqual({ frontierIds: ['cleanChild'] });
    },
  );

  it('deduplicates dirty paths across rows and depths in a single warning', async () => {
    query.mockResolvedValueOnce([
      row('dirtyOne', 'src/z.ts'),
      row('dirtyTwo', 'src/z.ts'),
      row('dirtyOne', 'src/z.ts'),
      row('clean'),
    ]);
    query.mockResolvedValueOnce([row('dirtyThree', 'src/a.ts'), row('dirtyOne', 'src/z.ts')]);

    const result = await runImpactKernel(repo, target, {
      ...options,
      dirtyPaths: new Set(['src/z.ts', 'src/a.ts']),
    });

    expect(result.impacted.map(({ id }) => id)).toEqual([
      'dirtyOne',
      'dirtyTwo',
      'clean',
      'dirtyThree',
    ]);
    expect(result.impacted.filter(({ dirty }) => dirty)).toHaveLength(3);
    expect(result.warnings).toEqual([
      'Impact traversal stopped at dirty paths with stale graph IDs: src/a.ts, src/z.ts',
    ]);
    expect(result.partial).toBe(true);
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[1][2]).toEqual({ frontierIds: ['clean'] });
  });

  it('marks even a final-depth dirty row partial and normalizes graph path separators', async () => {
    query.mockResolvedValueOnce([row('dirty', 'src\\dirty.ts')]);

    const result = await runImpactKernel(repo, target, {
      ...options,
      maxDepth: 1,
      dirtyPaths: new Set(['src/dirty.ts']),
    });

    expect(result.impacted[0]).toMatchObject({ filePath: 'src\\dirty.ts', dirty: true });
    expect(result.partial).toBe(true);
    expect(result.warnings[0]).toContain('src/dirty.ts');
    expect(query).toHaveBeenCalledTimes(1);
  });

  it.each([undefined, new Set<string>(), new Set(['src/unrelated.ts'])])(
    'preserves baseline output and traversal when dirtyPaths is %s',
    async (dirtyPaths) => {
      const firstDepth = [row('first'), row('second')];
      const secondDepth = [row('third')];
      query.mockResolvedValueOnce(firstDepth).mockResolvedValueOnce(secondDepth);
      const baseline = await runImpactKernel(repo, target, options);
      const baselineQueries = query.mock.calls.map((call) => call[1]);
      query.mockClear();
      query.mockResolvedValueOnce(firstDepth).mockResolvedValueOnce(secondDepth);

      const result = await runImpactKernel(repo, target, { ...options, dirtyPaths });

      expect(result).toEqual(baseline);
      expect(query.mock.calls.map((call) => call[1])).toEqual(baselineQueries);
      expect(result.partial).toBe(false);
      expect(result.warnings).toEqual([]);
    },
  );

  it('preserves existing test and low-confidence MENTIONS filtering', async () => {
    query.mockResolvedValueOnce([
      row('test', 'src/dirty.test.ts'),
      { ...row('mention'), relType: 'MENTIONS', confidence: 0.4 },
      row('clean'),
    ]);

    const result = await runImpactKernel(repo, target, {
      ...options,
      dirtyPaths: new Set(['src/dirty.test.ts', 'src/mention.ts']),
    });

    expect(result.impacted.map(({ id }) => id)).toEqual(['clean']);
    expect(result.partial).toBe(false);
    expect(result.warnings).toEqual([]);
    expect(query.mock.calls[1][2]).toEqual({ frontierIds: ['clean'] });
  });

  it.each([false, true])(
    'passes snapshot dirty paths through backend impact when overlay usable is %s',
    async (usable) => {
      vi.mocked(getOverlaySnapshot).mockResolvedValue({
        usable,
        reason: usable ? null : 'no overlay built',
        dirtyPaths: new Set(['src/dirty.ts']),
        overlayPaths: new Set(['src/dirty.ts']),
        tombstones: new Set(),
      });
      vi.mocked(resolveSymbolCandidates).mockResolvedValue({
        kind: 'ok',
        resolvedLabel: 'Function',
        symbol: { ...target, startLine: 1, endLine: 2 },
      } as Awaited<ReturnType<typeof resolveSymbolCandidates>>);
      query.mockResolvedValueOnce([row('dirty')]);

      const result = await runImpact(repo, { target: 'target', direction: 'upstream' });

      expect(result).toMatchObject({
        impactedCount: 1,
        partial: true,
        warnings: [expect.stringContaining('src/dirty.ts')],
        byDepth: { 1: [expect.objectContaining({ id: 'dirty', dirty: true })] },
      });
      expect(query.mock.calls.filter((call) => call[1].includes('$frontierIds'))).toHaveLength(1);
    },
  );
});

describe('bounded dirty mentions', () => {
  it('matches whole names, ignores missing/non-source/oversize files and enforces the file cap', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'impact-dirty-'));
    try {
      await fs.writeFile(path.join(root, 'caller.ts'), 'target();');
      await fs.writeFile(path.join(root, 'other.ts'), 'targetSuffix(); prefixTarget();');
      await fs.writeFile(path.join(root, 'notes.txt'), 'target();');
      await fs.writeFile(
        path.join(root, 'large.ts'),
        'target();' + ' '.repeat(DIRTY_MENTION_MAX_BYTES),
      );
      await fs.writeFile(path.join(root, 'escaped.ts'), 'a.b();');
      await fs.writeFile(path.join(root, 'wrong.ts'), 'axb();');
      expect(
        await findDirtyMentions(
          root,
          new Set(['caller.ts', 'other.ts', 'notes.txt', 'large.ts', 'missing.ts']),
          'target',
        ),
      ).toEqual(['caller.ts']);
      expect(await findDirtyMentions(root, new Set(['escaped.ts', 'wrong.ts']), 'a.b')).toEqual([
        'escaped.ts',
      ]);
      const capped = new Set(
        Array.from({ length: DIRTY_MENTION_MAX_FILES }, (_, i) => `missing${i}.ts`),
      );
      capped.add('caller.ts');
      expect(await findDirtyMentions(root, capped, 'target')).toEqual([]);
      expect(await findDirtyMentions(root, new Set(), 'target')).toEqual([]);
      expect(await findDirtyMentions(root, new Set(['../outside.ts']), 'target')).toEqual([]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('marks clean-target impact partial for a dirty new caller while excluding its definition and tombstones', async () => {
    vi.resetAllMocks();
    vi.mocked(poolAdapter.executeQuery).mockResolvedValue([]);
    vi.mocked(poolAdapter.executeParameterized).mockResolvedValue([]);
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'impact-wiring-'));
    try {
      await fs.mkdir(path.join(root, 'src'));
      await fs.writeFile(path.join(root, 'src/caller.ts'), 'target();');
      await fs.writeFile(path.join(root, 'src/target.ts'), 'function target() {}');
      await fs.writeFile(path.join(root, 'src/deleted.ts'), 'target();');
      vi.mocked(getOverlaySnapshot).mockResolvedValue({
        usable: false,
        reason: 'no overlay built',
        dirtyPaths: new Set(['src/caller.ts', 'src/target.ts', 'src/deleted.ts']),
        overlayPaths: new Set(),
        tombstones: new Set(['src/deleted.ts']),
      });
      vi.mocked(resolveSymbolCandidates).mockResolvedValue({
        kind: 'ok',
        resolvedLabel: 'Function',
        symbol: { ...target, startLine: 1, endLine: 2 },
      } as Awaited<ReturnType<typeof resolveSymbolCandidates>>);
      const result = await runImpact(
        { ...repo, repoPath: root },
        { target: 'target', direction: 'upstream' },
      );
      expect(result).toMatchObject({
        impactedCount: 0,
        risk: 'LOW',
        partial: true,
        traversalComplete: false,
      });
      expect(result.warnings).toEqual([
        'Dirty file src/caller.ts mentions target; callers added there are not in the graph',
      ]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
