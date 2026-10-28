import { describe, expect, it } from 'vitest';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import type { GraphRelationship } from 'ontoindex-shared';
import { reconstructScopeRetentionParse } from '../../src/core/ingestion/pipeline-phases/parse-replay.js';
import type { ScopeRetentionCandidateFamilies } from '../../src/core/ingestion/pipeline-phases/scope-retention-candidate-reader.js';

const sourceId = 'Class:src/scope-tree.ts:ScopeTreeInvariantError';

function fixture(): ScopeRetentionCandidateFamilies {
  return {
    parsedFiles: [],
    calls: [],
    assignments: [],
    heritage: [],
    constructors: [],
    fileBindings: [],
    exportedTypes: [],
    events: [],
    importStates: [
      { version: 1, importMap: [], packageMap: [], namedImportMap: [], moduleAliasMap: [] },
    ],
    declarationNodes: [
      {
        id: sourceId,
        label: 'Class',
        properties: {
          name: 'ScopeTreeInvariantError',
          filePath: 'src/scope-tree.ts',
        },
      },
    ],
    structuralRelationships: [],
    fetchCalls: [],
    routes: [],
    decoratorRoutes: [],
    toolDefinitions: [],
    ormQueries: [],
  };
}

function edge(
  type: GraphRelationship['type'],
  targetId = 'Class:Error',
  source = sourceId,
): GraphRelationship {
  return {
    id: `${type}:${source}->${targetId}`,
    sourceId: source,
    targetId,
    type,
    confidence: 0.5,
    reason: '',
  };
}

describe.each(['retained', 'upstream'] as const)('%s unresolved heritage endpoints', (origin) => {
  it.each([
    ['EXTENDS', 'Class:Error'],
    ['IMPLEMENTS', 'Interface:Disposable'],
    ['IMPLEMENTS', 'Trait:Debug'],
    ['EXTENDS', 'Class:Échec'],
  ] as const)('preserves %s to %s without synthesizing a node', async (type, targetId) => {
    const families = fixture();
    const graph = createKnowledgeGraph();
    const relationship = edge(type, targetId);
    if (origin === 'retained') families.structuralRelationships.push(relationship);
    else graph.addRelationship(relationship);
    const result = await reconstructScopeRetentionParse(families, graph);
    try {
      expect(graph.nodes).toEqual(families.declarationNodes);
      expect(graph.relationships).toEqual([relationship]);
      expect(graph.getNode(targetId)).toBeUndefined();
    } finally {
      result.resolutionContext.clear();
      result.bindingAccumulator.dispose();
    }
  });

  it.each([
    edge('DEFINES'),
    edge('CALLS'),
    edge('ACCESSES'),
    edge('EXTENDS', 'Class:Error', 'Class:missing.ts:Missing'),
    edge('IMPLEMENTS', 'Interface:Disposable', 'Class:missing.ts:Missing'),
    edge('EXTENDS', 'Class:src/external.ts:Error'),
    edge('EXTENDS', 'Class:external.ts'),
    edge('EXTENDS', 'Class:dir/Error'),
    edge('EXTENDS', 'Class:dir\\Error'),
    edge('EXTENDS', 'Class:'),
    edge('EXTENDS', 'Function:Error'),
    edge('EXTENDS', 'Class:Error\n'),
  ])('rejects $id transactionally', async (relationship) => {
    const families = fixture();
    const graph = createKnowledgeGraph();
    graph.addNode({
      id: 'File:upstream.ts',
      label: 'File',
      properties: { name: 'upstream.ts', filePath: 'upstream.ts' },
    });
    if (origin === 'retained') families.structuralRelationships.push(relationship);
    else graph.addRelationship(relationship);
    const before = structuredClone({ nodes: graph.nodes, relationships: graph.relationships });
    await expect(reconstructScopeRetentionParse(families, graph)).rejects.toThrow(
      new Error(
        `scope-retention-parse-replay: dangling ${origin === 'retained' ? 'structural' : 'resolved'} relationship: ${relationship.id}`,
      ),
    );
    expect({ nodes: graph.nodes, relationships: graph.relationships }).toEqual(before);
  });
});
