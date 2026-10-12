import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  listRegisteredRepos: vi.fn(),
  initLbug: vi.fn(),
  closeLbug: vi.fn(),
}));
vi.mock('../../src/storage/repo-manager.js', () => ({
  listRegisteredRepos: mocks.listRegisteredRepos,
  resolveActiveIndexGeneration: vi.fn().mockResolvedValue(null),
}));
vi.mock('fs/promises', () => ({
  default: {
    access: vi.fn().mockResolvedValue(undefined),
    stat: vi.fn().mockRejectedValue(new Error('absent')),
    readFile: vi.fn().mockRejectedValue(new Error('absent')),
  },
}));
vi.mock('../../src/core/lbug/pool-adapter.js', () => ({
  initLbug: mocks.initLbug,
  closeLbug: mocks.closeLbug,
  isLbugReady: () => false,
  isLbugDbPathReady: () => false,
  isWriteQuery: () => false,
  executeParameterized: vi.fn(),
}));
import { LocalBackend } from '../../src/mcp/local/local-backend.js';

const entry = {
  name: 'removal',
  path: '/repo/removal',
  storagePath: '/repo/removal/.ontoindex',
  indexedAt: '2026-10-12T00:00:00Z',
  lastCommit: 'abc123',
  stats: {},
};
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('repository removal admission and drain', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listRegisteredRepos.mockResolvedValue([entry]);
    mocks.initLbug.mockResolvedValue(undefined);
    mocks.closeLbug.mockResolvedValue(undefined);
  });

  it('drains accepted work, rejects new work and concurrent removal, then awaits close', async () => {
    const backend = new LocalBackend();
    await backend.init();
    const active = deferred();
    const closing = deferred();
    mocks.closeLbug.mockReturnValue(closing.promise);
    const operation = backend.withOperation(() => active.promise);
    const remove = vi.fn(async () => {
      mocks.listRegisteredRepos.mockResolvedValue([]);
    });
    const removal = backend.withRepoRemoval(entry.name, entry.path, remove);
    expect(() => backend.withOperation(async () => {})).toThrow('removal is in progress');
    await expect(backend.withRepoRemoval(entry.name, entry.path, remove)).rejects.toThrow(
      'removal is in progress',
    );
    await expect(backend.init()).rejects.toThrow('removal is in progress');
    await expect(backend.listRepos({ refresh: false })).rejects.toThrow('removal is in progress');
    await expect(backend.resolveRepo(entry.name)).rejects.toThrow('removal is in progress');
    expect(mocks.closeLbug).not.toHaveBeenCalled();
    active.resolve();
    await operation;
    await vi.waitFor(() => expect(mocks.closeLbug).toHaveBeenCalledWith('removal'));
    expect(remove).not.toHaveBeenCalled();
    closing.resolve();
    await removal;
    expect(remove).toHaveBeenCalledTimes(1);
    expect(await backend.listRepos()).toEqual([]);
    expect(backend.getContext()).toBeNull();
    await backend.withRepoRemoval(entry.name, entry.path, async () => {});
  });

  it('drains registry initialization that publishes the target after removal starts', async () => {
    const backend = new LocalBackend();
    const registry = deferred<Array<typeof entry>>();
    mocks.listRegisteredRepos.mockReturnValue(registry.promise);
    const initialization = backend.init();
    const remove = vi.fn(async () => {});
    const removal = backend.withRepoRemoval(entry.name, entry.path, remove);
    expect(remove).not.toHaveBeenCalled();
    registry.resolve([entry]);
    await initialization;
    await removal;
    expect(mocks.closeLbug).toHaveBeenCalledWith('removal');
    expect(await backend.listRepos({ refresh: false })).toEqual([]);
  });

  it('drains database initialization and never reopens from a queued stale handle', async () => {
    const backend = new LocalBackend();
    await backend.init();
    const initialization = deferred();
    mocks.initLbug.mockReturnValue(initialization.promise);
    const first = backend.ensureRepoInitialized('removal');
    await vi.waitFor(() => expect(mocks.initLbug).toHaveBeenCalledTimes(1));
    const queued = backend.ensureRepoInitialized('removal');
    const rejection = expect(queued).rejects.toThrow('removal is in progress');
    const remove = vi.fn(async () => {});
    const removal = backend.withRepoRemoval(entry.name, entry.path, remove);
    expect(mocks.closeLbug).not.toHaveBeenCalled();
    initialization.resolve();
    await Promise.all([first, rejection, removal]);
    expect(mocks.initLbug).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it.each(['close', 'remove'])(
    'releases admission and reloads registry after %s fails',
    async (stage) => {
      const backend = new LocalBackend();
      await backend.init();
      const failure = new Error(`${stage} failed`);
      const remove = vi.fn(async () => {
        if (stage === 'remove') throw failure;
      });
      if (stage === 'close') mocks.closeLbug.mockRejectedValueOnce(failure);
      await expect(backend.withRepoRemoval(entry.name, entry.path, remove)).rejects.toThrow(
        failure,
      );
      if (stage === 'close') expect(remove).not.toHaveBeenCalled();
      expect(await backend.withOperation(async () => 'available')).toBe('available');
      expect(await backend.listRepos()).toHaveLength(1);
      expect(mocks.listRegisteredRepos).toHaveBeenCalledTimes(2);
      await backend.withRepoRemoval(entry.name, entry.path, async () => {});
    },
  );
});
