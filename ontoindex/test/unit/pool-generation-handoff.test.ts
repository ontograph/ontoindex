import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A generation swap must not fail callers queued on the retired pool entry:
 * they are re-routed to the entry opened for the newly published generation.
 */

const mocks = vi.hoisted(() => {
  // Read at pool-adapter import time: one connection forces the second caller to queue.
  process.env.ONTOINDEX_LBUG_POOL_SIZE = '1';
  let nextDbId = 0;
  return {
    databases: [] as number[],
    closedDatabases: [] as number[],
    releaseFirst: null as null | (() => void),
    newDb: () => ++nextDbId,
  };
});

vi.mock('../../src/core/lbug/lbug-adapter.js', () => ({
  resolveLocalLbugExtensionPath: vi.fn(async () => null),
}));

vi.mock('@ladybugdb/core', () => ({
  default: {
    Database: class {
      id = mocks.newDb();
      constructor() {
        mocks.databases.push(this.id);
      }
      close = vi.fn(async () => {
        mocks.closedDatabases.push(this.id);
      });
    },
    Connection: class {
      constructor(public db: { id: number }) {}
      close = vi.fn(async () => undefined);
      query = vi.fn(async (cypher: string) => {
        if (cypher.startsWith('INSTALL') || cypher.startsWith('LOAD')) return undefined;
        if (cypher.includes('slow') && mocks.releaseFirst === null) {
          await new Promise<void>((resolve) => {
            mocks.releaseFirst = resolve;
          });
        }
        return { getAll: async () => [{ db: this.db.id }] };
      });
    },
  },
}));

import { closeLbug, executeQuery, initLbug } from '../../src/core/lbug/pool-adapter.js';

describe('pool generation handoff', () => {
  const repoId = 'generation-handoff';
  let root: string;
  let current: string;

  beforeEach(async () => {
    mocks.releaseFirst = null;
    mocks.databases.length = 0;
    mocks.closedDatabases.length = 0;
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'ontoindex-handoff-'));
    for (const gen of ['gen-a', 'gen-b']) {
      await fs.mkdir(path.join(root, gen));
      await fs.writeFile(path.join(root, gen, 'lbug'), gen);
    }
    current = path.join(root, 'current');
    await fs.symlink(path.join(root, 'gen-a'), current, 'dir');
  });

  afterEach(async () => {
    await closeLbug(repoId).catch(() => {});
    await fs.rm(root, { recursive: true, force: true });
  });

  it('moves queued callers to the new generation instead of rejecting them', async () => {
    const dbPath = path.join(current, 'lbug');
    await initLbug(repoId, dbPath);

    // Occupy the only connection, then queue a second caller behind it.
    const inFlight = executeQuery<{ db: number }>(repoId, 'MATCH (n) RETURN "slow"');
    await vi.waitFor(() => expect(mocks.releaseFirst).not.toBeNull());
    const queued = executeQuery<{ db: number }>(repoId, 'MATCH (n) RETURN 1');

    // Publish generation B behind the stable path and trigger the swap.
    await fs.rm(current);
    await fs.symlink(path.join(root, 'gen-b'), current, 'dir');
    await initLbug(repoId, dbPath);

    mocks.releaseFirst?.();
    const [first, second] = await Promise.all([inFlight, queued]);

    const [dbA, dbB] = mocks.databases;
    expect(first[0].db).toBe(dbA);
    expect(second[0].db).toBe(dbB);
  });

  it('keeps the retired generation open until its in-flight query finishes', async () => {
    const dbPath = path.join(current, 'lbug');
    await initLbug(repoId, dbPath);

    const inFlight = executeQuery<{ db: number }>(repoId, 'MATCH (n) RETURN "slow"');
    await vi.waitFor(() => expect(mocks.releaseFirst).not.toBeNull());

    await fs.rm(current);
    await fs.symlink(path.join(root, 'gen-b'), current, 'dir');
    await initLbug(repoId, dbPath);

    const [dbA, dbB] = mocks.databases;
    expect(dbB).toBeDefined();
    // Closing the native Database under a running query can crash the process.
    expect(mocks.closedDatabases).not.toContain(dbA);

    mocks.releaseFirst?.();
    const rows = await inFlight;
    expect(rows[0].db).toBe(dbA);
    await vi.waitFor(() => expect(mocks.closedDatabases).toContain(dbA));
    expect(mocks.closedDatabases).not.toContain(dbB);
  });
});
