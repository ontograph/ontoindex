import { describe, expect, it } from 'vitest';
import {
  createEnrichmentRecord,
  decideEnrichmentReadPolicy,
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

describe('enrichment read policy', () => {
  it('uses fresh complete enrichment when confidence clears the threshold', () => {
    const record = createEnrichmentRecord(baseRecordInput);

    expect(decideEnrichmentReadPolicy(record, freshSnapshot)).toEqual({
      used: true,
      reason: 'fresh-complete',
      status: 'complete',
      freshness: { usable: true, reason: 'fresh' },
      confidence: 0.95,
      minConfidence: 0.8,
      partial: false,
      visible: true,
    });
  });

  it('allows fresh partial enrichment while exposing partial metadata', () => {
    const record = createEnrichmentRecord({ ...baseRecordInput, status: 'partial' });

    expect(decideEnrichmentReadPolicy(record, freshSnapshot)).toEqual({
      used: true,
      reason: 'fresh-partial',
      status: 'partial',
      freshness: { usable: true, reason: 'fresh' },
      confidence: 0.95,
      minConfidence: 0.8,
      partial: true,
      visible: true,
    });
  });

  it('rejects stale enrichment but keeps freshness metadata visible', () => {
    const record = createEnrichmentRecord(baseRecordInput);

    expect(
      decideEnrichmentReadPolicy(record, { ...freshSnapshot, sourceCommitHash: 'commit-2' }),
    ).toEqual({
      used: false,
      reason: 'stale-rejected',
      status: 'complete',
      freshness: { usable: false, reason: 'commit-mismatch' },
      confidence: 0.95,
      minConfidence: 0.8,
      partial: false,
      visible: true,
    });
  });

  it('rejects low-confidence enrichment by default', () => {
    const record = createEnrichmentRecord({ ...baseRecordInput, confidence: 0.4 });

    expect(decideEnrichmentReadPolicy(record, freshSnapshot)).toMatchObject({
      used: false,
      reason: 'low-confidence-rejected',
      confidence: 0.4,
      minConfidence: 0.8,
    });
  });

  it('uses low-confidence enrichment only with explicit opt-in', () => {
    const record = createEnrichmentRecord({ ...baseRecordInput, confidence: 0.4 });

    expect(
      decideEnrichmentReadPolicy(record, freshSnapshot, { allowLowConfidence: true }),
    ).toMatchObject({
      used: true,
      reason: 'fresh-complete',
      confidence: 0.4,
    });
  });

  it('requires complete high-confidence enrichment for safety-critical impact', () => {
    const partial = createEnrichmentRecord({ ...baseRecordInput, status: 'partial' });
    const lowConfidence = createEnrichmentRecord({ ...baseRecordInput, confidence: 0.4 });
    const complete = createEnrichmentRecord(baseRecordInput);

    expect(
      decideEnrichmentReadPolicy(complete, freshSnapshot, {
        safety: 'safety-critical-impact',
      }),
    ).toMatchObject({
      used: false,
      reason: 'safety-critical-opt-in-required',
    });
    expect(
      decideEnrichmentReadPolicy(partial, freshSnapshot, {
        safety: 'safety-critical-impact',
        allowSafetyCriticalImpact: true,
      }),
    ).toMatchObject({
      used: false,
      reason: 'fresh-partial-rejected',
      partial: true,
    });
    expect(
      decideEnrichmentReadPolicy(lowConfidence, freshSnapshot, {
        safety: 'safety-critical-impact',
        allowSafetyCriticalImpact: true,
      }),
    ).toMatchObject({
      used: false,
      reason: 'low-confidence-rejected',
      confidence: 0.4,
    });
    expect(
      decideEnrichmentReadPolicy(complete, freshSnapshot, {
        safety: 'safety-critical-impact',
        allowSafetyCriticalImpact: true,
      }),
    ).toMatchObject({
      used: true,
      reason: 'fresh-complete',
    });
  });

  it('allows low-confidence safety-critical impact only with both explicit opt-ins', () => {
    const record = createEnrichmentRecord({ ...baseRecordInput, confidence: 0.4 });

    expect(
      decideEnrichmentReadPolicy(record, freshSnapshot, {
        safety: 'safety-critical-impact',
        allowLowConfidence: true,
        allowSafetyCriticalImpact: true,
      }),
    ).toMatchObject({
      used: true,
      reason: 'fresh-complete',
      confidence: 0.4,
    });
  });

  it('keeps failed and stale statuses visible but unused', () => {
    const failed = createEnrichmentRecord({
      ...baseRecordInput,
      status: 'failed',
      failureReason: 'analyzer crashed',
    });
    const stale = createEnrichmentRecord({ ...baseRecordInput, status: 'stale' });

    expect(decideEnrichmentReadPolicy(failed, freshSnapshot)).toMatchObject({
      used: false,
      reason: 'status-rejected',
      status: 'failed',
      freshness: { usable: false, reason: 'status-unusable' },
      visible: true,
    });
    expect(decideEnrichmentReadPolicy(stale, freshSnapshot)).toMatchObject({
      used: false,
      reason: 'status-rejected',
      status: 'stale',
      freshness: { usable: false, reason: 'status-unusable' },
      visible: true,
    });
  });
});
