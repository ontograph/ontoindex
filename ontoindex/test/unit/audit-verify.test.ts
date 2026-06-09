import { describe, expect, it, vi } from 'vitest';

import type { AuditFinding } from '../../src/core/audit-lifecycle/audit-types.js';

const { verifyFindingFreshEvidenceMock, resolveTargetContextMock } = vi.hoisted(() => ({
  verifyFindingFreshEvidenceMock: vi.fn(async ({ finding }: { finding: AuditFinding }) => ({
    finding: {
      ...finding,
      status: 'OPEN',
      statusReason: 'fresh evidence verified',
      confidence: 1,
      reasonCodes: ['fresh-static-evidence'],
      verifiedAt: '2026-05-17T09:05:00.000Z',
      verifiedHead: finding.targetHead,
    },
    evidence: [
      {
        id: 'ev-1',
        mode: 'static',
        polarity: 'positive',
        path: 'src/process.cpp',
        line: 2,
        detail: 'pipe() without O_CLOEXEC remains reachable',
        confidence: 'high',
        verifierVersion: 'test-verifier',
        reasonCodes: ['fresh-static-evidence'],
        targetHead: finding.targetHead,
        graphIndexId: 'idx:test',
      },
    ],
    negativeEvidence: [],
    comments: [],
    testMentions: [],
    fixHistory: [],
    warnings: [],
  })),
  resolveTargetContextMock: vi.fn(async () => ({
    scope: 'repo',
    repoName: 'fixture',
    repoPath: '/workspace/fixture',
    storagePath: '/workspace/fixture/.ontoindex',
    indexedCommit: 'abc123',
    currentCommit: 'abc123',
    indexFresh: true,
    repoExists: true,
    gitAvailable: true,
  })),
}));

vi.mock('../../src/core/audit-lifecycle/index.js', () => ({
  FINDING_VERIFIER_VERSION: 'test-verifier',
  LocalAuditEventStore: class {
    async load() {
      return { events: [] };
    }
    async appendEvent() {}
  },
  verifyFindingFreshEvidence: verifyFindingFreshEvidenceMock,
}));

vi.mock('../../src/mcp/shared/target-context.js', () => ({
  resolveTargetContext: resolveTargetContextMock,
}));

import { runAuditVerify } from '../../src/mcp/super/audit-verify.js';

describe('runAuditVerify', () => {
  it('preserves the legacy response shape by default', async () => {
    const result = await runAuditVerify(
      '/workspace/fixture',
      {
        finding: finding(),
        persist: false,
      },
      'fixture',
    );

    expect(verifyFindingFreshEvidenceMock).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      version: 1,
      action: 'audit-verify',
      verifiedCount: 1,
      findings: [expect.objectContaining({ findingId: 'AUDIT-M3-001' })],
    });
    expect('envelopeVersion' in result).toBe(false);
  });

  it('preserves the legacy response shape when legacyResponse is true', async () => {
    const result = await runAuditVerify(
      '/workspace/fixture',
      {
        finding: finding(),
        persist: false,
        legacyResponse: true,
      },
      'fixture',
    );

    expect(result.action).toBe('audit-verify');
    expect('results' in result).toBe(false);
  });

  it('returns the capability-aware envelope when legacyResponse is false', async () => {
    const result = await runAuditVerify(
      '/workspace/fixture',
      {
        finding: finding(),
        persist: false,
        legacyResponse: false,
      },
      'fixture',
    );

    expect(resolveTargetContextMock).toHaveBeenCalledWith({ repo: 'fixture' });
    expect(result).toMatchObject({
      envelopeVersion: '1',
      tool: 'gn_audit_verify',
      status: 'ok',
      capabilitiesUsed: expect.arrayContaining([
        'audit-lifecycle',
        'filesystem-evidence',
        'git-history',
        'freshness-policy',
      ]),
      nextTools: expect.arrayContaining(['gn_fix_history', 'gn_audit_dedupe', 'gn_audit_bundle']),
    });
    expect(result.results).toMatchObject({
      verifiedCount: 1,
      findings: [expect.objectContaining({ findingId: 'AUDIT-M3-001' })],
    });
    expect(Array.isArray(result.evidence)).toBe(true);
  });
});

function finding(): AuditFinding {
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
    targetRepo: '/workspace/fixture',
    targetRef: 'HEAD',
    targetHead: 'abc123',
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
  };
}
