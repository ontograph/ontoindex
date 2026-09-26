import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pruneIndexGenerations } from '../../src/storage/repo-manager.js';

describe('pruneIndexGenerations', () => {
  let storagePath: string;
  const generations = () => path.join(storagePath, 'generations');

  async function makeGeneration(name: string, ageMinutes: number): Promise<void> {
    const dir = path.join(generations(), name);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'lbug'), name);
    const time = new Date(Date.now() - ageMinutes * 60_000);
    await fs.utimes(dir, time, time);
  }

  beforeEach(async () => {
    storagePath = await fs.mkdtemp(path.join(os.tmpdir(), 'ontoindex-prune-'));
    await makeGeneration('gen-1', 50);
    await makeGeneration('gen-2', 40);
    await makeGeneration('gen-3', 30);
    await makeGeneration('gen-4', 20);
    await makeGeneration('gen-active', 60); // oldest mtime, but active
    await fs.mkdir(path.join(generations(), '.staging-gen-5-1-2-x'));
    await fs.symlink(path.join('generations', 'gen-active'), path.join(storagePath, 'current'));
  });

  afterEach(async () => {
    await fs.rm(storagePath, { recursive: true, force: true });
  });

  it('keeps the active generation, staging dirs, and the newest previous ones', async () => {
    const result = await pruneIndexGenerations(storagePath, 2, 0);

    expect(result.removed.sort()).toEqual(['gen-1', 'gen-2']);
    expect((await fs.readdir(generations())).sort()).toEqual([
      '.staging-gen-5-1-2-x',
      'gen-3',
      'gen-4',
      'gen-active',
    ]);
  });

  it('does nothing without an active generation', async () => {
    await fs.unlink(path.join(storagePath, 'current'));

    const result = await pruneIndexGenerations(storagePath, 0, 0);

    expect(result.removed).toEqual([]);
    expect((await fs.readdir(generations())).length).toBe(6);
  });

  it('defers deleting generations that were replaced within the grace period', async () => {
    // gen-2 was replaced when gen-3 was published 30 minutes ago; gen-1 when
    // gen-2 was published 40 minutes ago.
    const result = await pruneIndexGenerations(storagePath, 2, 35 * 60_000);

    expect(result.removed).toEqual(['gen-1']);
    expect(result.deferred).toEqual(['gen-2']);
    expect(await fs.readdir(generations())).toContain('gen-2');
  });
});
