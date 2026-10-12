import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import lbug from '@ladybugdb/core';
import * as pool from '../../src/core/lbug/pool-adapter.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  acquireIndexGenerationPin,
  createIndexGeneration,
  publishIndexGenerationTransaction,
} from '../../src/storage/repo-manager.js';

describe('committed index generation retention', () => {
  let storage: string;
  beforeEach(async () => {
    storage = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'index-retention-')));
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(storage, { recursive: true, force: true });
  });
  async function publish(name: string, fail = false) {
    const generation = await createIndexGeneration(storage, name);
    await fs.writeFile(generation.lbugPath, name);
    await fs.writeFile(generation.metaPath, JSON.stringify({ generationId: name }));
    await fs.writeFile(generation.snapshotPath, '{}');
    const published = await publishIndexGenerationTransaction(storage, generation, async () => {
      if (fail) throw new Error('injected commit failure');
    });
    return published;
  }
  async function names() {
    return (await fs.readdir(path.join(storage, 'generations')))
      .filter((n) => !n.startsWith('.'))
      .sort();
  }
  it('opens new and existing unmanaged databases through a root alias', async () => {
    const directory = path.join(storage, 'overlay', 'generation');
    await fs.mkdir(directory, { recursive: true });
    const alias = path.join(storage, 'alias');
    await fs.symlink(directory, alias, 'junction');
    const requested = path.join(alias, 'lbug');
    const canonical = path.join(directory, 'lbug');
    const created = await acquireIndexGenerationPin(requested);
    expect(created.dbPath).toBe(canonical);
    expect(created.published).toBeUndefined();
    await created.release();
    await fs.writeFile(canonical, 'unmanaged');
    const existing = await acquireIndexGenerationPin(requested);
    expect(existing.dbPath).toBe(canonical);
    await existing.release();
    expect(await fs.readdir(directory)).toEqual(['lbug']);
  });
  it('keeps readers alive through publications and prunes after release', async () => {
    await publish('a');
    const pin = await acquireIndexGenerationPin(path.join(storage, 'lbug'));
    await publish('b');
    await publish('c');
    await publish('d');
    expect(await names()).toEqual(['a', 'b', 'c', 'd']);
    expect(await fs.readFile(pin.dbPath, 'utf8')).toBe('a');
    await pin.release();
    expect(await names()).toEqual(['b', 'c', 'd']);
    await pin.release();
  });
  it('pins published file aliases until concurrent releases finish', async () => {
    await publish('a');
    const alias = path.join(storage, 'alias.lbug');
    await fs.symlink(path.join('generations', 'a', 'lbug'), alias);
    const pin = await acquireIndexGenerationPin(alias);
    expect(pin.published).toBe(true);
    await publish('b');
    await publish('c');
    await publish('d');
    expect(await fs.readFile(pin.dbPath, 'utf8')).toBe('a');
    await Promise.all([pin.release(), pin.release(), pin.release()]);
    expect(await names()).toEqual(['b', 'c', 'd']);
  });
  it('retries release after unlink failure', async () => {
    await publish('a');
    const pin = await acquireIndexGenerationPin(path.join(storage, 'lbug'));
    const unlink = fs.unlink.bind(fs);
    const spy = vi.spyOn(fs, 'unlink').mockImplementation(async (filename) => {
      if (String(filename).includes('.reader-')) {
        spy.mockImplementation(unlink);
        throw new Error('injected unlink failure');
      }
      return unlink(filename);
    });
    await expect(pin.release()).rejects.toThrow('injected unlink failure');
    await pin.release();
    expect(
      (await fs.readdir(path.dirname(pin.dbPath))).some((name) => name.startsWith('.reader-')),
    ).toBe(false);
  });
  it('rejects published aliases that escape their storage root', async () => {
    await publish('a');
    const nested = path.join(storage, 'nested');
    await fs.mkdir(nested);
    const alias = path.join(nested, 'alias.lbug');
    await fs.symlink(path.join(storage, 'generations', 'a', 'lbug'), alias);
    await expect(acquireIndexGenerationPin(alias)).rejects.toThrow(
      'outside its generations directory',
    );
    expect((await fs.lstat(alias)).isSymbolicLink()).toBe(true);
  });
  it('preserves legacy generations and restores the previous pointer after commit failure', async () => {
    await publish('legacy');
    await fs.unlink(path.join(storage, 'generations', 'legacy', '.retention-managed'));
    await publish('a');
    await publish('b');
    await publish('c');
    await publish('d');
    await expect(publish('failed', true)).rejects.toThrow('injected commit failure');
    expect(await fs.realpath(path.join(storage, 'current'))).toBe(
      path.join(storage, 'generations', 'd'),
    );
    expect(await names()).toContain('legacy');
  });
  it('preserves unknown reader pins and symlink entries', async () => {
    await publish('a');
    await fs.writeFile(path.join(storage, 'generations', 'a', '.reader-unknown'), '');
    await fs.symlink(storage, path.join(storage, 'generations', 'linked'));
    await publish('b');
    await publish('c');
    await publish('d');
    expect(await names()).toContain('a');
    expect((await fs.lstat(path.join(storage, 'generations', 'linked'))).isSymbolicLink()).toBe(
      true,
    );
  });
  it('retains immediate predecessors despite tied and backward clocks and descending ids', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1000);
    await publish('z');
    await publish('y');
    vi.mocked(Date.now).mockReturnValue(999);
    await publish('x');
    await publish('w');
    expect(await names()).toEqual(['w', 'x', 'y']);
    expect(
      await fs.readFile(path.join(storage, 'generations', 'w', '.retention-managed'), 'utf8'),
    ).toBe('1003');
  });
  it('skips malformed directories while collecting managed generations', async () => {
    await publish('a');
    await fs.mkdir(path.join(storage, 'generations', 'bad name'));
    await publish('b');
    await publish('c');
    await publish('d');
    expect(await names()).toEqual(['b', 'bad name', 'c', 'd']);
  });
  it('rejects missing published files and a symlink generations root', async () => {
    await publish('a');
    await expect(
      acquireIndexGenerationPin(path.join(storage, 'generations', 'missing', 'lbug')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await fs.rename(path.join(storage, 'generations'), path.join(storage, 'elsewhere'));
    await fs.symlink(path.join(storage, 'elsewhere'), path.join(storage, 'generations'));
    await expect(
      acquireIndexGenerationPin(path.join(storage, 'generations', 'a', 'lbug')),
    ).rejects.toThrow('symbolic link');
  });
  it('removes only old staging directories whose owners are confirmed dead', async () => {
    await publish('a');
    const old = Date.now() - 25 * 60 * 60 * 1000;
    const dead = `.staging-dead-123456-${old}-abc`;
    const unknown = `.staging-unknown-123457-${old}-abc`;
    const young = `.staging-young-123456-${Date.now()}-abc`;
    for (const name of [dead, unknown, young])
      await fs.mkdir(path.join(storage, 'generations', name));
    vi.spyOn(process, 'kill').mockImplementation(((pid: number) => {
      throw Object.assign(new Error('owner unavailable'), {
        code: pid === 123456 ? 'ESRCH' : 'EPERM',
      });
    }) as typeof process.kill);
    await publish('b');
    expect(await fs.readdir(path.join(storage, 'generations'))).toEqual(
      expect.arrayContaining([unknown, young]),
    );
    await expect(fs.stat(path.join(storage, 'generations', dead))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
  it('holds a native pool reader until its database closes', async () => {
    const generation = await createIndexGeneration(storage, 'native-a');
    const db = new lbug.Database(
      generation.lbugPath,
      16 * 1024 * 1024,
      false,
      false,
      64 * 1024 * 1024,
    );
    const conn = new lbug.Connection(db);
    try {
      for (const query of [
        'CREATE NODE TABLE Retention(id STRING, PRIMARY KEY(id))',
        "CREATE (:Retention {id: 'alive'})",
      ]) {
        const result = await conn.query(query);
        for (const item of Array.isArray(result) ? result : [result]) item.close();
      }
    } finally {
      await conn.close();
      await db.close();
    }
    await fs.writeFile(generation.metaPath, JSON.stringify({ generationId: 'native-a' }));
    await fs.writeFile(generation.snapshotPath, '{}');
    await publishIndexGenerationTransaction(storage, generation, async () => {});
    const Database = lbug.Database;
    vi.spyOn(lbug, 'Database').mockImplementation(function (
      dbPath?: string,
      buffer?: number,
      compression?: boolean,
      readOnly?: boolean,
    ) {
      return new Database(
        dbPath,
        buffer || 16 * 1024 * 1024,
        compression,
        readOnly,
        64 * 1024 * 1024,
      );
    } as typeof lbug.Database);
    try {
      await pool.initLbug('retention-native', path.join(storage, 'lbug'));
      const unlink = fs.unlink.bind(fs);
      let resumeRelease!: () => void;
      let enteredRelease!: () => void;
      const releaseGate = new Promise<void>((resolve) => {
        resumeRelease = resolve;
      });
      const releaseEntered = new Promise<void>((resolve) => {
        enteredRelease = resolve;
      });
      let pauseOnce = true;
      const unlinkSpy = vi.spyOn(fs, 'unlink').mockImplementation(async (filename) => {
        if (pauseOnce && String(filename).includes('.reader-')) {
          pauseOnce = false;
          enteredRelease();
          await releaseGate;
        }
        return unlink(filename);
      });
      const sharing = pool.initLbug('retention-shared', path.join(storage, 'lbug'));
      try {
        await releaseEntered;
        await pool.closeLbug('retention-native');
      } finally {
        resumeRelease();
      }
      await sharing;
      unlinkSpy.mockRestore();
      await publish('b');
      await publish('c');
      await publish('d');
      expect(await names()).toContain('native-a');
      expect(
        await pool.executeQuery('retention-shared', 'MATCH (n:Retention) RETURN n.id AS id'),
      ).toEqual([{ id: 'alive' }]);
    } finally {
      await pool.closeLbug('retention-native');
      await pool.closeLbug('retention-shared');
    }
    await vi.waitFor(async () => {
      expect(await names()).not.toContain('native-a');
    });
  }, 120_000);
});
