import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  acquireIndexGenerationPin,
  createIndexGeneration,
  processStartedAfter,
  publishIndexGenerationTransaction,
} from '../../src/storage/repo-manager.js';

describe('reader pin PID reuse', () => {
  let storage: string | undefined;

  afterEach(async () => {
    if (storage) await fs.rm(storage, { recursive: true, force: true });
    storage = undefined;
  });

  it('only identifies a live PID as started after a valid reference time', () => {
    expect(processStartedAfter(process.pid, Date.now() + 60_000)).toBe(false);
    expect(processStartedAfter(process.pid, 0)).toBe(true);
    expect(processStartedAfter(2_147_483_647, 0)).toBe(false);
  });

  it('sweeps an old pin for a reused live PID and preserves a current pin', async () => {
    storage = await fs.mkdtemp(path.join(os.tmpdir(), 'reader-pin-pid-reuse-'));
    const generation = await createIndexGeneration(storage, 'generation-a');
    await fs.writeFile(generation.lbugPath, 'generation-a');
    await fs.writeFile(generation.metaPath, JSON.stringify({ generationId: 'generation-a' }));
    await fs.writeFile(generation.snapshotPath, '{}');
    await publishIndexGenerationTransaction(storage, generation, async () => {});

    const directory = path.join(storage, 'generations', 'generation-a');
    const oldPin = path.join(directory, `.reader-${process.ppid}-old`);
    const currentPin = path.join(directory, `.reader-${process.ppid}-current`);
    await fs.writeFile(oldPin, '');
    await fs.utimes(oldPin, new Date(0), new Date(0));
    await fs.writeFile(currentPin, '');

    const acquired = await acquireIndexGenerationPin(path.join(storage, 'lbug'));
    await acquired.release();

    await expect(fs.lstat(oldPin)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await fs.lstat(currentPin)).isFile()).toBe(true);
  });
});
