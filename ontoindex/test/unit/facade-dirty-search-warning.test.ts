import { mkdtemp, mkdir, rm, writeFile, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dispatchFacade } from '../../src/mcp/facade/dispatch.js';
import { withPreparedSuperRead } from '../../src/mcp/super/names.js';
import { attachWorkspaceSearchWarning } from '../../src/mcp/shared/workspace-search-warning.js';
import {
  dirtyWorkspaceSearchWarning,
  resolveTargetContext,
} from '../../src/mcp/shared/target-context.js';
import type { LocalBackend } from '../../src/mcp/local/local-backend.js';
import type { TargetContextDirtyWorkspace } from '../../src/mcp/shared/target-context.js';
import type { Ignore } from 'ignore';
import {
  getPinnedOverlaySnapshot,
  type OverlaySnapshot,
} from '../../src/mcp/local/backend-overlay.js';

vi.mock('../../src/mcp/shared/target-context.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/mcp/shared/target-context.js')>()),
  resolveTargetContext: vi.fn(),
}));
vi.mock('../../src/mcp/local/backend-overlay.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/mcp/local/backend-overlay.js')>()),
  getPinnedOverlaySnapshot: vi.fn(),
}));
vi.mock('../../src/mcp/super/dispatch.js', () => ({
  dispatchSuper: vi.fn(async () => ({ warnings: ['existing'], definitions: [] })),
}));
vi.mock('../../src/mcp/super/names.js', () => ({
  withPreparedSuperRead: vi.fn(async (_name, _args, _repo, _backend, _options, run) => run()),
}));

function workspace(
  overrides: Partial<TargetContextDirtyWorkspace> = {},
): TargetContextDirtyWorkspace {
  return {
    state: 'unknown-untracked',
    fileCount: 8,
    sourceFileCount: 8,
    stagedSourceFileCount: 0,
    unstagedSourceFileCount: 0,
    untrackedSourceFileCount: 8,
    unknownGraphCoverageCount: 8,
    dirtyPaths: Array.from({ length: 8 }, (_, i) => `src/f${i}.ts`),
    ...overrides,
  };
}

beforeEach(() => {
  vi.mocked(resolveTargetContext).mockReset();
  vi.mocked(resolveTargetContext).mockResolvedValue({ dirtyWorkspace: workspace() } as never);
  vi.mocked(getPinnedOverlaySnapshot).mockReset();
  vi.mocked(withPreparedSuperRead).mockReset();
  vi.mocked(withPreparedSuperRead).mockImplementation(
    async (_name, _args, _repo, _backend, _options, run) => run(),
  );
});

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempRepo() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dirty-search-warning-'));
  tempDirs.push(dir);
  const repoPath = path.join(dir, 'repo');
  await mkdir(path.join(repoPath, 'src'), { recursive: true });
  return { dir, repoPath };
}

const CURRENT_COMMIT = 'abc123def456abc123def456abc123def456abc1';

function workspaceSnapshot(overrides: Partial<OverlaySnapshot> = {}): OverlaySnapshot {
  return {
    usable: true,
    capability: 'workspace-graph',
    coverage: 'complete',
    reason: null,
    generation: 'workspace-1',
    manifestDigest: 'validated-digest',
    currentHead: CURRENT_COMMIT,
    baseGenerationId: 'base-1',
    baseCommit: CURRENT_COMMIT,
    dirtyPaths: new Set(['src/a.ts']),
    parseErrorPaths: new Set(),
    overlayPaths: new Set(['src/a.ts']),
    uncoveredPaths: new Set(),
    tombstones: new Set(),
    ...overrides,
  };
}

async function useActualResolver(snapshot: OverlaySnapshot | undefined) {
  const actual = await vi.importActual<typeof import('../../src/mcp/shared/target-context.js')>(
    '../../src/mcp/shared/target-context.js',
  );
  vi.mocked(getPinnedOverlaySnapshot).mockReturnValue(snapshot);
  const readActiveGenerationMeta = vi.fn(async () => ({
    activeGeneration: null,
    meta: {
      repoPath: '.',
      lastCommit: CURRENT_COMMIT,
      indexedAt: 'graph-index-1',
      sourceManifest: {
        version: 1 as const,
        head: CURRENT_COMMIT,
        sourceDigest: 'source-1',
        sourceEntryCount: 1,
        includePaths: [],
        scopeDigest: 'scope-1',
        ignorePolicyDigest: 'ignore-1',
        pipelineProfile: 'full' as const,
        analyzerContractVersion: 'ontoindex-source-manifest-v1' as const,
        coverage: 'complete' as const,
      },
    },
    authority: 'legacy-root' as const,
  }));
  const computeSourceManifest = vi.fn(async () => {
    throw new Error('search warnings must not scan the source manifest');
  });
  vi.mocked(resolveTargetContext).mockImplementation((options) =>
    actual.resolveTargetContext(options, {
      readRegistry: async () => [
        {
          name: 'fixture',
          path: '/repo/fixture',
          storagePath: '/repo/fixture/.ontoindex',
          indexedAt: 'graph-index-1',
          lastCommit: CURRENT_COMMIT,
          stats: { embeddings: 3 },
        },
      ],
      execGit: async (_cwd, args) => {
        if (args.join(' ') === 'rev-parse --abbrev-ref HEAD') return 'main\n';
        if (args.join(' ') === 'status --porcelain=v1 --untracked-files=all')
          return ' M src/a.ts\n';
        return `${CURRENT_COMMIT}\n`;
      },
      getPinnedOverlaySnapshot,
      getPinnedGenerationDir: () => undefined,
      readActiveGenerationMeta,
      computeSourceManifest,
      loadIgnoreRules: async () => ({ ignores: () => false }) as unknown as Ignore,
    }),
  );
  return { readActiveGenerationMeta, computeSourceManifest };
}

describe('facade dirty search warnings', () => {
  it('prioritizes an untracked file containing the queried symbol', async () => {
    const { repoPath } = await tempRepo();
    await writeFile(path.join(repoPath, 'src/f7.ts'), 'function fancySymbol() {}');
    vi.mocked(resolveTargetContext).mockResolvedValue({
      repoPath,
      dirtyWorkspace: workspace(),
    } as never);
    const result = (await attachWorkspaceSearchWarning(
      {},
      { query: 'fancySymbol' },
      'fixture',
    )) as any;
    expect(result.warnings).toEqual([
      '8 untracked source file(s) are not in the graph; results may omit changes: src/f7.ts, src/f0.ts, src/f1.ts, src/f2.ts, src/f3.ts, +3 more; query symbol(s) fancySymbol appear in untracked file(s): src/f7.ts',
    ]);
  });

  it('preserves the warning when the query has no whole-identifier match', async () => {
    const { repoPath } = await tempRepo();
    await writeFile(path.join(repoPath, 'src/f7.ts'), 'function fancySymbolSuffix() {}');
    vi.mocked(resolveTargetContext).mockResolvedValue({
      repoPath,
      dirtyWorkspace: workspace(),
    } as never);
    const result = (await attachWorkspaceSearchWarning(
      {},
      { query: 'fancySymbol' },
      'fixture',
    )) as any;
    expect(result.warnings).toEqual([dirtyWorkspaceSearchWarning(workspace(), 'fancySymbol')]);
  });

  it('ignores paths and symlinks escaping the repository', async () => {
    const { dir, repoPath } = await tempRepo();
    await writeFile(path.join(dir, 'outside.ts'), 'function fancySymbol() {}');
    await symlink(path.join(dir, 'outside.ts'), path.join(repoPath, 'src/link.ts'));
    const dirtyWorkspace = workspace({ dirtyPaths: ['../outside.ts', 'src/link.ts'] });
    vi.mocked(resolveTargetContext).mockResolvedValue({ repoPath, dirtyWorkspace } as never);
    const result = (await attachWorkspaceSearchWarning(
      {},
      { query: 'fancySymbol' },
      'fixture',
    )) as any;
    expect(result.warnings).toEqual([dirtyWorkspaceSearchWarning(dirtyWorkspace, 'fancySymbol')]);
  });

  it('skips oversized files and tracked-only dirty workspaces', async () => {
    const { repoPath } = await tempRepo();
    await writeFile(path.join(repoPath, 'src/f7.ts'), `fancySymbol ${' '.repeat(256 * 1024)}`);
    const dirtyWorkspace = workspace();
    vi.mocked(resolveTargetContext).mockResolvedValue({ repoPath, dirtyWorkspace } as never);
    const result = (await attachWorkspaceSearchWarning(
      {},
      { query: 'fancySymbol' },
      'fixture',
    )) as any;
    expect(result.warnings).toEqual([dirtyWorkspaceSearchWarning(dirtyWorkspace, 'fancySymbol')]);
    await writeFile(path.join(repoPath, 'src/f7.ts'), 'function fancySymbol() {}');
    const tracked = workspace({ untrackedSourceFileCount: 0 });
    vi.mocked(resolveTargetContext).mockResolvedValue({
      repoPath,
      dirtyWorkspace: tracked,
    } as never);
    const trackedResult = (await attachWorkspaceSearchWarning(
      {},
      { query: 'fancySymbol' },
      'fixture',
    )) as any;
    expect(trackedResult.warnings).toEqual([dirtyWorkspaceSearchWarning(tracked, 'fancySymbol')]);
  });

  it.each([
    ['inspect', 'explore'],
    ['inspect', 'related'],
  ] as const)(
    'warns once for %s/%s even when results contain no dirty files',
    async (tool, action) => {
      const backend = {
        resolveRepo: vi.fn(async () => ({ id: 'fixture', repoPath: '/tmp/fixture' })),
        callTool: vi.fn(async () => ({ warnings: ['existing'], definitions: [] })),
      } as unknown as LocalBackend;
      const result = (await dispatchFacade(
        tool,
        action,
        { repo: 'fixture', query: 'f7.ts' },
        backend,
      )) as any;
      expect(result.warnings).toEqual([
        'existing',
        '8 untracked source file(s) are not in the graph; results may omit changes: src/f7.ts, src/f0.ts, src/f1.ts, src/f2.ts, src/f3.ts, +3 more',
      ]);
      expect(resolveTargetContext).toHaveBeenCalledTimes(1);
      vi.mocked(resolveTargetContext).mockClear();
    },
  );

  it('keeps clean workspace warnings unchanged', async () => {
    vi.mocked(resolveTargetContext).mockResolvedValue({
      dirtyWorkspace: workspace({ sourceFileCount: 0 }),
    } as never);
    const original = { warnings: ['existing'] };
    expect(await attachWorkspaceSearchWarning(original, {}, 'fixture')).toBe(original);
  });

  it('keeps admitted workspace graph results unchanged', async () => {
    vi.mocked(getPinnedOverlaySnapshot).mockReturnValue(workspaceSnapshot());
    vi.mocked(resolveTargetContext).mockResolvedValue({
      dirtyWorkspace: workspace(),
      graphAuthority: { state: 'authoritative', capability: 'workspace-graph' },
    } as never);
    const original = { warnings: [] };
    expect(await attachWorkspaceSearchWarning(original, {}, 'fixture')).toBe(original);
  });

  it.each([
    ['complete current', {}, 'authoritative'],
    ['partial', { coverage: 'partial' }, 'degraded'],
    ['unusable', { usable: false }, 'degraded'],
    ['stale', { currentHead: 'older-captured-head' }, 'review'],
  ] as const)(
    'uses real resolver authority for a %s pinned workspace graph',
    async (_name, overrides, state) => {
      const probes = await useActualResolver(workspaceSnapshot(overrides));
      const original = { warnings: ['existing'], definitions: [{ name: 'a' }] };
      const result = await attachWorkspaceSearchWarning(original, {}, 'fixture');
      const context = await vi.mocked(resolveTargetContext).mock.results[0].value;
      expect(resolveTargetContext).toHaveBeenCalledWith({
        repo: 'fixture',
        verifyGraphAuthority: true,
      });
      expect(context.graphAuthority).toMatchObject({ state, capability: 'workspace-graph' });
      if (state === 'authoritative') {
        expect(result).toBe(original);
      } else {
        expect(result).toEqual({
          ...original,
          warnings: [
            'existing',
            '1 dirty source file(s) are not in the graph; results may omit changes: src/a.ts',
          ],
        });
      }
      expect(getPinnedOverlaySnapshot).toHaveBeenCalledWith('fixture');
      expect(probes.readActiveGenerationMeta).not.toHaveBeenCalled();
      expect(probes.computeSourceManifest).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['absent', undefined],
    [
      'committed-view empty',
      workspaceSnapshot({
        usable: false,
        capability: undefined,
        coverage: undefined,
        generation: undefined,
        manifestDigest: undefined,
        reason: 'no dirty files',
      }),
    ],
  ] as const)('does not verify graph authority for an %s snapshot', async (_name, snapshot) => {
    const probes = await useActualResolver(snapshot);
    const original = { warnings: ['existing'], definitions: [{ name: 'a' }] };
    expect(await attachWorkspaceSearchWarning(original, {}, 'fixture')).toEqual({
      ...original,
      warnings: [
        'existing',
        '1 dirty source file(s) are not in the graph; results may omit changes: src/a.ts',
      ],
    });
    expect(resolveTargetContext).toHaveBeenCalledWith({
      repo: 'fixture',
      verifyGraphAuthority: false,
    });
    const context = await vi.mocked(resolveTargetContext).mock.results[0].value;
    expect(context.graphAuthority).toBeUndefined();
    expect(probes.computeSourceManifest).not.toHaveBeenCalled();
  });

  it.each(['explore', 'related'] as const)(
    'checks %s warnings inside the prepared workspace read',
    async (action) => {
      await useActualResolver(undefined);
      let insidePreparedRead = false;
      vi.mocked(getPinnedOverlaySnapshot).mockImplementation(() =>
        insidePreparedRead ? workspaceSnapshot() : undefined,
      );
      vi.mocked(withPreparedSuperRead).mockImplementation(
        async (_name, _args, _repo, _backend, _options, run) => {
          insidePreparedRead = true;
          try {
            return await run();
          } finally {
            insidePreparedRead = false;
          }
        },
      );
      const backend = {
        resolveRepo: vi.fn(async () => ({ id: 'fixture', repoPath: '/repo/fixture' })),
        callTool: vi.fn(async () => ({ warnings: ['existing'], definitions: [] })),
      } as unknown as LocalBackend;
      const result = await dispatchFacade('inspect', action, { repo: 'fixture' }, backend);
      expect(result).toMatchObject({ warnings: ['existing'], definitions: [] });
      expect(resolveTargetContext).toHaveBeenCalledTimes(1);
      expect(resolveTargetContext).toHaveBeenCalledWith({
        repo: 'fixture',
        verifyGraphAuthority: true,
      });
      expect(insidePreparedRead).toBe(false);
    },
  );

  it('prioritizes full paths and preserves the capped summary remainder', () => {
    expect(
      dirtyWorkspaceSearchWarning(
        workspace({
          fileCount: 60,
          sourceFileCount: 60,
          untrackedSourceFileCount: 60,
          dirtyPathsTruncated: true,
        }),
        'inspect `src/f6.ts`',
      ),
    ).toBe(
      '60 untracked source file(s) are not in the graph; results may omit changes: src/f6.ts, src/f0.ts, src/f1.ts, src/f2.ts, src/f3.ts, +55 more',
    );
  });

  it('lists symbol matches before a path named in the query', () => {
    expect(dirtyWorkspaceSearchWarning(workspace(), 'f0.ts fancySymbol', ['src/f7.ts'])).toBe(
      '8 untracked source file(s) are not in the graph; results may omit changes: src/f7.ts, src/f0.ts, src/f1.ts, src/f2.ts, src/f3.ts, +3 more',
    );
  });

  it('warns about unstaged tracked source changes', () => {
    expect(
      dirtyWorkspaceSearchWarning(
        workspace({
          state: 'dirty-file',
          sourceFileCount: 1,
          fileCount: 1,
          unstagedSourceFileCount: 1,
          untrackedSourceFileCount: 0,
          dirtyPaths: ['src/a.ts'],
        }),
        'a.ts',
      ),
    ).toBe('1 dirty source file(s) are not in the graph; results may omit changes: src/a.ts');
  });

  it('omits non-source paths from the preview and remainder', () => {
    expect(
      dirtyWorkspaceSearchWarning(
        workspace({
          sourceFileCount: 1,
          untrackedSourceFileCount: 1,
          fileCount: 2,
          dirtyPaths: ['notes.txt', 'src/a.ts'],
        }),
        'notes.txt',
      ),
    ).toBe('1 untracked source file(s) are not in the graph; results may omit changes: src/a.ts');
  });
});
