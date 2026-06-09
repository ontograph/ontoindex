import { describe, expect, it } from 'vitest';
import {
  createEnrichmentRecord,
  selectPassiveFactCandidates,
  type EnrichmentRecordInput,
  type EnrichmentSnapshot,
} from '../../src/core/ingestion/enrichment/index.js';

const fileA = { filePath: 'src/orders/service.ts', fileHash: 'hash-orders' };
const fileB = { filePath: 'src/billing/service.ts', fileHash: 'hash-billing' };

const baseInput: EnrichmentRecordInput = {
  sourceIndexId: 'index-1',
  sourceCommitHash: 'commit-1',
  schemaVersion: 1,
  analyzerId: 'axel',
  analyzerVersion: '0.1.0',
  filePath: fileA.filePath,
  fileHash: fileA.fileHash,
  status: 'complete',
  confidence: 0.95,
  records: [],
};

const snapshot: EnrichmentSnapshot = {
  sourceIndexId: baseInput.sourceIndexId,
  sourceCommitHash: baseInput.sourceCommitHash,
  schemaVersion: baseInput.schemaVersion,
  analyzerVersion: baseInput.analyzerVersion,
  filePath: baseInput.filePath,
  fileHash: baseInput.fileHash,
};

describe('passive fact selector', () => {
  it('returns exact subject matches with the highest deterministic score', () => {
    const record = createEnrichmentRecord({
      ...baseInput,
      records: [
        {
          kind: 'domain-classification',
          subject: { type: 'symbol', id: 'Class:OrderService', filePath: fileA.filePath },
          confidence: 0.91,
          evidence: [],
          referencedFiles: [fileA],
          domain: 'orders',
        },
      ],
    });

    const result = selectPassiveFactCandidates([record], snapshot, {
      type: 'symbol',
      id: 'Class:OrderService',
    });

    expect(result.candidates).toEqual([
      expect.objectContaining({
        reason: 'exact-subject-match',
        score: 0.991,
        fact: expect.objectContaining({ kind: 'domain-classification' }),
        record,
      }),
    ]);
    expect(result.summary).toMatchObject({ candidateCount: 1, rejectedRecordCount: 0 });
  });

  it('returns referenced file matches below exact subject matches', () => {
    const record = createEnrichmentRecord({
      ...baseInput,
      records: [
        {
          kind: 'architecture-drift',
          subject: { type: 'cluster', id: 'Cluster:orders' },
          confidence: 0.87,
          evidence: [],
          referencedFiles: [fileA, fileB],
          observedDomain: 'orders',
        },
      ],
    });

    const result = selectPassiveFactCandidates([record], snapshot, {
      type: 'file',
      filePath: fileB.filePath,
      fileHash: fileB.fileHash,
    });

    expect(result.candidates).toEqual([
      expect.objectContaining({
        reason: 'referenced-file-match',
        score: 0.787,
      }),
    ]);
  });

  it('uses semantic bridge endpoint matches as a fallback', () => {
    const record = createEnrichmentRecord({
      ...baseInput,
      records: [
        {
          kind: 'semantic-bridge',
          subject: { type: 'edge', id: 'Bridge:orders-billing' },
          confidence: 0.82,
          evidence: [],
          referencedFiles: [fileA],
          from: { type: 'symbol', id: 'Class:OrderService', filePath: fileA.filePath },
          to: { type: 'symbol', id: 'Class:InvoiceService', filePath: fileB.filePath },
          bridgeType: 'architecture',
        },
      ],
    });

    const result = selectPassiveFactCandidates([record], snapshot, {
      type: 'symbol',
      id: 'Class:InvoiceService',
    });

    expect(result.candidates).toEqual([
      expect.objectContaining({
        reason: 'semantic-bridge-fallback',
        score: 0.582,
      }),
    ]);
  });

  it('rejects stale records without returning facts', () => {
    const record = createEnrichmentRecord({
      ...baseInput,
      sourceCommitHash: 'old-commit',
      records: [
        {
          kind: 'domain-classification',
          subject: { type: 'symbol', id: 'Class:OrderService' },
          confidence: 0.91,
          evidence: [],
          referencedFiles: [fileA],
          domain: 'orders',
        },
      ],
    });

    const result = selectPassiveFactCandidates([record], snapshot, {
      type: 'symbol',
      id: 'Class:OrderService',
    });

    expect(result.candidates).toEqual([]);
    expect(result.rejectedRecords).toEqual([
      expect.objectContaining({ reason: 'stale-rejected', factCount: 1 }),
    ]);
    expect(result.summary.rejectionReasons).toEqual({ 'stale-rejected': 1 });
  });

  it('rejects low-confidence records by default', () => {
    const record = createEnrichmentRecord({
      ...baseInput,
      confidence: 0.4,
      records: [
        {
          kind: 'domain-classification',
          subject: { type: 'symbol', id: 'Class:OrderService' },
          confidence: 0.91,
          evidence: [],
          referencedFiles: [fileA],
          domain: 'orders',
        },
      ],
    });

    const result = selectPassiveFactCandidates([record], snapshot, {
      type: 'symbol',
      id: 'Class:OrderService',
    });

    expect(result.candidates).toEqual([]);
    expect(result.rejectedRecords[0]).toMatchObject({
      reason: 'low-confidence-rejected',
      factCount: 1,
    });
  });

  it('reports empty fact records as visible rejections', () => {
    const record = createEnrichmentRecord(baseInput);

    const result = selectPassiveFactCandidates([record], snapshot, {
      type: 'symbol',
      id: 'Class:OrderService',
    });

    expect(result.candidates).toEqual([]);
    expect(result.rejectedRecords).toEqual([
      expect.objectContaining({ reason: 'empty-facts', factCount: 0 }),
    ]);
    expect(result.summary).toEqual({
      candidateCount: 0,
      rejectedRecordCount: 1,
      rejectionReasons: { 'empty-facts': 1 },
    });
  });

  it('sorts equal-score candidates by stable fact identity', () => {
    const record = createEnrichmentRecord({
      ...baseInput,
      records: [
        {
          kind: 'domain-classification',
          subject: { type: 'symbol', id: 'Class:OrderService' },
          confidence: 0.9,
          evidence: [],
          referencedFiles: [fileA],
          domain: 'z-orders',
        },
        {
          kind: 'domain-classification',
          subject: { type: 'symbol', id: 'Class:OrderService' },
          confidence: 0.9,
          evidence: [],
          referencedFiles: [fileA],
          domain: 'a-orders',
        },
      ],
    });

    const result = selectPassiveFactCandidates([record], snapshot, {
      type: 'symbol',
      id: 'Class:OrderService',
    });

    expect(result.candidates.map((candidate) => candidate.fact.domain)).toEqual([
      'a-orders',
      'z-orders',
    ]);
  });
});
