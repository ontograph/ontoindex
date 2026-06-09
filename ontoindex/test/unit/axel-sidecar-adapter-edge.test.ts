import { describe, expect, it } from 'vitest';
import {
  CURRENT_AXEL_ENRICHMENT_FACT_SCHEMA_VERSION,
  convertAxelEnvelopeToEnrichmentRecords,
} from '../../src/core/ingestion/enrichment/index.js';

const fileA = { filePath: 'src/domain/order-service.ts', fileHash: 'sha256:file-a' };
const fileB = { filePath: 'src/domain/invoice-service.ts', fileHash: 'sha256:file-b' };

const baseEnvelope = {
  analyzerId: 'axel',
  analyzerVersion: '0.1.0',
  schemaVersion: CURRENT_AXEL_ENRICHMENT_FACT_SCHEMA_VERSION,
  sourceIndexId: 'index-edge-1',
  sourceCommitHash: 'commit-edge-1',
  repoId: 'repo-edge-1',
};

function convertFacts(facts: readonly Record<string, unknown>[], files = [fileA]) {
  return convertAxelEnvelopeToEnrichmentRecords(
    { ...baseEnvelope, facts },
    { ...baseEnvelope, files },
  );
}

function domainFact(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'domain-classification',
    subject: {
      type: 'symbol',
      id: 'Class:OrderService',
      filePath: fileA.filePath,
    },
    domain: 'billing',
    confidence: 0.91,
    evidence: [
      {
        kind: 'source-range',
        filePath: fileA.filePath,
        fileHash: fileA.fileHash,
        lineStart: 10,
        lineEnd: 20,
      },
    ],
    referencedFiles: [fileA],
    ...overrides,
  };
}

describe('Axel sidecar adapter edge contract', () => {
  it('keeps unresolved subjects in record payloads without requiring canonical ids', () => {
    const fact = domainFact({
      subject: {
        type: 'unresolved',
        label: 'maybe Class:UnknownOrderPort',
        reason: 'no matching canonical OntoIndex symbol',
        filePath: fileA.filePath,
      },
    });

    const records = convertFacts([fact]);

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      filePath: fileA.filePath,
      fileHash: fileA.fileHash,
      status: 'complete',
      records: [fact],
    });
    expect(records[0].records[0]).not.toHaveProperty('subject.id');
  });

  it('creates a failed file record when file-backed evidence omits its hash', () => {
    const records = convertFacts([
      domainFact({
        evidence: [{ kind: 'source-range', filePath: fileA.filePath, lineStart: 10 }],
      }),
    ]);

    expect(records).toEqual([
      expect.objectContaining({
        filePath: fileA.filePath,
        fileHash: fileA.fileHash,
        status: 'failed',
        records: [],
        failureReason: expect.stringContaining('fileHash'),
      }),
    ]);
  });

  it('rejects facts referencing files outside the supplied file scope as failed records', () => {
    const records = convertFacts([
      domainFact({
        referencedFiles: [fileB],
        evidence: [{ kind: 'source-range', filePath: fileB.filePath, fileHash: fileB.fileHash }],
      }),
    ]);

    expect(records).toEqual([
      expect.objectContaining({
        filePath: fileB.filePath,
        fileHash: fileB.fileHash,
        status: 'failed',
        records: [],
        failureReason: expect.stringContaining('scope'),
      }),
    ]);
  });

  it('groups duplicate facts for the same file into one record payload', () => {
    const first = domainFact({ domain: 'billing' });
    const second = domainFact({
      domain: 'orders',
      subject: { type: 'symbol', id: 'Function:createInvoice', filePath: fileA.filePath },
    });

    const records = convertFacts([first, second]);

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      filePath: fileA.filePath,
      fileHash: fileA.fileHash,
      status: 'complete',
      records: [first, second],
    });
  });

  it('does not mutate the input envelope', () => {
    const envelope = {
      ...baseEnvelope,
      facts: [domainFact()],
    };
    const before = structuredClone(envelope);

    convertAxelEnvelopeToEnrichmentRecords(envelope, { ...baseEnvelope, files: [fileA] });

    expect(envelope).toEqual(before);
  });
});
