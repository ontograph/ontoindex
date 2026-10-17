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
  getLbugStats,
  initLbug,
  loadGraphToLbug,
} from '../../src/core/lbug/lbug-adapter.js';
import * as repoManager from '../../src/storage/repo-manager.js';
import { buildTestGraph } from '../helpers/test-graph.js';
import { resolveOverlayDbPath } from '../../src/mcp/local/backend-overlay.js';

describe('disposable dirty overlay build', () => {
  it('refuses an over-budget pinned overlay before capture or build', async () => {
    const repoPath = await fs.mkdtemp(path.join(os.tmpdir(), 'ontoindex-overlay-budget-'));
    const overlay = path.join(repoManager.getStoragePaths(repoPath).storagePath, 'overlay');
    const generation = path.join(overlay, '1-1-abc');
    const previous = process.env.ONTOINDEX_OVERLAY_BUDGET_BYTES;
    const analyzeRepo = vi.fn();
    try {
      await fs.mkdir(generation, { recursive: true });
      await fs.writeFile(path.join(generation, 'lbug'), 'over-budget');
      await fs.writeFile(path.join(generation, `.reader-${process.pid}-live`), '');
      process.env.ONTOINDEX_OVERLAY_BUDGET_BYTES = '1';
      await expect(
        runFullAnalysis(
          repoPath,
          { dirtyOverlay: true, overlayPaths: [] },
          { onProgress: () => {} },
          { analyzeRuntime: { analyzeRepo } },
        ),
      ).rejects.toMatchObject({ code: 'overlay_budget_exceeded' });
      expect(analyzeRepo).not.toHaveBeenCalled();
      expect(await fs.readdir(overlay)).toEqual(['1-1-abc']);
      expect(await fs.readdir(repoPath)).toEqual(['.ontoindex']);
    } finally {
      if (previous === undefined) delete process.env.ONTOINDEX_OVERLAY_BUDGET_BYTES;
      else process.env.ONTOINDEX_OVERLAY_BUDGET_BYTES = previous;
      await fs.rm(repoPath, { recursive: true, force: true });
    }
  });

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
      // Bound fixture mappings too, not just the production overlay (RT-9).
      await initLbug(generation.lbugPath, { maxDBSize: 2 ** 32 });
      try {
        await loadGraphToLbug(graph, repoPath, generation.generationPath);
        expect(await getLbugStats()).toEqual({ nodes: 4, edges: 2 });
      } finally {
        await closeLbug();
      }
      await fs.writeFile(generation.metaPath, '{ "baseline": true, "nodes": 4, "edges": 2 }\n');
      const active = await repoManager.activateIndexGeneration(storagePath, generation);

      const snapshotActive = async () => {
        // The production adapter initializes schema on open. Verification must
        // not itself rewrite the active database's catalog or checkpoints.
        const db = new lbug.Database(active.lbugPath, 0, true, true, 2 ** 32);
        const conn = new lbug.Connection(db);
        const results: lbug.QueryResult[] = [];
        let counts: { nodes: number; edges: number };
        try {
          const nodeQuery = await conn.query('MATCH (n) RETURN count(n) AS count');
          results.push(...(Array.isArray(nodeQuery) ? nodeQuery : [nodeQuery]));
          const nodeResult = results[0];
          const edgeQuery = await conn.query('MATCH ()-[r]->() RETURN count(r) AS count');
          const edgeResults = Array.isArray(edgeQuery) ? edgeQuery : [edgeQuery];
          results.push(...edgeResults);
          const edgeResult = edgeResults[0];
          counts = {
            nodes: Number((await nodeResult.getAll())[0].count),
            edges: Number((await edgeResult.getAll())[0].count),
          };
        } finally {
          try {
            for (const result of results) result.close();
          } finally {
            try {
              await conn.close();
            } finally {
              await db.close();
            }
          }
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
          options: {
            profile: 'symbols',
            includePaths: ['src/dirty.ts'],
            capturedWorkspace: {
              captureRoot: expect.stringContaining('workspace-inputs'),
              canonicalRepoPath: await fs.realpath(repoPath),
            },
          },
        }),
      );
      // The capture is disposed after publication.
      expect(await fs.readdir(path.join(storagePath, 'workspace-inputs'))).toEqual([]);
      expect(result.stats.files).toBe(1);
      expect(result.stats.embeddings).toBe(0);
      expect(result.embeddingLifecycle).toEqual({ mode: 'off', state: 'absent' });
      expect(await snapshotActive()).toEqual(before);
      const overlayDbPath = await resolveOverlayDbPath(storagePath);
      expect(overlayDbPath).not.toBeNull();
      expect((await fs.stat(overlayDbPath!)).isFile()).toBe(true);
      expect(
        JSON.parse(await fs.readFile(path.join(path.dirname(overlayDbPath!), 'base.json'), 'utf8')),
      ).toEqual({
        baseGenerationId: generation.generationId,
        baseCommit: null,
        manifestDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
        configurationDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
        parserIdentity: expect.any(String),
        includePaths: ['src/dirty.ts'],
        inputs: {
          'src/dirty.ts': createHash('sha256')
            .update('export function dirtyNow() { return 2; }\n')
            .digest('hex'),
        },
      });
      const overlayCurrent = await fs.readFile(path.join(overlayPath, 'CURRENT'));
      const overlayBefore = await fs.readFile(overlayDbPath!);
      // Verify the immutable publication read-only, without writable catalog
      // initialization or deferred native checkpoints changing its bytes.
      const overlayDb = new lbug.Database(overlayDbPath!, 0, true, true, 2 ** 32);
      const overlayConn = new lbug.Connection(overlayDb);
      try {
        for (const [query, expected] of [
          [
            'MATCH (n:Function) RETURN n.name AS name, n.filePath AS filePath',
            [{ name: 'dirtyNow', filePath: 'src/dirty.ts' }],
          ],
          ['MATCH (n:File) RETURN n.filePath AS filePath', [{ filePath: 'src/dirty.ts' }]],
        ] as const) {
          const result = await overlayConn.query(query);
          const results = Array.isArray(result) ? result : [result];
          try {
            expect(await results[0].getAll()).toEqual(expected);
          } finally {
            for (const rowset of results) rowset.close();
          }
        }
      } finally {
        try {
          await overlayConn.close();
        } finally {
          await overlayDb.close();
        }
      }
      await expect(
        fs.stat(path.join(path.dirname(overlayDbPath!), 'meta.json')),
      ).rejects.toMatchObject({
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
      expect(await fs.readFile(path.join(overlayPath, 'CURRENT'))).toEqual(overlayCurrent);
      expect(await fs.readFile(overlayDbPath!)).toEqual(overlayBefore);
      expect((await fs.readdir(overlayPath)).sort()).toEqual(
        [path.basename(path.dirname(overlayDbPath!)), 'CURRENT'].sort(),
      );
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
