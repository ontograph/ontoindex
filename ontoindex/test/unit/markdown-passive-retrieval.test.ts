import { describe, expect, it } from 'vitest';

import {
  createEnrichmentRecord,
  type EnrichmentRecord,
  type EnrichmentSnapshot,
} from '../../src/core/ingestion/enrichment/enrichment-record.js';
import { selectMarkdownPassiveRetrieval } from '../../src/core/ingestion/enrichment/markdown-passive-retrieval.js';

const snapshot: EnrichmentSnapshot = {
  sourceIndexId: 'index-1',
  sourceCommitHash: 'commit-1',
  schemaVersion: 1,
  analyzerVersion: '1.0.0',
  filePath: 'docs/orders.md',
  fileHash: 'hash-doc',
};

const adrRetrievalFixture = {
  query: {
    docPath: 'docs/adr/0085-mcp-repo-resolution-without-env-harness.md',
    symbolId: 'Function:ontoindex/src/mcp/shared/target-context.ts:resolveTargetContext',
  },
  expectedAnchors: [
    'docs/adr/0085-mcp-repo-resolution-without-env-harness.md',
    'ontoindex/src/mcp/shared/target-context.ts',
  ],
} as const;

function record(overrides: Partial<EnrichmentRecord> = {}): EnrichmentRecord {
  return createEnrichmentRecord({
    sourceIndexId: 'index-1',
    sourceCommitHash: 'commit-1',
    schemaVersion: 1,
    analyzerId: 'markdown-sidecar',
    analyzerVersion: '1.0.0',
    filePath: 'docs/orders.md',
    fileHash: 'hash-doc',
    status: 'complete',
    confidence: 0.95,
    records: [
      {
        kind: 'markdown-chunk',
        chunkKey: 'chunk:checkout-overview',
        docPath: 'docs/orders.md',
        fileHash: 'hash-doc',
        headingPath: ['Orders', 'Checkout'],
        lineSpan: { start: 10, end: 18 },
        chunkIndex: 1,
        normalizedAnchor: 'orders-checkout',
        contentHash: 'content-1',
        excerpt: 'Checkout creates an invoice after payment authorization.',
      },
      {
        kind: 'markdown-code-mention',
        chunkKey: 'chunk:checkout-overview',
        target: {
          type: 'symbol',
          id: 'Function:src/billing/invoice.ts:createInvoice',
          filePath: 'src/billing/invoice.ts',
        },
        confidence: 0.88,
        resolutionStatus: 'resolved',
        evidence: { text: 'createInvoice', lineSpan: { start: 13, end: 13 } },
      },
    ],
    ...overrides,
  });
}

function adrRecord(): EnrichmentRecord {
  return createEnrichmentRecord({
    sourceIndexId: 'index-1',
    sourceCommitHash: 'commit-1',
    schemaVersion: 1,
    analyzerId: 'markdown-sidecar',
    analyzerVersion: '1.0.0',
    filePath: adrRetrievalFixture.query.docPath,
    fileHash: 'hash-adr',
    status: 'complete',
    confidence: 0.95,
    records: [
      {
        kind: 'markdown-chunk',
        chunkKey: 'chunk:mcp-repo-resolution',
        docPath: adrRetrievalFixture.query.docPath,
        fileHash: 'hash-adr',
        headingPath: ['ADR 0085', 'Repo resolution'],
        lineSpan: { start: 10, end: 18 },
        chunkIndex: 1,
        normalizedAnchor: 'mcp-repo-resolution',
        contentHash: 'content-adr',
        excerpt: 'Repo resolution stays inside the shared target context.',
      },
      {
        kind: 'markdown-code-mention',
        chunkKey: 'chunk:mcp-repo-resolution',
        target: {
          type: 'symbol',
          id: adrRetrievalFixture.query.symbolId,
          filePath: 'ontoindex/src/mcp/shared/target-context.ts',
        },
        confidence: 0.93,
        resolutionStatus: 'resolved',
        evidence: { text: 'target-context.ts', lineSpan: { start: 130, end: 130 } },
      },
    ],
  });
}

function adrSnapshot(): EnrichmentSnapshot {
  return {
    ...snapshot,
    filePath: adrRetrievalFixture.query.docPath,
    fileHash: 'hash-adr',
  };
}

describe('markdown passive retrieval', () => {
  it('returns related chunks and docs as metadata without reordering primary results', () => {
    const primaryResults = [
      { id: 'code-1', score: 1 },
      { id: 'code-2', score: 0.8 },
    ];

    const result = selectMarkdownPassiveRetrieval(
      primaryResults,
      [record()],
      { docPath: 'docs/orders.md' },
      { topK: 5, snapshotsByDocPath: { 'docs/orders.md': snapshot } },
    );

    expect(result.primaryResults).toBe(primaryResults);
    expect(result.relatedChunks).toEqual([
      expect.objectContaining({
        chunkKey: 'chunk:checkout-overview',
        docPath: 'docs/orders.md',
        headingPath: ['Orders', 'Checkout'],
        lineSpan: { start: 10, end: 18 },
        excerpt: 'Checkout creates an invoice after payment authorization.',
        explanation: { retriever: 'markdown-bm25', reasons: ['chunk-match'] },
      }),
    ]);
    expect(result.relatedDocs).toEqual([
      {
        docPath: 'docs/orders.md',
        fileHash: 'hash-doc',
        chunkCount: 1,
        score: 0.8,
        headingPaths: [['Orders', 'Checkout']],
      },
    ]);
  });

  it('keeps the ADR retrieval fixture anchors inside the bounded result set', () => {
    const result = selectMarkdownPassiveRetrieval([], [adrRecord()], adrRetrievalFixture.query, {
      topK: 3,
      snapshotsByDocPath: { [adrRetrievalFixture.query.docPath]: adrSnapshot() },
    });

    const anchors = collectRetrievalAnchors(result);

    expect(result.relatedChunks.length).toBeLessThanOrEqual(3);
    for (const expectedAnchor of adrRetrievalFixture.expectedAnchors) {
      expect(anchors.has(expectedAnchor)).toBe(true);
    }
  });

  it('selects chunks through code mentions and keeps mention state as metadata', () => {
    const result = selectMarkdownPassiveRetrieval(
      [],
      [record()],
      { symbolId: 'Function:src/billing/invoice.ts:createInvoice' },
      { topK: 5, snapshotsByDocPath: { 'docs/orders.md': snapshot } },
    );

    expect(result.relatedChunks).toEqual([
      expect.objectContaining({
        chunkKey: 'chunk:checkout-overview',
        lineSpan: { start: 10, end: 18 },
        excerpt: 'Checkout creates an invoice after payment authorization.',
        reasons: ['code-mention-match', 'resolved'],
        mentions: [
          {
            target: {
              type: 'symbol',
              id: 'Function:src/billing/invoice.ts:createInvoice',
              filePath: 'src/billing/invoice.ts',
            },
            confidence: 0.88,
            resolutionStatus: 'resolved',
            evidence: { text: 'createInvoice', lineSpan: { start: 13, end: 13 } },
          },
        ],
        explanation: {
          retriever: 'markdown-code-mentions',
          reasons: ['code-mention-match', 'resolved'],
        },
      }),
    ]);
    expect(result.explanation.retrievers).toEqual([
      {
        name: 'markdown-code-mentions',
        factCount: 1,
        chunkCount: 1,
        reasons: ['code-mention-match', 'resolved'],
      },
    ]);
  });

  it('reports stale markdown facts without returning chunks', () => {
    const result = selectMarkdownPassiveRetrieval(
      [],
      [record({ sourceCommitHash: 'old-commit' })],
      { docPath: 'docs/orders.md' },
      { topK: 5, snapshotsByDocPath: { 'docs/orders.md': snapshot } },
    );

    expect(result.relatedChunks).toEqual([]);
    expect(result.relatedDocs).toEqual([]);
    expect(result.summary.degraded).toBe(true);
    expect(result.summary.degradedReasons).toEqual({ 'stale-enrichment': 1 });
    expect(result.skipped).toEqual([{ reason: 'stale-enrichment', detail: 'commit-mismatch' }]);
  });

  it('does not treat unresolved or ambiguous mentions as code links', () => {
    const ambiguous = record({
      records: [
        {
          kind: 'markdown-code-mention',
          chunkKey: 'chunk:ambiguous',
          target: { type: 'symbol', id: 'Function:ambiguous' },
          confidence: 0.4,
          resolutionStatus: 'ambiguous',
          candidates: [{ type: 'symbol', id: 'Function:a', confidence: 0.4 }],
        },
      ],
    });

    const result = selectMarkdownPassiveRetrieval(
      [],
      [ambiguous],
      { symbolId: 'Function:a' },
      { topK: 5, snapshotsByDocPath: { 'docs/orders.md': snapshot } },
    );

    expect(result.relatedChunks).toEqual([]);
    expect(result.summary.candidateCount).toBe(0);
  });

  it('ignores unrelated non-markdown facts without degrading the markdown result', () => {
    const result = selectMarkdownPassiveRetrieval(
      [],
      [
        record({
          records: [
            {
              kind: 'semantic-bridge',
              subject: { type: 'symbol', id: 'Function:checkout' },
            },
            ...record().records,
          ],
        }),
      ],
      { docPath: 'docs/orders.md' },
      { topK: 5, snapshotsByDocPath: { 'docs/orders.md': snapshot } },
    );

    expect(result.relatedChunks).toHaveLength(1);
    expect(result.summary.degraded).toBe(false);
    expect(result.skipped).toEqual([]);
  });
});

function collectRetrievalAnchors(result: {
  relatedDocs: Array<{ docPath: string }>;
  relatedChunks: Array<{
    docPath: string;
    mentions: Array<{ target: unknown }>;
  }>;
}): Set<string> {
  const anchors = new Set<string>();
  for (const doc of result.relatedDocs) {
    anchors.add(doc.docPath);
  }
  for (const chunk of result.relatedChunks) {
    anchors.add(chunk.docPath);
    for (const mention of chunk.mentions) {
      if (typeof mention.target !== 'object' || mention.target === null) continue;
      const target = mention.target as { filePath?: unknown };
      if (typeof target.filePath === 'string') {
        anchors.add(target.filePath);
      }
    }
  }
  return anchors;
}
