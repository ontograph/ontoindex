import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { RepoHandle } from 'ontoindex-shared';

import {
  ensureRepoInitialized,
  RepoPreparationWaitError,
  resolveRepoFromHandles,
} from '../../src/mcp/local/local-backend-repo-runtime.js';

describe('generation reopen retry', () => {
  it.each(['close', 'init'])(
    'keeps committed metadata after failed %s and retries',
    async (failure) => {
      const storagePath = await fs.mkdtemp(path.join(os.tmpdir(), 'ontoindex-retry-'));
      const handle = makeRepo('retry', 'retry', storagePath);
      handle.storagePath = storagePath;
      handle.lbugPath = '/gen/A/lbug';
      const originalIndexedAt = handle.indexedAt;
      const initializedRepos = new Set([handle.id]);
      const closeLbug = vi.fn(async () => {});
      const initLbug = vi.fn(async () => {});
      (failure === 'close' ? closeLbug : initLbug).mockRejectedValueOnce(
        new Error('temporary failure'),
      );
      const options = {
        repoId: handle.id,
        handle,
        initializedRepos,
        reinitPromises: new Map<string, Promise<void>>(),
        lastStalenessCheck: new Map<string, number>(),
        isLbugReady: () => initializedRepos.has(handle.id),
        closeLbug,
        initLbug,
        resolveActiveLbugPath: vi.fn(async () => '/gen/B/lbug'),
        now: () => 5000,
      };
      try {
        await fs.writeFile(
          path.join(storagePath, 'meta.json'),
          JSON.stringify({ indexedAt: 'new' }),
        );
        await expect(ensureRepoInitialized(options)).rejects.toThrow('temporary failure');
        expect(handle.lbugPath).toBe('/gen/A/lbug');
        expect(handle.indexedAt).toBe(originalIndexedAt);
        await ensureRepoInitialized(options);
        expect(initLbug).toHaveBeenLastCalledWith(handle.id, '/gen/B/lbug');
        expect(handle.lbugPath).toBe('/gen/B/lbug');
        expect(handle.indexedAt).toBe('new');
        expect(initializedRepos.has(handle.id)).toBe(true);
      } finally {
        await fs.rm(storagePath, { recursive: true, force: true });
      }
    },
  );
});

function makeRepo(id: string, name: string, repoPath: string): RepoHandle {
  const resolvedRepoPath = path.resolve(repoPath);
  return {
    id,
    name,
    repoPath: resolvedRepoPath,
    storagePath: `${resolvedRepoPath}/.ontoindex`,
    lbugPath: `${resolvedRepoPath}/.ontoindex/lbug.db`,
    indexedAt: '2026-06-13T00:00:00.000Z',
    lastCommit: 'abc123',
  };
}

describe('resolveRepoFromHandles', () => {
  it('defaults to the preferred project path when multiple repos are indexed', () => {
    const repos = new Map<string, RepoHandle>([
      ['ontoindex', makeRepo('ontoindex', 'OntoIndex', '/opt/demodb/_workfolder/OntoIndex')],
      ['codex', makeRepo('codex', 'codex', '/opt/demodb/_workfolder/ontocode')],
    ]);

    const result = resolveRepoFromHandles(repos, undefined, '/opt/demodb/_workfolder/ontocode');

    expect(result).toEqual({ kind: 'resolved', repo: repos.get('codex') });
  });

  it('prefers an explicit repo parameter over the preferred project path', () => {
    const repos = new Map<string, RepoHandle>([
      ['ontoindex', makeRepo('ontoindex', 'OntoIndex', '/opt/demodb/_workfolder/OntoIndex')],
      ['codex', makeRepo('codex', 'codex', '/opt/demodb/_workfolder/ontocode')],
    ]);

    const result = resolveRepoFromHandles(repos, 'ontoindex', '/opt/demodb/_workfolder/ontocode');

    expect(result).toEqual({ kind: 'resolved', repo: repos.get('ontoindex') });
  });

  it('still returns null when multiple repos are indexed and no default matches', () => {
    const repos = new Map<string, RepoHandle>([
      ['ontoindex', makeRepo('ontoindex', 'OntoIndex', '/opt/demodb/_workfolder/OntoIndex')],
      ['codex', makeRepo('codex', 'codex', '/opt/demodb/_workfolder/ontocode')],
    ]);

    const result = resolveRepoFromHandles(
      repos,
      undefined,
      '/opt/demodb/_workfolder/unindexed-project',
    );

    expect(result.kind).toBe('ambiguous');
  });

  it('uses the preferred project path to disambiguate duplicate labels', () => {
    const active = makeRepo('codex', 'codex', '/opt/demodb/_workfolder/ontocode');
    const stale = makeRepo('codex-b3B0L2', 'codex', '/opt/demodb/_workfolder/ontocode-f1-layout');
    const repos = new Map<string, RepoHandle>([
      [active.id, active],
      [stale.id, stale],
    ]);

    expect(resolveRepoFromHandles(repos, 'codex', active.repoPath)).toEqual({
      kind: 'resolved',
      repo: active,
    });
  });

  it('prefers the longest containing repository path', () => {
    const parent = makeRepo('workspace', 'shared', '/opt/workspace');
    const child = makeRepo('project', 'shared', '/opt/workspace/project');
    const repos = new Map<string, RepoHandle>([
      [parent.id, parent],
      [child.id, child],
    ]);

    expect(resolveRepoFromHandles(repos, 'shared', '/opt/workspace/project/src')).toEqual({
      kind: 'resolved',
      repo: child,
    });
    expect(resolveRepoFromHandles(repos, undefined, '/opt/workspace/project/src')).toEqual({
      kind: 'resolved',
      repo: child,
    });
  });

  it('reports duplicate labels as ambiguous without a matching preferred path', () => {
    const first = makeRepo('first', 'shared', '/opt/first');
    const second = makeRepo('second', 'shared', '/opt/second');
    const repos = new Map<string, RepoHandle>([
      [first.id, first],
      [second.id, second],
    ]);

    expect(resolveRepoFromHandles(repos, 'shared', '/opt/unrelated')).toEqual({
      kind: 'ambiguous',
      candidates: [first, second],
    });
  });

  it('reports partial labels as ambiguous unless only one matches', () => {
    const first = makeRepo('first', 'shared-api', '/opt/first');
    const second = makeRepo('second', 'shared-web', '/opt/second');
    const repos = new Map<string, RepoHandle>([
      [first.id, first],
      [second.id, second],
    ]);

    expect(resolveRepoFromHandles(repos, 'shared')).toEqual({
      kind: 'ambiguous',
      candidates: [first, second],
    });
    expect(resolveRepoFromHandles(repos, 'api')).toEqual({ kind: 'resolved', repo: first });
  });

  it('matches an exact repository path through a symlink', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ontoindex-resolve-'));
    const repoPath = path.join(tempRoot, 'repo');
    const symlinkPath = path.join(tempRoot, 'repo-link');
    await fs.mkdir(repoPath);
    await fs.symlink(repoPath, symlinkPath, 'dir');
    const repo = makeRepo('repo', 'repo', repoPath);

    try {
      expect(resolveRepoFromHandles(new Map([[repo.id, repo]]), symlinkPath)).toEqual({
        kind: 'resolved',
        repo,
      });
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });
});

describe('ensureRepoInitialized', () => {
  it('adopts the commit of a newly published generation when it reopens the index', async () => {
    const repoPath = await fs.mkdtemp(path.join(os.tmpdir(), 'ontoindex-republish-'));
    const storagePath = path.join(repoPath, '.ontoindex');
    await fs.mkdir(storagePath);
    const handle = makeRepo('repo', 'repo', repoPath);
    const initLbug = vi.fn(async () => undefined);
    try {
      await fs.writeFile(
        path.join(storagePath, 'meta.json'),
        JSON.stringify({ indexedAt: '2026-09-27T06:44:54.355Z', lastCommit: 'def456' }),
      );
      await ensureRepoInitialized({
        repoId: 'repo',
        handle,
        initializedRepos: new Set(['repo']),
        reinitPromises: new Map(),
        lastStalenessCheck: new Map(),
        isLbugReady: () => true,
        initLbug,
        closeLbug: vi.fn(async () => undefined),
        resolveActiveLbugPath: vi.fn(async () => '/gen/B/lbug'),
      });
      expect(initLbug).toHaveBeenCalledOnce();
      expect(handle.indexedAt).toBe('2026-09-27T06:44:54.355Z');
      expect(handle.lastCommit).toBe('def456');
    } finally {
      await fs.rm(repoPath, { recursive: true, force: true });
    }
  });

  it.each([
    {
      label: 'unchanged timestamp',
      indexedAt: '2026-06-13T00:00:00.000Z',
      activePath: '/gen/B/lbug',
      reopens: true,
    },
    {
      label: 'changed timestamp',
      indexedAt: '2026-06-14T00:00:00.000Z',
      activePath: '/gen/B/lbug',
      reopens: true,
    },
    {
      label: 'legacy layout with unchanged timestamp',
      indexedAt: '2026-06-13T00:00:00.000Z',
      activePath: null,
      reopens: false,
    },
    {
      label: 'legacy layout with changed timestamp',
      indexedAt: '2026-06-14T00:00:00.000Z',
      activePath: null,
      reopens: true,
    },
    { label: 'missing metadata', indexedAt: null, activePath: '/gen/B/lbug', reopens: true },
  ])('uses the active generation for $label', async ({ indexedAt, activePath, reopens }) => {
    const storagePath = await fs.mkdtemp(path.join(os.tmpdir(), 'ontoindex-reinit-'));
    const handle = makeRepo('repo', 'repo', storagePath);
    handle.storagePath = storagePath;
    handle.lbugPath = '/gen/A/lbug';
    const originalIndexedAt = handle.indexedAt;
    const calls: string[] = [];
    const closeLbug = vi.fn(async () => {
      calls.push('close');
    });
    const initLbug = vi.fn(async () => {
      calls.push('init');
    });
    const initializedRepos = new Set([handle.id]);
    const reinitPromises = new Map<string, Promise<void>>();
    const resolveActiveLbugPath = vi.fn(async () => activePath);

    try {
      if (indexedAt)
        await fs.writeFile(path.join(storagePath, 'meta.json'), JSON.stringify({ indexedAt }));
      await ensureRepoInitialized({
        repoId: handle.id,
        handle,
        initializedRepos,
        reinitPromises,
        lastStalenessCheck: new Map(),
        isLbugReady: () => true,
        initLbug,
        closeLbug,
        resolveActiveLbugPath,
        now: () => 5000,
      });

      expect(resolveActiveLbugPath).toHaveBeenCalledWith(storagePath);
      expect(calls).toEqual(reopens ? ['close', 'init'] : []);
      if (reopens) expect(initLbug).toHaveBeenCalledWith(handle.id, activePath ?? '/gen/A/lbug');
      expect(handle.lbugPath).toBe(activePath ?? '/gen/A/lbug');
      expect(handle.indexedAt).toBe(indexedAt ?? originalIndexedAt);
      expect(initializedRepos.has(handle.id)).toBe(true);
      expect(reinitPromises.size).toBe(0);
    } finally {
      await fs.rm(storagePath, { recursive: true, force: true });
    }
  });
});

describe('repository preparation coalescing', () => {
  function fixture() {
    const handle = makeRepo('coalesce', 'coalesce', '/missing/coalesce');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const initLbug = vi.fn(async () => {
      await gate;
    });
    const options = {
      repoId: handle.id,
      handle,
      initializedRepos: new Set<string>(),
      reinitPromises: new Map<string, Promise<void>>(),
      lastStalenessCheck: new Map<string, number>(),
      isLbugReady: () => false,
      initLbug,
      closeLbug: vi.fn(async () => {}),
      resolveActiveLbugPath: vi.fn(async () => null),
    };
    return { options, initLbug, release };
  }

  it('cancels one waiter without cancelling shared preparation', async () => {
    const { options, initLbug, release } = fixture();
    const controller = new AbortController();
    const first = ensureRepoInitialized({ ...options, signal: controller.signal });
    const second = ensureRepoInitialized(options);
    const rejected = expect(first).rejects.toMatchObject({ code: 'cancelled' });
    controller.abort();
    await rejected;
    release();
    await second;
    expect(initLbug).toHaveBeenCalledOnce();
  });

  it('times out one waiter while another still resolves', async () => {
    vi.useFakeTimers();
    try {
      const { options, initLbug, release } = fixture();
      const first = ensureRepoInitialized({ ...options, deadline: performance.now() + 10 });
      const second = ensureRepoInitialized(options);
      const rejected = expect(first).rejects.toMatchObject({ code: 'timeout' });
      await vi.advanceTimersByTimeAsync(10);
      await rejected;
      release();
      await second;
      expect(initLbug).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('caps the waiter deadline at sixty seconds and observes late failure', async () => {
    vi.useFakeTimers();
    try {
      const { options, initLbug, release } = fixture();
      initLbug.mockImplementationOnce(async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 60_001));
        throw new Error('late failure');
      });
      const waiter = ensureRepoInitialized({ ...options, deadline: performance.now() + 120_000 });
      const rejected = expect(waiter).rejects.toBeInstanceOf(RepoPreparationWaitError);
      await vi.advanceTimersByTimeAsync(60_000);
      await rejected;
      // Flush native filesystem preparation before advancing its delayed initializer.
      await vi.waitFor(() => expect(initLbug).toHaveBeenCalledOnce());
      await vi.runAllTimersAsync();
      release();
      // The late shared rejection is observed even though no waiter remains.
    } finally {
      vi.useRealTimers();
    }
  });

  it('removes abort listeners after preparation settles', async () => {
    const { options, release } = fixture();
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const waiter = ensureRepoInitialized({ ...options, signal: controller.signal });
    release();
    await waiter;
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
  });

  it('fails a queued successor once and permits a fresh retry', async () => {
    const { options, initLbug } = fixture();
    initLbug.mockImplementation(async () => {
      throw new Error('failed');
    });
    const first = ensureRepoInitialized(options);
    const successor = ensureRepoInitialized({
      ...options,
      handle: { ...options.handle, indexedAt: 'next' },
    });
    await Promise.all([
      expect(first).rejects.toThrow('failed'),
      expect(successor).rejects.toThrow('failed'),
    ]);
    expect(initLbug).toHaveBeenCalledTimes(2);
    initLbug.mockResolvedValue(undefined);
    await ensureRepoInitialized(options);
    expect(initLbug).toHaveBeenCalledTimes(3);
  });

  it('shares concurrent preparation for the same snapshot and starts fresh after settling', async () => {
    const { options, initLbug, release } = fixture();
    const first = ensureRepoInitialized(options);
    const second = ensureRepoInitialized(options);
    expect(first).not.toBe(second);
    await vi.waitFor(() => expect(initLbug).toHaveBeenCalledTimes(1));
    release();
    await Promise.all([first, second]);
    await ensureRepoInitialized(options);
    expect(initLbug).toHaveBeenCalledTimes(2);
  });

  it('collapses changed snapshots into one latest successor', async () => {
    const { options, initLbug, release } = fixture();
    const first = ensureRepoInitialized(options);
    await vi.waitFor(() => expect(initLbug).toHaveBeenCalledTimes(1));
    const second = ensureRepoInitialized({
      ...options,
      handle: { ...options.handle, lbugPath: '/gen/B/lbug' },
    });
    const third = ensureRepoInitialized({
      ...options,
      handle: { ...options.handle, lbugPath: '/gen/C/lbug' },
    });
    expect(second).not.toBe(third);
    expect(initLbug).toHaveBeenCalledTimes(1);
    release();
    await Promise.all([first, second, third]);
    expect(initLbug).toHaveBeenCalledTimes(2);
    expect(initLbug).toHaveBeenLastCalledWith(options.repoId, '/gen/C/lbug');
  });

  it('clears failed preparation so the next call retries', async () => {
    const { options, initLbug, release } = fixture();
    initLbug.mockRejectedValueOnce(new Error('preparation failed'));
    await expect(ensureRepoInitialized(options)).rejects.toThrow('preparation failed');
    release();
    await ensureRepoInitialized(options);
    expect(initLbug).toHaveBeenCalledTimes(2);
  });
});
