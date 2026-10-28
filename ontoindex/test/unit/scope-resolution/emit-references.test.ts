/**
 * Unit tests for `emit-references` (RFC #909 Ring 2 PKG #925).
 *
 * Covers kind → RelationshipType mapping, enclosing-def resolution
 * through the scope tree, evidence serialization onto emitted edges,
 * skip counts, and the optional `INGESTION_EMIT_SCOPES` scope-node
 * flush.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  buildDefIndex,
  buildMethodDispatchIndex,
  buildModuleScopeIndex,
  buildQualifiedNameIndex,
  buildScopeTree,
  type BindingRef,
  type DefId,
  type ImportEdge,
  type Range,
  type Reference,
  type ReferenceIndex,
  type Scope,
  type ScopeId,
  type SymbolDefinition,
} from 'ontoindex-shared';
import { createKnowledgeGraph } from '../../../src/core/graph/graph.js';
import {
  emitReferencesToGraph,
  emitScopeGraph,
} from '../../../src/core/ingestion/emit-references.js';
import type { ScopeResolutionIndexes } from '../../../src/core/ingestion/model/scope-resolution-indexes.js';

// ─── Env isolation ────────────────────────────────────────────────────────

let savedEnv: string | undefined;
beforeEach(() => {
  savedEnv = process.env['INGESTION_EMIT_SCOPES'];
  delete process.env['INGESTION_EMIT_SCOPES'];
});
afterEach(() => {
  if (savedEnv === undefined) delete process.env['INGESTION_EMIT_SCOPES'];
  else process.env['INGESTION_EMIT_SCOPES'] = savedEnv;
});

// ─── Fixture builders ─────────────────────────────────────────────────────

const range = (sl = 1, sc = 0, el = 100, ec = 0): Range => ({
  startLine: sl,
  startCol: sc,
  endLine: el,
  endCol: ec,
});

const def = (
  nodeId: string,
  type: SymbolDefinition['type'] = 'Method',
  qname?: string,
): SymbolDefinition => ({
  nodeId,
  filePath: 'x.ts',
  type,
  ...(qname !== undefined ? { qualifiedName: qname } : {}),
});

const scope = (
  id: ScopeId,
  parent: ScopeId | null,
  kind: Scope['kind'],
  ownedDefs: readonly SymbolDefinition[] = [],
  r: Range = range(),
  filePath = 'x.ts',
  bindings: Record<string, readonly BindingRef[]> = {},
): Scope => ({
  id,
  parent,
  kind,
  range: r,
  filePath,
  bindings: new Map(Object.entries(bindings)),
  ownedDefs,
  imports: [],
  typeBindings: new Map(),
});

function makeIndexes(scopes: Scope[], allDefs: SymbolDefinition[]): ScopeResolutionIndexes {
  return {
    scopeTree: buildScopeTree(scopes),
    defs: buildDefIndex(allDefs),
    qualifiedNames: buildQualifiedNameIndex(allDefs),
    moduleScopes: buildModuleScopeIndex(
      scopes
        .filter((s) => s.kind === 'Module')
        .map((s) => ({ filePath: s.filePath, moduleScopeId: s.id })),
    ),
    methodDispatch: buildMethodDispatchIndex({
      owners: [],
      computeMro: () => [],
      implementsOf: () => [],
    }),
    imports: new Map(),
    bindings: new Map(),
    referenceSites: [],
    sccs: [],
    stats: {
      totalFiles: 0,
      totalEdges: 0,
      linkedEdges: 0,
      unresolvedEdges: 0,
      sccCount: 0,
      largestSccSize: 0,
    },
  };
}

function buildRefIndex(sourceScope: ScopeId, refs: readonly Reference[]): ReferenceIndex {
  const bySource = new Map<ScopeId, readonly Reference[]>();
  bySource.set(sourceScope, refs);
  const byTarget = new Map<DefId, Reference[]>();
  for (const ref of refs) {
    const bucket = byTarget.get(ref.toDef) ?? [];
    bucket.push(ref);
    byTarget.set(ref.toDef, bucket);
  }
  return {
    bySourceScope: bySource,
    byTargetDef: new Map(
      Array.from(byTarget.entries()).map(([k, v]) => [k, Object.freeze([...v])]),
    ),
  };
}

describe('explicit caller ownership', () => {
  function emit(
    scopes: Scope[],
    allDefs: SymbolDefinition[],
    source: Scope,
    kinds: Reference['kind'][] = ['call'],
  ) {
    const graph = createKnowledgeGraph();
    const target = def('def:target', 'Function');
    const stats = emitReferencesToGraph({
      graph,
      scopes: makeIndexes(scopes, [...allDefs, target]),
      referenceIndex: buildRefIndex(
        source.id,
        kinds.map((kind, index) => ({
          fromScope: source.id,
          toDef: target.nodeId,
          atRange: range(12 + index, 2, 12 + index, 6),
          kind,
          confidence: 0.75,
          evidence: [],
        })),
      ),
    });
    return { graph, stats };
  }

  it.each(['Function', 'Method', 'Constructor'] as const)(
    'selects the exact %s owner in either ownedDefs order',
    (type) => {
      const caller = def('def:caller', type);
      const nested = def('def:nested', 'Function');
      const mod = scope('scope:m', null, 'Module');
      for (const owned of [
        [nested, caller],
        [caller, nested],
      ]) {
        const fn = {
          ...scope('scope:f', mod.id, 'Function', owned, range(2, 0, 90, 0)),
          ownerDefId: caller.nodeId,
        };
        const { graph, stats } = emit([mod, fn], [caller, nested], fn);
        expect(stats).toMatchObject({ edgesEmitted: 1, skippedNoCaller: 0 });
        expect(
          graph.relationships.map(({ sourceId, targetId, type }) => ({ sourceId, targetId, type })),
        ).toEqual([{ sourceId: caller.nodeId, targetId: 'def:target', type: 'CALLS' }]);
      }
    },
  );

  it('treats explicit null as a Function barrier even when the anonymous scope contains a callable', () => {
    const outerDef = def('def:outer', 'Function');
    const nested = def('def:nested', 'Function');
    const mod = scope('scope:m', null, 'Module');
    const outer = {
      ...scope('scope:outer', mod.id, 'Function', [outerDef], range(2, 0, 90, 0)),
      ownerDefId: outerDef.nodeId,
    };
    const anonymous = {
      ...scope('scope:anonymous', outer.id, 'Function', [nested], range(5, 0, 50, 0)),
      ownerDefId: null,
    };
    const block = {
      ...scope('scope:b', anonymous.id, 'Block', [], range(10, 0, 30, 0)),
      ownerDefId: null,
    };
    const { graph, stats } = emit([mod, outer, anonymous, block], [outerDef, nested], block);
    expect(stats).toMatchObject({ edgesEmitted: 0, skippedNoCaller: 1 });
    expect(graph.relationships).toEqual([]);
  });

  it.each(['missing', 'wrong-file', 'noncallable', 'other-scope'] as const)(
    'rejects a %s explicit Function owner without choosing another callable',
    (invalid) => {
      const unrelated = def('def:unrelated', 'Function');
      const owner = {
        ...def('def:owner', invalid === 'noncallable' ? 'Variable' : 'Function'),
        filePath: invalid === 'wrong-file' ? 'other.ts' : 'x.ts',
      };
      const mod = scope('scope:m', null, 'Module', invalid === 'other-scope' ? [owner] : []);
      const fn = {
        ...scope(
          'scope:f',
          mod.id,
          'Function',
          invalid === 'other-scope' ? [unrelated] : [unrelated, owner],
          range(2, 0, 90, 0),
        ),
        ownerDefId: owner.nodeId,
      };
      const { graph, stats } = emit(
        [mod, fn],
        invalid === 'missing' ? [unrelated] : [unrelated, owner],
        fn,
      );
      expect(stats).toMatchObject({ edgesEmitted: 0, skippedNoCaller: 1 });
      expect(graph.relationships).toEqual([]);
    },
  );

  it('ignores an unrelated Block callable and reaches the explicit outer owner', () => {
    const caller = def('def:caller', 'Function');
    const unrelated = def('def:unrelated', 'Function');
    const mod = scope('scope:m', null, 'Module');
    const fn = {
      ...scope('scope:f', mod.id, 'Function', [caller], range(2, 0, 90, 0)),
      ownerDefId: caller.nodeId,
    };
    const block = {
      ...scope('scope:b', fn.id, 'Block', [unrelated], range(10, 0, 30, 0)),
      ownerDefId: null,
    };
    const { graph, stats } = emit([mod, fn, block], [caller, unrelated], block);
    expect(stats).toMatchObject({ edgesEmitted: 1, skippedNoCaller: 0 });
    expect(graph.relationships.map((edge) => edge.sourceId)).toEqual([caller.nodeId]);
  });

  it('uses the exact Class fallback rather than its unrelated callable or nested Class', () => {
    const owner = def('def:Owner', 'Class');
    const nested = def('def:Nested', 'Class');
    const unrelated = def('def:unrelated', 'Function');
    const mod = scope('scope:m', null, 'Module');
    const cls = {
      ...scope('scope:c', mod.id, 'Class', [unrelated, nested, owner], range(2, 0, 90, 0)),
      ownerDefId: owner.nodeId,
    };
    const block = {
      ...scope('scope:b', cls.id, 'Block', [], range(10, 0, 30, 0)),
      ownerDefId: null,
    };
    const { graph, stats } = emit([mod, cls, block], [owner, nested, unrelated], block);
    expect(stats).toMatchObject({ edgesEmitted: 1, skippedNoCaller: 0 });
    expect(graph.relationships.map((edge) => edge.sourceId)).toEqual([owner.nodeId]);
  });

  it('preserves non-call emission when Function owner metadata is explicit null', () => {
    const caller = def('def:caller', 'Function');
    const mod = scope('scope:m', null, 'Module');
    const legacy = scope('scope:f', mod.id, 'Function', [caller], range(2, 0, 90, 0));
    const explicit = { ...legacy, ownerDefId: null };
    const kinds: Reference['kind'][] = [
      'read',
      'write',
      'inherits',
      'type-reference',
      'import-use',
    ];
    const before = emit([mod, legacy], [caller], legacy, kinds);
    const after = emit([mod, explicit], [caller], explicit, kinds);
    expect(after.stats).toEqual(before.stats);
    expect(after.stats.edgesEmitted).toBe(5);
    expect(after.graph.relationships).toEqual(before.graph.relationships);
  });

  it('preserves the first callable legacy owner when owner metadata is absent', () => {
    const first = def('def:first', 'Function');
    const second = def('def:second', 'Function');
    const mod = scope('scope:m', null, 'Module');
    const legacy = scope('scope:f', mod.id, 'Function', [first, second], range(2, 0, 90, 0));
    expect(Object.hasOwn(legacy, 'ownerDefId')).toBe(false);
    const { graph, stats } = emit([mod, legacy], [first, second], legacy);
    expect(stats).toMatchObject({ edgesEmitted: 1, skippedNoCaller: 0 });
    expect(graph.relationships.map((edge) => edge.sourceId)).toEqual([first.nodeId]);
  });
});

// ─── Kind mapping + basic emission ────────────────────────────────────────

describe('emitReferencesToGraph: kind mapping', () => {
  it('maps call → CALLS and carries confidence + evidence onto the edge', () => {
    const callerFn = def('def:saveUser', 'Function', 'saveUser');
    const targetFn = def('def:User.save', 'Method', 'User.save');
    const mod = scope('scope:m', null, 'Module', [targetFn]);
    const callerScope = scope('scope:f', mod.id, 'Function', [callerFn]);
    const indexes = makeIndexes([mod, callerScope], [callerFn, targetFn]);

    const ref: Reference = {
      fromScope: callerScope.id,
      toDef: 'def:User.save',
      atRange: range(10, 4, 10, 8),
      kind: 'call',
      confidence: 0.75,
      evidence: [
        { kind: 'local', weight: 0.55 },
        { kind: 'arity-match', weight: 0.1, note: 'compatible' },
      ],
    };

    const graph = createKnowledgeGraph();
    const stats = emitReferencesToGraph({
      graph,
      scopes: indexes,
      referenceIndex: buildRefIndex(callerScope.id, [ref]),
    });

    expect(stats.edgesEmitted).toBe(1);
    expect(graph.relationships).toHaveLength(1);
    const edge = graph.relationships[0]!;
    expect(edge.id).toBe('rel:CALLS:def:saveUser->def:User.save:10:4');
    expect(edge.type).toBe('CALLS');
    expect(edge.sourceId).toBe('def:saveUser');
    expect(edge.targetId).toBe('def:User.save');
    expect(edge.confidence).toBe(0.75);
    expect(edge.evidence).toEqual([
      { kind: 'local', weight: 0.55 },
      { kind: 'arity-match', weight: 0.1, note: 'compatible' },
    ]);
    expect(edge.reason).toContain('call');
    expect(edge.reason).toContain('0.750');
  });

  it('maps read / write → ACCESSES and stamps step=1 / step=2 for discrimination', () => {
    const fn = def('def:render', 'Function');
    const field = def('def:User.name', 'Property');
    const mod = scope('scope:m', null, 'Module', [fn, field]);
    const indexes = makeIndexes([mod], [fn, field]);

    const readRef: Reference = {
      fromScope: 'scope:m',
      toDef: 'def:User.name',
      atRange: range(5, 0, 5, 4),
      kind: 'read',
      confidence: 0.55,
      evidence: [{ kind: 'local', weight: 0.55 }],
    };
    const writeRef: Reference = {
      fromScope: 'scope:m',
      toDef: 'def:User.name',
      atRange: range(6, 0, 6, 4),
      kind: 'write',
      confidence: 0.55,
      evidence: [{ kind: 'local', weight: 0.55 }],
    };

    const graph = createKnowledgeGraph();
    emitReferencesToGraph({
      graph,
      scopes: indexes,
      referenceIndex: buildRefIndex('scope:m', [readRef, writeRef]),
    });

    const edges = graph.relationships;
    expect(edges).toHaveLength(2);
    expect(edges.every((e) => e.type === 'ACCESSES')).toBe(true);
    const readEdge = edges.find((e) => e.step === 1)!;
    const writeEdge = edges.find((e) => e.step === 2)!;
    expect(readEdge).toBeDefined();
    expect(writeEdge).toBeDefined();
  });

  it('maps inherits → INHERITS and type-reference/import-use → USES', () => {
    const hostFn = def('def:host', 'Function');
    const base = def('def:Base', 'Class');
    const mixin = def('def:Mixin', 'Class');
    const module = def('def:SomeModule', 'Namespace');
    const mod = scope('scope:m', null, 'Module', [hostFn, base, mixin, module]);
    const indexes = makeIndexes([mod], [hostFn, base, mixin, module]);

    const refs: Reference[] = [
      {
        fromScope: 'scope:m',
        toDef: 'def:Base',
        atRange: range(1, 0, 1, 4),
        kind: 'inherits',
        confidence: 0.9,
        evidence: [],
      },
      {
        fromScope: 'scope:m',
        toDef: 'def:Mixin',
        atRange: range(2, 0, 2, 4),
        kind: 'type-reference',
        confidence: 0.7,
        evidence: [],
      },
      {
        fromScope: 'scope:m',
        toDef: 'def:SomeModule',
        atRange: range(3, 0, 3, 4),
        kind: 'import-use',
        confidence: 0.5,
        evidence: [],
      },
    ];

    const graph = createKnowledgeGraph();
    emitReferencesToGraph({
      graph,
      scopes: indexes,
      referenceIndex: buildRefIndex('scope:m', refs),
    });

    const types = graph.relationships.map((r) => r.type).sort();
    expect(types).toEqual(['INHERITS', 'USES', 'USES']);
    expect(graph.relationships.find((edge) => edge.type === 'INHERITS')!.id).toBe(
      'rel:INHERITS:def:host->def:Base:1:0',
    );
  });

  it.each([
    ['read', 'write', 'ACCESSES'],
    ['write', 'read', 'ACCESSES'],
    ['type-reference', 'import-use', 'USES'],
    ['import-use', 'type-reference', 'USES'],
  ] as const)('preserves same-site %s / %s edges on repeat emission', (first, second, type) => {
    const caller = def('def:host', 'Function');
    const target = def('def:target', 'Property');
    const mod = scope('scope:m', null, 'Module', [caller, target]);
    const indexes = makeIndexes([mod], [caller, target]);
    const refs: Reference[] = [first, second].map((kind, index) => ({
      fromScope: mod.id,
      toDef: target.nodeId,
      atRange: range(10, 4, 10, 8),
      kind,
      confidence: index === 0 ? 0.75 : 0.55,
      evidence: [{ kind: 'local', weight: 0.55, note: kind }],
    }));
    const graph = createKnowledgeGraph();
    const input = { graph, scopes: indexes, referenceIndex: buildRefIndex(mod.id, refs) };

    emitReferencesToGraph(input);

    expect(graph.relationships).toEqual(
      refs.map((ref) => ({
        id: `rel:${type}:${caller.nodeId}->${target.nodeId}:10:4:${ref.kind}`,
        sourceId: caller.nodeId,
        targetId: target.nodeId,
        type,
        confidence: ref.confidence,
        reason: `scope-resolution: ${ref.kind} | confidence ${ref.confidence.toFixed(3)}`,
        evidence: ref.evidence,
        ...(ref.kind === 'read' ? { step: 1 } : ref.kind === 'write' ? { step: 2 } : {}),
      })),
    );
    expect(new Set(graph.relationships.map((edge) => edge.id)).size).toBe(2);
    const emitted = structuredClone(graph.relationships);

    emitReferencesToGraph(input);

    expect(graph.relationships).toEqual(emitted);
  });
});

describe('definitionNodeIds mapping', () => {
  it.each([
    ['call', 'CALLS'],
    ['read', 'ACCESSES'],
    ['write', 'ACCESSES'],
    ['inherits', 'INHERITS'],
    ['type-reference', 'USES'],
    ['import-use', 'USES'],
  ] as const)('translates %s endpoints and preserves evidence on repeat emission', (kind, type) => {
    const caller = def('def:caller', 'Function');
    const target = def('def:target', 'Class');
    const mod = scope('scope:m', null, 'Module', [target]);
    const callerScope = scope('scope:f', mod.id, 'Function', [caller]);
    const indexes = makeIndexes([mod, callerScope], [caller, target]);
    const refs: Reference[] = [
      {
        fromScope: callerScope.id,
        toDef: target.nodeId,
        atRange: range(10, 4, 10, 8),
        kind,
        confidence: 0.75,
        evidence: [{ kind: 'local', weight: 0.55, note: 'preserved' }],
      },
    ];
    const definitionNodeIds = new Map<DefId, string>([
      [caller.nodeId, 'Function:x.ts:caller'],
      [target.nodeId, 'Class:x.ts:target'],
    ]);
    const original = structuredClone({ mod, callerScope, caller, target, refs, definitionNodeIds });
    const graph = createKnowledgeGraph();
    for (const definition of [caller, target]) {
      graph.addNode({
        id: definitionNodeIds.get(definition.nodeId)!,
        label: definition.type,
        properties: { name: definition.nodeId, filePath: definition.filePath },
      });
    }
    const nodes = structuredClone(graph.nodes);
    const input = {
      graph,
      scopes: indexes,
      referenceIndex: buildRefIndex(callerScope.id, refs),
      definitionNodeIds,
      sourceLabel: 'mapped-resolution',
    };

    expect(emitReferencesToGraph(input)).toEqual({
      edgesEmitted: 1,
      skippedNoCaller: 0,
      skippedMissingTarget: 0,
      scopeNodesEmitted: 0,
      scopeEdgesEmitted: 0,
    });
    const suffix = type === 'ACCESSES' || type === 'USES' ? `:${kind}` : '';
    expect(graph.relationships).toEqual([
      {
        id: `rel:${type}:Function:x.ts:caller->Class:x.ts:target:10:4${suffix}`,
        sourceId: 'Function:x.ts:caller',
        targetId: 'Class:x.ts:target',
        type,
        confidence: 0.75,
        reason: `mapped-resolution: ${kind} | confidence 0.750`,
        evidence: refs[0]!.evidence,
        ...(kind === 'read' ? { step: 1 } : kind === 'write' ? { step: 2 } : {}),
      },
    ]);
    const emitted = structuredClone(graph.relationships);
    emitReferencesToGraph(input);
    expect(graph.relationships).toEqual(emitted);
    expect(graph.nodes).toEqual(nodes);
    expect({ mod, callerScope, caller, target, refs, definitionNodeIds }).toEqual(original);
    for (const edge of graph.relationships) {
      expect(graph.getNode(edge.sourceId)).toBeDefined();
      expect(graph.getNode(edge.targetId)).toBeDefined();
    }
  });

  it.each([
    ['caller', 'missing'],
    ['caller', 'empty'],
    ['caller', 'absent-node'],
    ['target', 'missing'],
    ['target', 'empty'],
    ['target', 'absent-node'],
    ['both', 'missing'],
  ] as const)(
    'skips %s with %s mapping even when raw definition nodes exist',
    (endpoint, failure) => {
      const caller = def('def:caller', 'Function');
      const target = def('def:target', 'Class');
      const mod = scope('scope:m', null, 'Module', [target]);
      const callerScope = scope('scope:f', mod.id, 'Function', [caller]);
      const indexes = makeIndexes([mod, callerScope], [caller, target]);
      const definitionNodeIds = new Map<DefId, string>([
        [caller.nodeId, 'legacy:caller'],
        [target.nodeId, 'legacy:target'],
      ]);
      for (const definition of endpoint === 'both'
        ? [caller, target]
        : [endpoint === 'caller' ? caller : target]) {
        if (failure === 'missing') definitionNodeIds.delete(definition.nodeId);
        else definitionNodeIds.set(definition.nodeId, failure === 'empty' ? '' : 'legacy:absent');
      }
      const graph = createKnowledgeGraph();
      for (const id of [caller.nodeId, target.nodeId, 'legacy:caller', 'legacy:target']) {
        graph.addNode({ id, label: 'Function', properties: { name: id, filePath: 'x.ts' } });
      }
      const stats = emitReferencesToGraph({
        graph,
        scopes: indexes,
        definitionNodeIds,
        referenceIndex: buildRefIndex(callerScope.id, [
          {
            fromScope: callerScope.id,
            toDef: target.nodeId,
            atRange: range(10, 4, 10, 8),
            kind: 'call',
            confidence: 0.75,
            evidence: [],
          },
        ]),
      });

      expect(stats).toEqual({
        edgesEmitted: 0,
        skippedNoCaller: endpoint === 'caller' ? 1 : 0,
        skippedMissingTarget: endpoint === 'caller' ? 0 : 1,
        scopeNodesEmitted: 0,
        scopeEdgesEmitted: 0,
      });
      expect(graph.relationships).toEqual([]);
    },
  );

  it('does not substitute a mapped ancestor for the selected unmapped caller', () => {
    const outer = def('def:outer', 'Function');
    const inner = def('def:inner', 'Function');
    const target = def('def:target', 'Method');
    const mod = scope('scope:m', null, 'Module');
    const outerScope = scope('scope:outer', mod.id, 'Function', [outer], range(2, 0, 90, 0));
    const child = scope('scope:f', outerScope.id, 'Function', [inner], range(5, 0, 20, 0));
    const indexes = makeIndexes([mod, outerScope, child], [outer, inner, target]);
    const graph = createKnowledgeGraph();
    for (const id of ['legacy:outer', 'legacy:target']) {
      graph.addNode({ id, label: 'Function', properties: { name: id, filePath: 'x.ts' } });
    }
    const stats = emitReferencesToGraph({
      graph,
      scopes: indexes,
      definitionNodeIds: new Map([
        [outer.nodeId, 'legacy:outer'],
        [target.nodeId, 'legacy:target'],
      ]),
      referenceIndex: buildRefIndex(child.id, [
        {
          fromScope: child.id,
          toDef: target.nodeId,
          atRange: range(10, 4, 10, 8),
          kind: 'call',
          confidence: 0.75,
          evidence: [],
        },
      ]),
    });

    expect(stats.skippedNoCaller).toBe(1);
    expect(stats.edgesEmitted).toBe(0);
    expect(graph.relationships).toEqual([]);
  });

  it.each(['direct', 'env'] as const)(
    'translates only DEFINES during %s scope emission',
    (mode) => {
      const fn = def('def:fn', 'Function');
      const missing = def('def:missing', 'Function');
      const empty = def('def:empty', 'Function');
      const absent = def('def:absent', 'Function');
      const mod = scope('scope:m', null, 'Module');
      const child = scope('scope:f', mod.id, 'Function', [fn, missing, empty, absent]);
      const target = scope('scope:y', null, 'Module', [], range(), 'y.ts');
      const indexes: ScopeResolutionIndexes = {
        ...makeIndexes([mod, child, target], [fn, missing, empty, absent]),
        imports: new Map([
          [
            mod.id,
            [
              {
                localName: 'linked',
                targetFile: 'y.ts',
                targetExportedName: '*',
                targetModuleScope: target.id,
                kind: 'namespace',
              },
            ],
          ],
        ]),
      };
      const definitionNodeIds = new Map<DefId, string>([
        [fn.nodeId, 'legacy:fn'],
        [empty.nodeId, ''],
        [absent.nodeId, 'legacy:absent'],
      ]);
      const graph = createKnowledgeGraph();
      for (const id of ['legacy:fn', fn.nodeId, missing.nodeId, empty.nodeId, absent.nodeId]) {
        graph.addNode({ id, label: 'Function', properties: { name: id, filePath: 'x.ts' } });
      }
      const original = structuredClone({
        mod,
        child,
        target,
        imports: indexes.imports,
        definitionNodeIds,
      });
      process.env['INGESTION_EMIT_SCOPES'] = mode === 'env' ? '1' : '0';
      const emit = () =>
        mode === 'direct'
          ? emitScopeGraph({ graph, scopes: indexes, definitionNodeIds })
          : emitReferencesToGraph({
              graph,
              scopes: indexes,
              definitionNodeIds,
              referenceIndex: buildRefIndex(child.id, []),
            });

      expect(emit()).toMatchObject({ scopeNodesEmitted: 3, scopeEdgesEmitted: 3 });
      expect(graph.relationships).toEqual([
        {
          id: 'rel:contains:scope:m->scope:f',
          sourceId: mod.id,
          targetId: child.id,
          type: 'CONTAINS',
          confidence: 1,
          reason: 'scope-tree parent/child',
        },
        {
          id: 'rel:defines:scope:f->legacy:fn',
          sourceId: child.id,
          targetId: 'legacy:fn',
          type: 'DEFINES',
          confidence: 1,
          reason: 'scope.ownedDefs',
        },
        {
          id: 'rel:imports:scope:m->scope:y:linked',
          sourceId: mod.id,
          targetId: target.id,
          type: 'IMPORTS',
          confidence: 1,
          reason: 'import namespace linked',
        },
      ]);
      for (const lexicalScope of [mod, child, target]) {
        expect(graph.getNode(lexicalScope.id)).toMatchObject({
          id: lexicalScope.id,
          label: 'CodeElement',
          properties: { name: lexicalScope.kind },
        });
      }
      const emitted = structuredClone({ nodes: graph.nodes, relationships: graph.relationships });
      emit();
      expect({ nodes: graph.nodes, relationships: graph.relationships }).toEqual(emitted);
      expect({ mod, child, target, imports: indexes.imports, definitionNodeIds }).toEqual(original);
    },
  );

  it('emits no DEFINES for an empty supplied map even with raw definition nodes', () => {
    const fn = def('def:fn', 'Function');
    const mod = scope('scope:m', null, 'Module', [fn]);
    const graph = createKnowledgeGraph();
    graph.addNode({ id: fn.nodeId, label: fn.type, properties: { name: 'fn', filePath: 'x.ts' } });

    expect(
      emitScopeGraph({
        graph,
        scopes: makeIndexes([mod], [fn]),
        definitionNodeIds: new Map(),
      }),
    ).toEqual({ scopeNodesEmitted: 1, scopeEdgesEmitted: 0 });
    expect(graph.relationships).toEqual([]);
  });
});

// ─── Enclosing-def resolution ─────────────────────────────────────────────

describe('enclosing-def resolution', () => {
  it.each(['Block', 'Expression', 'Namespace', 'Function'] as const)(
    'skips calls from a %s scope owning only a variable while retaining non-call fallback',
    (kind) => {
      const constant = def('def:unrelated', 'Variable', 'unrelated');
      const target = def('def:target', 'Function');
      const mod = scope('scope:m', null, 'Module');
      const child = scope('scope:child', mod.id, kind, [constant], range(2, 0, 20, 0));
      const graph = createKnowledgeGraph();
      const refs: Reference[] = (['call', 'read'] as const).map((kind) => ({
        fromScope: child.id,
        toDef: target.nodeId,
        atRange: range(7, 0, 7, 4),
        kind,
        confidence: 0.55,
        evidence: [],
      }));

      expect(
        emitReferencesToGraph({
          graph,
          scopes: makeIndexes([mod, child], [constant, target]),
          referenceIndex: buildRefIndex(child.id, refs),
        }),
      ).toEqual({
        edgesEmitted: 1,
        skippedNoCaller: 1,
        skippedMissingTarget: 0,
        scopeNodesEmitted: 0,
        scopeEdgesEmitted: 0,
      });
      expect(graph.relationships).toEqual([
        expect.objectContaining({
          sourceId: constant.nodeId,
          targetId: target.nodeId,
          type: 'ACCESSES',
          step: 1,
        }),
      ]);
    },
  );

  it.each(['Module', 'Block'] as const)(
    'skips calls from %s when only a module constant could supply the caller',
    (kind) => {
      const constant = def('def:unrelated', 'Variable', 'unrelated');
      const target = def('def:target', 'Function');
      const mod = scope('scope:m', null, 'Module', [constant]);
      const child = scope('scope:b', mod.id, 'Block');
      const source = kind === 'Module' ? mod : child;
      const graph = createKnowledgeGraph();
      const ref: Reference = {
        fromScope: source.id,
        toDef: target.nodeId,
        atRange: range(7, 0, 7, 4),
        kind: 'call',
        confidence: 0.55,
        evidence: [],
      };

      expect(
        emitReferencesToGraph({
          graph,
          scopes: makeIndexes([mod, child], [constant, target]),
          referenceIndex: buildRefIndex(source.id, [ref]),
        }),
      ).toMatchObject({ edgesEmitted: 0, skippedNoCaller: 1, skippedMissingTarget: 0 });
      expect(graph.relationships).toEqual([]);
    },
  );

  it.each(['call-first', 'call-last'] as const)(
    'preserves module fallback for every non-call kind with %s references in one scope',
    (order) => {
      const constant = def('def:unrelated', 'Variable', 'unrelated');
      const target = def('def:target', 'Class');
      const mod = scope('scope:m', null, 'Module', [constant]);
      const nonCallKinds = ['read', 'write', 'inherits', 'type-reference', 'import-use'] as const;
      const kinds: Reference['kind'][] =
        order === 'call-first' ? ['call', ...nonCallKinds] : [...nonCallKinds, 'call'];
      const refs: Reference[] = kinds.map((kind) => ({
        fromScope: mod.id,
        toDef: target.nodeId,
        atRange: range(7, 0, 7, 4),
        kind,
        confidence: 0.55,
        evidence: [],
      }));
      const graph = createKnowledgeGraph();

      expect(
        emitReferencesToGraph({
          graph,
          scopes: makeIndexes([mod], [constant, target]),
          referenceIndex: buildRefIndex(mod.id, refs),
        }),
      ).toMatchObject({ edgesEmitted: 5, skippedNoCaller: 1, skippedMissingTarget: 0 });
      expect(
        graph.relationships.map(({ sourceId, targetId, type, step }) => ({
          sourceId,
          targetId,
          type,
          step,
        })),
      ).toEqual([
        { sourceId: constant.nodeId, targetId: target.nodeId, type: 'ACCESSES', step: 1 },
        { sourceId: constant.nodeId, targetId: target.nodeId, type: 'ACCESSES', step: 2 },
        { sourceId: constant.nodeId, targetId: target.nodeId, type: 'INHERITS', step: undefined },
        { sourceId: constant.nodeId, targetId: target.nodeId, type: 'USES', step: undefined },
        { sourceId: constant.nodeId, targetId: target.nodeId, type: 'USES', step: undefined },
      ]);
    },
  );

  describe.each(['Module', 'Block'] as const)('calls from %s scope', (kind) => {
    it.each([
      { order: ['constant', 'first'] },
      { order: ['first', 'constant'] },
      { order: ['constant', 'first', 'second'] },
      { order: ['second', 'first', 'constant'] },
    ] as const)('does not select unrelated module definitions in order $order', ({ order }) => {
      const definitions = {
        constant: def('def:unrelated', 'Variable'),
        first: def('def:first', 'Function'),
        second: def('def:second', 'Function'),
      };
      const target = def('def:target', 'Function');
      const ownedDefs = order.map((name) => definitions[name]);
      const mod = scope('scope:m', null, 'Module', ownedDefs);
      const child = scope('scope:b', mod.id, 'Block');
      const source = kind === 'Module' ? mod : child;
      const graph = createKnowledgeGraph();

      expect(
        emitReferencesToGraph({
          graph,
          scopes: makeIndexes([mod, child], [...ownedDefs, target]),
          referenceIndex: buildRefIndex(source.id, [
            {
              fromScope: source.id,
              toDef: target.nodeId,
              atRange: range(7, 0, 7, 4),
              kind: 'call',
              confidence: 0.55,
              evidence: [],
            },
          ]),
        }),
      ).toMatchObject({ edgesEmitted: 0, skippedNoCaller: 1, skippedMissingTarget: 0 });
      expect(graph.relationships).toEqual([]);
    });
  });

  it.each(['Function', 'Method', 'Constructor'] as const)(
    'retains a %s caller below unrelated module functions',
    (type) => {
      const unrelated = def('def:unrelated', 'Function');
      const constant = def('def:constant', 'Variable');
      const caller = def('def:caller', type);
      const target = def('def:target', 'Function');
      const mod = scope('scope:m', null, 'Module', [unrelated]);
      const callerScope = scope('scope:f', mod.id, 'Function', [caller], range(2, 0, 90, 0));
      const child = scope('scope:b', callerScope.id, 'Block', [constant], range(5, 0, 20, 0));
      const graph = createKnowledgeGraph();

      expect(
        emitReferencesToGraph({
          graph,
          scopes: makeIndexes([mod, callerScope, child], [unrelated, constant, caller, target]),
          referenceIndex: buildRefIndex(child.id, [
            {
              fromScope: child.id,
              toDef: target.nodeId,
              atRange: range(7, 0, 7, 4),
              kind: 'call',
              confidence: 0.55,
              evidence: [],
            },
          ]),
        }),
      ).toMatchObject({ edgesEmitted: 1, skippedNoCaller: 0, skippedMissingTarget: 0 });
      expect(graph.relationships).toEqual([
        expect.objectContaining({
          sourceId: caller.nodeId,
          targetId: target.nodeId,
          type: 'CALLS',
        }),
      ]);
    },
  );

  describe.each(['empty', 'variable-only'] as const)('%s Function boundary', (ownership) => {
    it.each(['Function', 'Method', 'Constructor'] as const)(
      'does not attribute a nested block call to the outer %s',
      (type) => {
        const caller = def('def:outer', type);
        const variable = def('def:local', 'Variable');
        const target = def('def:target', 'Function');
        const mod = scope('scope:m', null, 'Module');
        const outer = scope('scope:outer', mod.id, 'Function', [caller], range(2, 0, 90, 0));
        const boundary = scope(
          'scope:boundary',
          outer.id,
          'Function',
          ownership === 'empty' ? [] : [variable],
          range(5, 0, 50, 0),
        );
        const child = scope('scope:b', boundary.id, 'Block', [], range(10, 0, 20, 0));
        const graph = createKnowledgeGraph();

        expect(
          emitReferencesToGraph({
            graph,
            scopes: makeIndexes([mod, outer, boundary, child], [caller, variable, target]),
            referenceIndex: buildRefIndex(child.id, [
              {
                fromScope: child.id,
                toDef: target.nodeId,
                atRange: range(12, 0, 12, 4),
                kind: 'call',
                confidence: 0.55,
                evidence: [],
              },
            ]),
          }),
        ).toMatchObject({ edgesEmitted: 0, skippedNoCaller: 1, skippedMissingTarget: 0 });
        expect(graph.relationships).toEqual([]);
      },
    );
  });

  it('does not use an outer Class across an empty Function boundary', () => {
    const classDef = def('def:Outer', 'Class');
    const target = def('def:target', 'Function');
    const mod = scope('scope:m', null, 'Module');
    const outer = scope('scope:outer', mod.id, 'Class', [classDef], range(2, 0, 90, 0));
    const boundary = scope('scope:boundary', outer.id, 'Function', [], range(5, 0, 50, 0));
    const child = scope('scope:b', boundary.id, 'Block', [], range(10, 0, 20, 0));
    const graph = createKnowledgeGraph();

    expect(
      emitReferencesToGraph({
        graph,
        scopes: makeIndexes([mod, outer, boundary, child], [classDef, target]),
        referenceIndex: buildRefIndex(child.id, [
          {
            fromScope: child.id,
            toDef: target.nodeId,
            atRange: range(12, 0, 12, 4),
            kind: 'call',
            confidence: 0.55,
            evidence: [],
          },
        ]),
      }),
    ).toMatchObject({ edgesEmitted: 0, skippedNoCaller: 1, skippedMissingTarget: 0 });
    expect(graph.relationships).toEqual([]);
  });

  it.each(['call-first', 'call-last'] as const)(
    'discards a cached Class fallback at an empty Function boundary with %s references',
    (order) => {
      const caller = def('def:outer', 'Function');
      const classDef = def('def:Inner', 'Class');
      const target = def('def:target', 'Class');
      const mod = scope('scope:m', null, 'Module');
      const outer = scope('scope:outer', mod.id, 'Function', [caller], range(2, 0, 90, 0));
      const boundary = scope('scope:boundary', outer.id, 'Function', [], range(5, 0, 50, 0));
      const child = scope('scope:c', boundary.id, 'Class', [classDef], range(10, 0, 20, 0));
      const nonCallKinds = ['read', 'write', 'inherits', 'type-reference', 'import-use'] as const;
      const kinds: Reference['kind'][] =
        order === 'call-first' ? ['call', ...nonCallKinds] : [...nonCallKinds, 'call'];
      const refs: Reference[] = kinds.map((kind) => ({
        fromScope: child.id,
        toDef: target.nodeId,
        atRange: range(12, 0, 12, 4),
        kind,
        confidence: 0.55,
        evidence: [],
      }));
      const graph = createKnowledgeGraph();

      expect(
        emitReferencesToGraph({
          graph,
          scopes: makeIndexes([mod, outer, boundary, child], [caller, classDef, target]),
          referenceIndex: buildRefIndex(child.id, refs),
        }),
      ).toMatchObject({ edgesEmitted: 5, skippedNoCaller: 1, skippedMissingTarget: 0 });
      expect(
        graph.relationships.map(({ sourceId, targetId, type, step }) => ({
          sourceId,
          targetId,
          type,
          step,
        })),
      ).toEqual([
        { sourceId: caller.nodeId, targetId: target.nodeId, type: 'ACCESSES', step: 1 },
        { sourceId: caller.nodeId, targetId: target.nodeId, type: 'ACCESSES', step: 2 },
        { sourceId: caller.nodeId, targetId: target.nodeId, type: 'INHERITS', step: undefined },
        { sourceId: caller.nodeId, targetId: target.nodeId, type: 'USES', step: undefined },
        { sourceId: caller.nodeId, targetId: target.nodeId, type: 'USES', step: undefined },
      ]);
    },
  );

  it('uses the innermost Function/Method ancestor as the caller', () => {
    const method = def('def:User.save', 'Method');
    const classScope = scope('scope:c', 'scope:m', 'Class', [], range(5, 0, 40, 0));
    const methodScope = scope('scope:f', 'scope:c', 'Function', [method], range(10, 0, 30, 0));
    const mod = scope('scope:m', null, 'Module', [], range(1, 0, 100, 0));
    const target = def('def:Logger.log', 'Method');
    const indexes = makeIndexes([mod, classScope, methodScope], [method, target]);

    // Reference fires from a block inside the method scope.
    const ref: Reference = {
      fromScope: 'scope:f',
      toDef: 'def:Logger.log',
      atRange: range(20, 4, 20, 8),
      kind: 'call',
      confidence: 0.75,
      evidence: [],
    };

    const graph = createKnowledgeGraph();
    emitReferencesToGraph({
      graph,
      scopes: indexes,
      referenceIndex: buildRefIndex('scope:f', [ref]),
    });

    expect(graph.relationships[0]!.sourceId).toBe('def:User.save');
  });

  it('walks up to the parent Class if the immediate scope has no Function def', () => {
    const classDef = def('def:User', 'Class');
    const unrelated = def('def:unrelated', 'Function');
    const targetFn = def('def:Logger.log', 'Method');
    const mod = scope('scope:m', null, 'Module', [unrelated], range(1, 0, 100, 0));
    // Class scope owns the Class def but no Function/Method; fallback
    // walks into the Class's owned defs.
    const classScope = scope('scope:c', 'scope:m', 'Class', [classDef], range(5, 0, 50, 0));
    const indexes = makeIndexes([mod, classScope], [classDef, unrelated, targetFn]);

    const ref: Reference = {
      fromScope: 'scope:c',
      toDef: 'def:Logger.log',
      atRange: range(7, 0, 7, 4),
      kind: 'call',
      confidence: 0.55,
      evidence: [],
    };

    const graph = createKnowledgeGraph();
    emitReferencesToGraph({
      graph,
      scopes: indexes,
      referenceIndex: buildRefIndex('scope:c', [ref]),
    });

    // No Function ancestor — falls back to the first owned def: the class itself.
    expect(graph.relationships[0]!.sourceId).toBe('def:User');
  });

  it('increments skippedNoCaller when no ancestor has any owned defs', () => {
    // Module scope is empty; the lone child scope references something
    // but neither it nor its ancestors own anything.
    const target = def('def:someClass', 'Class');
    const mod = scope('scope:m', null, 'Module', [], range(1, 0, 100, 0));
    const child = scope('scope:c', 'scope:m', 'Function', [], range(5, 0, 10, 0));
    const indexes = makeIndexes([mod, child], [target]);

    const ref: Reference = {
      fromScope: 'scope:c',
      toDef: 'def:someClass',
      atRange: range(7, 0, 7, 4),
      kind: 'type-reference',
      confidence: 0.3,
      evidence: [],
    };

    const graph = createKnowledgeGraph();
    const stats = emitReferencesToGraph({
      graph,
      scopes: indexes,
      referenceIndex: buildRefIndex('scope:c', [ref]),
    });

    expect(stats.edgesEmitted).toBe(0);
    expect(stats.skippedNoCaller).toBe(1);
    expect(graph.relationships).toHaveLength(0);
  });
});

// ─── Missing target ──────────────────────────────────────────────────────

describe('missing target', () => {
  it('skips references whose toDef is not in the DefIndex', () => {
    const callerFn = def('def:caller', 'Function');
    const mod = scope('scope:m', null, 'Module', [callerFn]);
    const indexes = makeIndexes([mod], [callerFn]); // target def missing

    const ref: Reference = {
      fromScope: 'scope:m',
      toDef: 'def:ghost',
      atRange: range(5, 0, 5, 4),
      kind: 'call',
      confidence: 0.3,
      evidence: [],
    };
    const graph = createKnowledgeGraph();
    const stats = emitReferencesToGraph({
      graph,
      scopes: indexes,
      referenceIndex: buildRefIndex('scope:m', [ref]),
    });
    expect(stats.edgesEmitted).toBe(0);
    expect(stats.skippedMissingTarget).toBe(1);
    expect(graph.relationships).toHaveLength(0);
  });
});

// ─── Scope-graph emission (INGESTION_EMIT_SCOPES) ─────────────────────────

describe('scope-graph emission', () => {
  it('stays off by default — no scope nodes emitted', () => {
    const callerFn = def('def:caller', 'Function');
    const targetFn = def('def:target', 'Method');
    const mod = scope('scope:m', null, 'Module', [callerFn, targetFn]);
    const indexes = makeIndexes([mod], [callerFn, targetFn]);

    const ref: Reference = {
      fromScope: 'scope:m',
      toDef: 'def:target',
      atRange: range(5, 0, 5, 4),
      kind: 'call',
      confidence: 0.5,
      evidence: [],
    };
    const graph = createKnowledgeGraph();
    const stats = emitReferencesToGraph({
      graph,
      scopes: indexes,
      referenceIndex: buildRefIndex('scope:m', [ref]),
    });
    expect(stats.scopeNodesEmitted).toBe(0);
    expect(stats.scopeEdgesEmitted).toBe(0);
    // No scope nodes in the graph either.
    expect(graph.nodes.filter((n) => n.id.startsWith('scope:')).length).toBe(0);
  });

  it('emits Scope nodes + CONTAINS + DEFINES when INGESTION_EMIT_SCOPES=1', () => {
    process.env['INGESTION_EMIT_SCOPES'] = '1';
    const fn = def('def:fn', 'Function');
    const childScope = scope('scope:f', 'scope:m', 'Function', [fn], range(5, 0, 10, 0));
    const mod = scope('scope:m', null, 'Module', [], range(1, 0, 100, 0));
    const indexes = makeIndexes([mod, childScope], [fn]);

    const graph = createKnowledgeGraph();
    const stats = emitReferencesToGraph({
      graph,
      scopes: indexes,
      referenceIndex: buildRefIndex('scope:f', []),
    });

    expect(stats.scopeNodesEmitted).toBe(2); // module + function scope
    // 1 CONTAINS (module→function) + 1 DEFINES (function→fn def) = 2
    expect(stats.scopeEdgesEmitted).toBe(2);
    const containsEdge = graph.relationships.find((e) => e.type === 'CONTAINS');
    const definesEdge = graph.relationships.find((e) => e.type === 'DEFINES');
    expect(containsEdge).toBeDefined();
    expect(containsEdge!.sourceId).toBe('scope:m');
    expect(containsEdge!.targetId).toBe('scope:f');
    expect(definesEdge).toBeDefined();
    expect(definesEdge!.targetId).toBe('def:fn');
  });

  it("treats 'true', 'yes' (case-insensitive) as enabled; anything else as disabled", () => {
    const fn = def('def:fn', 'Function');
    const mod = scope('scope:m', null, 'Module', [fn]);
    const indexes = makeIndexes([mod], [fn]);

    for (const value of ['true', 'TRUE', 'yes', '1']) {
      process.env['INGESTION_EMIT_SCOPES'] = value;
      const g = createKnowledgeGraph();
      const stats = emitReferencesToGraph({
        graph: g,
        scopes: indexes,
        referenceIndex: buildRefIndex('scope:m', []),
      });
      expect(stats.scopeNodesEmitted).toBeGreaterThan(0);
    }
    for (const value of ['false', '0', '', 'off', 'tru']) {
      process.env['INGESTION_EMIT_SCOPES'] = value;
      const g = createKnowledgeGraph();
      const stats = emitReferencesToGraph({
        graph: g,
        scopes: indexes,
        referenceIndex: buildRefIndex('scope:m', []),
      });
      expect(stats.scopeNodesEmitted).toBe(0);
    }
  });

  it('emitScopeGraph can be called directly (bypasses env flag)', () => {
    const fn = def('def:fn', 'Function');
    const mod = scope('scope:m', null, 'Module', [fn]);
    const indexes = makeIndexes([mod], [fn]);

    const graph = createKnowledgeGraph();
    const stats = emitScopeGraph({ graph, scopes: indexes });
    expect(stats.scopeNodesEmitted).toBe(1);
    expect(stats.scopeEdgesEmitted).toBe(1); // only the DEFINES edge; no parent scope
  });

  it('closes structural endpoints when callers seed definitions and imports name existing modules', () => {
    const fn = def('def:fn', 'Function');
    const exported = { ...def('def:exported', 'Function'), filePath: 'y.ts' };
    const mod = scope('scope:m', null, 'Module');
    const child = scope('scope:f', mod.id, 'Function', [fn], range(5, 0, 10, 0));
    const target = scope('scope:y', null, 'Module', [exported], range(), 'y.ts');
    const indexes: ScopeResolutionIndexes = {
      ...makeIndexes([mod, child, target], [fn, exported]),
      imports: new Map<ScopeId, readonly ImportEdge[]>([
        [
          mod.id,
          [
            {
              localName: 'linked',
              targetFile: 'y.ts',
              targetExportedName: 'exported',
              targetModuleScope: target.id,
              targetDefId: exported.nodeId,
              kind: 'named',
            },
            {
              localName: 'missingSymbol',
              targetFile: 'y.ts',
              targetExportedName: 'missingSymbol',
              targetModuleScope: target.id,
              linkStatus: 'unresolved',
              kind: 'named',
            },
            {
              localName: 'missingModule',
              targetFile: null,
              targetExportedName: '*',
              linkStatus: 'unresolved',
              kind: 'dynamic-unresolved',
            },
          ],
        ],
      ]),
    };
    const graph = createKnowledgeGraph();
    // Scope emission relies on the caller having materialized definition nodes.
    for (const definition of [fn, exported]) {
      graph.addNode({
        id: definition.nodeId,
        label: definition.type,
        properties: { name: definition.nodeId, filePath: definition.filePath },
      });
    }
    const seededDefinitions = graph.nodes;

    const stats = emitScopeGraph({ graph, scopes: indexes });

    expect(stats).toEqual({ scopeNodesEmitted: 3, scopeEdgesEmitted: 5 });
    expect(graph.nodes.map((node) => node.id).sort()).toEqual([
      'def:exported',
      'def:fn',
      'scope:f',
      'scope:m',
      'scope:y',
    ]);
    expect(
      graph.relationships.map((edge) => ({
        type: edge.type,
        sourceId: edge.sourceId,
        targetId: edge.targetId,
        confidence: edge.confidence,
      })),
    ).toEqual([
      { type: 'CONTAINS', sourceId: 'scope:m', targetId: 'scope:f', confidence: 1 },
      { type: 'DEFINES', sourceId: 'scope:f', targetId: 'def:fn', confidence: 1 },
      { type: 'DEFINES', sourceId: 'scope:y', targetId: 'def:exported', confidence: 1 },
      { type: 'IMPORTS', sourceId: 'scope:m', targetId: 'scope:y', confidence: 1 },
      { type: 'IMPORTS', sourceId: 'scope:m', targetId: 'scope:y', confidence: 0.5 },
    ]);
    expect(graph.relationships.some((edge) => edge.id.endsWith(':missingModule'))).toBe(false);
    for (const edge of graph.relationships) {
      expect(graph.getNode(edge.sourceId)).toBeDefined();
      expect(graph.getNode(edge.targetId)).toBeDefined();
    }
    for (const definition of seededDefinitions) {
      expect(graph.getNode(definition.id)).toBe(definition);
    }
  });
});

// ─── Empty input ──────────────────────────────────────────────────────────

describe('empty input', () => {
  it('returns zeroed stats and mutates nothing when ReferenceIndex is empty', () => {
    const mod = scope('scope:m', null, 'Module', []);
    const indexes = makeIndexes([mod], []);
    const graph = createKnowledgeGraph();
    const stats = emitReferencesToGraph({
      graph,
      scopes: indexes,
      referenceIndex: { bySourceScope: new Map(), byTargetDef: new Map() },
    });
    expect(stats).toEqual({
      edgesEmitted: 0,
      skippedNoCaller: 0,
      skippedMissingTarget: 0,
      scopeNodesEmitted: 0,
      scopeEdgesEmitted: 0,
    });
    expect(graph.nodes).toHaveLength(0);
    expect(graph.relationships).toHaveLength(0);
  });
});
