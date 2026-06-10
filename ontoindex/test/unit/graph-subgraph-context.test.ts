import { describe, expect, it } from 'vitest';
import { buildGraphSchemaManifest, buildSubgraphContext } from '../../src/core/graph/subgraph-context.js';

describe('graph schema manifest builder', () => {
  it('sorts labels, edge types, and properties deterministically', () => {
    const manifest = buildGraphSchemaManifest({
      nodeLabels: [
        { id: 'Function', properties: ['path', 'name', 'path'] },
        { id: 'Class', properties: ['file', 'name'] },
        { id: 'Type', properties: ['kind', 'name'] },
        { id: 'Function', properties: ['ignored', 'duplicate'] },
      ],
      edgeTypes: [
        {
          id: 'CALLS',
          sourceLabel: 'Function',
          targetLabel: 'Function',
          properties: ['weight'],
        },
        {
          id: 'BELONGS_TO',
          sourceLabel: 'Class',
          targetLabel: 'Type',
          properties: ['confidence'],
        },
        {
          id: 'DEPENDS_ON',
          sourceLabel: 'Type',
          targetLabel: 'Function',
          properties: ['strength'],
        },
        {
          id: 'BELONGS_TO',
          sourceLabel: 'Type',
          targetLabel: 'Function',
          properties: ['duplicate'],
        },
      ],
    });

    expect(manifest.nodeLabels.map((label) => label.id)).toEqual(['Class', 'Function', 'Type']);
    expect(manifest.nodeLabels[0].properties).toEqual(['file', 'name']);
    expect(manifest.nodeLabels[1].properties).toEqual(['name', 'path']);
    expect(manifest.edgeTypes.map((edgeType) => edgeType.id)).toEqual([
      'BELONGS_TO',
      'CALLS',
      'DEPENDS_ON',
    ]);
    expect(manifest.renderedShape.split('\n')).toEqual([
      'Class {file,name} -BELONGS_TO-> Type',
      'Function {name,path} -CALLS-> Function',
      'Type {kind,name} -DEPENDS_ON-> Function',
    ]);
    expect(manifest.warnings).toEqual([
      'Duplicate node label id "Function" was skipped.',
      'Duplicate edge type id "BELONGS_TO" was skipped.',
    ]);
  });
});

describe('subgraph context builder', () => {
  it('renders shape/triples and compact json with stable ordering', () => {
    const report = buildSubgraphContext({
      schema: {
        nodeLabels: [
          { id: 'Function', properties: ['name', 'path'] },
          { id: 'Class', properties: ['name'] },
        ],
        edgeTypes: [
          { id: 'CALLS', sourceLabel: 'Function', targetLabel: 'Function', properties: ['weight'] },
          { id: 'IMPLEMENTS', sourceLabel: 'Class', targetLabel: 'Function', properties: ['path'] },
        ],
      },
      nodes: [
        {
          id: 'n2',
          label: 'Function',
          sourceId: 'node-two',
          properties: { name: 'b', path: '/b.ts', size: 2 },
        },
        {
          id: 'n1',
          label: 'Function',
          sourceId: 'node-one',
          properties: { name: 'a', path: '/a.ts', size: 1 },
        },
        {
          id: 'n3',
          label: 'Class',
          sourceId: 'node-three',
          properties: { name: 'C', path: '/c.ts', size: 3 },
        },
      ],
      edges: [
        {
          id: 'e2',
          type: 'CALLS',
          fromNodeId: 'n2',
          toNodeId: 'n1',
          sourceId: 'edge-two',
          properties: { confidence: 1 },
        },
        {
          id: 'e1',
          type: 'IMPLEMENTS',
          fromNodeId: 'n3',
          toNodeId: 'n2',
          sourceId: 'edge-one',
          properties: { confidence: 2 },
        },
      ],
    });

    expect(report.manifest.renderedShape).toBe(
      [
        'Function {name,path} -CALLS-> Function',
        'Class {name} -IMPLEMENTS-> Function',
      ].join('\n'),
    );
    expect(report.rendered.triples).toBe(
      [
        'Class:n3 IMPLEMENTS Function:n2',
        'Function:n2 CALLS Function:n1',
      ].join('\n'),
    );

    const compact = JSON.parse(report.rendered['compact-json'] ?? '{}');
    expect(compact.n[0][0]).toBe('n1');
    expect(compact.e[0][0]).toBe('e1');
    expect(compact.c.e.edges).toBe(2);
    expect(compact.w).toEqual([]);
  });

  it('tracks truncation for nodes, edges, properties, and text length', () => {
    const report = buildSubgraphContext({
      schema: {
        nodeLabels: [{ id: 'Function', properties: ['name', 'path'] }],
        edgeTypes: [
          {
            id: 'CALLS',
            sourceLabel: 'Function',
            targetLabel: 'Function',
            properties: ['weight'],
          },
        ],
      },
      nodes: [
        { id: 'n3', label: 'Function', sourceId: 'node-3', properties: { a: 1, b: 2, c: 3, d: 4 } },
        { id: 'n1', label: 'Function', sourceId: 'node-1', properties: { a: 1, b: 2 } },
        { id: 'n2', label: 'Function', sourceId: 'node-2', properties: { a: 1, b: 2, c: 3 } },
      ],
      edges: [
        {
          id: 'e3',
          type: 'CALLS',
          fromNodeId: 'n3',
          toNodeId: 'n1',
          sourceId: 'edge-3',
          properties: { p: 1, q: 2, r: 3, s: 4 },
        },
        {
          id: 'e1',
          type: 'CALLS',
          fromNodeId: 'n2',
          toNodeId: 'n1',
          sourceId: 'edge-1',
          properties: { p: 1 },
        },
      ],
      limits: {
        maxNodes: 2,
        maxEdges: 1,
        maxProperties: 3,
        maxTextLength: 40,
      },
      formats: ['shape', 'triples', 'compact-json'] as const,
    });

    expect(report.observed.nodes).toBe(3);
    expect(report.observed.edges).toBe(2);
    expect(report.observed.properties).toBe(14);
    expect(report.observed.textLength).toBeGreaterThan(40);
    expect(report.emitted.nodes).toBe(2);
    expect(report.emitted.edges).toBe(1);
    expect(report.emitted.properties).toBe(3);
    expect(report.truncated).toEqual({
      nodes: true,
      edges: true,
      properties: true,
      textLength: true,
    });
    expect(report.rendered.shape).toBeDefined();
    expect(report.rendered.shape.length).toBeLessThanOrEqual(40);
    expect(report.rendered.triples).toBeDefined();
    expect(report.rendered.triples.length).toBeLessThanOrEqual(40);
    expect(report.rendered['compact-json']?.length).toBeLessThanOrEqual(40);
  });

  it('returns an empty-safe shape on empty input', () => {
    const report = buildSubgraphContext({
      schema: { nodeLabels: [], edgeTypes: [] },
      nodes: [],
      edges: [],
    });
    const textLength = [report.rendered.shape, report.rendered.triples, report.rendered['compact-json']]
      .map((entry) => entry?.length ?? 0)
      .reduce((acc, current) => acc + current, 0);

    expect(report.observed).toEqual({ nodes: 0, edges: 0, properties: 0, textLength });
    expect(report.emitted).toEqual({ nodes: 0, edges: 0, properties: 0, textLength });
    expect(report.truncated).toEqual({
      nodes: false,
      edges: false,
      properties: false,
      textLength: false,
    });
    expect(report.rendered.shape).toBe('');
    expect(report.rendered.triples).toBe('');
    expect(report.observed.textLength).toBe(textLength);
    expect(report.emitted.textLength).toBe(textLength);
    expect(report.rendered['compact-json']).toContain('"v":1');
  });

  it('warns for duplicate node ids and dangling edges and retains source ids', () => {
    const report = buildSubgraphContext({
      schema: {
        nodeLabels: [{ id: 'Function', properties: ['name', 'path'] }],
        edgeTypes: [
          {
            id: 'CALLS',
            sourceLabel: 'Function',
            targetLabel: 'Function',
            properties: [],
          },
        ],
      },
      nodes: [
        { id: 'n1', label: 'Function', sourceId: 'node-a', properties: { name: 'first' } },
        { id: 'n1', label: 'Function', sourceId: 'node-dup', properties: { name: 'duplicate' } },
      ],
      edges: [
        {
          id: 'e1',
          type: 'CALLS',
          fromNodeId: 'n1',
          toNodeId: 'missing',
          sourceId: 'edge-a',
          properties: { confidence: 1 },
        },
      ],
    });

    const warningsText = report.warnings.join('\n');
    expect(warningsText).toContain('Duplicate node id "n1" was skipped.');
    expect(warningsText).toContain('Dangling edge e1');

    const compact = JSON.parse(report.rendered['compact-json'] ?? '{}');
    expect(compact.n[0][0]).toBe('n1');
    expect(compact.n[0][3]).toBe('node-a');
    expect(compact.e[0][0]).toBe('e1');
    expect(compact.e[0][5]).toBe('edge-a');
    expect(compact.c.o.edges).toBe(0);
    expect(compact.c.o.nodes).toBe(0);
  });

  it('preserves unsupported property values without dropping keys', () => {
    const circular: Record<string, unknown> = { name: 'cycle' };
    circular.self = circular;

    const report = buildSubgraphContext({
      schema: { nodeLabels: [{ id: 'Function', properties: ['path', 'name'] }], edgeTypes: [] },
      nodes: [
        {
          id: 'n1',
          label: 'Function',
          sourceId: 'node-1',
          properties: {
            undef: undefined,
            fn: () => 42,
            sym: Symbol('node'),
            cyc: circular,
          } as Record<string, unknown>,
        },
      ],
      edges: [],
    });

    const compact = JSON.parse(report.rendered['compact-json'] ?? '{}');
    const nodeProperties = compact.n[0][2];

    expect(compact.n[0][0]).toBe('n1');
    expect(compact.n[0][1]).toBe('Function');
    expect(report.observed.properties).toBe(4);
    expect(report.emitted.properties).toBe(4);
    expect(Object.keys(nodeProperties).sort()).toEqual(['cyc', 'fn', 'sym', 'undef']);
    expect(nodeProperties.undef).toBeNull();
    expect(typeof nodeProperties.fn).toBe('string');
    expect(typeof nodeProperties.sym).toBe('string');
    expect(typeof nodeProperties.cyc).toBe('string');
  });
});
