import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

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
});
