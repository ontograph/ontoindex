import { describe, it, expect, vi } from 'vitest';
import { LocalBackend } from '../../src/mcp/local/local-backend.js';
import { closeLbug, getLbugDbPath } from '../../src/core/lbug/pool-adapter.js';
import { acquireWorkspaceWatch } from '../../src/mcp/local/local-backend-repo-runtime.js';
import * as overlay from '../../src/mcp/local/backend-overlay.js';
vi.mock('../../src/mcp/local/backend-overlay.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/mcp/local/backend-overlay.js')>()),
  getOverlaySnapshot: vi.fn(),
}));
vi.mock('../../src/mcp/local/local-backend-repo-runtime.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/mcp/local/local-backend-repo-runtime.js')>()),
  acquireWorkspaceWatch: vi.fn(),
}));
vi.mock('../../src/core/lbug/pool-adapter.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/core/lbug/pool-adapter.js')>()),
  closeLbug: vi.fn().mockResolvedValue(undefined),
  getLbugDbPath: vi.fn(),
}));

describe('backend state retention', () => {
  it('rejects a non-callable registry entry before preparation or tracking use', async () => {
    const backend = new LocalBackend() as any;
    vi.spyOn(backend, 'resolveRepo').mockResolvedValue({ id: 'dispatch-test' });
    backend.repoToolHandlers.set('overview', {});
    const prepare = vi.spyOn(backend, 'withPreparedRepoRead');
    const track = vi.spyOn(backend, 'trackRepoUse');
    try {
      await expect(backend.dispatchRepoTool('overview', {})).rejects.toThrow('Unknown tool');
      expect(prepare).not.toHaveBeenCalled();
      expect(track).not.toHaveBeenCalled();
    } finally {
      await backend.dispose();
    }
  });
  it.each(['toString', 'constructor', '__proto__'])(
    'rejects unregistered prototype handler %s',
    async (method) => {
      const backend = new LocalBackend() as any;
      vi.spyOn(backend, 'resolveRepo').mockResolvedValue({ id: 'dispatch-test' });
      const prepare = vi.spyOn(backend, 'withPreparedRepoRead');
      try {
        await expect(backend.dispatchRepoTool(method, {})).rejects.toThrow('Unknown tool');
        expect(prepare).not.toHaveBeenCalled();
      } finally {
        await backend.dispose();
      }
    },
  );
  it.each([undefined, 'readiness', 'context', 'drift'])(
    'gates docs action %s according to its graph requirements',
    async (action) => {
      const backend = new LocalBackend() as any;
      const handler = vi.fn().mockResolvedValue({ status: 'unavailable' });
      const prepare = vi
        .spyOn(backend, 'withPreparedRepoRead')
        .mockRejectedValue(new Error('workspace_too_large'));
      try {
        const request = backend.dispatchTrackedRepoTool(
          { id: 'docs-test' },
          'docs',
          { action },
          handler,
        );
        if (action === undefined || action === 'readiness') {
          expect(await request).toMatchObject({ status: 'unavailable' });
          expect(prepare).not.toHaveBeenCalled();
          expect(handler).toHaveBeenCalledOnce();
        } else {
          await expect(request).rejects.toThrow('workspace_too_large');
          expect(handler).not.toHaveBeenCalled();
        }
      } finally {
        await backend.dispose();
      }
    },
  );
  it('cancels one watcher startup waiter while another survives and releases once', async () => {
    vi.stubEnv('ONTOINDEX_AUTO_WORKSPACE', '1');
    const release = vi.fn().mockResolvedValue(undefined);
    let ready!: (watch: { release: typeof release }) => void;
    vi.mocked(acquireWorkspaceWatch)
      .mockClear()
      .mockImplementation(
        () =>
          new Promise((resolve) => {
            ready = resolve;
          }),
      );
    const probe = vi.mocked(overlay.getOverlaySnapshot).mockResolvedValue({
      usable: false,
      reason: 'no dirty files',
      baseMatches: true,
      headChanged: false,
      dirtyPaths: new Set(),
      parseErrorPaths: new Set(),
      overlayPaths: new Set(),
      uncoveredPaths: new Set(),
      tombstones: new Set(),
    });
    const backend = new LocalBackend({ watchWorkspace: true });
    const repo = { id: 'pending-watch', repoPath: '/repo', storagePath: '/repo/.ontoindex' } as any;
    const cancelledHandler = vi.fn(async () => 'cancelled');
    const survivorHandler = vi.fn(async () => 'survived');
    const controller = new AbortController();
    try {
      const cancelled = backend.withOperation(
        () => backend.withPreparedRepoRead(repo, { needsRelationships: false }, cancelledHandler),
        { signal: controller.signal },
      );
      const survivor = backend.withOperation(() =>
        backend.withPreparedRepoRead(repo, { needsRelationships: false }, survivorHandler),
      );
      await vi.waitFor(() => expect(acquireWorkspaceWatch).toHaveBeenCalledTimes(1));
      const rejected = expect(cancelled).rejects.toMatchObject({ code: 'workspace_cancelled' });
      controller.abort();
      await rejected;
      expect(probe).not.toHaveBeenCalled();
      expect(cancelledHandler).not.toHaveBeenCalled();
      ready({ release });
      await expect(survivor).resolves.toBe('survived');
      expect(probe).toHaveBeenCalledTimes(1);
      expect(survivorHandler).toHaveBeenCalledOnce();
      expect(cancelledHandler).not.toHaveBeenCalled();
      await backend.dispose();
      expect(release).toHaveBeenCalledOnce();
    } finally {
      probe.mockReset();
      vi.mocked(acquireWorkspaceWatch).mockClear();
      vi.unstubAllEnvs();
    }
  });
  it('retains one watch for concurrent requests and releases it before draining operations', async () => {
    vi.stubEnv('ONTOINDEX_AUTO_WORKSPACE', '1');
    const release = vi.fn().mockResolvedValue(undefined);
    vi.mocked(acquireWorkspaceWatch).mockResolvedValue({ release });
    const backend = new LocalBackend({ watchWorkspace: true }) as any;
    const repo = { id: 'watch-backend', repoPath: '/repo', storagePath: '/repo/.ontoindex' };
    await Promise.all([backend.retainWorkspaceWatch(repo), backend.retainWorkspaceWatch(repo)]);
    expect(acquireWorkspaceWatch).toHaveBeenCalledTimes(1);
    let drain!: () => void;
    const active = backend.withOperation(
      () =>
        new Promise<void>((resolve) => {
          drain = resolve;
        }),
    );
    const disposal = backend.dispose();
    await Promise.resolve();
    await Promise.resolve();
    expect(release).toHaveBeenCalledTimes(1);
    drain();
    await active;
    await disposal;
    vi.mocked(acquireWorkspaceWatch).mockClear();
    vi.unstubAllEnvs();
  });

  it('leaves foreground backend reads without a watcher', async () => {
    vi.stubEnv('ONTOINDEX_AUTO_WORKSPACE', '1');
    const backend = new LocalBackend() as any;
    await backend.retainWorkspaceWatch({ id: 'foreground' });
    expect(acquireWorkspaceWatch).not.toHaveBeenCalled();
    await backend.dispose();
    vi.unstubAllEnvs();
  });
  it('keeps shared-path live aliases open while closing distinct retired paths', () => {
    vi.mocked(closeLbug).mockClear();
    vi.mocked(getLbugDbPath).mockImplementation((id) =>
      id === 'shared' ? '/index/live' : '/index/retired',
    );
    const backend = new LocalBackend() as any;
    backend.repos.set('current', { lbugPath: '/index/live' });
    backend.initializedRepos.add('shared');
    backend.initializedRepos.add('distinct');
    backend.pruneRetiredRepoState();
    expect(closeLbug).not.toHaveBeenCalledWith('shared');
    expect(closeLbug).toHaveBeenCalledWith('distinct');
    expect(backend.initializedRepos.size).toBe(0);
  });
  it('retires removed state after the refresh operation settles', async () => {
    const backend = new LocalBackend() as any;
    backend.loadRegisteredReposForBackend = vi.fn().mockResolvedValue([]);
    backend.initializedRepos.add('removed');
    backend.lastStalenessCheck.set('removed', 1);
    await backend.withOperation(() => backend.refreshRepos());
    expect(backend.initializedRepos.has('removed')).toBe(false);
    expect(backend.lastStalenessCheck.has('removed')).toBe(false);
  });

  it('retains removed state until another admitted operation settles', async () => {
    const backend = new LocalBackend() as any;
    backend.loadRegisteredReposForBackend = vi.fn().mockResolvedValue([]);
    backend.initializedRepos.add('removed');
    let release!: () => void;
    const active = backend.withOperation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    await backend.withOperation(() => backend.refreshRepos());
    expect(backend.initializedRepos.has('removed')).toBe(true);
    release();
    await active;
    expect(backend.initializedRepos.has('removed')).toBe(false);
  });

  it('rejects admission once disposal starts while draining admitted work', async () => {
    const backend = new LocalBackend();
    let release!: () => void;
    const active = backend.withOperation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    await Promise.resolve();
    const disposal = backend.dispose();
    expect(() => backend.withOperation(async () => {})).toThrow('backend is shutting down');
    release();
    await active;
    await disposal;
  });
});
