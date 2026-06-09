import { describe, expect, it } from 'vitest';
import {
  createEnrichmentRecord,
  decideEnrichmentFreshness,
  invalidateEnrichmentForNewAnalyze,
  type EnrichmentRecord,
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

describe('enrichment record contract', () => {
  it('creates serializable records and omits confidence when uncalibrated', () => {
    const record = createEnrichmentRecord(baseRecordInput);

    expect(record).toEqual({
      ...baseRecordInput,
      records: [{ kind: 'call-edge', from: 'main', to: 'run' }],
    });
    expect('confidence' in record).toBe(false);
    expect(JSON.parse(JSON.stringify(record))).toEqual(record);
  });

  it('keeps calibrated confidence in the inclusive 0..1 range', () => {
    expect(createEnrichmentRecord({ ...baseRecordInput, confidence: 0 }).confidence).toBe(0);
    expect(createEnrichmentRecord({ ...baseRecordInput, confidence: 1 }).confidence).toBe(1);
    expect(() => createEnrichmentRecord({ ...baseRecordInput, confidence: -0.01 })).toThrow(
      'confidence must be a finite number from 0 to 1',
    );
    expect(() => createEnrichmentRecord({ ...baseRecordInput, confidence: 1.01 })).toThrow(
      'confidence must be a finite number from 0 to 1',
    );
    expect(() => createEnrichmentRecord({ ...baseRecordInput, confidence: Number.NaN })).toThrow(
      'confidence must be a finite number from 0 to 1',
    );
  });

  it('rejects unsupported status values from persisted record input', () => {
    expect(() =>
      createEnrichmentRecord({ ...baseRecordInput, status: 'pending' as never }),
    ).toThrow('status has unsupported value: pending');
  });

  it('marks complete and partial records usable only when snapshot identity and file hash match', () => {
    const complete = createEnrichmentRecord(baseRecordInput);
    const partial = createEnrichmentRecord({ ...baseRecordInput, status: 'partial' });

    expect(decideEnrichmentFreshness(complete, freshSnapshot)).toEqual({
      usable: true,
      reason: 'fresh',
    });
    expect(decideEnrichmentFreshness(partial, freshSnapshot)).toEqual({
      usable: true,
      reason: 'fresh',
    });
  });

  it('rejects freshness for non-usable statuses and snapshot mismatches', () => {
    const record = createEnrichmentRecord(baseRecordInput);
    const running = createEnrichmentRecord({ ...baseRecordInput, status: 'running' });

    expect(decideEnrichmentFreshness(running, freshSnapshot)).toEqual({
      usable: false,
      reason: 'status-unusable',
    });
    expect(
      decideEnrichmentFreshness(record, { ...freshSnapshot, sourceIndexId: 'index-2' }),
    ).toEqual({ usable: false, reason: 'index-mismatch' });
    expect(
      decideEnrichmentFreshness(record, { ...freshSnapshot, sourceCommitHash: 'commit-2' }),
    ).toEqual({ usable: false, reason: 'commit-mismatch' });
    expect(decideEnrichmentFreshness(record, { ...freshSnapshot, schemaVersion: 3 })).toEqual({
      usable: false,
      reason: 'schema-mismatch',
    });
    expect(
      decideEnrichmentFreshness(record, { ...freshSnapshot, filePath: 'src/other.ts' }),
    ).toEqual({
      usable: false,
      reason: 'file-path-mismatch',
    });
    expect(
      decideEnrichmentFreshness(record, { ...freshSnapshot, fileHash: 'file-hash-2' }),
    ).toEqual({
      usable: false,
      reason: 'file-hash-mismatch',
    });
  });

  it('treats missing schema version on either side as a mismatch for read freshness', () => {
    const withoutSchema = createEnrichmentRecord({
      ...baseRecordInput,
      schemaVersion: undefined,
    });

    expect(decideEnrichmentFreshness(withoutSchema, freshSnapshot)).toEqual({
      usable: false,
      reason: 'schema-mismatch',
    });
  });

  it('marks old records stale by default after a new analyze', () => {
    const record = createEnrichmentRecord(baseRecordInput);

    expect(
      invalidateEnrichmentForNewAnalyze(record, {
        ...freshSnapshot,
        sourceIndexId: 'index-2',
        sourceCommitHash: 'commit-2',
        fileHash: 'file-hash-2',
      }),
    ).toEqual({
      record: { ...record, status: 'stale' },
      reason: 'stale-by-new-index',
    });
  });

  it('supersedes queued records after a new analyze unless hash-compatible', () => {
    const queued = createEnrichmentRecord({ ...baseRecordInput, status: 'queued' });

    expect(
      invalidateEnrichmentForNewAnalyze(queued, {
        ...freshSnapshot,
        sourceIndexId: 'index-2',
        sourceCommitHash: 'commit-2',
        fileHash: 'file-hash-2',
      }),
    ).toEqual({
      record: { ...queued, status: 'superseded' },
      reason: 'superseded-by-new-index',
    });
  });

  it('keeps hash-compatible file-level enrichment across a new index decision', () => {
    const record: EnrichmentRecord = createEnrichmentRecord(baseRecordInput);

    expect(
      invalidateEnrichmentForNewAnalyze(record, {
        ...freshSnapshot,
        sourceIndexId: 'index-2',
        sourceCommitHash: 'commit-2',
      }),
    ).toEqual({
      record,
      reason: 'hash-compatible',
    });
  });

  it('requires matching analyzer and schema versions to reuse enrichment after analyze', () => {
    const record = createEnrichmentRecord(baseRecordInput);

    expect(
      invalidateEnrichmentForNewAnalyze(record, {
        ...freshSnapshot,
        sourceIndexId: 'index-2',
        sourceCommitHash: 'commit-2',
        analyzerVersion: '2.0.0',
      }),
    ).toEqual({
      record: { ...record, status: 'stale' },
      reason: 'stale-by-new-index',
    });
    expect(
      invalidateEnrichmentForNewAnalyze(record, {
        ...freshSnapshot,
        sourceIndexId: 'index-2',
        sourceCommitHash: 'commit-2',
        analyzerVersion: undefined,
      }),
    ).toEqual({
      record: { ...record, status: 'stale' },
      reason: 'stale-by-new-index',
    });
    expect(
      invalidateEnrichmentForNewAnalyze(record, {
        ...freshSnapshot,
        sourceIndexId: 'index-2',
        sourceCommitHash: 'commit-2',
        schemaVersion: 3,
      }),
    ).toEqual({
      record: { ...record, status: 'stale' },
      reason: 'stale-by-new-index',
    });
  });
});
