import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const execFileTextMock = vi.hoisted(() => ({
  output: '',
  useReal: false,
  real: undefined as
    | ((
        command: string,
        args: string[],
        options?: { cwd?: string; timeoutMs?: number; maxBuffer?: number },
      ) => Promise<string>)
    | undefined,
}));

vi.mock('../../src/core/process/exec-file.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/process/exec-file.js')>();
  execFileTextMock.real = actual.execFileText;
  return {
    ...actual,
    execFileText: (
      command: string,
      args: string[],
      options?: { cwd?: string; timeoutMs?: number; maxBuffer?: number },
    ) =>
      execFileTextMock.useReal
        ? execFileTextMock.real!(command, args, options)
        : Promise.resolve(execFileTextMock.output),
  };
});

import { createWatchCommand, type DebouncedWatcherOptions } from '../../src/cli/watch.js';
import { planDirtyOverlay } from '../../src/core/analyze-delta.js';
import { tryResolveWithExtensions } from '../../src/core/ingestion/import-resolvers/utils.js';
import { isDirtyPath } from '../../src/mcp/local/backend-overlay.js';
import { findDirtyResultPaths } from '../../src/mcp/shared/response-envelope.js';
import { resolveTargetContext } from '../../src/mcp/shared/target-context.js';

describe('Windows-style path handling', () => {
  function runGit(repoPath: string, args: string[]): string {
    const result = spawnSync('git', args, { cwd: repoPath, encoding: 'utf8' });
    expect(result.status).toBe(0);
    return String(result.stdout ?? '').trim();
  }

  it('normalizes backslashes in isDirtyPath input src\\nested\\file.ts', () => {
    const snapshot = { dirtyPaths: new Set(['src/nested/file.ts']) } as never;

    expect(isDirtyPath(snapshot, 'src\\nested\\file.ts')).toBe(
      isDirtyPath(snapshot, 'src/nested/file.ts'),
    );
    expect(isDirtyPath(snapshot, 'src\\nested\\file.ts')).toBe(true);
  });

  it('matches mixed-separator result paths against forward-slash dirtyPaths', () => {
    const dirtyPaths = ['src/nested/file.ts', 'src/other.ts'];
    const windowsResults = {
      results: [
        { filePath: 'src\\nested/file.ts' },
        { path: 'src/other.ts' },
        { file: 'src\\clean.ts' },
      ],
    };
    const forwardResults = {
      results: [
        { filePath: 'src/nested/file.ts' },
        { path: 'src/other.ts' },
        { file: 'src/clean.ts' },
      ],
    };

    expect(findDirtyResultPaths(windowsResults, dirtyPaths)).toEqual(
      findDirtyResultPaths(forwardResults, dirtyPaths),
    );
    expect(findDirtyResultPaths(windowsResults, dirtyPaths)).toEqual([
      'src/nested/file.ts',
      'src/other.ts',
    ]);
  });

  it('normalizes backslashes in watcher ignore paths node_modules\\pkg\\file.ts', async () => {
    let watcherOptions: DebouncedWatcherOptions | undefined;
    const ignoreFilter = vi.fn(({ relative }: { relative: () => string }) =>
      relative().startsWith('node_modules/'),
    );
    const command = await createWatchCommand('/repo', {
      leasePath: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'watch-win-')), 'watch.lease'),
      createWatcher: (options) => {
        watcherOptions = options;
        return { start: vi.fn(), stop: vi.fn() };
      },
      createIgnoreFilter: vi.fn(async () => ({
        ignored: ignoreFilter,
        childrenIgnored: () => false,
      })) as never,
      planDirtyOverlay: vi.fn(async () => ({
        includePaths: [],
        uncoveredPaths: [],
        allDirtyPaths: [],
        tombstones: [],
        tooMany: false,
        skipped: [],
      })),
      log: vi.fn(),
      error: vi.fn(),
      onSignal: vi.fn(),
      offSignal: vi.fn(),
    });

    expect(watcherOptions?.shouldIgnore?.('node_modules\\pkg\\file.ts')).toBe(
      watcherOptions?.shouldIgnore?.('node_modules/pkg/file.ts'),
    );
    expect(ignoreFilter).toHaveBeenNthCalledWith(1, { relative: expect.any(Function) });
    expect(ignoreFilter.mock.calls[0]?.[0].relative()).toBe('node_modules/pkg/file.ts');
    command.stop();
  });

  it('parses quoted rename paths with spaces from LF porcelain output', async () => {
    execFileTextMock.output = 'R  "old name.ts" -> "new name.ts"\n';

    const plan = await planDirtyOverlay('/repo');

    expect(plan).toEqual({
      includePaths: ['new name.ts'],
      uncoveredPaths: [],
      allDirtyPaths: ['new name.ts', 'old name.ts'],
      tombstones: ['old name.ts'],
      tooMany: false,
      skipped: [],
    });
  });

  it('parses quoted rename paths with spaces from CRLF porcelain output', async () => {
    execFileTextMock.output = 'R  "old name.ts" -> "new name.ts"\r\n';

    const plan = await planDirtyOverlay('/repo');

    expect(plan).toEqual({
      includePaths: ['new name.ts'],
      uncoveredPaths: [],
      allDirtyPaths: ['new name.ts', 'old name.ts'],
      tombstones: ['old name.ts'],
      tooMany: false,
      skipped: [],
    });
  });

  it('plans a real Git rename between filenames containing spaces', async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ontoindex-windows-path-'));
    const oldPath = path.join(repo, 'old name.ts');
    const newPath = path.join(repo, 'new name.ts');
    try {
      runGit(repo, ['init', '--quiet']);
      runGit(repo, ['config', 'user.name', 'OntoIndex Test']);
      runGit(repo, ['config', 'user.email', 'test@example.com']);
      fs.writeFileSync(oldPath, 'export const value = 1;\n');
      runGit(repo, ['add', 'old name.ts']);
      runGit(repo, ['commit', '--quiet', '-m', 'baseline']);
      runGit(repo, ['mv', 'old name.ts', 'new name.ts']);
      execFileTextMock.useReal = true;

      expect(await planDirtyOverlay(repo)).toEqual({
        includePaths: ['new name.ts'],
        uncoveredPaths: [],
        allDirtyPaths: ['new name.ts', 'old name.ts'],
        tombstones: ['old name.ts'],
        tooMany: false,
        skipped: [],
      });
    } finally {
      execFileTextMock.useReal = false;
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('maps a normalized forward-slash JS path to a TS source without leaking separators', () => {
    const resolved = tryResolveWithExtensions(
      'src/nested/file.js',
      new Set(['src/nested/file.ts']),
      { mapJsToTs: true },
    );

    expect(resolved).toBe('src/nested/file.ts');
    expect(resolved).not.toContain('\\');
  });

  it.fails('maps Windows-style resolver input src\\nested\\file.js to normalized TS paths', () => {
    const files = new Set(['src/nested/file.ts']);
    const windowsResult = tryResolveWithExtensions('src\\nested\\file.js', files, {
      mapJsToTs: true,
    });
    const forwardResult = tryResolveWithExtensions('src/nested/file.js', files, {
      mapJsToTs: true,
    });

    expect(windowsResult).toBe(forwardResult);
    expect(windowsResult).toBe('src/nested/file.ts');
  });

  it('preserves spaces in dirtyPaths from target-context porcelain output', async () => {
    const context = await resolveTargetContext(
      { repo: 'test-repo' },
      {
        readRegistry: async () => [
          {
            name: 'test-repo',
            path: '/repo/test-repo',
            storagePath: '/repo/test-repo/.ontoindex',
            indexedAt: 'index-1',
            lastCommit: 'head-1',
            stats: { embeddings: 0 },
          } as never,
        ],
        execGit: async (_cwd, args) => {
          if (args[0] === 'status') return '?? src/dir with spaces/file.ts\n';
          if (args[1] === '--abbrev-ref') return 'main\n';
          return 'head-1\n';
        },
      },
    );

    expect(context.dirtyWorkspace?.dirtyPaths).toEqual(['src/dir with spaces/file.ts']);
  });
});
