import { afterEach, describe, expect, it } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { resolveLocalLbugExtensionPath } from '../../src/core/lbug/lbug-adapter.js';

describe('LadybugDB extension cache lookup', () => {
  const originalDir = process.env.ONTOINDEX_LADYBUG_EXTENSION_DIR;
  const originalCache = process.env.ONTOINDEX_LADYBUG_EXTENSIONS_CACHE;
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const platformDir = (() => {
    const arch = process.arch === 'x64' ? 'amd64' : process.arch;
    if (process.platform === 'linux' || process.platform === 'win32') {
      return `${process.platform}_${arch}`;
    }
    return null;
  })();

  afterEach(() => {
    if (originalDir === undefined) {
      delete process.env.ONTOINDEX_LADYBUG_EXTENSION_DIR;
    } else {
      process.env.ONTOINDEX_LADYBUG_EXTENSION_DIR = originalDir;
    }
    if (originalCache === undefined) {
      delete process.env.ONTOINDEX_LADYBUG_EXTENSIONS_CACHE;
    } else {
      process.env.ONTOINDEX_LADYBUG_EXTENSIONS_CACHE = originalCache;
    }
    if (platformDir) {
      return fs.rm(
        path.join(repoRoot, 'dist', 'ladybugdb-extensions', 'v0.17.0', platformDir),
        { recursive: true, force: true },
      );
    }
  });

  it('finds fts in the installer-populated cache directory', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ontoindex-lbug-ext-'));
    const ftsPath = path.join(dir, 'libfts.lbug_extension');
    const vectorPath = path.join(dir, 'libvector.lbug_extension');
    await fs.writeFile(ftsPath, 'test');
    await fs.writeFile(vectorPath, 'test');

    delete process.env.ONTOINDEX_LADYBUG_EXTENSION_DIR;
    process.env.ONTOINDEX_LADYBUG_EXTENSIONS_CACHE = dir;

    await expect(resolveLocalLbugExtensionPath('fts')).resolves.toBe(ftsPath);
    await expect(resolveLocalLbugExtensionPath('vector')).resolves.toBe(vectorPath);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('finds extensions in the packaged dist directory', async () => {
    if (!platformDir) return;

    const dir = path.join(repoRoot, 'dist', 'ladybugdb-extensions', 'v0.17.0', platformDir);
    const ftsPath = path.join(dir, 'libfts.lbug_extension');
    const vectorPath = path.join(dir, 'libvector.lbug_extension');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(ftsPath, 'test');
    await fs.writeFile(vectorPath, 'test');

    delete process.env.ONTOINDEX_LADYBUG_EXTENSION_DIR;
    delete process.env.ONTOINDEX_LADYBUG_EXTENSIONS_CACHE;

    await expect(resolveLocalLbugExtensionPath('fts')).resolves.toBe(ftsPath);
    await expect(resolveLocalLbugExtensionPath('vector')).resolves.toBe(vectorPath);
  });
});
