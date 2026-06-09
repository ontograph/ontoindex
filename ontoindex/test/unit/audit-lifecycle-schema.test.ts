import { describe, expect, it } from 'vitest';
import {
  assertValidFindingStatus,
  classifyUnsupportedClaim,
  createFindingWithProjectedStatus,
  projectFindingStatus,
  validateFindingLifecycle,
  type AuditEvidence,
  type AuditFinding,
} from '../../src/core/audit-lifecycle/index.js';

const targetHead = '2ce931e082ee';

function evidence(overrides: Partial<AuditEvidence> = {}): AuditEvidence {
  return {
    id: 'ev-1',
    mode: 'ast',
    polarity: 'positive',
    targetHead,
    verifiedHead: targetHead,
    verifiedAt: '2026-05-17T10:00:00.000Z',
    verifierId: 'audit-lifecycle-static-patterns',
    verifierVersion: '0.1.0',
    confidence: 'high',
    reasonCodes: ['fresh-positive-evidence'],
    path: 'src/process.cpp',
    line: 42,
    symbol: 'spawnChild',
    detail: 'pipe() is present without pipe2/O_CLOEXEC in the verified target.',
    graphIndexId: 'idx:2ce931e:schema:1',
    ...overrides,
  };
}

function finding(overrides: Partial<AuditFinding> = {}): AuditFinding {
  return {
    findingId: 'AUDIT-M0-001',
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
    graphIndexId: 'idx:2ce931e:schema:1',
    claimedEvidence: ['src/process.cpp:42 uses pipe()'],
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

describe('audit lifecycle schema contracts', () => {
  it('allows OPEN only with fresh verified evidence at target HEAD', () => {
    const open = finding({
      status: 'OPEN',
      verifiedEvidence: [evidence()],
      verifiedAt: '2026-05-17T10:00:00.000Z',
      verifiedHead: targetHead,
      confidence: 0.92,
    });

    expect(validateFindingLifecycle(open)).toEqual([]);
    expect(assertValidFindingStatus(open)).toBe(open);
  });

  it('downgrades copied or stale OPEN claims to NEEDS-VERIFY', () => {
    const projected = createFindingWithProjectedStatus(
      finding({
        status: 'OPEN',
        verifiedEvidence: [evidence({ verifiedHead: 'old-head' })],
        verifiedAt: '2026-05-16T10:00:00.000Z',
        verifiedHead: 'old-head',
      }),
    );

    expect(projected.status).toBe('NEEDS-VERIFY');
    expect(projected.reasonCodes).toContain('target-head-mismatch');
  });

  it('requires contradiction proof for RESOLVED-ALREADY and FALSE-POSITIVE', () => {
    const unresolved = validateFindingLifecycle(finding({ status: 'RESOLVED-ALREADY' }));
    expect(unresolved.map((item) => item.code)).toContain('missing-status-proof');

    const resolved = finding({
      status: 'RESOLVED-ALREADY',
      negativeEvidence: [
        evidence({
          id: 'ev-negative',
          polarity: 'fix-proof',
          mode: 'git-history',
          reasonCodes: ['fix-commit-found'],
          detail: 'Fix commit removed the unsafe call at target HEAD.',
        }),
      ],
      fixCommit: 'abc1234',
    });
    expect(validateFindingLifecycle(resolved)).toEqual([]);

    const falsePositive = finding({
      status: 'FALSE-POSITIVE',
      negativeEvidence: [
        evidence({
          id: 'ev-tombstone',
          polarity: 'tombstone-proof',
          mode: 'tombstone',
          reasonCodes: ['tombstone-match'],
          detail: 'Stable tombstone matches invariant exception.',
        }),
      ],
      tombstoneMatch: 'tombstone:fd-wrapper-safe',
    });
    expect(validateFindingLifecycle(falsePositive)).toEqual([]);
  });

  it('requires blocker metadata and reopen trigger for HOLD', () => {
    const invalid = validateFindingLifecycle(
      finding({ status: 'HOLD', verificationKind: 'static' }),
    );
    expect(invalid.map((item) => item.code)).toEqual(
      expect.arrayContaining([
        'missing-blocker-metadata',
        'missing-reopen-trigger',
        'runtime-required',
      ]),
    );

    const valid = finding({
      status: 'HOLD',
      verificationKind: 'runtime',
      blocker: {
        kind: 'runtime-required',
        requiredEnvironment: 'linux integration host with fork/exec tracing',
        detail: 'Needs runtime FD inheritance check.',
      },
      reopenTrigger: {
        kind: 'environment-available',
        detail: 'Reopen when the integration host is available.',
      },
    });
    expect(validateFindingLifecycle(valid)).toEqual([]);
  });

  it('classifies unsupported verifier claims as NEEDS-VERIFY, never OPEN', () => {
    const unsupported = finding({
      status: 'OPEN',
      claimDsl: {
        id: 'AI-ONLY-001',
        kind: 'semantic-vibes',
        language: 'cpp',
        evidenceMode: 'manual-review',
      },
    });

    expect(classifyUnsupportedClaim(unsupported.claimDsl)).toMatchObject({
      supported: false,
      behavior: 'NEEDS-VERIFY',
      reasonCodes: ['unsupported-claim-kind'],
    });
    expect(projectFindingStatus(unsupported).status).toBe('NEEDS-VERIFY');
  });

  it('classifies runtime-only unsupported claims as HOLD', () => {
    expect(
      classifyUnsupportedClaim({
        id: 'RUNTIME-001',
        kind: 'fork-scheduler-race',
        requiresRuntime: true,
      }),
    ).toMatchObject({
      supported: false,
      behavior: 'HOLD',
      reasonCodes: ['runtime-required'],
    });
  });
});
