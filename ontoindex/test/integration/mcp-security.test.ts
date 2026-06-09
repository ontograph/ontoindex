import { describe, it, expect, beforeAll, vi } from 'vitest';
import { LocalBackend } from '../../src/mcp/local/local-backend.js';
import { listRegisteredRepos } from '../../src/storage/repo-manager.js';

vi.mock('../../src/storage/repo-manager.js', () => ({
  listRegisteredRepos: vi.fn().mockResolvedValue([]),
  cleanupOldKuzuFiles: vi.fn().mockResolvedValue({ found: false, needsReindex: false }),
}));

describe('MCP Security Integration', () => {
  let backend: LocalBackend;

  beforeAll(async () => {
    vi.mocked(listRegisteredRepos).mockResolvedValue([
      {
        name: 'test-repo',
        path: '/test/repo',
        storagePath: '/tmp/ontoindex-mcp-security-index',
        indexedAt: new Date().toISOString(),
        lastCommit: 'abc123',
        stats: { files: 2, nodes: 3, communities: 1, processes: 1 },
      },
    ]);

    backend = new LocalBackend();
    await backend.init();
  });

  it('rename tool blocks path traversal in file_path before opening LadybugDB', async () => {
    // canonicalize throws before rename initializes the repository DB.
    await expect(
      backend.callTool('rename', {
        symbol_name: 'login',
        new_name: 'newLogin',
        file_path: '../../etc/passwd',
        dry_run: true,
      }),
    ).rejects.toThrow(/escapes repository/i);
  });
});
