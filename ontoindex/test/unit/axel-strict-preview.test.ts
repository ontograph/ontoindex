import { describe, expect, it } from 'vitest';
import {
  createEnrichmentRecord,
  previewAxelStrictFindings,
} from '../../src/core/ingestion/enrichment/index.js';

const snapshot = {
  sourceIndexId: 'index-1',
  sourceCommitHash: 'commit-1',
  schemaVersion: 1,
  analyzerVersion: '0.1.0',
  filePath: 'src/app.ts',
  fileHash: 'sha256:app',
};

const baseRecord = {
  sourceIndexId: 'index-1',
  sourceCommitHash: 'commit-1',
  schemaVersion: 1,
  analyzerId: 'axel',
  analyzerVersion: '0.1.0',
  filePath: 'src/app.ts',
  fileHash: 'sha256:app',
  status: 'complete' as const,
  confidence: 0.9,
};

describe('Axel strict preview', () => {
  it('reports only review findings from persisted Axel facts', () => {
    const record = createEnrichmentRecord({
      ...baseRecord,
      records: [
        { kind: 'domain-classification', domain: 'ingestion' },
        { kind: 'architecture-drift', observedDomain: 'ui' },
        { kind: 'orphan-anchor-suggestion', missing: 'owner' },
      ],
    });

    const result = previewAxelStrictFindings([record], snapshot);

    expect(result.findings).toEqual([
      { kind: 'architecture-drift', fact: { kind: 'architecture-drift', observedDomain: 'ui' } },
      {
        kind: 'orphan-anchor-suggestion',
        fact: { kind: 'orphan-anchor-suggestion', missing: 'owner' },
      },
    ]);
    expect(result.summary).toEqual({
      findingCount: 2,
      architectureDriftCount: 1,
      orphanAnchorSuggestionCount: 1,
      factCount: 3,
      rejectedRecordCount: 0,
    });
  });

  it('keeps safety-critical strictness read-only and opt-in', () => {
    const record = createEnrichmentRecord({
      ...baseRecord,
      records: [{ kind: 'architecture-drift', observedDomain: 'ui' }],
    });

    const rejected = previewAxelStrictFindings([record], snapshot, {
      safety: 'safety-critical-impact',
    });
    expect(rejected.findings).toEqual([]);
    expect(rejected.summary.rejectedRecordCount).toBe(1);

    const accepted = previewAxelStrictFindings([record], snapshot, {
      safety: 'safety-critical-impact',
      allowSafetyCriticalImpact: true,
    });
    expect(accepted.findings).toHaveLength(1);
  });
});
