import { describe, expect, it } from 'vitest';
import {
  createEnrichmentRecord,
  decideEnrichmentFreshness,
  invalidateEnrichmentForNewAnalyze,
  normalizeAxelEnrichmentFact,
  type EnrichmentFact,
} from '../../src/core/ingestion/enrichment/index.js';

const baseRecordInput = {
  sourceIndexId: 'index-axel-1',
  sourceCommitHash: 'commit-axel-1',
  schemaVersion: 2,
  analyzerId: 'axel',
  analyzerVersion: '0.1.0',
  filePath: 'src/domain/order-service.ts',
  fileHash: 'record-file-hash-1',
  status: 'complete' as const,
};

const freshSnapshot = {
  sourceIndexId: 'index-axel-1',
  sourceCommitHash: 'commit-axel-1',
  schemaVersion: 2,
  analyzerVersion: '0.1.0',
  filePath: 'src/domain/order-service.ts',
  fileHash: 'record-file-hash-1',
};

const domainClassificationFact: EnrichmentFact = {
  kind: 'domain-classification',
  subject: {
    type: 'symbol',
    id: 'Class:OrderService',
    filePath: 'src/domain/order-service.ts',
  },
  domain: 'billing',
  confidence: 0.91,
  evidence: [
    {
      kind: 'source-range',
      filePath: 'src/domain/order-service.ts',
      fileHash: 'record-file-hash-1',
      symbols: ['OrderService', 'createInvoice'],
    },
  ],
  referencedFiles: [
    {
      filePath: 'src/domain/order-service.ts',
      fileHash: 'record-file-hash-1',
    },
  ],
};

const semanticBridgeFact: EnrichmentFact = {
  kind: 'semantic-bridge',
  subject: {
    type: 'edge',
    id: 'Bridge:orders-to-billing',
  },
  from: {
    type: 'symbol',
    id: 'Class:OrderService',
    filePath: 'src/domain/order-service.ts',
  },
  to: {
    type: 'symbol',
    id: 'Class:InvoiceService',
    filePath: 'src/domain/invoice-service.ts',
  },
  bridgeType: 'architecture',
  confidence: 0.88,
  evidence: [],
  referencedFiles: [
    {
      filePath: 'src/domain/order-service.ts',
      fileHash: 'record-file-hash-1',
    },
    {
      filePath: 'src/domain/invoice-service.ts',
      fileHash: 'referenced-file-hash-2',
    },
  ],
};

describe('enrichment record Axel compatibility', () => {
  it('stores Axel domain-classification facts as serializable enrichment payloads', () => {
    const fact = normalizeAxelEnrichmentFact(domainClassificationFact);
    const record = createEnrichmentRecord({
      ...baseRecordInput,
      records: [fact],
    });

    expect(record.records).toEqual([fact]);
    expect(JSON.parse(JSON.stringify(record))).toEqual(record);
  });

  it('preserves multi-file Axel semantic-bridge referenced file hashes in records', () => {
    const fact = normalizeAxelEnrichmentFact(semanticBridgeFact);
    const record = createEnrichmentRecord({
      ...baseRecordInput,
      records: [fact],
    });

    expect(record.records).toEqual([fact]);
    expect(record.records[0]).toMatchObject({
      kind: 'semantic-bridge',
      referencedFiles: [
        { filePath: 'src/domain/order-service.ts', fileHash: 'record-file-hash-1' },
        { filePath: 'src/domain/invoice-service.ts', fileHash: 'referenced-file-hash-2' },
      ],
    });
  });

  it('rejects stale record-level file hashes even when Axel referencedFiles include matching hashes', () => {
    const fact = normalizeAxelEnrichmentFact(semanticBridgeFact);
    const record = createEnrichmentRecord({
      ...baseRecordInput,
      fileHash: 'record-file-hash-stale',
      records: [fact],
    });

    expect(decideEnrichmentFreshness(record, freshSnapshot)).toEqual({
      usable: false,
      reason: 'file-hash-mismatch',
    });
  });

  it('invalidates by record-level identity without inspecting Axel fact internals', () => {
    const fact = normalizeAxelEnrichmentFact(semanticBridgeFact);
    const record = createEnrichmentRecord({
      ...baseRecordInput,
      fileHash: 'record-file-hash-stale',
      records: [fact],
    });

    expect(invalidateEnrichmentForNewAnalyze(record, freshSnapshot)).toEqual({
      record: { ...record, status: 'stale' },
      reason: 'stale-by-new-index',
    });
  });
});
