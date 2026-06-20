import { afterEach, describe, expect, it } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { resolveLocalLbugExtensionPath } from '../../src/core/lbug/lbug-adapter.js';

describe('LadybugDB extension cache lookup', () => {
  const originalDir = process.env.ONTOINDEX_LADYBUG_EXTENSION_DIR;
  const originalCache = process.env.ONTOINDEX_LADYBUG_EXTENSIONS_CACHE;

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
  });

  it('finds fts in the installer-populated cache directory', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ontoindex-lbug-ext-'));
    const ftsPath = path.join(dir, 'libfts.lbug_extension');
    await fs.writeFile(ftsPath, 'test');

    delete process.env.ONTOINDEX_LADYBUG_EXTENSION_DIR;
    process.env.ONTOINDEX_LADYBUG_EXTENSIONS_CACHE = dir;

    await expect(resolveLocalLbugExtensionPath('fts')).resolves.toBe(ftsPath);
    await fs.rm(dir, { recursive: true, force: true });
  });
});
