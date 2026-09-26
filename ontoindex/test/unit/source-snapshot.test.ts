import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  computeSourceManifest,
  sourceManifestDigest,
} from '../../src/core/indexing/source-manifest.js';
import {
  createSourceSnapshot,
  reapStaleSourceSnapshots,
  resolveSourceSnapshotMode,
  SOURCE_SNAPSHOTS_DIR,
  SourceSnapshotUnavailableError,
} from '../../src/core/indexing/source-snapshot.js';

const HEAD = 'a'.repeat(40);

async function write(root: string, rel: string, content: string | Buffer): Promise<void> {
  await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
  await fs.writeFile(path.join(root, rel), content);
}

describe('createSourceSnapshot', () => {
  let repo: string;
  let storage: string;
  const savedEnv = { ...process.env };

  beforeEach(async () => {
    repo = await fs.mkdtemp(path.join(os.tmpdir(), 'ontoindex-snapshot-'));
    storage = path.join(repo, '.ontoindex');
    await write(repo, 'src/a.ts', 'export const a = 1;\n');
    await write(repo, 'src/nested/b.py', 'def b():\n    return 2\n');
    await write(repo, 'README.md', '# repo\n');
    await write(repo, '.gitignore', 'ignored/\n');
    await write(repo, 'ignored/secret.ts', 'export const s = 0;\n');
    await write(repo, 'node_modules/dep/index.js', 'module.exports = 1;\n');
    await write(repo, '.ontoindex/meta.json', '{}');
    await fs.chmod(path.join(repo, 'src/a.ts'), 0o755);
  });

  afterEach(async () => {
    process.env = { ...savedEnv };
    await fs.rm(repo, { recursive: true, force: true });
  });

  it('reproduces the live manifest exactly and excludes unselected files', async () => {
    const live = await computeSourceManifest(repo, { includePaths: [], pipelineProfile: 'full' });
    const snapshot = await createSourceSnapshot(repo, storage, { head: live.head });
    try {
      expect(sourceManifestDigest(snapshot.manifest)).toBe(sourceManifestDigest(live));
      expect(snapshot.manifest).toEqual(live);
      expect(snapshot.root.startsWith(path.join(storage, SOURCE_SNAPSHOTS_DIR))).toBe(true);
      await expect(fs.stat(path.join(snapshot.root, 'ignored/secret.ts'))).rejects.toThrow();
      await expect(fs.stat(path.join(snapshot.root, 'node_modules'))).rejects.toThrow();
      await expect(fs.stat(path.join(snapshot.root, '.ontoindex'))).rejects.toThrow();
    } finally {
      await snapshot.dispose();
    }
  });

  it('stays frozen while the live tree is edited, added to, and deleted from', async () => {
    const snapshot = await createSourceSnapshot(repo, storage, { head: HEAD });
    try {
      await write(repo, 'src/a.ts', 'export const a = 999;\n');
      await write(repo, 'src/new.ts', 'export const n = 1;\n');
      await fs.rm(path.join(repo, 'README.md'));

      expect(await fs.readFile(path.join(snapshot.root, 'src/a.ts'), 'utf8')).toBe(
        'export const a = 1;\n',
      );
      const again = await computeSourceManifest(snapshot.root, { pipelineProfile: 'full' });
      expect({ ...again, head: HEAD }).toEqual(snapshot.manifest);
      const live = await computeSourceManifest(repo, { pipelineProfile: 'full' });
      expect(live.sourceDigest).not.toBe(snapshot.manifest.sourceDigest);
    } finally {
      await snapshot.dispose();
    }
  });

  it('keeps oversized files out of the copy but preserves their degraded coverage', async () => {
    process.env.ONTOINDEX_SCAN_MAX_FILE_KB = '1';
    await write(repo, 'src/huge.ts', Buffer.alloc(4096, 'x'));
    const live = await computeSourceManifest(repo, { pipelineProfile: 'full' });
    expect(live.coverage).toBe('degraded');

    const snapshot = await createSourceSnapshot(repo, storage, { head: live.head });
    try {
      expect(snapshot.manifest).toEqual(live);
      expect(snapshot.bytes).toBeLessThan(4096);
    } finally {
      await snapshot.dispose();
    }
  });

  it('honours include paths', async () => {
    const live = await computeSourceManifest(repo, {
      includePaths: ['src/nested'],
      pipelineProfile: 'full',
    });
    const snapshot = await createSourceSnapshot(repo, storage, {
      includePaths: ['src/nested'],
      head: live.head,
    });
    try {
      expect(snapshot.manifest).toEqual(live);
      expect(snapshot.fileCount).toBe(1);
    } finally {
      await snapshot.dispose();
    }
  });

  it('refuses sources above the size limit and leaves nothing behind', async () => {
    process.env.ONTOINDEX_ANALYZE_SNAPSHOT_MAX_MB = '0.00001';
    await expect(createSourceSnapshot(repo, storage, { head: HEAD })).rejects.toBeInstanceOf(
      SourceSnapshotUnavailableError,
    );
    expect(await fs.readdir(path.join(storage, SOURCE_SNAPSHOTS_DIR))).toEqual([]);
  });

  it('dispose removes the snapshot', async () => {
    const snapshot = await createSourceSnapshot(repo, storage, { head: HEAD });
    await snapshot.dispose();
    await expect(fs.stat(snapshot.root)).rejects.toThrow();
  });

  it('reaps snapshots of dead processes but keeps live ones', async () => {
    const dir = path.join(storage, SOURCE_SNAPSHOTS_DIR);
    await fs.mkdir(path.join(dir, `${process.pid}-live`), { recursive: true });
    await fs.mkdir(path.join(dir, '4194311-dead'), { recursive: true });
    await fs.mkdir(path.join(dir, 'not-a-snapshot'), { recursive: true });

    expect(await reapStaleSourceSnapshots(dir)).toEqual(['4194311-dead']);
    expect((await fs.readdir(dir)).sort()).toEqual([`${process.pid}-live`, 'not-a-snapshot']);
  });
});

describe('resolveSourceSnapshotMode', () => {
  it('maps the environment switch', () => {
    expect(resolveSourceSnapshotMode(undefined)).toBe('auto');
    expect(resolveSourceSnapshotMode('1')).toBe('always');
    expect(resolveSourceSnapshotMode('always')).toBe('always');
    expect(resolveSourceSnapshotMode('0')).toBe('never');
    expect(resolveSourceSnapshotMode('never')).toBe('never');
    expect(resolveSourceSnapshotMode('auto')).toBe('auto');
  });
});
