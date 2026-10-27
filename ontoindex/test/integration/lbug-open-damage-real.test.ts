import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import lbug from '@ladybugdb/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LbugOpenError } from '../../src/core/lbug/open-error.js';
import { closeLbug, executeParameterized, initLbug } from '../../src/core/lbug/pool-adapter.js';

describe('native storage damage found at open', () => {
  let root: string;
  let fixture: Buffer;
  const countQuery = 'MATCH (n:T) RETURN count(n) AS n';

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'ontoindex-open-damage-'));
    const dbPath = path.join(root, 'fixture');
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
      try {
        await conn.close();
      } finally {
        await db.close();
      }
    }
    fixture = await fs.readFile(dbPath);
    expect(fixture.length).toBeGreaterThan(1024 * 1024);
  }, 120_000);

  afterAll(async () => {
    if (root) await fs.rm(root, { recursive: true, force: true });
  });

  async function writeCopy(name: string, contents: Buffer): Promise<string> {
    const dir = path.join(root, name);
    await fs.mkdir(dir);
    const dbPath = path.join(dir, 'lbug');
    await fs.writeFile(dbPath, contents);
    return dbPath;
  }

  function damagedCopy(variant: string): Buffer {
    if (variant === 'half-truncated') return fixture.subarray(0, Math.floor(fixture.length / 2));
    if (variant === 'tail-truncated') return fixture.subarray(0, fixture.length - 8192);
    const contents = Buffer.from(fixture);
    const start =
      variant === 'middle-flipped' ? Math.floor(contents.length / 2) : contents.length - 300000;
    for (let index = start; index < start + 65536; index++) contents[index] ^= 0xff;
    return contents;
  }

  async function expectCorruptOpen(dbPath: string): Promise<void> {
    const repoId = `${root}:${path.basename(path.dirname(dbPath))}`;
    try {
      const opening = initLbug(repoId, dbPath);
      await expect(opening).rejects.toBeInstanceOf(LbugOpenError);
      await expect(opening).rejects.toMatchObject({
        dbPath: await fs.realpath(dbPath),
        kind: 'corrupt',
        phase: 'native-open',
      });
    } finally {
      await closeLbug(repoId);
    }
  }

  it('reads the flushed healthy database', async () => {
    const dbPath = await writeCopy('healthy', fixture);
    const repoId = `${root}:healthy`;
    try {
      await initLbug(repoId, dbPath);
      const rows = await executeParameterized(repoId, countQuery, {});
      expect(rows).toHaveLength(1);
      expect(Number(rows[0].n)).toBe(30000);
    } finally {
      await closeLbug(repoId);
    }
  }, 120_000);

  // Directory names stay neutral: the native message echoes the path, and a name
  // containing a corruption keyword would classify the error without the read signature.
  it.each(['half-truncated', 'tail-truncated', 'middle-flipped', 'tail-flipped'])(
    'classifies %s damage as corrupt at open',
    async (variant) => {
      await expectCorruptOpen(
        await writeCopy(`db-${variant.length}-${variant.charCodeAt(0)}`, damagedCopy(variant)),
      );
    },
    120_000,
  );

  it('keeps missing-table binder errors out of the open classification', async () => {
    const dbPath = await writeCopy('binder-error', fixture);
    const repoId = `${root}:binder-error`;
    try {
      await initLbug(repoId, dbPath);
      const reading = executeParameterized(repoId, 'MATCH (n:Missing) RETURN n', {});
      await expect(reading).rejects.toThrow(/Binder exception/);
      await expect(reading).rejects.not.toBeInstanceOf(LbugOpenError);
    } finally {
      await closeLbug(repoId);
    }
  }, 120_000);
});
