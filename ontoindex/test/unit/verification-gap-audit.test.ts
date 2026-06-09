import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

vi.mock('child_process', () => ({
  execFileSync: vi.fn(),
}));

vi.mock('../../src/core/lbug/pool-adapter.js', () => ({
  executeParameterized: vi.fn(),
}));

import { execFileSync } from 'child_process';
import { executeParameterized } from '../../src/core/lbug/pool-adapter.js';
import { auditVerificationGap } from '../../src/audit/verification-gap.js';

const execFileSyncMock = vi.mocked(execFileSync);
const executeParameterizedMock = vi.mocked(executeParameterized);

function mockChangedFiles(output: string): void {
  execFileSyncMock.mockReturnValueOnce('abc123\n').mockReturnValueOnce(output);
}

async function writeFile(repoPath: string, relPath: string, content: string): Promise<void> {
  const absPath = path.join(repoPath, relPath);
  await fs.mkdir(path.dirname(absPath), { recursive: true });
  await fs.writeFile(absPath, content, 'utf8');
}

describe('auditVerificationGap', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-verif-gap-'));
    execFileSyncMock.mockReset();
    executeParameterizedMock.mockReset();
    executeParameterizedMock.mockResolvedValue([]);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('marks a changed source file as covered when a test imports it directly', async () => {
    await writeFile(
      tmpDir,
      'src/mcp/local/backend-repomap.ts',
      'export function runRepomap() {}\n',
    );
    await writeFile(
      tmpDir,
      'test/unit/backend-repomap.test.ts',
      "import { runRepomap } from '../../src/mcp/local/backend-repomap.js';\n",
    );
    mockChangedFiles('src/mcp/local/backend-repomap.ts\n');

    const result = await auditVerificationGap({
      repoPath: tmpDir,
      repoId: 'repo-1',
      baseRef: 'HEAD~1',
    });

    expect(result.coverage).toEqual([
      expect.objectContaining({
        file: 'src/mcp/local/backend-repomap.ts',
        status: 'covered',
      }),
    ]);
    expect(result.coverage[0]!.gap).toContain('test/unit/backend-repomap.test.ts');
  });

  it('handles runtime .js imports that point at TypeScript source files in the same directory', async () => {
    await writeFile(
      tmpDir,
      'src/utils/math.ts',
      'export const add = (a: number, b: number) => a + b;\n',
    );
    await writeFile(
      tmpDir,
      'src/utils/math.test.ts',
      "import { add } from './math.js';\nexpect(add(1, 2)).toBe(3);\n",
    );
    mockChangedFiles('src/utils/math.ts\n');

    const result = await auditVerificationGap({
      repoPath: tmpDir,
      repoId: 'repo-1',
    });

    expect(result.coverage[0]).toEqual(
      expect.objectContaining({
        file: 'src/utils/math.ts',
        status: 'covered',
      }),
    );
  });

  it('falls back to weakly_covered when a naming-convention test exists but does not import the file', async () => {
    await writeFile(tmpDir, 'src/lib/token.ts', 'export const token = 1;\n');
    await writeFile(tmpDir, 'test/unit/token.test.ts', 'it("token", () => expect(1).toBe(1));\n');
    mockChangedFiles('src/lib/token.ts\n');

    const result = await auditVerificationGap({
      repoPath: tmpDir,
      repoId: 'repo-1',
    });

    expect(result.coverage[0]).toEqual(
      expect.objectContaining({
        file: 'src/lib/token.ts',
        status: 'weakly_covered',
      }),
    );
  });

  it('still reports graph-based coverage when no direct import exists', async () => {
    await writeFile(
      tmpDir,
      'src/mcp/local/backend-tech-debt.ts',
      'export function runTechDebt() {}\n',
    );
    mockChangedFiles('src/mcp/local/backend-tech-debt.ts\n');
    executeParameterizedMock.mockResolvedValue([{ hits: 2 } as any]);

    const result = await auditVerificationGap({
      repoPath: tmpDir,
      repoId: 'repo-1',
    });

    expect(result.coverage[0]).toEqual(
      expect.objectContaining({
        file: 'src/mcp/local/backend-tech-debt.ts',
        status: 'covered',
      }),
    );
    expect(result.coverage[0]!.gap).toContain('graph trace');
  });

  it('resolves base refs and diffs through argv instead of a shell command', async () => {
    await writeFile(tmpDir, 'src/lib/safe-diff.ts', 'export const value = 1;\n');
    mockChangedFiles('src/lib/safe-diff.ts\n');

    await auditVerificationGap({
      repoPath: tmpDir,
      baseRef: 'main; touch /tmp/owned',
    });

    expect(execFileSyncMock).toHaveBeenNthCalledWith(
      1,
      'git',
      ['rev-parse', '--verify', '--end-of-options', 'main; touch /tmp/owned^{commit}'],
      expect.objectContaining({ cwd: tmpDir }),
    );
    expect(execFileSyncMock).toHaveBeenNthCalledWith(
      2,
      'git',
      ['diff', '--name-only', 'abc123', '--'],
      expect.objectContaining({ cwd: tmpDir }),
    );
  });

  it('does not index oversized test files as direct import coverage', async () => {
    await writeFile(tmpDir, 'src/lib/large.ts', 'export const large = 1;\n');
    await writeFile(
      tmpDir,
      'test/unit/large.test.ts',
      `${'// padding\n'.repeat(120_000)}import { large } from '../../src/lib/large.js';\n`,
    );
    mockChangedFiles('src/lib/large.ts\n');

    const result = await auditVerificationGap({
      repoPath: tmpDir,
    });

    expect(result.coverage[0]).toEqual(
      expect.objectContaining({
        file: 'src/lib/large.ts',
        status: 'weakly_covered',
      }),
    );
    expect(result.coverage[0]!.gap).not.toContain('Direct test import');
  });
});
