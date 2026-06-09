/**
 * Unit Tests: Sandbox tool confirmation gating
 *
 * Verifies that 'sandbox apply' requires explicit confirmation.
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
      name: 'test-project',
      path: '/tmp/test-project',
      storagePath: '/tmp/.ontoindex/test-project',
      indexedAt: '2024-06-01T12:00:00Z',
      lastCommit: 'abc1234567890',
      stats: { files: 10, nodes: 50 },
    },
  ]),
  cleanupOldKuzuFiles: vi.fn().mockResolvedValue({ found: false, needsReindex: false }),
}));

import { LocalBackend } from '../../src/mcp/local/local-backend.js';

describe('sandbox tool confirmation gating', () => {
  let backend: LocalBackend;

  beforeEach(async () => {
    vi.clearAllMocks();
    backend = new LocalBackend();
    await backend.init();
  });

  it('allows "stage" action without confirmation', async () => {
    const result = await backend.callTool('sandbox', {
      action: 'stage',
      payload: { file: 'foo.ts' },
    });
    expect(result.success).toBe(true);
  });

  it('rejects "apply" action without confirm: true', async () => {
    await expect(backend.callTool('sandbox', { action: 'apply' })).rejects.toThrow(
      /Explicit confirmation.*required/,
    );
  });

  it('allows "apply" action with confirm: true', async () => {
    const result = await backend.callTool('sandbox', { action: 'apply', confirm: true });
    expect(result.success).toBe(true);
  });
});
