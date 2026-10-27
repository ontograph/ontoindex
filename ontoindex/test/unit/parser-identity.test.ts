import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runtimeArtifactIdentity } from '../../src/core/tree-sitter/parser-identity.js';

const fixtures: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    fixtures.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ontoindex-parser-artifacts-'));
  fixtures.push(root);
  const runtime = path.join(root, 'runtime');
  const shared = path.join(root, 'shared');
  await fs.mkdir(path.join(runtime, 'processing'), { recursive: true });
  await fs.mkdir(shared);
  const processor = path.join(runtime, 'processing/processor.js');
  const sharedFile = path.join(shared, 'types.js');
  await fs.writeFile(processor, 'first');
  await fs.writeFile(sharedFile, 'first');
  const manifest = path.join(root, 'package.json');
  await fs.writeFile(manifest, '{}');
  const roots = [
    ['runtime', runtime],
    ['shared', shared],
  ] as const;
  return {
    root,
    runtime,
    shared,
    processor,
    sharedFile,
    manifest,
    roots,
    identity: () => runtimeArtifactIdentity(roots, manifest),
  };
}

describe('parser runtime disk artifact identity', () => {
  it('observes processor, shared, package and map/native bytes on every invocation', async () => {
    const value = await fixture();
    let previous = await value.identity();
    for (const file of [
      value.processor,
      value.sharedFile,
      value.manifest,
      path.join(value.runtime, 'code.js.map'),
      path.join(value.runtime, 'addon.node'),
    ]) {
      await fs.writeFile(file, 'other');
      const changed = await value.identity();
      expect(changed).not.toBe(previous);
      expect(await value.identity()).toBe(changed);
      previous = changed;
    }
  });

  it('binds add/remove/rename membership and ignores root and enumeration order', async () => {
    const first = await fixture();
    const second = await fixture();
    const initial = await first.identity();
    expect(await second.identity()).toBe(initial);
    expect(await runtimeArtifactIdentity([...first.roots].reverse(), first.manifest)).toBe(initial);
    const added = path.join(first.runtime, 'added.js');
    await fs.writeFile(added, 'other');
    expect(await first.identity()).not.toBe(initial);
    await fs.rm(added);
    expect(await first.identity()).toBe(initial);
    await fs.rename(first.processor, path.join(first.runtime, 'processing/renamed.js'));
    expect(await first.identity()).not.toBe(initial);
  });

  it.each(['file', 'directory', 'root'])('refuses %s symlinks', async (kind) => {
    const value = await fixture();
    const link = kind === 'root' ? value.shared : path.join(value.runtime, 'link');
    if (kind === 'root') await fs.rm(value.shared, { recursive: true });
    await fs.symlink(kind === 'file' ? value.sharedFile : value.root, link);
    await expect(value.identity()).rejects.toThrow(/regular file|directory/);
  });

  it('refuses special files without opening them', async () => {
    const value = await fixture();
    const original = fs.lstat;
    vi.spyOn(fs, 'lstat').mockImplementation((async (...args: Parameters<typeof fs.lstat>) => {
      const stat = await original(...args);
      if (args[0] === value.processor)
        return Object.assign(stat, {
          isFile: () => false,
          isDirectory: () => false,
        });
      return stat;
    }) as typeof fs.lstat);
    await expect(value.identity()).rejects.toThrow(/regular file/);
  });

  it('refuses per-file and aggregate byte limits before reading', async () => {
    const value = await fixture();
    const file = await fs.open(value.processor, 'w');
    await file.truncate(32 * 1024 * 1024 + 1);
    await file.close();
    await expect(value.identity()).rejects.toThrow(/byte limit/);
    await fs.rm(value.processor);
    for (let index = 0; index < 5; index++) {
      const sparse = await fs.open(path.join(value.runtime, `${index}.node`), 'w');
      await sparse.truncate(32 * 1024 * 1024);
      await sparse.close();
    }
    await expect(value.identity()).rejects.toThrow(/byte limit/);
  });

  it('refuses excessive depth', async () => {
    const value = await fixture();
    await fs.mkdir(path.join(value.runtime, ...Array(33).fill('deep')), { recursive: true });
    await expect(value.identity()).rejects.toThrow(/inventory limit/);
  });

  it('refuses excessive entries while enumerating', async () => {
    const value = await fixture();
    const original = fs.opendir;
    vi.spyOn(fs, 'opendir').mockImplementation((async (...args: Parameters<typeof fs.opendir>) => {
      if (args[0] === value.runtime)
        return {
          async *[Symbol.asyncIterator]() {
            for (let index = 0; index < 10_001; index++) yield { name: 'processing' };
          },
        };
      return original(...args);
    }) as typeof fs.opendir);
    await expect(value.identity()).rejects.toThrow(/inventory limit/);
  });

  it.each(['replace', 'mutate', 'add'])('refuses %s during a streamed read', async (change) => {
    const value = await fixture();
    const original = fs.open;
    vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await original(...args);
      if (args[0] === value.processor) {
        const read = handle.read.bind(handle);
        let changed = false;
        vi.spyOn(handle, 'read').mockImplementation((async (
          ...readArgs: Parameters<typeof handle.read>
        ) => {
          const result = await read(...readArgs);
          if (!changed) {
            changed = true;
            if (change === 'replace') {
              await fs.rename(value.processor, `${value.processor}.old`);
              await fs.writeFile(value.processor, 'first');
            } else if (change === 'mutate') {
              await fs.writeFile(value.processor, 'other');
              // Same-size rewrite: force a distinct mtime so detection does not depend on the
              // filesystem timestamp tick between creation and rewrite.
              await fs.utimes(value.processor, new Date(0), new Date(0));
            } else await fs.writeFile(path.join(value.runtime, 'new.js'), 'new');
          }
          return result;
        }) as typeof handle.read);
      }
      return handle;
    });
    await expect(value.identity()).rejects.toThrow(/changed/);
  });
});
