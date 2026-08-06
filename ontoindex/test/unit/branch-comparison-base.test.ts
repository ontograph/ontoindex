import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { resolveBranchComparisonBase } from '../../src/storage/git.js';

const roots: string[] = [];

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

async function makeRepo(initialBranch = 'trunk'): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ontoindex-branch-base-'));
  roots.push(root);
  git(root, ['init', '-b', initialBranch]);
  git(root, ['config', 'user.email', 'test@example.com']);
  git(root, ['config', 'user.name', 'Test']);
  await fs.writeFile(path.join(root, 'README.md'), 'base\n');
  git(root, ['add', 'README.md']);
  git(root, ['commit', '-m', 'base']);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('resolveBranchComparisonBase', () => {
  it('prefers an explicitly configured default branch', async () => {
    const repo = await makeRepo();
    git(repo, ['branch', 'integration']);
    git(repo, ['config', 'ontoindex.defaultBranch', 'integration']);

    expect(resolveBranchComparisonBase(repo)).toMatchObject({
      ref: 'integration',
      source: 'config',
      range: 'integration...HEAD',
    });
  });

  it('falls back to master when main is absent', async () => {
    const repo = await makeRepo('master');
    git(repo, ['switch', '-c', 'feature']);

    expect(resolveBranchComparisonBase(repo)).toMatchObject({
      ref: 'master',
      source: 'master',
      range: 'master...HEAD',
    });
  });

  it('does not infer a feature branch upstream and fails actionably without a base', async () => {
    const repo = await makeRepo('feature');

    expect(() => resolveBranchComparisonBase(repo)).toThrow(
      'Pass an explicit commit range or configure ontoindex.defaultBranch',
    );
  });
});
