import fs from 'node:fs/promises';
import { readFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { runFullAnalysis } from '../../src/core/run-analyze.js';
import { runPipelineFromRepo } from '../../src/core/ingestion/pipeline.js';
import { closeLbug, initLbug, loadGraphToLbug } from '../../src/core/lbug/lbug-adapter.js';
import * as repoManager from '../../src/storage/repo-manager.js';
import { buildTestGraph } from '../helpers/test-graph.js';

describe('dirty overlay publication rollback', () => {
  it('preserves the published generation after a late failure and allows a retry', async () => {
    const repoPath = await fs.mkdtemp(path.join(os.tmpdir(), 'ontoindex-overlay-late-failure-'));
    const { storagePath } = repoManager.getStoragePaths(repoPath);
    const overlayPath = path.join(storagePath, 'overlay');
    const currentPath = path.join(overlayPath, 'CURRENT');
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
      const dependencies = { analyzeRuntime: { analyzeRepo } };
      const options = { dirtyOverlay: true, overlayPaths: ['src/dirty.ts'] };
      const snapshotPublished = async () => {
        const current = await fs.readFile(currentPath);
        const generationId = current.toString('utf8').trim();
        return {
          current,
          generationId,
          database: await fs.readFile(path.join(overlayPath, generationId, 'lbug')),
          base: await fs.readFile(path.join(overlayPath, generationId, 'base.json')),
          entries: (await fs.readdir(overlayPath)).sort(),
        };
      };

      // Publish a baseline and retain its exact bytes without opening the database.
      const baseline = await runFullAnalysis(
        repoPath,
        options,
        { onProgress: () => {} },
        dependencies,
      );
      expect(baseline.stats.files).toBe(1);
      const before = await snapshotPublished();
      expect(before.entries).toEqual([before.generationId, 'CURRENT'].sort());
      expect(await fs.readdir(path.join(storagePath, 'workspace-inputs'))).toEqual([]);

      // Fail only after the replacement's base.json exists, before CURRENT publication.
      const injectedError = new Error('injected late overlay publication failure');
      let failedGenerationId: string | undefined;
      await expect(
        runFullAnalysis(
          repoPath,
          options,
          {
            onProgress: (phase) => {
              if (phase !== 'done') return;
              const replacementEntries = readdirSync(overlayPath).filter(
                (entry) => !before.entries.includes(entry),
              );
              expect(replacementEntries).toHaveLength(1);
              failedGenerationId = replacementEntries[0]!;
              const base = JSON.parse(
                readFileSync(path.join(overlayPath, failedGenerationId, 'base.json'), 'utf8'),
              );
              expect(base.databaseDigest.sha256).toMatch(/^[0-9a-f]{64}$/);
              throw injectedError;
            },
          },
          dependencies,
        ),
      ).rejects.toBe(injectedError);
      expect(failedGenerationId).toBeDefined();
      expect(await snapshotPublished()).toEqual(before);
      expect(await fs.readdir(path.join(storagePath, 'workspace-inputs'))).toEqual([]);

      // A retry on the same repository must publish a new, correctly digested database.
      const recovered = await runFullAnalysis(
        repoPath,
        options,
        { onProgress: () => {} },
        dependencies,
      );
      expect(recovered.stats.files).toBe(1);
      const after = await snapshotPublished();
      expect(after.generationId).not.toBe(before.generationId);
      expect(after.generationId).not.toBe(failedGenerationId);
      expect(JSON.parse(after.base.toString('utf8')).databaseDigest).toEqual({
        sha256: createHash('sha256').update(after.database).digest('hex'),
        size: after.database.byteLength,
      });
      expect(await fs.readdir(path.join(storagePath, 'workspace-inputs'))).toEqual([]);

      // A killed process leaves an unpublished temp pointer and a half-written generation.
      const orphanId = '9999999999999-1-deadbeef';
      await fs.mkdir(path.join(overlayPath, orphanId));
      await fs.writeFile(path.join(overlayPath, orphanId, 'lbug'), 'truncated');
      await fs.writeFile(
        path.join(overlayPath, `.CURRENT-${orphanId}.tmp`),
        `${orphanId}
`,
      );
      expect((await snapshotPublished()).current).toEqual(after.current);

      const afterKill = await runFullAnalysis(
        repoPath,
        options,
        { onProgress: () => {} },
        dependencies,
      );
      expect(afterKill.stats.files).toBe(1);
      const final = await snapshotPublished();
      expect(final.generationId).not.toBe(after.generationId);
      expect(final.generationId).not.toBe(orphanId);
      expect(JSON.parse(final.base.toString('utf8')).databaseDigest).toEqual({
        sha256: createHash('sha256').update(final.database).digest('hex'),
        size: final.database.byteLength,
      });
    } finally {
      await closeLbug();
      await fs.rm(repoPath, { recursive: true, force: true });
    }
  }, 120_000);
});
