import { setTimeout } from 'node:timers/promises';
import { loadOntoIndexNativeModule, type NativeFileLock } from './module.js';

export async function acquireNativeFileLock(
  lockPath: string,
  options: { attempts?: number; retryDelayMs?: number } = {},
): Promise<NativeFileLock> {
  const { attempts = 1, retryDelayMs = 10 } = options;
  if (!Number.isSafeInteger(attempts) || attempts < 1) {
    throw new Error(`Invalid native lock attempts for ${lockPath}: expected a positive integer`);
  }
  if (!Number.isFinite(retryDelayMs) || retryDelayMs < 0) {
    throw new Error(
      `Invalid native lock retry delay for ${lockPath}: expected a nonnegative finite number`,
    );
  }
  if (process.platform !== 'linux') {
    throw new Error(`Native file locking requires Linux: ${lockPath}`);
  }

  try {
    const native = await loadOntoIndexNativeModule();
    if (typeof native.tryAcquireFileLock !== 'function') {
      throw new Error('Native module does not provide tryAcquireFileLock');
    }
    for (let attempt = 0; attempt < attempts; attempt++) {
      const lock = native.tryAcquireFileLock(lockPath);
      if (lock !== null) {
        if (typeof lock?.release !== 'function') {
          throw new Error('Native module returned an invalid file lock handle');
        }
        return lock;
      }
      if (attempt + 1 < attempts) await setTimeout(retryDelayMs);
    }
  } catch (cause) {
    throw new Error(`Cannot acquire native file lock: ${lockPath}`, { cause });
  }

  throw Object.assign(
    new Error(
      attempts === 1
        ? `OntoIndex analyze is already running or analysis mutation lock is held: ${lockPath}`
        : `Timed out acquiring analysis active mutation lock: ${lockPath}`,
    ),
    { code: 'LOCK_CONFLICT' },
  );
}
