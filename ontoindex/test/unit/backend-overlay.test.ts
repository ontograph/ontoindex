import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import lbug from '@ladybugdb/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { planDirtyOverlay } from '../../src/core/analyze-delta.js';
import * as pool from '../../src/core/lbug/pool-adapter.js';
import {
  getOverlaySnapshot,
  isDirtyPath,
  overlayDbPath,
  overlayRepoId,
  queryOverlay,
  resetOverlaySnapshotCache,
} from '../../src/mcp/local/backend-overlay.js';

vi.mock('../../src/core/analyze-delta.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/core/analyze-delta.js')>();
  return { ...original, planDirtyOverlay: vi.fn(original.planDirtyOverlay) };
});

const git = (cwd: string, ...args: string[]) =>
  expect(spawnSync('git', args, { cwd, encoding: 'utf8' }).status).toBe(0);

describe('backend-overlay snapshot', () => {
  let repo: string;
  let storage: string;
  const handle = () => ({ id: 'r', repoPath: repo, storagePath: storage });

  beforeEach(() => {
    resetOverlaySnapshotCache();
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ovl-'));
    storage = path.join(repo, '.ontoindex');
    git(repo, 'init', '-q');
    git(repo, 'config', 'user.name', 't');
    git(repo, 'config', 'user.email', 't@t');
    fs.mkdirSync(path.join(repo, 'src'));
    fs.writeFileSync(path.join(repo, 'src/a.ts'), 'export const a = 1;\n');
    fs.writeFileSync(path.join(repo, 'src/gone.ts'), 'export const g = 1;\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'base');
  });
  afterEach(() => fs.rmSync(repo, { recursive: true, force: true }));

  it('is unusable and empty on a clean tree', async () => {
    const s = await getOverlaySnapshot(handle());
    expect(s.usable).toBe(false);
    expect(s.dirtyPaths.size).toBe(0);
  });

  it('reports dirty paths but is unusable when no overlay was built', async () => {
    fs.writeFileSync(path.join(repo, 'src/a.ts'), 'export const a = 2;\n');
    const s = await getOverlaySnapshot(handle());
    expect(s.usable).toBe(false);
    expect(s.reason).toContain('--dirty-overlay');
    expect(isDirtyPath(s, 'src/a.ts')).toBe(true);
    expect(isDirtyPath(s, 'src\\a.ts')).toBe(true);
    expect(isDirtyPath(s, 'src/other.ts')).toBe(false);
  });

  it('is usable when the overlay is newer than every dirty file, and tombstones deletions', async () => {
    fs.writeFileSync(path.join(repo, 'src/a.ts'), 'export const a = 2;\n');
    fs.rmSync(path.join(repo, 'src/gone.ts'));
    fs.mkdirSync(path.dirname(overlayDbPath(storage)), { recursive: true });
    fs.writeFileSync(overlayDbPath(storage), 'x');
    const future = new Date(Date.now() + 5_000);
    fs.utimesSync(overlayDbPath(storage), future, future);
    const s = await getOverlaySnapshot(handle());
    expect(s.usable).toBe(true);
    expect([...s.overlayPaths]).toEqual(['src/a.ts']);
    expect([...s.tombstones]).toEqual(['src/gone.ts']);
  });

  it('becomes unusable when a dirty file is saved after the overlay was built', async () => {
    fs.writeFileSync(path.join(repo, 'src/a.ts'), 'export const a = 2;\n');
    fs.mkdirSync(path.dirname(overlayDbPath(storage)), { recursive: true });
    fs.writeFileSync(overlayDbPath(storage), 'x');
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(overlayDbPath(storage), past, past);
    const s = await getOverlaySnapshot(handle());
    expect(s.usable).toBe(false);
    expect(s.reason).toContain('older than src/a.ts');
  });

  it('uses a distinct pool id', () => {
    expect(overlayRepoId('r')).toBe('r::overlay');
  });
});

describe('backend-overlay snapshot single-flight', () => {
  const repo = { id: 'single-flight', repoPath: '/repo', storagePath: '/repo/.ontoindex' };
  const cleanPlan = { includePaths: [], tombstones: [], tooMany: false, skipped: [] };

  beforeEach(() => {
    resetOverlaySnapshotCache();
    vi.mocked(planDirtyOverlay).mockReset();
  });
  afterEach(() => {
    resetOverlaySnapshotCache();
    vi.mocked(planDirtyOverlay).mockReset();
    vi.restoreAllMocks();
  });

  it('shares one pending git probe across ten concurrent calls and caches success', async () => {
    let finish!: (plan: typeof cleanPlan) => void;
    vi.mocked(planDirtyOverlay).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const calls = Array.from({ length: 10 }, () => getOverlaySnapshot(repo));
    expect(planDirtyOverlay).toHaveBeenCalledExactlyOnceWith(repo.repoPath);
    expect(calls.every((call) => call === calls[0])).toBe(true);
    finish(cleanPlan);
    const snapshots = await Promise.all(calls);
    expect(snapshots.every((snapshot) => snapshot === snapshots[0])).toBe(true);
    expect(getOverlaySnapshot(repo)).toBe(calls[0]);
    expect(planDirtyOverlay).toHaveBeenCalledTimes(1);
  });

  it('keeps the two-second TTL for successful probes', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    vi.mocked(planDirtyOverlay).mockResolvedValue(cleanPlan);
    const first = getOverlaySnapshot(repo);
    await first;
    now.mockReturnValue(2_999);
    expect(getOverlaySnapshot(repo)).toBe(first);
    now.mockReturnValue(3_000);
    const second = getOverlaySnapshot(repo);
    expect(second).not.toBe(first);
    await second;
    expect(planDirtyOverlay).toHaveBeenCalledTimes(2);
  });

  it('evicts a rejected probe immediately while retaining the failure diagnostic', async () => {
    vi.mocked(planDirtyOverlay)
      .mockRejectedValueOnce(new Error('git failed'))
      .mockResolvedValueOnce(cleanPlan);
    const failed = getOverlaySnapshot(repo);
    expect(getOverlaySnapshot(repo)).toBe(failed);
    await expect(failed).resolves.toMatchObject({
      usable: false,
      reason: 'dirty planning failed: git failed',
    });
    await expect(getOverlaySnapshot(repo)).resolves.toMatchObject({
      usable: false,
      reason: 'no dirty files',
    });
    expect(planDirtyOverlay).toHaveBeenCalledTimes(2);
  });

  it('does not let an older failed probe evict a newer cached probe', async () => {
    let fail!: (error: Error) => void;
    vi.mocked(planDirtyOverlay)
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            fail = reject;
          }),
      )
      .mockResolvedValueOnce(cleanPlan);
    const old = getOverlaySnapshot(repo);
    resetOverlaySnapshotCache();
    const current = getOverlaySnapshot(repo);
    await current;
    fail(new Error('late failure'));
    await old;
    expect(getOverlaySnapshot(repo)).toBe(current);
    expect(planDirtyOverlay).toHaveBeenCalledTimes(2);
  });
});

describe('backend-overlay real pool lifecycle', () => {
  let root: string;
  let repo: { id: string; repoPath: string; storagePath: string };
  const cypher = 'MATCH (n:Function) RETURN n.name AS name LIMIT 10';

  // Only a Function table is needed to exercise the real read-only MCP pool.
  async function buildOverlay(name: string): Promise<void> {
    const dbPath = overlayDbPath(repo.storagePath);
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    // Keep repeated fixture builds from reserving the native default 8-TiB mmap.
    const db = new lbug.Database(dbPath, 64 * 1024 * 1024, false, false, 256 * 1024 * 1024);
    const conn = new lbug.Connection(db);
    try {
      await conn.query('CREATE NODE TABLE Function(id STRING, name STRING, PRIMARY KEY(id))');
      const statement = await conn.prepare('CREATE (:Function {id: $id, name: $name})');
      await conn.execute(statement, { id: `Function:${name}`, name });
    } finally {
      await conn.close();
      await db.close();
    }
  }

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ovl-pool-'));
    repo = { id: root, repoPath: root, storagePath: path.join(root, '.ontoindex') };
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await pool.closeLbug(overlayRepoId(repo.id));
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('reopens a rebuilt overlay at the same path and reads only new symbols', async () => {
    await buildOverlay('beforeRebuild');
    const close = vi.spyOn(pool, 'closeLbug');
    await expect(queryOverlay(repo, cypher)).resolves.toEqual([{ name: 'beforeRebuild' }]);
    close.mockClear();
    // Match analyze --dirty-overlay: remove the directory without closing the
    // MCP reader, then build a new store at the exact same path.
    fs.rmSync(path.dirname(overlayDbPath(repo.storagePath)), { recursive: true });
    await buildOverlay('afterRebuild');
    const reads = await Promise.all(Array.from({ length: 10 }, () => queryOverlay(repo, cypher)));
    expect(reads).toEqual(Array.from({ length: 10 }, () => [{ name: 'afterRebuild' }]));
    expect(close).toHaveBeenCalledExactlyOnceWith(overlayRepoId(repo.id));
    close.mockClear();
    await expect(queryOverlay(repo, cypher)).resolves.toEqual([{ name: 'afterRebuild' }]);
    expect(close).not.toHaveBeenCalled();
  });

  it('closes a deleted overlay, rejects the read, and can read a later rebuild', async () => {
    await buildOverlay('beforeDelete');
    await queryOverlay(repo, cypher);
    expect(pool.isLbugReady(overlayRepoId(repo.id))).toBe(true);
    fs.rmSync(path.dirname(overlayDbPath(repo.storagePath)), { recursive: true });
    await expect(queryOverlay(repo, cypher)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(pool.isLbugReady(overlayRepoId(repo.id))).toBe(false);
    expect(fs.existsSync(overlayDbPath(repo.storagePath))).toBe(false);
    await buildOverlay('afterDelete');
    await expect(queryOverlay(repo, cypher)).resolves.toEqual([{ name: 'afterDelete' }]);
  });
});
