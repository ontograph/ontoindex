import { describe, expect, it } from 'vitest';
import type { DocsReportEnvelope } from '../../src/core/ingestion/enrichment/docs-contracts.js';
import type {
  MarkdownAcceptanceCriterionFact,
  MarkdownCodeMentionFact,
  MarkdownRequirementFact,
  MarkdownTestMentionFact,
} from '../../src/core/ingestion/enrichment/markdown-document-facts.js';
import type { MarkdownDocResolutionRecord } from '../../src/core/ingestion/enrichment/markdown-doc-resolver.js';
import { createMarkdownRequirementTraceReport } from '../../src/core/ingestion/enrichment/markdown-requirement-trace.js';

describe('createMarkdownRequirementTraceReport', () => {
  it('reports implemented and tested requirements with all evidence classes', () => {
    const facts = [
      requirement('REQ-1'),
      criterion('REQ-1', 1),
      codeMention('REQ-1', 12),
      testMention('REQ-1', 14),
    ];
    const report = createMarkdownRequirementTraceReport({
      baseReport: baseReport(),
      facts,
      resolutions: [
        resolution('REQ-1', 'requirement', 'resolved', {
          evidenceKind: 'lexical-requirement-id',
          confidence: 0.91,
        }),
        resolution(codeMentionKey('REQ-1', 12), 'code-mention', 'resolved', {
          evidenceKind: 'graph-structural',
          confidence: 0.88,
        }),
        resolution(`test:REQ-1`, 'test-mention', 'resolved', {
          evidenceKind: 'graph-structural',
          confidence: 0.82,
          targetType: 'test-file',
        }),
      ],
    });

    expect(report.items).toHaveLength(1);
    expect(report.items[0]).toMatchObject({
      requirementId: 'REQ-1',
      status: 'implemented',
      confidence: 0.91,
      evidenceClasses: ['declared', 'linked', 'resolved', 'structural', 'tested'],
    });
    expect(report.items[0].implementationEvidence).toHaveLength(2);
    expect(report.items[0].tests[0]).toMatchObject({ mention: 'REQ-1 test', status: 'resolved' });
    expect(report.summary.requirements).toMatchObject({
      byStatus: { implemented: 1 },
      byEvidenceClass: { declared: 1, linked: 1, resolved: 1, structural: 1, tested: 1 },
    });
  });

  it('keeps lexical-only evidence implemented without structural or tested classes', () => {
    const report = createMarkdownRequirementTraceReport({
      baseReport: baseReport(),
      facts: [requirement('REQ-LEX')],
      resolutions: [
        resolution('REQ-LEX', 'requirement', 'resolved', {
          evidenceKind: 'lexical-requirement-id',
        }),
      ],
    });

    expect(report.items[0]).toMatchObject({
      status: 'implemented',
      evidenceClasses: ['declared', 'linked', 'resolved'],
      suggestedActions: ['link or add a resolved test mention'],
    });
  });

  it('reports declared requirements with no implementation evidence as missing', () => {
    const report = createMarkdownRequirementTraceReport({
      baseReport: baseReport(),
      facts: [requirement('REQ-MISSING')],
      resolutions: [],
    });

    expect(report.items[0]).toMatchObject({
      status: 'missing',
      reason: 'no implementation evidence found',
      evidenceClasses: ['declared'],
      suggestedActions: ['add code evidence or implement the requirement'],
    });
  });

  it('preserves ambiguous resolution state', () => {
    const report = createMarkdownRequirementTraceReport({
      baseReport: baseReport(),
      facts: [requirement('REQ-AMB')],
      resolutions: [
        resolution('REQ-AMB', 'requirement', 'ambiguous', {
          candidates: [candidate('symbol:a', 'a.ts'), candidate('symbol:b', 'b.ts')],
        }),
      ],
    });

    expect(report.items[0]).toMatchObject({
      status: 'ambiguous',
      reason: 'multiple graph candidates remain unresolved',
      suggestedActions: ['add explicit code symbol or file anchors for this requirement'],
    });
    expect(report.items[0].implementationEvidence[0].candidates).toHaveLength(2);
  });

  it('surfaces stale sidecar and stale resolution state', () => {
    const report = createMarkdownRequirementTraceReport({
      baseReport: baseReport('stale', ['commit mismatch']),
      facts: [requirement('REQ-STALE')],
      resolutions: [resolution('REQ-STALE', 'requirement', 'stale')],
    });

    expect(report.sidecar.status).toBe('stale');
    expect(report.items[0]).toMatchObject({
      status: 'stale',
      reason: 'commit mismatch',
      suggestedActions: ['refresh markdown sidecar and resolution records'],
    });
  });

  it('marks otherwise resolved requirements partial when sidecar coverage is partial', () => {
    const report = createMarkdownRequirementTraceReport({
      baseReport: baseReport('partial'),
      facts: [requirement('REQ-PARTIAL')],
      resolutions: [resolution('REQ-PARTIAL', 'requirement', 'resolved')],
    });

    expect(report.items[0]).toMatchObject({
      status: 'partial',
      reason: 'sidecar coverage is partial',
    });
  });

  it('applies id filtering and cardinality truncation metadata', () => {
    const truncated = createMarkdownRequirementTraceReport({
      baseReport: baseReport(),
      facts: [requirement('REQ-1'), requirement('REQ-2'), requirement('REQ-3')],
      resolutions: [],
      maxItems: 2,
    });
    expect(truncated.items.map((item) => item.requirementId)).toEqual(['REQ-1', 'REQ-2']);
    expect(truncated.limits.truncated).toBe(true);
    expect(truncated.warnings).toContain('requirement trace truncated to 2 item(s)');

    const filtered = createMarkdownRequirementTraceReport({
      baseReport: baseReport(),
      facts: [requirement('REQ-1'), requirement('REQ-2'), requirement('REQ-3')],
      resolutions: [],
      requirementId: 'REQ-3',
      maxItems: 2,
    });
    expect(filtered.items.map((item) => item.requirementId)).toEqual(['REQ-3']);
    expect(filtered.limits.truncated).toBe(false);
  });
});

function baseReport(
  status: DocsReportEnvelope['sidecar']['status'] = 'complete',
  staleReasons: string[] = [],
): DocsReportEnvelope {
  return {
    version: 1,
    repo: {
      id: '/repo',
      path: '/repo',
      sourceIndexId: 'index-1',
      sourceCommitHash: 'abc123',
      graphSchemaVersion: 1,
    },
    sidecar: {
      status,
      staleReasons,
      degradedReasons: status === 'partial' ? { partial: 1 } : {},
    },
    summary: { complete: 1 },
    items: [],
    warnings: [],
    limits: {
      truncated: false,
      maxItems: 100,
      maxCandidatesPerFact: 5,
    },
  };
}

function requirement(requirementId: string, line = 10): MarkdownRequirementFact {
  return {
    kind: 'markdown-requirement',
    schemaVersion: 1,
    docPath: 'docs/requirements.md',
    headingPath: [requirementId],
    lineSpan: { start: line, end: line },
    sourceChunkKey: `chunk:${requirementId}`,
    normalizedKey: requirementId,
    confidence: 1,
    evidence: {
      text: `${requirementId} requirement`,
      raw: `${requirementId} requirement`,
      lineSpan: { start: line, end: line },
    },
    requirementId,
    title: `${requirementId} title`,
    source: 'heading',
  };
}

function criterion(requirementId: string, ordinal: number): MarkdownAcceptanceCriterionFact {
  return {
    kind: 'markdown-acceptance-criterion',
    schemaVersion: 1,
    docPath: 'docs/requirements.md',
    headingPath: [requirementId, 'Acceptance'],
    lineSpan: { start: 11 + ordinal, end: 11 + ordinal },
    sourceChunkKey: `chunk:${requirementId}`,
    normalizedKey: `criterion:${requirementId}:${ordinal}`,
    confidence: 1,
    evidence: {
      text: `Criterion ${ordinal}`,
      raw: `Criterion ${ordinal}`,
      lineSpan: { start: 11 + ordinal, end: 11 + ordinal },
    },
    criterion: `Criterion ${ordinal}`,
    ordinal,
    requirementId,
  };
}

function codeMention(requirementId: string, line: number): MarkdownCodeMentionFact {
  return {
    kind: 'markdown-code-mention',
    chunkKey: `chunk:${requirementId}`,
    target: { type: 'symbol' },
    confidence: 0.8,
    resolutionStatus: 'resolved',
    evidence: {
      text: `${requirementId}Handler`,
      lineSpan: { start: line, end: line },
    },
  };
}

function testMention(requirementId: string, line: number): MarkdownTestMentionFact {
  return {
    kind: 'markdown-test-mention',
    schemaVersion: 1,
    docPath: 'docs/requirements.md',
    headingPath: [requirementId, 'Tests'],
    lineSpan: { start: line, end: line },
    sourceChunkKey: `chunk:${requirementId}`,
    normalizedKey: `test:${requirementId}`,
    confidence: 0.7,
    evidence: {
      text: `${requirementId} test`,
      raw: `${requirementId} test`,
      lineSpan: { start: line, end: line },
    },
    mention: `${requirementId} test`,
    targetPath: `test/${requirementId}.test.ts`,
    resolvable: true,
  };
}

function resolution(
  factKey: string,
  subjectKind: MarkdownDocResolutionRecord['subjectKind'],
  status: MarkdownDocResolutionRecord['status'],
  overrides: Partial<MarkdownDocResolutionRecord> & { targetType?: 'symbol' | 'test-file' } = {},
): MarkdownDocResolutionRecord {
  const target =
    overrides.targetGraphIdentity ??
    candidate(`${overrides.targetType ?? 'symbol'}:${factKey}`, `${factKey}.ts`);
  const candidates = overrides.candidates ?? (status === 'unresolved' ? [] : [target]);
  return {
    kind: 'markdown-doc-resolution',
    schemaVersion: 1,
    resolverId: 'ontoindex.markdown-doc-resolver',
    resolverVersion: '1.0.0',
    sourceIndexId: 'index-1',
    sourceCommitHash: 'abc123',
    graphSchemaVersion: 1,
    docPath: 'docs/requirements.md',
    factKey,
    factKind: subjectKind === 'code-mention' ? 'markdown-code-mention' : 'markdown-requirement',
    subjectKind,
    resolutionKey: `resolution:${factKey}:${status}`,
    status,
    confidence: overrides.confidence ?? 0.8,
    evidenceKind: overrides.evidenceKind ?? 'lexical-requirement-id',
    reasons: overrides.reasons ?? [status === 'resolved' ? 'single-candidate' : status],
    targetGraphIdentity: status === 'resolved' || status === 'stale' ? target : undefined,
    candidates,
    lineSpan: overrides.lineSpan ?? { start: 10, end: 10 },
  };
}

function candidate(id: string, filePath: string) {
  return {
    type: id.startsWith('test-file') ? ('test-file' as const) : ('symbol' as const),
    id,
    name: id,
    filePath,
    confidence: 0.8,
    sourceIndexId: 'index-1',
    graphSchemaVersion: 1,
  };
}

function codeMentionKey(requirementId: string, line: number): string {
  return [
    'markdown-code-mention',
    `chunk:${requirementId}`,
    line,
    line,
    `${requirementId}Handler`,
  ].join(':');
}
