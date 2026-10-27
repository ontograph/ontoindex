import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { syncPath, syncTree } from '../../src/core/durable-publish.js';

describe('durable publication sync', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'durable-publish-'));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('syncs nested files and directories', async () => {
    await fs.mkdir(path.join(root, 'nested', 'child'), { recursive: true });
    await fs.writeFile(path.join(root, 'base.json'), '{}');
    await fs.writeFile(path.join(root, 'nested', 'child', 'database'), 'data');

    await expect(syncTree(root)).resolves.toBeUndefined();
  });

  it('rejects a missing root', async () => {
    await expect(syncTree(path.join(root, 'missing'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('supports best-effort directory sync', async () => {
    await expect(syncPath(root, { bestEffort: true })).resolves.toBeUndefined();
  });
});
