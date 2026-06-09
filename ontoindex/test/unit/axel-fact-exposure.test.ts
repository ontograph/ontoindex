import { describe, expect, it } from 'vitest';
import {
  createEnrichmentRecord,
  exposeAxelEnrichmentFacts,
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

describe('Axel fact exposure', () => {
  it('keeps Axel facts hidden from consumption until explicitly opted in', () => {
    const record = createEnrichmentRecord({
      ...baseRecord,
      records: [{ kind: 'domain-classification', domain: 'ingestion' }],
    });

    const result = exposeAxelEnrichmentFacts([record], snapshot);

    expect(result.facts).toEqual([]);
    expect(result.summary).toMatchObject({
      factCount: 0,
      visibleRecordCount: 1,
      usedRecordCount: 0,
      rejectedRecordCount: 1,
    });
    expect(result.consumption.rejectedRecords[0]).toMatchObject({
      reason: 'fact-consumption-opt-in-required',
    });
  });

  it('exposes only supported Axel fact kinds with summary counters', () => {
    const record = createEnrichmentRecord({
      ...baseRecord,
      records: [
        { kind: 'domain-classification', domain: 'ingestion' },
        { kind: 'semantic-bridge', bridgeType: 'architecture' },
        { kind: 'call-edge', from: 'main', to: 'run' },
      ],
    });

    const result = exposeAxelEnrichmentFacts([record], snapshot, { consumeFacts: true });

    expect(result.facts).toEqual([
      { kind: 'domain-classification', domain: 'ingestion' },
      { kind: 'semantic-bridge', bridgeType: 'architecture' },
    ]);
    expect(result.summary).toEqual({
      factCount: 2,
      byKind: {
        'domain-classification': 1,
        'semantic-bridge': 1,
      },
      visibleRecordCount: 1,
      usedRecordCount: 1,
      rejectedRecordCount: 0,
      partialRecordCount: 0,
    });
  });

  it('preserves safety-critical impact strictness', () => {
    const record = createEnrichmentRecord({
      ...baseRecord,
      records: [{ kind: 'architecture-drift', observedDomain: 'ui' }],
    });

    const rejected = exposeAxelEnrichmentFacts([record], snapshot, {
      consumeFacts: true,
      safety: 'safety-critical-impact',
    });
    expect(rejected.facts).toEqual([]);
    expect(rejected.consumption.rejectedRecords[0]).toMatchObject({
      reason: 'safety-critical-opt-in-required',
    });

    const accepted = exposeAxelEnrichmentFacts([record], snapshot, {
      consumeFacts: true,
      safety: 'safety-critical-impact',
      allowSafetyCriticalImpact: true,
    });
    expect(accepted.facts).toEqual([{ kind: 'architecture-drift', observedDomain: 'ui' }]);
  });
});
