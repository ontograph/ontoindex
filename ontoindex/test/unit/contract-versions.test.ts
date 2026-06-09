import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CURRENT_CONTRACT } from '../../src/core/contract/versions.js';
import { saveMeta, RepoMeta } from '../../src/storage/repo-manager.js';
import fs from 'fs/promises';
import path from 'path';

vi.mock('fs/promises');

describe('Contract Versions', () => {
  it('defines CURRENT_CONTRACT with version 1 for all components', () => {
    expect(CURRENT_CONTRACT.graph_schema).toBe(1);
    expect(CURRENT_CONTRACT.meta_json).toBe(1);
    expect(CURRENT_CONTRACT.mcp_tools).toBe(1);
    expect(CURRENT_CONTRACT.web_api).toBe(1);
  });

  describe('saveMeta', () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it('includes CURRENT_CONTRACT in the written meta.json', async () => {
      const storagePath = '/fake/storage';
      const meta: RepoMeta = {
        repoPath: '/fake/repo',
        lastCommit: 'abc',
        indexedAt: '2026-04-19T00:00:00.000Z',
        stats: { files: 10 },
      };

      await saveMeta(storagePath, meta);

      expect(fs.mkdir).toHaveBeenCalledWith(storagePath, { recursive: true });

      const metaPath = path.join(storagePath, 'meta.json');
      const writeFileCall = vi.mocked(fs.writeFile).mock.calls.find((call) => call[0] === metaPath);

      expect(writeFileCall).toBeDefined();
      const writtenContent = JSON.parse(writeFileCall![1] as string);

      expect(writtenContent.contract).toEqual(CURRENT_CONTRACT);
      expect(writtenContent.repoPath).toBe('.');
    });
  });
});
