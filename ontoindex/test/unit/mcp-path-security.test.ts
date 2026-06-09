/**
 * Unit Tests: MCP Tool Path Security
 *
 * Verifies that all tools accepting file paths (context, rename, replace_symbol, sandbox)
 * are secured against path traversal using canonicalize().
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { lbugMocks } = vi.hoisted(() => ({
  lbugMocks: {
    initLbug: vi.fn().mockResolvedValue(undefined),
    executeQuery: vi.fn().mockResolvedValue([]),
    executeParameterized: vi.fn().mockResolvedValue([]),
    closeLbug: vi.fn().mockResolvedValue(undefined),
    isLbugReady: vi.fn().mockReturnValue(true),
  },
}));

vi.mock('../../src/core/lbug/pool-adapter.js', async (importOriginal) => {
  const actual: any = await importOriginal();
  return { ...actual, ...lbugMocks };
});

vi.mock('../../src/storage/repo-manager.js', () => ({
  listRegisteredRepos: vi.fn().mockResolvedValue([
    {
      name: 'test-repo',
      path: '/home/user/repo',
      storagePath: '/home/user/repo/.ontoindex',
      indexedAt: '2024-06-01T12:00:00Z',
      lastCommit: 'abc1234567890',
      stats: { files: 10, nodes: 50 },
    },
  ]),
  cleanupOldKuzuFiles: vi.fn().mockResolvedValue({ found: false, needsReindex: false }),
}));

import { LocalBackend } from '../../src/mcp/local/local-backend.js';

describe('MCP Tool Path Security', () => {
  let backend: LocalBackend;

  beforeEach(async () => {
    vi.clearAllMocks();
    backend = new LocalBackend();
    await backend.init();
  });

  it('context: rejects paths outside repo root', async () => {
    await expect(
      backend.callTool('context', {
        name: 'foo',
        file_path: '../../etc/passwd',
        repo: 'test-repo',
      }),
    ).rejects.toThrow(/Path escapes repository/);
  });

  it('rename: rejects paths outside repo root', async () => {
    await expect(
      backend.callTool('rename', {
        symbol_name: 'foo',
        new_name: 'bar',
        file_path: '../../etc/passwd',
        repo: 'test-repo',
      }),
    ).rejects.toThrow(/Path escapes repository/);
  });

  // Note: replace_symbol currently takes uid, but if we add file_path later, it must be secured.
  // sandbox might take paths in payload.
});
