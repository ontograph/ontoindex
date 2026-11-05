import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { planDirtyOverlay, workingTreeMatchesHead } from '../../src/core/analyze-delta.js';
import { isOwnGitignoreEdit } from '../../src/core/run-analyze.js';

function git(repo: string, ...args: string[]): void {
  const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  expect(result.status, result.stderr).toBe(0);
}

describe('working tree provenance', () => {
  it.each(['--assume-unchanged', '--skip-worktree'])(
    'includes present files hidden by %s and ignores absent sparse entries',
    async (flag) => {
      const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'source-provenance-flags-'));
      try {
        git(repo, 'init', '--quiet');
        for (const file of ['source.ts', 'absent.ts', 'ignored.ts', 'notes.txt']) {
          fs.writeFileSync(path.join(repo, file), 'baseline');
        }
        fs.writeFileSync(path.join(repo, '.ontoindexignore'), 'ignored.ts\n');
        git(repo, 'add', '.');
        git(
          repo,
          '-c',
          'user.name=t',
          '-c',
          'user.email=t@t',
          'commit',
          '--quiet',
          '-m',
          'baseline',
        );
        git(repo, 'update-index', flag, 'source.ts', 'ignored.ts', 'notes.txt');
        git(repo, 'update-index', '--skip-worktree', 'absent.ts');
        fs.unlinkSync(path.join(repo, 'absent.ts'));
        fs.writeFileSync(path.join(repo, 'source.ts'), 'edited');
        fs.writeFileSync(path.join(repo, 'ignored.ts'), 'edited');
        const status = spawnSync('git', ['status', '--porcelain=v1'], {
          cwd: repo,
          encoding: 'utf8',
        });
        expect(status.status, status.stderr).toBe(0);
        expect(status.stdout).toBe('');
        expect(await workingTreeMatchesHead(repo)).toEqual({
          clean: false,
          changedPathCount: 2,
          changedPaths: ['notes.txt', 'source.ts'],
        });
        expect(await planDirtyOverlay(repo)).toMatchObject({
          includePaths: ['source.ts'],
          allDirtyPaths: ['source.ts'],
          tombstones: [],
        });
      } finally {
        fs.rmSync(repo, { recursive: true, force: true });
      }
    },
  );

  it.each([
    ['clean', (_repo: string) => {}, 0],
    [
      'modified tracked',
      (repo: string) => fs.writeFileSync(path.join(repo, 'source.ts'), 'changed'),
      1,
    ],
    ['untracked', (repo: string) => fs.writeFileSync(path.join(repo, 'new.ts'), 'new'), 1],
    ['deleted', (repo: string) => fs.unlinkSync(path.join(repo, 'source.ts')), 1],
    [
      'staged-only',
      (repo: string) => {
        fs.writeFileSync(path.join(repo, 'source.ts'), 'staged');
        git(repo, 'add', 'source.ts');
      },
      1,
    ],
    ['renamed', (repo: string) => git(repo, 'mv', 'source.ts', 'renamed.ts'), 2],
    [
      'ignored-only',
      (repo: string) => fs.writeFileSync(path.join(repo, 'ignored.txt'), 'ignored'),
      0,
    ],
    ['non-source', (repo: string) => fs.writeFileSync(path.join(repo, 'notes.txt'), 'changed'), 1],
  ])('%s', async (_name, change, count) => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'source-provenance-'));
    try {
      git(repo, 'init', '--quiet');
      git(repo, 'config', 'user.name', 'Test');
      git(repo, 'config', 'user.email', 'test@example.com');
      fs.writeFileSync(path.join(repo, 'source.ts'), 'baseline');
      fs.writeFileSync(path.join(repo, 'notes.txt'), 'baseline');
      fs.writeFileSync(path.join(repo, '.ontoindexignore'), 'ignored.txt\n');
      git(repo, 'add', '.');
      git(repo, 'commit', '--quiet', '-m', 'baseline');
      change(repo);
      const result = await workingTreeMatchesHead(repo);
      expect(result.clean).toBe(count === 0);
      expect(result.changedPathCount).toBe(count);
      expect(result.changedPaths).toHaveLength(count);
      expect(result.changedPaths).toEqual([...result.changedPaths].sort());
      if (_name === 'renamed') expect(result.changedPaths).toEqual(['renamed.ts', 'source.ts']);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it.each([
    ['committed file', 'node_modules\n', 'node_modules\n.ontoindex\n', true],
    ['missing file', undefined, '.ontoindex\n', true],
    ['user addition', 'node_modules\n', 'node_modules\n.ontoindex\nuser\n', false],
  ])('recognizes own gitignore edit: %s', async (_name, committed, current, expected) => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'source-provenance-'));
    try {
      git(repo, 'init', '--quiet');
      git(repo, 'config', 'user.name', 'Test');
      git(repo, 'config', 'user.email', 'test@example.com');
      fs.writeFileSync(path.join(repo, 'source.ts'), 'baseline');
      if (committed !== undefined) fs.writeFileSync(path.join(repo, '.gitignore'), committed);
      git(repo, 'add', '.');
      git(repo, 'commit', '--quiet', '-m', 'baseline');
      fs.writeFileSync(path.join(repo, '.gitignore'), current);
      expect(await isOwnGitignoreEdit(repo)).toBe(expected);
      expect((await workingTreeMatchesHead(repo)).changedPaths).toContain('.gitignore');
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});
