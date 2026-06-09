import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AuditFinding } from '../../src/core/audit-lifecycle/audit-types.js';
import { verifyFindingFreshEvidence } from '../../src/core/audit-lifecycle/finding-verify.js';
import { findFixHistoryCandidates } from '../../src/core/audit-lifecycle/fix-history.js';
import {
  createFixInvariant,
  createNegativeEvidence,
} from '../../src/core/audit-lifecycle/invariants.js';
import { validateStatusTransition } from '../../src/core/audit-lifecycle/status-transitions.js';
import {
  createAuditTombstoneRecord,
  type AuditTombstoneRecord,
} from '../../src/core/audit-lifecycle/tombstones.js';

let repoDir: string;

beforeEach(async () => {
  repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-audit-verify-'));
  await git(['init']);
  await git(['config', 'user.email', 'audit@example.test']);
  await git(['config', 'user.name', 'Audit Test']);
});

afterEach(async () => {
  await fs.rm(repoDir, { recursive: true, force: true });
});

describe('fresh evidence verifier', () => {
  it('opens supported findings only when fresh positive evidence exists at target HEAD', async () => {
    await writeFile(
      'src/process.cpp',
      'int spawnChild() {\n  int fds[2];\n  return pipe(fds);\n}\n',
    );
    await commit('unsafe pipe');
    const targetHead = await revParse('HEAD');

    const result = await verifyFindingFreshEvidence({
      repoPath: repoDir,
      finding: finding(targetHead),
      now: new Date('2026-05-17T10:00:00.000Z'),
    });

    expect(result.finding.status).toBe('OPEN');
    expect(result.finding.verifiedHead).toBe(targetHead);
    expect(result.finding.verifiedEvidence[0]).toMatchObject({
      polarity: 'positive',
      targetHead,
      verifiedHead: targetHead,
      fileHash: expect.stringMatching(/^sha256:/),
      reasonCodes: ['fresh-positive-evidence'],
      symbol: 'spawnChild',
    });
  });

  it('labels dirty overlay source evidence separately from stale graph evidence', async () => {
    await writeFile('src/process.cpp', 'int spawnChild() { return 0; }\n');
    await commit('safe baseline');
    const targetHead = await revParse('HEAD');
    await writeFile(
      'src/process.cpp',
      'int spawnChild() {\n  int fds[2];\n  return pipe(fds);\n}\n',
    );

    const result = await verifyFindingFreshEvidence({
      repoPath: repoDir,
      finding: finding(targetHead),
      now: new Date('2026-05-17T10:00:00.000Z'),
      snapshotMode: 'dirty-worktree-overlay',
      changedFiles: ['src/process.cpp'],
      changedSymbols: ['spawnChild'],
      staleWarnings: ['Indexed graph is stale; filesystem overlay is current.'],
      freshnessPolicy: {
        mode: 'advisory',
        targetHead,
        currentHead: targetHead,
        indexedHead: 'indexed-old',
        dirtyWorktree: false,
      },
    });

    expect(result.finding.status).toBe('OPEN');
    expect(result.finding.statusReason).toContain('filesystem evidence');
    expect(result.finding.verifiedEvidence[0]).toMatchObject({
      source: 'filesystem',
      sourceFresh: true,
      graphStale: true,
      staleWarnings: ['Indexed graph is stale; filesystem overlay is current.'],
      reasonCodes: ['fresh-positive-evidence'],
    });
    expect(result.finding.reasonCodes).toContain('stale-evidence');
  });

  it('does not open findings without fresh positive evidence and records fix history candidates', async () => {
    await writeFile(
      'src/process.cpp',
      'int spawnChild() {\n  int fds[2];\n  return pipe(fds);\n}\n',
    );
    await commit('unsafe pipe');
    await writeFile(
      'src/process.cpp',
      'int spawnChild() {\n  int fds[2];\n  return pipe2(fds, O_CLOEXEC);\n}\n',
    );
    await commit('fix cloexec pipe');
    const targetHead = await revParse('HEAD');

    const result = await verifyFindingFreshEvidence({
      repoPath: repoDir,
      finding: finding(targetHead),
      now: new Date('2026-05-17T10:00:00.000Z'),
    });

    expect(result.finding.status).toBe('RESOLVED-ALREADY');
    expect(result.finding.verifiedEvidence).toEqual([]);
    expect(result.finding.negativeEvidence.map((item) => item.polarity)).toContain('negative');
    expect(result.finding.fixCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(result.finding.reasonCodes).toEqual(
      expect.arrayContaining(['fresh-negative-evidence', 'fix-commit-found']),
    );
  });

  it('classifies unsupported and runtime claims without opening them', async () => {
    await writeFile('src/process.cpp', 'int spawnChild() { return 0; }\n');
    await commit('safe baseline');
    const targetHead = await revParse('HEAD');

    const unsupported = await verifyFindingFreshEvidence({
      repoPath: repoDir,
      finding: finding(targetHead, {
        claimDsl: {
          id: 'RUNTIME-001',
          kind: 'fork-scheduler-race',
          requiresRuntime: true,
        },
      }),
    });

    expect(unsupported.finding.status).toBe('HOLD');
    expect(unsupported.finding.reasonCodes).toContain('runtime-required');
    expect(unsupported.finding.blocker?.kind).toBe('runtime-required');
  });

  it('forces runtime-only heuristic claims to HOLD even when static patterns match', async () => {
    await writeFile(
      'src/process.cpp',
      'int spawnChild() {\n  int fds[2];\n  return pipe(fds);\n}\n',
    );
    await commit('unsafe pipe');
    const targetHead = await revParse('HEAD');

    const result = await verifyFindingFreshEvidence({
      repoPath: repoDir,
      finding: finding(targetHead, {
        title: 'Direct-spawn pipe race under load',
        claimedEvidence: ['Requires telemetry for cgroup host behavior under load.'],
      }),
      now: new Date('2026-05-17T10:00:00.000Z'),
    });

    expect(result.finding.status).toBe('HOLD');
    expect(result.finding.reasonCodes).toContain('runtime-required');
    expect(result.finding.verifiedEvidence).toEqual([]);
  });

  it('finds comment and test mentions as partial evidence without driving OPEN', async () => {
    await writeFile(
      'src/process.cpp',
      '// AUDIT-FD-001: previous unsafe pipe report was fixed\nint spawnChild() { return 0; }\n',
    );
    await writeFile(
      'test/process.test.ts',
      "it('covers AUDIT-FD-001 cloexec regression', () => undefined);\n",
    );
    await commit('document fixed audit case');
    const targetHead = await revParse('HEAD');

    const result = await verifyFindingFreshEvidence({
      repoPath: repoDir,
      finding: finding(targetHead),
      now: new Date('2026-05-17T10:00:00.000Z'),
    });

    expect(result.finding.status).toBe('RESOLVED-ALREADY');
    expect(result.comments).toHaveLength(1);
    expect(result.testMentions).toHaveLength(1);
    expect(result.finding.verifiedEvidence.map((item) => item.id)).toEqual(
      expect.arrayContaining(['AUDIT-M3-001:comment-mention', 'AUDIT-M3-001:test-mention']),
    );
  });

  it('validates status transitions that require proof', () => {
    const targetHead = 'abc123';
    const projected = validateStatusTransition({
      from: 'NEEDS-VERIFY',
      to: 'OPEN',
      finding: finding(targetHead, { status: 'OPEN' }),
    });

    expect(projected.status).toBe('NEEDS-VERIFY');
    expect(projected.reasonCodes).toContain('missing-status-proof');
  });

  it('downgrades resolved statuses without fresh negative proof', () => {
    const targetHead = 'abc123';
    const projected = validateStatusTransition({
      from: 'NEEDS-VERIFY',
      to: 'RESOLVED-ALREADY',
      finding: finding(targetHead, {
        status: 'RESOLVED-ALREADY',
        fixCommit: 'abc1234',
      }),
    });

    expect(projected.status).toBe('NEEDS-VERIFY');
    expect(projected.reasonCodes).toContain('missing-status-proof');
  });

  it('treats active tombstone matches as resolved before reopening', async () => {
    await writeFile(
      'src/process.cpp',
      'int spawnChild() {\n  int fds[2];\n  return pipe(fds);\n}\n',
    );
    await commit('unsafe pipe');
    const targetHead = await revParse('HEAD');

    const result = await verifyFindingFreshEvidence({
      repoPath: repoDir,
      finding: finding(targetHead),
      tombstones: [tombstone(targetHead)],
      now: new Date('2026-05-17T10:00:00.000Z'),
    });

    expect(result.finding.status).toBe('RESOLVED-ALREADY');
    expect(result.finding.tombstoneMatch).toBe('tombstone:fd-wrapper-safe');
    expect(result.finding.negativeEvidence[0]).toMatchObject({
      polarity: 'tombstone-proof',
      reasonCodes: ['tombstone-match'],
    });
    expect(result.finding.verifiedEvidence).toEqual([]);
  });

  it('requires explicit tombstone invariant failure metadata before reopening', async () => {
    await writeFile(
      'src/process.cpp',
      'int spawnChild() {\n  int fds[2];\n  return pipe(fds);\n}\n',
    );
    await commit('unsafe pipe');
    const targetHead = await revParse('HEAD');

    const result = await verifyFindingFreshEvidence({
      repoPath: repoDir,
      finding: finding(targetHead),
      tombstones: [
        tombstone(targetHead, {
          invariantState: 'violated',
        }),
      ],
      now: new Date('2026-05-17T10:00:00.000Z'),
    });

    expect(result.finding.status).toBe('OPEN');
    expect(result.finding.tombstoneMatch).toBe('tombstone:fd-wrapper-safe');
    expect(result.finding.verifiedEvidence[0]?.reasonCodes).toContain('fresh-positive-evidence');
  });

  it('exposes bounded fix history lookup', async () => {
    await writeFile('src/process.cpp', 'int spawnChild() { return pipe(0); }\n');
    await commit('unsafe pipe');
    await writeFile('src/process.cpp', 'int spawnChild() { return pipe2(0, O_CLOEXEC); }\n');
    await commit('fix pipe');
    const targetHead = await revParse('HEAD');

    await expect(
      findFixHistoryCandidates({
        repoPath: repoDir,
        targetHead,
        path: 'src/process.cpp',
        patterns: ['pipe'],
        limit: 2,
      }),
    ).resolves.toHaveLength(2);
  });
});

function finding(targetHead: string, overrides: Partial<AuditFinding> = {}): AuditFinding {
  return {
    findingId: 'AUDIT-M3-001',
    title: 'Direct-spawn pipe CLOEXEC race',
    severity: 'HIGH',
    status: 'NEEDS-VERIFY',
    source: {
      path: 'audits/report.md',
      hash: 'sha256:report',
      ingestedAt: '2026-05-17T09:00:00.000Z',
      dirtyWorktree: false,
    },
    targetRepo: repoDir,
    targetRef: 'HEAD',
    targetHead,
    graphIndexId: 'idx:test',
    claimedEvidence: ['AUDIT-FD-001 src/process.cpp spawnChild pipe without O_CLOEXEC'],
    verifiedEvidence: [],
    negativeEvidence: [],
    statusReason: '',
    fixCommit: null,
    confidence: 0,
    reasonCodes: [],
    fingerprint: {
      location: 'loc-hash',
      claim: 'claim-hash',
      history: 'history-hash',
    },
    claimDsl: {
      id: 'AUDIT-FD-001',
      kind: 'forbidden-call-pattern',
      language: 'cpp',
      evidenceMode: 'ast',
      symbol: 'spawnChild',
      path: 'src/process.cpp',
      pattern: { calls: ['pipe'], missing_any: ['pipe2', 'O_CLOEXEC'] },
      risk: 'fd-leak-across-fork',
    },
    verificationKind: 'static',
    verifiedAt: null,
    verifiedHead: null,
    statusChangedAt: null,
    statusChangedBy: 'ontoindex',
    statusTransitionEvidence: [],
    reopenTrigger: null,
    blocker: null,
    tombstoneMatch: null,
    ...overrides,
  };
}

async function writeFile(filePath: string, content: string): Promise<void> {
  const absolute = path.join(repoDir, filePath);
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  await fs.writeFile(absolute, content);
}

async function commit(message: string): Promise<void> {
  await git(['add', '.']);
  await git(['commit', '-m', message]);
}

async function revParse(ref: string): Promise<string> {
  return (await git(['rev-parse', ref])).trim();
}

function tombstone(
  targetHead: string,
  options: { invariantState?: 'holds' | 'violated' | 'unknown' } = {},
): AuditTombstoneRecord {
  const verifiedAt = '2026-05-17T09:30:00.000Z';
  const negativeEvidence = createNegativeEvidence({
    id: 'ev-negative',
    mode: 'ast',
    polarity: 'negative',
    targetHead,
    verifiedAt,
    verifierId: 'audit-lifecycle-core-fresh-evidence',
    verifierVersion: '0.1.0',
    graphIndexId: 'idx:test',
    path: 'src/process.cpp',
    symbol: 'spawnChild',
    detail: 'Unsafe pipe pattern was absent when the tombstone was created.',
  });

  return createAuditTombstoneRecord({
    id: 'tombstone:fd-wrapper-safe',
    findingId: 'AUDIT-M0-001',
    targetRepo: repoDir,
    targetHead,
    graphIndexId: 'idx:test',
    verifierId: 'audit-lifecycle-core-fresh-evidence',
    verifierVersion: '0.1.0',
    tombstonedAt: verifiedAt,
    reason: 'Fix removed unsafe pipe inheritance.',
    fingerprint: {
      location: 'loc-hash',
      claim: 'claim-hash',
      history: 'history-hash',
    },
    invariant: createFixInvariant({
      id: 'inv:fd-wrapper-safe',
      kind: 'absence-of-pattern',
      state: options.invariantState ?? 'holds',
      targetHead,
      verifiedHead: targetHead,
      verifiedAt,
      verifierId: 'audit-lifecycle-core-fresh-evidence',
      verifierVersion: '0.1.0',
      graphIndexId: 'idx:test',
      reasonCodes: ['fresh-negative-evidence'],
      evidence: [negativeEvidence],
      detail: 'Unsafe pipe inheritance is absent.',
    }),
    evidence: [negativeEvidence],
    negativeEvidence: [negativeEvidence],
  });
}

async function git(args: string[]): Promise<string> {
  const { execFile } = await import('node:child_process');
  return await new Promise<string>((resolve, reject) => {
    execFile('git', args, { cwd: repoDir }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr || error.message));
        return;
      }
      resolve(stdout);
    });
  });
}
