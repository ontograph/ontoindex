import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runFullAnalysis } from '../../src/core/run-analyze.js';
import { syncPath } from '../../src/core/durable-publish.js';
import {
  supervisedWorkspaceParserIdentity,
  workspaceParserIdentity,
} from '../../src/core/tree-sitter/parser-identity.js';
import type { PipelineOptions } from '../../src/core/ingestion/pipeline.js';
import {
  ScopeRetentionStage,
  type ScopeRetentionRequest,
} from '../../src/core/ingestion/pipeline-phases/scope-retention-stage.js';
import {
  persistScopeRetentionCandidate,
  copyScopeRetentionCandidate,
  type ScopeRetentionCandidateManifest,
} from '../../src/core/ingestion/pipeline-phases/scope-retention-candidate.js';
import { loadScopeRetentionCandidate } from '../../src/core/ingestion/pipeline-phases/scope-retention-candidate-reader.js';
import {
  captureWorkspaceInputs,
  planDirtyOverlay,
  type WorkspaceInputCapture,
} from '../../src/core/analyze-delta.js';
import {
  closeLbugForPath,
  createFTSIndex,
  initLbug,
  loadGraphToLbug,
} from '../../src/core/lbug/lbug-adapter.js';
import { getCurrentCommit } from '../../src/storage/git.js';
import { getStoragePaths, pruneOverlayGenerations } from '../../src/storage/repo-manager.js';
import { buildTestGraph } from '../helpers/test-graph.js';

vi.mock('../../src/core/tree-sitter/parser-identity.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/core/tree-sitter/parser-identity.js')>()),
  workspaceParserIdentity: vi.fn(),
  supervisedWorkspaceParserIdentity: vi.fn(),
}));

vi.mock('../../src/core/durable-publish.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/core/durable-publish.js')>()),
  syncPath: vi.fn(),
}));

vi.mock('../../src/core/ingestion/pipeline-phases/scope-retention-candidate.js', () => ({
  persistScopeRetentionCandidate: vi.fn(),
  copyScopeRetentionCandidate: vi.fn(),
}));

vi.mock(
  '../../src/core/ingestion/pipeline-phases/scope-retention-candidate-reader.js',
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import('../../src/core/ingestion/pipeline-phases/scope-retention-candidate-reader.js')
    >()),
    loadScopeRetentionCandidate: vi.fn(),
  }),
);

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

describe('workspace analysis publication ordering', () => {
  let root: string;
  let overlay: string;
  let completed: string[];
  const dispose = vi.fn<() => Promise<void>>();
  const analyzeRepo = vi.fn();
  const onLog = vi.fn();
  const build = (scopeRetention?: ScopeRetentionRequest) =>
    runFullAnalysis(
      root,
      { workspaceGraph: true, skipNativeClose: true },
      { onProgress: () => {}, onLog },
      { analyzeRuntime: { analyzeRepo }, ...(scopeRetention ? { scopeRetention } : {}) },
    );
  const temporaryPointers = async () =>
    (await fs.readdir(overlay)).filter((name) => /^\.CURRENT-.*\.tmp$/.test(name));

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.mocked(workspaceParserIdentity).mockReset().mockResolvedValue('test-parser');
    vi.mocked(supervisedWorkspaceParserIdentity).mockReset().mockResolvedValue(null);
    vi.mocked(loadScopeRetentionCandidate)
      .mockReset()
      .mockRejectedValue(new Error('candidate missing'));
    vi.mocked(copyScopeRetentionCandidate).mockReset();
    vi.mocked(syncPath).mockReset().mockResolvedValue(undefined);
    vi.mocked(persistScopeRetentionCandidate)
      .mockReset()
      .mockImplementation(async (_handle, generationPath, identity, request) => {
        const directory = path.join(generationPath, 'scope-retention-candidate');
        await fs.mkdir(directory);
        const candidate = `${JSON.stringify(identity)}\n`;
        await fs.writeFile(path.join(directory, 'manifest.json'), candidate);
        const artifactBytes = Buffer.byteLength(candidate);
        request.artifactAllowance.remainingBytes -= artifactBytes;
        completed.push('retained');
        // This harness exercises publication ownership; the writer owns manifest validation.
        return { artifactBytes } as ScopeRetentionCandidateManifest;
      });
    completed = [];
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-publication-order-'));
    overlay = path.join(getStoragePaths(root).storagePath, 'overlay');
    await fs.mkdir(overlay, { recursive: true });
    await fs.writeFile(path.join(root, 'source.ts'), 'export const value = 1;\n');
    dispose.mockResolvedValue(undefined);
    vi.mocked(getCurrentCommit).mockReset().mockReturnValue('stable-head');
    vi.mocked(pruneOverlayGenerations).mockReset().mockResolvedValue(false);
    vi.mocked(initLbug).mockImplementation(async (dbPath) => {
      await fs.writeFile(dbPath, 'generation database');
    });
    vi.mocked(loadGraphToLbug).mockImplementation(async () => {
      await Promise.resolve();
      completed.push('loaded');
    });
    vi.mocked(createFTSIndex).mockImplementation(async () => {
      await Promise.resolve();
      completed.push('fts');
    });
    vi.mocked(closeLbugForPath).mockImplementation(async () => {
      await Promise.resolve();
      completed.push('closed');
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
    analyzeRepo
      .mockReset()
      .mockImplementation(async ({ options }: { options?: PipelineOptions }) => {
        if (options?.scopeReplay) {
          await options.scopeReplay.preserve();
        } else if (options?.scopeRetention) {
          const handle = new ScopeRetentionStage(options.scopeRetention);
          try {
            await options.scopeRetention.consume(handle);
          } finally {
            await handle.dispose();
          }
        }
        return {
          graph: buildTestGraph([
            { id: 'File:source.ts', label: 'File', name: 'source.ts', filePath: 'source.ts' },
          ]),
          repoPath: root,
          totalFileCount: 1,
          usedWorkerPool: false,
        };
      });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true });
  });

  it.each([undefined, 'unexpected', 'full', 'retained-replay'])(
    'persists only an observed recognized parse mode: %s',
    async (parseMode) => {
      const analyze = analyzeRepo.getMockImplementation()!;
      analyzeRepo.mockImplementation(async (...args) => ({
        ...(await analyze(...args)),
        parseMode,
      }));
      await build();
      const current = (await fs.readFile(path.join(overlay, 'CURRENT'), 'utf8')).trim();
      const base = JSON.parse(await fs.readFile(path.join(overlay, current, 'base.json'), 'utf8'));
      if (parseMode === 'full' || parseMode === 'retained-replay') {
        expect(base.buildTimings.parseMode).toBe(parseMode);
      } else {
        expect(base.buildTimings).not.toHaveProperty('parseMode');
      }
    },
  );

  const prepareReplay = async () => {
    const previous = '1-1-previous';
    const sourcePath = path.join(overlay, previous);
    await fs.mkdir(sourcePath);
    await fs.writeFile(path.join(overlay, 'CURRENT'), `${previous}\n`);
    vi.mocked(supervisedWorkspaceParserIdentity).mockResolvedValue('test-parser');
    const candidate = { manifest: { seedReady: true }, families: {} } as Awaited<
      ReturnType<typeof loadScopeRetentionCandidate>
    >;
    vi.mocked(loadScopeRetentionCandidate).mockResolvedValue(candidate);
    const request: ScopeRetentionRequest = {
      deadline: Date.now() + 60_000,
      artifactAllowance: { remainingBytes: 4096 },
    };
    const readerPins = async () =>
      (await fs.readdir(sourcePath)).filter((name) => name.startsWith('.reader-'));
    vi.mocked(copyScopeRetentionCandidate).mockImplementation(
      async (_source, destination, expected, copyRequest) => {
        expect(await readerPins()).toHaveLength(1);
        const directory = path.join(destination, 'scope-retention-candidate');
        await fs.mkdir(directory);
        const content = JSON.stringify(expected);
        await fs.writeFile(path.join(directory, 'manifest.json'), content);
        const artifactBytes = Buffer.byteLength(content);
        copyRequest.artifactAllowance.remainingBytes -= artifactBytes;
        return { artifactBytes } as ScopeRetentionCandidateManifest;
      },
    );
    return { sourcePath, previous, candidate, request, readerPins };
  };

  it('pins verified replay through copying and publication, then releases its reader pin', async () => {
    const { sourcePath, candidate, request, readerPins } = await prepareReplay();
    const load = vi.mocked(loadScopeRetentionCandidate).getMockImplementation()!;
    vi.mocked(loadScopeRetentionCandidate).mockImplementationOnce(async (...args) => {
      expect(await readerPins()).toHaveLength(1);
      return load(...args);
    });
    const rename = fs.rename.bind(fs);
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (to === path.join(overlay, 'CURRENT')) expect(await readerPins()).toHaveLength(1);
      await rename(from, to);
    });

    await expect(build(request)).resolves.toMatchObject({ stats: { files: 1 } });

    const current = (await fs.readFile(path.join(overlay, 'CURRENT'), 'utf8')).trim();
    const expected = {
      identity: {
        sourceManifestDigest: 'manifest-digest',
        targetCommit: 'stable-head',
        baseGenerationId: null,
      },
      parserCodeIdentity: 'test-parser',
    };
    expect(loadScopeRetentionCandidate).toHaveBeenCalledWith(sourcePath, expected, request);
    expect(copyScopeRetentionCandidate).toHaveBeenCalledWith(
      sourcePath,
      path.join(overlay, current),
      expected,
      request,
    );
    expect(analyzeRepo.mock.calls[0][0].options.scopeReplay).toMatchObject({ candidate, request });
    expect(persistScopeRetentionCandidate).not.toHaveBeenCalled();
    expect(request.artifactAllowance.remainingBytes).toBe(
      4096 - Buffer.byteLength(JSON.stringify(expected)),
    );
    expect(await readerPins()).toEqual([]);
  });

  it('falls back to full parsing on a replay load miss and releases its reader pin', async () => {
    const { request, readerPins } = await prepareReplay();
    vi.mocked(loadScopeRetentionCandidate).mockRejectedValueOnce(new Error('stale candidate'));

    await expect(build(request)).resolves.toMatchObject({ stats: { files: 1 } });

    expect(analyzeRepo.mock.calls[0][0].options).not.toHaveProperty('scopeReplay');
    expect(persistScopeRetentionCandidate).toHaveBeenCalledOnce();
    expect(copyScopeRetentionCandidate).not.toHaveBeenCalled();
    expect(await readerPins()).toEqual([]);
  });

  it('skips replay loading without a supervised parser baseline', async () => {
    const { request, readerPins } = await prepareReplay();
    vi.mocked(supervisedWorkspaceParserIdentity).mockResolvedValueOnce(null);

    await expect(build(request)).resolves.toMatchObject({ stats: { files: 1 } });

    expect(loadScopeRetentionCandidate).not.toHaveBeenCalled();
    expect(copyScopeRetentionCandidate).not.toHaveBeenCalled();
    expect(persistScopeRetentionCandidate).toHaveBeenCalledOnce();
    expect(await readerPins()).toEqual([]);
  });

  it('removes a partially copied replay candidate, refunds its charge and releases the pin', async () => {
    const { previous, request, readerPins } = await prepareReplay();
    const copy = vi.mocked(copyScopeRetentionCandidate).getMockImplementation()!;
    const failure = new Error('copy failed after charging bytes');
    vi.mocked(copyScopeRetentionCandidate).mockImplementationOnce(async (...args) => {
      await copy(...args);
      throw failure;
    });

    await expect(build(request)).rejects.toBe(failure);

    const destination = vi.mocked(copyScopeRetentionCandidate).mock.calls[0][1];
    await expect(fs.stat(destination)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readFile(path.join(overlay, 'CURRENT'), 'utf8')).toBe(`${previous}\n`);
    expect(request.artifactAllowance.remainingBytes).toBe(4096);
    expect(await readerPins()).toEqual([]);
    expect(dispose).toHaveBeenCalledOnce();
  });

  it.each(['cancelled', 'deadline'] as const)(
    'propagates replay %s during loading and releases its pin',
    async (reason) => {
      const { previous, request, readerPins } = await prepareReplay();
      const controller = new AbortController();
      request.signal = controller.signal;
      vi.mocked(loadScopeRetentionCandidate).mockImplementationOnce(async () => {
        expect(await readerPins()).toHaveLength(1);
        if (reason === 'cancelled') controller.abort();
        else request.deadline = Date.now() - 1;
        throw new Error('reader stopped');
      });

      await expect(build(request)).rejects.toThrow(`Workspace replay ${reason}`);

      expect(analyzeRepo).not.toHaveBeenCalled();
      expect(await fs.readFile(path.join(overlay, 'CURRENT'), 'utf8')).toBe(`${previous}\n`);
      expect(request.artifactAllowance.remainingBytes).toBe(4096);
      expect(await readerPins()).toEqual([]);
      expect(dispose).toHaveBeenCalledOnce();
    },
  );

  it.each(['pipeline', 'publication'] as const)(
    'releases the replay pin and refunds copied bytes after %s failure',
    async (phase) => {
      const { previous, request, readerPins } = await prepareReplay();
      const failure = new Error(`replay ${phase} failed`);
      if (phase === 'pipeline') {
        const pipeline = analyzeRepo.getMockImplementation()!;
        analyzeRepo.mockImplementationOnce(async (...args) => {
          await pipeline(...args);
          throw failure;
        });
      } else {
        const rename = fs.rename.bind(fs);
        vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
          if (to === path.join(overlay, 'CURRENT')) throw failure;
          await rename(from, to);
        });
      }

      await expect(build(request)).rejects.toBe(failure);

      const destination = vi.mocked(copyScopeRetentionCandidate).mock.calls[0][1];
      await expect(fs.stat(destination)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await fs.readFile(path.join(overlay, 'CURRENT'), 'utf8')).toBe(`${previous}\n`);
      expect(request.artifactAllowance.remainingBytes).toBe(4096);
      expect(await readerPins()).toEqual([]);
      expect(dispose).toHaveBeenCalledOnce();
    },
  );

  it('persists captured retention identity in the published generation before CURRENT changes', async () => {
    const request: ScopeRetentionRequest = {
      deadline: Date.now() + 60_000,
      artifactAllowance: { remainingBytes: 4096 },
    };
    const identity = {
      sourceManifestDigest: 'manifest-digest',
      targetCommit: 'stable-head',
      baseGenerationId: null,
    };
    const artifactBytes = Buffer.byteLength(`${JSON.stringify(identity)}\n`);
    const rename = fs.rename.bind(fs);
    let stagedPath: string | undefined;
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (to === path.join(overlay, 'CURRENT')) {
        const generationId = (await fs.readFile(from, 'utf8')).trim();
        stagedPath = path.join(overlay, generationId);
        expect(
          JSON.parse(
            await fs.readFile(
              path.join(stagedPath, 'scope-retention-candidate', 'manifest.json'),
              'utf8',
            ),
          ),
        ).toEqual(identity);
        expect(completed).toEqual(['retained', 'loaded', 'fts', 'closed']);
        expect(request.artifactAllowance.remainingBytes).toBe(4096 - artifactBytes);
      }
      await rename(from, to);
    });

    await expect(build(request)).resolves.toMatchObject({ stats: { files: 1 } });

    const current = (await fs.readFile(path.join(overlay, 'CURRENT'), 'utf8')).trim();
    expect(stagedPath).toBe(path.join(overlay, current));
    expect(persistScopeRetentionCandidate).toHaveBeenCalledOnce();
    expect(persistScopeRetentionCandidate).toHaveBeenCalledWith(
      expect.any(ScopeRetentionStage),
      stagedPath,
      identity,
      request,
    );
    expect(analyzeRepo.mock.calls[0][0].options.scopeRetention).toMatchObject({
      deadline: request.deadline,
      artifactAllowance: request.artifactAllowance,
      consume: expect.any(Function),
    });
    expect(
      JSON.parse(
        await fs.readFile(
          path.join(overlay, current, 'scope-retention-candidate', 'manifest.json'),
          'utf8',
        ),
      ),
    ).toEqual(identity);
    expect(request.artifactAllowance.remainingBytes).toBe(4096 - artifactBytes);
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('publishes a real verifiable candidate with honest incomplete retention evidence', async () => {
    const writer = await vi.importActual<
      typeof import('../../src/core/ingestion/pipeline-phases/scope-retention-candidate.js')
    >('../../src/core/ingestion/pipeline-phases/scope-retention-candidate.js');
    const { verifyScopeRetentionCandidate } =
      await import('../../src/core/ingestion/pipeline-phases/scope-retention-candidate-reader.js');
    vi.mocked(persistScopeRetentionCandidate).mockImplementationOnce(
      writer.persistScopeRetentionCandidate,
    );
    const capture = await captureWorkspaceInputs(root);
    const manifestDigest = 'a'.repeat(64);
    vi.mocked(captureWorkspaceInputs)
      .mockClear()
      .mockResolvedValue({ ...capture, manifestDigest });
    const initialBytes = 1024 * 1024;
    const request: ScopeRetentionRequest = {
      deadline: Date.now() + 60_000,
      artifactAllowance: { remainingBytes: initialBytes },
    };

    await expect(build(request)).resolves.toMatchObject({ stats: { files: 1 } });

    const current = (await fs.readFile(path.join(overlay, 'CURRENT'), 'utf8')).trim();
    const generationPath = path.join(overlay, current);
    const identity = {
      sourceManifestDigest: manifestDigest,
      targetCommit: 'stable-head',
      baseGenerationId: null,
    };
    const manifest = await verifyScopeRetentionCandidate(
      generationPath,
      { identity, parserCodeIdentity: null },
      request,
    );
    expect(manifest).toMatchObject({
      version: 5,
      status: 'candidate',
      seedReady: false,
      identity,
      retention: {
        status: 'incomplete',
        graphNodesCaptured: false,
        graphRelationshipsCaptured: false,
        inputEvidence: { complete: false, parserCodeIdentity: null },
      },
      totalRecordCount: 0,
    });
    expect(manifest.artifactBytes).toBeGreaterThan(0);
    expect(request.artifactAllowance.remainingBytes).toBe(initialBytes - manifest.artifactBytes);
    expect(persistScopeRetentionCandidate).toHaveBeenCalledOnce();
    expect(persistScopeRetentionCandidate).toHaveBeenCalledWith(
      expect.any(ScopeRetentionStage),
      generationPath,
      identity,
      request,
    );
    expect(dispose).toHaveBeenCalledOnce();
  });

  it.each(['pipeline', 'publication'] as const)(
    'removes a retained candidate and refunds its bytes after %s failure',
    async (phase) => {
      const previous = '1-1-previous';
      await fs.mkdir(path.join(overlay, previous));
      await fs.writeFile(path.join(overlay, 'CURRENT'), `${previous}\n`);
      const request: ScopeRetentionRequest = {
        deadline: Date.now() + 60_000,
        artifactAllowance: { remainingBytes: 4096 },
      };
      const failure = new Error(`injected ${phase} failure after retention`);
      if (phase === 'pipeline') {
        const pipeline = analyzeRepo.getMockImplementation()!;
        analyzeRepo.mockImplementationOnce(async (...args) => {
          await pipeline(...args);
          expect(request.artifactAllowance.remainingBytes).toBeLessThan(4096);
          throw failure;
        });
      } else {
        const rename = fs.rename.bind(fs);
        vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
          if (to !== path.join(overlay, 'CURRENT')) return rename(from, to);
          expect(completed).toEqual(['retained', 'loaded', 'fts', 'closed']);
          expect(request.artifactAllowance.remainingBytes).toBeLessThan(4096);
          throw failure;
        });
      }

      await expect(build(request)).rejects.toBe(failure);

      expect(persistScopeRetentionCandidate).toHaveBeenCalledOnce();
      const generationPath = vi.mocked(persistScopeRetentionCandidate).mock.calls[0][1];
      await expect(fs.stat(generationPath)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await fs.readFile(path.join(overlay, 'CURRENT'), 'utf8')).toBe(`${previous}\n`);
      expect((await fs.readdir(overlay)).sort()).toEqual([previous, 'CURRENT'].sort());
      expect(request.artifactAllowance.remainingBytes).toBe(4096);
      expect(dispose).toHaveBeenCalledOnce();
    },
  );

  it.each(['workspace-without-request', 'symbols-with-request'] as const)(
    'does not persist retention for %s',
    async (mode) => {
      const request: ScopeRetentionRequest = {
        deadline: Date.now() + 60_000,
        artifactAllowance: { remainingBytes: 4096 },
      };
      if (mode === 'workspace-without-request') {
        await build();
      } else {
        await runFullAnalysis(
          root,
          { dirtyOverlay: true, overlayPaths: ['source.ts'], skipNativeClose: true },
          { onProgress: () => {}, onLog },
          { analyzeRuntime: { analyzeRepo }, scopeRetention: request },
        );
      }

      expect(persistScopeRetentionCandidate).not.toHaveBeenCalled();
      expect(analyzeRepo).toHaveBeenCalledOnce();
      expect(analyzeRepo.mock.calls[0][0].options).not.toHaveProperty('scopeRetention');
      expect(request.artifactAllowance.remainingBytes).toBe(4096);
      const current = (await fs.readFile(path.join(overlay, 'CURRENT'), 'utf8')).trim();
      await expect(
        fs.stat(path.join(overlay, current, 'scope-retention-candidate')),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    },
  );

  it('refunds a failed writer charge when outer generation cleanup succeeds', async () => {
    const previous = '1-1-previous';
    await fs.mkdir(path.join(overlay, previous));
    await fs.writeFile(path.join(overlay, 'CURRENT'), `${previous}\n`);
    const request: ScopeRetentionRequest = {
      deadline: Date.now() + 60_000,
      artifactAllowance: { remainingBytes: 4096 },
    };
    const failure = new AggregateError(
      [new Error('injected writer failure'), new Error('injected inner cleanup failure')],
      'scope-retention-candidate: cleanup failed',
    );
    const writer = vi.mocked(persistScopeRetentionCandidate).getMockImplementation()!;
    vi.mocked(persistScopeRetentionCandidate).mockImplementationOnce(async (...args) => {
      await writer(...args);
      expect(request.artifactAllowance.remainingBytes).toBeLessThan(4096);
      throw failure;
    });

    await expect(build(request)).rejects.toBe(failure);

    expect(persistScopeRetentionCandidate).toHaveBeenCalledOnce();
    const generationPath = vi.mocked(persistScopeRetentionCandidate).mock.calls[0][1];
    await expect(fs.stat(generationPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readFile(path.join(overlay, 'CURRENT'), 'utf8')).toBe(`${previous}\n`);
    expect((await fs.readdir(overlay)).sort()).toEqual([previous, 'CURRENT'].sort());
    expect(request.artifactAllowance.remainingBytes).toBe(4096);
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('keeps retained bytes charged when failed publication cannot remove the generation', async () => {
    const previous = '1-1-previous';
    await fs.mkdir(path.join(overlay, previous));
    await fs.writeFile(path.join(overlay, 'CURRENT'), `${previous}\n`);
    const request: ScopeRetentionRequest = {
      deadline: Date.now() + 60_000,
      artifactAllowance: { remainingBytes: 4096 },
    };
    const failure = new Error('injected publication failure');
    const rename = fs.rename.bind(fs);
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (to === path.join(overlay, 'CURRENT')) throw failure;
      await rename(from, to);
    });
    const rm = fs.rm.bind(fs);
    vi.spyOn(fs, 'rm').mockImplementation(async (target, options) => {
      const generationPath = vi.mocked(persistScopeRetentionCandidate).mock.calls[0]?.[1];
      if (target === generationPath) throw new Error('injected generation cleanup failure');
      await rm(target, options);
    });

    await expect(build(request)).rejects.toBe(failure);

    expect(persistScopeRetentionCandidate).toHaveBeenCalledOnce();
    const generationPath = vi.mocked(persistScopeRetentionCandidate).mock.calls[0][1];
    const candidate = await fs.readFile(
      path.join(generationPath, 'scope-retention-candidate', 'manifest.json'),
      'utf8',
    );
    expect(request.artifactAllowance.remainingBytes).toBe(4096 - Buffer.byteLength(candidate));
    expect(await fs.readFile(path.join(overlay, 'CURRENT'), 'utf8')).toBe(`${previous}\n`);
    expect(await temporaryPointers()).toEqual([]);
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('has a closed, loaded, indexed database and base metadata before renaming CURRENT', async () => {
    const rename = fs.rename.bind(fs);
    const snapshots: unknown[] = [];
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (to === path.join(overlay, 'CURRENT')) {
        const generationId = (await fs.readFile(from, 'utf8')).trim();
        const generationPath = path.join(overlay, generationId);
        snapshots.push({
          from,
          generationId,
          completed: [...completed],
          closedPaths: vi.mocked(closeLbugForPath).mock.calls.map(([dbPath]) => dbPath),
          database: await fs.readFile(path.join(generationPath, 'lbug'), 'utf8'),
          base: JSON.parse(await fs.readFile(path.join(generationPath, 'base.json'), 'utf8')),
        });
      }
      await rename(from, to);
    });

    await expect(build()).resolves.toMatchObject({ stats: { nodes: 1, edges: 0, files: 1 } });

    const generationId = (await fs.readFile(path.join(overlay, 'CURRENT'), 'utf8')).trim();
    expect(snapshots).toEqual([
      {
        from: path.join(overlay, `.CURRENT-${generationId}.tmp`),
        generationId,
        completed: ['loaded', 'fts', 'closed'],
        closedPaths: [path.join(overlay, generationId, 'lbug')],
        database: 'generation database',
        base: expect.objectContaining({
          head: 'stable-head',
          capability: 'workspace-graph',
          ftsIndexes: expect.arrayContaining([expect.any(String)]),
        }),
      },
    ]);
    expect(await temporaryPointers()).toEqual([]);
    expect(dispose).toHaveBeenCalledOnce();
  });

  it.each([true, false])(
    'cleans the staged pointer when publication throws (existing CURRENT: %s)',
    async (existingCurrent) => {
      const previous = '1-1-previous\n';
      if (existingCurrent) {
        await fs.mkdir(path.join(overlay, previous.trim()));
        await fs.writeFile(path.join(overlay, 'CURRENT'), previous);
      }
      const rename = fs.rename.bind(fs);
      const failure = new Error('injected failure immediately before publication');
      let stagedGeneration: string | undefined;
      vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
        if (to !== path.join(overlay, 'CURRENT')) return rename(from, to);
        stagedGeneration = (await fs.readFile(from, 'utf8')).trim();
        expect(
          await fs.readFile(path.join(overlay, stagedGeneration, 'base.json'), 'utf8'),
        ).toContain('workspace-graph');
        expect(completed).toEqual(['loaded', 'fts', 'closed']);
        throw failure;
      });

      await expect(build()).rejects.toBe(failure);

      expect(stagedGeneration).toBeDefined();
      if (existingCurrent) {
        expect(await fs.readFile(path.join(overlay, 'CURRENT'), 'utf8')).toBe(previous);
      } else {
        await expect(fs.stat(path.join(overlay, 'CURRENT'))).rejects.toMatchObject({
          code: 'ENOENT',
        });
      }
      expect(await temporaryPointers()).toEqual([]);
      await expect(fs.stat(path.join(overlay, stagedGeneration!))).rejects.toMatchObject({
        code: 'ENOENT',
      });
      expect(dispose).toHaveBeenCalledOnce();
    },
  );

  it.each([true, false])(
    'refuses to publish when the generation database cannot be closed (existing CURRENT: %s)',
    async (existingCurrent) => {
      const previous = '1-1-previous\n';
      if (existingCurrent) {
        await fs.mkdir(path.join(overlay, previous.trim()));
        await fs.writeFile(path.join(overlay, 'CURRENT'), previous);
      }
      const failure = new Error('native close failed');
      // Only a strict close reports the native failure; a best-effort close swallows it.
      vi.mocked(closeLbugForPath).mockImplementation(async (_dbPath, options) => {
        if (options?.strict) throw failure;
      });

      await expect(build()).rejects.toBe(failure);

      if (existingCurrent) {
        expect(await fs.readFile(path.join(overlay, 'CURRENT'), 'utf8')).toBe(previous);
      } else {
        await expect(fs.stat(path.join(overlay, 'CURRENT'))).rejects.toMatchObject({
          code: 'ENOENT',
        });
      }
      expect(await temporaryPointers()).toEqual([]);
      expect(dispose).toHaveBeenCalledOnce();
    },
  );

  for (const identityFailure of ['changed', 'unreadable'] as const) {
    it.each([true, false])(
      `refuses publication for ${identityFailure} parser artifacts and cleans up (existing CURRENT: %s)`,
      async (existingCurrent) => {
        const previous = '1-1-previous';
        if (existingCurrent) {
          await fs.mkdir(path.join(overlay, previous));
          await fs.writeFile(path.join(overlay, 'CURRENT'), `${previous}\n`);
        }
        let stagedGeneration: string | undefined;
        const failure = new Error('Parser artifact inventory limit exceeded');
        vi.mocked(syncPath).mockImplementation(async (target) => {
          if (!path.basename(target).startsWith('.CURRENT-')) return;
          stagedGeneration = (await fs.readFile(target, 'utf8')).trim();
          expect(completed).toEqual(['loaded', 'fts', 'closed']);
          expect(
            await fs.readFile(path.join(overlay, stagedGeneration, 'base.json'), 'utf8'),
          ).toContain('workspace-graph');
          if (identityFailure === 'changed') {
            vi.mocked(workspaceParserIdentity).mockResolvedValue('changed-parser');
          } else {
            vi.mocked(workspaceParserIdentity).mockRejectedValue(failure);
          }
        });
        const rename = vi.spyOn(fs, 'rename');

        if (identityFailure === 'changed') {
          await expect(build()).rejects.toThrow(
            'Workspace parser identity changed during analysis; restart required.',
          );
        } else {
          await expect(build()).rejects.toBe(failure);
        }

        expect(workspaceParserIdentity).toHaveBeenCalledOnce();
        expect(stagedGeneration).toBeDefined();
        expect(rename.mock.calls.some(([, to]) => to === path.join(overlay, 'CURRENT'))).toBe(
          false,
        );
        expect((await fs.readdir(overlay)).sort()).toEqual(
          existingCurrent ? [previous, 'CURRENT'] : [],
        );
        if (existingCurrent) {
          expect(await fs.readFile(path.join(overlay, 'CURRENT'), 'utf8')).toBe(`${previous}\n`);
        }
        await expect(fs.stat(path.join(overlay, stagedGeneration!))).rejects.toMatchObject({
          code: 'ENOENT',
        });
        expect(await temporaryPointers()).toEqual([]);
        expect(dispose).toHaveBeenCalledOnce();
      },
    );
  }

  it('keeps the published generation successful when post-publication pruning throws', async () => {
    const previous = '1-1-previous';
    await fs.mkdir(path.join(overlay, previous));
    await fs.writeFile(path.join(overlay, 'CURRENT'), `${previous}\n`);
    let publishedAtPrune: string | undefined;
    vi.mocked(pruneOverlayGenerations)
      .mockResolvedValueOnce(false)
      .mockImplementationOnce(async (_overlayPath, generationId) => {
        publishedAtPrune = (await fs.readFile(path.join(overlay, 'CURRENT'), 'utf8')).trim();
        expect(publishedAtPrune).toBe(generationId);
        throw new Error('injected post-publication prune failure');
      });

    await expect(build()).resolves.toMatchObject({ stats: { nodes: 1, edges: 0, files: 1 } });

    const current = (await fs.readFile(path.join(overlay, 'CURRENT'), 'utf8')).trim();
    expect(current).not.toBe(previous);
    expect(publishedAtPrune).toBe(current);
    expect(pruneOverlayGenerations).toHaveBeenNthCalledWith(1, overlay, previous);
    expect(pruneOverlayGenerations).toHaveBeenNthCalledWith(2, overlay, current);
    expect(
      JSON.parse(await fs.readFile(path.join(overlay, current, 'base.json'), 'utf8')),
    ).toMatchObject({ capability: 'workspace-graph', head: 'stable-head' });
    expect(await fs.readFile(path.join(overlay, current, 'lbug'), 'utf8')).toBe(
      'generation database',
    );
    expect(await temporaryPointers()).toEqual([]);
    expect(onLog).toHaveBeenCalledWith(
      'Dirty overlay published; some old generations could not be pruned.',
    );
    expect(dispose).toHaveBeenCalledOnce();
  });
});
