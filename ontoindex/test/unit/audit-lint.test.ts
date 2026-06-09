import { describe, expect, it } from 'vitest';
import {
  lintAuditBundles,
  lintAuditLifecycle,
  lintAuditReport,
  type AuditLintBundle,
  type AuditLintFinding,
} from '../../src/core/audit-lifecycle/audit-lint.js';
import type { AuditEvidence } from '../../src/core/audit-lifecycle/index.js';
import {
  formatAuditLintJUnit,
  formatAuditLintSarif,
  formatScopeGuardSarif,
} from '../../src/cli/ci-export.js';
import { runAuditLint } from '../../src/mcp/super/audit-lint.js';
import { expectSchemaMatch, loadJsonFixture } from '../helpers/json-schema.js';

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
    detail: 'Verified unsafe pipe usage at target HEAD.',
    graphIndexId: 'idx:2ce931e:schema:1',
    ...overrides,
  };
}

function finding(overrides: Partial<AuditLintFinding> = {}): AuditLintFinding {
  return {
    findingId: 'AUDIT-M5-001',
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

function bundle(overrides: Partial<AuditLintBundle> = {}): AuditLintBundle {
  return {
    id: 'bundle-1',
    sessionId: 'session-1',
    findingIds: ['AUDIT-M5-001'],
    status: 'CREATED',
    createdAt: '2026-05-17T11:00:00.000Z',
    metadata: {
      tests: ['ONTOINDEX_MAX_WORKERS=7 npx vitest run test/unit/audit-lint.test.ts'],
      impactTargets: ['spawnChild'],
    },
    ...overrides,
  };
}

describe('audit lifecycle lint', () => {
  it('accepts fresh report lint without requiring bundles', () => {
    const result = lintAuditReport({
      findings: [
        finding({
          status: 'OPEN',
          verifiedAt: '2026-05-17T10:00:00.000Z',
          verifiedHead: targetHead,
          verifiedEvidence: [evidence()],
        }),
      ],
    });

    expect(result).toMatchObject({ ok: true, exitRecommendation: 'zero', issues: [] });
  });

  it('rejects stale OPEN, STILL-OPEN, and line-only OPEN findings', () => {
    const result = lintAuditReport({
      findings: [
        finding({
          findingId: 'stale-open',
          status: 'OPEN',
          verifiedAt: '2026-05-16T10:00:00.000Z',
          verifiedHead: 'old-head',
          verifiedEvidence: [evidence({ verifiedHead: 'old-head' })],
        }),
        finding({ findingId: 'copied-open', status: 'STILL-OPEN' }),
        finding({
          findingId: 'line-only',
          status: 'OPEN',
          claimDsl: null,
          verifiedAt: '2026-05-17T10:00:00.000Z',
          verifiedHead: targetHead,
          verifiedEvidence: [evidence({ symbol: undefined })],
        }),
      ],
    });

    expect(result.ok).toBe(false);
    expect(result.exitRecommendation).toBe('nonzero');
    expect(result.issues.map((issue) => issue.ruleId)).toEqual(
      expect.arrayContaining([
        'open-requires-fresh-evidence',
        'no-still-open-status',
        'no-line-only-open',
      ]),
    );
    expect(result.issues.find((issue) => issue.findingId === 'copied-open')).toMatchObject({
      suggestedStatus: 'NEEDS-VERIFY',
    });
  });

  it('requires runtime evidence for runtime-only OPEN findings', () => {
    const result = lintAuditReport({
      findings: [
        finding({
          status: 'OPEN',
          verificationKind: 'runtime',
          claimDsl: {
            id: 'RUNTIME-001',
            kind: 'fork-scheduler-race',
            requiresRuntime: true,
          },
          verifiedAt: '2026-05-17T10:00:00.000Z',
          verifiedHead: targetHead,
          verifiedEvidence: [evidence()],
        }),
      ],
    });

    expect(result.issues).toContainEqual(
      expect.objectContaining({
        ruleId: 'runtime-open-requires-runtime-evidence',
        suggestedStatus: 'HOLD',
      }),
    );
  });

  it('rejects duplicate root causes split into separate implementation work', () => {
    const result = lintAuditReport({
      findings: [
        finding({
          findingId: 'dup-1',
          status: 'OPEN',
          rootCauseId: 'rc-fd-leak',
          bundleId: 'bundle-a',
          verifiedAt: '2026-05-17T10:00:00.000Z',
          verifiedHead: targetHead,
          verifiedEvidence: [evidence()],
        }),
        finding({
          findingId: 'dup-2',
          status: 'OPEN',
          rootCauseId: 'rc-fd-leak',
          bundleId: 'bundle-b',
          verifiedAt: '2026-05-17T10:00:00.000Z',
          verifiedHead: targetHead,
          verifiedEvidence: [evidence({ id: 'ev-2' })],
        }),
      ],
    });

    expect(
      result.issues.filter((issue) => issue.ruleId === 'no-duplicate-root-cause-work'),
    ).toHaveLength(2);
  });

  it('rejects tombstoned reopen while invariant holds and incomplete HOLD metadata', () => {
    const result = lintAuditReport({
      findings: [
        finding({
          findingId: 'reopened-tombstone',
          status: 'OPEN',
          tombstoneMatch: 'tombstone:fd-wrapper-safe',
          metadata: { tombstoneInvariantHolds: true },
          verifiedAt: '2026-05-17T10:00:00.000Z',
          verifiedHead: targetHead,
          verifiedEvidence: [evidence()],
        }),
        finding({ findingId: 'bad-hold', status: 'HOLD', verificationKind: null }),
      ],
    });

    expect(result.issues.map((issue) => issue.ruleId)).toEqual(
      expect.arrayContaining([
        'no-tombstone-reopen-while-invariant-holds',
        'hold-requires-verification-and-reopen-trigger',
      ]),
    );
  });

  it('runs bundle lint only when bundles are provided', () => {
    const reportOnly = lintAuditLifecycle({ findings: [] });
    const withBundles = lintAuditLifecycle({
      findings: [],
      bundles: [bundle({ metadata: { tests: [] } })],
    });

    expect(reportOnly.issues).toEqual([]);
    expect(withBundles.issues.map((issue) => issue.ruleId)).toEqual(
      expect.arrayContaining(['bundle-requires-tests', 'bundle-requires-impact-targets']),
    );
  });

  it('accepts bundle tests and impact targets from top-level or metadata fields', () => {
    expect(lintAuditBundles({ bundles: [bundle()] }).ok).toBe(true);
    expect(
      lintAuditBundles({
        bundles: [
          bundle({
            tests: ['npm test'],
            impactTargets: ['spawnChild'],
            metadata: {},
          }),
        ],
      }).ok,
    ).toBe(true);
  });

  it('keeps advisory findings non-blocking through severity and exit recommendation', () => {
    const result = lintAuditReport({ findings: [finding({ status: 'OPEN' })] }, { advisory: true });

    expect(result.ok).toBe(false);
    expect(result.exitRecommendation).toBe('zero');
    expect(result.issues).toContainEqual(
      expect.objectContaining({ severity: 'warning', ruleId: 'open-requires-fresh-evidence' }),
    );
  });

  it('paginates lint issues with deterministic cursors', async () => {
    const result = await runAuditLint('/repo', {
      findings: [
        finding({ findingId: 'A-1', status: 'OPEN', rootCauseId: 'rc-a' }),
        finding({ findingId: 'B-1', status: 'OPEN', rootCauseId: 'rc-b' }),
      ],
      maxIssues: 1,
      persist: false,
    });

    expect(result).toMatchObject({
      responseMode: 'full',
      limits: { emitted: 1, total: 2, truncated: true, maxIssues: 1 },
      cursor: { offset: 0, pageSize: 1, returned: 1, total: 2, hasMore: true },
    });
    expect(result.issues).toEqual([expect.objectContaining({ findingId: 'A-1' })]);

    const nextPage = await runAuditLint('/repo', {
      findings: [
        finding({ findingId: 'A-1', status: 'OPEN', rootCauseId: 'rc-a' }),
        finding({ findingId: 'B-1', status: 'OPEN', rootCauseId: 'rc-b' }),
      ],
      maxIssues: 50,
      cursor: (result.cursor as { next?: string }).next,
      persist: false,
    });

    expect(nextPage).toMatchObject({
      cursor: { offset: 1, pageSize: 1, returned: 1, total: 2, hasMore: false },
      limits: { emitted: 1, total: 2, truncated: true, maxIssues: 1 },
    });
    expect(nextPage.issues).toEqual([expect.objectContaining({ findingId: 'B-1' })]);
  });

  it('supports summary and minimal audit lint responses', async () => {
    const summary = await runAuditLint('/repo', {
      findings: [finding({ status: 'OPEN' })],
      summary: true,
      persist: false,
    });
    expect(summary).toMatchObject({
      responseMode: 'summary',
      summary: {
        issueCount: 1,
        byRuleId: { 'open-requires-fresh-evidence': 1 },
      },
    });
    expect(summary.issues).toEqual([
      expect.objectContaining({
        ruleId: 'open-requires-fresh-evidence',
        findingId: 'AUDIT-M5-001',
      }),
    ]);

    const minimal = await runAuditLint('/repo', {
      findings: [finding({ status: 'OPEN' })],
      minimal: true,
      persist: false,
    });
    expect(minimal).toMatchObject({
      responseMode: 'minimal',
      result: {
        ok: false,
        exitRecommendation: 'nonzero',
        summary: { issueCount: 1 },
        truncated: false,
      },
    });
    expect(minimal.nextAction).toContain('Fix reported lint issues');
    expect(minimal.issues).toBeUndefined();
  });

  it('validates audit lint JSON against the committed schema fixture', async () => {
    const result = await runAuditLint('/repo', {
      findings: [finding({ status: 'OPEN' })],
      persist: false,
    });

    expectSchemaMatch(loadJsonFixture('audit-ci/audit-lint.schema.json'), {
      ...result,
      gate: {
        mode: 'advisory',
        source: 'default-advisory',
        warnings: [],
        policy: { blockOnStaleOpen: false },
      },
    });
  });

  it('validates impact JSON against the committed schema fixture', () => {
    expectSchemaMatch(loadJsonFixture('audit-ci/impact.schema.json'), {
      target: {
        id: 'Function:impact',
        name: 'impactCommand',
        type: 'Function',
        filePath: 'src/cli/tool.ts',
      },
      direction: 'upstream',
      impactedCount: 3,
      risk: 'HIGH',
      summary: {
        direct: 2,
        processes_affected: 1,
        modules_affected: 1,
      },
      affected_processes: [
        {
          name: 'audit flow',
          type: 'process',
          filePath: 'src/cli/tool.ts',
          affected_process_count: 1,
          total_hits: 2,
          earliest_broken_step: 1,
        },
      ],
      affected_modules: [{ name: 'cli', hits: 2, impact: 'direct' }],
      byDepth: { 1: [{ id: 'Function:caller', filePath: 'src/cli/index.ts', depth: 1 }] },
      rawCounts: { directCount: 2, totalImpacted: 3, riskReasons: ['process_count>=3:3'] },
    });
  });

  it('exports stale/open lifecycle violations to SARIF with evidence paths', () => {
    const issues = lintAuditReport({
      findings: [finding({ findingId: 'stale-open', status: 'OPEN' })],
    }).issues;

    const sarif = formatAuditLintSarif(
      {
        version: 1,
        action: 'audit-lint',
        issues,
        warnings: [],
      },
      {
        findings: [finding({ findingId: 'stale-open', status: 'OPEN' })],
        bundles: [],
        gate: {
          mode: 'advisory',
          source: 'default-advisory',
          warnings: [],
          policy: { blockOnStaleOpen: false },
        },
      },
    );

    const results = (sarif.runs as Array<{ results: Array<Record<string, unknown>> }>)[0].results;
    expect(results[0]).toMatchObject({
      ruleId: 'open-requires-fresh-evidence',
      properties: {
        gateMode: 'advisory',
        evidencePaths: ['src/process.cpp (spawnChild) [claim]'],
      },
    });
  });

  it('exports runtime-without-evidence and duplicate root cause violations to SARIF', () => {
    const findings = [
      finding({
        findingId: 'runtime',
        status: 'OPEN',
        verificationKind: 'runtime',
        claimDsl: {
          id: 'RUNTIME-001',
          kind: 'fork-scheduler-race',
          path: 'src/process.cpp',
          requiresRuntime: true,
        },
        verifiedEvidence: [evidence()],
      }),
      finding({
        findingId: 'dup-1',
        status: 'OPEN',
        rootCauseId: 'rc-fd-leak',
        bundleId: 'bundle-a',
        verifiedAt: '2026-05-17T10:00:00.000Z',
        verifiedHead: targetHead,
        verifiedEvidence: [evidence()],
      }),
      finding({
        findingId: 'dup-2',
        status: 'OPEN',
        rootCauseId: 'rc-fd-leak',
        bundleId: 'bundle-b',
        verifiedAt: '2026-05-17T10:00:00.000Z',
        verifiedHead: targetHead,
        verifiedEvidence: [evidence({ id: 'ev-2' })],
      }),
    ];
    const issues = lintAuditReport({ findings }).issues;
    const sarif = formatAuditLintSarif(
      {
        version: 1,
        action: 'audit-lint',
        issues,
        warnings: [],
      },
      {
        findings,
        bundles: [],
        gate: {
          mode: 'blocking',
          source: 'repo-policy',
          warnings: [],
          policy: { blockOnStaleOpen: true },
        },
      },
    );
    const resultRules = new Set(
      (sarif.runs as Array<{ results: Array<{ ruleId: string }> }>)[0].results.map(
        (result) => result.ruleId,
      ),
    );

    expect([...resultRules]).toEqual(
      expect.arrayContaining([
        'runtime-open-requires-runtime-evidence',
        'no-duplicate-root-cause-work',
      ]),
    );
  });

  it('exports scope violations to SARIF', () => {
    const sarif = formatScopeGuardSarif({
      status: 'FAIL',
      bundleId: 'bundle-1',
      issues: [
        {
          kind: 'unexpected-file',
          value: 'src/outside.ts',
          message: 'Changed file is outside bundle scope: src/outside.ts',
        },
      ],
    });

    const result = (sarif.runs as Array<{ results: Array<Record<string, unknown>> }>)[0].results[0];
    expect(result).toMatchObject({
      ruleId: 'scope-guard/unexpected-file',
      properties: { kind: 'unexpected-file' },
    });
    expect(result.locations).toEqual([
      expect.objectContaining({
        physicalLocation: expect.objectContaining({
          artifactLocation: { uri: 'src/outside.ts' },
        }),
      }),
    ]);
  });

  it('emits blocking JUnit failures with detailed evidence paths', () => {
    const report = {
      version: 1,
      action: 'audit-lint' as const,
      issues: lintAuditReport({
        findings: [finding({ findingId: 'stale-open', status: 'OPEN' })],
      }).issues,
      warnings: [],
    };

    const xml = formatAuditLintJUnit(report, {
      findings: [finding({ findingId: 'stale-open', status: 'OPEN' })],
      bundles: [],
      gate: {
        mode: 'blocking',
        source: 'repo-policy',
        warnings: [],
        policy: { blockOnStaleOpen: true },
      },
    });

    expect(xml).toContain(
      '<failure message="OPEN findings require fresh positive evidence at targetHead.">',
    );
    expect(xml).toContain('src/process.cpp (spawnChild) [claim]');
    expect(xml).toContain('gateMode: blocking');
  });
});
