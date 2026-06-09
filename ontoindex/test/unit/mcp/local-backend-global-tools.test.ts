import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LocalBackend } from '../../../src/mcp/local/local-backend.js';
import { listRegisteredRepos } from '../../../src/storage/repo-manager.js';

vi.mock('../../../src/storage/repo-manager.js', () => ({
  listRegisteredRepos: vi.fn(),
  cleanupOldKuzuFiles: vi.fn().mockResolvedValue({ found: false, needsReindex: false }),
}));

vi.mock('../../../src/core/lbug/pool-adapter.js', () => ({
  initLbug: vi.fn().mockResolvedValue(undefined),
  closeLbug: vi.fn().mockResolvedValue(undefined),
  isLbugReady: vi.fn().mockReturnValue(true),
  executeQuery: vi.fn().mockResolvedValue([]),
  executeParameterized: vi.fn().mockResolvedValue([]),
}));

describe('LocalBackend repo-agnostic tool dispatch', () => {
  let backend: LocalBackend;

  beforeEach(async () => {
    vi.clearAllMocks();
    backend = new LocalBackend();

    // Multiple repos trigger the repo-selection gate for repo-scoped tools.
    (listRegisteredRepos as any).mockResolvedValue([
      { name: 'repo-1', path: '/path/1', storagePath: '/storage/1' },
      { name: 'repo-2', path: '/path/2', storagePath: '/storage/2' },
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

  it('bypasses repo resolution for gn_help', async () => {
    const result = await backend.callTool('gn_help', {});
    expect(result).toBeDefined();
    // gn_help returns a string or report object depending on params
  });

  it('bypasses repo resolution for gn_tool_contract', async () => {
    const result = await backend.callTool('gn_tool_contract', {});
    expect(result).toBeDefined();
  });

  it('bypasses repo resolution for gn_diagnose', async () => {
    const result = await backend.callTool('gn_diagnose', {});
    expect(result).toBeDefined();
    // gn_diagnose returns a report
  });

  it('still requires repo for repo-scoped tools', async () => {
    await expect(backend.callTool('query', { query: 'test' })).rejects.toThrow(
      'Multiple repositories indexed',
    );
  });
});
