import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../src/mcp/shared/target-context.js', () => ({ resolveTargetContext: vi.fn() }));
import { resolveTargetContext } from '../../src/mcp/shared/target-context.js';
import { gnDiffImpact, gnReviewDiff } from '../../src/mcp/super/diff-impact.js';
import { resolveCommitRef, resolveCommitRange } from '../../src/storage/git.js';
import { collectVerificationDiff } from '../../src/mcp/super/write-through-verification.js';
import { detectChanges } from '../../src/mcp/local/backend-detect-changes.js';
import { resolveTargetHead } from '../../src/core/audit-lifecycle/target-head.js';
import { findFixHistoryCandidates } from '../../src/core/audit-lifecycle/fix-history.js';

let repo: string;
const git = (...args: string[]) =>
  execFileSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
beforeEach(() => {
  repo = mkdtempSync(path.join(os.tmpdir(), 'git-ref-safety-'));
  git('init', '-b', 'main');
  git('config', 'user.email', 'test@example.test');
  git('config', 'user.name', 'Test');
  writeFileSync(path.join(repo, 'file.txt'), 'one');
  git('add', '.');
  git('commit', '-m', 'first');
  writeFileSync(path.join(repo, 'file.txt'), 'two');
  git('add', '.');
  git('commit', '-m', 'second');
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

describe('untrusted git revisions', () => {
  it('resolves valid revisions and ranges to commits', async () => {
    const head = git('rev-parse', 'HEAD');
    const previous = git('rev-parse', 'HEAD~1');
    expect(await resolveCommitRef(repo, 'HEAD')).toBe(head);
    expect(await resolveCommitRef(repo, 'main')).toBe(head);
    expect(await resolveCommitRange(repo, 'HEAD~1..HEAD')).toBe(`${previous}..${head}`);
    expect(await resolveCommitRange(repo, 'main...HEAD')).toBe(`${head}...${head}`);
    expect(await resolveCommitRange(repo, '..HEAD')).toBe(`${head}..${head}`);
  });

  it('rejects option injection before any consumer can create an output file', async () => {
    const output = path.join(repo, 'injected');
    const ref = `--output=${output}`;
    vi.mocked(resolveTargetContext).mockResolvedValue({
      status: 'ok',
      repoPath: repo,
      warnings: [],
    } as Awaited<ReturnType<typeof resolveTargetContext>>);
    await expect(gnDiffImpact('test', { commitRange: ref })).rejects.toThrow(
      'Invalid git revision',
    );
    await expect(gnReviewDiff('test', { commitRange: ref })).rejects.toThrow(
      'Invalid git revision',
    );
    await expect(resolveCommitRange(repo, ref)).rejects.toThrow('Invalid git revision');
    await expect(
      collectVerificationDiff({ id: 'test', repoPath: repo }, { diffRef: ref, changedSymbols: [] }),
    ).rejects.toThrow('Invalid git revision');
    expect(
      await detectChanges({ id: 'test', repoPath: repo }, { scope: 'compare', base_ref: ref }),
    ).toEqual({ error: `Invalid git revision: ${ref}` });
    await expect(resolveTargetHead(repo, { ref })).rejects.toThrow('Invalid git revision');
    await expect(
      findFixHistoryCandidates({
        repoPath: repo,
        targetHead: ref,
        path: 'file.txt',
        patterns: ['one'],
      }),
    ).rejects.toThrow('Invalid git revision');
    expect(existsSync(output)).toBe(false);
  });

  it.each(['', '\0', 'HEAD..main..HEAD', 'HEAD....main', 'missing-ref'])(
    'rejects invalid revision %j',
    async (ref) => {
      await expect(resolveCommitRange(repo, ref)).rejects.toThrow('Invalid git revision');
    },
  );
});
