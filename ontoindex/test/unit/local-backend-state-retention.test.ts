import { describe, it, expect, vi } from 'vitest';
import { LocalBackend } from '../../src/mcp/local/local-backend.js';
import { closeLbug, getLbugDbPath } from '../../src/core/lbug/pool-adapter.js';
vi.mock('../../src/core/lbug/pool-adapter.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/core/lbug/pool-adapter.js')>()),
  closeLbug: vi.fn().mockResolvedValue(undefined),
  getLbugDbPath: vi.fn(),
}));

describe('backend state retention', () => {
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
