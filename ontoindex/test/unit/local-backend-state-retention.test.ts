import { describe, it, expect, vi } from 'vitest';
import { LocalBackend } from '../../src/mcp/local/local-backend.js';

describe('backend state retention', () => {
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
