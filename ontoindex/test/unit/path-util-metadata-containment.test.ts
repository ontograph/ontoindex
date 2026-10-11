import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveContainedMetadataPath } from '../../src/mcp/local/path-util.js';

describe('resolveContainedMetadataPath', () => {
  let tmpDir: string;
  let root: string;

  beforeEach(async () => {
    tmpDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'metadata-path-')));
    root = path.join(tmpDir, 'metadata');
    await fs.mkdir(path.join(root, 'nested'), { recursive: true });
    await fs.writeFile(path.join(root, 'nested', 'inside.json'), '{}');
    await fs.writeFile(path.join(tmpDir, 'outside.json'), 'outside');
  });

  afterEach(async () => fs.rm(tmpDir, { recursive: true, force: true }));

  it('allows aliases above the trusted root and missing descendants', async () => {
    const alias = path.join(tmpDir, 'root-alias');
    await fs.symlink(root, alias);
    await expect(resolveContainedMetadataPath(alias, 'new/deep/store.json')).resolves.toBe(
      path.join(root, 'new', 'deep', 'store.json'),
    );
  });

  it('rejects symlinked descendants, including in-root redirects and dangling links', async () => {
    await fs.symlink(path.join(root, 'nested'), path.join(root, 'inside-link'));
    await fs.symlink(path.join(tmpDir, 'outside.json'), path.join(root, 'outside-link'));
    await fs.symlink(path.join(tmpDir, 'absent.json'), path.join(root, 'dangling-link'));
    for (const input of ['inside-link/store.json', 'outside-link', 'dangling-link']) {
      await expect(resolveContainedMetadataPath(root, input)).rejects.toThrow(/symbolic link/);
    }
  });

  it('rejects lexical traversal outside the root', async () => {
    await expect(resolveContainedMetadataPath(root, '../outside.json')).rejects.toThrow(/escapes/);
  });

  it('allows the trusted root itself to be missing', async () => {
    const missingRoot = path.join(tmpDir, 'new-metadata-root');
    await expect(resolveContainedMetadataPath(missingRoot, 'store.json')).resolves.toBe(
      path.join(missingRoot, 'store.json'),
    );
  });
});
