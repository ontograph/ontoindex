import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import lbug from '@ladybugdb/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runFullAnalysis } from '../../src/core/run-analyze.js';
import { closeLbug } from '../../src/core/lbug/lbug-adapter.js';
import * as pool from '../../src/core/lbug/pool-adapter.js';
import {
  getOverlaySnapshot,
  overlayDbPath,
  overlayRepoId,
  queryOverlay,
  resetOverlaySnapshotCache,
  resolveOverlayDbPath,
} from '../../src/mcp/local/backend-overlay.js';
import { buildTestGraph } from '../helpers/test-graph.js';

describe('immutable overlay generations (real LadybugDB)', () => {
  let root: string;
  let repo: { id: string; repoPath: string; storagePath: string };
  let overlay: string;
  const cypher = 'MATCH (n:Function) RETURN n.name AS name LIMIT 10';
  const current = () => fs.readFile(path.join(overlay, 'CURRENT'), 'utf8');
  const directories = async () =>
    (await fs.readdir(overlay, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();

  async function build(name: string, fail = false, onLog = vi.fn()) {
    const analyzeRepo = vi.fn(async () => ({
      graph: buildTestGraph([
        { id: 'File:source.ts', label: 'File', name: 'source.ts', filePath: 'source.ts' },
        { id: `Function:${name}`, label: 'Function', name, filePath: 'source.ts' },
      ]),
      repoPath: root,
      totalFileCount: 1,
      usedWorkerPool: false,
    }));
    const result = await runFullAnalysis(
      root,
      { dirtyOverlay: true, overlayPaths: ['source.ts'] },
      {
        onLog,
        onProgress: (phase, _percent, message) => {
          if (fail && phase === 'lbug' && message.startsWith('Loaded nodes')) {
            throw new Error('injected generation load failure');
          }
        },
      },
      { analyzeRuntime: { analyzeRepo } },
    );
    expect(analyzeRepo).toHaveBeenCalledWith(
      expect.objectContaining({ options: { profile: 'symbols', includePaths: ['source.ts'] } }),
    );
    expect(result.stats.embeddings).toBe(0);
    return result;
  }

  beforeEach(async () => {
    // Exercise real native readers without reserving the pool's default 8-TiB
    // mapping for every fixture generation. Production adapters stay unchanged.
    const Database = lbug.Database;
    vi.spyOn(lbug, 'Database').mockImplementation(function (
      dbPath?: string,
      bufferSize?: number,
      compression?: boolean,
      readOnly?: boolean,
      maxDBSize?: number,
    ) {
      return new Database(dbPath, bufferSize, compression, readOnly, maxDBSize ?? 2 ** 32);
    });
    resetOverlaySnapshotCache();
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'overlay-generations-'));
    repo = { id: root, repoPath: root, storagePath: path.join(root, '.ontoindex') };
    overlay = path.join(repo.storagePath, 'overlay');
    for (const args of [
      ['init', '-q'],
      ['config', 'user.name', 'test'],
      ['config', 'user.email', 'test@example.com'],
    ]) {
      expect(spawnSync('git', args, { cwd: root, encoding: 'utf8' }).status).toBe(0);
    }
    await fs.writeFile(path.join(root, 'source.ts'), 'export function baseline() {}\n');
    for (const args of [
      ['add', 'source.ts'],
      ['commit', '-qm', 'baseline'],
    ]) {
      expect(spawnSync('git', args, { cwd: root, encoding: 'utf8' }).status).toBe(0);
    }
    await fs.writeFile(path.join(root, 'source.ts'), 'export function dirtySymbol() {}\n');
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    resetOverlaySnapshotCache();
    await pool.closeLbug(overlayRepoId(repo.id));
    await closeLbug();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('publishes gen2 while gen1 has a live reader, then switches serialized reads', async () => {
    await build('gen1');
    const first = await resolveOverlayDbPath(repo.storagePath);
    expect(first).toBe(overlayDbPath(repo.storagePath));
    expect(await queryOverlay(repo, cypher)).toEqual([{ name: 'gen1' }]);
    expect(pool.isLbugReady(overlayRepoId(repo.id))).toBe(true);
    const bytes = await fs.readFile(first!);
    await expect(getOverlaySnapshot(repo)).resolves.toMatchObject({ usable: true });

    await build('gen2');
    expect(pool.isLbugReady(overlayRepoId(repo.id))).toBe(true);
    // The still-open handle remains usable until queryOverlay switches it.
    expect(await pool.executeParameterized(overlayRepoId(repo.id), cypher, {})).toEqual([
      { name: 'gen1' },
    ]);
    expect(await fs.readFile(first!)).toEqual(bytes);
    expect(await resolveOverlayDbPath(repo.storagePath)).not.toBe(first);
    const close = vi.spyOn(pool, 'closeLbug');
    expect(await Promise.all(Array.from({ length: 10 }, () => queryOverlay(repo, cypher)))).toEqual(
      Array.from({ length: 10 }, () => [{ name: 'gen2' }]),
    );
    expect(close).toHaveBeenCalledExactlyOnceWith(overlayRepoId(repo.id));
  });

  it('removes only a failed build and leaves CURRENT, gen1 bytes and its reader untouched', async () => {
    await build('gen1');
    await queryOverlay(repo, cypher);
    const published = await current();
    const dbPath = (await resolveOverlayDbPath(repo.storagePath))!;
    const bytes = await fs.readFile(dbPath);
    const before = await fs.readdir(overlay);
    await expect(build('failed', true)).rejects.toThrow('injected generation load failure');
    expect(await current()).toBe(published);
    expect(await fs.readFile(dbPath)).toEqual(bytes);
    expect(await fs.readdir(overlay)).toEqual(before);
    expect(await queryOverlay(repo, cypher)).toEqual([{ name: 'gen1' }]);
  });

  it('leaves the published generation untouched when CURRENT rename fails', async () => {
    await build('gen1');
    const published = await current();
    const before = await fs.readdir(overlay);
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('injected publication failure'));
    await expect(build('failedPublish')).rejects.toThrow('injected publication failure');
    expect(await current()).toBe(published);
    expect(await fs.readdir(overlay)).toEqual(before);
    expect(await queryOverlay(repo, cypher)).toEqual([{ name: 'gen1' }]);
  });

  it('keeps CURRENT and the two newest generations, tolerating locked old stores', async () => {
    await build('gen1');
    const firstId = (await current()).trim();
    const lockedId = '1-1-locked';
    // Future mtimes: the real gen1 directory may be touched by the store after build.
    const future = Math.floor(Date.now() / 1000) + 100_000;
    for (const [id, seconds] of [
      [firstId, 1],
      [lockedId, 2],
      ['3-1-old', 3],
      ['4-1-new', future + 1],
      ['5-1-newer', future + 2],
    ] as const) {
      const dir = path.join(overlay, id);
      await fs.mkdir(dir, { recursive: true });
      await fs.utimes(dir, seconds, seconds);
    }
    const rm = fs.rm.bind(fs);
    const remove = vi.spyOn(fs, 'rm').mockImplementation(async (target, options) => {
      if (target === path.join(overlay, lockedId)) {
        throw Object.assign(new Error('locked a portion of the file'), { code: 'EPERM' });
      }
      return rm(target, options);
    });
    const onLog = vi.fn();
    await expect(build('gen2', false, onLog)).resolves.toBeDefined();
    const secondId = (await current()).trim();
    expect(await directories()).toEqual([lockedId, '4-1-new', '5-1-newer', secondId].sort());
    expect(onLog).toHaveBeenCalledTimes(1);
    expect(await queryOverlay(repo, cypher)).toEqual([{ name: 'gen2' }]);
    remove.mockRestore();
    await build('gen3');
    expect(await directories()).toHaveLength(3);
    expect(await queryOverlay(repo, cypher)).toEqual([{ name: 'gen3' }]);
  });

  it.each(['', '../outside', '/absolute', 'one/two', '..', 'gen\nother', 'missing-generation'])(
    'treats invalid or missing CURRENT target %j as no overlay without throwing',
    async (value) => {
      await build('gen1');
      await queryOverlay(repo, cypher);
      await fs.writeFile(path.join(overlay, 'CURRENT'), value);
      resetOverlaySnapshotCache();
      await expect(getOverlaySnapshot(repo)).resolves.toMatchObject({
        usable: false,
        reason: expect.stringContaining('CURRENT'),
      });
      await expect(queryOverlay(repo, cypher)).resolves.toEqual([]);
      expect(pool.isLbugReady(overlayRepoId(repo.id))).toBe(false);
    },
  );

  it('ignores missing/unreadable CURRENT and the legacy layout, then replaces it best-effort', async () => {
    await fs.mkdir(overlay, { recursive: true });
    await fs.writeFile(path.join(overlay, 'lbug'), 'legacy');
    await expect(resolveOverlayDbPath(repo.storagePath)).resolves.toBeNull();
    await expect(getOverlaySnapshot(repo)).resolves.toMatchObject({ usable: false });
    await expect(queryOverlay(repo, cypher)).resolves.toEqual([]);
    await fs.mkdir(path.join(overlay, 'CURRENT'));
    resetOverlaySnapshotCache();
    await expect(getOverlaySnapshot(repo)).resolves.toMatchObject({ usable: false });
    await expect(queryOverlay(repo, cypher)).resolves.toEqual([]);
    await fs.rmdir(path.join(overlay, 'CURRENT'));
    await build('modern');
    await expect(fs.stat(path.join(overlay, 'lbug'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await queryOverlay(repo, cypher)).toEqual([{ name: 'modern' }]);
  });
});
