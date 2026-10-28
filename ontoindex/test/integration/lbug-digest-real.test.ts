import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import lbug from '@ladybugdb/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { digestDatabaseFile } from '../../src/core/lbug/database-digest.js';
import { closeLbug, executeParameterized, initLbug } from '../../src/core/lbug/pool-adapter.js';

describe('database digest on a real native database', () => {
  let root: string;
  let dbPath: string;

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'ontoindex-digest-real-'));
    dbPath = path.join(root, 'lbug');
    const db = new lbug.Database(dbPath, 64 * 1024 * 1024);
    const conn = new lbug.Connection(db);
    try {
      for (const statement of [
        'CREATE NODE TABLE T(id STRING, PRIMARY KEY(id))',
        "UNWIND range(1,30000) AS i CREATE (:T {id: 'x_' + cast(i as string) + '_' + '0123456789012345678901234567890123456789'})",
        'CHECKPOINT',
      ]) {
        const response = await conn.query(statement);
        for (const result of Array.isArray(response) ? response : [response]) result.close();
      }
    } finally {
      await conn.close();
      await db.close();
    }
  }, 120_000);

  afterAll(async () => {
    if (root) await fs.rm(root, { recursive: true, force: true });
  });

  it('is unchanged by a read-only open, query and close', async () => {
    const before = await digestDatabaseFile(dbPath);
    expect(before.size).toBeGreaterThan(1024 * 1024);
    const repoId = `${root}:readonly`;
    try {
      await initLbug(repoId, dbPath);
      const rows = await executeParameterized(repoId, 'MATCH (n:T) RETURN count(n) AS n', {});
      expect(Number(rows[0].n)).toBe(30000);
    } finally {
      await closeLbug(repoId);
    }
    expect(await digestDatabaseFile(dbPath)).toEqual(before);
  }, 120_000);

  it('detects same-size damage in the early data pages that the native open cannot survive', async () => {
    const healthy = await digestDatabaseFile(dbPath);
    const contents = await fs.readFile(dbPath);
    contents.fill(0xff, 16 * 4096, 20 * 4096);
    const damagedPath = path.join(root, 'damaged');
    await fs.writeFile(damagedPath, contents);
    const damaged = await digestDatabaseFile(damagedPath);
    expect(damaged.size).toBe(healthy.size);
    expect(damaged.sha256).not.toBe(healthy.sha256);
  });
});
