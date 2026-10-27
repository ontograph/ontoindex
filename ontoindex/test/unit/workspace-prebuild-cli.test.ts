import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { analyzeCommand, prepareWorkspaceGraphCommand } from '../../src/cli/analyze.js';
import { MANAGED_ANALYSIS_ENV } from '../../src/core/analysis/analysis-publication-receipt.js';
import type { OverlaySnapshot } from '../../src/mcp/local/backend-overlay.js';

const { getSnapshot, evictSnapshot, automaticEnabled, buildGraph, readMeta } = vi.hoisted(() => ({
  getSnapshot: vi.fn(),
  evictSnapshot: vi.fn(),
  automaticEnabled: vi.fn(),
  buildGraph: vi.fn(),
  readMeta: vi.fn(),
}));

vi.mock('../../src/mcp/local/backend-overlay.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/mcp/local/backend-overlay.js')>()),
  getOverlaySnapshot: getSnapshot,
  evictOverlayState: evictSnapshot,
  isAutomaticWorkspaceEnabled: automaticEnabled,
}));
vi.mock('../../src/mcp/local/local-backend-repo-runtime.js', () => ({
  buildWorkspaceGraph: buildGraph,
}));
vi.mock('../../src/storage/repo-manager.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/storage/repo-manager.js')>()),
  readActiveGenerationMeta: readMeta,
}));

const tempDirs: string[] = [];
async function makeRepo() {
  const repoPath = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-prebuild-')),
  );
  tempDirs.push(repoPath);
  return repoPath;
}

function snapshot(overrides: Partial<OverlaySnapshot> = {}): OverlaySnapshot {
  return {
    usable: false,
    reason: 'missing',
    dirtyPaths: new Set(['sample.ts']),
    parseErrorPaths: new Set(),
    overlayPaths: new Set(),
    uncoveredPaths: new Set(),
    tombstones: new Set(),
    baseMatches: true,
    headChanged: false,
    ...overrides,
  };
}

function completeGraph(overrides: Partial<OverlaySnapshot> = {}) {
  return snapshot({
    usable: true,
    reason: null,
    capability: 'workspace-graph',
    coverage: 'complete',
    overlayPaths: new Set(['sample.ts']),
    generation: 'workspace-generation',
    ...overrides,
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  automaticEnabled.mockReturnValue(true);
  readMeta.mockResolvedValue({ meta: { lastCommit: 'a'.repeat(40) } });
  getSnapshot.mockResolvedValue(completeGraph());
  buildGraph.mockResolvedValue(undefined);
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  process.exitCode = undefined;
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('explicit workspace graph prebuild', () => {
  it('rejects managed analysis context before creating storage', async () => {
    const repoPath = await makeRepo();
    const head = 'a'.repeat(40);
    const managed = {
      jobId: 'prebuild-fixture',
      targetHead: head,
      optionsDigest: 'b'.repeat(64),
      sourceIdentity: `commit:${head}`,
      sourceManifestDigest: 'c'.repeat(64),
      requestedCapabilities: JSON.stringify({
        version: 1,
        graph: true,
        graphCapabilities: ['symbols'],
        embeddings: false,
        embeddingModelHash: null,
      }),
    };
    for (const [key, envName] of Object.entries(MANAGED_ANALYSIS_ENV)) {
      vi.stubEnv(envName, managed[key as keyof typeof managed]);
    }
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await analyzeCommand(repoPath, { workspaceGraph: true });

    expect(process.exitCode).toBe(1);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('managed analysis'));
    expect(buildGraph).not.toHaveBeenCalled();
    await expect(fs.access(path.join(repoPath, '.ontoindex'))).rejects.toThrow();
  });

  it('reuses a matching complete graph without invoking the builder', async () => {
    const repoPath = await makeRepo();
    const result = await prepareWorkspaceGraphCommand(repoPath);

    expect(result).toMatchObject({ reused: true, snapshot: completeGraph() });
    expect(buildGraph).not.toHaveBeenCalled();
    await expect(fs.access(path.join(repoPath, '.ontoindex', 'analyze.lock'))).rejects.toThrow();
  });

  it('accepts a current clean base without building a disposable graph', async () => {
    const repoPath = await makeRepo();
    getSnapshot.mockResolvedValue(snapshot({ dirtyPaths: new Set(), configPaths: new Set() }));

    await expect(prepareWorkspaceGraphCommand(repoPath)).resolves.toMatchObject({
      baseCurrent: true,
    });
    expect(buildGraph).not.toHaveBeenCalled();
  });

  it.each(['disabled automatic workspace', 'missing committed base'])(
    'refuses %s before creating storage',
    async (condition) => {
      const repoPath = await makeRepo();
      if (condition === 'disabled automatic workspace') automaticEnabled.mockReturnValue(false);
      else readMeta.mockResolvedValue({ meta: null });

      await expect(prepareWorkspaceGraphCommand(repoPath)).rejects.toThrow();
      expect(buildGraph).not.toHaveBeenCalled();
      await expect(fs.access(path.join(repoPath, '.ontoindex'))).rejects.toThrow();
    },
  );

  it('holds the analyze lock until the supervised build settles and verifies a fresh snapshot', async () => {
    const repoPath = await makeRepo();
    const signal = new AbortController().signal;
    let settle!: () => void;
    getSnapshot.mockResolvedValueOnce(snapshot()).mockResolvedValue(completeGraph());
    buildGraph.mockImplementation(
      async () =>
        new Promise<void>((resolve) => {
          settle = resolve;
        }),
    );

    const pending = prepareWorkspaceGraphCommand(repoPath, signal);
    await vi.waitFor(() => expect(buildGraph).toHaveBeenCalledOnce());
    const lockPath = path.join(repoPath, '.ontoindex', 'analyze.lock');
    expect(JSON.parse(await fs.readFile(lockPath, 'utf8')).pid).toBe(process.pid);
    expect(buildGraph).toHaveBeenCalledWith(
      { id: repoPath, repoPath, storagePath: path.join(repoPath, '.ontoindex') },
      signal,
      undefined,
      true,
    );
    settle();

    await expect(pending).resolves.toMatchObject({ reused: false, snapshot: completeGraph() });
    expect(evictSnapshot).toHaveBeenCalledWith(repoPath);
    expect(getSnapshot).toHaveBeenCalledTimes(2);
    await expect(fs.access(lockPath)).rejects.toThrow();
  });

  it.each([
    ['stale', { usable: false, reason: 'inputs changed' }],
    ['degraded', { coverage: 'degraded' }],
    ['missing coverage', { coverage: undefined }],
    ['symbols only', { capability: 'symbols' }],
  ] as const)('rejects a %s result and releases the lock', async (_condition, overrides) => {
    const repoPath = await makeRepo();
    getSnapshot.mockResolvedValueOnce(snapshot()).mockResolvedValue(completeGraph(overrides));

    await expect(prepareWorkspaceGraphCommand(repoPath)).rejects.toThrow();
    expect(buildGraph).toHaveBeenCalledOnce();
    await expect(fs.access(path.join(repoPath, '.ontoindex', 'analyze.lock'))).rejects.toThrow();
  });

  it('preserves partial coverage in the prepared result', async () => {
    const repoPath = await makeRepo();
    getSnapshot
      .mockResolvedValueOnce(snapshot())
      .mockResolvedValue(completeGraph({ coverage: 'partial' }));

    await expect(prepareWorkspaceGraphCommand(repoPath)).resolves.toMatchObject({
      reused: false,
      snapshot: { capability: 'workspace-graph', coverage: 'partial' },
    });
  });

  it('releases the lock after a build failure', async () => {
    const repoPath = await makeRepo();
    getSnapshot.mockResolvedValue(snapshot());
    buildGraph.mockRejectedValue(new Error('supervised child failed'));

    await expect(prepareWorkspaceGraphCommand(repoPath)).rejects.toThrow('supervised child failed');
    await expect(fs.access(path.join(repoPath, '.ontoindex', 'analyze.lock'))).rejects.toThrow();
  });

  it('passes cancellation to the builder and retains the lock until cancellation drains', async () => {
    const repoPath = await makeRepo();
    const controller = new AbortController();
    let settle!: () => void;
    getSnapshot.mockResolvedValue(snapshot());
    buildGraph.mockImplementation(async (_repo, signal) => {
      expect(signal).toBe(controller.signal);
      await new Promise<void>((resolve) => {
        settle = resolve;
      });
      signal.throwIfAborted();
    });
    const pending = prepareWorkspaceGraphCommand(repoPath, controller.signal);
    const rejected = expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(buildGraph).toHaveBeenCalledOnce());
    controller.abort();
    const lockPath = path.join(repoPath, '.ontoindex', 'analyze.lock');
    await expect(fs.access(lockPath)).resolves.toBeUndefined();
    settle();

    await rejected;
    await expect(fs.access(lockPath)).rejects.toThrow();
  });

  it.each([
    ['SIGINT', 130],
    ['SIGTERM', 143],
  ] as const)(
    'aborts the CLI build on %s and drains before releasing its lock',
    async (signalName, exitCode) => {
      const repoPath = await makeRepo();
      const listeners = {
        SIGINT: process.listeners('SIGINT'),
        SIGTERM: process.listeners('SIGTERM'),
      };
      let settle!: () => void;
      let buildSignal!: AbortSignal;
      getSnapshot.mockResolvedValue(snapshot());
      buildGraph.mockImplementation(async (_repo, signal: AbortSignal) => {
        buildSignal = signal;
        await new Promise<void>((resolve) => {
          settle = resolve;
        });
        signal.throwIfAborted();
      });
      vi.spyOn(console, 'error').mockImplementation(() => {});

      const pending = analyzeCommand(repoPath, { workspaceGraph: true });
      try {
        await vi.waitFor(() => expect(buildGraph).toHaveBeenCalledOnce());
        expect(buildSignal.aborted).toBe(false);
        process.emit(signalName);

        expect(buildSignal.aborted).toBe(true);
        const lockPath = path.join(repoPath, '.ontoindex', 'analyze.lock');
        await expect(fs.access(lockPath)).resolves.toBeUndefined();
        settle();
        await pending;

        expect(process.exitCode).toBe(exitCode);
        await expect(fs.access(lockPath)).rejects.toThrow();
        expect(process.listeners('SIGINT')).toEqual(listeners.SIGINT);
        expect(process.listeners('SIGTERM')).toEqual(listeners.SIGTERM);
      } finally {
        settle?.();
        await pending;
      }
    },
  );

  it('removes CLI signal listeners and releases the lock after an ordinary build failure', async () => {
    const repoPath = await makeRepo();
    const listeners = {
      SIGINT: process.listeners('SIGINT'),
      SIGTERM: process.listeners('SIGTERM'),
    };
    getSnapshot.mockResolvedValue(snapshot());
    buildGraph.mockRejectedValue(new Error('supervised child failed'));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await analyzeCommand(repoPath, { workspaceGraph: true });

    expect(process.exitCode).toBe(1);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('supervised child failed'));
    await expect(fs.access(path.join(repoPath, '.ontoindex', 'analyze.lock'))).rejects.toThrow();
    expect(process.listeners('SIGINT')).toEqual(listeners.SIGINT);
    expect(process.listeners('SIGTERM')).toEqual(listeners.SIGTERM);
  });
});
