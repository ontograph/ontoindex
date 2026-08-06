import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LocalBackend } from '../../../src/mcp/local/local-backend.js';
import {
  listRegisteredRepos,
  resolveActiveIndexGeneration,
  type RegistryEntry,
} from '../../../src/storage/repo-manager.js';
import { initLbug } from '../../../src/core/lbug/pool-adapter.js';
import { gnDiagnose } from '../../../src/mcp/super/diagnose.js';

vi.mock('../../../src/storage/repo-manager.js', () => ({
  listRegisteredRepos: vi.fn(),
  resolveActiveIndexGeneration: vi.fn().mockResolvedValue(null),
  cleanupOldKuzuFiles: vi.fn().mockResolvedValue({ found: false, needsReindex: false }),
}));

vi.mock('../../../src/core/lbug/pool-adapter.js', () => ({
  initLbug: vi.fn().mockResolvedValue(undefined),
  closeLbug: vi.fn().mockResolvedValue(undefined),
  isLbugReady: vi.fn().mockReturnValue(true),
  isLbugDbPathReady: vi.fn().mockReturnValue(true),
  executeQuery: vi.fn().mockResolvedValue([]),
  executeParameterized: vi.fn().mockResolvedValue([]),
}));
vi.mock('../../../src/mcp/super/diagnose.js', () => ({
  gnDiagnose: vi.fn().mockResolvedValue({ version: 1 }),
}));

describe('LocalBackend repo-agnostic tool dispatch', () => {
  let backend: LocalBackend;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.mocked(resolveActiveIndexGeneration).mockResolvedValue(null);
    backend = new LocalBackend();

    // Multiple repos trigger the repo-selection gate for repo-scoped tools.
    vi.mocked(listRegisteredRepos).mockResolvedValue([
      {
        name: 'repo-1',
        path: '/path/1',
        storagePath: '/storage/1',
        indexedAt: '2026-08-06T00:00:00.000Z',
        lastCommit: 'commit-1',
      },
      {
        name: 'repo-2',
        path: '/path/2',
        storagePath: '/storage/2',
        indexedAt: '2026-08-06T00:00:00.000Z',
        lastCommit: 'commit-2',
      },
    ]);

    await backend.init();
  });

  it('bypasses repo resolution for gn_quality_mode', async () => {
    const result = await backend.callTool('gn_quality_mode', { level: 'balanced' });
    expect(result).toMatchObject({
      version: 1,
      appliedMode: 'balanced',
    });
  });

  it('opens the active index generation', async () => {
    vi.mocked(listRegisteredRepos).mockResolvedValue([
      {
        name: 'repo-1',
        path: '/path/1',
        storagePath: '/storage/1',
        indexedAt: '2026-08-06T00:00:00.000Z',
        lastCommit: 'commit-1',
      } satisfies RegistryEntry,
    ]);
    vi.mocked(resolveActiveIndexGeneration).mockResolvedValue({
      generationId: 'generation-1',
      generationPath: '/storage/1/generations/generation-1',
      lbugPath: '/storage/1/generations/generation-1/lbug',
      metaPath: '/storage/1/generations/generation-1/meta.json',
      snapshotPath: '/storage/1/generations/generation-1/snapshot.json',
    });

    const singleRepoBackend = new LocalBackend();
    await singleRepoBackend.init();
    await singleRepoBackend.ensureRepoInitialized('repo-1');

    expect(initLbug).toHaveBeenCalledWith('repo-1', '/storage/1/generations/generation-1/lbug');
  });

  it('bypasses repo resolution for gn_help', async () => {
    const result = await backend.callTool('gn_help', {});
    expect(result).toBeDefined();
    // gn_help returns a string or report object depending on params
  });

  it('bypasses repo resolution for gn_tool_contract', async () => {
    const result = await backend.callTool('gn_tool_contract', {});
    expect(result).toBeDefined();
  });

  it('routes gn_diagnose through repo resolution', async () => {
    const result = await backend.callTool('gn_diagnose', { repo: 'repo-1' });
    expect(result).toBeDefined();
    expect(gnDiagnose).toHaveBeenCalledWith('repo-1', { repo: 'repo-1' });
    // gn_diagnose returns a report
  });

  it('requires explicit repo for gn_diagnose when multiple repos are indexed', async () => {
    await expect(backend.callTool('gn_diagnose', {})).rejects.toThrow(
      'Multiple repositories are indexed',
    );
  });

  it('still requires repo for repo-scoped tools', async () => {
    await expect(backend.callTool('query', { query: 'test' })).rejects.toThrow(
      'Multiple repositories are indexed',
    );
  });
});
