import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  runMarkdownDocumentPpr,
  type MarkdownDocumentPprEdge,
  type MarkdownDocumentPprNode,
} from '../../src/core/ingestion/enrichment/markdown-document-ppr.js';

const fixture = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../fixtures/markdown-rag-retrieval/document-ppr.json', import.meta.url)),
    'utf8',
  ),
) as { nodes: MarkdownDocumentPprNode[]; edges: MarkdownDocumentPprEdge[] };

describe('markdown document PPR', () => {
  it('retrieves multi-hop document evidence deterministically', () => {
    const result = runMarkdownDocumentPpr(fixture.nodes, fixture.edges, {
      seedIds: ['chunk:checkout-overview'],
      allowedNodeTypes: ['chunk', 'entity', 'mention'],
      topK: 5,
      maxHops: 3,
      maxVisitedNodes: 10,
      restartProbability: 0.2,
    });

    expect(result.rankedIds.map((item) => item.id)).toContain('chunk:payment-handshake');
    expect(result.rankedIds.map((item) => item.id)).toContain('entity:payment-flow');
    expect(result.explanation.retrievers).toEqual([
      expect.objectContaining({
        name: 'markdown-passive-graph',
        seedIds: ['chunk:checkout-overview'],
        traversedNodeTypes: ['chunk', 'entity', 'mention'],
        restartProbability: 0.2,
        visitedCount: 4,
      }),
    ]);
  });

  it('reports cap degradation when max visited nodes is hit', () => {
    const result = runMarkdownDocumentPpr(fixture.nodes, fixture.edges, {
      seedIds: ['chunk:checkout-overview'],
      allowedNodeTypes: ['chunk', 'entity', 'mention'],
      topK: 5,
      maxHops: 3,
      maxVisitedNodes: 2,
      restartProbability: 0.2,
    });

    expect(result.summary.degraded).toBe(true);
    expect(result.summary.degradedReasons).toMatchObject({ 'max-visited-nodes-exceeded': 1 });
    expect(result.rankedIds.map((item) => item.id)).not.toContain('chunk:payment-handshake');
  });

  it('skips stale facts with visible metadata', () => {
    const result = runMarkdownDocumentPpr(fixture.nodes, fixture.edges, {
      seedIds: ['chunk:payment-handshake'],
      allowedNodeTypes: ['chunk', 'entity', 'mention'],
      topK: 5,
      maxHops: 1,
      maxVisitedNodes: 10,
      restartProbability: 0.2,
    });

    expect(result.rankedIds.map((item) => item.id)).not.toContain('chunk:stale');
    expect(result.skipped).toContainEqual({ id: 'chunk:stale', reason: 'stale-fact' });
    expect(result.summary.degradedReasons).toMatchObject({ 'stale-fact': 1 });
  });

  it('does not traverse code graph authority edges', () => {
    const result = runMarkdownDocumentPpr(fixture.nodes, fixture.edges, {
      seedIds: ['mention:createInvoice'],
      allowedNodeTypes: ['chunk', 'entity', 'mention'],
      topK: 5,
      maxHops: 2,
      maxVisitedNodes: 10,
      restartProbability: 0.2,
    });

    expect(result.rankedIds.map((item) => item.id)).not.toContain('code:Function:createInvoice');
    expect(result.skipped).toContainEqual({
      id: 'code:Function:createInvoice',
      edgeType: 'impact',
      reason: 'edge-type-not-allowed',
    });
  });
});
