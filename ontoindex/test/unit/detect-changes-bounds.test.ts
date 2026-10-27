import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

const SOURCE_PATH = path.join(__dirname, '../../src/mcp/local/backend-detect-changes.ts');

const { lbugMocks, childProcessMocks } = vi.hoisted(() => ({
  lbugMocks: {
    executeParameterized: vi.fn(),
  },
  childProcessMocks: {
    execFile: vi.fn(),
  },
}));

vi.mock('../../src/core/lbug/pool-adapter.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, ...lbugMocks };
});

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, execFile: childProcessMocks.execFile };
});

describe('detect_changes performance bounds', () => {
  const source = fs.readFileSync(SOURCE_PATH, 'utf-8');

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it('does not use synchronous git diff capture', () => {
    expect(source).not.toMatch(/execFileSync/);
    expect(source).toMatch(/timeout:\s*GIT_DIFF_TIMEOUT_MS/);
    expect(source).toMatch(/maxBuffer:\s*GIT_DIFF_MAX_BUFFER/);
  });

  it('caps diff parsing and database result sizes', () => {
    expect(source).toMatch(/maxFiles:\s*MAX_DIFF_FILES \+ 1/);
    expect(source).toMatch(/maxHunksPerFile:\s*MAX_HUNKS_PER_FILE/);
    expect(source).toMatch(
      /LIMIT \$\{Math\.max\(1, MAX_CHANGED_SYMBOLS - changedSymbols\.length\)\}/,
    );
    expect(source).toMatch(/LIMIT 5000/);
  });

  it.each([
    ['unstaged', ['diff', '-U0']],
    ['staged', ['diff', '--staged', '-U0']],
    ['all', ['diff', 'HEAD', '-U0']],
  ])('restricts %s capture with literal exact-file pathspecs', async (scope, args) => {
    childProcessMocks.execFile.mockImplementation((_cmd, _args, _options, callback) => {
      callback(null, '');
    });
    const { detectChanges } = await import('../../src/mcp/local/backend-detect-changes.js');
    const selected = ['src/a[1]*.ts', '-leading.ts', ':(glob)**.ts'];

    await detectChanges(
      { id: 'repo', repoPath: '/repo' },
      {
        scope,
        changed_files: selected,
        include_paths: ['src'],
      },
    );

    expect(childProcessMocks.execFile.mock.calls[0][1]).toEqual([
      ...args,
      '--no-renames',
      '--name-only',
      '-z',
      '--',
      ...selected.map((filePath) => `:(top,literal)${filePath}`),
    ]);
    expect(childProcessMocks.execFile.mock.calls[1][1]).toEqual([
      ...args,
      '--no-renames',
      '--',
      ...selected.map((filePath) => `:(top,literal)${filePath}`),
    ]);
  });

  it('keeps ambient capture when exact-file selection is absent', async () => {
    childProcessMocks.execFile.mockImplementation((_cmd, _args, _options, callback) => {
      callback(null, '');
    });
    const { detectChanges } = await import('../../src/mcp/local/backend-detect-changes.js');

    await detectChanges({ id: 'repo', repoPath: '/repo' }, { include_paths: ['src'] });

    expect(childProcessMocks.execFile.mock.calls[0][1]).toEqual(['diff', '-U0']);
  });

  it('stops before patch capture and graph queries when filename preflight fails', async () => {
    childProcessMocks.execFile.mockImplementation((_cmd, _args, _options, callback) => {
      callback(new Error('filename capture failed'));
    });
    const { detectChanges } = await import('../../src/mcp/local/backend-detect-changes.js');

    const result = await detectChanges(
      { id: 'repo', repoPath: '/repo' },
      {
        changed_files: ['src/selected.ts'],
      },
    );

    expect(result.error).toContain('Git diff failed: filename capture failed');
    expect(childProcessMocks.execFile).toHaveBeenCalledTimes(1);
    expect(lbugMocks.executeParameterized).not.toHaveBeenCalled();
  });

  it('reads preflight filenames using NUL delimiters', async () => {
    const selected = 'src/line\nbreak.ts';
    childProcessMocks.execFile
      .mockImplementationOnce((_cmd, _args, _options, callback) => callback(null, `${selected}\0`))
      .mockImplementationOnce((_cmd, _args, _options, callback) => callback(null, ''));
    const { detectChanges } = await import('../../src/mcp/local/backend-detect-changes.js');

    const result = await detectChanges(
      { id: 'repo', repoPath: '/repo' },
      { changed_files: [selected] },
    );

    expect(result.error).toBeUndefined();
    expect(childProcessMocks.execFile).toHaveBeenCalledTimes(2);
  });

  it('rejects an unselected patch path appearing after successful preflight', async () => {
    childProcessMocks.execFile
      .mockImplementationOnce((_cmd, _args, _options, callback) =>
        callback(null, 'src/selected.ts\0'),
      )
      .mockImplementationOnce((_cmd, _args, _options, callback) =>
        callback(
          null,
          [
            'diff --git a/src/selected.ts/child.ts b/src/selected.ts/child.ts',
            '--- a/src/selected.ts/child.ts',
            '+++ b/src/selected.ts/child.ts',
            '@@ -1 +1 @@',
            '-before',
            '+after',
            '',
          ].join('\n'),
        ),
      );
    const { detectChanges } = await import('../../src/mcp/local/backend-detect-changes.js');

    const result = await detectChanges(
      { id: 'repo', repoPath: '/repo' },
      {
        changed_files: ['src/selected.ts'],
      },
    );

    expect(result.error).toContain('exact files');
    expect(lbugMocks.executeParameterized).not.toHaveBeenCalled();
  });

  it('returns empty success without Git for an empty exact-file selection', async () => {
    const { detectChanges } = await import('../../src/mcp/local/backend-detect-changes.js');

    const result = await detectChanges(
      { id: 'repo', repoPath: '/repo' },
      {
        scope: 'compare',
        changed_files: [],
      },
    );

    expect(result.summary).toMatchObject({ changed_count: 0, risk_level: 'none' });
    expect(childProcessMocks.execFile).not.toHaveBeenCalled();
    expect(lbugMocks.executeParameterized).not.toHaveBeenCalled();
  });

  it.each([
    '',
    '.',
    '..',
    '../secret',
    'src/../secret',
    '/tmp/file',
    'C:/file',
    'src\\file',
    'src/./file',
    'src//file',
    'src/',
    'src/\0file',
  ])('rejects unsafe exact-file selection %j before Git', async (filePath) => {
    const { detectChanges } = await import('../../src/mcp/local/backend-detect-changes.js');

    const result = await detectChanges(
      { id: 'repo', repoPath: '/repo' },
      {
        scope: 'compare',
        base_ref: 'HEAD',
        changed_files: [filePath],
      },
    );

    expect(result.error).toMatch(/normalized repository-relative/);
    expect(childProcessMocks.execFile).not.toHaveBeenCalled();
  });

  it('captures a tiny selected patch despite an unrelated diff above the default buffer', async () => {
    const actual = await vi.importActual<typeof import('child_process')>('child_process');
    const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'ontoindex-diff-bounds-'));
    const git = (args: string[], maxBuffer = 16 * 1024 * 1024) =>
      new Promise<string>((resolve, reject) => {
        actual.execFile(
          'git',
          args,
          { cwd: repoPath, encoding: 'utf-8', maxBuffer },
          (error, stdout) => {
            if (error) reject(error);
            else resolve(stdout);
          },
        );
      });
    try {
      await git(['init', '-q']);
      const selected = 'selected[1]*.ts';
      fs.writeFileSync(path.join(repoPath, selected), 'before\n');
      fs.writeFileSync(path.join(repoPath, 'unrelated.txt'), 'before\n');
      await git(['add', '--', '.']);
      await git([
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.invalid',
        '-c',
        'commit.gpgsign=false',
        'commit',
        '-qm',
        'initial',
      ]);
      fs.writeFileSync(path.join(repoPath, selected), 'after\n');
      fs.writeFileSync(path.join(repoPath, 'unrelated.txt'), 'large diff line\n'.repeat(1_200_000));
      await expect(git(['diff', '-U0'])).rejects.toMatchObject({
        code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
      });
      childProcessMocks.execFile.mockImplementation(actual.execFile);
      lbugMocks.executeParameterized.mockResolvedValue([]);
      const { detectChanges } = await import('../../src/mcp/local/backend-detect-changes.js');

      const result = await detectChanges({ id: 'repo', repoPath }, { changed_files: [selected] });

      expect(result.error).toBeUndefined();
      expect(result.summary?.changed_files).toBe(1);
      expect(lbugMocks.executeParameterized.mock.calls[0][2]).toMatchObject({ filePath: selected });

      const compared = await detectChanges(
        { id: 'repo', repoPath },
        {
          scope: 'compare',
          base_ref: 'HEAD',
          changed_files: [selected],
        },
      );

      expect(compared.error).toBeUndefined();
      expect(compared.summary?.changed_files).toBe(1);
    } finally {
      fs.rmSync(repoPath, { recursive: true, force: true });
    }
  });

  it('rejects directory descendants while accepting exact deleted files and symlinks', async () => {
    const actual = await vi.importActual<typeof import('child_process')>('child_process');
    const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'ontoindex-exact-files-'));
    const git = (args: string[]) =>
      new Promise<string>((resolve, reject) => {
        actual.execFile('git', args, { cwd: repoPath, encoding: 'utf-8' }, (error, stdout) => {
          if (error) reject(error);
          else resolve(stdout);
        });
      });
    try {
      await git(['init', '-q']);
      for (const dir of ['live', 'deleted', 'replaced']) {
        fs.mkdirSync(path.join(repoPath, dir));
        fs.writeFileSync(path.join(repoPath, dir, 'child.ts'), 'before\n');
      }
      fs.writeFileSync(path.join(repoPath, 'deleted.ts'), 'before\n');
      fs.symlinkSync('deleted.ts', path.join(repoPath, 'link.ts'));
      await git(['add', '--', '.']);
      await git([
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.invalid',
        '-c',
        'commit.gpgsign=false',
        'commit',
        '-qm',
        'initial',
      ]);
      fs.writeFileSync(path.join(repoPath, 'live/child.ts'), 'after\n');
      fs.rmSync(path.join(repoPath, 'deleted'), { recursive: true });
      fs.rmSync(path.join(repoPath, 'replaced'), { recursive: true });
      fs.writeFileSync(path.join(repoPath, 'replaced'), 'replacement file\n');
      fs.unlinkSync(path.join(repoPath, 'deleted.ts'));
      fs.unlinkSync(path.join(repoPath, 'link.ts'));
      fs.symlinkSync('live/child.ts', path.join(repoPath, 'link.ts'));
      childProcessMocks.execFile.mockImplementation(actual.execFile);
      lbugMocks.executeParameterized.mockResolvedValue([]);
      const { detectChanges } = await import('../../src/mcp/local/backend-detect-changes.js');

      for (const selection of [
        { changed_files: ['live'] },
        { changed_files: ['deleted'] },
        { changed_files: ['replaced'], scope: 'compare', base_ref: 'HEAD' },
      ]) {
        childProcessMocks.execFile.mockClear();
        const result = await detectChanges({ id: 'repo', repoPath }, selection);
        expect(result.error).toContain('exact files');
        // Compare may first resolve its base ref, but no patch capture is allowed.
        expect(
          childProcessMocks.execFile.mock.calls.filter(
            (call) => call[1][0] === 'diff' && !call[1].includes('--name-only'),
          ),
        ).toHaveLength(0);
        expect(lbugMocks.executeParameterized).not.toHaveBeenCalled();
      }

      for (const selected of ['deleted.ts', 'link.ts']) {
        childProcessMocks.execFile.mockClear();
        const result = await detectChanges({ id: 'repo', repoPath }, { changed_files: [selected] });
        expect(result.error).toBeUndefined();
        expect(childProcessMocks.execFile.mock.calls.map((call) => call[1])).toEqual([
          ['diff', '-U0', '--no-renames', '--name-only', '-z', '--', `:(top,literal)${selected}`],
          ['diff', '-U0', '--no-renames', '--', `:(top,literal)${selected}`],
        ]);
      }
    } finally {
      fs.rmSync(repoPath, { recursive: true, force: true });
    }
  });

  it.each([0, 1])(
    'fails closed when changed-symbol query %i rejects',
    async (successfulQueries) => {
      const files = ['src/auth.ts', 'src/session.ts'];
      childProcessMocks.execFile.mockImplementation((_cmd, _args, _options, callback) => {
        callback(
          null,
          files
            .map((filePath) =>
              [
                `diff --git a/${filePath} b/${filePath}`,
                `--- a/${filePath}`,
                `+++ b/${filePath}`,
                '@@ -1 +1 @@',
                '-before',
                '+after',
                '',
              ].join('\n'),
            )
            .join('\n'),
        );
      });
      if (successfulQueries > 0) {
        lbugMocks.executeParameterized.mockResolvedValueOnce([
          { id: 'sym-1', name: 'login', type: 'Function', filePath: files[0] },
        ]);
      }
      lbugMocks.executeParameterized.mockRejectedValueOnce(
        new Error('database query failed at /private/database with secret-token'),
      );
      const { detectChanges } = await import('../../src/mcp/local/backend-detect-changes.js');

      const result = await detectChanges({ id: 'repo', repoPath: '/repo' }, {});

      expect(result).toEqual({
        error: 'Changed-symbol query failed; diff verification is incomplete.',
      });
      expect(lbugMocks.executeParameterized).toHaveBeenCalledTimes(successfulQueries + 1);
      expect(lbugMocks.executeParameterized.mock.calls.at(-1)?.[2]).toMatchObject({
        filePath: files[successfulQueries],
      });
    },
  );

  it('does not report the process impact cap when duplicate symbol ids are deduplicated', async () => {
    childProcessMocks.execFile.mockImplementation((_cmd, _args, _options, callback) => {
      callback(
        null,
        [
          'diff --git a/src/auth.ts b/src/auth.ts',
          '--- a/src/auth.ts',
          '+++ b/src/auth.ts',
          '@@ -1,0 +1 @@',
          '+changed',
          '',
        ].join('\n'),
      );
    });
    lbugMocks.executeParameterized
      .mockResolvedValueOnce([
        { id: 'sym-1', name: 'login', type: 'Function', filePath: 'src/auth.ts' },
        { id: 'sym-1', name: 'login', type: 'Function', filePath: 'src/auth.ts' },
      ])
      .mockResolvedValueOnce([]);

    const { detectChanges } = await import('../../src/mcp/local/backend-detect-changes.js');
    const result = await detectChanges({ id: 'repo', repoPath: '/repo' }, {});

    expect(lbugMocks.executeParameterized.mock.calls[1][2]).toEqual({ ids: ['sym-1'] });
    expect(result.warnings).not.toEqual(
      expect.arrayContaining([expect.stringContaining('Process impact lookup capped')]),
    );
  });

  it('filters changed files by include_paths and reports omitted ambient files', async () => {
    childProcessMocks.execFile.mockImplementation((_cmd, _args, _options, callback) => {
      callback(
        null,
        [
          'diff --git a/src/auth.ts b/src/auth.ts',
          '--- a/src/auth.ts',
          '+++ b/src/auth.ts',
          '@@ -1,0 +1 @@',
          '+changed',
          'diff --git a/docs/notes.md b/docs/notes.md',
          '--- a/docs/notes.md',
          '+++ b/docs/notes.md',
          '@@ -1,0 +1 @@',
          '+changed',
          '',
        ].join('\n'),
      );
    });
    lbugMocks.executeParameterized
      .mockResolvedValueOnce([
        { id: 'sym-1', name: 'login', type: 'Function', filePath: 'src/auth.ts' },
      ])
      .mockResolvedValueOnce([]);

    const { detectChanges } = await import('../../src/mcp/local/backend-detect-changes.js');
    const result = await detectChanges(
      { id: 'repo', repoPath: '/repo' },
      { include_paths: ['src'] },
    );

    expect(result.error).toBeUndefined();
    expect(result.summary).toMatchObject({ changed_files: 1, changed_count: 1 });
    expect(result.changed_symbols).toHaveLength(1);
    expect(result.changed_symbols?.[0]?.filePath).toBe('src/auth.ts');
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          'Omitted 1 changed file outside include_paths (src): docs/notes.md',
        ),
      ]),
    );
    expect(lbugMocks.executeParameterized).toHaveBeenCalledTimes(2);
  });
});
