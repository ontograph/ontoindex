import { describe, expect, it } from 'vitest';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import { reconstructScopeRetentionParse } from '../../src/core/ingestion/pipeline-phases/parse-replay.js';
import type { ScopeRetentionCandidateFamilies } from '../../src/core/ingestion/pipeline-phases/scope-retention-candidate-reader.js';
import type { SemanticModelRegistrationEvent } from '../../src/core/ingestion/model/semantic-model.js';

function fixture(): ScopeRetentionCandidateFamilies {
  const filePath = 'src/example.ts';
  const declarations = [
    { name: 'caller', type: 'Function', nodeId: `Function:${filePath}:caller` },
    { name: 'target', type: 'Function', nodeId: `Function:${filePath}:target` },
    { name: 'User', type: 'Class', nodeId: `Class:${filePath}:User` },
    {
      name: 'address',
      type: 'Property',
      nodeId: `Property:${filePath}:User.address`,
      metadata: { ownerId: `Class:${filePath}:User` },
    },
  ] as const;
  return {
    parsedFiles: [],
    calls: [{ filePath, sourceId: declarations[0].nodeId, calledName: 'target', callForm: 'free' }],
    assignments: [
      {
        filePath,
        sourceId: declarations[0].nodeId,
        receiverText: 'user',
        receiverTypeName: 'User',
        propertyName: 'address',
      },
    ],
    heritage: [],
    constructors: [],
    fileBindings: [{ filePath, varName: 'user', typeName: 'User' }],
    exportedTypes: [{ filePath, exportName: 'user', typeName: 'User' }],
    events: declarations.map((declaration) => ({ kind: 'symbol.add', filePath, ...declaration })),
    importStates: [
      { version: 1, importMap: [], packageMap: [], namedImportMap: [], moduleAliasMap: [] },
    ],
    declarationNodes: declarations.map(({ nodeId, name, type }) => ({
      id: nodeId,
      label: type,
      properties: { name, filePath },
    })),
    structuralRelationships: [],
    fetchCalls: [],
    routes: [],
    decoratorRoutes: [],
    toolDefinitions: [],
    ormQueries: [],
  };
}

function snapshot(graph: ReturnType<typeof createKnowledgeGraph>) {
  return structuredClone({ nodes: graph.nodes, relationships: graph.relationships });
}

describe('retained parse reconstruction', () => {
  it('reruns calls and writes and returns live parse owners and extraction arrays', async () => {
    const families = fixture();
    // Scope DefIds use a different identity space from legacy graph node IDs.
    families.parsedFiles.push({
      filePath: 'src/example.ts',
      moduleScope: 'module:scope-id',
      parsedImports: [],
      localDefs: [],
      referenceSites: [],
      scopes: [],
    });
    families.fileBindings.push({ ...families.fileBindings[0]! });
    families.exportedTypes.push({ ...families.exportedTypes[0]! });
    const graph = createKnowledgeGraph();
    const result = await reconstructScopeRetentionParse(families, graph);
    try {
      expect(graph.relationships).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'CALLS',
            sourceId: families.calls[0]!.sourceId,
            targetId: 'Function:src/example.ts:target',
          }),
          expect.objectContaining({
            type: 'ACCESSES',
            reason: 'write',
            targetId: 'Property:src/example.ts:User.address',
          }),
        ]),
      );
      expect(result.resolutionContext.resolve('target', 'src/example.ts')?.candidates).toHaveLength(
        1,
      );
      expect(result.bindingAccumulator.fileScopeGet('src/example.ts', 'user')).toBe('User');
      expect(result.exportedTypeMap.get('src/example.ts')?.get('user')).toBe('User');
      expect(result.usedWorkerPool).toBe(false);
      expect(result.allFetchCalls).toBe(families.fetchCalls);
      expect(result.allExtractedRoutes).toBe(families.routes);
      expect(result.allDecoratorRoutes).toBe(families.decoratorRoutes);
      expect(result.allToolDefs).toBe(families.toolDefinitions);
      expect(result.allORMQueries).toBe(families.ormQueries);
    } finally {
      result.resolutionContext.clear();
      result.bindingAccumulator.dispose();
    }
  });

  const invalidCases: [string, (families: ScopeRetentionCandidateFamilies) => void][] = [
    [
      'missing import state',
      (families) => {
        families.importStates.length = 0;
      },
    ],
    [
      'multiple import states',
      (families) => {
        families.importStates.push(families.importStates[0]!);
      },
    ],
    [
      'malformed import state',
      (families) => {
        families.importStates[0]!.version = 2 as 1;
      },
    ],
    [
      'dangling relationship',
      (families) => {
        families.structuralRelationships.push({
          id: 'edge',
          sourceId: families.calls[0]!.sourceId,
          targetId: 'missing',
          type: 'CONTAINS',
          confidence: 1,
          reason: '',
        });
      },
    ],
    [
      'missing call source',
      (families) => {
        families.calls[0]!.sourceId = 'missing';
      },
    ],
    [
      'missing write source',
      (families) => {
        families.assignments[0]!.sourceId = 'missing';
      },
    ],
    [
      'conflicting file binding',
      (families) => {
        families.fileBindings.push({ ...families.fileBindings[0]!, typeName: 'Other' });
      },
    ],
    [
      'conflicting exported type',
      (families) => {
        families.exportedTypes.push({ ...families.exportedTypes[0]!, typeName: 'Other' });
      },
    ],
    [
      'conflicting retained node',
      (families) => {
        families.declarationNodes.push({
          ...families.declarationNodes[0]!,
          properties: { name: 'Other' },
        });
      },
    ],
  ];
  it.each(invalidCases)('rejects %s without changing the upstream graph', async (_name, mutate) => {
    const families = fixture();
    mutate(families);
    const graph = createKnowledgeGraph();
    graph.addNode({
      id: 'File:upstream.ts',
      label: 'File',
      properties: { name: 'upstream.ts', filePath: 'upstream.ts' },
    });
    const before = snapshot(graph);
    await expect(reconstructScopeRetentionParse(families, graph)).rejects.toThrow();
    expect(snapshot(graph)).toEqual(before);
  });

  it('rejects an incompatible upstream node instead of silently keeping it', async () => {
    const families = fixture();
    const graph = createKnowledgeGraph();
    graph.addNode({ ...families.declarationNodes[0]!, properties: { name: 'different' } });
    const before = snapshot(graph);
    await expect(reconstructScopeRetentionParse(families, graph)).rejects.toThrow(
      'conflicting graph node',
    );
    expect(snapshot(graph)).toEqual(before);
  });

  const invalidRegistrations: [string, (families: ScopeRetentionCandidateFamilies) => void][] = [
    [
      'target redirected to caller',
      (families) => {
        const event = families.events[1]!;
        if (event.kind === 'symbol.add') event.nodeId = families.calls[0]!.sourceId;
      },
    ],
    [
      'missing symbol node',
      (families) => {
        const event = families.events[1]!;
        if (event.kind === 'symbol.add') event.nodeId = 'private-missing-id';
      },
    ],
    [
      'wrong symbol name',
      (families) => {
        const event = families.events[1]!;
        if (event.kind === 'symbol.add') event.name = 'private-wrong-name';
      },
    ],
    [
      'wrong symbol label',
      (families) => {
        const event = families.events[1]!;
        if (event.kind === 'symbol.add') event.type = 'Class';
      },
    ],
    [
      'wrong symbol file',
      (families) => {
        const event = families.events[1]!;
        if (event.kind === 'symbol.add') event.filePath = 'private-wrong-file.ts';
      },
    ],
  ];
  it.each(invalidRegistrations)(
    'rejects %s before publishing resolved edges',
    async (_name, mutate) => {
      const families = fixture();
      mutate(families);
      const graph = createKnowledgeGraph();
      graph.addNode({
        id: 'File:upstream.ts',
        label: 'File',
        properties: { name: 'upstream.ts', filePath: 'upstream.ts' },
      });
      const before = snapshot(graph);
      await expect(reconstructScopeRetentionParse(families, graph)).rejects.toThrow(
        new Error('scope-retention-parse-replay: registration does not match graph declaration'),
      );
      expect(snapshot(graph)).toEqual(before);
    },
  );

  const directKinds = [
    'type.registerClass',
    'type.registerImpl',
    'method.register',
    'field.register',
  ] as const;
  function directRegistration(kind: (typeof directKinds)[number]): SemanticModelRegistrationEvent {
    const def = {
      nodeId: 'Function:src/example.ts:target',
      type: 'Function' as const,
      filePath: 'src/example.ts',
    };
    if (kind === 'type.registerClass')
      return { kind, name: 'alias', qualifiedName: 'Namespace.alias', def };
    if (kind === 'type.registerImpl') return { kind, name: 'alias', def };
    return { kind, name: 'alias', ownerNodeId: 'unavailable-owner', def };
  }

  describe.each(directKinds)('%s graph correspondence', (kind) => {
    it.each(['missing', 'label', 'file'] as const)(
      'rejects a mismatched %s without publishing',
      async (mismatch) => {
        const families = fixture();
        const event = directRegistration(kind);
        if (!('def' in event)) throw new Error('expected direct registration');
        if (mismatch === 'missing') event.def.nodeId = 'private-missing-id';
        if (mismatch === 'label') event.def.type = 'Class';
        if (mismatch === 'file') event.def.filePath = 'private-wrong-file.ts';
        families.events.push(event);
        const graph = createKnowledgeGraph();
        graph.addNode(families.declarationNodes[0]!);
        const before = snapshot(graph);
        await expect(reconstructScopeRetentionParse(families, graph)).rejects.toThrow(
          new Error('scope-retention-parse-replay: registration does not match graph declaration'),
        );
        expect(snapshot(graph)).toEqual(before);
      },
    );

    it('accepts lookup aliases and upstream nodes without requiring an owner node', async () => {
      const families = fixture();
      families.events.push(directRegistration(kind));
      const graph = createKnowledgeGraph();
      const [target] = families.declarationNodes.splice(1, 1);
      graph.addNode(target!);
      const result = await reconstructScopeRetentionParse(families, graph);
      try {
        const model = result.resolutionContext.model;
        if (kind === 'type.registerClass')
          expect(model.types.lookupClassByQualifiedName('Namespace.alias')[0]?.nodeId).toBe(
            target!.id,
          );
        if (kind === 'type.registerImpl')
          expect(model.types.lookupImplByName('alias')[0]?.nodeId).toBe(target!.id);
        if (kind === 'method.register')
          expect(model.methods.lookupMethodByOwner('unavailable-owner', 'alias')?.nodeId).toBe(
            target!.id,
          );
        if (kind === 'field.register')
          expect(model.fields.lookupFieldByOwner('unavailable-owner', 'alias')?.nodeId).toBe(
            target!.id,
          );
      } finally {
        result.resolutionContext.clear();
        result.bindingAccumulator.dispose();
      }
    });
  });

  it.each(['declarationFilePath', 'definitionFilePath'] as const)(
    'accepts C++ registrations through %s',
    async (pathProperty) => {
      const families = fixture();
      const event = families.events[1]!;
      if (event.kind !== 'symbol.add') throw new Error('expected symbol registration');
      event.filePath = 'include/example.hpp';
      families.declarationNodes[1]!.properties = {
        ...families.declarationNodes[1]!.properties,
        [pathProperty]: event.filePath,
      };
      for (const kind of directKinds) {
        const direct = directRegistration(kind);
        if ('def' in direct) direct.def.filePath = event.filePath;
        families.events.push(direct);
      }
      const result = await reconstructScopeRetentionParse(families, createKnowledgeGraph());
      try {
        expect(result.resolutionContext.resolve('target', event.filePath)?.candidates).toHaveLength(
          1,
        );
      } finally {
        result.resolutionContext.clear();
        result.bindingAccumulator.dispose();
      }
    },
  );

  it('preserves clear event ordering and Function-with-owner registration', async () => {
    const families = fixture();
    const target = families.events[1]!;
    if (target.kind !== 'symbol.add') throw new Error('expected symbol registration');
    families.events.push(
      { kind: 'type.clear' },
      { kind: 'method.clear' },
      { kind: 'field.clear' },
      { kind: 'model.clear' },
      { ...target, metadata: { ownerId: 'unavailable-owner' } },
    );
    families.assignments = [];
    const result = await reconstructScopeRetentionParse(families, createKnowledgeGraph());
    try {
      expect(result.resolutionContext.model.types.lookupClassByName('User')).toEqual([]);
      expect(
        result.resolutionContext.model.methods.lookupMethodByOwner('unavailable-owner', 'target'),
      ).toEqual(expect.objectContaining({ nodeId: target.nodeId, type: 'Function' }));
    } finally {
      result.resolutionContext.clear();
      result.bindingAccumulator.dispose();
    }
  });

  it('leaves the graph unchanged when resolution progress throws', async () => {
    const graph = createKnowledgeGraph();
    const before = snapshot(graph);
    await expect(
      reconstructScopeRetentionParse(fixture(), graph, () => {
        throw new Error('cancelled');
      }),
    ).rejects.toThrow('cancelled');
    expect(snapshot(graph)).toEqual(before);
  });

  it('accepts sources provided by upstream phases', async () => {
    const families = fixture();
    const source = families.declarationNodes.shift()!;
    const graph = createKnowledgeGraph();
    graph.addNode(source);
    const result = await reconstructScopeRetentionParse(families, graph);
    try {
      expect(
        graph.relationships.some((edge) => edge.type === 'CALLS' && edge.sourceId === source.id),
      ).toBe(true);
    } finally {
      result.resolutionContext.clear();
      result.bindingAccumulator.dispose();
    }
  });
});
