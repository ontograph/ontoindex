import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { planExperimentalFileDeltaRefresh } from '../../src/core/analyze-delta.js';
import type { RepoMeta } from '../../src/storage/repo-manager.js';

const repoManagerMocks = vi.hoisted(() => ({
  loadMeta: vi.fn(),
}));

vi.mock('../../src/storage/repo-manager.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/storage/repo-manager.js')>();
  return {
    ...actual,
    loadMeta: repoManagerMocks.loadMeta,
  };
});

function runGit(repoPath: string, args: string[]): string {
  const result = spawnSync('git', args, {
    cwd: repoPath,
    encoding: 'utf8',
  });
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

function commitFile(
  repoPath: string,
  relativePath: string,
  contents: string,
  message: string,
): string {
  writeFile(repoPath, relativePath, contents);
  runGit(repoPath, ['add', relativePath]);
  runGit(repoPath, ['commit', '--quiet', '-m', message]);
  return runGit(repoPath, ['rev-parse', 'HEAD']);
}

describe('experimental file-delta planner', () => {
  beforeEach(() => {
    repoManagerMocks.loadMeta.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('uses bounded symbols-only analysis for clean source-file changes', async () => {
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-file-delta-safe-'));
    try {
      initGitRepo(repoDir);
      const baselineCommit = commitFile(repoDir, 'src/plain.ts', 'const answer = 1;\n', 'baseline');
      commitFile(repoDir, 'src/plain.ts', 'const answer = 2;\n', 'change');

      repoManagerMocks.loadMeta.mockResolvedValue({
        repoPath: repoDir,
        lastCommit: baselineCommit,
        indexedAt: new Date().toISOString(),
      } as RepoMeta);

      const plan = await planExperimentalFileDeltaRefresh(repoDir);

      expect(plan.baselineCommit).toBe(baselineCommit);
      expect(plan.safeToBound).toBe(true);
      expect(plan.forceFullAnalyze).toBe(false);
      expect(plan.changedFiles).toEqual(['src/plain.ts']);
      expect(plan.boundedIncludePaths).toEqual(['src/plain.ts']);
      expect(plan.unsafeReasons).toEqual([]);
      expect(plan.report).toContain('partial');
    } finally {
      fs.rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('falls back to full analyze when imports or exports are introduced', async () => {
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-file-delta-unsafe-'));
    try {
      initGitRepo(repoDir);
      const baselineCommit = commitFile(repoDir, 'src/plain.ts', 'const answer = 1;\n', 'baseline');
      commitFile(repoDir, 'src/plain.ts', 'export const answer = 2;\n', 'export change');

      repoManagerMocks.loadMeta.mockResolvedValue({
        repoPath: repoDir,
        lastCommit: baselineCommit,
        indexedAt: new Date().toISOString(),
      } as RepoMeta);

      const plan = await planExperimentalFileDeltaRefresh(repoDir);

      expect(plan.safeToBound).toBe(false);
      expect(plan.boundedIncludePaths).toEqual([]);
      expect(plan.changedFiles).toEqual(['src/plain.ts']);
      expect(plan.unsafeReasons).toEqual(
        expect.arrayContaining([expect.stringContaining('imports/exports detected')]),
      );
      expect(plan.report).toContain('falling back to full analyze');
    } finally {
      fs.rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('forces a full analyze when the workspace is dirty', async () => {
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-file-delta-dirty-'));
    try {
      initGitRepo(repoDir);
      const baselineCommit = commitFile(repoDir, 'src/plain.ts', 'const answer = 1;\n', 'baseline');
      writeFile(repoDir, 'src/plain.ts', 'const answer = 3;\n');

      repoManagerMocks.loadMeta.mockResolvedValue({
        repoPath: repoDir,
        lastCommit: baselineCommit,
        indexedAt: new Date().toISOString(),
      } as RepoMeta);

      const plan = await planExperimentalFileDeltaRefresh(repoDir);

      expect(plan.safeToBound).toBe(false);
      expect(plan.forceFullAnalyze).toBe(true);
      expect(plan.changedFiles).toEqual(['src/plain.ts']);
      expect(plan.unsafeReasons).toEqual(
        expect.arrayContaining([expect.stringContaining('working tree has uncommitted')]),
      );
    } finally {
      fs.rmSync(repoDir, { recursive: true, force: true });
    }
  });
});
