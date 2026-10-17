import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import lbug from '@ladybugdb/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { planDirtyOverlay, workspaceConfigurationIdentity } from '../../src/core/analyze-delta.js';
import * as pool from '../../src/core/lbug/pool-adapter.js';
import { resolveSymbolCandidates } from '../../src/mcp/local/backend-symbol-resolution.js';
import * as backendOverlay from '../../src/mcp/local/backend-overlay.js';
import {
  getOverlaySnapshot,
  evictOverlayState,
  isDirtyPath,
  isAuthoritativePath,
  overlayDbPath,
  overlayRepoId,
  queryOverlay,
  resetOverlaySnapshotCache,
  withPinnedOverlay,
  type OverlaySnapshot,
} from '../../src/mcp/local/backend-overlay.js';

vi.mock('../../src/core/analyze-delta.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/core/analyze-delta.js')>();
  return {
    ...original,
    planDirtyOverlay: vi.fn(original.planDirtyOverlay),
    workspaceConfigurationIdentity: vi.fn(),
  };
});

const git = (cwd: string, ...args: string[]) =>
  expect(spawnSync('git', args, { cwd, encoding: 'utf8' }).status).toBe(0);

describe('backend-overlay snapshot', () => {
  let repo: string;
  let storage: string;
  const handle = () => ({ id: 'r', repoPath: repo, storagePath: storage });
  const publishFixture = () => {
    fs.mkdirSync(path.join(storage, 'overlay', 'fixture'), { recursive: true });
    fs.writeFileSync(path.join(storage, 'overlay', 'CURRENT'), 'fixture\n');
    fs.writeFileSync(overlayDbPath(storage), 'x');
    fs.writeFileSync(
      path.join(storage, 'overlay', 'fixture', 'base.json'),
      JSON.stringify({
        baseGenerationId: null,
        baseCommit: null,
        manifestDigest: 'f'.repeat(64),
        configurationDigest: 'config',
        parserIdentity: 'parser',
        includePaths: ['src/a.ts'],
        inputs: {
          'src/a.ts': createHash('sha256')
            .update(fs.readFileSync(path.join(repo, 'src/a.ts')))
            .digest('hex'),
        },
      }),
    );
  };

  beforeEach(() => {
    resetOverlaySnapshotCache();
    vi.stubEnv('ONTOINDEX_AUTO_WORKSPACE', '1');
    vi.mocked(workspaceConfigurationIdentity).mockResolvedValue({
      configurationDigest: 'config',
      parserIdentity: 'parser',
    });
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
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    fs.rmSync(repo, { recursive: true, force: true });
  });

  const publishWorkspaceFixture = (coverage = 'complete') => {
    publishFixture();
    const metadataPath = path.join(storage, 'overlay', 'fixture', 'base.json');
    const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
    fs.writeFileSync(
      metadataPath,
      JSON.stringify({
        ...metadata,
        inventory: Object.fromEntries(
          fs
            .readdirSync(path.join(repo, 'src'))
            .filter((name) => name.endsWith('.ts'))
            .map((name) => {
              const rel = `src/${name}`;
              const stat = fs.statSync(path.join(repo, rel));
              return [
                rel,
                [
                  stat.size,
                  stat.mtimeMs,
                  stat.ino,
                  createHash('sha256')
                    .update(fs.readFileSync(path.join(repo, rel)))
                    .digest('hex'),
                ],
              ];
            }),
        ),
        capability: 'workspace-graph',
        coverage,
        dirtyPaths: ['src/a.ts'],
        tombstones: [],
        includePaths: [],
      }),
    );
  };

  it('reuses a complete workspace graph and checks configuration across the full inventory', async () => {
    fs.writeFileSync(path.join(repo, 'src/a.ts'), 'export const a = 2;\n');
    publishWorkspaceFixture();
    expect(await getOverlaySnapshot(handle())).toMatchObject({
      usable: true,
      capability: 'workspace-graph',
      coverage: 'complete',
    });
    expect(workspaceConfigurationIdentity).toHaveBeenLastCalledWith(repo, undefined);
    expect([...(await getOverlaySnapshot(handle())).overlayPaths]).toEqual(['src/a.ts']);
    expect([...(await getOverlaySnapshot(handle())).parseErrorPaths]).toEqual([]);
  });

  it('treats a persisted workspace graph as unusable when the flag is off', async () => {
    fs.writeFileSync(path.join(repo, 'src/a.ts'), 'export const a = 2;\n');
    publishWorkspaceFixture();
    vi.stubEnv('ONTOINDEX_AUTO_WORKSPACE', '0');
    resetOverlaySnapshotCache();
    expect(await getOverlaySnapshot(handle())).toMatchObject({
      usable: false,
      reason: expect.stringContaining('ONTOINDEX_AUTO_WORKSPACE'),
    });
  });

  it('reuses partial coverage while withholding authority for parse-error paths', async () => {
    fs.writeFileSync(path.join(repo, 'src/a.ts'), 'export const a = 2;\n');
    publishWorkspaceFixture('partial');
    const metadataPath = path.join(storage, 'overlay', 'fixture', 'base.json');
    const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
    fs.writeFileSync(
      metadataPath,
      JSON.stringify({ ...metadata, parseErrorFiles: ['src/a.ts'], parseErrorCount: 1 }),
    );
    const snapshot = await getOverlaySnapshot(handle());
    expect(snapshot).toMatchObject({ usable: true, reason: null, coverage: 'partial' });
    expect([...snapshot.parseErrorPaths]).toEqual(['src/a.ts']);
    expect(isAuthoritativePath(snapshot, 'src/a.ts')).toBe(false);
    expect(isAuthoritativePath(snapshot, 'src\\a.ts')).toBe(false);
    expect(isAuthoritativePath(snapshot, 'src/other.ts')).toBe(true);
  });

  it.each([undefined, 'src/a.ts', [1]])(
    'rejects malformed partial parse-error metadata %j',
    async (parseErrorFiles) => {
      fs.writeFileSync(path.join(repo, 'src/a.ts'), 'export const a = 2;\n');
      publishWorkspaceFixture('partial');
      const metadataPath = path.join(storage, 'overlay', 'fixture', 'base.json');
      const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
      fs.writeFileSync(metadataPath, JSON.stringify({ ...metadata, parseErrorFiles }));
      expect(await getOverlaySnapshot(handle())).toMatchObject({
        usable: false,
        reason: 'workspace graph has malformed parse-error metadata',
      });
    },
  );

  it('rejects degraded workspace graph coverage explicitly', async () => {
    fs.writeFileSync(path.join(repo, 'src/a.ts'), 'export const a = 2;\n');
    publishWorkspaceFixture('degraded');
    expect(await getOverlaySnapshot(handle())).toMatchObject({
      usable: false,
      reason: expect.stringContaining('coverage is degraded'),
    });
  });

  it('rechecks workspace graph bytes despite a preserved mtime', async () => {
    fs.writeFileSync(path.join(repo, 'src/a.ts'), 'export const a = 2;\n');
    publishWorkspaceFixture();
    expect((await getOverlaySnapshot(handle())).usable).toBe(true);
    const before = fs.statSync(path.join(repo, 'src/a.ts'));
    fs.writeFileSync(path.join(repo, 'src/a.ts'), 'export const a = 3;\n');
    fs.utimesSync(path.join(repo, 'src/a.ts'), before.atime, before.mtime);
    expect(await getOverlaySnapshot(handle())).toMatchObject({
      usable: false,
      reason: expect.stringContaining('stale for src/a.ts'),
    });
  });

  it.each(['edited', 'added', 'deleted', 'touched', 'missing inventory'] as const)(
    'checks non-dirty inventory: %s',
    async (change) => {
      fs.writeFileSync(path.join(repo, 'src/a.ts'), 'export const a = 2;\n');
      publishWorkspaceFixture();
      git(repo, 'update-index', '--assume-unchanged', 'src/gone.ts');
      if (change === 'edited') fs.appendFileSync(path.join(repo, 'src/gone.ts'), '// changed\n');
      if (change === 'added') {
        fs.writeFileSync(path.join(repo, 'src/hidden.ts'), 'export const hidden = 1;');
        // Hide from the dirty planner, while remaining eligible to the capture walker.
        const plan = await planDirtyOverlay(repo);
        vi.mocked(planDirtyOverlay).mockResolvedValueOnce({
          ...plan,
          allDirtyPaths: ['src/a.ts'],
          includePaths: ['src/a.ts'],
        });
      }
      if (change === 'deleted') fs.unlinkSync(path.join(repo, 'src/gone.ts'));
      if (change === 'touched')
        fs.utimesSync(path.join(repo, 'src/gone.ts'), new Date(), new Date(Date.now() + 5000));
      if (change === 'missing inventory') {
        const metadataPath = path.join(storage, 'overlay', 'fixture', 'base.json');
        const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
        delete metadata.inventory;
        fs.writeFileSync(metadataPath, JSON.stringify(metadata));
      }
      const snapshot = await getOverlaySnapshot(handle());
      expect(snapshot.usable).toBe(change === 'touched');
      if (change === 'edited' || change === 'deleted')
        expect(snapshot.reason).toContain('src/gone.ts');
      if (change === 'added') expect(snapshot.reason).toContain('src/hidden.ts');
      if (change === 'missing inventory') expect(snapshot.reason).toContain('no input inventory');
    },
  );

  it('validates an unchanged 1300-file inventory without content reads', async () => {
    for (let n = 0; n < 1298; n++)
      fs.writeFileSync(path.join(repo, `src/scale${n}.ts`), 'export const value = 1;');
    git(repo, 'add', 'src');
    git(repo, 'commit', '-qm', 'inventory scale');
    fs.writeFileSync(path.join(repo, 'src/a.ts'), 'export const a = 2;\n');
    publishWorkspaceFixture();
    const started = performance.now();
    expect((await getOverlaySnapshot(handle())).usable).toBe(true);
    console.log(`1300-file inventory snapshot: ${(performance.now() - started).toFixed(1)} ms`);
  });

  it('bounds changed input hashes at 200', async () => {
    fs.writeFileSync(path.join(repo, 'src/a.ts'), 'export const a = 2;\n');
    for (let n = 0; n < 201; n++)
      fs.writeFileSync(path.join(repo, `src/file${n}.ts`), 'export const value = 1;');
    git(repo, 'add', 'src');
    git(repo, 'commit', '-qm', 'inventory');
    fs.writeFileSync(path.join(repo, 'src/a.ts'), 'export const a = 3;\n');
    publishWorkspaceFixture();
    for (let n = 0; n < 201; n++)
      fs.utimesSync(path.join(repo, `src/file${n}.ts`), new Date(), new Date(Date.now() + 5000));
    expect(await getOverlaySnapshot(handle())).toMatchObject({
      usable: false,
      reason: expect.stringContaining('too many changed inputs'),
    });
  });

  it('accepts the documented residual when a non-dirty input preserves size, mtime and inode', async () => {
    fs.writeFileSync(path.join(repo, 'src/a.ts'), 'export const a = 2;\n');
    publishWorkspaceFixture();
    git(repo, 'update-index', '--assume-unchanged', 'src/gone.ts');
    const metadataPath = path.join(storage, 'overlay', 'fixture', 'base.json');
    fs.writeFileSync(path.join(repo, 'src/gone.ts'), 'export const g = 2;\n');
    const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
    // Simulate exactly preserved stat identity without platform timestamp rounding.
    // This deliberately accepted residual avoids reading every unchanged file.
    metadata.inventory['src/gone.ts'][1] = fs.statSync(path.join(repo, 'src/gone.ts')).mtimeMs;
    fs.writeFileSync(metadataPath, JSON.stringify(metadata));
    expect((await getOverlaySnapshot(handle())).usable).toBe(true);
  });

  it('rejects a workspace graph when the recorded dirty set differs', async () => {
    fs.writeFileSync(path.join(repo, 'src/a.ts'), 'export const a = 2;\n');
    publishWorkspaceFixture();
    fs.writeFileSync(path.join(repo, 'src/b.ts'), 'export const b = 1;\n');
    expect(await getOverlaySnapshot(handle())).toMatchObject({
      usable: false,
      reason: expect.stringContaining('dirty paths or tombstones differ'),
    });
  });

  it('evicts one repository without dropping another snapshot', async () => {
    const first = getOverlaySnapshot(handle());
    const other = getOverlaySnapshot({ ...handle(), id: 'other' });
    await Promise.all([first, other]);
    evictOverlayState('r');
    const replacement = getOverlaySnapshot(handle());
    expect(replacement).not.toBe(first);
    expect(getOverlaySnapshot({ ...handle(), id: 'other' })).toBe(other);
    await replacement;
  });

  it('caps cached snapshots at 64 repositories', async () => {
    const first = getOverlaySnapshot({ ...handle(), id: 'first' });
    await first;
    await Promise.all(
      Array.from({ length: 64 }, (_, i) => getOverlaySnapshot({ ...handle(), id: `repo-${i}` })),
    );
    const replacement = getOverlaySnapshot({ ...handle(), id: 'first' });
    expect(replacement).not.toBe(first);
    await replacement;
  });

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
    publishFixture();
    const future = new Date(Date.now() + 5_000);
    fs.utimesSync(overlayDbPath(storage), future, future);
    const s = await getOverlaySnapshot(handle());
    expect(s.usable).toBe(true);
    expect([...s.overlayPaths]).toEqual(['src/a.ts']);
    expect([...s.tombstones]).toEqual(['src/gone.ts']);
  });

  it('becomes unusable when a dirty file changes content after the overlay was built', async () => {
    fs.writeFileSync(path.join(repo, 'src/a.ts'), 'export const a = 2;\n');
    publishFixture();
    // Same size, same mtime: only the content digest can notice the edit.
    const before = fs.statSync(path.join(repo, 'src/a.ts'));
    fs.writeFileSync(path.join(repo, 'src/a.ts'), 'export const a = 3;\n');
    fs.utimesSync(path.join(repo, 'src/a.ts'), before.atime, before.mtime);
    const s = await getOverlaySnapshot(handle());
    expect(s.usable).toBe(false);
    expect(s.reason).toContain('stale for src/a.ts');
  });

  it('rejects an overlay recorded without manifest identity', async () => {
    fs.writeFileSync(path.join(repo, 'src/a.ts'), 'export const a = 2;\n');
    publishFixture();
    fs.writeFileSync(
      path.join(storage, 'overlay', 'fixture', 'base.json'),
      JSON.stringify({ baseGenerationId: null, baseCommit: null }),
    );
    expect(await getOverlaySnapshot(handle())).toMatchObject({
      usable: false,
      reason: expect.stringContaining('no manifest identity'),
    });
  });

  it('re-plans and rechecks matching identities on every usable hit within the TTL', async () => {
    fs.writeFileSync(path.join(repo, 'src/a.ts'), 'export const a = 2;\n');
    publishFixture();
    vi.mocked(planDirtyOverlay).mockClear();
    expect((await getOverlaySnapshot(handle())).usable).toBe(true);
    expect((await getOverlaySnapshot(handle())).usable).toBe(true);
    expect(planDirtyOverlay).toHaveBeenCalledTimes(2);
    expect(workspaceConfigurationIdentity).toHaveBeenLastCalledWith(repo, {
      includePaths: ['src/a.ts'],
    });
    const before = fs.statSync(path.join(repo, 'src/a.ts'));
    fs.writeFileSync(path.join(repo, 'src/a.ts'), 'export const a = 3;\n');
    fs.utimesSync(path.join(repo, 'src/a.ts'), before.atime, before.mtime);
    expect(await getOverlaySnapshot(handle())).toMatchObject({
      usable: false,
      reason: expect.stringContaining('stale for src/a.ts'),
    });
  });

  it.each(['configurationDigest', 'parserIdentity'] as const)(
    'rejects changed %s within the TTL',
    async (field) => {
      fs.writeFileSync(path.join(repo, 'src/a.ts'), 'export const a = 2;\n');
      publishFixture();
      expect((await getOverlaySnapshot(handle())).usable).toBe(true);
      vi.mocked(workspaceConfigurationIdentity).mockResolvedValue({
        configurationDigest: 'config',
        parserIdentity: 'parser',
        [field]: 'changed',
      });
      expect(await getOverlaySnapshot(handle())).toMatchObject({
        usable: false,
        reason: expect.stringContaining(
          field === 'configurationDigest'
            ? 'configuration identity changed'
            : 'parser identity changed',
        ),
      });
    },
  );

  it.each(['configurationDigest', 'parserIdentity', 'includePaths'])(
    'rejects missing %s',
    async (field) => {
      fs.writeFileSync(path.join(repo, 'src/a.ts'), 'export const a = 2;\n');
      publishFixture();
      const metadataPath = path.join(storage, 'overlay', 'fixture', 'base.json');
      const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
      delete metadata[field];
      fs.writeFileSync(metadataPath, JSON.stringify(metadata));
      expect((await getOverlaySnapshot(handle())).usable).toBe(false);
    },
  );

  it('does not serve a cached usable snapshot after another file becomes dirty within the TTL', async () => {
    fs.writeFileSync(path.join(repo, 'src/a.ts'), 'export const a = 2;\n');
    publishFixture();
    const first = await getOverlaySnapshot(handle());
    expect(first.usable).toBe(true);
    fs.writeFileSync(path.join(repo, 'src/b.ts'), 'export const b = 1;\n');
    const second = await getOverlaySnapshot(handle());
    expect(second.dirtyPaths.has('src/b.ts')).toBe(true);
    expect(second.usable).toBe(false);
  });

  it('uses a distinct pool id', () => {
    expect(overlayRepoId('r')).toBe('r::overlay');
  });

  it('rejects a legacy overlay without recorded base metadata', async () => {
    fs.writeFileSync(path.join(repo, 'src/a.ts'), 'export const a = 2;\n');
    publishFixture();
    fs.rmSync(path.join(storage, 'overlay', 'fixture', 'base.json'));
    expect(await getOverlaySnapshot(handle())).toMatchObject({
      usable: false,
      reason: 'overlay has no recorded base; rebuild: ontoindex analyze --dirty-overlay',
    });
  });

  it('invalidates a cached matching overlay on the next probe after base activation', async () => {
    fs.writeFileSync(path.join(repo, 'src/a.ts'), 'export const a = 2;\n');
    publishFixture();
    const future = new Date(Date.now() + 5_000);
    fs.utimesSync(overlayDbPath(storage), future, future);
    expect((await getOverlaySnapshot(handle())).usable).toBe(true);
    const generation = path.join(storage, 'generations', 'new-base');
    fs.mkdirSync(generation, { recursive: true });
    fs.writeFileSync(
      path.join(generation, 'meta.json'),
      JSON.stringify({ generationId: 'new-base', lastCommit: 'abcdefgh1234' }),
    );
    fs.symlinkSync(generation, path.join(storage, 'current'));
    expect(await getOverlaySnapshot(handle())).toMatchObject({
      usable: false,
      reason:
        'overlay was built on base legacy/unknown but the active base is new-base/abcdefgh; rebuild: ontoindex analyze --dirty-overlay',
    });
  });

  it('rejects a recorded commit that differs from the active base commit', async () => {
    fs.writeFileSync(path.join(repo, 'src/a.ts'), 'export const a = 2;\n');
    publishFixture();
    fs.writeFileSync(
      path.join(storage, 'overlay', 'fixture', 'base.json'),
      JSON.stringify({
        baseGenerationId: null,
        baseCommit: 'old-commit',
        manifestDigest: 'f'.repeat(64),
        inputs: {},
      }),
    );
    expect(await getOverlaySnapshot(handle())).toMatchObject({
      usable: false,
      reason: expect.stringContaining('old-comm'),
    });
  });

  it('does not resolve base symbols from tombstones when the overlay is unusable', async () => {
    fs.rmSync(path.join(repo, 'src/gone.ts'));
    vi.spyOn(pool, 'executeParameterized').mockResolvedValue([
      {
        id: 'gone-id',
        name: 'gone',
        type: 'Function',
        filePath: 'src\\gone.ts',
        startLine: 1,
        endLine: 2,
      },
    ]);

    const result = await resolveSymbolCandidates(handle(), { name: 'gone' }, {});

    expect(result).toEqual({
      kind: 'not_found',
      warning: 'Deleted source path(s): src/gone.ts',
    });
  });

  it('resolves renamed symbols only from their new path with a usable overlay', async () => {
    vi.spyOn(backendOverlay, 'getOverlaySnapshot').mockResolvedValue({
      usable: true,
      reason: null,
      dirtyPaths: new Set(['src/gone.ts', 'src/renamed.ts']),
      parseErrorPaths: new Set(),
      overlayPaths: new Set(['src/renamed.ts']),
      uncoveredPaths: new Set(),
      tombstones: new Set(['src/gone.ts']),
    });
    vi.spyOn(backendOverlay, 'queryOverlay').mockResolvedValue([
      {
        id: 'renamed-id',
        name: 'renamed',
        type: 'Function',
        filePath: 'src/renamed.ts',
        startLine: 1,
        endLine: 2,
        content: 'export function renamed() {}',
      },
    ]);
    vi.spyOn(pool, 'executeParameterized').mockResolvedValue([
      {
        id: 'gone-id',
        name: 'renamed',
        type: 'Function',
        filePath: 'src/gone.ts',
        startLine: 1,
        endLine: 2,
      },
    ]);

    const result = await resolveSymbolCandidates(handle(), { name: 'renamed' }, {});

    expect(result).toMatchObject({
      kind: 'ok',
      symbol: { id: 'renamed-id', filePath: 'src/renamed.ts', source: 'overlay' },
    });
    expect(backendOverlay.queryOverlay).toHaveBeenCalledOnce();
  });

  it('leaves clean base symbol resolution unchanged', async () => {
    vi.spyOn(pool, 'executeParameterized').mockResolvedValue([
      {
        id: 'clean-id',
        name: 'clean',
        type: 'Function',
        filePath: 'src/a.ts',
        startLine: 1,
        endLine: 2,
      },
    ]);

    const result = await resolveSymbolCandidates(handle(), { name: 'clean' }, {});

    expect(result).toMatchObject({
      kind: 'ok',
      symbol: { id: 'clean-id', filePath: 'src/a.ts' },
    });
  });
});

describe('backend-overlay snapshot single-flight', () => {
  const repo = { id: 'single-flight', repoPath: '/repo', storagePath: '/repo/.ontoindex' };
  const cleanPlan = {
    includePaths: [],
    uncoveredPaths: [],
    allDirtyPaths: [],
    tombstones: [],
    tooMany: false,
    skipped: [],
  };

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
  const snapshot = (generation: string, usable = true): OverlaySnapshot => ({
    usable,
    generation,
    reason: usable ? null : 'unusable',
    dirtyPaths: new Set(),
    parseErrorPaths: new Set(),
    overlayPaths: new Set(),
    uncoveredPaths: new Set(),
    tombstones: new Set(),
  });

  // Only a Function table is needed to exercise the real read-only MCP pool.
  async function buildOverlay(name: string): Promise<void> {
    const overlayPath = path.join(repo.storagePath, 'overlay');
    const dbPath = path.join(overlayPath, name, 'lbug');
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    // Keep repeated fixture builds from reserving the native default 8-TiB mmap.
    const db = new lbug.Database(dbPath, 64 * 1024 * 1024, false, false, 256 * 1024 * 1024);
    const conn = new lbug.Connection(db);
    try {
      const schema = await conn.query(
        'CREATE NODE TABLE Function(id STRING, name STRING, PRIMARY KEY(id))',
      );
      for (const result of Array.isArray(schema) ? schema : [schema]) result.close();
      const statement = await conn.prepare('CREATE (:Function {id: $id, name: $name})');
      const inserted = await conn.execute(statement, { id: `Function:${name}`, name });
      for (const result of Array.isArray(inserted) ? inserted : [inserted]) result.close();
    } finally {
      try {
        await conn.close();
      } finally {
        await db.close();
      }
    }
    const temp = path.join(overlayPath, 'CURRENT.tmp');
    fs.writeFileSync(temp, `${name}\n`);
    fs.renameSync(temp, path.join(overlayPath, 'CURRENT'));
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

  it('reopens a newly published generation and reads only new symbols', async () => {
    await buildOverlay('beforeRebuild');
    const close = vi.spyOn(pool, 'closeLbug');
    await expect(queryOverlay(repo, cypher)).resolves.toEqual([{ name: 'beforeRebuild' }]);
    close.mockClear();
    const oldPath = overlayDbPath(repo.storagePath);
    await buildOverlay('afterRebuild');
    expect(fs.existsSync(oldPath)).toBe(true);
    const reads = await Promise.all(Array.from({ length: 10 }, () => queryOverlay(repo, cypher)));
    expect(reads).toEqual(Array.from({ length: 10 }, () => [{ name: 'afterRebuild' }]));
    expect(close).toHaveBeenCalledExactlyOnceWith(overlayRepoId(repo.id));
    close.mockClear();
    await expect(queryOverlay(repo, cypher)).resolves.toEqual([{ name: 'afterRebuild' }]);
    expect(close).not.toHaveBeenCalled();
  });

  it('keeps all scoped reads on the validated generation after publication changes', async () => {
    await buildOverlay('generationA');
    const close = vi.spyOn(pool, 'closeLbug');
    await withPinnedOverlay(repo, snapshot('generationA'), async () => {
      await buildOverlay('generationB');
      await expect(queryOverlay(repo, cypher)).resolves.toEqual([{ name: 'generationA' }]);
      await expect(queryOverlay(repo, cypher)).resolves.toEqual([{ name: 'generationA' }]);
      expect(close).not.toHaveBeenCalled();
    });
    await expect(queryOverlay(repo, cypher)).resolves.toEqual([{ name: 'generationB' }]);
  });

  it('rejects a snapshot whose generation is no longer available', async () => {
    const callback = vi.fn(async () => 'unreachable');
    await expect(withPinnedOverlay(repo, snapshot('missing'), callback)).rejects.toThrow(
      'overlay generation no longer available',
    );
    expect(callback).not.toHaveBeenCalled();
  });

  it('releases a pin when the scoped callback fails', async () => {
    await buildOverlay('generationA');
    const initialCount = pool.openPoolCount();
    await expect(
      withPinnedOverlay(repo, snapshot('generationA'), async () => {
        await queryOverlay(repo, cypher);
        throw new Error('scoped failure');
      }),
    ).rejects.toThrow('scoped failure');
    await pool.closeLbug(overlayRepoId(repo.id));
    expect(pool.isLbugReady(overlayRepoId(repo.id))).toBe(false);
    expect(pool.openPoolCount()).toBe(initialCount);
  });

  it('rejects a conflicting expected generation inside a pinned scope', async () => {
    await buildOverlay('generationA');
    await withPinnedOverlay(repo, snapshot('generationA'), async () => {
      await expect(queryOverlay(repo, cypher, {}, 'generationB')).rejects.toThrow(
        'overlay generation changed since the snapshot was validated',
      );
      await expect(queryOverlay(repo, cypher, {}, 'generationA')).resolves.toEqual([
        { name: 'generationA' },
      ]);
    });
  });

  it('runs unusable snapshots without pinning their generation', async () => {
    await buildOverlay('generationA');
    await withPinnedOverlay(repo, snapshot('missing', false), async () => {
      await buildOverlay('generationB');
      await expect(queryOverlay(repo, cypher)).resolves.toEqual([{ name: 'generationB' }]);
    });
  });

  it('refuses to read a generation other than the one the snapshot validated', async () => {
    await buildOverlay('validated');
    const validated = path.basename(path.dirname(overlayDbPath(repo.storagePath)));
    await expect(queryOverlay(repo, cypher, {}, validated)).resolves.toEqual([
      { name: 'validated' },
    ]);
    await buildOverlay('swappedIn');
    await expect(queryOverlay(repo, cypher, {}, validated)).rejects.toThrow('generation changed');
    await expect(queryOverlay(repo, cypher)).resolves.toEqual([{ name: 'swappedIn' }]);
  });

  it('holds an on-disk reader marker for the whole pinned scope so pruning cannot remove it', async () => {
    await buildOverlay('markerGen');
    const dir = path.dirname(overlayDbPath(repo.storagePath));
    const markers = () => fs.readdirSync(dir).filter((n) => n.startsWith('.reader-'));
    expect(markers()).toEqual([]);
    const snapshot = { usable: true, generation: path.basename(dir) } as never;
    let during: string[] = [];
    await withPinnedOverlay(repo, snapshot, async () => {
      during = markers();
    });
    expect(during).toHaveLength(1);
    expect(markers()).toEqual([]);
    await expect(
      withPinnedOverlay(repo, snapshot, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(markers()).toEqual([]);
  });

  it('closes an unpublished overlay, rejects the read, and can read a later rebuild', async () => {
    await buildOverlay('beforeDelete');
    await queryOverlay(repo, cypher);
    expect(pool.isLbugReady(overlayRepoId(repo.id))).toBe(true);
    // Removing only CURRENT is valid even while Windows holds the store open.
    const oldPath = overlayDbPath(repo.storagePath);
    fs.rmSync(path.join(repo.storagePath, 'overlay', 'CURRENT'));
    await expect(queryOverlay(repo, cypher)).rejects.toThrow('no published overlay');
    expect(pool.isLbugReady(overlayRepoId(repo.id))).toBe(false);
    expect(fs.existsSync(oldPath)).toBe(true);
    await buildOverlay('afterDelete');
    await expect(queryOverlay(repo, cypher)).resolves.toEqual([{ name: 'afterDelete' }]);
  });
});

describe('workspace capability selection', () => {
  const defaults = {
    eligibleChangeCount: 1,
    configChanged: false,
    needsRelationships: false,
    haveUsableSymbolsOverlay: false,
    haveUsableWorkspaceGraph: false,
    baseMatches: true,
    headChanged: false,
  };
  it.each([
    [0, 'reuse-base'],
    [1, 'build-symbols-overlay'],
    [50, 'build-symbols-overlay'],
    [51, 'build-workspace-graph'],
  ] as const)('selects for %i changes', (eligibleChangeCount, action) => {
    expect(
      backendOverlay.selectWorkspaceCapability({ ...defaults, eligibleChangeCount }).action,
    ).toBe(action);
  });
  it.each([
    { configChanged: true },
    { needsRelationships: true, haveUsableSymbolsOverlay: true },
    { baseMatches: false },
    { headChanged: true },
  ])('escalates full-analysis requirements %j', (input) => {
    expect(backendOverlay.selectWorkspaceCapability({ ...defaults, ...input }).action).toBe(
      'build-workspace-graph',
    );
  });
  it('reuses sufficient workspace and symbol generations', () => {
    expect(
      backendOverlay.selectWorkspaceCapability({
        ...defaults,
        needsRelationships: true,
        haveUsableWorkspaceGraph: true,
      }).action,
    ).toBe('reuse-workspace-graph');
    expect(
      backendOverlay.selectWorkspaceCapability({ ...defaults, haveUsableSymbolsOverlay: true })
        .action,
    ).toBe('reuse-symbols-overlay');
  });
  it.each([
    'tsconfig.json',
    'src/tsconfig.build.json',
    'package.json',
    'go.mod',
    'a.csproj',
    'Cargo.toml',
    'pyproject.toml',
    'composer.json',
    'Package.swift',
  ])('recognizes resolver configuration %s', (filePath) => {
    expect(backendOverlay.isResolverConfigPath(filePath)).toBe(true);
  });
});
