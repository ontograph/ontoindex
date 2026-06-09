import { describe, expect, it } from 'vitest';
import type { AuditEvidence, AuditFinding } from '../../src/core/audit-lifecycle/audit-types.js';
import {
  createFixInvariant,
  createNegativeEvidence,
  verifyFixInvariantFreshness,
} from '../../src/core/audit-lifecycle/invariants.js';
import {
  classifyTombstoneMatch,
  createAuditTombstoneRecord,
  matchTombstoneByFingerprint,
  type AuditTombstoneRecord,
} from '../../src/core/audit-lifecycle/tombstones.js';

const targetHead = '2ce931e082ee';
const graphIndexId = 'idx:2ce931e:schema:1';
const verifierId = 'audit-lifecycle-static-patterns';
const verifierVersion = '0.1.0';
const verifiedAt = '2026-05-17T10:00:00.000Z';

function evidence(overrides: Partial<AuditEvidence> = {}): AuditEvidence {
  return {
    id: 'ev-negative',
    mode: 'ast',
    polarity: 'negative',
    targetHead,
    verifiedHead: targetHead,
    verifiedAt,
    verifierId,
    verifierVersion,
    confidence: 'high',
    reasonCodes: ['fresh-negative-evidence'],
    path: 'src/process.cpp',
    line: 42,
    symbol: 'spawnChild',
    detail: 'Verified unsafe pipe pattern is absent at target HEAD.',
    graphIndexId,
    ...overrides,
  };
}

function finding(overrides: Partial<AuditFinding> = {}): AuditFinding {
  return {
    findingId: 'AUDIT-M4-001',
    title: 'Direct-spawn pipe CLOEXEC race',
    severity: 'HIGH',
    status: 'NEEDS-VERIFY',
    source: {
      path: 'audits/report.md',
      hash: 'sha256:report',
      ingestedAt: '2026-05-17T09:00:00.000Z',
      dirtyWorktree: false,
    },
    targetRepo: 'fixture',
    targetRef: 'main',
    targetHead,
    graphIndexId,
    claimedEvidence: ['src/process.cpp:42 uses pipe()'],
    verifiedEvidence: [],
    negativeEvidence: [],
    statusReason: '',
    fixCommit: null,
    confidence: 0,
    reasonCodes: [],
    fingerprint: {
      location: 'loc:src/process.cpp:spawnChild',
      claim: 'claim:missing-cloexec',
      history: 'history:pipe-wrapper-fix',
    },
    claimDsl: {
      id: 'SIDE-FD-001',
      kind: 'forbidden-call-pattern',
      language: 'cpp',
      evidenceMode: 'ast',
      symbol: 'spawnChild',
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

function tombstone(overrides: Partial<AuditTombstoneRecord> = {}): AuditTombstoneRecord {
  const baseEvidence = evidence();
  return createAuditTombstoneRecord({
    id: 'tombstone:fd-wrapper-safe',
    findingId: 'AUDIT-M0-001',
    targetRepo: 'fixture',
    targetHead,
    graphIndexId,
    verifierId,
    verifierVersion,
    tombstonedAt: verifiedAt,
    reason: 'Fix removed unsafe pipe inheritance.',
    fingerprint: {
      location: 'loc:src/process.cpp:spawnChild',
      claim: 'claim:missing-cloexec',
      history: 'history:pipe-wrapper-fix',
    },
    invariant: createFixInvariant({
      id: 'inv:no-raw-pipe-in-spawnChild',
      kind: 'absence-of-pattern',
      state: 'holds',
      targetHead,
      verifiedHead: targetHead,
      verifiedAt,
      verifierId,
      verifierVersion,
      graphIndexId,
      reasonCodes: ['fresh-negative-evidence'],
      evidence: [baseEvidence],
      detail: 'spawnChild must not call raw pipe() without CLOEXEC.',
    }),
    fixCommit: 'abc1234',
    evidence: [baseEvidence],
    ...overrides,
  });
}

describe('audit lifecycle tombstones', () => {
  it('creates fresh negative evidence records', () => {
    expect(
      createNegativeEvidence({
        id: 'ev-fix-proof',
        mode: 'git-history',
        polarity: 'fix-proof',
        targetHead,
        verifiedAt,
        verifierId,
        verifierVersion,
        detail: 'Fix commit removed the unsafe call.',
        reasonCodes: ['fix-commit-found'],
      }),
    ).toMatchObject({
      id: 'ev-fix-proof',
      polarity: 'fix-proof',
      targetHead,
      verifiedHead: targetHead,
      reasonCodes: ['fix-commit-found'],
    });
  });

  it('matches future findings by layered fingerprints', () => {
    const exact = tombstone();
    const claimHistory = tombstone({
      id: 'tombstone:claim-history',
      fingerprint: {
        location: 'loc:renamed.cpp:spawnChild',
        claim: 'claim:missing-cloexec',
        history: 'history:pipe-wrapper-fix',
      },
    });

    expect(matchTombstoneByFingerprint(finding(), [claimHistory])?.layer).toBe('claim-history');
    expect(matchTombstoneByFingerprint(finding(), [claimHistory, exact])?.layer).toBe(
      'location-claim-history',
    );
  });

  it('classifies fresh tombstone with holding invariant as RESOLVED-ALREADY', () => {
    const classification = classifyTombstoneMatch(finding(), [tombstone()], {
      verifierId,
      verifierVersion,
    });

    expect(classification.status).toBe('RESOLVED-ALREADY');
    expect(classification.advisory).toBe(false);
    expect(classification.match?.tombstone.id).toBe('tombstone:fd-wrapper-safe');
    expect(classification.evidence).toHaveLength(1);
    expect(classification.evidence[0]).toMatchObject({
      mode: 'tombstone',
      polarity: 'tombstone-proof',
      reasonCodes: ['tombstone-match'],
    });
  });

  it('downgrades stale tombstones to advisory NEEDS-REVERIFY', () => {
    const classification = classifyTombstoneMatch(
      finding(),
      [tombstone({ targetHead: 'old-head' })],
      {
        verifierId,
        verifierVersion,
      },
    );

    expect(classification.status).toBe('NEEDS-REVERIFY');
    expect(classification.advisory).toBe(true);
    expect(classification.reasonCodes).toContain('stale-evidence');
    expect(classification.evidence[0]?.id).toBe('ev-negative');
  });

  it('requires invariant freshness against target HEAD and verifier version', () => {
    const invariant = createFixInvariant({
      ...tombstone().invariant,
      verifiedHead: 'old-head',
      verifierVersion: '0.0.9',
    });

    expect(
      verifyFixInvariantFreshness(invariant, {
        targetHead,
        graphIndexId,
        verifierId,
        verifierVersion,
      }),
    ).toMatchObject({
      fresh: false,
      holds: true,
      staleReasonCodes: expect.arrayContaining(['target-head-mismatch', 'stale-evidence']),
    });
  });
});
