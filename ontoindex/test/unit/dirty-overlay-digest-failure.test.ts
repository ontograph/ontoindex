import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { runPipelineFromRepo } from '../../src/core/ingestion/pipeline.js';
import * as databaseDigest from '../../src/core/lbug/database-digest.js';
import { closeLbug, initLbug, loadGraphToLbug } from '../../src/core/lbug/lbug-adapter.js';
import { runFullAnalysis } from '../../src/core/run-analyze.js';
import { resolveOverlayDbPath } from '../../src/mcp/local/backend-overlay.js';
import * as repoManager from '../../src/storage/repo-manager.js';
import { buildTestGraph } from '../helpers/test-graph.js';

describe('dirty overlay database digest publication', () => {
  it('preserves the published generation on digest failure and publishes a final-byte digest on recovery', async () => {
    const repoPath = await fs.mkdtemp(path.join(os.tmpdir(), 'ontoindex-overlay-digest-'));
    const { storagePath } = repoManager.getStoragePaths(repoPath);
    const overlayPath = path.join(storagePath, 'overlay');
    try {
      await fs.mkdir(path.join(repoPath, 'src'));
      await fs.writeFile(
        path.join(repoPath, 'src/dirty.ts'),
        'export function dirtyNow() { return 2; }\n',
      );
      const generation = await repoManager.createIndexGeneration(storagePath, 'baseline');
      const graph = buildTestGraph(
        [
          { id: 'File:src/dirty.ts', label: 'File', name: 'dirty.ts', filePath: 'src/dirty.ts' },
          {
            id: 'Function:src/dirty.ts:dirtyBefore',
            label: 'Function',
            name: 'dirtyBefore',
            filePath: 'src/dirty.ts',
          },
        ],
        [
          {
            sourceId: 'File:src/dirty.ts',
            targetId: 'Function:src/dirty.ts:dirtyBefore',
            type: 'CONTAINS',
          },
        ],
      );
      await initLbug(generation.lbugPath, { maxDBSize: 2 ** 32 });
      try {
        await loadGraphToLbug(graph, repoPath, generation.generationPath);
      } finally {
        await closeLbug();
      }
      await fs.writeFile(generation.metaPath, '{ "baseline": true, "nodes": 2, "edges": 1 }\n');
      await repoManager.activateIndexGeneration(storagePath, generation);

      const analyzeRepo = vi.fn(({ repoPath: root, onProgress, options }) =>
        runPipelineFromRepo(root, onProgress, { ...options, skipWorkers: true }),
      );
      const build = () =>
        runFullAnalysis(
          repoPath,
          { dirtyOverlay: true, overlayPaths: ['src/dirty.ts'] },
          { onProgress: () => {} },
          { analyzeRuntime: { analyzeRepo } },
        );

      await build();
      const publishedDbPath = await resolveOverlayDbPath(storagePath);
      expect(publishedDbPath).not.toBeNull();
      const currentBefore = await fs.readFile(path.join(overlayPath, 'CURRENT'));
      const entriesBefore = (await fs.readdir(overlayPath)).sort();
      const databaseBefore = await fs.readFile(publishedDbPath!);

      const digest = vi
        .spyOn(databaseDigest, 'digestDatabaseFile')
        .mockRejectedValueOnce(new Error('injected digest failure'));
      try {
        await expect(build()).rejects.toThrow('injected digest failure');
        expect(digest).toHaveBeenCalledTimes(1);
        expect(await fs.readFile(path.join(overlayPath, 'CURRENT'))).toEqual(currentBefore);
        expect(await fs.readFile(publishedDbPath!)).toEqual(databaseBefore);
        expect((await fs.readdir(overlayPath)).sort()).toEqual(entriesBefore);
        expect(await fs.readdir(path.join(storagePath, 'workspace-inputs'))).toEqual([]);
      } finally {
        digest.mockRestore();
      }

      await build();
      const recoveredDbPath = await resolveOverlayDbPath(storagePath);
      expect(recoveredDbPath).not.toBeNull();
      expect(recoveredDbPath).not.toBe(publishedDbPath);
      // Read after the build returns to include the native close's final bytes.
      const recoveredBytes = await fs.readFile(recoveredDbPath!);
      const base = JSON.parse(
        await fs.readFile(path.join(path.dirname(recoveredDbPath!), 'base.json'), 'utf8'),
      );
      expect(base.databaseDigest).toEqual({
        sha256: createHash('sha256').update(recoveredBytes).digest('hex'),
        size: recoveredBytes.length,
      });
      expect(await fs.readdir(path.join(storagePath, 'workspace-inputs'))).toEqual([]);
    } finally {
      vi.restoreAllMocks();
      try {
        await closeLbug();
      } finally {
        await fs.rm(repoPath, { recursive: true, force: true });
      }
    }
  });
});
