import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { executeParameterized, isLbugReady } = vi.hoisted(() => ({
  executeParameterized: vi.fn(),
  isLbugReady: vi.fn(() => true),
}));

vi.mock('../../src/core/lbug/pool-adapter.js', () => ({
  executeParameterized,
  isLbugReady,
}));

import { runMigrationProgress } from '../../src/mcp/local/backend-migration-progress.js';
import { runTypeCoverage } from '../../src/mcp/local/backend-type-coverage.js';

describe('backend migration/type tools', () => {
  let repoDir: string;

  beforeEach(async () => {
    executeParameterized.mockReset();
    isLbugReady.mockReset();
    isLbugReady.mockReturnValue(true);
    repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-migration-type-'));
    await fs.mkdir(path.join(repoDir, 'src'), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(repoDir, { recursive: true, force: true });
  });

  it('migration_progress reports remaining old-pattern files and module grouping', async () => {
    await fs.writeFile(
      path.join(repoDir, 'src', 'migration.ts'),
      [
        'setTimeout(() => work(), 100);',
        'timerRegistry.setTimeout(() => work(), 100);',
        'setTimeout(() => workMore(), 100);',
      ].join('\n'),
      'utf8',
    );

    executeParameterized.mockResolvedValueOnce([
      { filePath: 'src/migration.ts', communityId: 'comm:timers', community: 'Timers' },
    ]);

    const result = await runMigrationProgress(
      { id: 'repo', name: 'test-repo', repoPath: repoDir },
      {
        old_pattern: '\\bsetTimeout\\s*\\(',
        new_pattern: 'timerRegistry\\.setTimeout\\s*\\(',
        file_glob: 'src/**/*.ts',
        label: 'Timer migration',
      },
    );

    expect(result.status).toBe('success');
    expect(result.summary.total_old_sites).toBe(2);
    expect(result.summary.total_new_sites).toBe(1);
    expect(result.summary.files_remaining).toBe(1);
    expect(result.remaining_files[0]).toMatchObject({ file: 'src/migration.ts', module: 'Timers' });
  });

  it('migration_progress wraps invalid regex errors without changing response shape', async () => {
    const result = await runMigrationProgress(
      { id: 'repo', name: 'test-repo', repoPath: repoDir },
      {
        old_pattern: '[',
        new_pattern: 'timerRegistry\\.setTimeout\\s*\\(',
        file_glob: 'src/**/*.ts',
      },
    );

    expect(result).toMatchObject({
      status: 'error',
      tool: 'migration_progress',
      repo: 'test-repo',
      file_glob: 'src/**/*.ts',
      exclude_patterns: [],
      summary: {
        total_old_sites: 0,
        total_new_sites: 0,
        pct_migrated: 0,
        files_remaining: 0,
        done_files: 0,
        scanned_files: 0,
      },
      by_module: [],
      remaining_files: [],
      done_files: [],
    });
    expect(result.error).toContain('Migration progress failed: Invalid old_pattern: ');
    expect(result.error).toContain('Invalid regular expression');
  });

  it('migration_progress preserves Symbol message interpolation in invalid regex wrapping', async () => {
    const globMock = vi.fn().mockResolvedValue([]);
    vi.resetModules();
    vi.doMock('glob', () => ({ glob: globMock }));

    try {
      const { runMigrationProgress: runIsolatedMigrationProgress } =
        await import('../../src/mcp/local/backend-migration-progress.js');
      const originalRegExp = globalThis.RegExp;
      vi.stubGlobal('RegExp', function RegExpStub() {
        throw { message: Symbol('regex') };
      } as unknown as RegExpConstructor);

      try {
        const result = await runIsolatedMigrationProgress(
          { id: 'repo', name: 'test-repo', repoPath: repoDir },
          {
            old_pattern: 'legacyCall',
            new_pattern: 'modernCall',
            file_glob: 'src/**/*.ts',
          },
        );

        expect(globMock).toHaveBeenCalled();
        expect(result.status).toBe('error');
        expect(result.error).toContain('Cannot convert a Symbol value to a string');
      } finally {
        vi.stubGlobal('RegExp', originalRegExp);
      }
    } finally {
      vi.doUnmock('glob');
      vi.resetModules();
    }
  });

  it('migration_progress preserves Symbol message interpolation in the outer error response', async () => {
    const params = Object.defineProperty(
      { new_pattern: 'timerRegistry\\.setTimeout\\s*\\(' },
      'old_pattern',
      {
        get() {
          throw { message: Symbol('outer') };
        },
      },
    ) as { old_pattern: string; new_pattern: string };

    await expect(
      runMigrationProgress({ id: 'repo', name: 'test-repo', repoPath: repoDir }, params),
    ).rejects.toThrow(TypeError);
  });

  it('type_coverage finds unsafe syntax and correlates caller counts', async () => {
    await fs.writeFile(
      path.join(repoDir, 'src', 'types.ts'),
      [
        'export function risky(input: any) {',
        '  // @ts-ignore',
        '  const narrowed = input as User;',
        '  return input!.name + narrowed.name;',
        '}',
      ].join('\n'),
      'utf8',
    );

    executeParameterized.mockResolvedValueOnce([
      {
        id: 'func:risky',
        name: 'risky',
        kind: 'Function',
        filePath: 'src/types.ts',
        startLine: 1,
        endLine: 5,
        callerCount: 2,
      },
    ]);

    const result = await runTypeCoverage(
      { id: 'repo', name: 'test-repo', repoPath: repoDir },
      {
        patterns: ['explicit_any', 'type_suppression', 'unsafe_cast', 'non_null_assertion'],
        file_glob: 'src/types.ts',
        limit: 10,
      },
    );

    expect(result.status).toBe('success');
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          pattern_type: 'explicit_any',
          enclosing_symbol: 'risky',
          caller_count: 2,
        }),
        expect.objectContaining({
          pattern_type: 'type_suppression',
          enclosing_symbol: 'risky',
          caller_count: 2,
        }),
        expect.objectContaining({
          pattern_type: 'unsafe_cast',
          enclosing_symbol: 'risky',
          caller_count: 2,
        }),
        expect.objectContaining({
          pattern_type: 'non_null_assertion',
          enclosing_symbol: 'risky',
          caller_count: 2,
        }),
      ]),
    );
  });
});
