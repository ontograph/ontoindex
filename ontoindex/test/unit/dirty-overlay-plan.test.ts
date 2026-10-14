import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { planDirtyOverlay } from '../../src/core/analyze-delta.js';

function runGit(repoPath: string, args: string[]): string {
  const result = spawnSync('git', args, { cwd: repoPath, encoding: 'utf8' });
  expect(result.status).toBe(0);
  return String(result.stdout ?? '').trim();
}

function initGitRepo(repoPath: string): void {
  runGit(repoPath, ['init', '--quiet']);
  runGit(repoPath, ['config', 'user.name', 'OntoIndex Test']);
  runGit(repoPath, ['config', 'user.email', 'test@example.com']);
}

function writeFile(repoPath: string, relativePath: string, contents: string): void {
  const fullPath = path.join(repoPath, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, contents, 'utf8');
}

function commitFiles(repoPath: string): void {
  runGit(repoPath, ['add', '.']);
  runGit(repoPath, ['commit', '--quiet', '-m', 'baseline']);
}

function withGitRepo(test: (repoPath: string) => Promise<void>): () => Promise<void> {
  return async () => {
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-dirty-overlay-'));
    try {
      initGitRepo(repoDir);
      await test(repoDir);
    } finally {
      fs.rmSync(repoDir, { recursive: true, force: true });
    }
  };
}

describe('dirty overlay planner', () => {
  it(
    'includes modified, added, and untracked sources and tombstones deleted and renamed-away sources',
    withGitRepo(async (repoDir) => {
      writeFile(repoDir, 'modified.ts', 'const before = 1;\n');
      writeFile(repoDir, 'deleted.py', 'print("delete")\n');
      writeFile(repoDir, 'rename-old.js', 'const value = "same content";\n');
      writeFile(repoDir, 'rename-non-source.txt', 'old text\n');
      commitFiles(repoDir);

      writeFile(repoDir, 'modified.ts', 'const after = 2;\n');
      writeFile(repoDir, 'added.rs', 'fn added() {}\n');
      writeFile(repoDir, 'untracked with spaces.go', 'package main\n');
      fs.unlinkSync(path.join(repoDir, 'deleted.py'));
      runGit(repoDir, ['mv', 'rename-old.js', 'renamed-new.js']);
      runGit(repoDir, ['mv', 'rename-non-source.txt', 'renamed-non-source.txt']);

      const plan = await planDirtyOverlay(repoDir);

      expect(plan).toEqual({
        includePaths: ['added.rs', 'modified.ts', 'renamed-new.js', 'untracked with spaces.go'],
        uncoveredPaths: [],
        allDirtyPaths: [
          'added.rs',
          'deleted.py',
          'modified.ts',
          'rename-old.js',
          'renamed-new.js',
          'untracked with spaces.go',
        ],
        tombstones: ['deleted.py', 'rename-old.js'],
        tooMany: false,
        skipped: ['rename-non-source.txt', 'renamed-non-source.txt'],
      });
    }),
  );

  it(
    'covers the 50 newest dirty files and reports the rest as uncovered',
    withGitRepo(async (repoDir) => {
      writeFile(repoDir, 'src/deleted.ts', 'export const deleted = true;\n');
      commitFiles(repoDir);
      fs.unlinkSync(path.join(repoDir, 'src/deleted.ts'));
      for (let index = 0; index < 75; index += 1) {
        writeFile(repoDir, `src/file-${index}.ts`, `export const value${index} = ${index};\n`);
        const mtime = new Date(1_700_000_000_000 + index * 1_000);
        fs.utimesSync(path.join(repoDir, `src/file-${index}.ts`), mtime, mtime);
      }

      const plan = await planDirtyOverlay(repoDir);

      expect(plan.tooMany).toBe(true);
      expect(plan.includePaths).toEqual(
        Array.from({ length: 50 }, (_, index) => `src/file-${74 - index}.ts`),
      );
      expect(plan.uncoveredPaths).toEqual(
        Array.from({ length: 25 }, (_, index) => `src/file-${index}.ts`).sort(),
      );
      expect(plan.tombstones).toEqual(['src/deleted.ts']);
      expect(plan.allDirtyPaths).toHaveLength(76);
      expect(plan.skipped).toEqual([]);
    }),
  );

  it(
    'ignores non-source dirty files and includes source files with imports and exports',
    withGitRepo(async (repoDir) => {
      writeFile(repoDir, 'notes.md', 'baseline\n');
      writeFile(repoDir, 'module.ts', 'const before = 1;\n');
      commitFiles(repoDir);
      writeFile(repoDir, 'notes.md', 'changed\n');
      writeFile(repoDir, 'module.ts', "import { value } from './value.js';\nexport { value };\n");

      const plan = await planDirtyOverlay(repoDir);

      expect(plan.includePaths).toEqual(['module.ts']);
      expect(plan.uncoveredPaths).toEqual([]);
      expect(plan.allDirtyPaths).toEqual(['module.ts']);
      expect(plan.tombstones).toEqual([]);
      expect(plan.tooMany).toBe(false);
      expect(plan.skipped).toEqual(['notes.md']);
    }),
  );

  it(
    'treats staged-add/worktree-delete and delete/modify conflicts as tombstones',
    withGitRepo(async (repoDir) => {
      writeFile(repoDir, 'conflict.ts', 'const base = 1;\n');
      commitFiles(repoDir);
      runGit(repoDir, ['checkout', '-b', 'delete-side']);
      runGit(repoDir, ['rm', '-q', 'conflict.ts']);
      runGit(repoDir, ['commit', '--quiet', '-m', 'delete conflict file']);
      runGit(repoDir, ['checkout', '-q', 'master']);
      runGit(repoDir, ['checkout', '-b', 'modify-side']);
      writeFile(repoDir, 'conflict.ts', 'const changed = 2;\n');
      runGit(repoDir, ['add', 'conflict.ts']);
      runGit(repoDir, ['commit', '--quiet', '-m', 'modify conflict file']);
      runGit(repoDir, ['checkout', '-q', 'delete-side']);
      const merge = spawnSync('git', ['merge', 'modify-side'], {
        cwd: repoDir,
        encoding: 'utf8',
      });
      expect(merge.status).toBe(1);
      writeFile(repoDir, 'added-then-deleted.ts', 'const temporary = true;\n');
      runGit(repoDir, ['add', 'added-then-deleted.ts']);
      fs.unlinkSync(path.join(repoDir, 'added-then-deleted.ts'));

      const status = runGit(repoDir, ['status', '--porcelain=v1', '--untracked-files=all']);
      expect(status).toContain('DU conflict.ts');
      expect(status).toContain('AD added-then-deleted.ts');

      const plan = await planDirtyOverlay(repoDir);

      expect(plan.tombstones).toEqual(['added-then-deleted.ts', 'conflict.ts']);
      expect(plan.includePaths).toEqual([]);
      expect(plan.uncoveredPaths).toEqual([]);
      expect(plan.allDirtyPaths).toEqual(['added-then-deleted.ts', 'conflict.ts']);
      expect(plan.tooMany).toBe(false);
      expect(plan.skipped).toEqual([]);
    }),
  );
});
