import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { exportCommunityEvidencePackCommand } from '../../src/cli/export.js';
import { runCommunityEvidencePack } from '../../src/mcp/local/backend-community-evidence-pack.js';
import { loadMeta, getStoragePaths } from '../../src/storage/repo-manager.js';

vi.mock('node:fs');
vi.mock('node:child_process');
vi.mock('../../src/storage/repo-manager.js');
vi.mock('../../src/mcp/local/backend-community-evidence-pack.js');
vi.mock('../../src/core/lbug/pool-adapter.js', () => ({
  initLbug: vi.fn(),
  closeLbug: vi.fn(),
}));

describe('exportCommunityEvidencePackCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(execFileSync).mockReturnValue('test-root' as any);
    vi.mocked(getStoragePaths).mockReturnValue({
      storagePath: 'test-storage',
      lbugPath: 'test-lbug',
    } as any);
    vi.mocked(loadMeta).mockResolvedValue({ indexedAt: '2023-01-01' } as any);
  });

  it('successfully exports a community evidence pack', async () => {
    const mockResult = {
      status: 'success',
      communityId: 'c1',
      symbols: [],
      processes: [],
      concepts: [],
      citationDensity: 0,
      emptyResult: true,
      truncationState: { symbols: false, processes: false, concepts: false },
    };
    vi.mocked(runCommunityEvidencePack).mockResolvedValue(mockResult as any);

    await exportCommunityEvidencePackCommand({ community: 'c1', limit: 25, out: 'out-dir' });

    expect(runCommunityEvidencePack).toHaveBeenCalledWith(
      { id: 'test-root', name: 'test-root' },
      { community_id: 'c1', limit: 25 },
    );
    expect(fs.mkdirSync).toHaveBeenCalled();
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining('community-evidence-pack-c1.json'),
      expect.stringContaining('"emptyResult": true'),
      'utf8',
    );
  });

  it('fails if no index is found', async () => {
    vi.mocked(loadMeta).mockResolvedValue(null as any);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('exit');
    });

    await expect(exportCommunityEvidencePackCommand({})).rejects.toThrow('exit');
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });

  it('fails if backend returns error', async () => {
    vi.mocked(runCommunityEvidencePack).mockResolvedValue({
      status: 'error',
      communityId: 'c1',
      error: 'Backend error',
    } as any);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('exit');
    });

    await expect(exportCommunityEvidencePackCommand({ community: 'c1' })).rejects.toThrow('exit');
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });
});
