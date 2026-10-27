import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadImportConfigs } from '../../src/core/ingestion/language-config.js';

const basenames = ['pyproject.toml', 'setup.cfg', 'compile_commands.json', 'CMakeLists.txt'];

describe('native packaging and build config observations', () => {
  let root: string;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'native-config-observations-'));
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it.each(basenames.flatMap((name) => [name, `nested/${name}`]))(
    'tracks edits, deletion and byte restoration for %s without changing configs',
    async (relativePath) => {
      const filename = path.join(root, relativePath);
      // Keep the inventory stable to exercise presence/absence of the same candidate.
      const inventory = [relativePath];
      await fs.mkdir(path.dirname(filename), { recursive: true });
      const { observations: absent, ...expectedConfigs } = await loadImportConfigs(root, inventory);
      expect(absent).toMatchObject({ complete: true, digest: expect.any(String) });
      expect(absent!.records).toContainEqual({
        kind: 'file',
        path: relativePath,
        status: 'absent',
        errorCode: 'ENOENT',
      });

      const originalBytes = Buffer.from('# native config\n');
      await fs.writeFile(filename, originalBytes);
      const { observations: original, ...originalConfigs } = await loadImportConfigs(
        root,
        inventory,
      );
      expect(originalConfigs).toEqual(expectedConfigs);
      expect(original).toMatchObject({ complete: true, digest: expect.any(String) });
      expect(original!.digest).not.toBe(absent!.digest);

      await fs.writeFile(filename, '# edited native config\n');
      const { observations: edited, ...editedConfigs } = await loadImportConfigs(root, inventory);
      expect(editedConfigs).toEqual(expectedConfigs);
      expect(edited).toMatchObject({ complete: true, digest: expect.any(String) });
      expect(edited!.digest).not.toBe(original!.digest);

      await fs.unlink(filename);
      const { observations: deleted, ...deletedConfigs } = await loadImportConfigs(root, inventory);
      expect(deletedConfigs).toEqual(expectedConfigs);
      expect(deleted!.digest).not.toBe(original!.digest);
      expect(deleted).toEqual(absent);

      await fs.writeFile(filename, originalBytes);
      const { observations: restored, ...restoredConfigs } = await loadImportConfigs(
        root,
        inventory,
      );
      expect(restoredConfigs).toEqual(expectedConfigs);
      expect(restored).toEqual(original);
    },
  );

  it('rejects noncanonical inventory paths before observing nested configs', async () => {
    const { observations } = await loadImportConfigs(root, [
      '../pyproject.toml',
      '/tmp/setup.cfg',
      'nested/../compile_commands.json',
      'nested\\CMakeLists.txt',
      'C:/setup.cfg',
      'nested/\0pyproject.toml',
    ]);
    expect(observations).toMatchObject({ complete: true, digest: expect.any(String) });
    expect(
      observations!.records
        .filter(
          (record) =>
            record.kind === 'file' && basenames.includes(path.posix.basename(record.path)),
        )
        .map((record) => record.path)
        .sort(),
    ).toEqual([...basenames].sort());
  });
});
