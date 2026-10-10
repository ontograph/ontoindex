import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  getOverlaySnapshot,
  isDirtyPath,
  overlayDbPath,
  overlayRepoId,
  resetOverlaySnapshotCache,
} from '../../src/mcp/local/backend-overlay.js';

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
