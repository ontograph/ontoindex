import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { canonicalRepoId, resolveRegistryEntry } from '../../src/mcp/shared/target-context.js';

describe('shared repository identity', () => {
  const first = {
    name: 'Project',
    path: '/repos/first',
    storagePath: '/indexes/first',
    indexedAt: '',
  };
  const second = { ...first, path: '/repos/second', storagePath: '/indexes/second' };
  const registry = [first, second];

  it('resolves paths and canonical collision ids to the same entry', () => {
    const ids = new Map([['project', { name: first.name, repoPath: first.path }]]);
    const id = canonicalRepoId(second.name, second.path, ids);
    expect(id).toBe(
      `project-${createHash('sha256').update(second.path).digest('hex').slice(0, 8)}`,
    );
    expect(resolveRegistryEntry(registry, id)).toEqual({ status: 'ok', entry: second });
    expect(resolveRegistryEntry(registry, second.path)).toEqual({ status: 'ok', entry: second });
  });

  it('accepts mixed case names and refuses ambiguous exact or fuzzy selectors', () => {
    expect(resolveRegistryEntry([first], 'pRoJeCt')).toEqual({ status: 'ok', entry: first });
    expect(resolveRegistryEntry(registry, 'PROJECT').status).toBe('ambiguous');
    expect(resolveRegistryEntry(registry, 'proj').status).toBe('ambiguous');
  });

  it('reuses existing ids for the same resolved path', () => {
    expect(
      canonicalRepoId(
        'PROJECT',
        '/repos/first/../first',
        new Map([['project', { name: first.name, repoPath: first.path }]]),
      ),
    ).toBe('project');
  });

  it('keeps a newer queued lock tail until that operation settles', async () => {
    const { LocalBackend } = await import('../../src/mcp/local/local-backend.js');
    const backend = new LocalBackend() as any;
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = backend.withRepoLock('project', async () => {});
    const second = backend.withRepoLock('project', () => pending);
    await first;
    expect(backend.analysisLocks.has('project')).toBe(true);
    release();
    await second;
    await Promise.resolve();
    expect(backend.analysisLocks.has('project')).toBe(false);
  });

  it('prunes removed repository bookkeeping while retaining active work', async () => {
    const { LocalBackend } = await import('../../src/mcp/local/local-backend.js');
    const backend = new LocalBackend() as any;
    backend.loadRegisteredReposForBackend = vi.fn().mockResolvedValue([]);
    backend.lastStalenessCheck.set('removed', 1);
    backend.lastStalenessCheck.set('active', 1);
    let release!: () => void;
    const active = backend.withRepoLock(
      'active',
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    await Promise.resolve();
    await backend.refreshRepos();
    expect(backend.lastStalenessCheck.has('removed')).toBe(false);
    expect(backend.lastStalenessCheck.has('active')).toBe(true);
    release();
    await active;
    await Promise.resolve();
    await backend.refreshRepos();
    expect(backend.lastStalenessCheck.size).toBe(0);
  });
});
