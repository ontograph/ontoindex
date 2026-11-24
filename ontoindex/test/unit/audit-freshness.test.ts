import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  computeAuditFreshness,
  projectAuditStatusForFreshness,
  summarizeGitPorcelainStatus,
} from '../../src/core/audit-lifecycle/freshness.js';
import { evaluateFreshnessGatePolicy } from '../../src/core/audit-lifecycle/freshness-policy.js';
import { resolveTargetHead } from '../../src/core/audit-lifecycle/target-head.js';

let tmpDir: string | undefined;

afterEach(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = undefined;
});

describe('audit freshness utilities', () => {
  it('locks target HEAD for a local git ref', async () => {
    const repo = initRepo();
    const head = await resolveTargetHead(repo, {
      ref: 'HEAD',
      now: new Date('2026-05-17T00:00:00.000Z'),
    });

    expect(fs.realpathSync.native(head.gitRoot)).toBe(fs.realpathSync.native(repo));
    expect(head.ref).toBe('HEAD');
    expect(head.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(head.shortCommit).toHaveLength(12);
    expect(head.lockedAt).toBe('2026-05-17T00:00:00.000Z');
  });

  it('reports clean freshness when checkout still matches target HEAD', async () => {
    const repo = initRepo();
    const target = await resolveTargetHead(repo);
    const freshness = await computeAuditFreshness(repo, {
      target,
      now: new Date('2026-05-17T00:00:00.000Z'),
    });

    expect(freshness.state).toBe('clean');
    expect(freshness.currentHead).toBe(target.commit);
    expect(freshness.changedFiles).toEqual([]);
    expect(freshness.warnings).toEqual([]);
    expect(projectAuditStatusForFreshness('OPEN', freshness)).toBe('OPEN');
  });

  it('reports dirty freshness and downgrades stale evidence to NEEDS-REVERIFY', async () => {
    const repo = initRepo();
    const target = await resolveTargetHead(repo);
    fs.writeFileSync(path.join(repo, 'tracked.txt'), 'changed\n');
    fs.writeFileSync(path.join(repo, 'untracked.txt'), 'new\n');

    const freshness = await computeAuditFreshness(repo, { target });

    expect(freshness.state).toBe('dirty');
    expect(freshness.changedFiles).toEqual(['tracked.txt', 'untracked.txt']);
    expect(freshness.warnings).toContain(
      'Dirty checkout has 2 changed file(s) after target HEAD lock.',
    );
    expect(projectAuditStatusForFreshness('OPEN', freshness)).toBe('NEEDS-REVERIFY');
  });

  it('counts nested untracked files and decodes quoted Unicode and rename paths', async () => {
    const repo = initRepo();
    fs.writeFileSync(path.join(repo, 'tracked file with spaces.ts'), 'before\n');
    const renameSource = 'rename source -> naïve.ts';
    const renameDestination = 'rename destination -> café.ts';
    fs.writeFileSync(path.join(repo, renameSource), 'same payload\n');
    git(repo, 'add', 'tracked file with spaces.ts', renameSource);
    git(repo, 'commit', '-m', 'add worktree count fixtures');

    fs.writeFileSync(path.join(repo, 'tracked file with spaces.ts'), 'after\n');
    git(repo, 'mv', renameSource, renameDestination);
    const untrackedDir = path.join(repo, 'ontoindex', 'undefined');
    fs.mkdirSync(path.join(untrackedDir, 'nested dir', 'deeper'), { recursive: true });
    fs.writeFileSync(path.join(untrackedDir, 'one.ts'), 'one\n');
    fs.writeFileSync(path.join(untrackedDir, 'nested dir', 'two file.ts'), 'two\n');
    const unicodeUntrackedPath = 'nested dir/deeper/three file -> über.ts';
    fs.writeFileSync(path.join(untrackedDir, unicodeUntrackedPath), 'three\n');

    const compactStatus = git(repo, 'status', '--porcelain=v1');
    const expandedStatus = git(
      repo,
      '-c',
      'core.quotePath=true',
      'status',
      '--porcelain=v1',
      '--untracked-files=all',
    );
    const compactSummary = summarizeGitPorcelainStatus(compactStatus);
    const expandedSummary = summarizeGitPorcelainStatus(expandedStatus);
    const freshness = await computeAuditFreshness(repo);

    expect(compactSummary?.dirtyFileCount).toBe(3);
    expect(expandedSummary?.dirtyFileCount).toBe(5);
    expect(expandedSummary?.sourceFileCount).toBe(5);
    expect(expandedStatus).toMatch(/\\[0-7]{3}/);
    expect(
      expandedSummary?.dirtyFiles.filter(
        (file) => file.indexStatus === '?' && file.worktreeStatus === '?',
      ),
    ).toHaveLength(3);
    expect(expandedSummary?.dirtyFiles.map((file) => file.path)).toContain(renameDestination);
    expect(expandedSummary?.dirtyFiles.map((file) => file.path)).toContain(
      `ontoindex/undefined/${unicodeUntrackedPath}`,
    );
    expect(freshness.changedFiles).toEqual([
      `ontoindex/undefined/${unicodeUntrackedPath}`,
      'ontoindex/undefined/nested dir/two file.ts',
      'ontoindex/undefined/one.ts',
      renameDestination,
      'tracked file with spaces.ts',
    ]);

    expect(summarizeGitPorcelainStatus('?? plain name -> destination.ts')?.dirtyFiles[0]?.path).toBe(
      'plain name -> destination.ts',
    );
  });

  it('reports stale freshness when checkout HEAD advances after target lock', async () => {
    const repo = initRepo();
    const target = await resolveTargetHead(repo);
    fs.writeFileSync(path.join(repo, 'tracked.txt'), 'second\n');
    git(repo, 'add', 'tracked.txt');
    git(repo, 'commit', '-m', 'second');

    const freshness = await computeAuditFreshness(repo, { target });

    expect(freshness.state).toBe('stale');
    expect(freshness.commitsAfterTarget).toBe(1);
    expect(freshness.changedFiles).toEqual([]);
    expect(freshness.warnings[0]).toContain(`Target HEAD ${target.shortCommit} is stale`);
  });

  it('falls back to NEEDS-VERIFY when NEEDS-REVERIFY is unavailable', async () => {
    const status = projectAuditStatusForFreshness(
      'OPEN',
      { state: 'stale' },
      { availableStatuses: ['OPEN', 'NEEDS-VERIFY'] },
    );

    expect(status).toBe('NEEDS-VERIFY');
  });

  it('separates source freshness from graph staleness', () => {
    const decision = evaluateFreshnessGatePolicy({
      mode: 'strict',
      targetHead: 'target-head',
      currentHead: 'target-head',
      indexedHead: 'indexed-head',
      dirtyWorktree: false,
    });

    expect(decision.sourceFresh).toBe(true);
    expect(decision.graphStale).toBe(true);
    expect(decision.allowOpen).toBe(false);
    expect(decision.dispatchable).toBe(false);
    expect(decision.errorCode).toBe('STALE_INDEX_ERROR');
    expect(decision.reasonCodes).toEqual(['stale-evidence', 'target-head-mismatch']);
  });

  it('keeps advisory stale graph output dispatchable but marks explicit stale non-dispatchable', () => {
    expect(
      evaluateFreshnessGatePolicy({
        mode: 'advisory',
        targetHead: 'target-head',
        indexedHead: 'indexed-head',
      }),
    ).toMatchObject({ graphStale: true, allowOpen: true, dispatchable: true });

    expect(
      evaluateFreshnessGatePolicy({
        mode: 'explicit-stale',
        targetHead: 'target-head',
        indexedHead: 'target-head',
      }),
    ).toMatchObject({
      sourceFresh: false,
      graphStale: true,
      allowOpen: false,
      dispatchable: false,
      errorCode: 'STALE_INDEX_ERROR',
    });
  });
});

function initRepo(): string {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-audit-freshness-'));
  git(tmpDir, 'init', '--initial-branch=main');
  git(tmpDir, 'config', 'user.name', 'OntoIndex Test');
  git(tmpDir, 'config', 'user.email', 'ontoindex-test@example.com');
  fs.writeFileSync(path.join(tmpDir, 'tracked.txt'), 'initial\n');
  git(tmpDir, 'add', 'tracked.txt');
  git(tmpDir, 'commit', '-m', 'initial');
  return tmpDir;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}
