import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  acquireIndexGenerationPin,
  createIndexGeneration,
  processStartedAfter,
  publishIndexGenerationTransaction,
} from '../../src/storage/repo-manager.js';

describe('reader pin PID reuse', () => {
  let storage: string | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
    syncBuiltinESMExports();
    if (storage) await fs.rm(storage, { recursive: true, force: true });
    storage = undefined;
  });

  it('checks Darwin start times with a two-second tolerance', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
    const ps = vi
      .spyOn(childProcess, 'execFileSync')
      .mockReturnValue(' Wed Oct 14 12:00:00 2026\n');
    const startedAtMs = Date.parse('Wed Oct 14 12:00:00 2026');
    syncBuiltinESMExports();
    expect(processStartedAfter(123, startedAtMs - 2001)).toBe(true);
    expect(processStartedAfter(123, startedAtMs - 2000)).toBe(false);
    expect(processStartedAfter(123, startedAtMs + 1000)).toBe(false);
    expect(ps).toHaveBeenCalledWith('ps', ['-o', 'lstart=', '-p', '123'], {
      env: { ...process.env, LC_ALL: 'C' },
      timeout: 2000,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  });

  it('preserves pins when Darwin start-time detection fails', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
    const ps = vi.spyOn(childProcess, 'execFileSync');
    syncBuiltinESMExports();
    for (const output of ['', ' \n', 'invalid date']) {
      ps.mockReturnValue(output);
      expect(processStartedAfter(123, 0)).toBe(false);
    }
    ps.mockImplementation(() => {
      throw new Error('ps failed or timed out');
    });
    expect(processStartedAfter(123, 0)).toBe(false);
  });

  it('preserves pins on Windows without process start-time detection', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    expect(processStartedAfter(process.pid, 0)).toBe(false);
  });

  it.skipIf(process.platform === 'win32')(
    'only identifies a live PID as started after a valid reference time',
    () => {
      expect(processStartedAfter(process.pid, Date.now() + 60_000)).toBe(false);
      expect(processStartedAfter(process.pid, 0)).toBe(true);
      expect(processStartedAfter(2_147_483_647, 0)).toBe(false);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'sweeps an old pin for a reused live PID and preserves a current pin',
    async () => {
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
    },
  );
});
