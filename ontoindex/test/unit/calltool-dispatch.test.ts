/**
 * Unit Tests: LocalBackend callTool dispatch & lifecycle
 *
 * Tests the callTool dispatch logic, resolveRepo, init/disconnect,
 * error cases, and silent failure patterns — all with mocked LadybugDB.
 *
 * These are pure unit tests that mock the LadybugDB layer to test
 * the dispatch and error handling logic in isolation.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

// We need to mock the LadybugDB adapter and repo-manager BEFORE importing LocalBackend.
// local-backend.ts imports from core/lbug/pool-adapter.js; the mcp/core/lbug-adapter.js
// re-exports from the same module, so we mock the canonical source.
// vi.hoisted runs before vi.mock hoisting, making the fns available to both factories.
const { lbugMocks } = vi.hoisted(() => ({
  lbugMocks: {
    initLbug: vi.fn().mockResolvedValue(undefined),
    executeQuery: vi.fn().mockResolvedValue([]),
    executeParameterized: vi.fn().mockResolvedValue([]),
    closeLbug: vi.fn().mockResolvedValue(undefined),
    isLbugReady: vi.fn().mockReturnValue(true),
  },
}));

vi.mock('../../src/core/lbug/pool-adapter.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, ...lbugMocks };
});

// Re-export shim must resolve to the same mocks
vi.mock('../../src/mcp/core/lbug-adapter.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, ...lbugMocks };
});

vi.mock('../../src/storage/repo-manager.js', () => ({
  listRegisteredRepos: vi.fn().mockResolvedValue([]),
  resolveActiveIndexGeneration: vi.fn().mockResolvedValue(null),
  readActiveGenerationMeta: vi.fn().mockResolvedValue({ meta: null, authority: 'untrusted' }),
  cleanupOldKuzuFiles: vi.fn().mockResolvedValue({ found: false, needsReindex: false }),
}));

vi.mock('../../src/mcp/super/diagnose.js', () => ({
  gnDiagnose: vi.fn().mockResolvedValue({ misconfiguration: { status: 'ok' } }),
}));

vi.mock('../../src/core/analyze-delta.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/analyze-delta.js')>();
  return { ...actual, planDirtyOverlay: vi.fn(actual.planDirtyOverlay) };
});

// Also mock the search modules to avoid loading onnxruntime
vi.mock('../../src/core/search/bm25-index.js', () => ({
  searchFTSFromLbug: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../src/mcp/core/embedder.js', () => ({
  embedQuery: vi.fn().mockResolvedValue([]),
  getEmbeddingDims: vi.fn().mockReturnValue(384),
}));

vi.mock('../../src/mcp/local/backend-overlay.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/mcp/local/backend-overlay.js')>();
  return {
    ...actual,
    getOverlaySnapshot: vi.fn(async () => ({
      usable: false,
      reason: 'no dirty files',
      dirtyPaths: new Set<string>(),
      parseErrorPaths: new Set<string>(),
      overlayPaths: new Set<string>(),
      uncoveredPaths: new Set<string>(),
      tombstones: new Set<string>(),
    })),
    withPinnedOverlay: vi.fn(async (_repo, _snapshot, fn) => fn()),
  };
});

vi.mock('../../src/mcp/local/local-backend-repo-runtime.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../src/mcp/local/local-backend-repo-runtime.js')>();
  return {
    ...actual,
    prepareWorkspaceRead: vi.fn(({ repo }) => getOverlaySnapshot(repo)),
  };
});

import { LocalBackend, getReadRequestContext } from '../../src/mcp/local/local-backend.js';
import { gnDiagnose } from '../../src/mcp/super/diagnose.js';
import {
  prepareWorkspaceRead,
  WorkspacePreparationError,
} from '../../src/mcp/local/local-backend-repo-runtime.js';
import * as runtimeModule from '../../src/mcp/local/local-backend-repo-runtime.js';
import {
  getOverlaySnapshot,
  withPinnedOverlay,
  type OverlaySnapshot,
} from '../../src/mcp/local/backend-overlay.js';
import {
  listRegisteredRepos,
  cleanupOldKuzuFiles,
  readActiveGenerationMeta,
} from '../../src/storage/repo-manager.js';
import { planDirtyOverlay } from '../../src/core/analyze-delta.js';
import {
  initLbug,
  executeQuery,
  executeParameterized,
  isLbugReady,
  closeLbug,
} from '../../src/mcp/core/lbug-adapter.js';

// ─── Helpers ─────────────────────────────────────────────────────────

const MOCK_REPO_ENTRY = {
  name: 'test-project',
  path: path.join(os.tmpdir(), 'test-project'),
  storagePath: path.join(os.tmpdir(), '.ontoindex', 'test-project'),
  indexedAt: '2024-06-01T12:00:00Z',
  lastCommit: 'abc1234567890',
  stats: { files: 10, nodes: 50, edges: 100, communities: 3, processes: 5 },
};

const tmpDirs: string[] = [];

function setupSingleRepo() {
  (listRegisteredRepos as any).mockResolvedValue([MOCK_REPO_ENTRY]);
}

function setupMultipleRepos() {
  (listRegisteredRepos as any).mockResolvedValue([
    MOCK_REPO_ENTRY,
    {
      ...MOCK_REPO_ENTRY,
      name: 'other-project',
      path: path.join(os.tmpdir(), 'other-project'),
      storagePath: path.join(os.tmpdir(), '.ontoindex', 'other-project'),
    },
  ]);
}

function setupNoRepos() {
  (listRegisteredRepos as any).mockResolvedValue([]);
}

async function setupMultipleReposWithReadableOther() {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ontoindex-filter-'));
  tmpDirs.push(tmpRoot);
  const otherPath = path.join(tmpRoot, 'other-project');
  const otherStorage = path.join(tmpRoot, 'other-index');
  await fs.mkdir(otherStorage, { recursive: true });
  await fs.writeFile(path.join(otherStorage, 'meta.json'), '{}');

  const otherRepo = {
    ...MOCK_REPO_ENTRY,
    name: 'other-project',
    path: otherPath,
    storagePath: otherStorage,
  };
  (listRegisteredRepos as any).mockResolvedValue([MOCK_REPO_ENTRY, otherRepo]);
  return otherRepo;
}

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

// ─── LocalBackend lifecycle ──────────────────────────────────────────

describe('request workspace gate', () => {
  let backend: LocalBackend;
  const cleanSnapshot = (): OverlaySnapshot => ({
    usable: false,
    reason: 'no dirty files',
    dirtyPaths: new Set(),
    parseErrorPaths: new Set(),
    overlayPaths: new Set(),
    uncoveredPaths: new Set(),
    tombstones: new Set(),
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.mocked(prepareWorkspaceRead).mockImplementation(({ repo }) => getOverlaySnapshot(repo));
    vi.mocked(getOverlaySnapshot).mockImplementation(async () => cleanSnapshot());
    vi.mocked(withPinnedOverlay).mockImplementation(async (_repo, _snapshot, fn) => fn());
    backend = new LocalBackend();
    setupSingleRepo();
    await backend.init();
  });

  it.each([false, true])(
    'shares direct prepared callbacks and releases on failure=%s',
    async (fails) => {
      const repo = await backend.resolveRepo();
      vi.mocked(prepareWorkspaceRead).mockResolvedValue({
        ...cleanSnapshot(),
        usable: true,
        generation: 'direct',
      });
      let release!: ReturnType<typeof vi.spyOn>;
      const operation = vi.fn(async () => {
        const context = getReadRequestContext()!;
        release = vi.spyOn(context, 'release');
        return backend.withPreparedRepoRead(repo, { needsRelationships: true }, async () => {
          expect(getReadRequestContext()).toBe(context);
          if (fails) throw new Error('direct failure');
          return 'direct';
        });
      });
      const result = backend.withPreparedRepoRead(
        repo,
        { needsRelationships: true, wantsWorkspaceGraph: true },
        operation,
      );
      if (fails) await expect(result).rejects.toThrow('direct failure');
      else await expect(result).resolves.toBe('direct');
      expect(operation).toHaveBeenCalledOnce();
      expect(prepareWorkspaceRead).toHaveBeenCalledOnce();
      expect(withPinnedOverlay).toHaveBeenCalledOnce();
      expect(release).toHaveBeenCalledOnce();
      expect(getReadRequestContext()).toBeUndefined();
    },
  );

  it('rejects direct callbacks before entry when preparation fails', async () => {
    const repo = await backend.resolveRepo();
    vi.mocked(prepareWorkspaceRead).mockRejectedValueOnce(new Error('private-path'));
    const operation = vi.fn(async () => 'unreachable');
    await expect(
      backend.withPreparedRepoRead(repo, { needsRelationships: true }, operation),
    ).rejects.toMatchObject({
      code: 'workspace_preparation_failed',
      message: 'workspace_preparation_failed',
    });
    expect(operation).not.toHaveBeenCalled();
  });

  it('gates nested reads once and shares the context and fixed deadline', async () => {
    let outer: ReturnType<typeof getReadRequestContext>;
    const handlers = (backend as any).repoToolHandlers;
    handlers.overview = async () => {
      outer = getReadRequestContext();
      return backend.callTool('route_map', {});
    };
    handlers.route_map = async () => {
      expect(getReadRequestContext()).toBe(outer);
      expect(outer!.deadline).toBeGreaterThan(performance.now() + 59_000);
      return ['nested'];
    };
    expect(await backend.callTool('overview', { timeoutMs: 1 })).toEqual(['nested']);
    expect(getOverlaySnapshot).toHaveBeenCalledTimes(1);
    expect(prepareWorkspaceRead).toHaveBeenCalledTimes(1);
    expect(getReadRequestContext()).toBeUndefined();
  });

  it.each([false, true])(
    'pins usable generations and releases on handler error=%s',
    async (fails) => {
      vi.mocked(getOverlaySnapshot).mockResolvedValue({
        ...cleanSnapshot(),
        usable: true,
        generation: 'g1',
      });
      let release: ReturnType<typeof vi.spyOn>;
      (backend as any).repoToolHandlers.overview = async () => {
        release = vi.spyOn(getReadRequestContext()!, 'release');
        expect(withPinnedOverlay).toHaveBeenCalledTimes(1);
        if (fails) throw new Error('handler failed');
        return ['ok'];
      };
      const call = backend.callTool('overview', {});
      if (fails) await expect(call).rejects.toThrow('handler failed');
      else expect(await call).toEqual(['ok']);
      expect(release!).toHaveBeenCalledTimes(1);
      await getReadRequestContext()?.release();
    },
  );

  it('inherits operation signals through nested scopes and isolates concurrent requests', async () => {
    const first = new AbortController();
    const second = new AbortController();
    const preparations: Array<{ signal?: AbortSignal; finish(): void }> = [];
    vi.mocked(prepareWorkspaceRead).mockImplementation(
      ({ signal }) =>
        new Promise((resolve) => {
          preparations.push({ signal, finish: () => resolve(cleanSnapshot()) });
        }),
    );
    const seen: Array<AbortSignal | undefined> = [];
    (backend as any).repoToolHandlers.overview = async () => {
      seen.push(getReadRequestContext()?.signal);
      return backend.withOperation(() => backend.callTool('route_map', {}));
    };
    (backend as any).repoToolHandlers.route_map = async () => {
      seen.push(getReadRequestContext()?.signal);
      return [];
    };
    const firstRequest = backend.withOperation(
      () => backend.withOperation(() => backend.callTool('overview', {})),
      { signal: first.signal },
    );
    const secondRequest = backend.withOperation(() => backend.callTool('overview', {}), {
      signal: second.signal,
    });
    await vi.waitFor(() => expect(preparations).toHaveLength(2));
    expect(preparations.map(({ signal }) => signal)).toEqual(
      expect.arrayContaining([first.signal, second.signal]),
    );
    preparations.find(({ signal }) => signal === second.signal)!.finish();
    await secondRequest;
    preparations.find(({ signal }) => signal === first.signal)!.finish();
    await firstRequest;
    expect(seen).toEqual([second.signal, second.signal, first.signal, first.signal]);
    const unscopedRequest = backend.callTool('route_map', {});
    await vi.waitFor(() => expect(preparations).toHaveLength(3));
    expect(preparations[2].signal).toBeUndefined();
    preparations[2].finish();
    await unscopedRequest;
  });

  it('cancels only the waiting request before invoking its handler', async () => {
    const cancelled = new AbortController();
    let finish!: () => void;
    const building = new Promise<OverlaySnapshot>((resolve) => {
      finish = () => resolve(cleanSnapshot());
    });
    vi.mocked(prepareWorkspaceRead).mockImplementation(
      ({ signal }) =>
        new Promise((resolve, reject) => {
          const onAbort = () => reject(new WorkspacePreparationError('workspace_cancelled'));
          signal?.addEventListener('abort', onAbort, { once: true });
          void building.then((snapshot) => {
            signal?.removeEventListener('abort', onAbort);
            resolve(snapshot);
          });
        }),
    );
    const handler = vi.fn(async () => []);
    (backend as any).repoToolHandlers.overview = handler;
    const cancelledRequest = backend.withOperation(() => backend.callTool('overview', {}), {
      signal: cancelled.signal,
    });
    const survivingRequest = backend.callTool('overview', {});
    await vi.waitFor(() => expect(prepareWorkspaceRead).toHaveBeenCalledTimes(2));
    cancelled.abort();
    await expect(cancelledRequest).rejects.toMatchObject({ code: 'workspace_cancelled' });
    expect(handler).not.toHaveBeenCalled();
    finish();
    await expect(survivingRequest).resolves.toEqual([]);
    expect(handler).toHaveBeenCalledOnce();
  });

  it.each([
    ['context', true],
    ['impact', true],
    ['impact_batch', true],
    ['api_impact', true],
    ['cycle_detect', true],
    ['coupling_matrix', true],
    ['boundary_violations', true],
    ['hotspot_analysis', true],
    ['dead_code', true],
    ['tech_debt', true],
    ['audit_report', true],
    ['ipc_trace', true],
    ['evidence_pack', true],
    ['query', false],
    ['repomap', false],
  ])('prepares %s with needsRelationships=%s', async (method, needsRelationships) => {
    (backend as any).repoToolHandlers[method as string] = async () => [];
    await (backend as any).dispatchRepoTool(method, {});
    expect(prepareWorkspaceRead).toHaveBeenCalledWith({
      repo: expect.objectContaining({ repoPath: MOCK_REPO_ENTRY.path }),
      needsRelationships,
      beforeSnapshot: expect.any(Function),
      wantsWorkspaceGraph: needsRelationships || method === 'query' || method === 'repomap',
      deadline: expect.any(Number),
      signal: undefined,
    });
  });

  it('keeps diagnostic, history, lifecycle, mutation and global routes ungated', async () => {
    for (const method of [
      'gn_diagnose',
      'analysis_catalog',
      'session',
      'detect_changes',
      'graph_diff',
      'audit_rerun',
      'rename',
      'rename_symbol',
      'sandbox',
      'replace_symbol',
      'update_symbol_body',
      'extract_function',
      'move_symbol',
    ]) {
      (backend as any).repoToolHandlers[method] = async () => [];
      await (backend as any).dispatchRepoTool(method, {});
    }
    await backend.callTool('list_repos', {});
    expect(getOverlaySnapshot).not.toHaveBeenCalled();
    expect(prepareWorkspaceRead).not.toHaveBeenCalled();
  });

  it('fails preparation with a typed error before running the handler', async () => {
    vi.mocked(getOverlaySnapshot).mockRejectedValueOnce(new Error('capture failed'));
    const handler = vi.fn();
    (backend as any).repoToolHandlers.overview = handler;
    await expect(backend.callTool('overview', {})).rejects.toMatchObject({
      code: 'workspace_preparation_failed',
      message: 'workspace_preparation_failed',
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it.each([
    ['workspace_busy', true],
    ['workspace_timeout', true],
    ['workspace_cancelled', false],
    ['workspace_build_failed', false],
    ['workspace_too_large', false],
  ] as const)('preserves preparation code %s and retryability', async (code, retryable) => {
    const original = new WorkspacePreparationError(
      code,
      'secret=preparation-token\nsource: private.ts',
    );
    vi.mocked(prepareWorkspaceRead).mockRejectedValueOnce(original);
    const handler = vi.fn();
    (backend as any).repoToolHandlers.overview = handler;
    const failure = await backend.callTool('overview', {}).catch((error: unknown) => error);
    expect(failure).toMatchObject({
      code,
      retryable,
      message: `workspace_preparation_failed: ${code}`,
      cause: original,
    });
    expect(JSON.stringify(failure)).not.toMatch(/preparation-token|private\.ts/);
    expect(handler).not.toHaveBeenCalled();
  });

  describe('committed fallback for a refused working-tree graph', () => {
    const tooLarge = () =>
      new WorkspacePreparationError('workspace_too_large', 'too large', undefined, {
        observedIndexedFiles: 7002,
        maxIndexedFiles: 1600,
        requiredCapability: 'workspace-graph',
      });
    const dirtyPlan = (count: number) => ({
      includePaths: Array.from(
        { length: count },
        (_, i) => `src/dirty-${String(i).padStart(2, '0')}.rs`,
      ),
      uncoveredPaths: [],
      allDirtyPaths: [],
      tombstones: [],
      tooMany: false,
      skipped: [],
    });

    it('answers from the committed index and names the uncovered dirty files', async () => {
      vi.mocked(prepareWorkspaceRead).mockRejectedValueOnce(tooLarge());
      vi.mocked(planDirtyOverlay).mockResolvedValueOnce(dirtyPlan(12) as any);
      const real = backend.withPreparedRepoRead.bind(backend);
      const gate = vi
        .spyOn(backend, 'withPreparedRepoRead')
        .mockImplementation(async (repo, options, operation) =>
          options.readMode === 'committed'
            ? ((await operation()) as any)
            : real(repo, options, operation),
        );
      (backend as any).repoToolHandlers.context = async () => ({ status: 'found', warnings: [] });
      const result = (await backend.callTool('context', { name: 'x' })) as {
        status: string;
        warnings: string[];
      };
      expect(result.status).toBe('found');
      expect(gate).toHaveBeenLastCalledWith(
        expect.anything(),
        { needsRelationships: true, readMode: 'committed' },
        expect.any(Function),
      );
      const note = result.warnings.find((w) => w.includes('workspace_too_large'))!;
      expect(note).toContain('answered from the committed index');
      expect(note).toContain('readContext.indexedCommit');
      expect(note).toContain('newly committed code');
      expect(note).toContain('12 uncommitted source file(s) are not in this answer');
      expect(note).toContain('src/dirty-00.rs');
      expect(note).toContain('and 2 more');
      expect(note).not.toContain('src/dirty-11.rs');
    });

    it('rethrows the original refusal when no committed index is readable', async () => {
      vi.mocked(prepareWorkspaceRead).mockRejectedValueOnce(tooLarge());
      vi.mocked(readActiveGenerationMeta).mockResolvedValueOnce({
        meta: { lastCommit: 'abc1234567890' },
        authority: 'untrusted',
      } as any);
      const handler = vi.fn();
      (backend as any).repoToolHandlers.context = handler;
      await expect(backend.callTool('context', { name: 'x' })).rejects.toMatchObject({
        code: 'workspace_too_large',
        retryable: false,
      });
      expect(readActiveGenerationMeta).toHaveBeenCalled();
      expect(handler).not.toHaveBeenCalled();
    });
  });

  it('preserves safe size diagnostics without exposing private preparation text', async () => {
    const diagnostics = {
      observedIndexedFiles: 5000,
      maxIndexedFiles: 1600,
      requiredCapability: 'workspace-graph' as const,
    };
    const original = new WorkspacePreparationError(
      'workspace_too_large',
      'secret=preparation-token source: private.ts',
      undefined,
      { ...diagnostics, privatePath: 'private.ts' } as typeof diagnostics,
    );
    vi.mocked(prepareWorkspaceRead).mockRejectedValueOnce(original);
    const handler = vi.fn();
    (backend as any).repoToolHandlers.overview = handler;
    const failure = await backend.callTool('overview', {}).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: 'workspace_too_large', retryable: false, diagnostics });
    expect(JSON.stringify(failure)).not.toMatch(/preparation-token|private\.ts/);
    expect(handler).not.toHaveBeenCalled();
  });

  it.each([
    ['verification', 'snapshot_failed'],
    ['build', 'input_refused'],
  ] as const)(
    'projects safe %s/%s diagnostics without copying private fields',
    async (phase, reason) => {
      const original = new WorkspacePreparationError(
        'workspace_build_failed',
        'SYNTHETIC_PRIVATE',
        undefined,
        undefined,
        {
          phase,
          reason,
          systemCode: 'EIO',
          privatePath: '/private/source',
          stderr: 'SYNTHETIC_PRIVATE',
        } as NonNullable<WorkspacePreparationError['failure']>,
      );
      vi.mocked(prepareWorkspaceRead).mockRejectedValueOnce(original);
      const handler = vi.fn();
      (backend as any).repoToolHandlers.overview = handler;
      const failure = await backend.callTool('overview', {}).catch((error: unknown) => error);
      expect(failure).toMatchObject({
        code: 'workspace_build_failed',
        retryable: false,
        diagnostics: { phase, reason, systemCode: 'EIO' },
      });
      expect(JSON.stringify(failure)).not.toMatch(
        /SYNTHETIC_PRIVATE|private\/source|failureDiagnostics/,
      );
      expect(handler).not.toHaveBeenCalled();
    },
  );

  it.each(['Error', 'non-Error'])('bounds unexpected %s preparation failures', async (kind) => {
    const detail = `secret=preparation-token\nsource: private.ts\n${'x'.repeat(100_000)}`;
    const original = kind === 'Error' ? new Error(detail) : detail;
    vi.mocked(prepareWorkspaceRead).mockRejectedValueOnce(original);
    const handler = vi.fn();
    (backend as any).repoToolHandlers.overview = handler;
    const failure = await backend.callTool('overview', {}).catch((error: unknown) => error);
    expect(failure).toMatchObject({
      code: 'workspace_preparation_failed',
      message: 'workspace_preparation_failed',
      cause: original,
    });
    expect(JSON.stringify(failure)).toBe('{"code":"workspace_preparation_failed"}');
    expect(handler).not.toHaveBeenCalled();
  });

  it('fails a vanished usable generation without running the handler', async () => {
    vi.mocked(getOverlaySnapshot).mockResolvedValueOnce({
      ...cleanSnapshot(),
      usable: true,
      generation: 'gone',
    });
    vi.mocked(withPinnedOverlay).mockRejectedValueOnce(
      new Error('overlay generation no longer available'),
    );
    const handler = vi.fn();
    (backend as any).repoToolHandlers.overview = handler;
    await expect(backend.callTool('overview', {})).rejects.toMatchObject({
      code: 'workspace_preparation_failed',
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it('maps a pre-handler native-open failure to a preparation error without running the handler', async () => {
    const { LbugOpenError } = await import('../../src/core/lbug/open-error.js');
    vi.mocked(getOverlaySnapshot).mockResolvedValueOnce({
      ...cleanSnapshot(),
      usable: true,
      generation: 'bad',
    });
    vi.mocked(withPinnedOverlay).mockRejectedValueOnce(
      new LbugOpenError('/db/lbug', new Error('database is corrupt')),
    );
    const handler = vi.fn();
    (backend as any).repoToolHandlers.overview = handler;
    await expect(backend.callTool('overview', {})).rejects.toMatchObject({
      code: 'workspace_preparation_failed',
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it('preserves clean base results without pinning', async () => {
    (backend as any).repoToolHandlers.overview = async () => ['base'];
    expect(await backend.callTool('overview', {})).toEqual(['base']);
    expect(withPinnedOverlay).not.toHaveBeenCalled();
  });

  describe('idle repository eviction', () => {
    afterEach(() => {
      vi.useRealTimers();
      vi.unstubAllEnvs();
    });
    const idleSetup = async () => {
      vi.stubEnv('ONTOINDEX_AUTO_WORKSPACE', '1');
      (backend as any).repoToolHandlers.overview = async () => ({ items: [1] });
      await backend.callTool('overview', {});
      return (await backend.resolveRepo(undefined)).id as string;
    };

    it('releases runtime state of a repo idle for 60 seconds', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      const id = await idleSetup();
      (backend as any).initializedRepos.add(id);
      vi.setSystemTime(Date.now() + 61_000);
      expect(await backend.evictIdleRepos()).toEqual([id]);
      expect((backend as any).initializedRepos.has(id)).toBe(false);
      expect(closeLbug).toHaveBeenCalledWith(id);
    });

    it('keeps a repo that was used within the last minute', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      const id = await idleSetup();
      (backend as any).initializedRepos.add(id);
      vi.setSystemTime(Date.now() + 30_000);
      expect(await backend.evictIdleRepos()).toEqual([]);
      expect((backend as any).initializedRepos.has(id)).toBe(true);
    });

    it('never evicts a repo with a request still running', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.stubEnv('ONTOINDEX_AUTO_WORKSPACE', '1');
      let finish!: () => void;
      (backend as any).repoToolHandlers.overview = () =>
        new Promise((resolve) => {
          finish = () => resolve({ items: [1] });
        });
      const running = backend.callTool('overview', {});
      await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
      const id = (await backend.resolveRepo(undefined)).id as string;
      (backend as any).initializedRepos.add(id);
      vi.setSystemTime(Date.now() + 10 * 60_000);
      expect(await backend.evictIdleRepos()).toEqual([]);
      expect((backend as any).initializedRepos.has(id)).toBe(true);
      finish();
      await running;
    });

    it('leaves a repo with a working-tree build in progress alone', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      const id = await idleSetup();
      (backend as any).initializedRepos.add(id);
      const building = vi.spyOn(runtimeModule, 'hasWorkspaceBuild').mockReturnValue(true);
      try {
        vi.setSystemTime(Date.now() + 61_000);
        expect(await backend.evictIdleRepos()).toEqual([]);
        expect((backend as any).initializedRepos.has(id)).toBe(true);
      } finally {
        building.mockRestore();
      }
    });

    it('does not track repos when the flag is off', async () => {
      vi.stubEnv('ONTOINDEX_AUTO_WORKSPACE', '0');
      vi.useFakeTimers({ toFake: ['Date'] });
      (backend as any).repoToolHandlers.overview = async () => ({ items: [1] });
      await backend.callTool('overview', {});
      const id = (await backend.resolveRepo(undefined)).id as string;
      (backend as any).initializedRepos.add(id);
      vi.setSystemTime(Date.now() + 10 * 60_000);
      expect(await backend.evictIdleRepos()).toEqual([]);
      expect((backend as any).initializedRepos.has(id)).toBe(true);
      expect(closeLbug).not.toHaveBeenCalled();
    });
  });

  describe('impactByUid', () => {
    it('adds the preparation note to the result of a degraded read', async () => {
      vi.mocked(prepareWorkspaceRead).mockResolvedValueOnce({
        ...cleanSnapshot(),
        preparationNote: 'Working-tree graph not built (workspace_too_large); test note',
      });
      (backend as any).repoToolHandlers.overview = async () => ({ items: [1], warnings: ['old'] });
      const result = (await backend.callTool('overview', {})) as { warnings: string[] };
      expect(result.warnings).toEqual(['old', expect.stringContaining('workspace_too_large')]);
    });

    it('leaves results alone when there is no preparation note', async () => {
      (backend as any).repoToolHandlers.overview = async () => ({ items: [1] });
      expect(await backend.callTool('overview', {})).toEqual(
        expect.not.objectContaining({ warnings: expect.anything() }),
      );
    });

    const opts = { maxDepth: 3, relationTypes: ['CALLS'], minConfidence: 0, includeTests: false };
    let repoId: string;
    beforeEach(async () => {
      repoId = (await backend.resolveRepo(undefined)).id;
      vi.spyOn(backend as any, 'ensureInitialized').mockResolvedValue(undefined);
    });
    afterEach(() => vi.unstubAllEnvs());

    it.each([undefined, '1'])(
      'routes through the gated impact handler with activation %s',
      async (flag) => {
        vi.stubEnv('ONTOINDEX_AUTO_WORKSPACE', flag);
        const handler = vi.fn(async () => ({ risk: 'LOW', impactedCount: 1, byDepth: {} }));
        (backend as any).repoToolHandlers.impact = handler;
        const result = await backend.impactByUid(repoId, 'uid-1', 'downstream', opts);
        expect(result).toMatchObject({ impactedCount: 1 });
        expect(handler).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({ target_uid: 'uid-1', direction: 'downstream', maxDepth: 3 }),
        );
        expect(prepareWorkspaceRead).toHaveBeenCalledOnce();
      },
    );

    it.each([
      ['error', { error: 'not found' }],
      ['ambiguous', { status: 'ambiguous' }],
    ])('returns null for a %s workspace result', async (_name, payload) => {
      vi.stubEnv('ONTOINDEX_AUTO_WORKSPACE', '1');
      (backend as any).repoToolHandlers.impact = async () => payload;
      expect(await backend.impactByUid(repoId, 'uid-1', 'upstream', opts)).toBeNull();
    });

    it('returns null when workspace preparation fails', async () => {
      vi.stubEnv('ONTOINDEX_AUTO_WORKSPACE', '1');
      vi.mocked(prepareWorkspaceRead).mockRejectedValueOnce(
        new WorkspacePreparationError('workspace_busy'),
      );
      (backend as any).repoToolHandlers.impact = vi.fn();
      expect(await backend.impactByUid(repoId, 'uid-1', 'upstream', opts)).toBeNull();
    });

    it('does not use the gated handler when the flag is off', async () => {
      vi.stubEnv('ONTOINDEX_AUTO_WORKSPACE', '0');
      const handler = vi.fn();
      (backend as any).repoToolHandlers.impact = handler;
      await backend.impactByUid(repoId, 'uid-1', 'upstream', opts);
      expect(handler).not.toHaveBeenCalled();
      expect(prepareWorkspaceRead).not.toHaveBeenCalled();
    });

    describe('group service ports', () => {
      const ports = ['impact', 'query', 'context'] as const;
      const call = (port: (typeof ports)[number]) => {
        const svc = backend.getGroupService() as any;
        const repo = { id: repoId } as any;
        const params = { target: 'x', query: 'x', name: 'x' };
        return svc.port[port](repo, params, {});
      };

      it.each(ports)(
        'routes %s through the workspace gate with default activation',
        async (port) => {
          vi.stubEnv('ONTOINDEX_AUTO_WORKSPACE', undefined);
          const handler = vi.fn(async () => ({ ok: port }));
          (backend as any).repoToolHandlers[port] = handler;
          expect(await call(port)).toMatchObject({ ok: port });
          expect(prepareWorkspaceRead).toHaveBeenCalledOnce();
        },
      );

      it.each(ports)('does not prepare a workspace for %s when the flag is off', async (port) => {
        vi.stubEnv('ONTOINDEX_AUTO_WORKSPACE', '0');
        vi.spyOn(backend as any, port).mockResolvedValue({ ok: port });
        expect(await call(port)).toMatchObject({ ok: port });
        expect(prepareWorkspaceRead).not.toHaveBeenCalled();
      });
    });
  });
});

describe('LocalBackend.init', () => {
  let backend: LocalBackend;

  beforeEach(() => {
    backend = new LocalBackend();
    vi.clearAllMocks();
  });

  it('returns true when repos are available', async () => {
    setupSingleRepo();
    const result = await backend.init();
    expect(result).toBe(true);
  });

  it('returns false when no repos are registered', async () => {
    setupNoRepos();
    const result = await backend.init();
    expect(result).toBe(false);
  });

  it('reads registered repos without mutating registry during init', async () => {
    setupSingleRepo();
    await backend.init();
    expect(listRegisteredRepos).toHaveBeenCalledWith({ validate: false });
  });

  it('can list cached repos without a second registry refresh after init', async () => {
    setupSingleRepo();
    await backend.init();

    const repos = await backend.listRepos({ refresh: false });

    expect(repos).toHaveLength(1);
    expect(listRegisteredRepos).toHaveBeenCalledTimes(1);
  });

  it('shares one registry refresh across concurrent init calls', async () => {
    let release!: () => void;
    const pendingRepos = new Promise<(typeof MOCK_REPO_ENTRY)[]>((resolve) => {
      release = () => resolve([MOCK_REPO_ENTRY]);
    });
    (listRegisteredRepos as any).mockReturnValue(pendingRepos);

    const first = backend.init();
    const second = backend.init();
    release();

    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    expect(listRegisteredRepos).toHaveBeenCalledTimes(1);
  });

  it('aborts initialization without pinning the shared init promise', async () => {
    let release!: () => void;
    const pendingRepos = new Promise<(typeof MOCK_REPO_ENTRY)[]>((resolve) => {
      release = () => resolve([MOCK_REPO_ENTRY]);
    });
    (listRegisteredRepos as any).mockReturnValueOnce(pendingRepos);

    const controller = new AbortController();
    const first = backend.init({ signal: controller.signal });
    controller.abort();

    await expect(first).rejects.toThrow('LocalBackend initialization aborted');
    release();

    setupSingleRepo();
    await expect(backend.init()).resolves.toBe(true);
    expect(listRegisteredRepos).toHaveBeenCalledTimes(2);
  });

  it('can scope the backend to one registered repo by name', async () => {
    await setupMultipleReposWithReadableOther();
    backend = new LocalBackend({ repoFilter: 'other-project' });

    const result = await backend.init();
    const repos = await backend.listRepos();

    expect(result).toBe(true);
    expect(repos).toHaveLength(1);
    expect(repos[0].name).toBe('other-project');
    expect(listRegisteredRepos).toHaveBeenCalledWith({ validate: false });
  });

  it('can scope the backend to one registered repo by absolute path', async () => {
    const otherRepo = await setupMultipleReposWithReadableOther();
    backend = new LocalBackend({ repoFilter: otherRepo.path });

    const result = await backend.init();
    const repos = await backend.listRepos();

    expect(result).toBe(true);
    expect(repos).toHaveLength(1);
    expect(repos[0].path).toBe(otherRepo.path);
    expect(listRegisteredRepos).toHaveBeenCalledWith({ validate: false });
  });
});

describe('LocalBackend.disconnect', () => {
  let backend: LocalBackend;

  beforeEach(() => {
    backend = new LocalBackend();
    vi.clearAllMocks();
  });

  it('does not throw when no repos are initialized', async () => {
    setupNoRepos();
    await backend.init();
    await expect(backend.disconnect()).resolves.not.toThrow();
  });

  it('calls closeLbug on disconnect', async () => {
    setupSingleRepo();
    await backend.init();
    await backend.disconnect();
    expect(closeLbug).toHaveBeenCalled();
  });
});

// ─── callTool dispatch ───────────────────────────────────────────────

describe('LocalBackend.callTool', () => {
  let backend: LocalBackend;

  beforeEach(async () => {
    vi.clearAllMocks();
    backend = new LocalBackend();
    setupSingleRepo();
    await backend.init();
  });

  it.each([null, '/tmp/startup-other-project'])(
    'passes trusted selected repo context to diagnostics with startup project %s',
    async (projectCwd) => {
      backend = new LocalBackend({ preferredProjectPath: projectCwd ?? undefined });
      await backend.init();
      const params = { repo: MOCK_REPO_ENTRY.name, checkLsp: false };
      await backend.callTool('gn_diagnose', params);
      expect(gnDiagnose).toHaveBeenCalledWith(expect.any(String), params, {
        repoPath: MOCK_REPO_ENTRY.path,
        projectCwd,
      });
    },
  );

  it('rejects diagnostics outside an explicit repo filter', async () => {
    await setupMultipleReposWithReadableOther();
    backend = new LocalBackend({ repoFilter: 'other-project' });
    await backend.init();
    await expect(backend.callTool('gn_diagnose', { repo: MOCK_REPO_ENTRY.name })).rejects.toThrow();
    expect(gnDiagnose).not.toHaveBeenCalled();
  });

  it('routes list_repos without needing repo param', async () => {
    const result = await backend.callTool('list_repos', {});
    expect(Array.isArray(result)).toBe(true);
    expect(result[0].name).toBe('test-project');
  });

  it('preserves complete typed results before MCP response paging', async () => {
    (listRegisteredRepos as any).mockResolvedValue(
      Array.from({ length: 6000 }, (_, i) => ({
        ...MOCK_REPO_ENTRY,
        name: `repo-${i}`,
        path: path.join(os.tmpdir(), `repo-${i}`),
      })),
    );
    await backend.init({ forceRefresh: true });

    const result = await backend.callTool('list_repos', {});

    expect(result).toHaveLength(6000);
    expect(result.at(-1)).toMatchObject({ name: 'repo-5999' });
  });

  it('throws for unknown tool name', async () => {
    await expect(backend.callTool('nonexistent_tool', {})).rejects.toThrow(
      'Unknown tool method: nonexistent_tool',
    );
  });

  it('dispatches query tool', async () => {
    (executeParameterized as any).mockResolvedValue([]);
    const result = await backend.callTool('query', { query: 'auth' });
    expect(result).toHaveProperty('processes');
    expect(result).toHaveProperty('definitions');
  });

  it('query tool returns error for empty query', async () => {
    const result = await backend.callTool('query', { query: '' });
    expect(result.error).toContain('query parameter is required');
  });

  it('query tool returns error for whitespace-only query', async () => {
    const result = await backend.callTool('query', { query: '   ' });
    expect(result.error).toContain('query parameter is required');
  });

  it('dispatches cypher tool and blocks write queries', async () => {
    const result = await backend.callTool('cypher', { query: 'CREATE (n:Test)' });
    expect(result).toHaveProperty('error');
    expect(result.error).toContain('Write operations');
  });

  it('dispatches cypher tool with valid read query', async () => {
    (executeParameterized as any).mockResolvedValue([{ name: 'test', filePath: 'src/test.ts' }]);
    const result = await backend.callTool('cypher', {
      query: 'MATCH (n:Function) RETURN n.name AS name, n.filePath AS filePath LIMIT 5',
    });
    // formatCypherAsMarkdown returns { markdown, row_count } for tabular results
    expect(result).toHaveProperty('markdown');
    expect(result).toHaveProperty('row_count');
    expect(result.row_count).toBe(1);
  });

  it('dispatches context tool', async () => {
    (executeParameterized as any).mockResolvedValue([
      {
        id: 'func:main',
        name: 'main',
        type: 'Function',
        filePath: 'src/index.ts',
        startLine: 1,
        endLine: 10,
      },
    ]);
    const result = await backend.callTool('context', { name: 'main' });
    expect(result.status).toBe('found');
    expect(result.symbol.name).toBe('main');
  });

  it('context tool returns error when name and uid are both missing', async () => {
    const result = await backend.callTool('context', {});
    expect(result.error).toContain('Either "name" or "uid"');
  });

  it('context tool returns not-found for missing symbol', async () => {
    (executeParameterized as any).mockResolvedValue([]);
    const result = await backend.callTool('context', { name: 'doesNotExist' });
    expect(result.error).toContain('not found');
  });

  it('context tool returns disambiguation for multiple matches', async () => {
    (executeParameterized as any).mockResolvedValue([
      {
        id: 'func:main:1',
        name: 'main',
        type: 'Function',
        filePath: 'src/a.ts',
        startLine: 1,
        endLine: 5,
      },
      {
        id: 'func:main:2',
        name: 'main',
        type: 'Function',
        filePath: 'src/b.ts',
        startLine: 1,
        endLine: 5,
      },
    ]);
    const result = await backend.callTool('context', { name: 'main' });
    expect(result.status).toBe('ambiguous');
    expect(result.candidates).toHaveLength(2);

    // #470: every candidate carries a relevance score in [0, 1] and the list
    // is sorted descending by score (with deterministic tiebreakers).
    for (const c of result.candidates) {
      expect(typeof c.score).toBe('number');
      expect(c.score).toBeGreaterThanOrEqual(0);
      expect(c.score).toBeLessThanOrEqual(1);
    }
    expect(result.candidates[0].score).toBeGreaterThanOrEqual(result.candidates[1].score);
  });

  it('context tool ranks file_path match higher than non-match (#470)', async () => {
    (executeParameterized as any).mockResolvedValue([
      {
        id: 'func:handleConnect:1',
        name: 'handleConnect',
        type: 'Function',
        filePath: 'src/lib/socket.ts',
        startLine: 10,
        endLine: 20,
      },
      {
        id: 'func:handleConnect:2',
        name: 'handleConnect',
        type: 'Function',
        filePath: 'src/App.tsx',
        startLine: 42,
        endLine: 60,
      },
    ]);
    const result = await backend.callTool('context', {
      name: 'handleConnect',
      file_path: 'App.tsx',
    });
    // In production, `WHERE n.filePath CONTAINS $filePath` would pre-filter
    // at the DB layer and only `src/App.tsx` would come back — resolving
    // via the single-candidate early return rather than via scoring. The
    // `executeParameterized` mock here returns both rows regardless of the
    // WHERE clause parameters, so this asserts that the resolver ends up
    // picking the App.tsx candidate in either case (via mock-relaxed DB
    // pre-filter or via scoring promotion). The dedicated scoring-promotion
    // path is covered by the next `it()` block below.
    expect(result.status).toBe('found');
    expect(result.symbol.filePath).toBe('src/App.tsx');
  });

  it('context tool promotes top candidate via scoring when multiple rows survive DB pre-filter (#470)', async () => {
    // This test explicitly exercises the scored-promotion path (#470
    // review): both candidates satisfy the file_path hint (so DB
    // pre-filter would return both in production), and promotion is
    // determined purely by the combined file_path + kind score.
    (executeParameterized as any).mockResolvedValue([
      {
        id: 'fn:App:1',
        name: 'render',
        type: 'Function',
        filePath: 'src/components/App.tsx',
        startLine: 10,
        endLine: 20,
      },
      {
        id: 'method:App:1',
        name: 'render',
        type: 'Method',
        filePath: 'src/pages/App.tsx',
        startLine: 5,
        endLine: 15,
      },
    ]);
    const result = await backend.callTool('context', {
      name: 'render',
      file_path: 'components/App.tsx',
      kind: 'Function',
    });
    // Expected scoring:
    //   Function candidate: 0.50 base + 0.40 file_path + 0.20 kind = 1.10 → cap 1.00
    //   Method candidate:   0.50 base + 0.00 file_path + 0.00 kind + 0.06 definition = 0.56
    // Top score ≥ 0.95 and beats runner-up by 0.10 → confident promotion
    // to `{ status: 'found' }` with the Function.
    expect(result.status).toBe('found');
    expect(result.symbol.filePath).toBe('src/components/App.tsx');
    expect(result.symbol.kind).toBe('Function');
  });

  it('context tool returns ranked candidates when file_path only partially narrows (#470)', async () => {
    (executeParameterized as any).mockResolvedValue([
      {
        id: 'func:foo:1',
        name: 'foo',
        type: 'Function',
        filePath: 'src/a.ts',
        startLine: 1,
        endLine: 5,
      },
      {
        id: 'func:foo:2',
        name: 'foo',
        type: 'Function',
        filePath: 'src/b.ts',
        startLine: 1,
        endLine: 5,
      },
    ]);
    // No hints → both candidates score 0.62 (0.50 base + 0.06 Function
    // priority + 0.06 definition span). Tied scores fall back to deterministic tiebreakers.
    const result = await backend.callTool('context', { name: 'foo' });
    expect(result.status).toBe('ambiguous');
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates[0].score).toBeCloseTo(0.62, 2);
    expect(result.candidates[1].score).toBeCloseTo(0.62, 2);
  });

  it('context tool boosts the candidate whose kind matches the hint (#470)', async () => {
    (executeParameterized as any).mockResolvedValue([
      {
        id: 'method:save:1',
        name: 'save',
        type: 'Method',
        filePath: 'src/service.ts',
        startLine: 10,
        endLine: 20,
      },
      {
        id: 'func:save:1',
        name: 'save',
        type: 'Function',
        filePath: 'src/util.ts',
        startLine: 5,
        endLine: 15,
      },
    ]);
    const result = await backend.callTool('context', { name: 'save', kind: 'Function' });
    // When kind hint is given, kind-priority bonus is suppressed and +0.20
    // kind-match bonus applies instead. Function becomes the top candidate.
    expect(result.status).toBe('ambiguous');
    expect(result.candidates[0].kind).toBe('Function');
    expect(result.candidates[0].score).toBeGreaterThan(result.candidates[1].score);
  });

  it('impact tool returns ambiguous shape with ranked candidates when target has multiple matches (#470)', async () => {
    // resolveSymbolCandidates issues a single name query; mock it to return
    // two Function rows in different files with no hints.
    (executeParameterized as any).mockResolvedValue([
      {
        id: 'func:login:1',
        name: 'login',
        type: 'Function',
        filePath: 'src/auth.ts',
        startLine: 5,
        endLine: 15,
      },
      {
        id: 'func:login:2',
        name: 'login',
        type: 'Function',
        filePath: 'src/admin/login.ts',
        startLine: 8,
        endLine: 20,
      },
    ]);

    const result = await backend.callTool('impact', { target: 'login', direction: 'upstream' });

    expect(result.status).toBe('ambiguous');
    expect(result.candidates).toHaveLength(2);
    expect(result.impactedCount).toBe(0);
    expect(result.risk).toBe('UNKNOWN');
    expect(result.target.name).toBe('login');
    for (const c of result.candidates) {
      expect(typeof c.score).toBe('number');
      expect(c.uid).toBeDefined();
      expect(c.kind).toBe('Function');
    }
  });

  it('impact tool resolves via target_uid without running the name-based resolver (#470)', async () => {
    // UID path: exactly one executeParameterized call for the lookup, then
    // the BFS issues executeQuery calls (which we mock empty). Crucially,
    // no `WHERE n.name =` query fires.
    (executeParameterized as any).mockResolvedValue([
      {
        id: 'uid:1234',
        name: 'pickedByUid',
        type: 'Function',
        filePath: 'src/pick.ts',
        startLine: 1,
        endLine: 10,
      },
    ]);
    (executeQuery as any).mockResolvedValue([]);

    const result = await backend.callTool('impact', {
      target: 'ignoredName',
      target_uid: 'uid:1234',
      direction: 'upstream',
    });

    // No ambiguous shape and no name-lookup error — the uid short-circuit won.
    expect(result.status).not.toBe('ambiguous');
    expect(result.target).toBeDefined();

    // All executeParameterized calls this test dispatched must have been
    // uid-keyed, never name-keyed. That proves the name resolver was skipped.
    const calls = (executeParameterized as any).mock.calls as Array<
      [string, string, Record<string, unknown>]
    >;
    for (const [, cypher] of calls) {
      expect(cypher).not.toMatch(/WHERE n\.name = \$symName/);
    }
  });

  it('impact tool accepts displayed owner-qualified symbol names', async () => {
    (executeParameterized as any).mockResolvedValue([
      {
        id: 'Function:src/thread_manager.rs:ThreadManager.validate_environment_selections',
        name: 'validate_environment_selections',
        type: 'Function',
        filePath: 'src/thread_manager.rs',
        startLine: 10,
        endLine: 20,
      },
    ]);
    (executeQuery as any).mockResolvedValue([]);

    const result = await backend.callTool('impact', {
      target: 'ThreadManager.validate_environment_selections',
      direction: 'upstream',
    });

    expect(result.target.id).toBe(
      'Function:src/thread_manager.rs:ThreadManager.validate_environment_selections',
    );
    const [, cypher, params] = (executeParameterized as any).mock.calls[0] as [
      string,
      string,
      Record<string, unknown>,
    ];
    expect(cypher).toContain('n.id ENDS WITH $qualifiedSuffix');
    expect(params).toMatchObject({
      symName: 'ThreadManager.validate_environment_selections',
      qualifiedSuffix: ':ThreadManager.validate_environment_selections',
    });
  });

  it('dispatches impact tool', async () => {
    // impact() calls executeParameterized to find target, then executeQuery for traversal
    (executeParameterized as any).mockResolvedValue([
      { id: 'func:main', name: 'main', type: 'Function', filePath: 'src/index.ts' },
    ]);
    (executeQuery as any).mockResolvedValue([]);

    const result = await backend.callTool('impact', { target: 'main', direction: 'upstream' });
    expect(result).toBeDefined();
    expect(result.target).toBeDefined();
  });

  it('dispatches detect_changes tool', async () => {
    // detect_changes calls execFileSync which we haven't mocked at module level,
    // so it will throw a git error — that's fine, we test the error path
    const result = await backend.callTool('detect_changes', { scope: 'unstaged' });
    // Should either return changes or a git error
    expect(result).toBeDefined();
    expect(result.error || result.summary).toBeDefined();
  });

  it('dispatches rename tool', async () => {
    (executeParameterized as any)
      .mockResolvedValueOnce([
        {
          id: 'func:oldName',
          name: 'oldName',
          type: 'Function',
          filePath: 'src/test.ts',
          startLine: 1,
          endLine: 5,
        },
      ])
      .mockResolvedValue([]);

    const result = await backend.callTool('rename', {
      symbol_name: 'oldName',
      new_name: 'newName',
      dry_run: true,
    });
    expect(result).toBeDefined();
  });

  it('rename returns error when both symbol_name and symbol_uid are missing', async () => {
    const result = await backend.callTool('rename', { new_name: 'newName' });
    expect(result.error).toContain('Either symbol_name or symbol_uid');
  });

  // api_impact tool
  it('dispatches api_impact tool with route param', async () => {
    (executeParameterized as any).mockResolvedValue([
      {
        routeId: 'Route:/api/grants',
        routeName: '/api/grants',
        handlerFile: 'app/api/grants/route.ts',
        responseKeys: ['data', 'pagination'],
        errorKeys: ['error', 'message'],
        middleware: ['withAuth'],
        consumerName: 'GrantsList',
        consumerFile: 'src/GrantsList.tsx',
        fetchReason: 'fetch-url-match|keys:data,pagination',
      },
    ]);
    const result = await backend.callTool('api_impact', { route: '/api/grants' });
    expect(result).toHaveProperty('route', '/api/grants');
    expect(result).toHaveProperty('handler', 'app/api/grants/route.ts');
    expect(result).toHaveProperty('responseShape');
    expect(result.responseShape.success).toEqual(['data', 'pagination']);
    expect(result.responseShape.error).toEqual(['error', 'message']);
    expect(result).toHaveProperty('middleware', ['withAuth']);
    expect(result).toHaveProperty('consumers');
    expect(result.consumers).toHaveLength(1);
    expect(result).toHaveProperty('impactSummary');
    expect(result.impactSummary.directConsumers).toBe(1);
    expect(result.impactSummary.riskLevel).toBe('LOW');
  });

  it('api_impact returns error when no route or file param', async () => {
    const result = await backend.callTool('api_impact', {});
    expect(result.error).toContain('Either "route" or "file"');
  });

  it('api_impact returns error when no routes found', async () => {
    (executeParameterized as any).mockResolvedValue([]);
    const result = await backend.callTool('api_impact', { route: '/api/nonexistent' });
    expect(result.error).toContain('No routes found');
  });

  it('api_impact detects mismatches and bumps risk level', async () => {
    (executeParameterized as any).mockResolvedValue([
      {
        routeId: 'Route:/api/data',
        routeName: '/api/data',
        handlerFile: 'api/data.ts',
        responseKeys: ['items'],
        errorKeys: ['error'],
        middleware: null,
        consumerName: 'DataView',
        consumerFile: 'src/DataView.tsx',
        fetchReason: 'fetch-url-match|keys:items,meta',
      },
    ]);
    const result = await backend.callTool('api_impact', { route: '/api/data' });
    expect(result.mismatches).toBeDefined();
    expect(result.mismatches).toHaveLength(1);
    expect(result.mismatches[0].field).toBe('meta');
    expect(result.mismatches[0].reason).toContain('not in response shape');
    // 1 consumer = LOW, but mismatch bumps to MEDIUM
    expect(result.impactSummary.riskLevel).toBe('MEDIUM');
  });

  it('api_impact supports file param lookup', async () => {
    (executeParameterized as any).mockResolvedValue([
      {
        routeId: 'Route:/api/users',
        routeName: '/api/users',
        handlerFile: 'app/api/users/route.ts',
        responseKeys: ['users'],
        errorKeys: null,
        middleware: null,
        consumerName: null,
        consumerFile: null,
        fetchReason: null,
      },
    ]);
    const result = await backend.callTool('api_impact', { file: 'app/api/users/route.ts' });
    expect(result.route).toBe('/api/users');
    expect(result.impactSummary.directConsumers).toBe(0);
    expect(result.impactSummary.riskLevel).toBe('LOW');
  });

  it('api_impact reports active model packs when manifests are present', async () => {
    const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-api-impact-models-'));
    await fs.mkdir(path.join(repoDir, 'ontoindex-packs/core/framework-models'), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(repoDir, 'ontoindex-packs/core/framework-models/pack.yml'),
      [
        'schema: 1',
        'id: core.framework-models',
        'name: Framework Models',
        'version: 0.1.0',
        'kind: model',
        'tier: experimental',
        'summary: Framework semantics.',
        'provides:',
        '  - route-models',
        '  - component-models',
        '  - orm-models',
        'runs: []',
      ].join('\n'),
      'utf8',
    );

    (listRegisteredRepos as any).mockResolvedValue([
      {
        ...MOCK_REPO_ENTRY,
        path: repoDir,
      },
    ]);
    await backend.init();
    (executeParameterized as any).mockResolvedValue([
      {
        routeId: 'Route:/api/users',
        routeName: '/api/users',
        handlerFile: 'app/api/users/route.ts',
        responseKeys: ['users'],
        errorKeys: ['error'],
        middleware: null,
        consumerName: 'UsersList',
        consumerFile: 'src/UsersList.tsx',
        fetchReason: 'fetch-url-match|keys:users',
      },
    ]);

    const result = await backend.callTool('api_impact', { route: '/api/users' });
    expect(result.activeModelPacks).toEqual([
      {
        id: 'core.framework-models',
        tier: 'experimental',
        provides: ['route-models', 'component-models', 'orm-models'],
      },
    ]);

    await fs.rm(repoDir, { recursive: true, force: true });
  });

  it('api_impact returns array for multiple matching routes', async () => {
    (executeParameterized as any).mockResolvedValue([
      {
        routeId: 'Route:/api/a',
        routeName: '/api/a',
        handlerFile: 'api/a.ts',
        responseKeys: null,
        errorKeys: null,
        middleware: null,
        consumerName: null,
        consumerFile: null,
        fetchReason: null,
      },
      {
        routeId: 'Route:/api/b',
        routeName: '/api/b',
        handlerFile: 'api/b.ts',
        responseKeys: null,
        errorKeys: null,
        middleware: null,
        consumerName: null,
        consumerFile: null,
        fetchReason: null,
      },
    ]);
    const result = await backend.callTool('api_impact', { route: '/api/' });
    expect(result.routes).toHaveLength(2);
    expect(result.total).toBe(2);
  });

  it('api_impact HIGH risk for 10+ consumers', async () => {
    const rows = [];
    for (let i = 0; i < 10; i++) {
      rows.push({
        routeId: 'Route:/api/popular',
        routeName: '/api/popular',
        handlerFile: 'api/popular.ts',
        responseKeys: ['data'],
        errorKeys: null,
        middleware: null,
        consumerName: `Consumer${i}`,
        consumerFile: `src/Consumer${i}.tsx`,
        fetchReason: null,
      });
    }
    (executeParameterized as any).mockResolvedValue(rows);
    const result = await backend.callTool('api_impact', { route: '/api/popular' });
    expect(result.impactSummary.directConsumers).toBe(10);
    expect(result.impactSummary.riskLevel).toBe('HIGH');
  });

  // Legacy tool aliases
  it('dispatches "search" as alias for query', async () => {
    (executeParameterized as any).mockResolvedValue([]);
    const result = await backend.callTool('search', { query: 'auth' });
    expect(result).toHaveProperty('processes');
  });

  it('requires the full workspace graph for the search alias', async () => {
    vi.stubEnv('ONTOINDEX_AUTO_WORKSPACE', '1');
    (executeParameterized as any).mockResolvedValue([]);
    await backend.callTool('search', { query: 'auth' });
    expect(prepareWorkspaceRead).toHaveBeenCalledWith(
      expect.objectContaining({
        wantsWorkspaceGraph: true,
      }),
    );
  });

  it('dispatches "explore" as alias for context', async () => {
    (executeParameterized as any).mockResolvedValue([
      {
        id: 'func:main',
        name: 'main',
        type: 'Function',
        filePath: 'src/index.ts',
        startLine: 1,
        endLine: 10,
      },
    ]);
    const result = await backend.callTool('explore', { name: 'main' });
    // explore calls context — which may return found or ambiguous depending on mock
    expect(result).toBeDefined();
    expect(result.status === 'found' || result.symbol || result.error === undefined).toBeTruthy();
  });
});

// ─── Repo resolution ────────────────────────────────────────────────

describe('LocalBackend.resolveRepo', () => {
  let backend: LocalBackend;

  beforeEach(async () => {
    vi.clearAllMocks();
    backend = new LocalBackend();
  });

  it('resolves single repo without param', async () => {
    setupSingleRepo();
    await backend.init();
    const result = await backend.callTool('list_repos', {});
    expect(result).toHaveLength(1);
  });

  it('throws when no repos are registered', async () => {
    setupNoRepos();
    await backend.init();
    await expect(backend.callTool('query', { query: 'test' })).rejects.toThrow(
      'No indexed repositories',
    );
  });

  it('throws for ambiguous repos without param', async () => {
    setupMultipleRepos();
    await backend.init();
    await expect(backend.callTool('query', { query: 'test' })).rejects.toThrow(
      'Multiple repositories are indexed',
    );
    await expect(backend.callTool('query', { query: 'test' })).rejects.toThrow(
      'repo: "test-project"',
    );
  });

  it('resolves repo by name parameter', async () => {
    setupMultipleRepos();
    await backend.init();
    // With repo param, it should resolve correctly
    (executeParameterized as any).mockResolvedValue([]);
    const result = await backend.callTool('query', {
      query: 'auth',
      repo: 'test-project',
    });
    expect(result).toHaveProperty('processes');
  });

  it('reports every duplicate label candidate when the project path cannot disambiguate', async () => {
    (listRegisteredRepos as any).mockResolvedValue([
      { ...MOCK_REPO_ENTRY, name: 'codex', path: '/workspace/ontocode' },
      { ...MOCK_REPO_ENTRY, name: 'codex', path: '/workspace/ontocode-f1-layout' },
    ]);
    backend = new LocalBackend({ preferredProjectPath: '/workspace/unrelated' });
    await backend.init();

    await expect(backend.callTool('query', { query: 'auth', repo: 'codex' })).rejects.toThrow(
      /Repository "codex" is ambiguous[\s\S]*\/workspace\/ontocode[\s\S]*\/workspace\/ontocode-f1-layout/,
    );
  });

  it('resolves repo by absolute path parameter', async () => {
    setupMultipleRepos();
    await backend.init();
    (executeParameterized as any).mockResolvedValue([]);

    const result = await backend.callTool('query', {
      query: 'auth',
      repo: MOCK_REPO_ENTRY.path,
    });

    expect(result).toHaveProperty('processes');
  });

  it('throws for unknown repo name', async () => {
    setupSingleRepo();
    await backend.init();
    await expect(backend.callTool('query', { query: 'test', repo: 'nonexistent' })).rejects.toThrow(
      'not found',
    );
  });

  it('resolves repo case-insensitively', async () => {
    setupSingleRepo();
    await backend.init();
    (executeParameterized as any).mockResolvedValue([]);
    // Should match even with different case
    const result = await backend.callTool('query', {
      query: 'test',
      repo: 'Test-Project',
    });
    expect(result).toHaveProperty('processes');
  });

  it('refreshes registry on repo miss', async () => {
    setupNoRepos();
    await backend.init();

    // Now make a repo appear
    (listRegisteredRepos as any).mockResolvedValue([MOCK_REPO_ENTRY]);

    // The resolve should re-read the registry and find the new repo
    (executeParameterized as any).mockResolvedValue([]);
    const result = await backend.callTool('query', {
      query: 'test',
      repo: 'test-project',
    });
    expect(result).toHaveProperty('processes');
    // listRegisteredRepos should have been called again
    expect(listRegisteredRepos).toHaveBeenCalledTimes(2); // once in init, once in refreshRepos
  });
});

// ─── getContext ──────────────────────────────────────────────────────

describe('LocalBackend.getContext', () => {
  let backend: LocalBackend;

  beforeEach(async () => {
    vi.clearAllMocks();
    backend = new LocalBackend();
    setupSingleRepo();
    await backend.init();
  });

  it('returns context for single repo without specifying id', () => {
    const ctx = backend.getContext();
    expect(ctx).not.toBeNull();
    expect(ctx!.projectName).toBe('test-project');
    expect(ctx!.stats.fileCount).toBe(10);
    expect(ctx!.stats.functionCount).toBe(50);
  });

  it('returns context by repo id', () => {
    const ctx = backend.getContext('test-project');
    expect(ctx).not.toBeNull();
    expect(ctx!.projectName).toBe('test-project');
  });

  it('returns single repo context even with unknown id (single-repo fallback)', () => {
    // When only 1 repo is registered, getContext falls through the id check
    // and returns the single repo's context. This is intentional behavior.
    const ctx = backend.getContext('nonexistent');
    // The id doesn't match, but since repos.size === 1, it returns that single context
    // This is the actual behavior — test documents it
    expect(ctx).not.toBeNull();
    expect(ctx!.projectName).toBe('test-project');
  });
});

// ─── LadybugDB lazy initialization ──────────────────────────────────────

describe('ensureInitialized', () => {
  let backend: LocalBackend;

  beforeEach(async () => {
    vi.clearAllMocks();
    backend = new LocalBackend();
    setupSingleRepo();
    await backend.init();
  });

  it('calls initLbug on first tool call', async () => {
    (executeParameterized as any).mockResolvedValue([]);
    await backend.callTool('query', { query: 'test' });
    expect(initLbug).toHaveBeenCalled();
  });

  it('retries initLbug if connection was evicted', async () => {
    (executeParameterized as any).mockResolvedValue([]);
    // First call initializes
    await backend.callTool('query', { query: 'test' });
    expect(initLbug).toHaveBeenCalledTimes(1);

    // Simulate idle eviction
    (isLbugReady as any).mockReturnValueOnce(false);
    await backend.callTool('query', { query: 'test' });
    expect(initLbug).toHaveBeenCalledTimes(2);
  });

  it('handles initLbug failure gracefully', async () => {
    (initLbug as any).mockRejectedValueOnce(new Error('DB locked'));
    await expect(backend.callTool('query', { query: 'test' })).rejects.toThrow('DB locked');
  });
});

// ─── Cypher write blocking through callTool ──────────────────────────

describe('callTool cypher write blocking', () => {
  let backend: LocalBackend;

  beforeEach(async () => {
    vi.clearAllMocks();
    backend = new LocalBackend();
    setupSingleRepo();
    await backend.init();
  });

  const writeQueries = [
    'CREATE (n:Function {name: "test"})',
    'MATCH (n) DELETE n',
    'MATCH (n) SET n.name = "hacked"',
    'MERGE (n:Function {name: "test"})',
    'MATCH (n) REMOVE n.name',
    'DROP TABLE Function',
    'ALTER TABLE Function ADD COLUMN foo STRING',
    'COPY Function FROM "file.csv"',
    'MATCH (n) DETACH DELETE n',
  ];

  for (const query of writeQueries) {
    it(`blocks write query: ${query.slice(0, 30)}...`, async () => {
      const result = await backend.callTool('cypher', { query });
      expect(result).toHaveProperty('error');
      expect(result.error).toContain('Write operations');
    });
  }

  it('allows read query through callTool', async () => {
    (executeParameterized as any).mockResolvedValue([]);
    const result = await backend.callTool('cypher', {
      query: 'MATCH (n:Function) RETURN n.name LIMIT 5',
    });
    // Should not have error property with write-block message
    expect(result.error).toBeUndefined();
  });
});

// ─── listRepos ──────────────────────────────────────────────────────

describe('LocalBackend.listRepos', () => {
  let backend: LocalBackend;

  beforeEach(async () => {
    vi.clearAllMocks();
    backend = new LocalBackend();
  });

  it('returns empty array when no repos', async () => {
    setupNoRepos();
    await backend.init();
    const repos = await backend.callTool('list_repos', {});
    expect(repos).toEqual([]);
  });

  it('returns repo metadata', async () => {
    setupSingleRepo();
    await backend.init();
    const repos = await backend.callTool('list_repos', {});
    expect(repos).toHaveLength(1);
    expect(repos[0]).toEqual(
      expect.objectContaining({
        name: 'test-project',
        path: MOCK_REPO_ENTRY.path,
        indexedAt: expect.any(String),
        lastCommit: expect.any(String),
      }),
    );
  });

  it('re-reads registry on each listRepos call', async () => {
    setupSingleRepo();
    await backend.init();
    await backend.callTool('list_repos', {});
    await backend.callTool('list_repos', {});
    // listRegisteredRepos called: once in init, once per listRepos
    expect(listRegisteredRepos).toHaveBeenCalledTimes(3);
  });
});

// ─── Cypher LadybugDB not ready ────────────────────────────────────────

describe('cypher tool LadybugDB not ready', () => {
  let backend: LocalBackend;

  beforeEach(async () => {
    vi.clearAllMocks();
    backend = new LocalBackend();
    setupSingleRepo();
    await backend.init();
  });

  it('returns error when LadybugDB is not ready', async () => {
    (isLbugReady as any).mockReturnValue(false);
    // initLbug will succeed but isLbugReady returns false after ensureInitialized
    // Actually ensureInitialized checks isLbugReady and re-inits — let's make that pass
    // then the cypher method checks isLbugReady again
    (isLbugReady as any)
      .mockReturnValueOnce(false) // ensureInitialized check
      .mockReturnValueOnce(false); // cypher's own check

    const result = await backend.callTool('cypher', {
      query: 'MATCH (n) RETURN n LIMIT 1',
    });
    expect(result.error).toContain('LadybugDB not ready');
  });
});

// ─── formatCypherAsMarkdown ──────────────────────────────────────────

describe('cypher result formatting', () => {
  let backend: LocalBackend;

  beforeEach(async () => {
    // Full reset of all mocks to prevent state leaking from other tests
    vi.resetAllMocks();
    (listRegisteredRepos as any).mockResolvedValue([MOCK_REPO_ENTRY]);
    (cleanupOldKuzuFiles as any).mockResolvedValue({ found: false, needsReindex: false });
    (initLbug as any).mockResolvedValue(undefined);
    (isLbugReady as any).mockReturnValue(true);
    (closeLbug as any).mockResolvedValue(undefined);
    (executeParameterized as any).mockResolvedValue([]);

    backend = new LocalBackend();
    await backend.init();
  });

  it('formats tabular results as markdown table', async () => {
    (executeParameterized as any).mockResolvedValue([
      { name: 'main', filePath: 'src/index.ts' },
      { name: 'helper', filePath: 'src/utils.ts' },
    ]);
    const result = await backend.callTool('cypher', {
      query: 'MATCH (n:Function) RETURN n.name AS name, n.filePath AS filePath LIMIT 10',
    });
    expect(result).toHaveProperty('markdown');
    expect(result.markdown).toContain('name');
    expect(result.markdown).toContain('main');
    expect(result.row_count).toBe(2);
  });

  it('preserves empty array results without repo identity wrapping', async () => {
    (executeParameterized as any).mockResolvedValue([]);
    const result = await backend.callTool('cypher', {
      query: 'MATCH (n:Function) RETURN n.name LIMIT 1',
    });
    expect(result).toEqual([]);
  });

  it('returns error object when cypher fails', async () => {
    (executeParameterized as any).mockRejectedValue(new Error('Syntax error'));
    const result = await backend.callTool('cypher', {
      query: 'MATCH (n:Missing) RETURN n LIMIT 1',
    });
    expect(result).toHaveProperty('error');
    expect(result.error).toContain('Syntax error');
  });
});
