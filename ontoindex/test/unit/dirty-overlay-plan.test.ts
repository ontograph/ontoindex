import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { planDirtyOverlay, workingTreeMatchesHead } from '../../src/core/analyze-delta.js';

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
  it.each(['.ontoindexignore', '.gitignore'])(
    'classifies consumed root %s controls independently of source ignores',
    (control) =>
      withGitRepo(async (repoDir) => {
        writeFile(repoDir, control, `${control}\n`);
        writeFile(repoDir, `nested/${control}`, 'baseline\n');
        runGit(repoDir, ['add', '-f', control, `nested/${control}`]);
        commitFiles(repoDir);
        writeFile(repoDir, control, `${control}\nsource.ts\n`);
        writeFile(repoDir, `nested/${control}`, 'changed\n');
        expect((await planDirtyOverlay(repoDir)).configPaths).toEqual([control]);
        expect((await workingTreeMatchesHead(repoDir)).changedPaths).toContain(control);
        fs.unlinkSync(path.join(repoDir, control));
        expect((await planDirtyOverlay(repoDir)).configPaths).toEqual([control]);
        expect((await workingTreeMatchesHead(repoDir)).changedPaths).toContain(control);
        runGit(repoDir, ['add', '-u']);
        runGit(repoDir, ['commit', '--quiet', '-m', 'remove control']);
        writeFile(repoDir, control, 'new.ts\n');
        expect((await planDirtyOverlay(repoDir)).configPaths).toEqual([control]);
        expect((await workingTreeMatchesHead(repoDir)).changedPaths).toContain(control);
        fs.unlinkSync(path.join(repoDir, control));
        writeFile(repoDir, '.git/info/exclude', `${control}\n`);
        writeFile(repoDir, control, `${control}\nnew.ts\n`);
        expect(runGit(repoDir, ['status', '--porcelain'])).toBe('');
        expect((await planDirtyOverlay(repoDir)).configPaths).toEqual([control]);
        expect((await workingTreeMatchesHead(repoDir)).changedPaths).toContain(control);
      })(),
  );

  it.each([undefined, '', '1', 'enabled'])(
    'matches ignore-loader consumption with NO_GITIGNORE=%s',
    (value) =>
      withGitRepo(async (repoDir) => {
        try {
          vi.stubEnv('ONTOINDEX_NO_GITIGNORE', value);
          writeFile(repoDir, '.gitignore', '.gitignore\n');
          writeFile(repoDir, '.ontoindexignore', '.ontoindexignore\n');
          runGit(repoDir, ['add', '-f', '.gitignore', '.ontoindexignore']);
          commitFiles(repoDir);
          writeFile(repoDir, '.gitignore', '.gitignore\na.ts\n');
          writeFile(repoDir, '.ontoindexignore', '.ontoindexignore\nb.ts\n');
          expect((await planDirtyOverlay(repoDir)).configPaths).toEqual(
            value ? ['.ontoindexignore'] : ['.gitignore', '.ontoindexignore'],
          );
        } finally {
          vi.unstubAllEnvs();
        }
      })(),
  );

  it.each(['assume', 'skip', 'both'])(
    'distinguishes missing sources and configurations with %s index flags',
    (flags) =>
      withGitRepo(async (repoDir) => {
        writeFile(repoDir, '.ontoindexignore', 'ignored.ts\n');
        for (const file of ['source.ts', 'ignored.ts', 'tsconfig.json', 'configs/data.json']) {
          writeFile(repoDir, file, '{}\n');
        }
        fs.symlinkSync('configs/data.json', path.join(repoDir, 'jsconfig.json'));
        fs.symlinkSync('configs/data.json', path.join(repoDir, 'tsconfig.target.json'));
        commitFiles(repoDir);
        const missing = [
          'source.ts',
          'ignored.ts',
          'tsconfig.json',
          'jsconfig.json',
          'configs/data.json',
        ];
        if (flags !== 'skip') runGit(repoDir, ['update-index', '--assume-unchanged', ...missing]);
        if (flags !== 'assume') runGit(repoDir, ['update-index', '--skip-worktree', ...missing]);
        for (const file of missing) fs.unlinkSync(path.join(repoDir, file));
        const plan = await planDirtyOverlay(repoDir);
        expect(plan.includePaths).toEqual([]);
        expect(plan.allDirtyPaths).toEqual(flags === 'assume' ? ['source.ts'] : []);
        expect(plan.tombstones).toEqual(flags === 'assume' ? ['source.ts'] : []);
        expect(plan.configPaths).toEqual(
          flags === 'assume' ? ['jsconfig.json', 'tsconfig.json', 'tsconfig.target.json'] : [],
        );
      })(),
  );

  it(
    'keeps a broken hidden source symlink present and propagates lstat errors',
    withGitRepo(async (repoDir) => {
      fs.symlinkSync('missing.ts', path.join(repoDir, 'source.ts'));
      commitFiles(repoDir);
      runGit(repoDir, ['update-index', '--assume-unchanged', 'source.ts']);
      expect((await planDirtyOverlay(repoDir)).includePaths).toEqual(['source.ts']);
      const lstat = fsPromises.lstat.bind(fsPromises);
      const denied = Object.assign(new Error('denied'), { code: 'EACCES' });
      const spy = vi.spyOn(fsPromises, 'lstat').mockImplementation((...args) => {
        if (args[0] === path.join(repoDir, 'source.ts')) return Promise.reject(denied);
        return lstat(...args);
      });
      try {
        await expect(planDirtyOverlay(repoDir)).rejects.toBe(denied);
      } finally {
        spy.mockRestore();
      }
    }),
  );

  it.each(['relative', 'absolute', 'dotdot'])(
    'tracks intermediate directory dependencies through %s targets',
    (kind) =>
      withGitRepo(async (repoDir) => {
        writeFile(repoDir, 'configs/a/deep/placeholder', '');
        writeFile(repoDir, 'configs/a/value.json', '{}\n');
        writeFile(repoDir, 'configs/b/deep/placeholder', '');
        writeFile(repoDir, 'configs/b/value.json', '{"strict":true}\n');
        fs.symlinkSync('configs/a/deep', path.join(repoDir, 'alias'));
        const target = kind === 'dotdot' ? 'alias/../value.json' : 'alias/../../a/value.json';
        fs.symlinkSync(
          kind === 'absolute' ? `${repoDir}/${target}` : target,
          path.join(repoDir, 'tsconfig.json'),
        );
        commitFiles(repoDir);
        fs.unlinkSync(path.join(repoDir, 'alias'));
        fs.symlinkSync('configs/b/deep', path.join(repoDir, 'alias'));

        expect((await planDirtyOverlay(repoDir)).configPaths).toEqual(['tsconfig.json']);
      })(),
  );

  it.each(['broken', 'loop', 'external', 'hop-limit'])(
    'conservatively invalidates an unresolved %s config chain',
    (kind) =>
      withGitRepo(async (repoDir) => {
        writeFile(repoDir, 'data.json', '{}\n');
        if (kind === 'hop-limit') {
          for (let index = 0; index < 41; index += 1) {
            fs.symlinkSync(
              index === 40 ? 'data.json' : `link-${index + 1}`,
              path.join(repoDir, `link-${index}`),
            );
          }
        }
        const target =
          kind === 'loop'
            ? 'tsconfig.json'
            : kind === 'external'
              ? '../outside.json'
              : kind === 'hop-limit'
                ? 'link-0'
                : 'missing.json';
        fs.symlinkSync(target, path.join(repoDir, 'tsconfig.json'));
        commitFiles(repoDir);
        writeFile(repoDir, 'unrelated.json', '{"changed":true}\n');

        expect((await planDirtyOverlay(repoDir)).configPaths).toEqual(['tsconfig.json']);
      })(),
  );

  it(
    'resolves dot-dot after expanding the directory link rather than lexically',
    withGitRepo(async (repoDir) => {
      writeFile(repoDir, 'configs/deep/placeholder', '');
      writeFile(repoDir, 'configs/value.json', '{}\n');
      writeFile(repoDir, 'value.json', '{}\n');
      fs.symlinkSync('configs/deep', path.join(repoDir, 'alias'));
      fs.symlinkSync('alias/../value.json', path.join(repoDir, 'tsconfig.json'));
      commitFiles(repoDir);
      writeFile(repoDir, 'value.json', '{"unrelated":true}\n');
      expect((await planDirtyOverlay(repoDir)).configPaths).toEqual([]);
      writeFile(repoDir, 'configs/value.json', '{"strict":true}\n');
      expect((await planDirtyOverlay(repoDir)).configPaths).toEqual(['tsconfig.json']);
    }),
  );

  it.each(['--assume-unchanged', '--skip-worktree'])(
    'classifies hidden plain configurations under %s independently of sources',
    (flag) =>
      withGitRepo(async (repoDir) => {
        writeFile(repoDir, '.ontoindexignore', 'vendor/**\n');
        for (const file of ['tsconfig.json', 'package.json', 'vendor/tsconfig.json']) {
          writeFile(repoDir, file, '{}\n');
        }
        commitFiles(repoDir);
        const files = ['tsconfig.json', 'package.json', 'vendor/tsconfig.json'];
        runGit(repoDir, ['update-index', flag, ...files]);
        for (const file of files) writeFile(repoDir, file, '{"changed":true}\n');
        expect(runGit(repoDir, ['status', '--porcelain'])).toBe('');
        const plan = await planDirtyOverlay(repoDir);
        expect(plan.configPaths).toEqual(['package.json', 'tsconfig.json']);
        expect(plan.includePaths).toEqual([]);
        expect(plan.allDirtyPaths).toEqual([]);
      })(),
  );

  it(
    'does not invalidate a sparse-absent configuration symlink for an unrelated edit',
    withGitRepo(async (repoDir) => {
      writeFile(repoDir, 'configs/aliases.json', '{}\n');
      writeFile(repoDir, 'data.json', '{}\n');
      fs.symlinkSync('configs/aliases.json', path.join(repoDir, 'tsconfig.json'));
      commitFiles(repoDir);
      runGit(repoDir, ['update-index', '--skip-worktree', 'tsconfig.json']);
      fs.unlinkSync(path.join(repoDir, 'tsconfig.json'));
      writeFile(repoDir, 'data.json', '{"changed":true}\n');

      expect(runGit(repoDir, ['status', '--porcelain'])).toBe('M data.json');
      expect((await planDirtyOverlay(repoDir)).configPaths).toEqual([]);
    }),
  );

  it(
    'still invalidates a present skip-worktree configuration symlink with a broken target',
    withGitRepo(async (repoDir) => {
      writeFile(repoDir, 'data.json', '{}\n');
      fs.symlinkSync('missing.json', path.join(repoDir, 'tsconfig.json'));
      commitFiles(repoDir);
      runGit(repoDir, ['update-index', '--skip-worktree', 'tsconfig.json']);
      writeFile(repoDir, 'data.json', '{"changed":true}\n');

      expect((await planDirtyOverlay(repoDir)).configPaths).toEqual(['tsconfig.json']);
    }),
  );

  it.each(['.ontoindexignore', '.gitignore'])(
    'tracks a consumed configuration target ignored by %s',
    (ignoreFile) =>
      withGitRepo(async (repoDir) => {
        writeFile(repoDir, 'configs/aliases.json', '{"compilerOptions":{}}\n');
        writeFile(repoDir, 'configs/tsconfig.json', '{}\n');
        fs.symlinkSync('configs/aliases.json', path.join(repoDir, 'tsconfig.json'));
        commitFiles(repoDir);
        writeFile(repoDir, ignoreFile, 'configs/**\n');
        commitFiles(repoDir);
        writeFile(repoDir, 'configs/aliases.json', '{"compilerOptions":{"strict":true}}\n');
        writeFile(repoDir, 'configs/tsconfig.json', '{"ignored":true}\n');

        const plan = await planDirtyOverlay(repoDir);
        expect(plan.configPaths).toEqual(['tsconfig.json']);
        expect(plan.includePaths).toEqual([]);
        expect(plan.allDirtyPaths).toEqual([]);
      })(),
  );

  it(
    'marks a tracked configuration symlink when a directory link is retargeted',
    withGitRepo(async (repoDir) => {
      writeFile(repoDir, 'configs-a/x.json', '{"compilerOptions":{}}\n');
      writeFile(repoDir, 'configs-b/x.json', '{"compilerOptions":{"strict":true}}\n');
      fs.symlinkSync('configs-a', path.join(repoDir, 'alias'));
      fs.symlinkSync('alias/x.json', path.join(repoDir, 'tsconfig.json'));
      commitFiles(repoDir);
      fs.unlinkSync(path.join(repoDir, 'alias'));
      fs.symlinkSync('configs-b', path.join(repoDir, 'alias'));

      expect((await planDirtyOverlay(repoDir)).configPaths).toEqual(['tsconfig.json']);
    }),
  );

  it(
    'marks a tracked configuration symlink when its source target is assume-unchanged',
    withGitRepo(async (repoDir) => {
      writeFile(repoDir, 'configs/aliases.ts', '{"compilerOptions":{}}\n');
      fs.symlinkSync('configs/aliases.ts', path.join(repoDir, 'tsconfig.json'));
      commitFiles(repoDir);
      runGit(repoDir, ['update-index', '--assume-unchanged', 'configs/aliases.ts']);
      writeFile(repoDir, 'configs/aliases.ts', '{"compilerOptions":{"strict":true}}\n');
      expect(runGit(repoDir, ['status', '--porcelain'])).toBe('');

      const plan = await planDirtyOverlay(repoDir);
      expect(plan.configPaths).toEqual(['tsconfig.json']);
      expect(plan.includePaths).toEqual(['configs/aliases.ts']);
    }),
  );

  it.each(['external', 'self-loop'])(
    'marks a tracked configuration symlink when its target becomes an %s link',
    (replacement) =>
      withGitRepo(async (repoDir) => {
        writeFile(repoDir, 'configs/aliases.json', '{"compilerOptions":{}}\n');
        fs.symlinkSync('configs/aliases.json', path.join(repoDir, 'tsconfig.json'));
        commitFiles(repoDir);
        const external = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-config-external-'));
        try {
          fs.writeFileSync(path.join(external, 'aliases.json'), '{}\n');
          fs.unlinkSync(path.join(repoDir, 'configs/aliases.json'));
          fs.symlinkSync(
            replacement === 'external' ? path.join(external, 'aliases.json') : 'aliases.json',
            path.join(repoDir, 'configs/aliases.json'),
          );
          expect(runGit(repoDir, ['status', '--porcelain'])).toBe('T configs/aliases.json');

          expect((await planDirtyOverlay(repoDir)).configPaths).toEqual(['tsconfig.json']);
        } finally {
          fs.rmSync(external, { recursive: true, force: true });
        }
      })(),
  );

  it(
    'marks a tracked configuration symlink when an intermediate link is retargeted',
    withGitRepo(async (repoDir) => {
      writeFile(repoDir, 'configs/b.json', '{"compilerOptions":{}}\n');
      writeFile(repoDir, 'configs/c.json', '{"compilerOptions":{"strict":true}}\n');
      fs.symlinkSync('configs/a.json', path.join(repoDir, 'tsconfig.json'));
      fs.symlinkSync('b.json', path.join(repoDir, 'configs/a.json'));
      commitFiles(repoDir);
      fs.unlinkSync(path.join(repoDir, 'configs/a.json'));
      fs.symlinkSync('c.json', path.join(repoDir, 'configs/a.json'));
      expect(runGit(repoDir, ['status', '--porcelain'])).toBe('M configs/a.json');

      expect((await planDirtyOverlay(repoDir)).configPaths).toEqual(['tsconfig.json']);
    }),
  );

  it(
    'marks a tracked configuration symlink when a dirty intermediate link becomes unreadable',
    withGitRepo(async (repoDir) => {
      writeFile(repoDir, 'configs/b.json', '{"compilerOptions":{}}\n');
      writeFile(repoDir, 'plain.txt', 'not a directory\n');
      fs.symlinkSync('configs/a.json', path.join(repoDir, 'tsconfig.json'));
      fs.symlinkSync('b.json', path.join(repoDir, 'configs/a.json'));
      commitFiles(repoDir);
      fs.unlinkSync(path.join(repoDir, 'configs/a.json'));
      fs.symlinkSync('../plain.txt/child', path.join(repoDir, 'configs/a.json'));

      expect((await planDirtyOverlay(repoDir)).configPaths).toEqual(['tsconfig.json']);
    }),
  );

  it(
    'marks a tracked configuration symlink whose target is reached through a symlinked directory',
    withGitRepo(async (repoDir) => {
      writeFile(repoDir, 'configs/aliases.json', '{"compilerOptions":{}}\n');
      fs.symlinkSync('configs', path.join(repoDir, 'alias'));
      fs.symlinkSync('alias/aliases.json', path.join(repoDir, 'tsconfig.json'));
      commitFiles(repoDir);
      writeFile(repoDir, 'configs/aliases.json', '{"compilerOptions":{"strict":true}}\n');

      expect((await planDirtyOverlay(repoDir)).configPaths).toEqual(['tsconfig.json']);
    }),
  );

  it(
    'does not classify unrelated dirty JSON as configuration behind a tracked config symlink',
    withGitRepo(async (repoDir) => {
      writeFile(repoDir, 'configs/aliases.json', '{"compilerOptions":{}}\n');
      fs.symlinkSync('configs/aliases.json', path.join(repoDir, 'tsconfig.json'));
      writeFile(repoDir, 'data.json', '{"value":1}\n');
      commitFiles(repoDir);
      writeFile(repoDir, 'data.json', '{"value":2}\n');

      expect((await planDirtyOverlay(repoDir)).configPaths).toEqual([]);
    }),
  );

  it(
    'marks a tracked configuration symlink when its target is deleted',
    withGitRepo(async (repoDir) => {
      writeFile(repoDir, 'configs/aliases.json', '{"compilerOptions":{}}\n');
      fs.symlinkSync('configs/aliases.json', path.join(repoDir, 'tsconfig.json'));
      commitFiles(repoDir);
      fs.unlinkSync(path.join(repoDir, 'configs/aliases.json'));

      expect((await planDirtyOverlay(repoDir)).configPaths).toEqual(['tsconfig.json']);
    }),
  );

  it(
    'marks a tracked configuration symlink whose target has a source extension',
    withGitRepo(async (repoDir) => {
      writeFile(repoDir, 'configs/aliases.ts', '{"compilerOptions":{}}\n');
      fs.symlinkSync('configs/aliases.ts', path.join(repoDir, 'tsconfig.json'));
      commitFiles(repoDir);
      writeFile(repoDir, 'configs/aliases.ts', '{"compilerOptions":{"baseUrl":"."}}\n');

      expect((await planDirtyOverlay(repoDir)).configPaths).toEqual(['tsconfig.json']);
    }),
  );

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
    { cap: '1', includePaths: ['src/large.ts', 'src/small.ts'], skipped: [] },
    { cap: '0', includePaths: ['src/large.ts', 'src/small.ts'], skipped: [] },
  ])(
    'ignores the retired scan size cap ($cap KiB) for modified sources',
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
          expect(plan.allDirtyPaths).toEqual(['src/large.ts', 'src/small.ts']);
          expect(plan.uncoveredPaths).toEqual(skipped);
          expect(plan.skipped).toEqual(skipped);
        })();
      } finally {
        if (previousCap === undefined) delete process.env.ONTOINDEX_SCAN_MAX_FILE_KB;
        else process.env.ONTOINDEX_SCAN_MAX_FILE_KB = previousCap;
      }
    },
  );

  it(
    'covers untracked large sources before and after shrinking',
    withGitRepo(async (repoDir) => {
      vi.stubEnv('ONTOINDEX_SCAN_MAX_FILE_KB', '1');
      try {
        writeFile(repoDir, '.ontoindexignore', 'private/**\n');
        commitFiles(repoDir);
        writeFile(repoDir, 'src/large.ts', 'x'.repeat(2048));
        writeFile(repoDir, 'private/large.ts', 'x'.repeat(2048));
        const plan = await planDirtyOverlay(repoDir);
        expect(plan.includePaths).toEqual(['src/large.ts']);
        expect(plan.allDirtyPaths).toEqual(['src/large.ts']);
        expect(plan.uncoveredPaths).toEqual([]);
        expect(plan.tooMany).toBe(false);

        writeFile(repoDir, 'src/large.ts', 'export const small = 1;\n');
        const shrunk = await planDirtyOverlay(repoDir);
        expect(shrunk.includePaths).toEqual(['src/large.ts']);
        expect(shrunk.allDirtyPaths).toEqual(['src/large.ts']);
        expect(shrunk.uncoveredPaths).toEqual([]);
        expect(shrunk.skipped).toEqual(['private/large.ts']);
      } finally {
        vi.unstubAllEnvs();
      }
    }),
  );

  it(
    'includes large sources and preserves deletion tombstones with many dirty files',
    withGitRepo(async (repoDir) => {
      vi.stubEnv('ONTOINDEX_SCAN_MAX_FILE_KB', '1');
      try {
        writeFile(repoDir, 'src/deleted.ts', 'export const deleted = 1;\n');
        commitFiles(repoDir);
        fs.unlinkSync(path.join(repoDir, 'src/deleted.ts'));
        writeFile(repoDir, 'src/large.ts', 'x'.repeat(2048));
        for (let index = 0; index < 51; index++) {
          const rel = `src/file-${index}.ts`;
          writeFile(repoDir, rel, `export const value = ${index};\n`);
          const mtime = new Date(1_700_000_000_000 + index * 1000);
          fs.utimesSync(path.join(repoDir, rel), mtime, mtime);
        }
        const plan = await planDirtyOverlay(repoDir);
        expect(plan.tooMany).toBe(false);
        expect(plan.includePaths).toHaveLength(52);
        expect(plan.includePaths).toContain('src/large.ts');
        expect(plan.uncoveredPaths).toEqual([]);
        expect(plan.allDirtyPaths).toHaveLength(53);
        expect(plan.tombstones).toEqual(['src/deleted.ts']);
        expect(plan.skipped).toEqual([]);
      } finally {
        vi.unstubAllEnvs();
      }
    }),
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
    'keeps ignored paths out of dirty source coverage',
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
    'covers all dirty files without an arbitrary count cap',
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

      expect(plan.tooMany).toBe(false);
      expect(plan.includePaths).toEqual(
        Array.from({ length: 75 }, (_, index) => `src/file-${index}.ts`).sort(),
      );
      expect(plan.uncoveredPaths).toEqual([]);
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
