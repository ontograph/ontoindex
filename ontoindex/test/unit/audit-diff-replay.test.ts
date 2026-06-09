import { describe, expect, it } from 'vitest';

import {
  buildAuditSessionDiff,
  type AuditDiffFindingLike,
  type AuditDiffSessionLike,
} from '../../src/core/audit-lifecycle/audit-diff.js';
import { buildAuditReplayPlan } from '../../src/core/audit-lifecycle/audit-replay.js';

const sessionA: AuditDiffSessionLike = {
  id: 'session-a',
  targetRepo: 'repo-a',
  targetHead: 'head-a',
  sourceHash: 'sha256:source-a',
  graphIndexId: 'index-a',
  verifierVersion: 'verifier-a',
};

const sessionB: AuditDiffSessionLike = {
  id: 'session-b',
  targetRepo: 'repo-a',
  targetHead: 'head-b',
  sourceHash: 'sha256:source-b',
  graphIndexId: 'index-b',
  verifierVersion: 'verifier-b',
};

describe('audit diff and replay core', () => {
  it('classifies new OPEN findings as added', () => {
    const diff = buildAuditSessionDiff(sessionA, [], sessionB, [
      finding('new-open', { fingerprint: 'fp-new-open', status: 'OPEN' }),
    ]);

    expect(diff.added).toHaveLength(1);
    expect(diff.added[0]?.current).toMatchObject({
      id: 'new-open',
      fingerprint: 'fp-new-open',
      status: 'OPEN',
    });
    expect(diff.removed).toEqual([]);
    expect(diff.statusChanged).toEqual([]);
    expect(diff.unchanged).toEqual([]);
  });

  it('classifies resolved or removed findings as removed when absent from the later session', () => {
    const diff = buildAuditSessionDiff(
      sessionA,
      [finding('old-open', { fingerprint: 'fp-old-open', status: 'OPEN' })],
      sessionB,
      [],
    );

    expect(diff.removed).toHaveLength(1);
    expect(diff.removed[0]?.previous).toMatchObject({
      id: 'old-open',
      fingerprint: 'fp-old-open',
      status: 'OPEN',
    });
  });

  it('classifies status changes by fingerprint even when finding ids differ', () => {
    const diff = buildAuditSessionDiff(
      sessionA,
      [finding('finding-a', { fingerprint: 'fp-shared', status: 'OPEN' })],
      sessionB,
      [finding('finding-b', { fingerprint: 'fp-shared', status: 'RESOLVED-ALREADY' })],
    );

    expect(diff.statusChanged).toEqual([
      expect.objectContaining({
        identity: 'fp-shared',
        match: 'fingerprint',
        previousStatus: 'OPEN',
        currentStatus: 'RESOLVED-ALREADY',
      }),
    ]);
  });

  it('classifies unchanged findings by id when fingerprint is unavailable', () => {
    const diff = buildAuditSessionDiff(
      sessionA,
      [finding('stable-id', { fingerprint: '', status: 'OPEN' })],
      sessionB,
      [finding('stable-id', { fingerprint: '', status: 'OPEN' })],
    );

    expect(diff.unchanged).toEqual([
      expect.objectContaining({
        identity: 'stable-id',
        match: 'id',
      }),
    ]);
  });

  it('treats replayed findings that gain fingerprints as unchanged by stable id', () => {
    const diff = buildAuditSessionDiff(
      sessionA,
      [finding('stable-id', { fingerprint: '', status: 'OPEN', evidenceKinds: ['static'] })],
      sessionB,
      [
        finding('stable-id', {
          fingerprint: 'fp-stable-id',
          status: 'OPEN',
          evidenceKinds: ['static', 'runtime'],
        }),
      ],
    );

    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.statusChanged).toEqual([]);
    expect(diff.unchanged).toEqual([
      expect.objectContaining({
        identity: 'stable-id',
        match: 'id',
        evidenceDelta: expect.objectContaining({
          totalDelta: 1,
          addedKinds: ['runtime'],
          removedKinds: [],
        }),
      }),
    ]);
  });

  it('summarizes findings and evidence deltas', () => {
    const diff = buildAuditSessionDiff(
      sessionA,
      [
        finding('removed-1'),
        finding('changed-1', { status: 'OPEN' }),
        finding('unchanged-1', {
          evidenceKinds: ['static'],
        }),
      ],
      sessionB,
      [
        finding('added-1'),
        finding('changed-1', { status: 'RESOLVED-ALREADY' }),
        finding('unchanged-1', {
          evidenceKinds: ['static', 'dynamic'],
        }),
      ],
    );

    expect(diff.summary).toEqual({
      added: 1,
      removed: 1,
      statusChanged: 1,
      unchanged: 1,
      totalFindings: {
        previous: 3,
        current: 3,
      },
    });

    const unchanged = diff.unchanged.find((e) => e.identity === 'fp-unchanged-1');
    expect(unchanged?.evidenceDelta).toMatchObject({
      totalDelta: 1,
      addedKinds: ['dynamic'],
      removedKinds: [],
    });

    const changed = diff.statusChanged.find((e) => e.identity === 'fp-changed-1');
    expect(changed?.evidenceDelta).toBeDefined();
  });

  it('plans targetHead replay without executing verification', () => {
    const plan = buildAuditReplayPlan(
      sessionA,
      [
        finding('fresh-open', {
          fingerprint: 'fp-fresh',
          status: 'OPEN',
          targetHead: 'head-b',
          verifiedHead: 'head-b',
          evidenceTargetHead: 'head-b',
        }),
        finding('stale-open', {
          fingerprint: 'fp-stale',
          status: 'OPEN',
          targetHead: 'head-a',
          verifiedHead: 'head-a',
          evidenceTargetHead: 'head-a',
        }),
        finding('needs-verify', {
          fingerprint: 'fp-needs',
          status: 'NEEDS-VERIFY',
          targetHead: 'head-b',
          verifiedHead: null,
          evidenceTargetHead: 'head-b',
        }),
      ],
      'head-b',
    );

    expect(plan.findings.map((item) => item.id)).toEqual(['needs-verify', 'stale-open']);
    expect(plan.findings.find((item) => item.id === 'stale-open')).toMatchObject({
      fingerprint: 'fp-stale',
      status: 'OPEN',
      action: 'reverify',
      evidence: {
        total: 1,
        targetHeads: ['head-a'],
        verifiedHeads: ['head-a'],
        verifierVersions: ['verifier-a'],
      },
      reasons: expect.arrayContaining([
        'target-head-changed',
        'finding-target-head-mismatch',
        'verified-head-mismatch',
        'evidence-target-head-mismatch',
      ]),
    });
    expect(plan.findings.find((item) => item.id === 'needs-verify')).toMatchObject({
      status: 'NEEDS-VERIFY',
      action: 'verify',
      reasons: expect.arrayContaining(['status-needs-verification']),
    });
  });
});

function finding(
  id: string,
  overrides: {
    fingerprint?: string;
    status?: string;
    targetHead?: string;
    verifiedHead?: string | null;
    evidenceTargetHead?: string;
    evidenceKinds?: string[];
  } = {},
): AuditDiffFindingLike {
  const {
    fingerprint = `fp-${id}`,
    status = 'OPEN',
    targetHead = 'head-a',
    verifiedHead = targetHead,
    evidenceTargetHead = targetHead,
    evidenceKinds = ['static'],
  } = overrides;

  return {
    id,
    title: `Finding ${id}`,
    ...(fingerprint !== undefined ? { fingerprint } : {}),
    status,
    targetHead,
    verifiedHead,
    evidence: evidenceKinds.map((kind) => ({
      kind,
      targetHead: evidenceTargetHead,
      verifiedHead: evidenceTargetHead,
      graphIndexId: 'index-a',
      verifierVersion: 'verifier-a',
      reasonCodes: ['fresh-positive-evidence'],
      verifiedAt: '2026-05-17T10:00:00.000Z',
    })),
  };
}
