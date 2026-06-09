/**
 * Unit tests for `export review-bundle` CLI command (REV-6 / REV-9).
 *
 * Covers:
 * - `sanitizeRefForPath` path-safe ref sanitisation
 * - `buildBundleProvenance` metadata assembly
 * - `formatReviewBundleMarkdown` output structure and content
 * - `buildReviewBundleDiagnostics` evidence diagnostic summary shape (ADR 0031)
 * - `buildSidecarStatusArtifact` sidecar status artifact builder (REV-9)
 * - sidecar status labels in `formatReviewBundleMarkdown` (REV-9)
 *
 * Does not require a live git repo, LadybugDB, or filesystem writes.
 */

import { describe, expect, it } from 'vitest';
import {
  sanitizeRefForPath,
  buildBundleProvenance,
  formatReviewBundleMarkdown,
  buildReviewBundleDiagnostics,
  buildReviewBundleSemanticContracts,
  buildReviewBundleRiskSummaryArtifact,
  buildSidecarStatusArtifact,
  type ExportReviewBundleOptions,
  type BundleProvenance,
  type SidecarStatusSummary,
  type ReviewBundleDiagnostics,
  type ReviewBundleDiagnosticRecord,
  type ReviewBundleSemanticContracts,
} from '../../src/cli/export.js';
import type { TargetContext } from '../../src/mcp/shared/target-context.js';
import type { CapabilityResponseFreshness } from '../../src/mcp/shared/response-envelope.js';
import type { DiffReviewResult } from '../../src/core/review/review-types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeFreshness(
  status: CapabilityResponseFreshness['status'] = 'fresh',
  overrides: Partial<CapabilityResponseFreshness> = {},
): CapabilityResponseFreshness {
  return {
    status,
    actionable: status === 'fresh',
    reason: status === 'fresh' ? 'target context aligned' : `status: ${status}`,
    targetHead: 'abc1234',
    currentHead: 'abc1234',
    indexedHead: 'abc1234',
    snapshotMode: 'committed-head',
    ...overrides,
  };
}

function makeTargetContext(overrides: Partial<TargetContext> = {}): TargetContext {
  return {
    version: 1,
    status: 'ok',
    targetRef: 'HEAD',
    targetHead: 'abc1234',
    currentHead: 'abc1234',
    indexedHead: 'abc1234',
    dirtyWorktree: false,
    changedSinceIndex: false,
    snapshotMode: 'committed-head',
    qualityMode: 'fast',
    embeddings: { status: 'unknown', reason: 'not-probed' },
    lsp: { status: 'unknown', reason: 'not-probed' },
    sidecar: { status: 'unknown', reason: 'not-probed' },
    policy: { status: 'unknown', reason: 'policy-profile-probe-not-configured' },
    warnings: [],
    ...overrides,
  };
}

function makeReviewResult(overrides: Partial<DiffReviewResult> = {}): DiffReviewResult {
  return {
    reviewedFiles: [
      {
        path: 'src/foo.ts',
        addedLines: 10,
        removedLines: 2,
        changedSymbols: [
          {
            nodeId: 'n1',
            name: 'fooFn',
            impact: { upstreamCount: 5, downstreamCount: 2, risk: 'LOW', heuristic: false },
          },
        ],
      },
    ],
    totalSymbolsChanged: 1,
    highRiskSymbols: [],
    warnings: [],
    ...overrides,
  };
}

function makeSidecarStatus(
  status: SidecarStatusSummary['status'] = 'complete',
  overrides: Partial<SidecarStatusSummary> = {},
): SidecarStatusSummary {
  return {
    status,
    staleReasons: [],
    degradedReasons: {},
    summary: { files: 5, coveredFiles: 5, missingFiles: 0 },
    warnings: [],
    ...overrides,
  };
}

function makeKnowledgeReport(overrides: Record<string, unknown> = {}) {
  return {
    sidecar: {
      status: 'complete',
      staleReasons: [],
      degradedReasons: {},
    },
    items: [
      {
        label: 'API Contracts',
        freshness: 'fresh',
        diagnosticSidecarStatus: 'complete',
        linkedGraphIdentities: [
          { type: 'function', id: 'n1', name: 'fooFn', filePath: 'src/foo.ts' },
        ],
        rationaleSnippets: [
          {
            sourceFactKey: 'api:GET:/v1/users',
            factKind: 'markdown-api-spec',
            docPath: 'docs/api.md',
            headingPath: ['API Contracts'],
            lineSpan: { start: 12, end: 12 },
            excerpt: 'GET /v1/users',
            evidenceClass: 'docs_evidence',
            authority: 'advisory',
          },
        ],
        schemaEvidence: [
          {
            sourceFactKey: 'api:GET:/v1/users',
            routeKey: 'GET /v1/users',
            method: 'GET',
            path: '/v1/users',
            docPath: 'docs/api.md',
            lineSpan: { start: 12, end: 12 },
            excerpt: 'GET /v1/users',
            evidenceClass: 'docs_evidence',
            authority: 'advisory',
          },
        ],
      },
    ],
    ...overrides,
  } as any;
}

// ---------------------------------------------------------------------------
// sanitizeRefForPath
// ---------------------------------------------------------------------------

describe('sanitizeRefForPath', () => {
  it('passes through plain refs unchanged', () => {
    expect(sanitizeRefForPath('HEAD')).toBe('HEAD');
    expect(sanitizeRefForPath('main')).toBe('main');
    expect(sanitizeRefForPath('v1.2.3')).toBe('v1.2.3');
  });

  it('strips refs/ prefix before sanitising slashes', () => {
    // refs/ prefix stripped; remaining slash treated as unsafe char
    expect(sanitizeRefForPath('refs/heads/feature-x')).toBe('heads_feature-x');
  });

  it('replaces unsafe characters with underscores', () => {
    expect(sanitizeRefForPath('feature/my branch')).toBe('feature_my_branch');
    expect(sanitizeRefForPath('HEAD~5')).toBe('HEAD_5');
    // dots are allowed (preserve semver tags like v1.2.3)
    expect(sanitizeRefForPath('main...feature')).toBe('main...feature');
  });

  it('collapses consecutive underscores and trims leading/trailing', () => {
    // multiple consecutive unsafe chars collapse to a single underscore
    const r = sanitizeRefForPath('feature//branch');
    expect(r).toBe('feature_branch');
    const padded = sanitizeRefForPath('___padded___');
    expect(padded).not.toMatch(/^_/);
    expect(padded).not.toMatch(/_$/);
  });

  it('truncates very long refs at 64 chars', () => {
    const long = 'a'.repeat(100);
    expect(sanitizeRefForPath(long).length).toBeLessThanOrEqual(64);
  });

  it('falls back to HEAD for empty or fully-stripped refs', () => {
    expect(sanitizeRefForPath('')).toBe('HEAD');
    expect(sanitizeRefForPath('///')).toBe('HEAD');
  });
});

// ---------------------------------------------------------------------------
// buildBundleProvenance
// ---------------------------------------------------------------------------

describe('buildBundleProvenance', () => {
  it('includes required ADR 0020 fields', () => {
    const ctx = makeTargetContext();
    const freshness = makeFreshness('fresh');
    const prov = buildBundleProvenance(ctx, freshness, '2024-01-01T00:00:00.000Z', []);

    expect(prov.schemaVersion).toBe(1);
    expect(prov.targetRef).toBe('HEAD');
    expect(prov.targetHead).toBe('abc1234');
    expect(prov.indexedHead).toBe('abc1234');
    expect(prov.indexedAt).toBe('2024-01-01T00:00:00.000Z');
    expect(prov.dirtyWorktree).toBe(false);
    expect(prov.freshnessStatus).toBe('fresh');
    expect(prov.snapshotMode).toBe('committed-head');
    expect(typeof prov.generatedAt).toBe('string');
  });

  it('carries null indexedAt when index is absent', () => {
    const ctx = makeTargetContext({ status: 'no-index' });
    const freshness = makeFreshness('unknown');
    const prov = buildBundleProvenance(ctx, freshness, null, []);
    expect(prov.indexedAt).toBeNull();
  });

  it('merges warnings from context and extra sources', () => {
    const ctx = makeTargetContext({ warnings: ['ctx-warn'] });
    const freshness = makeFreshness('stale');
    const prov = buildBundleProvenance(ctx, freshness, null, ['extra-warn']);
    expect(prov.warnings).toContain('ctx-warn');
    expect(prov.warnings).toContain('extra-warn');
  });

  it('deduplicates warnings', () => {
    const ctx = makeTargetContext({ warnings: ['same-warn'] });
    const freshness = makeFreshness('stale');
    const prov = buildBundleProvenance(ctx, freshness, null, ['same-warn']);
    expect(prov.warnings.filter((w) => w === 'same-warn').length).toBe(1);
  });

  it('reflects dirty worktree state', () => {
    const ctx = makeTargetContext({ dirtyWorktree: true, snapshotMode: 'dirty-worktree-overlay' });
    const freshness = makeFreshness('degraded');
    const prov = buildBundleProvenance(ctx, freshness, null, []);
    expect(prov.dirtyWorktree).toBe(true);
    expect(prov.snapshotMode).toBe('dirty-worktree-overlay');
    expect(prov.freshnessStatus).toBe('degraded');
  });
});

// ---------------------------------------------------------------------------
// formatReviewBundleMarkdown
// ---------------------------------------------------------------------------

describe('formatReviewBundleMarkdown', () => {
  function makeProv(overrides: Partial<BundleProvenance> = {}): BundleProvenance {
    return {
      schemaVersion: 1,
      generatedAt: '2024-06-01T12:00:00.000Z',
      targetRef: 'HEAD',
      targetHead: 'abc1234',
      indexedHead: 'abc1234',
      indexedAt: '2024-06-01T11:00:00.000Z',
      dirtyWorktree: false,
      freshnessStatus: 'fresh',
      freshnessReason: 'target context aligned',
      snapshotMode: 'committed-head',
      warnings: [],
      ...overrides,
    };
  }

  it('emits disposable-snapshot disclaimer', () => {
    const md = formatReviewBundleMarkdown(makeProv(), makeReviewResult(), '--cached');
    expect(md).toContain('Disposable snapshot');
    expect(md).toContain('not canonical graph state');
  });

  it('includes all required provenance fields', () => {
    const md = formatReviewBundleMarkdown(makeProv(), makeReviewResult(), '--cached');
    expect(md).toContain('Schema version');
    expect(md).toContain('Target ref');
    expect(md).toContain('Target HEAD');
    expect(md).toContain('Indexed HEAD');
    expect(md).toContain('Indexed at');
    expect(md).toContain('Dirty worktree');
    expect(md).toContain('Snapshot mode');
    expect(md).toContain('Generated at');
  });

  it('shows freshness section with status icon', () => {
    const md = formatReviewBundleMarkdown(makeProv(), makeReviewResult(), '--cached');
    expect(md).toContain('## Freshness');
    expect(md).toContain('✅');
    expect(md).toContain('FRESH');
    expect(md).toContain('target context aligned');
  });

  it('shows ⚠️ for stale freshness', () => {
    const prov = makeProv({
      freshnessStatus: 'stale',
      freshnessReason: 'indexedHead != targetHead',
    });
    const md = formatReviewBundleMarkdown(prov, makeReviewResult(), 'main..HEAD');
    expect(md).toContain('⚠️');
    expect(md).toContain('STALE');
  });

  it('includes diff summary when review result is present', () => {
    const md = formatReviewBundleMarkdown(makeProv(), makeReviewResult(), '--cached');
    expect(md).toContain('## Diff Summary');
    expect(md).toContain('Files changed:');
    expect(md).toContain('Symbols changed:');
    expect(md).toContain('`--cached`');
  });

  it('shows changed symbols table', () => {
    const md = formatReviewBundleMarkdown(makeProv(), makeReviewResult(), '--cached');
    expect(md).toContain('## Changed Symbols');
    expect(md).toContain('fooFn');
    expect(md).toContain('LOW');
  });

  it('shows no-index message when reviewResult is null', () => {
    const md = formatReviewBundleMarkdown(makeProv(), null, '--cached');
    expect(md).toContain('No OntoIndex index found');
    expect(md).toContain('ontoindex analyze');
    expect(md).not.toContain('## Diff Summary');
  });

  it('shows warnings section when warnings are present', () => {
    const prov = makeProv({ warnings: ['index is stale', 'graph review failed'] });
    const md = formatReviewBundleMarkdown(prov, makeReviewResult(), '--cached');
    expect(md).toContain('## Warnings');
    expect(md).toContain('index is stale');
    expect(md).toContain('graph review failed');
  });

  it('shows high-risk symbols when present', () => {
    const result = makeReviewResult({ highRiskSymbols: ['criticalFn', 'anotherFn'] });
    const md = formatReviewBundleMarkdown(makeProv(), result, '--cached');
    expect(md).toContain('High-risk symbols');
    expect(md).toContain('criticalFn');
    expect(md).toContain('anotherFn');
  });

  it('shows affected processes when present', () => {
    const result = makeReviewResult({
      affectedProcesses: [
        { id: 'p1', name: 'auth-flow', processType: 'http', changedStepCount: 3 },
      ],
    });
    const md = formatReviewBundleMarkdown(makeProv(), result, '--cached');
    expect(md).toContain('## Affected Execution Flows');
    expect(md).toContain('auth-flow');
  });

  it('shows affected communities when present', () => {
    const result = makeReviewResult({
      affectedCommunities: [{ id: 'c1', name: 'auth-cluster', changedSymbolCount: 5 }],
    });
    const md = formatReviewBundleMarkdown(makeProv(), result, '--cached');
    expect(md).toContain('## Affected Communities');
    expect(md).toContain('auth-cluster');
  });

  it('shows cross-community risk hints when present', () => {
    const result = makeReviewResult({
      crossCommunityRiskReasons: ['change crosses auth↔storage boundary'],
    });
    const md = formatReviewBundleMarkdown(makeProv(), result, '--cached');
    expect(md).toContain('## Cross-Community Risk Hints');
    expect(md).toContain('auth↔storage boundary');
  });

  it('includes compact evidence diagnostics sections', () => {
    const result = makeReviewResult({
      highRiskSymbols: ['criticalFn'],
      crossCommunityRiskReasons: ['change crosses auth↔storage boundary'],
    });
    const md = formatReviewBundleMarkdown(
      makeProv(),
      result,
      '--cached',
      makeSidecarStatus('complete'),
    );

    expect(md).toContain('## Evidence Diagnostics');
    expect(md).toContain('### Authoritative Code/Graph Evidence');
    expect(md).toContain('### Advisory Docs Evidence');
    expect(md).toContain('### Ambiguous Relationships');
    expect(md).toContain('### Degraded or Truncated Evidence');
    expect(md).toContain('### Ranked Discovery Notes');
    expect(md).toContain('[authoritative/code] changed files');
    expect(md).toContain('[advisory/docs-sidecar] docs sidecar complete');
    expect(md).toContain('[advisory/review] high-risk symbols');
  });

  it('includes concise semantic contract section', () => {
    const md = formatReviewBundleMarkdown(
      makeProv(),
      makeReviewResult(),
      '--cached',
      makeSidecarStatus('complete'),
    );

    expect(md).toContain('## Semantic Contracts');
    expect(md).toContain('Semantic contracts passed (0 violations).');
  });

  it('shows degraded advisory diagnostics for stale sidecar state', () => {
    const sidecar = makeSidecarStatus('stale', {
      staleReasons: ['commit-mismatch'],
      warnings: ['doc hash mismatch for 3 record(s)'],
    });
    const md = formatReviewBundleMarkdown(makeProv(), makeReviewResult(), '--cached', sidecar);

    expect(md).toContain('[advisory/docs-sidecar] docs sidecar stale');
    expect(md).toContain('[advisory/docs-sidecar] docs sidecar stale reason');
    expect(md).toContain('commit-mismatch');
    expect(md).toContain('doc hash mismatch for 3 record(s)');
  });

  it('ends with snapshot disclaimer footer', () => {
    const md = formatReviewBundleMarkdown(makeProv(), null, '--cached');
    expect(md).toContain('point-in-time diagnostic artifact');
    expect(md).toContain('must not be treated as canonical graph state');
  });

  // REV-9: sidecar status in markdown
  it('omits sidecar section when sidecarStatus is not provided', () => {
    const md = formatReviewBundleMarkdown(makeProv(), null, '--cached');
    expect(md).not.toContain('## Docs Sidecar');
  });

  it('shows sidecar section with complete label', () => {
    const md = formatReviewBundleMarkdown(
      makeProv(),
      null,
      '--cached',
      makeSidecarStatus('complete'),
    );
    expect(md).toContain('## Docs Sidecar');
    expect(md).toContain('✅');
    expect(md).toContain('COMPLETE');
  });

  it('shows sidecar section with missing label', () => {
    const md = formatReviewBundleMarkdown(
      makeProv(),
      null,
      '--cached',
      makeSidecarStatus('missing'),
    );
    expect(md).toContain('## Docs Sidecar');
    expect(md).toContain('⬜');
    expect(md).toContain('MISSING');
  });

  it('shows sidecar section with stale label and stale reasons', () => {
    const sc = makeSidecarStatus('stale', { staleReasons: ['commit-mismatch'] });
    const md = formatReviewBundleMarkdown(makeProv(), null, '--cached', sc);
    expect(md).toContain('## Docs Sidecar');
    expect(md).toContain('⚠️');
    expect(md).toContain('STALE');
    expect(md).toContain('commit-mismatch');
  });

  it('shows sidecar section with partial label and degraded reasons', () => {
    const sc = makeSidecarStatus('partial', {
      degradedReasons: { partial: 2, failed: 0 },
    });
    const md = formatReviewBundleMarkdown(makeProv(), null, '--cached', sc);
    expect(md).toContain('🔶');
    expect(md).toContain('PARTIAL');
    expect(md).toContain('partial: 2');
    // zero-count entries should be omitted
    expect(md).not.toContain('failed: 0');
  });

  it('shows sidecar section with failed label', () => {
    const md = formatReviewBundleMarkdown(
      makeProv(),
      null,
      '--cached',
      makeSidecarStatus('failed'),
    );
    expect(md).toContain('❌');
    expect(md).toContain('FAILED');
  });

  it('shows sidecar warnings when present', () => {
    const sc = makeSidecarStatus('stale', { warnings: ['doc hash mismatch for 3 record(s)'] });
    const md = formatReviewBundleMarkdown(makeProv(), null, '--cached', sc);
    expect(md).toContain('doc hash mismatch for 3 record(s)');
  });
});

// ---------------------------------------------------------------------------
// buildReviewBundleDiagnostics (ADR 0031)

describe('buildReviewBundleDiagnostics', () => {
  function makeProv(overrides: Partial<BundleProvenance> = {}): BundleProvenance {
    return {
      schemaVersion: 1,
      generatedAt: '2024-06-01T12:00:00.000Z',
      targetRef: 'HEAD',
      targetHead: 'abc1234',
      indexedHead: 'abc1234',
      indexedAt: '2024-06-01T11:00:00.000Z',
      dirtyWorktree: false,
      freshnessStatus: 'fresh',
      freshnessReason: 'target context aligned',
      snapshotMode: 'committed-head',
      warnings: [],
      ...overrides,
    };
  }

  it('builds the required risk-summary diagnostics shape', () => {
    const diagnostics = buildReviewBundleDiagnostics(
      makeProv(),
      makeReviewResult(),
      makeSidecarStatus(),
    );

    expect(diagnostics.schemaVersion).toBe(1);
    expect(diagnostics.summary).toMatchObject({
      total: expect.any(Number),
      authoritative: expect.any(Number),
      advisory: expect.any(Number),
      ambiguous: expect.any(Number),
      degraded: expect.any(Number),
      truncated: expect.any(Number),
    });
    expect(diagnostics.records.length).toBe(diagnostics.summary.total);
    expect(diagnostics.records[0]).toMatchObject({
      category: expect.any(String),
      kind: expect.any(String),
      authority: expect.stringMatching(/^(authoritative|advisory)$/),
      advisory: expect.any(Boolean),
      subject: expect.any(String),
      reason: expect.any(String),
    });
  });

  it('keeps quality states out of diagnostic category values', () => {
    const diagnostics = buildReviewBundleDiagnostics(
      makeProv({ freshnessStatus: 'stale', freshnessReason: 'indexedHead != targetHead' }),
      makeReviewResult({
        reviewedFiles: [
          {
            path: 'src/foo.ts',
            addedLines: 10,
            removedLines: 2,
            changedSymbols: [
              {
                nodeId: 'n1',
                name: 'fooFn',
                impact: { upstreamCount: 5, downstreamCount: 2, risk: 'LOW', heuristic: true },
              },
            ],
          },
        ],
        warnings: ['Changed file scan capped at 500 paths'],
      }),
      makeSidecarStatus('stale', { staleReasons: ['commit-mismatch'] }),
    );

    const categories = new Set(diagnostics.records.map((record) => record.category));
    expect(categories).not.toContain('ambiguous');
    expect(categories).not.toContain('degraded');
    expect(categories).not.toContain('truncated');
    expect(diagnostics.records.some((record) => record.kind === 'ambiguous')).toBe(true);
    expect(diagnostics.records.some((record) => record.kind === 'degraded')).toBe(true);
    expect(diagnostics.records.some((record) => record.kind === 'truncated')).toBe(true);
    expect(diagnostics.records.some((record) => record.kind === 'stale')).toBe(true);
  });

  it('keeps docs sidecar diagnostics advisory', () => {
    const diagnostics = buildReviewBundleDiagnostics(
      makeProv(),
      makeReviewResult(),
      makeSidecarStatus('complete'),
    );

    const docs = diagnostics.records.find((record) => record.source === 'docs-sidecar');
    expect(docs).toMatchObject({
      authority: 'advisory',
      advisory: true,
      degraded: false,
    });
  });

  it('turns missing stale partial and failed sidecars into degraded advisory records', () => {
    for (const status of ['missing', 'stale', 'partial', 'failed'] as const) {
      const diagnostics = buildReviewBundleDiagnostics(
        makeProv(),
        makeReviewResult(),
        makeSidecarStatus(status, { staleReasons: status === 'stale' ? ['commit-mismatch'] : [] }),
      );
      const normalized = status === 'failed' ? 'partial' : status;
      const docs = diagnostics.records.find(
        (record) => record.subject === `docs sidecar ${normalized}`,
      );

      expect(docs).toMatchObject({
        authority: 'advisory',
        advisory: true,
        degraded: true,
      });
      expect(diagnostics.summary.degraded).toBeGreaterThan(0);
    }
  });

  it('marks heuristic impacts and cross-community hints as ambiguous advisory evidence', () => {
    const diagnostics = buildReviewBundleDiagnostics(
      makeProv(),
      makeReviewResult({
        reviewedFiles: [
          {
            path: 'src/foo.ts',
            addedLines: 10,
            removedLines: 2,
            changedSymbols: [
              {
                nodeId: 'n1',
                name: 'fooFn',
                impact: { upstreamCount: 5, downstreamCount: 2, risk: 'LOW', heuristic: true },
              },
            ],
          },
        ],
        crossCommunityRiskReasons: ['change crosses auth↔storage boundary'],
      }),
      makeSidecarStatus(),
    );

    expect(diagnostics.summary.ambiguous).toBeGreaterThanOrEqual(2);
    expect(
      diagnostics.records.filter((record) => record.ambiguous).every((record) => record.advisory),
    ).toBe(true);
  });

  it('bounds diagnostics records and emits a truncated marker', () => {
    const diagnostics = buildReviewBundleDiagnostics(
      makeProv({
        warnings: Array.from({ length: 60 }, (_, i) => `warning ${i}`),
      }),
      makeReviewResult(),
      makeSidecarStatus(),
    );

    expect(diagnostics.records.length).toBeLessThanOrEqual(50);
    expect(diagnostics.summary.total).toBe(diagnostics.records.length);
    expect(diagnostics.summary.truncated).toBe(1);
    expect(diagnostics.records.at(-1)).toMatchObject({
      subject: 'diagnostics records',
      truncated: true,
      advisory: true,
    });
  });

  it('builds the existing risk-summary artifact with embedded diagnostics', () => {
    const prov = makeProv();
    const reviewResult = makeReviewResult();
    const diagnostics = buildReviewBundleDiagnostics(
      prov,
      reviewResult,
      makeSidecarStatus('missing'),
    );
    const riskSummaryArtifact = buildReviewBundleRiskSummaryArtifact(
      prov,
      diagnostics,
      reviewResult,
      '--cached',
    ) as {
      _note: string;
      diagnostics: ReviewBundleDiagnostics;
      semanticContracts: ReviewBundleSemanticContracts;
      diffRange: string;
    };

    expect(riskSummaryArtifact.diagnostics.schemaVersion).toBe(1);
    expect(riskSummaryArtifact.diagnostics.records).toEqual(diagnostics.records);
    expect(riskSummaryArtifact.semanticContracts).toMatchObject({
      schemaVersion: 1,
      passed: true,
      text: 'Semantic contracts passed (0 violations).',
      bounded: {
        maxViolations: expect.any(Number),
        omittedViolations: 0,
        evidenceOmitted: false,
        omittedEvidenceCount: 0,
      },
    });
    expect(riskSummaryArtifact.diffRange).toBe('--cached');
    expect(riskSummaryArtifact).not.toHaveProperty('evidenceDiagnosticsPath');
  });

  it('adds advisory docs rationale and schema evidence diagnostics from knowledge reports', () => {
    const diagnostics = buildReviewBundleDiagnostics(
      makeProv(),
      makeReviewResult(),
      makeSidecarStatus('complete'),
      makeKnowledgeReport(),
    );

    expect(diagnostics.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: 'docs',
          kind: 'extracted',
          source: 'docs-sidecar',
          authority: 'advisory',
          subject: 'docs rationale: API Contracts',
          reason: expect.stringContaining('docs/api.md:12-12 GET /v1/users'),
          advisory: true,
          degraded: false,
        }),
        expect.objectContaining({
          category: 'docs',
          kind: 'extracted',
          source: 'docs-sidecar',
          authority: 'advisory',
          subject: 'docs schema: GET /v1/users',
          reason: expect.stringContaining('docs/api.md:12-12 GET /v1/users'),
          advisory: true,
          degraded: false,
        }),
      ]),
    );
  });

  it('skips docs knowledge diagnostics not linked to changed code evidence', () => {
    const diagnostics = buildReviewBundleDiagnostics(
      makeProv(),
      makeReviewResult(),
      makeSidecarStatus('complete'),
      makeKnowledgeReport({
        items: [
          {
            ...makeKnowledgeReport().items[0],
            linkedGraphIdentities: [{ type: 'route', id: 'GET /v1/users', routePath: '/v1/users' }],
          },
        ],
      }),
    );

    expect(diagnostics.records).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ subject: 'docs schema: GET /v1/users' })]),
    );
    expect(diagnostics.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: 'docs',
          kind: 'degraded',
          subject: 'docs knowledge relevance',
          reason: expect.stringContaining('not linked to changed code evidence'),
          advisory: true,
          degraded: true,
        }),
      ]),
    );
  });

  it('emits explicit docs truncation diagnostics for bounded knowledge evidence', () => {
    const baseItem = makeKnowledgeReport().items[0];
    const diagnostics = buildReviewBundleDiagnostics(
      makeProv(),
      makeReviewResult(),
      makeSidecarStatus('complete'),
      makeKnowledgeReport({
        items: Array.from({ length: 11 }, (_, index) => ({
          ...baseItem,
          label: `API Contracts ${index}`,
          linkedGraphIdentities: [
            { type: 'function', id: 'n1', name: 'fooFn', filePath: 'src/foo.ts' },
          ],
          rationaleSnippets:
            index === 0
              ? Array.from({ length: 3 }, (__, snippetIndex) => ({
                  ...baseItem.rationaleSnippets[0],
                  sourceFactKey: `api:${index}:rationale:${snippetIndex}`,
                  excerpt: `GET /v1/users rationale ${snippetIndex}`,
                }))
              : [],
          schemaEvidence:
            index === 0
              ? Array.from({ length: 3 }, (__, schemaIndex) => ({
                  ...baseItem.schemaEvidence[0],
                  sourceFactKey: `api:${index}:schema:${schemaIndex}`,
                  routeKey: `GET /v1/users/${schemaIndex}`,
                  excerpt: `GET /v1/users schema ${schemaIndex}`,
                }))
              : [],
        })),
      }),
    );

    expect(diagnostics.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: 'docs',
          kind: 'truncated',
          subject: 'docs rationale: API Contracts 0',
          truncated: true,
        }),
        expect.objectContaining({
          category: 'docs',
          kind: 'truncated',
          subject: 'docs schema: API Contracts 0',
          truncated: true,
        }),
        expect.objectContaining({
          category: 'docs',
          kind: 'truncated',
          subject: 'docs knowledge items',
          truncated: true,
        }),
      ]),
    );
  });
});

// buildReviewBundleSemanticContracts (ADR 0033)

describe('buildReviewBundleSemanticContracts', () => {
  function makeProv(overrides: Partial<BundleProvenance> = {}): BundleProvenance {
    return {
      schemaVersion: 1,
      generatedAt: '2024-06-01T12:00:00.000Z',
      targetRef: 'HEAD',
      targetHead: 'abc1234',
      indexedHead: 'abc1234',
      indexedAt: '2024-06-01T11:00:00.000Z',
      dirtyWorktree: false,
      freshnessStatus: 'fresh',
      freshnessReason: 'target context aligned',
      snapshotMode: 'committed-head',
      warnings: [],
      ...overrides,
    };
  }

  function appendDiagnostic(
    diagnostics: ReviewBundleDiagnostics,
    record: ReviewBundleDiagnosticRecord,
  ): ReviewBundleDiagnostics {
    return {
      ...diagnostics,
      records: [...diagnostics.records, record],
    };
  }

  it('reports authority consistency violations', () => {
    const prov = makeProv();
    const diagnostics = appendDiagnostic(
      buildReviewBundleDiagnostics(prov, makeReviewResult(), makeSidecarStatus('complete')),
      {
        category: 'review',
        kind: 'extracted',
        source: 'review',
        authority: 'authoritative',
        subject: 'review authority',
        reason: 'test diagnostic intentionally pairs authoritative with advisory true',
        advisory: true,
      },
    );

    const semanticContracts = buildReviewBundleSemanticContracts(
      prov,
      diagnostics,
      makeReviewResult(),
    );

    expect(semanticContracts.passed).toBe(false);
    expect(semanticContracts.text).toContain('authority-consistency: 1');
    expect(semanticContracts.violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          contract: 'authority-consistency',
          subject: 'review authority',
          reason: 'authoritative diagnostics cannot also be advisory',
        }),
      ]),
    );
  });

  it('renders stale graph authority violations in markdown', () => {
    const prov = makeProv({
      freshnessStatus: 'stale',
      freshnessReason: 'indexedHead != targetHead',
    });
    const diagnostics = appendDiagnostic(
      buildReviewBundleDiagnostics(prov, makeReviewResult(), makeSidecarStatus('complete')),
      {
        category: 'code-graph',
        kind: 'extracted',
        source: 'graph',
        authority: 'authoritative',
        subject: 'changed symbols',
        reason: 'test diagnostic intentionally keeps stale graph evidence authoritative',
        freshness: 'stale',
        advisory: false,
        degraded: false,
      },
    );

    const md = formatReviewBundleMarkdown(
      prov,
      makeReviewResult(),
      '--cached',
      makeSidecarStatus('complete'),
      diagnostics,
    );

    expect(md).toContain('## Semantic Contracts');
    expect(md).toContain('[freshness-consistency] changed symbols');
    expect(md).toContain('stale or degraded graph freshness must downgrade graph-derived claims');
  });
});

// buildSidecarStatusArtifact (REV-9)
// ---------------------------------------------------------------------------

describe('buildSidecarStatusArtifact', () => {
  function makeProv(overrides: Partial<BundleProvenance> = {}): BundleProvenance {
    return {
      schemaVersion: 1,
      generatedAt: '2024-06-01T12:00:00.000Z',
      targetRef: 'HEAD',
      targetHead: 'abc1234',
      indexedHead: 'abc1234',
      indexedAt: '2024-06-01T11:00:00.000Z',
      dirtyWorktree: false,
      freshnessStatus: 'fresh',
      freshnessReason: 'target context aligned',
      snapshotMode: 'committed-head',
      warnings: [],
      ...overrides,
    };
  }

  it('includes snapshot _note marker', () => {
    const artifact = buildSidecarStatusArtifact(makeProv(), makeSidecarStatus());
    expect(artifact._note).toContain('Snapshot artifact');
    expect(artifact._note).toContain('not canonical graph state');
  });

  it('includes provenance', () => {
    const prov = makeProv();
    const artifact = buildSidecarStatusArtifact(prov, makeSidecarStatus());
    expect(artifact.provenance).toBe(prov);
  });

  it('includes sidecar status fields', () => {
    const sc = makeSidecarStatus('stale', {
      staleReasons: ['commit-mismatch'],
      degradedReasons: { 'source-index-mismatch': 1 },
    });
    const artifact = buildSidecarStatusArtifact(makeProv(), sc);
    const sidecar = artifact.sidecar as SidecarStatusSummary;
    expect(sidecar.status).toBe('stale');
    expect(sidecar.staleReasons).toContain('commit-mismatch');
    expect(sidecar.degradedReasons['source-index-mismatch']).toBe(1);
  });

  it('works for missing sidecar state', () => {
    const sc = makeSidecarStatus('missing', { staleReasons: [], degradedReasons: {} });
    const artifact = buildSidecarStatusArtifact(makeProv(), sc);
    const sidecar = artifact.sidecar as SidecarStatusSummary;
    expect(sidecar.status).toBe('missing');
  });

  it('works for complete sidecar state', () => {
    const sc = makeSidecarStatus('complete');
    const artifact = buildSidecarStatusArtifact(makeProv(), sc);
    const sidecar = artifact.sidecar as SidecarStatusSummary;
    expect(sidecar.status).toBe('complete');
  });
});

// ---------------------------------------------------------------------------
// ExportReviewBundleOptions type shape (compile-time test)
// ---------------------------------------------------------------------------

describe('ExportReviewBundleOptions', () => {
  it('accepts all documented options', () => {
    const opts: ExportReviewBundleOptions = {
      target: 'HEAD',
      out: '.ontoindex/review/HEAD',
      repo: 'myrepo',
      base: 'main',
      head: 'HEAD',
      range: 'main...feature',
      staged: true,
    };
    expect(opts.target).toBe('HEAD');
    expect(opts.staged).toBe(true);
  });

  it('allows all fields to be omitted', () => {
    const opts: ExportReviewBundleOptions = {};
    expect(opts.target).toBeUndefined();
  });
});
