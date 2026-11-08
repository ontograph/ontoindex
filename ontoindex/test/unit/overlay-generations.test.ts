import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import lbug from '@ladybugdb/core';
import { describe, expect, it, vi } from 'vitest';
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
import {
  acquireOverlayGenerationPin,
  pruneOverlayGenerations,
} from '../../src/storage/repo-manager.js';

describe('overlay reader retention', () => {
  it('retains live pins and removes eligible generations with dead markers', async () => {
    const storage = await fs.mkdtemp(path.join(os.tmpdir(), 'overlay-pins-'));
    const overlay = path.join(storage, 'overlay');
    try {
      for (let index = 1; index <= 5; index++) {
        const dir = path.join(overlay, `${index}-1-abc`);
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(path.join(dir, 'lbug'), 'artifact');
        await fs.utimes(dir, index, index);
      }
      const live = path.join(overlay, '1-1-abc');
      const pin = await acquireOverlayGenerationPin(live);
      await fs.writeFile(path.join(overlay, '2-1-abc', '.reader-2147483647-dead'), '');
      // Pin creation changes mtime; restore chronology for deterministic retention.
      await fs.utimes(live, 1, 1);
      await fs.utimes(path.join(overlay, '2-1-abc'), 2, 2);
      expect(await pruneOverlayGenerations(overlay, '5-1-abc')).toBe(true);
      expect(await fs.stat(live)).toBeDefined();
      await expect(fs.stat(path.join(overlay, '2-1-abc'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
      await pin.release();
      await fs.utimes(live, 1, 1);
      expect(await pruneOverlayGenerations(overlay, '5-1-abc')).toBe(false);
      await expect(fs.stat(live)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await fs.rm(storage, { recursive: true, force: true });
    }
  });
});

function createPhaseRecorder() {
  const started = performance.now();
  let previous = started;
  const trail: string[] = [];
  let lastOperationPhase: string | undefined;
  return {
    markPhase(label: string) {
      const now = performance.now();
      const entry = `${label.replace(/[\r\n]/g, ' ').slice(0, 160)} @${(now - started).toFixed(1)}ms (+${(now - previous).toFixed(1)}ms)`;
      trail.push(entry);
      if (!label.startsWith('cleanup:')) lastOperationPhase = entry;
      if (trail.length > 32) trail.shift();
      previous = now;
    },
    report() {
      return `[overlay-generations] elapsed=${(performance.now() - started).toFixed(1)}ms; lastOperation=${lastOperationPhase}; lastRecorded=${trail.at(-1)}\n${trail.join('\n')}`;
    },
  };
}

it('keeps a deferred phase update local to its owning recorder', async () => {
  const first = createPhaseRecorder();
  let resume!: () => void;
  const deferred = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const lateUpdate = deferred.then(() => first.markPhase('build: late first fixture'));
  first.markPhase('cleanup: complete');
  const second = createPhaseRecorder();
  second.markPhase('build: second fixture');
  second.markPhase('cleanup: complete');
  const secondBefore = second.report().split('; lastOperation=')[1];
  resume();
  await lateUpdate;
  expect(first.report()).toContain('lastOperation=build: late first fixture');
  expect(second.report().split('; lastOperation=')[1]).toBe(secondBefore);
  expect(second.report()).toContain('lastOperation=build: second fixture');
  expect(second.report()).toContain('lastRecorded=cleanup: complete');
  expect(second.report()).not.toContain('late first fixture');
});

describe('immutable overlay generations (real LadybugDB)', () => {
  const cypher = 'MATCH (n:Function) RETURN n.name AS name LIMIT 10';
  async function createFixture(root: string, markPhase: (label: string) => void) {
    markPhase('setup: fixture');
    const repo = { id: root, repoPath: root, storagePath: path.join(root, '.ontoindex') };
    const overlay = path.join(repo.storagePath, 'overlay');
    const current = () => {
      markPhase('read: CURRENT');
      return fs.readFile(path.join(overlay, 'CURRENT'), 'utf8');
    };
    const directories = async () =>
      (await fs.readdir(overlay, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort();
    // Mirrors the literal `generations.slice(3)` in run-analyze.ts (runDirtyOverlayAnalysis pruning).
    const retentionLimit = async () => 3;

    async function build(name: string, fail = false, onLog = vi.fn()) {
      markPhase(`build: ${name}`);
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
          onProgress: (stage, _percent, message) => {
            markPhase(`build ${name}: ${stage}: ${message}`);
            if (fail && stage === 'lbug' && message.startsWith('Loaded nodes')) {
              throw new Error('injected generation load failure');
            }
          },
        },
        { analyzeRuntime: { analyzeRepo } },
      );
      markPhase(`build ${name}: assertions`);
      expect(analyzeRepo).toHaveBeenCalledWith(
        expect.objectContaining({
          options: {
            profile: 'symbols',
            includePaths: ['source.ts'],
            capturedWorkspace: {
              captureRoot: expect.stringContaining('workspace-inputs'),
              canonicalRepoPath: expect.any(String),
            },
          },
        }),
      );
      expect(result.stats.embeddings).toBe(0);
      markPhase(`read: after build ${name}`);
      return result;
    }

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
    markPhase('read: fixture ready');
    return { root, repo, overlay, build, current, directories, retentionLimit };
  }

  const test = it.extend<{ generation: Awaited<ReturnType<typeof createFixture>> }>({
    generation: async ({ onTestFailed, onTestFinished }, use) => {
      const { markPhase, report } = createPhaseRecorder();
      onTestFailed(() => console.error(report()));
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'overlay-generations-'));
      // Completion hooks have Vitest's hook timeout and run before failure reports.
      onTestFinished(async () => {
        markPhase('cleanup: mocks and snapshot cache');
        vi.restoreAllMocks();
        resetOverlaySnapshotCache();
        markPhase('cleanup: overlay reader');
        await pool.closeLbug(overlayRepoId(root));
        markPhase('cleanup: native database');
        await closeLbug();
        markPhase('cleanup: fixture');
        await fs.rm(root, { recursive: true, force: true });
        markPhase('cleanup: complete');
      });
      markPhase('setup: native database');
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
      const fixture = await createFixture(root, markPhase);
      await use(fixture);
    },
  });

  test('publishes gen2 while gen1 has a live reader, then switches serialized reads', async ({
    generation: { build, repo },
  }) => {
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

  test('removes only a failed build and leaves CURRENT, gen1 bytes and its reader untouched', async ({
    generation: { build, repo, current, overlay },
  }) => {
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

  test('leaves the published generation untouched when CURRENT rename fails', async ({
    generation: { build, repo, current, overlay },
  }) => {
    await build('gen1');
    const published = await current();
    const before = await fs.readdir(overlay);
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('injected publication failure'));
    await expect(build('failedPublish')).rejects.toThrow('injected publication failure');
    expect(await current()).toBe(published);
    expect(await fs.readdir(overlay)).toEqual(before);
    expect(await queryOverlay(repo, cypher)).toEqual([{ name: 'gen1' }]);
  });

  test('keeps CURRENT and the two newest generations, tolerating locked old stores', async ({
    generation: { build, repo, current, overlay, directories },
  }) => {
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

  test('bounds retained generations with a simulated OS lock until reader release', async ({
    generation: { build, repo, current, overlay, directories, retentionLimit },
  }) => {
    const retained = await retentionLimit();
    await build('held');
    await queryOverlay(repo, cypher);
    const heldId = (await current()).trim();
    const realRm = fs.rm.bind(fs);
    const blockedRm = vi.spyOn(fs, 'rm').mockImplementation(async (target, options) => {
      if (target === path.join(overlay, heldId)) {
        throw Object.assign(new Error('locked a portion of the file'), { code: 'EPERM' });
      }
      return realRm(target, options);
    });

    let newestId = heldId;
    for (let index = 1; index < 10; index += 1) {
      await build(`retained-${index}`);
      newestId = path.basename(path.dirname((await resolveOverlayDbPath(repo.storagePath))!));
    }
    const heldPath = path.join(overlay, heldId);
    expect((await fs.stat(heldPath)).isDirectory()).toBe(true);
    expect(await pool.executeParameterized(overlayRepoId(repo.id), cypher, {})).toEqual([
      { name: 'held' },
    ]);
    expect(await directories()).toHaveLength(retained + 1);
    expect(newestId).toBe((await current()).trim());
    async function totalBytes(directory: string): Promise<number> {
      const entries = await fs.readdir(directory, { withFileTypes: true });
      const sizes = await Promise.all(
        entries.map(async (entry) => {
          const target = path.join(directory, entry.name);
          return entry.isDirectory() ? totalBytes(target) : (await fs.stat(target)).size;
        }),
      );
      return sizes.reduce((sum, size) => sum + size, 0);
    }
    const retainedBytes = (
      await Promise.all((await directories()).map((name) => totalBytes(path.join(overlay, name))))
    ).reduce((sum, size) => sum + size, 0);
    expect(retainedBytes).toBeGreaterThan(0);
    expect(Number.isFinite(retainedBytes)).toBe(true);

    blockedRm.mockRestore();
    await queryOverlay(repo, cypher);
    await build('after-release');
    await expect(fs.stat(heldPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await directories()).toHaveLength(retained);
    expect((await current()).trim()).not.toBe(heldId);
  });

  test.for(['', '../outside', '/absolute', 'one/two', '..', 'gen\nother', 'missing-generation'])(
    'rejects queries for invalid or missing CURRENT target %j and closes stale handles',
    async (value, { generation: { build, repo, overlay } }) => {
      await build('gen1');
      await queryOverlay(repo, cypher);
      await fs.writeFile(path.join(overlay, 'CURRENT'), value);
      resetOverlaySnapshotCache();
      await expect(getOverlaySnapshot(repo)).resolves.toMatchObject({
        usable: false,
        reason: expect.stringContaining('CURRENT'),
      });
      await expect(queryOverlay(repo, cypher)).rejects.toThrow('no published overlay');
      expect(pool.isLbugReady(overlayRepoId(repo.id))).toBe(false);
    },
  );

  test('ignores missing/unreadable CURRENT and the legacy layout, then replaces it best-effort', async ({
    generation: { build, repo, overlay },
  }) => {
    await fs.mkdir(overlay, { recursive: true });
    await fs.writeFile(path.join(overlay, 'lbug'), 'legacy');
    await expect(resolveOverlayDbPath(repo.storagePath)).resolves.toBeNull();
    await expect(getOverlaySnapshot(repo)).resolves.toMatchObject({ usable: false });
    await expect(queryOverlay(repo, cypher)).rejects.toThrow('no published overlay');
    await fs.mkdir(path.join(overlay, 'CURRENT'));
    resetOverlaySnapshotCache();
    await expect(getOverlaySnapshot(repo)).resolves.toMatchObject({ usable: false });
    await expect(queryOverlay(repo, cypher)).rejects.toThrow('no published overlay');
    await fs.rmdir(path.join(overlay, 'CURRENT'));
    await build('modern');
    await expect(fs.stat(path.join(overlay, 'lbug'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await queryOverlay(repo, cypher)).toEqual([{ name: 'modern' }]);
  });
});
