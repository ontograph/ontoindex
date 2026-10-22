/**
 * Regression: `ontoindex analyze` publishes a new index generation by
 * repointing the stable `.ontoindex/current` symlink. A pool entry cached by
 * that stable path kept the handle to the replaced generation, so every later
 * MCP graph query failed with "Corrupted wal file. Read out invalid WAL record
 * type." while the same query through a fresh CLI process succeeded.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import lbug from '@ladybugdb/core';
import { inject } from 'vitest';
import {
  initLbug,
  withPinnedGeneration,
  getPinnedRepoId,
  getLbugDbPath,
  executeParameterized,
  executeQuery,
  closeLbug,
  addPoolCloseListener,
} from '../../src/core/lbug/pool-adapter.js';
import {
  createIndexGeneration,
  publishIndexGenerationTransaction,
  acquireOverlayGenerationPin,
  pruneOverlayGenerations,
} from '../../src/storage/repo-manager.js';
import { resolveTargetContext } from '../../src/mcp/shared/target-context.js';

const repoId = `test-generation-swap-${Date.now()}`;
let tmpRoot: string | undefined;

async function copyGeneration(templateDir: string, target: string): Promise<void> {
  await fs.mkdir(target, { recursive: true });
  for (const entry of await fs.readdir(templateDir)) {
    await fs.cp(path.join(templateDir, entry), path.join(target, entry), {
      recursive: true,
      force: true,
    });
  }
}

describe('lbug pool generation swap', () => {
  afterEach(async () => {
    try {
      await closeLbug(repoId);
    } catch {
      /* best-effort */
    }
    if (tmpRoot) {
      await fs.rm(tmpRoot, { recursive: true, force: true });
      tmpRoot = undefined;
    }
  });

  it('reopens the database after the current-generation symlink is repointed', async () => {
    const templateDbPath = inject<'lbugDbPath'>('lbugDbPath');
    const templateDir = path.dirname(templateDbPath);
    const dbFileName = path.basename(templateDbPath);

    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ontoindex-generation-swap-'));
    const generations = path.join(tmpRoot, 'generations');
    const genA = path.join(generations, 'gen-a');
    const genB = path.join(generations, 'gen-b');
    await copyGeneration(templateDir, genA);
    await copyGeneration(templateDir, genB);

    const currentLink = path.join(tmpRoot, 'current');
    await fs.symlink(genA, currentLink, 'dir');
    const stableDbPath = path.join(currentLink, dbFileName);

    await initLbug(repoId, stableDbPath);
    const before = await executeQuery(repoId, 'MATCH (f:File) RETURN count(f) AS total');
    expect(before).toBeDefined();

    const closedRepos: string[] = [];
    const removeListener = addPoolCloseListener((closedRepoId) => {
      closedRepos.push(closedRepoId);
    });

    // Publish a new generation behind the same stable path, exactly as
    // `ontoindex analyze` does when it swaps `.ontoindex/current`.
    await fs.rm(currentLink);
    await fs.symlink(genB, currentLink, 'dir');

    try {
      await initLbug(repoId, stableDbPath);
    } finally {
      removeListener();
    }

    // The stale handle must be dropped, otherwise queries keep reading the
    // replaced generation until the process restarts.
    expect(closedRepos).toContain(repoId);

    const after = await executeQuery(repoId, 'MATCH (f:File) RETURN count(f) AS total');
    expect(after).toBeDefined();
  });

  it('reports metadata for the generation pinned by the pool during publication', async () => {
    const templateDbPath = inject<'lbugDbPath'>('lbugDbPath');
    const templateDir = path.dirname(templateDbPath);

    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ontoindex-generation-meta-'));
    const storagePath = path.join(tmpRoot, '.ontoindex');
    const commitA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const commitB = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

    const publish = async (generationId: string, lastCommit: string) => {
      const generation = await createIndexGeneration(storagePath, generationId);
      await copyGeneration(templateDir, generation.generationPath);
      await fs.writeFile(
        generation.metaPath,
        JSON.stringify({
          repoPath: '.',
          lastCommit,
          indexedAt: generationId,
          generationId,
          stats: { files: generationId === 'generation-n' ? 1 : 2 },
        }),
      );
      await fs.writeFile(generation.snapshotPath, '{}');
      return publishIndexGenerationTransaction(storagePath, generation, async () => {});
    };

    await publish('generation-n', commitA);
    const dbPath = path.join(storagePath, 'lbug');
    await initLbug(repoId, dbPath);
    const beforeRows = await executeQuery(repoId, 'MATCH (f:File) RETURN count(f) AS total');
    expect(beforeRows).toBeDefined();
    expect(
      (await fs.readdir(path.join(storagePath, 'generations', 'generation-n'))).some((name) =>
        name.startsWith('.reader-'),
      ),
    ).toBe(true);

    await publish('generation-n-plus-one', commitB);
    const contextDeps = {
      readRegistry: async () => [
        {
          name: repoId,
          path: tmpRoot!,
          storagePath,
          indexedAt: 'registry-index',
          lastCommit: commitA,
        },
      ],
      execGit: async (_cwd: string, args: string[]) => {
        const key = args.join(' ');
        if (key === 'rev-parse --abbrev-ref HEAD') return 'main\n';
        if (key === 'status --porcelain=v1 --untracked-files=all') return '';
        return `${commitB}\n`;
      },
    };
    const context = await resolveTargetContext(
      { repo: repoId, verifyGraphAuthority: true },
      contextDeps,
    );

    // The open pool reader still owns N, so metadata beside its query context
    // must also identify N even though current now points to N+1.
    expect(context).toMatchObject({
      status: 'ok',
      indexedHead: commitA,
      generationId: 'generation-n',
    });
    expect(context.indexedHead).not.toBe(commitB);
    expect(await executeQuery(repoId, 'MATCH (f:File) RETURN count(f) AS total')).toEqual(
      beforeRows,
    );

    // Once the old reader is released, a new request must follow current to N+1.
    await closeLbug(repoId);
    await initLbug(repoId, dbPath);
    const nextContext = await resolveTargetContext(
      { repo: repoId, verifyGraphAuthority: true },
      contextDeps,
    );
    expect(nextContext).toMatchObject({
      status: 'ok',
      indexedHead: commitB,
      generationId: 'generation-n-plus-one',
    });
    expect(await executeQuery(repoId, 'MATCH (f:File) RETURN count(f) AS total')).toBeDefined();
  });

  async function pinnedFixture() {
    const template = inject<'lbugDbPath'>('lbugDbPath');
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ontoindex-request-pin-'));
    const storage = path.join(tmpRoot, '.ontoindex');
    const publish = async (id: string) => {
      const generation = await createIndexGeneration(storage, id);
      await copyGeneration(path.dirname(template), generation.generationPath);
      const db = new lbug.Database(generation.lbugPath);
      const conn = new lbug.Connection(db);
      try {
        const result = await conn.query(`CREATE (:File {id: '${id}', name: '${id}'})`);
        for (const item of Array.isArray(result) ? result : [result]) await item.close();
      } finally {
        await conn.close();
        await db.close();
      }
      await fs.writeFile(
        generation.metaPath,
        JSON.stringify({
          repoPath: '.',
          lastCommit: id,
          indexedAt: id,
          generationId: id,
          stats: { files: 1 },
        }),
      );
      await fs.writeFile(generation.snapshotPath, '{}');
      // Publication renames the staging directory; the activation reports the final paths.
      return (await publishIndexGenerationTransaction(storage, generation, async () => {}))
        .activeGeneration;
    };
    const a = await publish('pin-a');
    const b = await publish('pin-b');
    // Publishing activates each generation, so point the stable alias back at A.
    const current = path.join(storage, 'current');
    await fs.rm(current, { force: true });
    await fs.symlink(a.generationPath, current, 'dir');
    const markers = async () =>
      (await fs.readdir(a.generationPath)).filter((n) => n.startsWith('.reader-'));
    return { a, b, current, stable: path.join(current, path.basename(template)), markers };
  }

  it('keeps both query paths pinned across publication and restores the mutable alias', async () => {
    const { a, b, current, stable, markers } = await pinnedFixture();
    await initLbug(repoId, stable);
    let pinned!: string;
    await withPinnedGeneration(repoId, stable, async () => {
      pinned = getPinnedRepoId(repoId)!;
      expect(getLbugDbPath(pinned)).toBe(await fs.realpath(a.lbugPath));
      expect(await markers()).toHaveLength(1);
      const query = 'MATCH (f:File) RETURN f.name AS sentinel';
      const before = await executeQuery(repoId, query);
      expect(before).toEqual([{ sentinel: 'pin-a' }]);
      await fs.rm(current);
      await fs.symlink(b.generationPath, current, 'dir');
      await initLbug(repoId, stable);
      expect(await executeParameterized(repoId, query, {})).toEqual(before);
      expect(getLbugDbPath(pinned)).toBe(await fs.realpath(a.lbugPath));
      expect(await markers()).toHaveLength(1);
    });
    expect(getPinnedRepoId(repoId)).toBeUndefined();
    expect(getLbugDbPath(pinned)).toBeUndefined();
    expect(await markers()).toHaveLength(0);
    expect(getLbugDbPath(repoId)).toBe(await fs.realpath(b.lbugPath));
    expect(await executeQuery(repoId, 'MATCH (f:File) RETURN f.name AS sentinel')).toEqual([
      { sentinel: 'pin-b' },
    ]);
  });

  it('retains a pinned overlay generation during pruning and removes it after release', async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ontoindex-overlay-pin-'));
    const overlay = path.join(tmpRoot, 'overlay');
    for (let index = 1; index <= 5; index++) {
      const dir = path.join(overlay, `${index}-1-abc`);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, 'lbug'), 'artifact');
      await fs.utimes(dir, index, index);
    }
    const oldGeneration = path.join(overlay, '1-1-abc');
    const pin = await acquireOverlayGenerationPin(oldGeneration);
    try {
      await fs.utimes(oldGeneration, 1, 1);
      await pruneOverlayGenerations(overlay, '5-1-abc');
      expect(await fs.stat(oldGeneration)).toBeDefined();
      await expect(fs.stat(path.join(overlay, '2-1-abc'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      await pin.release();
    }
    await fs.utimes(oldGeneration, 1, 1);
    await pruneOverlayGenerations(overlay, '5-1-abc');
    await expect(fs.stat(oldGeneration)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([
    ['global', () => closeLbug()],
    ['alias', () => closeLbug(repoId)],
  ])('defers a %s close while a request scope holds the pin', async (_name, close) => {
    const { stable } = await pinnedFixture();
    await initLbug(repoId, stable);
    let pinned!: string;
    await withPinnedGeneration(repoId, stable, async () => {
      pinned = getPinnedRepoId(repoId)!;
      const before = await executeQuery(repoId, 'MATCH (f:File) RETURN count(f) AS total');
      await close();
      expect(getLbugDbPath(pinned)).toBeDefined();
      expect(await executeQuery(repoId, 'MATCH (f:File) RETURN count(f) AS total')).toEqual(before);
    });
    expect(getLbugDbPath(pinned)).toBeUndefined();
  });

  it('releases failed scopes and reuses nested scopes', async () => {
    const { stable, markers } = await pinnedFixture();
    let pinned!: string;
    const error = new Error('request failed');
    await expect(
      withPinnedGeneration(repoId, stable, async () => {
        pinned = getPinnedRepoId(repoId)!;
        await withPinnedGeneration(repoId, stable, async () => {
          expect(getPinnedRepoId(repoId)).toBe(pinned);
        });
        expect(getLbugDbPath(pinned)).toBeDefined();
        throw error;
      }),
    ).rejects.toBe(error);
    expect(getLbugDbPath(pinned)).toBeUndefined();
    expect(await markers()).toHaveLength(0);
  });

  it('shares concurrent scopes and closes only on the final release', async () => {
    const { stable, markers } = await pinnedFixture();
    let finishFirst!: () => void;
    let finishSecond!: () => void;
    let firstStarted!: () => void;
    let secondStarted!: () => void;
    const firstReady = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    const secondReady = new Promise<void>((resolve) => {
      secondStarted = resolve;
    });
    const firstEnd = new Promise<void>((resolve) => {
      finishFirst = resolve;
    });
    const secondEnd = new Promise<void>((resolve) => {
      finishSecond = resolve;
    });
    let pinned!: string;
    const first = withPinnedGeneration(repoId, stable, async () => {
      pinned = getPinnedRepoId(repoId)!;
      firstStarted();
      await firstEnd;
    });
    await firstReady;
    const second = withPinnedGeneration(repoId, stable, async () => {
      expect(getPinnedRepoId(repoId)).toBe(pinned);
      secondStarted();
      await secondEnd;
    });
    await secondReady;
    expect(await markers()).toHaveLength(1);
    finishFirst();
    await first;
    expect(getLbugDbPath(pinned)).toBeDefined();
    finishSecond();
    await second;
    expect(getLbugDbPath(pinned)).toBeUndefined();
    expect(await markers()).toHaveLength(0);
  });
});
