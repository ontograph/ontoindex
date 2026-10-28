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
import { closeLbugForPath, initLbug } from '../../src/core/lbug/lbug-adapter.js';
import { getCurrentCommit } from '../../src/storage/git.js';
import { getStoragePaths } from '../../src/storage/repo-manager.js';
import { buildTestGraph } from '../helpers/test-graph.js';

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

vi.mock('../../src/core/lbug/lbug-adapter.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/core/lbug/lbug-adapter.js')>()),
  initLbug: vi.fn(),
  loadGraphToLbug: vi.fn().mockResolvedValue(undefined),
  getLbugStats: vi.fn().mockResolvedValue({ nodes: 1, edges: 0 }),
  createFTSIndex: vi.fn().mockResolvedValue(undefined),
  closeLbugForPath: vi.fn().mockResolvedValue(undefined),
}));

describe('workspace analysis base guards', () => {
  let root: string;
  let overlay: string;
  let capture: WorkspaceInputCapture;
  const dispose = vi.fn<() => Promise<void>>();
  const analyzeRepo = vi.fn();
  const directories = async () =>
    (await fs.readdir(overlay, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
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
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-base-guard-'));
    overlay = path.join(getStoragePaths(root).storagePath, 'overlay');
    await fs.mkdir(overlay, { recursive: true });
    await fs.writeFile(path.join(root, 'source.ts'), 'export const value = 1;\n');
    dispose.mockResolvedValue(undefined);
    vi.mocked(getCurrentCommit).mockReset().mockReturnValue('stable-head');
    vi.mocked(initLbug).mockImplementation(async (dbPath) => {
      await fs.writeFile(dbPath, 'partial generation database');
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
    capture = {
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
    vi.mocked(captureWorkspaceInputs).mockImplementation(async () => {
      capture.head = getCurrentCommit(root) || null;
      return capture;
    });
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
    await fs.rm(root, { recursive: true, force: true });
  });

  for (const stage of ['after capture', 'during analysis'] as const) {
    it.each([true, false])(
      `rejects a HEAD change ${stage} and cleans up (existing CURRENT: %s)`,
      async (existingCurrent) => {
        const previousCurrent = '1-1-previous\n';
        if (existingCurrent) {
          await fs.mkdir(path.join(overlay, previousCurrent.trim()));
          await fs.writeFile(path.join(overlay, 'CURRENT'), previousCurrent);
        }
        const before = await directories();
        if (stage === 'after capture') {
          vi.mocked(getCurrentCommit)
            .mockReturnValueOnce('stable-head')
            .mockReturnValue('changed-head');
        } else {
          const stablePipeline = analyzeRepo.getMockImplementation()!;
          analyzeRepo.mockImplementation(async () => {
            vi.mocked(getCurrentCommit).mockReturnValue('changed-head');
            return stablePipeline();
          });
        }

        await expect(build()).rejects.toThrow(
          `Workspace graph base or HEAD changed ${stage}; rebuild required.`,
        );

        if (existingCurrent) {
          expect(await fs.readFile(path.join(overlay, 'CURRENT'), 'utf8')).toBe(previousCurrent);
        } else {
          await expect(fs.stat(path.join(overlay, 'CURRENT'))).rejects.toMatchObject({
            code: 'ENOENT',
          });
        }
        expect(await directories()).toEqual(before);
        expect(
          (await fs.readdir(overlay)).filter((name) => /^\.CURRENT-.*\.tmp$/.test(name)),
        ).toEqual([]);
        expect(dispose).toHaveBeenCalledOnce();
        expect(closeLbugForPath).toHaveBeenCalled();
        const closedPath = vi.mocked(closeLbugForPath).mock.calls[0][0];
        expect(path.dirname(path.dirname(closedPath))).toBe(overlay);
        expect(path.basename(closedPath)).toBe('lbug');
        expect(before).not.toContain(path.basename(path.dirname(closedPath)));
        if (stage === 'after capture') {
          expect(analyzeRepo).not.toHaveBeenCalled();
          expect(initLbug).not.toHaveBeenCalled();
        } else {
          expect(analyzeRepo).toHaveBeenCalledOnce();
          expect(closeLbugForPath).toHaveBeenCalledWith(vi.mocked(initLbug).mock.calls[0][0]);
        }
      },
    );
  }

  it('publishes CURRENT with stable HEAD and base using the same pipeline', async () => {
    await expect(build()).resolves.toMatchObject({ stats: { nodes: 1, edges: 0, files: 1 } });
    const current = (await fs.readFile(path.join(overlay, 'CURRENT'), 'utf8')).trim();
    expect(await directories()).toEqual([current]);
    expect(await fs.readFile(path.join(overlay, current, 'lbug'), 'utf8')).toBe(
      'partial generation database',
    );
    expect(
      JSON.parse(await fs.readFile(path.join(overlay, current, 'base.json'), 'utf8')),
    ).toMatchObject({
      head: 'stable-head',
      baseGenerationId: null,
      baseCommit: null,
      capability: 'workspace-graph',
    });
    expect(dispose).toHaveBeenCalledOnce();
    expect(analyzeRepo).toHaveBeenCalledOnce();
    expect(closeLbugForPath).toHaveBeenCalledWith(path.join(overlay, current, 'lbug'), {
      strict: true,
    });
    expect((await fs.readdir(overlay)).filter((name) => name.startsWith('.CURRENT-'))).toEqual([]);
  });
});
