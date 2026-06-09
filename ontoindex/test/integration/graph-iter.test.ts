/**
 * Integration Test: Graph Iteration
 *
 * Verifies that iterNodes/iterRelationships and forEach helpers expose the
 * graph's in-memory nodes and relationships.
 */
import { describe, it, expect } from 'vitest';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';

describe('Graph Iteration', () => {
  it('iterates over in-memory nodes', async () => {
    const graph = createKnowledgeGraph();

    graph.addNode({
      id: 'Node:1',
      label: 'Function',
      domain: 'code',
      properties: { name: 'node1', filePath: 'src/one.ts' },
    });
    graph.addNode({
      id: 'Node:2',
      label: 'Function',
      domain: 'code',
      properties: { name: 'node2', filePath: 'src/two.ts' },
    });

    const nodes = Array.from(graph.iterNodes());
    expect(nodes.length).toBe(2);

    const ids = nodes.map((n) => n.id);
    expect(ids).toContain('Node:1');
    expect(ids).toContain('Node:2');

    const seenIds: string[] = [];
    graph.forEachNode((n) => seenIds.push(n.id));
    expect(seenIds.length).toBe(2);
    expect(seenIds).toContain('Node:1');
    expect(seenIds).toContain('Node:2');
  });

  it('iterates over in-memory relationships', async () => {
    const graph = createKnowledgeGraph();

    graph.addNode({ id: 'n1', label: 'File', properties: { name: 'n1', filePath: 'n1' } });
    graph.addNode({ id: 'n2', label: 'File', properties: { name: 'n2', filePath: 'n2' } });

    graph.addRelationship({
      id: 'rel:one',
      sourceId: 'n1',
      targetId: 'n2',
      type: 'CALLS',
      confidence: 1.0,
      reason: '',
    });
    graph.addRelationship({
      id: 'rel:two',
      sourceId: 'n2',
      targetId: 'n1',
      type: 'CALLS',
      confidence: 1.0,
      reason: '',
    });

    const rels = Array.from(graph.iterRelationships());
    expect(rels.length).toBe(2);

    const ids = rels.map((r) => r.id);
    expect(ids).toContain('rel:one');
    expect(ids).toContain('rel:two');
  });
});
