import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { FileSessionStore } from '../../src/core/memory/session-store.js';

describe('FileSessionStore concurrency', () => {
  let root: string;

  afterEach(async () => {
    if (root) await fs.rm(root, { recursive: true, force: true });
  });

  it('retains concurrent updates from independent store instances', async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-store-concurrent-'));
    const stores = Array.from({ length: 20 }, () => new FileSessionStore(root, 'shared'));
    await Promise.all(stores.map((store, index) => store.set(`key-${index}`, `value-${index}`)));
    const keys = await stores[0].list();
    expect(keys.sort()).toEqual(Array.from({ length: 20 }, (_, index) => `key-${index}`).sort());
  });

  it('rejects symlinked metadata directories without writing through them', async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-store-symlink-'));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'session-store-outside-'));
    await fs.mkdir(path.join(root, '.ontoindex'));
    await fs.symlink(outside, path.join(root, '.ontoindex', 'sessions'));
    const store = new FileSessionStore(root, 'blocked');
    await expect(store.set('key', 'value')).rejects.toThrow(/symbolic link/);
    await expect(fs.readdir(outside)).resolves.toEqual([]);
    await fs.rm(outside, { recursive: true, force: true });
  });

  it.each(['shared.json', 'shared.json.lock'])(
    'rejects a symlinked %s without changing its target',
    async (leaf) => {
      root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-store-leaf-'));
      const directory = path.join(root, '.ontoindex', 'sessions');
      await fs.mkdir(directory, { recursive: true });
      const target = path.join(root, 'target');
      await fs.writeFile(target, '{}');
      const link = path.join(directory, leaf);
      await fs.symlink(target, link);
      await expect(new FileSessionStore(root, 'shared').set('key', 'value')).rejects.toThrow(
        /symbolic link/,
      );
      expect(await fs.readFile(target, 'utf8')).toBe('{}');
      expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
    },
  );

  it('retains updates from independent processes', async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-store-process-'));
    const source = new URL('../../src/core/memory/session-store.ts', import.meta.url).href;
    await Promise.all(
      Array.from({ length: 4 }, (_, index) =>
        promisify(execFile)(process.execPath, [
          '--import',
          'tsx',
          '--input-type=module',
          '-e',
          `import { FileSessionStore } from ${JSON.stringify(source)}; await new FileSessionStore(${JSON.stringify(root)}, 'shared').set('key-${index}', 'value-${index}');`,
        ]),
      ),
    );
    expect((await new FileSessionStore(root, 'shared').list()).sort()).toEqual([
      'key-0',
      'key-1',
      'key-2',
      'key-3',
    ]);
  });
});
