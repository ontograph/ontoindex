import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import path from 'node:path';
import {
  canonicalRepoId,
  registryRepoIds,
  resolveRegistryEntry,
} from '../../src/mcp/shared/target-context.js';

describe('shared repository identity', () => {
  const first = {
    name: 'Project',
    path: '/repos/first',
    storagePath: '/indexes/first',
    indexedAt: '',
  };
  const second = { ...first, path: '/repos/second', storagePath: '/indexes/second' };
  const registry = [first, second];

  it('keeps collision ids stable when the registry is reordered', () => {
    const forward = registryRepoIds(registry);
    const reverse = registryRepoIds([...registry].reverse());
    for (const entry of registry) {
      expect(forward.get(entry)).toBe(reverse.get(entry));
      expect(forward.get(entry)).toMatch(/^project-[a-f0-9]{8}$/);
      expect(resolveRegistryEntry(registry, forward.get(entry))).toEqual({ status: 'ok', entry });
    }
    expect(registryRepoIds([first]).get(first)).toBe('project');
    const ambiguous = resolveRegistryEntry(registry, 'project');
    expect(ambiguous.status).toBe('ambiguous');
    if (ambiguous.status !== 'ok') expect(ambiguous.action).toContain(forward.get(first));
  });

  it('resolves paths and canonical collision ids to the same entry', () => {
    const ids = new Map([['project', { name: first.name, repoPath: first.path }]]);
    const id = canonicalRepoId(second.name, second.path, ids);
    expect(id).toBe(
      `project-${createHash('sha256').update(path.resolve(second.path)).digest('hex').slice(0, 8)}`,
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

  it('assigns filtered servers the same canonical id as the full registry', async () => {
    const { LocalBackend } = await import('../../src/mcp/local/local-backend.js');
    const backend = new LocalBackend({ repoFilter: first.path }) as any;
    backend.loadRegisteredReposForBackend = vi.fn().mockResolvedValue(registry);
    await backend.refreshRepos();
    expect([...backend.repos.keys()]).toEqual([registryRepoIds(registry).get(first)]);
  });

  it('uses real candidate paths in ambiguous restart hints', async () => {
    const { LocalBackend } = await import('../../src/mcp/local/local-backend.js');
    const backend = new LocalBackend() as any;
    backend.loadRegisteredReposForBackend = vi.fn().mockResolvedValue(registry);
    await backend.refreshRepos();
    await expect(backend.resolveRepo('proj')).rejects.toThrow("--project '/repos/first'");
    await expect(backend.resolveRepo('proj')).rejects.not.toThrow(
      "--project '/opt/d1/tmp/ontoindex-build-2.2.22/ontoindex/proj'",
    );
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
