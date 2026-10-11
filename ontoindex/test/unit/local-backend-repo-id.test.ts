import { beforeEach, describe, expect, it, vi } from 'vitest';

const { listRegisteredRepos } = vi.hoisted(() => ({ listRegisteredRepos: vi.fn() }));

vi.mock('../../src/storage/repo-manager.js', () => ({
  listRegisteredRepos,
  resolveActiveIndexGeneration: vi.fn().mockResolvedValue(null),
}));

import { LocalBackend } from '../../src/mcp/local/local-backend.js';

describe('LocalBackend repository IDs', () => {
  beforeEach(() => {
    listRegisteredRepos.mockReset();
  });

  it('keeps same-name repositories with shared path prefixes distinct', async () => {
    const commonParent = '/tmp/ontoindex-repo-id-test';
    listRegisteredRepos.mockResolvedValue(
      ['one', 'two', 'three'].map((name) => ({
        name: 'shared-name',
        path: `${commonParent}/${name}`,
        storagePath: `${commonParent}/${name}/.ontoindex`,
        indexedAt: '2026-01-01T00:00:00.000Z',
        lastCommit: 'abc123',
        stats: {},
      })),
    );

    const repos = await new LocalBackend().listRepos();

    expect(repos).toHaveLength(3);
    expect(new Set(repos.map((repo) => repo.path)).size).toBe(3);
  });
});
