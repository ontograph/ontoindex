/**
 * Unit Tests: LocalBackend write-verb gating
 *
 * Verifies that the replace_symbol tool respects confirmation requirements
 * and the --confirm-writes startup flag.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
  resolveActiveIndexGeneration: vi.fn().mockResolvedValue(null),
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

  it('resolves replace_symbol in dry_run mode without requiring confirmation', async () => {
    backend = new LocalBackend({ confirmWrites: true });
    await backend.init();

    await expect(
      backend.callTool('replace_symbol', {
        uid: 'Function:foo',
        new_body: 'return 1;',
        dry_run: true,
      }),
    ).rejects.toThrow(/Symbol not found or ambiguous/);
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

  it.each([
    { tool: 'update_symbol_body', mutation: { new_body: 'export function foo() { return 2; }' } },
    { tool: 'extract_function', mutation: { new_name: 'extractedFoo' } },
    { tool: 'move_symbol', mutation: {} },
  ])(
    'rejects $tool when request confirmation cannot override disabled backend writes',
    async ({ tool, mutation }) => {
      const repoPath = await mkdtemp(join(tmpdir(), 'ontoindex-write-gating-'));
      const sourcePath = join(repoPath, 'source.ts');
      const destinationPath = join(repoPath, 'destination.ts');

      try {
        await writeFile(sourcePath, 'export function foo() { return 1; }\n');
        await writeFile(destinationPath, 'export const existing = true;\n');
        const sourceBefore = await readFile(sourcePath);
        const destinationBefore = await readFile(destinationPath);
        (listRegisteredRepos as any).mockResolvedValue([{ ...MOCK_REPO_ENTRY, path: repoPath }]);
        backend = new LocalBackend({ confirmWrites: false });
        await backend.init();

        await expect(
          backend.callTool(tool, {
            uid: 'Function:foo',
            target_file: 'destination.ts',
            ...mutation,
            dry_run: false,
            confirm: true,
            confirmWrites: true,
          }),
        ).rejects.toThrow('Write operations are disabled (start server with --confirm-writes)');

        expect(await readFile(sourcePath)).toEqual(sourceBefore);
        expect(await readFile(destinationPath)).toEqual(destinationBefore);
      } finally {
        await rm(repoPath, { recursive: true, force: true });
      }
    },
  );

  it('rejects unresolved replace_symbol instead of reporting a successful write', async () => {
    backend = new LocalBackend({ confirmWrites: true });
    await backend.init();

    await expect(
      backend.callTool('replace_symbol', {
        uid: 'Function:foo',
        new_body: 'return 1;',
        dry_run: false,
        confirm: true,
      }),
    ).rejects.toThrow(/Symbol not found or ambiguous/);
  });
});
