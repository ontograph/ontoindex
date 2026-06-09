import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ingestAuditFindings } from '../../src/core/audit-lifecycle/finding-ingest.js';

let tmpDir: string | undefined;

afterEach(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = undefined;
});

describe('audit finding ingest', () => {
  it('locks target HEAD, hashes source, and creates candidate-only findings', async () => {
    const repo = initRepo();
    const result = await ingestAuditFindings({
      repoPath: repo,
      targetRef: 'HEAD',
      sourceText: [
        '## Missing close guard',
        'Severity: HIGH',
        'Path: src/process.cpp',
        'Line: 42',
        '- Evidence: close(fd) return is unchecked',
      ].join('\n'),
      sourcePath: 'pasted-audit.md',
      now: new Date('2026-05-17T00:00:00.000Z'),
    });

    expect(result.targetHead).toMatch(/^[0-9a-f]{40}$/);
    expect(result.sourceHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(result.rawCount).toBe(1);
    expect(result.dedupedCount).toBe(1);
    expect(result.duplicatesCollapsed).toBe(0);
    expect(result.freshness.verifiedHead).toBeNull();
    expect(result.freshness.workingTreeDirtyAtVerify).toBe(false);
    expect(result.findings[0]).toMatchObject({
      status: 'NEEDS-VERIFY',
      severity: 'HIGH',
      targetHead: result.targetHead,
      verifiedEvidence: [],
      negativeEvidence: [],
      verifiedHead: null,
      verifiedAt: null,
      evidenceQuality: { sufficientForOpen: false },
    });
    expect(result.findings[0].status).not.toBe('OPEN');
  });

  it('collapses exact duplicates while preserving duplicate children', async () => {
    const repo = initRepo();
    const sourceText = [
      '## Missing close guard',
      'Path: src/process.cpp',
      'Line: 42',
      '- close(fd) return is unchecked',
      '',
      '## Missing close guard',
      'Path: src/process.cpp',
      'Line: 42',
      '- close(fd) return is unchecked',
    ].join('\n');

    const result = await ingestAuditFindings({
      repoPath: repo,
      sourceText,
      now: new Date('2026-05-17T00:00:00.000Z'),
    });

    expect(result.rawCount).toBe(2);
    expect(result.dedupedCount).toBe(1);
    expect(result.duplicatesCollapsed).toBe(1);
    expect(result.duplicateGroups).toEqual([
      {
        fingerprint: result.findings[0].exactDuplicateKey,
        parentFindingId: result.findings[0].findingId,
        childCount: 1,
      },
    ]);
    expect(result.findings[0].duplicateChildren).toHaveLength(1);
    expect(result.findings[0].duplicateChildren[0]).toMatchObject({ rawIndex: 1 });
  });

  it('marks line-only evidence insufficient for OPEN', async () => {
    const repo = initRepo();
    const result = await ingestAuditFindings({
      repoPath: repo,
      sourceText: ['## Claimed stale finding', '- src/process.cpp:42'].join('\n'),
      now: new Date('2026-05-17T00:00:00.000Z'),
    });

    expect(result.findings[0].status).toBe('NEEDS-VERIFY');
    expect(result.findings[0].claimedEvidence).toEqual(['src/process.cpp:42']);
    expect(result.findings[0].reasonCodes).toContain('missing-status-proof');
    expect(result.findings[0].evidenceQuality).toEqual({
      lineOnly: true,
      sufficientForOpen: false,
      reason: 'line-only-evidence',
    });
  });

  it('captures dirty freshness metadata after target lock', async () => {
    const repo = initRepo();
    fs.writeFileSync(path.join(repo, 'untracked.txt'), 'dirty\n');

    const result = await ingestAuditFindings({
      repoPath: repo,
      sourceText: '## Missing close guard\n- close(fd) return is unchecked\n',
      now: new Date('2026-05-17T00:00:00.000Z'),
    });

    expect(result.freshnessMetadata.state).toBe('dirty');
    expect(result.freshnessMetadata.changedFiles).toContain('untracked.txt');
    expect(result.freshness.workingTreeDirtyAtVerify).toBe(true);
    expect(result.findings[0].source.dirtyWorktree).toBe(true);
  });

  it('reads source text from sourcePath when pasted text is absent', async () => {
    const repo = initRepo();
    const reportPath = path.join(repo, 'audit-report.md');
    fs.writeFileSync(reportPath, '## Missing close guard\n- close(fd) return is unchecked\n');

    const result = await ingestAuditFindings({
      repoPath: repo,
      sourcePath: reportPath,
      now: new Date('2026-05-17T00:00:00.000Z'),
    });

    expect(result.sourcePath).toBe(reportPath);
    expect(result.rawCount).toBe(1);
    expect(result.findings[0].source.path).toBe(reportPath);
  });
});

function initRepo(): string {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-audit-ingest-'));
  git(tmpDir, 'init', '--initial-branch=main');
  git(tmpDir, 'config', 'user.name', 'OntoIndex Test');
  git(tmpDir, 'config', 'user.email', 'ontoindex-test@example.com');
  fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, 'src', 'process.cpp'), 'int main() { return 0; }\n');
  git(tmpDir, 'add', 'src/process.cpp');
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
