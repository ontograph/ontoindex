import { describe, expect, it } from 'vitest';

import type { AuditFinding } from '../../src/core/audit-lifecycle/audit-types.js';
import {
  adaptSystemsAuditEvidenceForResourceClaim,
  type SystemsAuditEvidence,
} from '../../src/core/audit-lifecycle/verifiers/resource-claims.js';

describe('systems-audit resource claim verifier adapter', () => {
  it('rejects systems evidence without provenance before it can drive status', () => {
    const targetHead = 'abc123';
    const result = adaptSystemsAuditEvidenceForResourceClaim({
      finding: finding(targetHead),
      evidence: [
        systemsEvidence({
          targetHead,
          verifiedHead: targetHead,
          provenance: undefined,
        }),
      ],
    });

    expect(result.finding.status).toBe('NEEDS-VERIFY');
    expect(result.acceptedEvidence).toEqual([]);
    expect(result.rejectedEvidence).toHaveLength(1);
    expect(result.warnings).toContain('missing-status-proof');
  });

  it('downgrades stale sidecar evidence through the status validator', () => {
    const result = adaptSystemsAuditEvidenceForResourceClaim({
      finding: finding('new-head'),
      evidence: [
        systemsEvidence({
          targetHead: 'old-head',
          verifiedHead: 'old-head',
          polarity: 'negative',
        }),
      ],
    });

    expect(result.acceptedEvidence).toHaveLength(1);
    expect(result.finding.status).toBe('NEEDS-REVERIFY');
    expect(result.projection.reasonCodes).toEqual(expect.arrayContaining(['target-head-mismatch']));
  });

  it('classifies fresh negative systems evidence as resolved already through validator', () => {
    const targetHead = 'abc123';
    const result = adaptSystemsAuditEvidenceForResourceClaim({
      finding: finding(targetHead),
      evidence: [
        systemsEvidence({
          targetHead,
          verifiedHead: targetHead,
          polarity: 'negative',
        }),
      ],
    });

    expect(result.finding.status).toBe('RESOLVED-ALREADY');
    expect(result.finding.negativeEvidence[0]).toMatchObject({
      mode: 'resource-lifecycle',
      polarity: 'negative',
      reasonCodes: ['fresh-negative-evidence'],
      verifierId: 'systems-resource-leak',
    });
    expect(result.projection.warnings).toEqual([]);
  });

  it('opens fresh positive systems evidence only for matching resource claim kinds', () => {
    const targetHead = 'abc123';
    const result = adaptSystemsAuditEvidenceForResourceClaim({
      finding: finding(targetHead, { claimDsl: { ...baseClaim(), kind: 'missing-cleanup' } }),
      evidence: [
        systemsEvidence({
          claimKind: 'resource-leak',
          targetHead,
          verifiedHead: targetHead,
          polarity: 'positive',
        }),
      ],
    });

    expect(result.finding.status).toBe('NEEDS-VERIFY');
    expect(result.acceptedEvidence).toEqual([]);
    expect(result.rejectedEvidence).toHaveLength(1);
  });
});

function systemsEvidence(overrides: Partial<SystemsAuditEvidence> = {}): SystemsAuditEvidence {
  return {
    id: 'ev-1',
    claimKind: 'resource-leak',
    polarity: 'positive',
    targetHead: 'abc123',
    verifiedHead: 'abc123',
    verifiedAt: '2026-05-17T10:00:00.000Z',
    analyzerId: 'systems-resource-leak',
    analyzerVersion: '0.1.0',
    confidence: 'high',
    path: 'src/process.cpp',
    line: 42,
    symbol: 'spawnChild',
    detail: 'open handle reaches return without cleanup',
    provenance: {
      sidecarRelease: 'sidecar-only-2026.05',
      sidecarSchemaVersion: 'systems-audit/v1',
      sidecarStateHash: 'sha256:sidecar',
      recordKind: 'systems.resource_lifecycle',
    },
    ...overrides,
  };
}

function finding(targetHead: string, overrides: Partial<AuditFinding> = {}): AuditFinding {
  return {
    findingId: 'AUDIT-S5-001',
    title: 'Resource leak',
    severity: 'HIGH',
    status: 'NEEDS-VERIFY',
    source: {
      path: 'audits/report.md',
      hash: 'sha256:report',
      ingestedAt: '2026-05-17T09:00:00.000Z',
      dirtyWorktree: false,
    },
    targetRepo: '/repo',
    targetRef: 'HEAD',
    targetHead,
    graphIndexId: 'idx:test',
    claimedEvidence: ['src/process.cpp leaks fd'],
    verifiedEvidence: [],
    negativeEvidence: [],
    statusReason: '',
    fixCommit: null,
    confidence: 0,
    reasonCodes: [],
    fingerprint: {
      location: 'loc',
      claim: 'claim',
      history: 'history',
    },
    claimDsl: baseClaim(),
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

function baseClaim(): NonNullable<AuditFinding['claimDsl']> {
  return {
    id: 'AUDIT-S5-001',
    kind: 'resource-leak',
    language: 'cpp',
    evidenceMode: 'resource-lifecycle',
    path: 'src/process.cpp',
    symbol: 'spawnChild',
  };
}
