/**
 * Unit Tests: LocalBackend write-verb gating
 *
 * Verifies that the replace_symbol tool respects confirmation requirements
 * and the --confirm-writes startup flag.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock LadybugDB and RepoManager to avoid side effects
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
  listRegisteredRepos: vi.fn().mockResolvedValue([]),
  cleanupOldKuzuFiles: vi.fn().mockResolvedValue({ found: false, needsReindex: false }),
}));

import { LocalBackend } from '../../src/mcp/local/local-backend.js';
import { listRegisteredRepos } from '../../src/storage/repo-manager.js';

const MOCK_REPO_ENTRY = {
  name: 'test-project',
  path: '/tmp/test-project',
  storagePath: '/tmp/.ontoindex/test-project',
  indexedAt: '2024-06-01T12:00:00Z',
  lastCommit: 'abc1234567890',
  stats: { files: 10, nodes: 50 },
};

describe('LocalBackend write-verb gating (replace_symbol)', () => {
  let backend: LocalBackend;

  beforeEach(async () => {
    vi.clearAllMocks();
    (listRegisteredRepos as any).mockResolvedValue([MOCK_REPO_ENTRY]);
  });

  it('allows replace_symbol in dry_run mode even without confirmation', async () => {
    backend = new LocalBackend({ confirmWrites: true });
    await backend.init();

    const result = await backend.callTool('replace_symbol', {
      uid: 'Function:foo',
      new_body: 'return 1;',
      dry_run: true,
    });

    expect(result.success).toBe(true);
    expect(result.dry_run).toBe(true);
  });

  it('rejects replace_symbol when dry_run: false and confirm: false', async () => {
    backend = new LocalBackend({ confirmWrites: true });
    await backend.init();

    await expect(
      backend.callTool('replace_symbol', {
        uid: 'Function:foo',
        new_body: 'return 1;',
        dry_run: false,
        confirm: false,
      }),
    ).rejects.toThrow(/Explicit confirmation.*required/);
  });

  it('rejects replace_symbol when dry_run: false and confirm: true but confirmWrites: false', async () => {
    // This simulates --no-confirm-writes flag at startup
    backend = new LocalBackend({ confirmWrites: false });
    await backend.init();

    await expect(
      backend.callTool('replace_symbol', {
        uid: 'Function:foo',
        new_body: 'return 1;',
        dry_run: false,
        confirm: true,
      }),
    ).rejects.toThrow(/Write operations are disabled/);
  });

  it('allows replace_symbol when dry_run: false, confirm: true, and confirmWrites: true', async () => {
    backend = new LocalBackend({ confirmWrites: true });
    await backend.init();

    const result = await backend.callTool('replace_symbol', {
      uid: 'Function:foo',
      new_body: 'return 1;',
      dry_run: false,
      confirm: true,
    });

    expect(result.success).toBe(true);
    expect(result.dry_run).toBe(false);
  });
});
