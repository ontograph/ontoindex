import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireNativeFileLock } from '../../src/native/file-lock.js';
import * as nativeModule from '../../src/native/module.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('native file lock wrapper', () => {
  it('holds real kernel ownership until release and preserves the file', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ontoindex-native-wrapper-'));
    temporaryDirectories.push(directory);
    const lockPath = join(directory, 'owner.lock');
    const bytes = Buffer.from('existing metadata\n\0preserve');
    writeFileSync(lockPath, bytes);
    const original = statSync(lockPath, { bigint: true });
    const assertPreserved = () => {
      const current = statSync(lockPath, { bigint: true });
      expect({ dev: current.dev, ino: current.ino }).toEqual({
        dev: original.dev,
        ino: original.ino,
      });
      expect(readFileSync(lockPath)).toEqual(bytes);
    };

    const lock = await acquireNativeFileLock(lockPath);
    try {
      await expect(acquireNativeFileLock(lockPath)).rejects.toMatchObject({
        code: 'LOCK_CONFLICT',
        message: expect.stringContaining('already running'),
      });
      await expect(
        acquireNativeFileLock(lockPath, { attempts: 2, retryDelayMs: 0 }),
      ).rejects.toMatchObject({
        code: 'LOCK_CONFLICT',
        message: expect.stringContaining('Timed out'),
      });
      assertPreserved();
    } finally {
      lock.release();
    }
    const reacquired = await acquireNativeFileLock(lockPath);
    try {
      assertPreserved();
    } finally {
      reacquired.release();
    }
    assertPreserved();
  });

  it('returns the native handle itself and retries only the requested number of times', async () => {
    const lock = { release: vi.fn() };
    const acquire = vi.fn().mockReturnValueOnce(null).mockReturnValueOnce(lock);
    vi.spyOn(nativeModule, 'loadOntoIndexNativeModule').mockResolvedValue({
      tryAcquireFileLock: acquire,
    });
    expect(await acquireNativeFileLock('/lock', { attempts: 2, retryDelayMs: 0 })).toBe(lock);
    expect(acquire.mock.calls).toEqual([['/lock'], ['/lock']]);
    expect(lock.release).not.toHaveBeenCalled();
  });

  it('fails closed when loading or the API is unavailable', async () => {
    const load = vi.spyOn(nativeModule, 'loadOntoIndexNativeModule');
    const unavailable = new Error('addon missing');
    load.mockRejectedValueOnce(unavailable);
    await expect(acquireNativeFileLock('/missing-addon')).rejects.toMatchObject({
      message: 'Cannot acquire native file lock: /missing-addon',
      cause: unavailable,
    });
    load.mockResolvedValueOnce({});
    await expect(acquireNativeFileLock('/missing-api')).rejects.toThrow('/missing-api');
  });

  it('rejects unsupported platforms before loading native code', async () => {
    const load = vi.spyOn(nativeModule, 'loadOntoIndexNativeModule');
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
    try {
      Object.defineProperty(process, 'platform', { ...descriptor, value: 'unsupported' });
      await expect(acquireNativeFileLock('/unsupported')).rejects.toThrow(
        'Native file locking requires Linux: /unsupported',
      );
      expect(load).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process, 'platform', descriptor);
    }
  });

  it('stops after the configured attempts when every acquisition contends', async () => {
    const acquire = vi.fn().mockReturnValue(null);
    vi.spyOn(nativeModule, 'loadOntoIndexNativeModule').mockResolvedValue({
      tryAcquireFileLock: acquire,
    });
    await expect(
      acquireNativeFileLock('/busy', { attempts: 3, retryDelayMs: 0 }),
    ).rejects.toMatchObject({
      code: 'LOCK_CONFLICT',
      message: 'Timed out acquiring analysis active mutation lock: /busy',
    });
    expect(acquire).toHaveBeenCalledTimes(3);
  });

  it('fails closed on native errors or malformed handles without retrying', async () => {
    const acquire = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error('permission denied');
      })
      .mockReturnValueOnce(undefined);
    vi.spyOn(nativeModule, 'loadOntoIndexNativeModule').mockResolvedValue({
      tryAcquireFileLock: acquire,
    });
    await expect(acquireNativeFileLock('/denied', { attempts: 3 })).rejects.toThrow('/denied');
    expect(acquire).toHaveBeenCalledTimes(1);
    await expect(acquireNativeFileLock('/bad-handle')).rejects.toThrow('/bad-handle');
    expect(acquire).toHaveBeenCalledTimes(2);
  });

  it.each([0, -1, 1.5, Infinity, NaN])(
    'rejects invalid attempts %s before loading native code',
    async (attempts) => {
      const load = vi.spyOn(nativeModule, 'loadOntoIndexNativeModule');
      await expect(acquireNativeFileLock('/invalid', { attempts })).rejects.toThrow('/invalid');
      expect(load).not.toHaveBeenCalled();
    },
  );

  it.each([-1, Infinity, NaN])(
    'rejects invalid retry delay %s before loading native code',
    async (retryDelayMs) => {
      const load = vi.spyOn(nativeModule, 'loadOntoIndexNativeModule');
      await expect(acquireNativeFileLock('/invalid', { retryDelayMs })).rejects.toThrow('/invalid');
      expect(load).not.toHaveBeenCalled();
    },
  );
});
