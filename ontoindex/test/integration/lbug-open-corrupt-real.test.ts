import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import lbug from '@ladybugdb/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LbugOpenError } from '../../src/core/lbug/open-error.js';
import { closeLbug, initLbug } from '../../src/core/lbug/pool-adapter.js';

describe('native corrupt database open classification', () => {
  let root: string;

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'ontoindex-corrupt-open-'));
  });

  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  async function expectCorruptOpen(name: string, dbPath: string): Promise<void> {
    const repoId = `${root}:${name}`;
    try {
      const opening = initLbug(repoId, dbPath);
      await expect(opening).rejects.toBeInstanceOf(LbugOpenError);
      await expect(opening).rejects.toMatchObject({ kind: 'corrupt', dbPath });
    } finally {
      await closeLbug(repoId);
    }
  }

  it.each([
    ['garbage-text', Buffer.from('this is not a database '.repeat(400))],
    ['zero-filled', Buffer.alloc(64 * 1024)],
  ] as const)('classifies a %s file as corrupt', async (name, contents) => {
    const dbPath = path.join(root, name);
    await fs.writeFile(dbPath, contents);
    await expectCorruptOpen(name, dbPath);
  });

  it('classifies a real database with a damaged header as corrupt', async () => {
    const dbPath = path.join(root, 'damaged-header');
    const db = new lbug.Database(dbPath, 64 * 1024 * 1024);
    try {
      await db.init();
    } finally {
      await db.close();
    }

    const contents = await fs.readFile(dbPath);
    expect(contents.length).toBeGreaterThanOrEqual(64);
    for (let index = 0; index < 64; index++) contents[index] ^= 0xff;
    await fs.writeFile(dbPath, contents);

    await expectCorruptOpen('damaged-header', dbPath);
  });
});
