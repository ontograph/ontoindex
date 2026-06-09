import { describe, expect, it } from 'vitest';
import {
  CURRENT_AXEL_ENRICHMENT_FACT_SCHEMA_VERSION,
  normalizeAxelEnrichmentFactEnvelope,
} from '../../src/core/ingestion/enrichment/index.js';

const baseSubject = {
  type: 'symbol',
  id: 'Function:runAnalyze',
  filePath: 'src/core/run-analyze.ts',
};

const baseFact = {
  subject: baseSubject,
  confidence: 0.9,
  evidence: [
    {
      kind: 'source-range',
      filePath: 'src/core/run-analyze.ts',
      fileHash: 'sha256:file-a',
      lineStart: 10,
      lineEnd: 20,
    },
  ],
  referencedFiles: [{ filePath: 'src/core/run-analyze.ts', fileHash: 'sha256:file-a' }],
};

const baseEnvelope = {
  analyzerId: 'axel',
  analyzerVersion: '0.1.0',
  schemaVersion: CURRENT_AXEL_ENRICHMENT_FACT_SCHEMA_VERSION,
  sourceIndexId: 'index-1',
  sourceCommitHash: 'abc123',
  repoId: 'repo-1',
};

describe('Axel enrichment fact contract', () => {
  it('accepts valid examples for all fact kinds', () => {
    const envelope = normalizeAxelEnrichmentFactEnvelope({
      ...baseEnvelope,
      facts: [
        {
          ...baseFact,
          kind: 'domain-classification',
          domain: 'ingestion',
        },
        {
          ...baseFact,
          kind: 'semantic-bridge',
          from: { type: 'process', id: 'Process:analyze' },
          to: { type: 'cluster', id: 'Cluster:ingestion' },
          bridgeType: 'architecture',
        },
        {
          ...baseFact,
          kind: 'architecture-drift',
          expectedDomain: 'cli',
          observedDomain: 'ingestion',
          childMix: { cli: 1, ingestion: 3 },
        },
        {
          ...baseFact,
          kind: 'orphan-anchor-suggestion',
          missing: 'process',
          suggestedAnchor: { type: 'process', id: 'Process:analyze' },
        },
      ],
    });

    expect(envelope).toEqual({
      ...baseEnvelope,
      facts: [
        {
          ...baseFact,
          kind: 'domain-classification',
          domain: 'ingestion',
        },
        {
          ...baseFact,
          kind: 'semantic-bridge',
          from: { type: 'process', id: 'Process:analyze' },
          to: { type: 'cluster', id: 'Cluster:ingestion' },
          bridgeType: 'architecture',
        },
        {
          ...baseFact,
          kind: 'architecture-drift',
          expectedDomain: 'cli',
          observedDomain: 'ingestion',
          childMix: { cli: 1, ingestion: 3 },
        },
        {
          ...baseFact,
          kind: 'orphan-anchor-suggestion',
          missing: 'process',
          suggestedAnchor: { type: 'process', id: 'Process:analyze' },
        },
      ],
    });
  });

  it('rejects unknown fact kinds', () => {
    expect(() =>
      normalizeAxelEnrichmentFactEnvelope({
        ...baseEnvelope,
        facts: [{ ...baseFact, kind: 'unexpected-kind' }],
      }),
    ).toThrow('facts[0].kind has unsupported value: unexpected-kind');
  });

  it('rejects missing envelope identity fields', () => {
    expect(() =>
      normalizeAxelEnrichmentFactEnvelope({
        ...baseEnvelope,
        analyzerId: '  ',
        facts: [],
      }),
    ).toThrow('analyzerId must be a non-empty string');
  });

  it('rejects referenced files without file hashes', () => {
    expect(() =>
      normalizeAxelEnrichmentFactEnvelope({
        ...baseEnvelope,
        facts: [
          {
            ...baseFact,
            kind: 'domain-classification',
            domain: 'ingestion',
            referencedFiles: [{ filePath: 'src/core/run-analyze.ts' }],
          },
        ],
      }),
    ).toThrow('facts[0].referencedFiles[0].fileHash must be a non-empty string');
  });

  it('requires file hashes for file-backed evidence', () => {
    expect(() =>
      normalizeAxelEnrichmentFactEnvelope({
        ...baseEnvelope,
        facts: [
          {
            ...baseFact,
            kind: 'domain-classification',
            domain: 'ingestion',
            evidence: [{ kind: 'source-range', filePath: 'src/core/run-analyze.ts' }],
          },
        ],
      }),
    ).toThrow('facts[0].evidence[0].fileHash must be a non-empty string');
  });

  it('accepts unresolved subjects only as explicit unresolved subjects', () => {
    const envelope = normalizeAxelEnrichmentFactEnvelope({
      ...baseEnvelope,
      facts: [
        {
          ...baseFact,
          kind: 'orphan-anchor-suggestion',
          subject: {
            type: 'unresolved',
            label: 'maybe Process:unknown',
            reason: 'no matching OntoIndex process identity',
          },
          missing: 'process',
        },
      ],
    });

    expect(envelope.facts[0].subject).toEqual({
      type: 'unresolved',
      label: 'maybe Process:unknown',
      reason: 'no matching OntoIndex process identity',
    });

    expect(() =>
      normalizeAxelEnrichmentFactEnvelope({
        ...baseEnvelope,
        facts: [
          {
            ...baseFact,
            kind: 'orphan-anchor-suggestion',
            subject: {
              type: 'symbol',
              id: 'Symbol:unknown',
              label: 'maybe Process:unknown',
              reason: 'no matching OntoIndex process identity',
            },
            missing: 'process',
          },
        ],
      }),
    ).toThrow('facts[0].subject unresolved label/reason requires type unresolved');
  });

  it('rejects low and high invalid confidence', () => {
    for (const confidence of [-0.01, 1.01]) {
      expect(() =>
        normalizeAxelEnrichmentFactEnvelope({
          ...baseEnvelope,
          facts: [
            {
              ...baseFact,
              kind: 'domain-classification',
              confidence,
              domain: 'ingestion',
            },
          ],
        }),
      ).toThrow('facts[0].confidence must be from 0 to 1');
    }
  });

  it('validates schema and analyzer versions', () => {
    expect(() =>
      normalizeAxelEnrichmentFactEnvelope({
        ...baseEnvelope,
        schemaVersion: CURRENT_AXEL_ENRICHMENT_FACT_SCHEMA_VERSION + 1,
        facts: [],
      }),
    ).toThrow(
      `Axel enrichment fact schemaVersion must be ${CURRENT_AXEL_ENRICHMENT_FACT_SCHEMA_VERSION}`,
    );

    expect(() =>
      normalizeAxelEnrichmentFactEnvelope({
        ...baseEnvelope,
        analyzerVersion: ' ',
        facts: [],
      }),
    ).toThrow('analyzerVersion must be a non-empty string');
  });
});
