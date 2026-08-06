import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  computeSourceManifest,
  manifestsMatch,
  sourceInputsMatch,
} from '../../src/core/indexing/source-manifest.js';

const roots: string[] = [];

async function makeRepo(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ontoindex-manifest-'));
  roots.push(root);
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('source manifest', () => {
  it('uses locale-independent code-unit ordering', async () => {
    const repo = await makeRepo();
    await fs.writeFile(path.join(repo, 'src', 'z.ts'), 'z\n');
    await fs.writeFile(path.join(repo, 'src', 'A.ts'), 'A\n');
    const expected = createHash('sha256');
    for (const [relativePath, content] of [
      ['src/A.ts', 'A\n'],
      ['src/z.ts', 'z\n'],
    ]) {
      expected.update(String(Buffer.byteLength(relativePath, 'utf8')));
      expected.update(':');
      expected.update(relativePath);
      expected.update('\0regular\0');
      expected.update(createHash('sha256').update(content).digest('hex'));
      expected.update('\n');
    }

    await expect(computeSourceManifest(repo)).resolves.toMatchObject({
      sourceDigest: expected.digest('hex'),
      sourceEntryCount: 2,
    });
  });

  it('changes identity for content, deletion, untracked input, and executable mode changes', async () => {
    const repo = await makeRepo();
    const sourcePath = path.join(repo, 'src', 'tool.ts');
    await fs.writeFile(sourcePath, 'export const value = 1;\n');
    const initial = await computeSourceManifest(repo);

    await fs.writeFile(sourcePath, 'export const value = 2;\n');
    const contentChanged = await computeSourceManifest(repo);
    expect(contentChanged.sourceDigest).not.toBe(initial.sourceDigest);

    await fs.chmod(sourcePath, 0o755);
    const executableChanged = await computeSourceManifest(repo);
    if (process.platform === 'win32') {
      expect(executableChanged.sourceDigest).toBe(contentChanged.sourceDigest);
    } else {
      expect(executableChanged.sourceDigest).not.toBe(contentChanged.sourceDigest);
    }

    await fs.writeFile(path.join(repo, 'src', 'new.ts'), 'export const added = true;\n');
    const untrackedAdded = await computeSourceManifest(repo);
    expect(untrackedAdded.sourceEntryCount).toBe(executableChanged.sourceEntryCount + 1);
    expect(untrackedAdded.sourceDigest).not.toBe(executableChanged.sourceDigest);

    await fs.rm(sourcePath);
    const deleted = await computeSourceManifest(repo);
    expect(deleted.sourceDigest).not.toBe(untrackedAdded.sourceDigest);
  });

  it('ignores excluded inputs and binds include paths, profile, and ignore policy', async () => {
    const repo = await makeRepo();
    await fs.writeFile(path.join(repo, '.gitignore'), 'ignored.ts\n');
    await fs.writeFile(path.join(repo, 'ignored.ts'), 'ignored one\n');
    await fs.writeFile(path.join(repo, 'src', 'main.ts'), 'included\n');

    const full = await computeSourceManifest(repo);
    await fs.writeFile(path.join(repo, 'ignored.ts'), 'ignored two\n');
    expect(await computeSourceManifest(repo)).toMatchObject({ sourceDigest: full.sourceDigest });

    const scoped = await computeSourceManifest(repo, { includePaths: ['src'] });
    const symbols = await computeSourceManifest(repo, {
      includePaths: ['src'],
      pipelineProfile: 'symbols',
    });
    expect(scoped.scopeDigest).not.toBe(full.scopeDigest);
    expect(symbols.scopeDigest).not.toBe(scoped.scopeDigest);

    await fs.writeFile(path.join(repo, '.gitignore'), 'ignored.ts\nother.ts\n');
    const changedPolicy = await computeSourceManifest(repo);
    expect(changedPolicy.ignorePolicyDigest).not.toBe(full.ignorePolicyDigest);
    expect(changedPolicy.scopeDigest).not.toBe(full.scopeDigest);
  });

  it('is deterministic across checkout paths and distinguishes coverage from source identity', async () => {
    const left = await makeRepo();
    const right = await makeRepo();
    for (const root of [left, right]) {
      await fs.writeFile(path.join(root, 'src', 'b.ts'), 'b\n');
      await fs.writeFile(path.join(root, 'src', 'a.ts'), 'a\n');
    }

    const leftManifest = await computeSourceManifest(left);
    const rightManifest = await computeSourceManifest(right);
    expect(leftManifest.sourceDigest).toBe(rightManifest.sourceDigest);
    expect(leftManifest.scopeDigest).toBe(rightManifest.scopeDigest);

    const degraded = await computeSourceManifest(left, { degradedPaths: ['src/a.ts'] });
    expect(sourceInputsMatch(leftManifest, degraded)).toBe(true);
    expect(manifestsMatch(leftManifest, degraded)).toBe(false);
    expect(degraded.coverage).toBe('degraded');
    expect(degraded.degradedInputsDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it('degrades coverage when the canonical scanner excludes an oversized input', async () => {
    const repo = await makeRepo();
    const previous = process.env.ONTOINDEX_SCAN_MAX_FILE_KB;
    process.env.ONTOINDEX_SCAN_MAX_FILE_KB = '1';
    try {
      await fs.writeFile(path.join(repo, 'src', 'large.ts'), 'x'.repeat(2048));
      const manifest = await computeSourceManifest(repo);
      expect(manifest.coverage).toBe('degraded');
      expect(manifest.sourceEntryCount).toBe(0);
      expect(manifest.degradedInputsDigest).toMatch(/^[a-f0-9]{64}$/);
    } finally {
      if (previous === undefined) delete process.env.ONTOINDEX_SCAN_MAX_FILE_KB;
      else process.env.ONTOINDEX_SCAN_MAX_FILE_KB = previous;
    }
  });
});
