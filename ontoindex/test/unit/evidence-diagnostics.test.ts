import { describe, expect, it } from 'vitest';
import {
  assertEvidenceDiagnosticKind,
  isEvidenceDiagnosticTruncationReason,
  normalizeEvidenceDiagnosticRecords,
  numericEvidenceDiagnosticSummaryValue,
  renderEvidenceDiagnosticGroup,
  renderEvidenceDiagnosticSummaryLine,
  summarizeReasonParts,
  summarizeEvidenceDiagnostics,
  type EvidenceDiagnosticRecord,
} from '../../src/core/runtime/evidence-diagnostics.js';

function record(overrides: Partial<EvidenceDiagnosticRecord> = {}): EvidenceDiagnosticRecord {
  return {
    category: 'code-graph',
    kind: 'extracted',
    source: 'graph',
    authority: 'authoritative',
    subject: 'changed symbols',
    reason: 'resolved from graph index',
    advisory: false,
    ...overrides,
  };
}

describe('evidence diagnostics helpers', () => {
  it('deduplicates records by passive diagnostic identity', () => {
    const records = normalizeEvidenceDiagnosticRecords([
      record(),
      record({ count: 2 }),
      record({ subject: 'affected flows' }),
    ]);

    expect(records).toHaveLength(2);
    expect(records.map((r) => r.subject)).toEqual(['changed symbols', 'affected flows']);
  });

  it('rejects quality states as diagnostic category values', () => {
    for (const category of [
      'ambiguous',
      'degraded',
      'extracted',
      'inferred',
      'stale',
      'truncated',
    ]) {
      expect(() => summarizeEvidenceDiagnostics([record({ category })])).toThrow(
        'is a quality state; use kind instead',
      );
    }
  });

  it('rejects domain labels as diagnostic kind values', () => {
    expect(() => assertEvidenceDiagnosticKind('ranked-discovery')).toThrow(
      'is not a supported quality state',
    );
    expect(() =>
      summarizeEvidenceDiagnostics([record({ kind: 'cross-community-risk' as any })]),
    ).toThrow('is not a supported quality state');
  });

  it('counts authority and quality flags without changing advisory semantics', () => {
    const diagnostics = summarizeEvidenceDiagnostics([
      record(),
      record({
        category: 'docs',
        kind: 'degraded',
        source: 'docs-sidecar',
        authority: 'advisory',
        subject: 'docs sidecar missing',
        reason: 'docs evidence unavailable',
        advisory: true,
        degraded: true,
      }),
      record({
        kind: 'ambiguous',
        authority: 'advisory',
        subject: 'heuristic edge',
        reason: 'single-hop relationship',
        advisory: true,
        ambiguous: true,
      }),
    ]);

    expect(diagnostics.summary).toMatchObject({
      total: 3,
      authoritative: 1,
      advisory: 2,
      ambiguous: 1,
      degraded: 1,
      truncated: 0,
    });
    expect(
      diagnostics.records.filter((r) => r.authority === 'advisory').every((r) => r.advisory),
    ).toBe(true);
  });

  it('bounds records with a caller supplied truncation marker', () => {
    const diagnostics = summarizeEvidenceDiagnostics(
      [record({ subject: 'a' }), record({ subject: 'b' }), record({ subject: 'c' })],
      {
        maxRecords: 2,
        createTruncationRecord: (omitted) =>
          record({
            category: 'runtime',
            kind: 'truncated',
            source: 'review',
            authority: 'advisory',
            subject: 'diagnostics records',
            reason: `${omitted} omitted`,
            count: omitted,
            advisory: true,
            degraded: true,
            truncated: true,
          }),
      },
    );

    expect(diagnostics.records.map((r) => r.subject)).toEqual(['a', 'diagnostics records']);
    expect(diagnostics.summary).toMatchObject({ total: 2, advisory: 1, truncated: 1 });
    expect(diagnostics.records[1]?.count).toBe(2);
  });

  it('classifies truncation wording and numeric summary values', () => {
    expect(isEvidenceDiagnosticTruncationReason('scan capped at 500 paths')).toBe(true);
    expect(isEvidenceDiagnosticTruncationReason('output omitted after limit')).toBe(true);
    expect(isEvidenceDiagnosticTruncationReason('docs sidecar missing')).toBe(false);
    expect(numericEvidenceDiagnosticSummaryValue({ files: 3 }, 'files')).toBe(3);
    expect(numericEvidenceDiagnosticSummaryValue({ files: '3' }, 'files')).toBeUndefined();
  });

  it('renders Markdown summary and grouped records passively', () => {
    const lines = [
      renderEvidenceDiagnosticSummaryLine(
        {
          total: 1,
          authoritative: 0,
          advisory: 1,
          ambiguous: 0,
          degraded: 1,
          truncated: 0,
        },
        ' | ',
      ),
      ...renderEvidenceDiagnosticGroup('Docs Evidence', [
        record({
          category: 'docs',
          kind: 'degraded',
          source: 'docs-sidecar',
          authority: 'advisory',
          subject: 'docs sidecar missing',
          reason: 'docs evidence unavailable',
          advisory: true,
          degraded: true,
        }),
      ]),
    ];

    expect(lines).toContain(
      'Records: **1** | authoritative: **0** | advisory: **1** | ambiguous: **0** | degraded: **1** | truncated: **0**',
    );
    expect(lines).toContain(
      '- [advisory/docs-sidecar] docs sidecar missing: docs evidence unavailable',
    );
  });

  it('summarizes explanation reasons with trimming and fallback', () => {
    expect(summarizeReasonParts([' degree 8 ', '', '2 flows'])).toBe('degree 8, 2 flows');
    expect(summarizeReasonParts([' ', ''], 'no reasons')).toBe('no reasons');
  });
});
