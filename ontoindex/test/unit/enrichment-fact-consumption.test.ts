import { describe, expect, it } from 'vitest';
import {
  consumeEnrichmentFacts,
  createEnrichmentRecord,
} from '../../src/core/ingestion/enrichment/index.js';

const baseRecordInput = {
  sourceIndexId: 'index-1',
  sourceCommitHash: 'commit-1',
  schemaVersion: 2,
  analyzerId: 'ts-type-aware',
  analyzerVersion: '1.0.0',
  filePath: 'src/app.ts',
  fileHash: 'file-hash-1',
  status: 'complete' as const,
  confidence: 0.95,
  records: [{ kind: 'call-edge', from: 'main', to: 'run' }],
};

const freshSnapshot = {
  sourceIndexId: 'index-1',
  sourceCommitHash: 'commit-1',
  schemaVersion: 2,
  analyzerVersion: '1.0.0',
  filePath: 'src/app.ts',
  fileHash: 'file-hash-1',
};

describe('enrichment fact consumption', () => {
  it('defaults to visible metadata without consuming facts', () => {
    const record = createEnrichmentRecord(baseRecordInput);

    const result = consumeEnrichmentFacts([record], freshSnapshot);

    expect(result.facts).toEqual([]);
    expect(result.usedRecords).toEqual([]);
    expect(result.rejectedRecords).toHaveLength(1);
    expect(result.rejectedRecords[0]).toMatchObject({
      reason: 'fact-consumption-opt-in-required',
      factCount: 1,
      decision: { used: true, reason: 'fresh-complete' },
    });
    expect(result.visibleRecords).toEqual([
      {
        analyzerId: 'ts-type-aware',
        analyzerVersion: '1.0.0',
        filePath: 'src/app.ts',
        status: 'complete',
        confidence: 0.95,
        partial: false,
        factCount: 1,
        used: false,
        rejectionReason: 'fact-consumption-opt-in-required',
        readPolicyReason: 'fresh-complete',
        freshnessReason: 'fresh',
      },
    ]);
    expect(result.summary).toEqual({
      visibleRecordCount: 1,
      usedRecordCount: 0,
      usedFactCount: 0,
      rejectedRecordCount: 1,
      partialRecordCount: 0,
      rejectionReasons: { 'fact-consumption-opt-in-required': 1 },
    });
  });

  it('consumes complete fresh facts with explicit opt-in', () => {
    const record = createEnrichmentRecord(baseRecordInput);

    const result = consumeEnrichmentFacts([record], freshSnapshot, { consumeFacts: true });

    expect(result.facts).toEqual([{ kind: 'call-edge', from: 'main', to: 'run' }]);
    expect(result.usedRecords).toHaveLength(1);
    expect(result.usedRecords[0]).toMatchObject({
      record,
      facts: [{ kind: 'call-edge', from: 'main', to: 'run' }],
      decision: { used: true, reason: 'fresh-complete' },
    });
    expect(result.rejectedRecords).toEqual([]);
    expect(result.visibleRecords[0]).toMatchObject({
      used: true,
      readPolicyReason: 'fresh-complete',
    });
    expect(result.visibleRecords[0].rejectionReason).toBeUndefined();
  });

  it('rejects stale records even with consumption opt-in', () => {
    const record = createEnrichmentRecord(baseRecordInput);

    const result = consumeEnrichmentFacts(
      [record],
      { ...freshSnapshot, sourceCommitHash: 'commit-2' },
      { consumeFacts: true },
    );

    expect(result.facts).toEqual([]);
    expect(result.rejectedRecords[0]).toMatchObject({
      reason: 'stale-rejected',
      decision: {
        used: false,
        reason: 'stale-rejected',
        freshness: { usable: false, reason: 'commit-mismatch' },
      },
    });
    expect(result.summary.rejectionReasons).toEqual({ 'stale-rejected': 1 });
  });

  it('requires low-confidence opt-in in addition to fact consumption opt-in', () => {
    const record = createEnrichmentRecord({ ...baseRecordInput, confidence: 0.4 });

    expect(
      consumeEnrichmentFacts([record], freshSnapshot, { consumeFacts: true }).rejectedRecords[0],
    ).toMatchObject({
      reason: 'low-confidence-rejected',
      decision: { used: false, reason: 'low-confidence-rejected' },
    });

    const allowed = consumeEnrichmentFacts([record], freshSnapshot, {
      consumeFacts: true,
      allowLowConfidence: true,
    });
    expect(allowed.facts).toEqual([{ kind: 'call-edge', from: 'main', to: 'run' }]);
    expect(allowed.rejectedRecords).toEqual([]);
  });

  it('keeps partial records visible and flagged', () => {
    const record = createEnrichmentRecord({ ...baseRecordInput, status: 'partial' });

    const result = consumeEnrichmentFacts([record], freshSnapshot);

    expect(result.visibleRecords[0]).toMatchObject({
      status: 'partial',
      partial: true,
      used: false,
      rejectionReason: 'fact-consumption-opt-in-required',
      readPolicyReason: 'fresh-partial',
    });
    expect(result.summary.partialRecordCount).toBe(1);
  });

  it('preserves safety-critical strictness', () => {
    const complete = createEnrichmentRecord(baseRecordInput);
    const partial = createEnrichmentRecord({ ...baseRecordInput, status: 'partial' });

    expect(
      consumeEnrichmentFacts([complete], freshSnapshot, {
        consumeFacts: true,
        safety: 'safety-critical-impact',
      }).rejectedRecords[0],
    ).toMatchObject({
      reason: 'safety-critical-opt-in-required',
      decision: { used: false, reason: 'safety-critical-opt-in-required' },
    });

    expect(
      consumeEnrichmentFacts([partial], freshSnapshot, {
        consumeFacts: true,
        safety: 'safety-critical-impact',
        allowSafetyCriticalImpact: true,
      }).rejectedRecords[0],
    ).toMatchObject({
      reason: 'fresh-partial-rejected',
      decision: { used: false, reason: 'fresh-partial-rejected', partial: true },
    });

    expect(
      consumeEnrichmentFacts([complete], freshSnapshot, {
        consumeFacts: true,
        safety: 'safety-critical-impact',
        allowSafetyCriticalImpact: true,
      }).facts,
    ).toEqual([{ kind: 'call-edge', from: 'main', to: 'run' }]);
  });

  it('aggregates rejection reasons across records', () => {
    const complete = createEnrichmentRecord(baseRecordInput);
    const stale = createEnrichmentRecord({ ...baseRecordInput, fileHash: 'old-file-hash' });
    const lowConfidence = createEnrichmentRecord({
      ...baseRecordInput,
      confidence: 0.4,
    });
    const failed = createEnrichmentRecord({
      ...baseRecordInput,
      status: 'failed',
      failureReason: 'analyzer crashed',
    });

    const result = consumeEnrichmentFacts([complete, stale, lowConfidence, failed], freshSnapshot, {
      consumeFacts: true,
    });

    expect(result.summary).toMatchObject({
      visibleRecordCount: 4,
      usedRecordCount: 1,
      usedFactCount: 1,
      rejectedRecordCount: 3,
      rejectionReasons: {
        'stale-rejected': 1,
        'low-confidence-rejected': 1,
        'status-rejected': 1,
      },
    });
  });
});
