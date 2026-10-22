import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
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
    'reports a configuration-only edit as configPaths and leaves the source set empty',
    withGitRepo(async (repoDir) => {
      writeFile(repoDir, 'src/a.ts', 'export const a = 1;\n');
      writeFile(repoDir, 'tsconfig.json', '{"compilerOptions":{}}\n');
      writeFile(repoDir, 'package.json', '{"name":"x"}\n');
      commitFiles(repoDir);
      writeFile(repoDir, 'tsconfig.json', '{"compilerOptions":{}}\n\n');
      writeFile(repoDir, 'package.json', '{"name":"y"}\n');

      const plan = await planDirtyOverlay(repoDir);

      expect(plan.configPaths).toEqual(['package.json', 'tsconfig.json']);
      expect(plan.allDirtyPaths).toEqual([]);
      expect(plan.includePaths).toEqual([]);
    }),
  );

  it(
    'does not report an ignored configuration file',
    withGitRepo(async (repoDir) => {
      writeFile(repoDir, '.ontoindexignore', 'vendor/**\n');
      writeFile(repoDir, 'vendor/tsconfig.json', '{}\n');
      commitFiles(repoDir);
      writeFile(repoDir, 'vendor/tsconfig.json', '{"a":1}\n');

      expect((await planDirtyOverlay(repoDir)).configPaths).toEqual([]);
    }),
  );

  it(
    'skips dirty sources matching .ontoindexignore',
    withGitRepo(async (repoDir) => {
      writeFile(repoDir, '.ontoindexignore', 'src/private/**\n');
      commitFiles(repoDir);
      writeFile(repoDir, 'src/private/value.ts', 'export const value = 1;\n');

      const plan = await planDirtyOverlay(repoDir);

      expect(plan.includePaths).toEqual([]);
      expect(plan.allDirtyPaths).toEqual([]);
      expect(plan.skipped).toEqual(['src/private/value.ts']);
    }),
  );

  it(
    'skips tracked modified sources matching .gitignore',
    withGitRepo(async (repoDir) => {
      writeFile(repoDir, 'src/generated.ts', 'export const value = 1;\n');
      commitFiles(repoDir);
      writeFile(repoDir, '.gitignore', 'src/generated.ts\n');
      runGit(repoDir, ['add', '.gitignore']);
      runGit(repoDir, ['commit', '--quiet', '-m', 'ignore generated source']);
      writeFile(repoDir, 'src/generated.ts', 'export const value = 2;\n');

      const plan = await planDirtyOverlay(repoDir);

      expect(plan.includePaths).toEqual([]);
      expect(plan.allDirtyPaths).toEqual([]);
      expect(plan.skipped).toEqual(['src/generated.ts']);
    }),
  );

  it(
    'does not tombstone deleted tracked sources matching an ignore rule',
    withGitRepo(async (repoDir) => {
      writeFile(repoDir, '.ontoindexignore', 'src/generated.ts\n');
      writeFile(repoDir, 'src/generated.ts', 'export const value = 1;\n');
      commitFiles(repoDir);
      fs.unlinkSync(path.join(repoDir, 'src/generated.ts'));

      const plan = await planDirtyOverlay(repoDir);

      expect(plan.tombstones).toEqual([]);
      expect(plan.allDirtyPaths).toEqual([]);
      expect(plan.skipped).toEqual(['src/generated.ts']);
    }),
  );

  it(
    'includes dirty sources that do not match root ignore rules',
    withGitRepo(async (repoDir) => {
      writeFile(repoDir, '.gitignore', 'generated/**\n');
      writeFile(repoDir, '.ontoindexignore', 'private/**\n');
      commitFiles(repoDir);
      writeFile(repoDir, 'src/value.ts', 'export const value = 1;\n');

      const plan = await planDirtyOverlay(repoDir);

      expect(plan.includePaths).toEqual(['src/value.ts']);
      expect(plan.allDirtyPaths).toEqual(['src/value.ts']);
      expect(plan.skipped).toEqual([]);
    }),
  );

  it(
    'keeps modified and deleted sources eligible without ignore files',
    withGitRepo(async (repoDir) => {
      writeFile(repoDir, 'src/value.ts', 'export const value = 1;\n');
      writeFile(repoDir, 'src/gone.ts', 'export const gone = true;\n');
      commitFiles(repoDir);
      writeFile(repoDir, 'src/value.ts', 'export const value = 2;\n');
      fs.unlinkSync(path.join(repoDir, 'src/gone.ts'));

      const plan = await planDirtyOverlay(repoDir);

      expect(plan.includePaths).toEqual(['src/value.ts']);
      expect(plan.tombstones).toEqual(['src/gone.ts']);
      expect(plan.allDirtyPaths).toEqual(['src/gone.ts', 'src/value.ts']);
      expect(plan.skipped).toEqual([]);
    }),
  );

  it(
    'skips modified dependency and build outputs',
    withGitRepo(async (repoDir) => {
      const files = ['node_modules/pkg/index.ts', 'dist/out.js', 'src/a.ts'];
      for (const file of files) writeFile(repoDir, file, 'const before = 1;\n');
      commitFiles(repoDir);
      for (const file of files) writeFile(repoDir, file, 'const after = 2;\n');

      const plan = await planDirtyOverlay(repoDir);

      expect(plan.includePaths).toEqual(['src/a.ts']);
      expect(plan.allDirtyPaths).toEqual(['src/a.ts']);
      expect(plan.skipped).toEqual(['dist/out.js', 'node_modules/pkg/index.ts']);
    }),
  );

  it.each([
    { cap: '1', includePaths: ['src/small.ts'], skipped: ['src/large.ts'] },
    { cap: '0', includePaths: ['src/large.ts', 'src/small.ts'], skipped: [] },
  ])(
    'applies the current scan size cap ($cap KiB) to modified sources',
    async ({ cap, includePaths, skipped }) => {
      const previousCap = process.env.ONTOINDEX_SCAN_MAX_FILE_KB;
      try {
        process.env.ONTOINDEX_SCAN_MAX_FILE_KB = cap;
        await withGitRepo(async (repoDir) => {
          writeFile(repoDir, 'src/large.ts', 'const before = 1;\n');
          writeFile(repoDir, 'src/small.ts', 'const before = 1;\n');
          commitFiles(repoDir);
          writeFile(repoDir, 'src/large.ts', 'x'.repeat(3 * 1024));
          writeFile(repoDir, 'src/small.ts', 'const after = 2;\n');

          const plan = await planDirtyOverlay(repoDir);

          expect(plan.includePaths).toEqual(includePaths);
          expect(plan.allDirtyPaths).toEqual(includePaths);
          expect(plan.skipped).toEqual(skipped);
        })();
      } finally {
        if (previousCap === undefined) delete process.env.ONTOINDEX_SCAN_MAX_FILE_KB;
        else process.env.ONTOINDEX_SCAN_MAX_FILE_KB = previousCap;
      }
    },
  );

  it(
    'keeps deleted sources as tombstones but skips deleted dependencies',
    withGitRepo(async (repoDir) => {
      writeFile(repoDir, 'src/gone.ts', 'export const gone = true;\n');
      writeFile(repoDir, 'node_modules/x/y.ts', 'export const ignored = true;\n');
      commitFiles(repoDir);
      fs.unlinkSync(path.join(repoDir, 'src/gone.ts'));
      fs.unlinkSync(path.join(repoDir, 'node_modules/x/y.ts'));

      const plan = await planDirtyOverlay(repoDir);

      expect(plan.tombstones).toEqual(['src/gone.ts']);
      expect(plan.includePaths).toEqual([]);
      expect(plan.allDirtyPaths).toEqual(['src/gone.ts']);
      expect(plan.skipped).toEqual(['node_modules/x/y.ts']);
    }),
  );

  it(
    'does not count ignored paths toward the 50-file cap',
    withGitRepo(async (repoDir) => {
      for (let index = 0; index < 60; index += 1) {
        writeFile(repoDir, `node_modules/p/f${index}.ts`, 'export const ignored = true;\n');
      }
      const sources = ['src/a.ts', 'src/b.ts', 'src/c.ts'];
      for (const file of sources) writeFile(repoDir, file, 'export const value = 1;\n');

      const plan = await planDirtyOverlay(repoDir);

      expect(plan.tooMany).toBe(false);
      expect(plan.includePaths).toEqual(sources);
      expect(plan.allDirtyPaths).toEqual(sources);
      expect(plan.uncoveredPaths).toEqual([]);
      expect(plan.skipped).toEqual(
        Array.from({ length: 60 }, (_, index) => `node_modules/p/f${index}.ts`).sort(),
      );
    }),
  );

  it(
    'keeps a modified source eligible when stat fails',
    withGitRepo(async (repoDir) => {
      writeFile(repoDir, 'src/missing.ts', 'const before = 1;\n');
      commitFiles(repoDir);
      writeFile(repoDir, 'src/missing.ts', 'const after = 2;\n');
      const originalStat = fsPromises.stat;
      const stat = vi.spyOn(fsPromises, 'stat').mockImplementation((...args) => {
        if (args[0] === path.join(repoDir, 'src/missing.ts')) {
          fs.rmSync(path.join(repoDir, 'src/missing.ts'), { force: true });
        }
        return originalStat(...args);
      });
      try {
        const plan = await planDirtyOverlay(repoDir);

        expect(plan.includePaths).toEqual(['src/missing.ts']);
        expect(plan.allDirtyPaths).toEqual(['src/missing.ts']);
        expect(plan.skipped).toEqual([]);
      } finally {
        stat.mockRestore();
      }
    }),
  );

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
        configPaths: [],
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
