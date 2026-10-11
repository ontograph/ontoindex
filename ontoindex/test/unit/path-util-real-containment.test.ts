import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveContainedRealPath } from '../../src/mcp/local/path-util.js';

describe('resolveContainedRealPath', () => {
  let tmpDir: string;
  let repoDir: string;

  beforeEach(async () => {
    tmpDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'gn-real-path-')));
    repoDir = path.join(tmpDir, 'repo');
    await fs.mkdir(path.join(repoDir, 'src'), { recursive: true });
    await fs.writeFile(path.join(repoDir, 'src', 'inside.ts'), 'inside\n');
    await fs.writeFile(path.join(tmpDir, 'outside.ts'), 'outside\n');
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('rejects a file symlink that points outside the repository', async () => {
    await fs.symlink(path.join(tmpDir, 'outside.ts'), path.join(repoDir, 'link.ts'));
    await expect(resolveContainedRealPath(repoDir, 'link.ts')).rejects.toThrow(/escapes/);
  });

  it('rejects a path through a directory symlink that points outside', async () => {
    await fs.symlink(tmpDir, path.join(repoDir, 'up'));
    await expect(resolveContainedRealPath(repoDir, 'up/outside.ts')).rejects.toThrow(/escapes/);
  });

  it('allows a symlink whose target stays inside the repository', async () => {
    await fs.symlink(path.join(repoDir, 'src', 'inside.ts'), path.join(repoDir, 'alias.ts'));
    await expect(resolveContainedRealPath(repoDir, 'alias.ts')).resolves.toBe(
      path.join(repoDir, 'src', 'inside.ts'),
    );
  });

  it('accepts an absolute alias path when the resolved target stays inside the repository', async () => {
    await fs.symlink(path.join(repoDir, 'src', 'inside.ts'), path.join(repoDir, 'alias.ts'));
    await expect(resolveContainedRealPath(repoDir, path.join(repoDir, 'alias.ts'))).resolves.toBe(
      path.join(repoDir, 'src', 'inside.ts'),
    );
  });

  it('rejects a dangling symlink instead of resolving it as a new in-repo file', async () => {
    await fs.symlink(path.join(tmpDir, 'not-created.ts'), path.join(repoDir, 'dangling.ts'));
    await expect(resolveContainedRealPath(repoDir, 'dangling.ts')).rejects.toThrow();
  });

  it('resolves nested missing targets beneath the nearest existing in-repo ancestor', async () => {
    await expect(resolveContainedRealPath(repoDir, 'src/new/deep/file.ts')).resolves.toBe(
      path.join(repoDir, 'src', 'new', 'deep', 'file.ts'),
    );
  });

  it('still rejects lexical traversal', async () => {
    await expect(resolveContainedRealPath(repoDir, '../outside.ts')).rejects.toThrow(/escapes/);
  });

  it('resolves a missing file inside the repository so callers can report not found', async () => {
    await expect(resolveContainedRealPath(repoDir, 'src/missing.ts')).resolves.toBe(
      path.join(repoDir, 'src', 'missing.ts'),
    );
  });
});
