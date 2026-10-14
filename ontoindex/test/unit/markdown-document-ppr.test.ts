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

  it('GR28-A: bounds skipped previews without truncating degradation counts', () => {
    const skippedNodes: MarkdownDocumentPprNode[] = Array.from({ length: 8 }, (_, index) => ({
      id: `chunk:${index}`,
      type: 'chunk',
    }));
    const nodes: MarkdownDocumentPprNode[] = [
      { id: 'chunk:seed', type: 'chunk' },
      ...skippedNodes,
      { id: 'chunk:stale', type: 'chunk', stale: true },
    ];
    const edges = nodes.slice(1).map((node) => ({
      from: 'chunk:seed',
      to: node.id,
      type: 'contains',
    }));
    const options = {
      seedIds: ['chunk:seed'],
      allowedNodeTypes: ['chunk'] as const,
      topK: 5,
      maxHops: 1,
      maxVisitedNodes: 1,
      restartProbability: 0.2,
    };
    const result = runMarkdownDocumentPpr(nodes, edges, options);
    const expectedPreview = skippedNodes.slice(0, 5).map((node) => ({
      id: node.id,
      edgeType: 'contains',
      reason: 'max-visited-nodes-exceeded',
    }));

    expect(result.skipped).toHaveLength(5);
    expect(result.skipped).toEqual(expectedPreview);
    expect(result.summary.skippedTotal).toBe(9);
    expect(result.summary.degraded).toBe(true);
    expect(result.summary.degradedReasons).toEqual({
      'max-visited-nodes-exceeded': 8,
      'stale-fact': 1,
    });
    expect(result.explanation.retrievers[0].skipped).toEqual(expectedPreview);
    expect(result.explanation.retrievers[0].seedIds).toEqual(['chunk:seed']);
    expect(runMarkdownDocumentPpr([...nodes].reverse(), [...edges].reverse(), options)).toEqual(
      result,
    );
  });

  it.each([0, 3, 5])('GR28-B: returns all %i skipped nodes within the preview limit', (count) => {
    const skippedNodes: MarkdownDocumentPprNode[] = Array.from({ length: count }, (_, index) => ({
      id: `chunk:${index}`,
      type: 'chunk',
    }));
    const result = runMarkdownDocumentPpr(
      [{ id: 'chunk:seed', type: 'chunk' }, ...skippedNodes],
      skippedNodes.map((node) => ({ from: 'chunk:seed', to: node.id, type: 'contains' })),
      {
        seedIds: ['chunk:seed'],
        allowedNodeTypes: ['chunk'],
        topK: 5,
        maxHops: 1,
        maxVisitedNodes: 1,
        restartProbability: 0.2,
      },
    );
    const expectedSkipped = skippedNodes.map((node) => ({
      id: node.id,
      edgeType: 'contains',
      reason: 'max-visited-nodes-exceeded',
    }));

    expect(result.skipped).toEqual(expectedSkipped);
    expect(result.summary.skippedTotal).toBe(result.skipped.length);
    expect(result.summary.degraded).toBe(count > 0);
    expect(result.summary.degradedReasons).toEqual(
      count > 0 ? { 'max-visited-nodes-exceeded': count } : {},
    );
    expect(result.explanation.retrievers[0].skipped).toEqual(expectedSkipped);
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
