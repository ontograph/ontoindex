import { describe, expect, it } from 'vitest';
import {
  AXEL_SIDECAR_ADAPTER_FAILURE_REASON,
  AXEL_SIDECAR_ADAPTER_IDENTITY_MISMATCH_REASON,
  CURRENT_AXEL_ENRICHMENT_FACT_SCHEMA_VERSION,
  convertAxelEnvelopeToEnrichmentRecords,
  type AxelSidecarAdapterOptions,
} from '../../src/core/ingestion/enrichment/index.js';

const options: AxelSidecarAdapterOptions = {
  analyzerId: 'axel',
  analyzerVersion: '0.1.0',
  sourceIndexId: 'index-1',
  sourceCommitHash: 'commit-1',
  schemaVersion: CURRENT_AXEL_ENRICHMENT_FACT_SCHEMA_VERSION,
  repoId: 'repo-1',
};

const fileA = { filePath: 'src/domain/order-service.ts', fileHash: 'hash-order' };
const fileB = { filePath: 'src/domain/invoice-service.ts', fileHash: 'hash-invoice' };

const subjectA = {
  type: 'symbol',
  id: 'Class:OrderService',
  filePath: fileA.filePath,
};

const envelope = {
  analyzerId: options.analyzerId,
  analyzerVersion: options.analyzerVersion,
  schemaVersion: options.schemaVersion,
  sourceIndexId: options.sourceIndexId,
  sourceCommitHash: options.sourceCommitHash,
  repoId: options.repoId,
  facts: [
    {
      kind: 'domain-classification',
      subject: subjectA,
      confidence: 0.91,
      evidence: [{ kind: 'source-range', ...fileA, lineStart: 10, lineEnd: 20 }],
      referencedFiles: [fileA],
      domain: 'orders',
    },
  ],
};

describe('Axel sidecar adapter', () => {
  it('converts complete envelopes into grouped records keyed by file path and hash', () => {
    const records = convertAxelEnvelopeToEnrichmentRecords(
      {
        ...envelope,
        facts: [
          ...envelope.facts,
          {
            kind: 'architecture-drift',
            subject: { type: 'file', id: 'File:invoice-service', filePath: fileB.filePath },
            confidence: 0.72,
            evidence: [{ kind: 'source-range', ...fileB }],
            referencedFiles: [fileB],
            expectedDomain: 'billing',
            observedDomain: 'invoicing',
          },
        ],
      },
      options,
    );

    expect(records).toEqual([
      {
        sourceIndexId: options.sourceIndexId,
        sourceCommitHash: options.sourceCommitHash,
        schemaVersion: options.schemaVersion,
        analyzerId: options.analyzerId,
        analyzerVersion: options.analyzerVersion,
        filePath: fileB.filePath,
        fileHash: fileB.fileHash,
        status: 'complete',
        records: [
          expect.objectContaining({
            kind: 'architecture-drift',
            referencedFiles: [fileB],
          }),
        ],
      },
      {
        sourceIndexId: options.sourceIndexId,
        sourceCommitHash: options.sourceCommitHash,
        schemaVersion: options.schemaVersion,
        analyzerId: options.analyzerId,
        analyzerVersion: options.analyzerVersion,
        filePath: fileA.filePath,
        fileHash: fileA.fileHash,
        status: 'complete',
        records: [
          expect.objectContaining({
            kind: 'domain-classification',
            referencedFiles: [fileA],
          }),
        ],
      },
    ]);
  });

  it('copies multi-file semantic bridge facts into each referenced file record', () => {
    const bridge = {
      kind: 'semantic-bridge',
      subject: { type: 'edge', id: 'Bridge:orders-to-billing' },
      confidence: 0.88,
      evidence: [],
      referencedFiles: [fileA, fileB],
      from: subjectA,
      to: { type: 'symbol', id: 'Class:InvoiceService', filePath: fileB.filePath },
      bridgeType: 'architecture',
    };

    const records = convertAxelEnvelopeToEnrichmentRecords(
      {
        ...envelope,
        facts: [bridge],
      },
      options,
    );

    expect(records).toHaveLength(2);
    for (const record of records) {
      expect(record.records).toEqual([
        expect.objectContaining({
          kind: 'semantic-bridge',
          referencedFiles: [fileA, fileB],
        }),
      ]);
    }
  });

  it('turns malformed Axel output into failed records when file scope is known', () => {
    const records = convertAxelEnvelopeToEnrichmentRecords(
      {
        ...envelope,
        facts: [{ ...envelope.facts[0], kind: 'unknown-fact-kind' }],
      },
      { ...options, fileScopes: [fileA, fileB] },
    );

    expect(records).toEqual([
      expect.objectContaining({
        filePath: fileB.filePath,
        fileHash: fileB.fileHash,
        status: 'failed',
        records: [],
        failureReason: expect.stringContaining(AXEL_SIDECAR_ADAPTER_FAILURE_REASON),
      }),
      expect.objectContaining({
        filePath: fileA.filePath,
        fileHash: fileA.fileHash,
        status: 'failed',
        records: [],
        failureReason: expect.stringContaining(AXEL_SIDECAR_ADAPTER_FAILURE_REASON),
      }),
    ]);
  });

  it('turns identity mismatches into failed records instead of throwing when file scope is known', () => {
    const records = convertAxelEnvelopeToEnrichmentRecords(
      {
        ...envelope,
        sourceCommitHash: 'other-commit',
      },
      { ...options, fileScopes: [fileA] },
    );

    expect(records).toEqual([
      expect.objectContaining({
        filePath: fileA.filePath,
        fileHash: fileA.fileHash,
        status: 'failed',
        records: [],
        failureReason: AXEL_SIDECAR_ADAPTER_IDENTITY_MISMATCH_REASON,
      }),
    ]);
  });

  it('returns an empty result for zero facts', () => {
    expect(
      convertAxelEnvelopeToEnrichmentRecords(
        {
          ...envelope,
          facts: [],
        },
        options,
      ),
    ).toEqual([]);
  });
});
