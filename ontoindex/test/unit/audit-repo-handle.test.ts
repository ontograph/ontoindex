import { describe, expect, it, vi } from 'vitest';
import { registryRepoIds } from '../../src/mcp/shared/target-context.js';
vi.mock('../../src/storage/repo-manager.js', () => ({ listRegisteredRepos: vi.fn() }));
import { listRegisteredRepos } from '../../src/storage/repo-manager.js';
import { resolveAuditRepoHandle } from '../../src/mcp/super/audit-ingest.js';

describe('audit repository handles', () => {
  const entries = [
    { name: 'foo', path: '/a/foo', storagePath: '/a/index', indexedAt: '' },
    { name: 'foo', path: '/b/foo', storagePath: '/b/index', indexedAt: '' },
  ];
  it('resolves canonical ids and absolute paths', async () => {
    vi.mocked(listRegisteredRepos).mockResolvedValue(entries);
    const id = registryRepoIds(entries).get(entries[1])!;
    await expect(resolveAuditRepoHandle(id)).resolves.toEqual({ id, repoPath: '/b/foo' });
    await expect(resolveAuditRepoHandle(id, '/a/foo')).resolves.toEqual({
      id: 'foo',
      repoPath: '/a/foo',
    });
  });
  it('resolves a unique name', async () => {
    vi.mocked(listRegisteredRepos).mockResolvedValue([entries[0]]);
    await expect(resolveAuditRepoHandle('foo')).resolves.toEqual({ id: 'foo', repoPath: '/a/foo' });
  });
  it('rejects duplicate names with both canonical ids and paths', async () => {
    vi.mocked(listRegisteredRepos).mockResolvedValue(entries);
    for (const entry of entries) {
      await expect(resolveAuditRepoHandle('foo')).rejects.toThrow(
        registryRepoIds(entries).get(entry)!,
      );
      await expect(resolveAuditRepoHandle('foo')).rejects.toThrow(entry.path);
    }
  });
});
