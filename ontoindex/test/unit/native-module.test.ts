import { afterEach, describe, expect, it } from 'vitest';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { loadOntoIndexNativeModule } from '../../src/native/module.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const makePackage = (includeAddon: boolean): string => {
  const directory = mkdtempSync(join(tmpdir(), 'ontoindex-native-package-'));
  temporaryDirectories.push(directory);
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ type: 'module' }));
  mkdirSync(join(directory, 'dist', 'native'), { recursive: true });
  cpSync(
    fileURLToPath(new URL('../../dist/native/module.js', import.meta.url)),
    join(directory, 'dist', 'native', 'module.js'),
  );
  if (includeAddon) {
    cpSync(
      fileURLToPath(new URL('../../dist/native/addon', import.meta.url)),
      join(directory, 'dist', 'native', 'addon'),
      { recursive: true },
    );
  }
  return directory;
};

const runPackage = (directory: string, script: string) =>
  spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
    cwd: directory,
    encoding: 'utf8',
    timeout: 10_000,
    maxBuffer: 64 * 1024,
  });

describe('native module loading', () => {
  it('loads the file-lock export through the source loader', async () => {
    const native = await loadOntoIndexNativeModule();
    expect(typeof native.tryAcquireFileLock).toBe('function');
    const directory = mkdtempSync(join(tmpdir(), 'ontoindex-source-loader-'));
    temporaryDirectories.push(directory);
    const lockPath = join(directory, 'owner.lock');
    const lock = native.tryAcquireFileLock!(lockPath);
    expect(lock).not.toBeNull();
    try {
      expect(native.tryAcquireFileLock!(lockPath)).toBeNull();
    } finally {
      lock?.release();
    }
    const reacquired = native.tryAcquireFileLock!(lockPath);
    try {
      expect(reacquired).not.toBeNull();
    } finally {
      reacquired?.release();
    }
  });

  it('loads the packaged addon and acquires a kernel lock outside the checkout', () => {
    const directory = makePackage(true);
    const child = runPackage(
      directory,
      `
      import assert from 'node:assert/strict';
      import { loadOntoIndexNativeModule } from './dist/native/module.js';
      const native = await loadOntoIndexNativeModule();
      assert.equal(typeof native.tryAcquireFileLock, 'function');
      const lock = native.tryAcquireFileLock('owner.lock');
      assert.ok(lock);
      try {
        assert.equal(native.tryAcquireFileLock('owner.lock'), null);
      } finally {
        lock.release();
      }
      const reacquired = native.tryAcquireFileLock('owner.lock');
      assert.ok(reacquired);
      reacquired.release();
      console.log('packaged lock lifecycle passed');
    `,
    );
    expect(child.error, child.stderr).toBeUndefined();
    expect(child.status, child.stderr).toBe(0);
    expect(child.stdout.trim()).toBe('packaged lock lifecycle passed');
  });

  it('rejects loading when the packaged addon is missing', () => {
    const directory = makePackage(false);
    const child = runPackage(
      directory,
      `
      import { loadOntoIndexNativeModule } from './dist/native/module.js';
      await loadOntoIndexNativeModule();
    `,
    );
    expect(child.error, child.stderr).toBeUndefined();
    expect(child.status, child.stderr).not.toBe(0);
    expect(child.stderr).toMatch(/MODULE_NOT_FOUND|Cannot find module/);
  });
});
