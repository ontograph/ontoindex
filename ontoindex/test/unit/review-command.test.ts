import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { reviewDiffCommand } from '../../src/cli/review.js';
import { registerRepo } from '../../src/storage/repo-manager.js';
import { createTempDir, type TestDBHandle } from '../helpers/test-db.js';

describe('reviewDiffCommand repository binding', () => {
  let cwdRepo: TestDBHandle;
  let targetRepo: TestDBHandle;
  let home: TestDBHandle;
  let originalCwd: string;
  let originalHome: string | undefined;

  async function initRepo(repoPath: string, fileName: string): Promise<void> {
    execFileSync('git', ['init', '--quiet'], { cwd: repoPath });
    execFileSync('git', ['config', 'user.name', 'OntoIndex Test'], { cwd: repoPath });
    execFileSync('git', ['config', 'user.email', 'ontoindex-test@example.com'], {
      cwd: repoPath,
    });
    execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: repoPath });
    await fs.mkdir(path.join(repoPath, 'src'), { recursive: true });
    await fs.writeFile(path.join(repoPath, 'src', fileName), 'export const value = 1;\n');
    execFileSync('git', ['add', '-A'], { cwd: repoPath });
    execFileSync('git', ['commit', '--quiet', '-m', 'initial'], { cwd: repoPath });
  }

  beforeEach(async () => {
    cwdRepo = await createTempDir('ontoindex-review-cwd-');
    targetRepo = await createTempDir('ontoindex-review-target-');
    home = await createTempDir('ontoindex-review-home-');
    originalCwd = process.cwd();
    originalHome = process.env.ONTOINDEX_HOME;
    process.env.ONTOINDEX_HOME = home.dbPath;
    await initRepo(cwdRepo.dbPath, 'cwd.ts');
    await initRepo(targetRepo.dbPath, 'target.ts');
    await registerRepo(
      targetRepo.dbPath,
      {
        repoPath: '.',
        lastCommit: execFileSync('git', ['rev-parse', 'HEAD'], {
          cwd: targetRepo.dbPath,
          encoding: 'utf8',
        }).trim(),
        indexedAt: '2026-08-05T00:00:00.000Z',
      },
      { name: 'review-target' },
    );
    await fs.writeFile(
      path.join(targetRepo.dbPath, 'src', 'target.ts'),
      'export const value = 2;\n',
    );
    execFileSync('git', ['add', 'src/target.ts'], { cwd: targetRepo.dbPath });
    process.chdir(cwdRepo.dbPath);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    if (originalHome === undefined) delete process.env.ONTOINDEX_HOME;
    else process.env.ONTOINDEX_HOME = originalHome;
    process.exitCode = undefined;
    await cwdRepo.cleanup();
    await targetRepo.cleanup();
    await home.cleanup();
  });

  it('uses the explicitly selected repository for Git diff and provenance', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await reviewDiffCommand({ repo: 'review-target', staged: true, json: true });
      const output = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0])) as {
        targetContext: { repoPath?: string };
        results: { reviewedFiles: Array<{ path: string }> };
      };
      expect(output.targetContext.repoPath).toBe(await fs.realpath(targetRepo.dbPath));
      expect(output.results.reviewedFiles.map((file) => file.path)).toEqual(['src/target.ts']);
    } finally {
      logSpy.mockRestore();
    }
  });

  it('fails closed for an unknown explicit repository', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await reviewDiffCommand({ repo: 'missing-review-target', staged: true, json: true });
      expect(process.exitCode).toBe(1);
      expect(errorSpy.mock.calls.flat().join('\n')).toContain('missing-review-target');
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('binds graph authority to the reviewed range endpoint', async () => {
    const firstCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: targetRepo.dbPath,
      encoding: 'utf8',
    }).trim();
    execFileSync('git', ['commit', '--quiet', '-m', 'second'], { cwd: targetRepo.dbPath });
    const secondCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: targetRepo.dbPath,
      encoding: 'utf8',
    }).trim();
    await fs.writeFile(
      path.join(targetRepo.dbPath, 'src', 'third.ts'),
      'export const third = 3;\n',
    );
    execFileSync('git', ['add', 'src/third.ts'], { cwd: targetRepo.dbPath });
    execFileSync('git', ['commit', '--quiet', '-m', 'third'], { cwd: targetRepo.dbPath });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await reviewDiffCommand({
        repo: 'review-target',
        range: `${firstCommit}..${secondCommit}`,
        json: true,
      });
      const output = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0])) as {
        targetContext: { targetRef: string; targetHead?: string; currentHead?: string };
        freshness: { status: string; actionable: boolean; reason: string };
      };
      expect(output.targetContext).toMatchObject({
        targetRef: secondCommit,
        targetHead: secondCommit,
      });
      expect(output.targetContext.currentHead).not.toBe(secondCommit);
      expect(output.freshness).toMatchObject({
        status: 'stale',
        actionable: false,
        reason: 'graph authority describes current checkout, not requested target ref',
      });
    } finally {
      logSpy.mockRestore();
    }
  });
});
