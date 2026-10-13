import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { acquireIndexGenerationPin } from '../../src/storage/repo-manager.js';

let storage: string;
const deadPid = 2147483646;
beforeEach(async () => {
  expect(() => process.kill(deadPid, 0)).toThrow();
  storage = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'pin-sweep-')));
  for (const name of ['active', 'unmanaged']) {
    await fs.mkdir(path.join(storage, 'generations', name), { recursive: true });
    await fs.writeFile(path.join(storage, 'generations', name, 'lbug'), '');
  }
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(storage, { recursive: true, force: true });
});
const directory = (name = 'active') => path.join(storage, 'generations', name);
it('sweeps dead pins on every generation during acquire while preserving other entries', async () => {
  for (const name of ['active', 'unmanaged'])
    await fs.writeFile(path.join(directory(name), `.reader-${deadPid}-dead`), '');
  const preserved = [`.reader-${process.pid}-live`, '.reader-abc', '.reader-12-UPPER'];
  for (const name of preserved) await fs.writeFile(path.join(directory(), name), '');
  const link = `.reader-${deadPid}-link`;
  await fs.symlink('lbug', path.join(directory(), link));
  const pin = await acquireIndexGenerationPin(path.join(directory(), 'lbug'));
  for (const name of ['active', 'unmanaged']) {
    expect((await fs.lstat(directory(name))).isDirectory()).toBe(true);
    await expect(
      fs.lstat(path.join(directory(name), `.reader-${deadPid}-dead`)),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  }
  for (const name of [...preserved, link])
    expect(await fs.lstat(path.join(directory(), name))).toBeTruthy();
  await pin.release();
});
it('does not fail an acquire when sweeping a generation fails', async () => {
  const read = fs.readdir.bind(fs);
  vi.spyOn(fs, 'readdir').mockImplementation(async (...args) => {
    if (String(args[0]) === directory('unmanaged')) throw new Error('unreadable generation');
    return read(...args);
  });
  const pin = await acquireIndexGenerationPin(path.join(directory(), 'lbug'));
  expect(pin.published).toBe(true);
  await pin.release();
});
it('unlinks at most 2000 pins per acquire', async () => {
  await Promise.all(
    Array.from({ length: 2003 }, (_, i) =>
      fs.writeFile(path.join(directory(), `.reader-${deadPid}-${i}`), ''),
    ),
  );
  const pin = await acquireIndexGenerationPin(path.join(directory(), 'lbug'));
  expect(
    (await fs.readdir(directory())).filter((name) => name.startsWith(`.reader-${deadPid}-`)),
  ).toHaveLength(3);
  await pin.release();
});
