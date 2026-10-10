import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import lbug from '@ladybugdb/core';
import { describe, expect, it, vi } from 'vitest';
import { runFullAnalysis } from '../../src/core/run-analyze.js';
import { runPipelineFromRepo } from '../../src/core/ingestion/pipeline.js';
import {
  closeLbug,
  executeQuery,
  getLbugStats,
  initLbug,
  loadGraphToLbug,
} from '../../src/core/lbug/lbug-adapter.js';
import * as repoManager from '../../src/storage/repo-manager.js';
import { buildTestGraph } from '../helpers/test-graph.js';

describe('disposable dirty overlay build', () => {
  it('isolates dirty symbols, preserves the active generation, and removes a failed partial store', async () => {
    const repoPath = await fs.mkdtemp(path.join(os.tmpdir(), 'ontoindex-overlay-build-'));
    const { storagePath, metaPath } = repoManager.getStoragePaths(repoPath);
    const overlayPath = path.join(storagePath, 'overlay');
    try {
      await fs.mkdir(path.join(repoPath, 'src'));
      await fs.writeFile(
        path.join(repoPath, 'src/dirty.ts'),
        'export function dirtyNow() { return 2; }\n',
      );
      await fs.writeFile(
        path.join(repoPath, 'src/clean.ts'),
        'export function cleanOnly() { return 1; }\n',
      );
      const generation = await repoManager.createIndexGeneration(storagePath, 'baseline');
      const graph = buildTestGraph(
        [
          { id: 'File:src/dirty.ts', label: 'File', name: 'dirty.ts', filePath: 'src/dirty.ts' },
          { id: 'File:src/clean.ts', label: 'File', name: 'clean.ts', filePath: 'src/clean.ts' },
          {
            id: 'Function:src/dirty.ts:dirtyBefore',
            label: 'Function',
            name: 'dirtyBefore',
            filePath: 'src/dirty.ts',
          },
          {
            id: 'Function:src/clean.ts:cleanOnly',
            label: 'Function',
            name: 'cleanOnly',
            filePath: 'src/clean.ts',
          },
        ],
        [
          {
            sourceId: 'File:src/dirty.ts',
            targetId: 'Function:src/dirty.ts:dirtyBefore',
            type: 'CONTAINS',
          },
          {
            sourceId: 'File:src/clean.ts',
            targetId: 'Function:src/clean.ts:cleanOnly',
            type: 'CONTAINS',
          },
        ],
      );
      await initLbug(generation.lbugPath);
      await loadGraphToLbug(graph, repoPath, generation.generationPath);
      expect(await getLbugStats()).toEqual({ nodes: 4, edges: 2 });
      await closeLbug();
      await fs.writeFile(generation.metaPath, '{ "baseline": true, "nodes": 4, "edges": 2 }\n');
      const active = await repoManager.activateIndexGeneration(storagePath, generation);

      const snapshotActive = async () => {
        // The production adapter initializes schema on open. Verification must
        // not itself rewrite the active database's catalog or checkpoints.
        const db = new lbug.Database(active.lbugPath, 0, true, true);
        const conn = new lbug.Connection(db);
        let counts: { nodes: number; edges: number };
        try {
          const nodeResult = await conn.query('MATCH (n) RETURN count(n) AS count');
          const edgeResult = await conn.query('MATCH ()-[r]->() RETURN count(r) AS count');
          counts = {
            nodes: Number((await nodeResult.getAll())[0].count),
            edges: Number((await edgeResult.getAll())[0].count),
          };
        } finally {
          await conn.close();
          await db.close();
        }
        return {
          generation: await repoManager.resolveActiveIndexGeneration(storagePath),
          current: await fs.readlink(path.join(storagePath, 'current')),
          meta: await fs.readFile(metaPath),
          database: createHash('sha256')
            .update(await fs.readFile(active.lbugPath))
            .digest('hex'),
          counts,
        };
      };
      const before = await snapshotActive();
      const activate = vi.spyOn(repoManager, 'activateIndexGeneration');
      const create = vi.spyOn(repoManager, 'createIndexGeneration');
      const saveMeta = vi.spyOn(repoManager, 'saveMeta');
      const analyzeRepo = vi.fn(({ repoPath: root, onProgress, options }) =>
        runPipelineFromRepo(root, onProgress, { ...options, skipWorkers: true }),
      );
      const dependencies = { analyzeRuntime: { analyzeRepo } };
      const options = {
        dirtyOverlay: true,
        overlayPaths: ['src/dirty.ts'],
        embeddings: true,
        annNeighbors: true,
        markdownSidecar: true,
        skipNativeClose: true,
      };
      const result = await runFullAnalysis(
        repoPath,
        options,
        { onProgress: () => {} },
        dependencies,
      );
      expect(analyzeRepo).toHaveBeenCalledWith(
        expect.objectContaining({
          options: { profile: 'symbols', includePaths: ['src/dirty.ts'] },
        }),
      );
      expect(result.stats.files).toBe(1);
      expect(result.stats.embeddings).toBe(0);
      expect(result.embeddingLifecycle).toEqual({ mode: 'off', state: 'absent' });
      expect(await snapshotActive()).toEqual(before);
      expect((await fs.stat(path.join(overlayPath, 'lbug'))).isFile()).toBe(true);
      await initLbug(path.join(overlayPath, 'lbug'));
      expect(
        await executeQuery('MATCH (n:Function) RETURN n.name AS name, n.filePath AS filePath'),
      ).toEqual([{ name: 'dirtyNow', filePath: 'src/dirty.ts' }]);
      expect(await executeQuery('MATCH (n:File) RETURN n.filePath AS filePath')).toEqual([
        { filePath: 'src/dirty.ts' },
      ]);
      await closeLbug();
      await expect(fs.stat(path.join(overlayPath, 'meta.json'))).rejects.toMatchObject({
        code: 'ENOENT',
      });

      let failedAfterCopy = false;
      await expect(
        runFullAnalysis(
          repoPath,
          options,
          {
            onProgress: (phase, _percent, message) => {
              if (phase === 'lbug' && message.startsWith('Loaded nodes')) {
                failedAfterCopy = true;
                throw new Error('injected overlay load failure');
              }
            },
          },
          dependencies,
        ),
      ).rejects.toThrow('injected overlay load failure');
      expect(failedAfterCopy).toBe(true);
      await expect(fs.stat(overlayPath)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await snapshotActive()).toEqual(before);

      analyzeRepo.mockClear();
      const empty = await runFullAnalysis(
        repoPath,
        { dirtyOverlay: true, overlayPaths: [] },
        {
          onProgress: () => {},
        },
        dependencies,
      );
      expect(analyzeRepo).not.toHaveBeenCalled();
      expect(empty.stats).toEqual({ nodes: 0, edges: 0, files: 0, embeddings: 0 });
      expect(await snapshotActive()).toEqual(before);
      expect(activate).not.toHaveBeenCalled();
      expect(create).not.toHaveBeenCalled();
      expect(saveMeta).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
      await closeLbug();
      await fs.rm(repoPath, { recursive: true, force: true });
    }
  });

  it('refuses over-limit scope without running the pipeline or creating storage', async () => {
    const repoPath = await fs.mkdtemp(path.join(os.tmpdir(), 'ontoindex-overlay-limit-'));
    const analyzeRepo = vi.fn();
    try {
      await expect(
        runFullAnalysis(
          repoPath,
          {
            dirtyOverlay: true,
            overlayPaths: Array.from({ length: 51 }, (_, index) => `src/file${index}.ts`),
          },
          { onProgress: () => {} },
          { analyzeRuntime: { analyzeRepo } },
        ),
      ).rejects.toThrow('limited to 50');
      expect(analyzeRepo).not.toHaveBeenCalled();
      await expect(
        fs.stat(repoManager.getStoragePaths(repoPath).storagePath),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await fs.rm(repoPath, { recursive: true, force: true });
    }
  });
});
