import { beforeEach, describe, expect, it, vi } from 'vitest';

import { listRegisteredRepos } from '../../src/storage/repo-manager.js';
import { resolveAuditRepoHandle } from '../../src/mcp/super/audit-ingest.js';

vi.mock('../../src/storage/repo-manager.js', () => ({
  listRegisteredRepos: vi.fn(),
}));

const mockedListRegisteredRepos = vi.mocked(listRegisteredRepos);

describe('resolveAuditRepoHandle', () => {
  beforeEach(() => {
    mockedListRegisteredRepos.mockResolvedValue([
      {
        name: 'codex-release-candidate',
        path: '/opt/demodb/_workfolder/ontocode',
        storagePath: '/opt/demodb/_workfolder/ontocode/.ontoindex',
        indexedAt: '2026-09-26T00:00:00.000Z',
        lastCommit: 'abc123',
      },
      {
        name: 'ontoindex',
        path: '/opt/demodb/_workfolder/OntoIndex',
        storagePath: '/opt/demodb/_workfolder/OntoIndex/.ontoindex',
        indexedAt: '2026-09-26T00:00:00.000Z',
        lastCommit: 'def456',
      },
    ]);
  });

  it('resolves a unique partial alias', async () => {
    await expect(resolveAuditRepoHandle('server', 'codex')).resolves.toEqual({
      id: 'codex-release-candidate',
      repoPath: '/opt/demodb/_workfolder/ontocode',
    });
  });

  it('matches names and paths case-insensitively where supported', async () => {
    await expect(resolveAuditRepoHandle('server', 'ONTOINDEX')).resolves.toMatchObject({
      id: 'ontoindex',
    });
    await expect(
      resolveAuditRepoHandle('server', '/opt/demodb/_workfolder/OntoIndex'),
    ).resolves.toMatchObject({ id: 'OntoIndex' });
  });

  it('rejects ambiguous aliases', async () => {
    mockedListRegisteredRepos.mockResolvedValueOnce([
      {
        name: 'codex-main',
        path: '/tmp/codex-main',
        storagePath: '/tmp/codex-main/.ontoindex',
        indexedAt: '2026-09-26T00:00:00.000Z',
        lastCommit: 'abc123',
      },
      {
        name: 'codex-release-candidate',
        path: '/tmp/codex-release-candidate',
        storagePath: '/tmp/codex-release-candidate/.ontoindex',
        indexedAt: '2026-09-26T00:00:00.000Z',
        lastCommit: 'def456',
      },
    ]);

    await expect(resolveAuditRepoHandle('server', 'codex')).rejects.toThrow(
      'Repository is ambiguous: codex',
    );
  });
});
