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
import { inject } from 'vitest';
import {
  initLbug,
  executeQuery,
  closeLbug,
  addPoolCloseListener,
} from '../../src/core/lbug/pool-adapter.js';
import {
  createIndexGeneration,
  publishIndexGenerationTransaction,
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
    const context = await resolveTargetContext(
      { repo: repoId, verifyGraphAuthority: true },
      {
        readRegistry: async () => [
          {
            name: repoId,
            path: tmpRoot!,
            storagePath,
            indexedAt: 'registry-index',
            lastCommit: commitA,
          },
        ],
        execGit: async (_cwd, args) => {
          const key = args.join(' ');
          if (key === 'rev-parse --abbrev-ref HEAD') return 'main\n';
          if (key === 'status --porcelain=v1 --untracked-files=all') return '';
          return `${commitB}\n`;
        },
      },
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
  });
});
