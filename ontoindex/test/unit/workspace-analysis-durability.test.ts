import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runFullAnalysis } from '../../src/core/run-analyze.js';
import { workspaceParserIdentity } from '../../src/core/tree-sitter/parser-identity.js';
import {
  captureWorkspaceInputs,
  planDirtyOverlay,
  type WorkspaceInputCapture,
} from '../../src/core/analyze-delta.js';
import { syncPath, syncTree } from '../../src/core/durable-publish.js';
import { closeLbugForPath, initLbug } from '../../src/core/lbug/lbug-adapter.js';
import { getCurrentCommit } from '../../src/storage/git.js';
import { getStoragePaths, pruneOverlayGenerations } from '../../src/storage/repo-manager.js';
import { buildTestGraph } from '../helpers/test-graph.js';

vi.mock('../../src/core/durable-publish.js', () => ({ syncPath: vi.fn(), syncTree: vi.fn() }));

vi.mock('../../src/core/tree-sitter/parser-identity.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/core/tree-sitter/parser-identity.js')>()),
  workspaceParserIdentity: vi.fn(),
}));

vi.mock('../../src/core/analyze-delta.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/core/analyze-delta.js')>()),
  captureWorkspaceInputs: vi.fn(),
  planDirtyOverlay: vi.fn(),
}));

vi.mock('../../src/storage/git.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/storage/git.js')>()),
  getCurrentCommit: vi.fn(),
}));

vi.mock('../../src/storage/repo-manager.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/storage/repo-manager.js')>()),
  pruneOverlayGenerations: vi.fn(),
}));

vi.mock('../../src/core/lbug/lbug-adapter.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/core/lbug/lbug-adapter.js')>()),
  initLbug: vi.fn(),
  loadGraphToLbug: vi.fn(),
  getLbugStats: vi.fn().mockResolvedValue({ nodes: 1, edges: 0 }),
  createFTSIndex: vi.fn(),
  closeLbugForPath: vi.fn(),
}));

describe('workspace analysis durability', () => {
  let root: string;
  let overlay: string;
  let operations: unknown[];
  const dispose = vi.fn<() => Promise<void>>();
  const analyzeRepo = vi.fn();
  const build = () =>
    runFullAnalysis(
      root,
      { workspaceGraph: true, skipNativeClose: true },
      { onProgress: () => {} },
      { analyzeRuntime: { analyzeRepo } },
    );

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.mocked(workspaceParserIdentity).mockReset().mockResolvedValue('test-parser');
    operations = [];
    vi.mocked(workspaceParserIdentity).mockImplementation(async () => {
      operations.push(['parser-identity']);
      return 'test-parser';
    });
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-durability-'));
    overlay = path.join(getStoragePaths(root).storagePath, 'overlay');
    await fs.mkdir(overlay, { recursive: true });
    await fs.writeFile(path.join(root, 'source.ts'), 'export const value = 1;\n');
    dispose.mockResolvedValue(undefined);
    vi.mocked(getCurrentCommit).mockReset().mockReturnValue('stable-head');
    vi.mocked(pruneOverlayGenerations).mockReset().mockResolvedValue(false);
    vi.mocked(closeLbugForPath).mockReset().mockResolvedValue(undefined);
    vi.mocked(initLbug).mockImplementation(async (dbPath) => {
      await fs.writeFile(dbPath, 'generation database');
    });
    vi.mocked(syncTree)
      .mockReset()
      .mockImplementation(async (target) => {
        operations.push(['tree', target]);
      });
    vi.mocked(syncPath)
      .mockReset()
      .mockImplementation(async (target, options) => {
        operations.push(['path', target, options]);
      });
    vi.mocked(planDirtyOverlay).mockResolvedValue({
      includePaths: ['source.ts'],
      uncoveredPaths: [],
      allDirtyPaths: ['source.ts'],
      tombstones: [],
      tooMany: false,
      skipped: [],
      configPaths: [],
    });
    const capture: WorkspaceInputCapture = {
      canonicalRepoPath: root,
      captureRoot: root,
      manifest: {
        version: 1,
        head: 'stable-head',
        sourceDigest: 'source-digest',
        sourceEntryCount: 1,
        includePaths: [],
        scopeDigest: 'scope-digest',
        ignorePolicyDigest: 'ignore-digest',
        pipelineProfile: 'full',
        analyzerContractVersion: 'ontoindex-source-manifest-v1',
        coverage: 'complete',
        workspaceCapture: {
          contract: 'ontoindex-workspace-input-v1',
          entries: [{ path: 'source.ts', byteLength: 24, digest: 'digest', executable: false }],
          configurationDigest: 'configuration-digest',
          parserIdentity: 'test-parser',
        },
      },
      manifestDigest: 'manifest-digest',
      baseGenerationId: null,
      baseCommit: null,
      head: 'stable-head',
      parserIdentity: 'test-parser',
      configurationDigest: 'configuration-digest',
      capturedPaths: ['source.ts'],
      tombstones: [],
      totalBytes: 24,
      dispose,
    };
    vi.mocked(captureWorkspaceInputs).mockResolvedValue(capture);
    analyzeRepo.mockReset().mockResolvedValue({
      graph: buildTestGraph([
        { id: 'File:source.ts', label: 'File', name: 'source.ts', filePath: 'source.ts' },
      ]),
      repoPath: root,
      totalFileCount: 1,
      usedWorkerPool: false,
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('syncs the generation and pointer before publishing, then the overlay directory', async () => {
    const rename = fs.rename.bind(fs);
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (to === path.join(overlay, 'CURRENT')) operations.push(['rename', from, to]);
      await rename(from, to);
    });

    await expect(build()).resolves.toMatchObject({ stats: { nodes: 1, edges: 0, files: 1 } });

    const generation = (await fs.readFile(path.join(overlay, 'CURRENT'), 'utf8')).trim();
    const pointer = path.join(overlay, `.CURRENT-${generation}.tmp`);
    expect(operations).toEqual([
      ['tree', path.join(overlay, generation)],
      ['path', pointer, undefined],
      ['parser-identity'],
      ['rename', pointer, path.join(overlay, 'CURRENT')],
      ['path', overlay, { bestEffort: true }],
    ]);
    expect(dispose).toHaveBeenCalledOnce();
  });

  it.each([true, false])(
    'cleans a failed generation sync (existing CURRENT: %s)',
    async (existing) => {
      const previous = '1-1-previous';
      if (existing) {
        await fs.mkdir(path.join(overlay, previous));
        await fs.writeFile(path.join(overlay, 'CURRENT'), `${previous}\n`);
      }
      const failure = new Error('file fsync failed');
      vi.mocked(syncTree).mockRejectedValueOnce(failure);

      await expect(build()).rejects.toBe(failure);

      const generationPath = vi.mocked(syncTree).mock.calls[0][0];
      expect(generationPath).toBeTruthy();
      await expect(fs.stat(generationPath)).rejects.toMatchObject({ code: 'ENOENT' });
      if (existing) {
        expect(await fs.readFile(path.join(overlay, 'CURRENT'), 'utf8')).toBe(`${previous}\n`);
      } else {
        await expect(fs.stat(path.join(overlay, 'CURRENT'))).rejects.toMatchObject({
          code: 'ENOENT',
        });
      }
      expect(
        (await fs.readdir(overlay)).filter((name) => /^\.CURRENT-.*\.tmp$/.test(name)),
      ).toEqual([]);
      expect(syncPath).not.toHaveBeenCalled();
      expect(dispose).toHaveBeenCalledOnce();
    },
  );

  it('keeps a published generation successful when the overlay directory sync rejects', async () => {
    vi.mocked(syncPath).mockImplementation(async (target) => {
      if (target === overlay) throw new Error('directory fsync failed');
    });

    await expect(build()).resolves.toMatchObject({ stats: { nodes: 1, edges: 0, files: 1 } });

    const generation = (await fs.readFile(path.join(overlay, 'CURRENT'), 'utf8')).trim();
    expect(vi.mocked(syncTree).mock.calls).toEqual([[path.join(overlay, generation)]]);
    expect(await fs.readFile(path.join(overlay, generation, 'lbug'), 'utf8')).toBe(
      'generation database',
    );
    expect(dispose).toHaveBeenCalledOnce();
  });
});
