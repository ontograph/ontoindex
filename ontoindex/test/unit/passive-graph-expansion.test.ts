import { describe, expect, it } from 'vitest';
import {
  createEnrichmentRecord,
  expandPassiveGraph,
  type EnrichmentRecord,
  type EnrichmentSnapshot,
  type PassiveGraphFactCandidate,
} from '../../src/core/ingestion/enrichment/index.js';

const snapshot: EnrichmentSnapshot = {
  sourceIndexId: 'index-1',
  sourceCommitHash: 'commit-1',
  schemaVersion: 1,
  analyzerVersion: '1.0.0',
  filePath: 'src/orders/service.ts',
  fileHash: 'hash-orders',
};

function record(overrides: Partial<EnrichmentRecord> = {}): EnrichmentRecord {
  return createEnrichmentRecord({
    sourceIndexId: 'index-1',
    sourceCommitHash: 'commit-1',
    schemaVersion: 1,
    analyzerId: 'axel',
    analyzerVersion: '1.0.0',
    filePath: 'src/orders/service.ts',
    fileHash: 'hash-orders',
    status: 'complete',
    confidence: 0.95,
    records: [],
    ...overrides,
  });
}

function candidate(overrides: Partial<PassiveGraphFactCandidate> = {}): PassiveGraphFactCandidate {
  return {
    factKey: 'fact-1',
    fact: {
      kind: 'semantic-bridge',
      subject: {
        type: 'symbol',
        id: 'Function:src/orders/service.ts:createOrder',
        filePath: 'src/orders/service.ts',
      },
      from: {
        type: 'symbol',
        id: 'Function:src/orders/service.ts:createOrder',
        filePath: 'src/orders/service.ts',
      },
      to: {
        type: 'symbol',
        id: 'Function:src/billing/invoice.ts:createInvoice',
        filePath: 'src/billing/invoice.ts',
      },
      bridgeType: 'usage',
      confidence: 0.9,
      evidence: [],
      referencedFiles: [
        { filePath: 'src/orders/service.ts', fileHash: 'hash-orders' },
        { filePath: 'src/billing/invoice.ts', fileHash: 'hash-billing' },
      ],
    },
    record: record(),
    score: 0.92,
    reason: 'semantic-bridge-fallback',
    ...overrides,
  };
}

describe('passive graph expansion', () => {
  it('returns related metadata without changing primary result ordering', () => {
    const primaryResults = [
      { id: 'primary-1', score: 1 },
      { id: 'primary-2', score: 0.8 },
    ];

    const result = expandPassiveGraph(primaryResults, [candidate()], {
      topK: 5,
      maxDepth: 1,
      allowedIdentityTypes: ['symbol', 'file'],
      snapshot,
    });

    expect(result.primaryResults).toBe(primaryResults);
    expect(result.primaryResults).toEqual([
      { id: 'primary-1', score: 1 },
      { id: 'primary-2', score: 0.8 },
    ]);
    expect(result.relatedFacts).toEqual([
      {
        factKey: 'fact-1',
        kind: 'semantic-bridge',
        score: 0.92,
        source: {
          analyzerId: 'axel',
          analyzerVersion: '1.0.0',
          filePath: 'src/orders/service.ts',
        },
        explanation: {
          retriever: 'passive-graph-expansion',
          sourceFactKind: 'semantic-bridge',
          expansionReason: 'semantic-bridge-fallback',
        },
      },
    ]);
    expect(result.relatedSymbols.map((item) => item.id)).toEqual([
      'Function:src/orders/service.ts:createOrder',
      'Function:src/billing/invoice.ts:createInvoice',
    ]);
    expect(result.relatedFiles.map((item) => item.filePath)).toEqual([
      'src/orders/service.ts',
      'src/billing/invoice.ts',
    ]);
    expect(result.relatedIdentities.map((item) => item.id)).toEqual([
      'Function:src/orders/service.ts:createOrder',
      'Function:src/billing/invoice.ts:createInvoice',
      'src/orders/service.ts',
      'src/billing/invoice.ts',
    ]);
    expect(result.explanation.retrievers).toEqual([
      { name: 'passive-graph-expansion', factCount: 1, identityCount: 4 },
    ]);
  });

  it('enforces topK against selector candidate order', () => {
    const result = expandPassiveGraph(
      [],
      [candidate({ factKey: 'fact-1', score: 0.9 }), candidate({ factKey: 'fact-2', score: 0.8 })],
      {
        topK: 1,
        maxDepth: 1,
        allowedIdentityTypes: ['symbol', 'file'],
        snapshot,
      },
    );

    expect(result.relatedFacts.map((fact) => fact.factKey)).toEqual(['fact-1']);
    expect(result.relatedIdentities.map((identity) => identity.id)).toEqual([
      'Function:src/orders/service.ts:createOrder',
    ]);
    expect(result.skipped).toEqual([
      { factKey: 'fact-1', reason: 'top-k-exceeded', detail: 'symbol' },
      { factKey: 'fact-1', reason: 'top-k-exceeded', detail: 'file' },
      { factKey: 'fact-1', reason: 'top-k-exceeded', detail: 'file' },
      { factKey: 'fact-2', reason: 'top-k-exceeded' },
    ]);
  });

  it('enforces max depth before identity expansion', () => {
    const result = expandPassiveGraph([], [candidate()], {
      topK: 5,
      maxDepth: 0,
      allowedIdentityTypes: ['symbol', 'file'],
      snapshot,
    });

    expect(result.relatedFacts).toHaveLength(1);
    expect(result.relatedSymbols).toEqual([]);
    expect(result.relatedFiles).toEqual([]);
    expect(result.skipped).toEqual([{ factKey: 'fact-1', reason: 'max-depth-exceeded' }]);
  });

  it('enforces allowed identity types', () => {
    const result = expandPassiveGraph([], [candidate()], {
      topK: 5,
      maxDepth: 1,
      allowedIdentityTypes: ['file'],
      snapshot,
    });

    expect(result.relatedSymbols).toEqual([]);
    expect(result.relatedFiles).toHaveLength(2);
    expect(result.relatedIdentities).toHaveLength(2);
    expect(result.summary.degradedReasons).toEqual({ 'identity-type-not-allowed': 2 });
  });

  it('returns allowed process and cluster identities in generic related metadata', () => {
    const result = expandPassiveGraph(
      [],
      [
        candidate({
          fact: {
            kind: 'process-cluster-link',
            subject: { type: 'process', id: 'Process:checkout' },
            to: { type: 'cluster', id: 'Cluster:billing' },
          },
        }),
      ],
      {
        topK: 5,
        maxDepth: 1,
        allowedIdentityTypes: ['process', 'cluster'],
        snapshot,
      },
    );

    expect(result.relatedSymbols).toEqual([]);
    expect(result.relatedFiles).toEqual([]);
    expect(result.relatedIdentities.map((identity) => `${identity.type}:${identity.id}`)).toEqual([
      'process:Process:checkout',
      'cluster:Cluster:billing',
    ]);
  });

  it('rejects stale candidate records with visible degraded metadata', () => {
    const result = expandPassiveGraph(
      [],
      [candidate({ record: record({ sourceCommitHash: 'old-commit' }) })],
      {
        topK: 5,
        maxDepth: 1,
        allowedIdentityTypes: ['symbol', 'file'],
        snapshot,
      },
    );

    expect(result.relatedFacts).toEqual([]);
    expect(result.relatedSymbols).toEqual([]);
    expect(result.skipped).toEqual([
      { factKey: 'fact-1', reason: 'stale-enrichment', detail: 'commit-mismatch' },
    ]);
    expect(result.summary).toMatchObject({
      candidateCount: 1,
      expandedFactCount: 0,
      degraded: true,
      degradedReasons: { 'stale-enrichment': 1 },
    });
  });

  it('skips passive expansion when the primary index is incomplete', () => {
    const result = expandPassiveGraph([], [candidate()], {
      topK: 5,
      maxDepth: 1,
      allowedIdentityTypes: ['symbol', 'file'],
      snapshot,
      indexComplete: false,
      incompleteIndexReason: 'partial-analysis',
    });

    expect(result.relatedFacts).toEqual([]);
    expect(result.relatedSymbols).toEqual([]);
    expect(result.relatedFiles).toEqual([]);
    expect(result.skipped).toEqual([
      { factKey: 'fact-1', reason: 'incomplete-index', detail: 'partial-analysis' },
    ]);
  });
});
