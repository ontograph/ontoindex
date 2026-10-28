/**
 * Unit tests for the scope-aware registries (RFC §4; Ring 2 SHARED #917).
 *
 * Tests are organized per RFC §4.2 step so a regression localizes to the
 * step it broke:
 *
 *   §4.2 Step 1 — lexical scope-chain walk + shadowing
 *   §4.2 Step 2 — type-binding / MRO walk (method/field registries)
 *   §4.2 Step 3 — owner-scoped contributor
 *   §4.2 Step 4 — kind filter + kind-match evidence
 *   §4.2 Step 5 — arity filter
 *   §4.2 Step 6 — global-qualified fallback
 *   §4.2 Step 7 — rank + tie-break cascade
 *   §4.5       — lookupQualified helper
 *   §4.7       — invariants
 *
 * Corroborators (owner-match, unresolved-import cap, dynamic-unresolved)
 * get their own sections.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  buildClassRegistry,
  buildFieldRegistry,
  buildMethodRegistry,
  buildDefIndex,
  buildMethodDispatchIndex,
  buildModuleScopeIndex,
  buildQualifiedNameIndex,
  buildScopeTree,
  lookupCore,
  lookupQualified,
  EvidenceWeights,
  type BindingRef,
  type ImportEdge,
  type Range,
  type RegistryContext,
  type Resolution,
  type Scope,
  type ScopeId,
  type ScopeKind,
  type SymbolDefinition,
  type TypeRef,
} from 'ontoindex-shared';

// ─── Test helpers ───────────────────────────────────────────────────────────

const r = (startLine: number, startCol: number, endLine: number, endCol: number): Range => ({
  startLine,
  startCol,
  endLine,
  endCol,
});

const mkDef = (overrides: Partial<SymbolDefinition> & { nodeId: string }): SymbolDefinition => ({
  nodeId: overrides.nodeId,
  filePath: overrides.filePath ?? 'x.ts',
  type: overrides.type ?? 'Class',
  ...overrides,
});

const mkBinding = (
  def: SymbolDefinition,
  origin: BindingRef['origin'],
  via?: ImportEdge,
): BindingRef => ({ def, origin, ...(via !== undefined ? { via } : {}) });

interface ScopeSpec {
  id: ScopeId;
  parent: ScopeId | null;
  kind?: ScopeKind;
  range?: Range;
  filePath?: string;
  bindings?: Record<string, readonly BindingRef[]>;
  ownedDefs?: readonly SymbolDefinition[];
  typeBindings?: Record<string, TypeRef>;
  imports?: readonly ImportEdge[];
}

const mkScope = (s: ScopeSpec): Scope => ({
  id: s.id,
  parent: s.parent,
  kind: s.kind ?? 'Module',
  range: s.range ?? r(1, 0, 1000, 0),
  filePath: s.filePath ?? 'x.ts',
  bindings: new Map(Object.entries(s.bindings ?? {})),
  ownedDefs: s.ownedDefs ?? [],
  imports: s.imports ?? [],
  typeBindings: new Map(Object.entries(s.typeBindings ?? {})),
});

const typeRef = (rawName: string, declaredAtScope: ScopeId): TypeRef => ({
  rawName,
  declaredAtScope,
  source: 'parameter-annotation',
});

function makeCtx(
  scopes: Scope[],
  defs: SymbolDefinition[],
  opts: {
    mro?: Record<string, readonly string[]>;
    implsByInterface?: Record<string, readonly string[]>;
    arity?: (
      callsite: { arity: number },
      def: SymbolDefinition,
    ) => 'compatible' | 'unknown' | 'incompatible';
  } = {},
): RegistryContext {
  const defIndex = buildDefIndex(defs);
  const qualifiedNameIndex = buildQualifiedNameIndex(defs);
  const moduleScopes = buildModuleScopeIndex(
    scopes
      .filter((s) => s.kind === 'Module')
      .map((s) => ({ filePath: s.filePath, moduleScopeId: s.id })),
  );
  const owners = Array.from(new Set(defs.map((d) => d.nodeId)));
  const methodDispatch = buildMethodDispatchIndex({
    owners,
    computeMro: (owner) => opts.mro?.[owner] ?? [],
    implementsOf: (owner) => {
      const out: string[] = [];
      for (const [iface, impls] of Object.entries(opts.implsByInterface ?? {})) {
        if (impls.includes(owner)) out.push(iface);
      }
      return out;
    },
  });
  return {
    scopes: buildScopeTree(scopes),
    defs: defIndex,
    qualifiedNames: qualifiedNameIndex,
    moduleScopes,
    methodDispatch,
    providers: opts.arity !== undefined ? { arityCompatibility: opts.arity } : {},
  };
}

const evidenceOfKind = (res: Resolution, kind: string) => res.evidence.find((e) => e.kind === kind);

describe('explicit receiver chains', () => {
  const fixture = () => {
    const owner = mkDef({ nodeId: 'type:Owner', qualifiedName: 'Owner' });
    const child = mkDef({ nodeId: 'type:Child', qualifiedName: 'Child' });
    const wrong = mkDef({ nodeId: 'type:Wrong', qualifiedName: 'Wrong' });
    const field = mkDef({
      nodeId: 'field:child',
      type: 'Property',
      ownerId: owner.nodeId,
      qualifiedName: 'Owner.child',
      declaredType: 'Child',
    });
    const method = mkDef({
      nodeId: 'method:child',
      type: 'Method',
      ownerId: owner.nodeId,
      qualifiedName: 'Owner.getChild',
      returnType: 'Child',
      parameterCount: 0,
    });
    const next = mkDef({
      nodeId: 'field:next',
      type: 'Property',
      ownerId: child.nodeId,
      qualifiedName: 'Child.next',
      declaredType: 'Child',
    });
    const target = mkDef({
      nodeId: 'method:save',
      type: 'Method',
      ownerId: child.nodeId,
      qualifiedName: 'Child.save',
      parameterCount: 0,
    });
    const decoy = mkDef({ nodeId: 'function:save', type: 'Function', qualifiedName: 'save' });
    const factory = mkDef({
      nodeId: 'function:factory',
      type: 'Function',
      qualifiedName: 'factory',
      returnType: 'Owner',
      parameterCount: 0,
    });
    const parameter = mkDef({
      nodeId: 'parameter:obj',
      type: 'Variable',
      qualifiedName: 'obj',
      declaredType: 'Owner',
    });
    const outer = mkScope({
      id: 'scope:outer',
      parent: null,
      ownedDefs: [owner, child, wrong, field, method, next, target, factory, parameter],
      bindings: {
        Owner: [mkBinding(owner, 'local')],
        Child: [mkBinding(child, 'local')],
        obj: [mkBinding(parameter, 'local')],
        factory: [mkBinding(factory, 'local')],
      },
      typeBindings: { obj: typeRef('Owner', 'scope:outer'), this: typeRef('Child', 'scope:outer') },
    });
    const inner = mkScope({
      id: 'scope:inner',
      parent: outer.id,
      kind: 'Function',
      range: r(2, 0, 20, 0),
      bindings: { save: [mkBinding(decoy, 'local')], Child: [mkBinding(wrong, 'local')] },
    });
    const defs = [owner, child, wrong, field, method, next, target, decoy, factory, parameter];
    const arity = ({ arity }: { arity: number }, def: SymbolDefinition) =>
      arity === def.parameterCount ? ('compatible' as const) : ('incompatible' as const);
    const ctx = makeCtx([outer, inner], defs, { arity });
    const member = (name: string) => ({ kind: 'member' as const, name, range: r(3, 0, 3, 1) });
    const call = (arity = 0) => ({ kind: 'call' as const, arity, range: r(3, 0, 3, 1) });
    const chain = (steps: ReturnType<typeof member | typeof call>[], root = 'obj') => ({
      kind: 'chain' as const,
      root: { name: root, range: r(3, 0, 3, 1) },
      steps,
    });
    return {
      owner,
      child,
      field,
      method,
      next,
      target,
      decoy,
      factory,
      parameter,
      outer,
      inner,
      defs,
      ctx,
      member,
      call,
      chain,
    };
  };

  it('resolves fields at their declaration scope despite leaf and type decoys', () => {
    const f = fixture();
    const result = buildMethodRegistry(f.ctx).lookup('save', f.inner.id, {
      explicitReceiver: f.chain([f.member('child')]),
      ownerScopedContributor: { ownerDefId: 'decoy', byName: () => [f.decoy] },
    });
    expect(result.map((hit) => hit.def)).toEqual([f.target]);
    expect(
      buildFieldRegistry(f.ctx)
        .lookup('child', f.inner.id, { explicitReceiver: { name: 'obj' } })
        .map((hit) => hit.def),
    ).toEqual([f.field]);
  });

  it('continues through declared method and factory returns', () => {
    const f = fixture();
    const registry = buildMethodRegistry(f.ctx);
    expect(
      registry
        .lookup('save', f.inner.id, { explicitReceiver: f.chain([f.member('getChild'), f.call()]) })
        .map((hit) => hit.def),
    ).toEqual([f.target]);
    expect(
      registry
        .lookup('save', f.inner.id, {
          explicitReceiver: f.chain([f.call(), f.member('child')], 'factory'),
        })
        .map((hit) => hit.def),
    ).toEqual([f.target]);
  });

  it('stops at a nearer untyped value instead of an outer type fact', () => {
    const f = fixture();
    const inner = {
      ...f.inner,
      bindings: new Map([...f.inner.bindings, ['obj', [mkBinding(f.decoy, 'local')]]]),
    };
    const ctx = { ...f.ctx, scopes: buildScopeTree([f.outer, inner]) };
    expect(
      buildFieldRegistry(ctx).lookup('child', inner.id, { explicitReceiver: { name: 'obj' } }),
    ).toEqual([]);
  });

  it('uses a declared value type without a separate type binding', () => {
    const f = fixture();
    const outer = { ...f.outer, typeBindings: new Map() };
    const ctx = { ...f.ctx, scopes: buildScopeTree([outer, f.inner]) };
    expect(
      buildFieldRegistry(ctx)
        .lookup('child', f.inner.id, { explicitReceiver: { name: 'obj' } })
        .map((hit) => hit.def),
    ).toEqual([f.field]);
  });

  it('rejects ambiguous roots and annotation types', () => {
    const f = fixture();
    for (const name of ['obj', 'Owner']) {
      const original = f.outer.bindings.get(name)!;
      const outer = {
        ...f.outer,
        bindings: new Map([
          ...f.outer.bindings,
          [name, [...original, mkBinding(f.child, 'local')]],
        ]),
      };
      const ctx = { ...f.ctx, scopes: buildScopeTree([outer, f.inner]) };
      expect(
        buildFieldRegistry(ctx).lookup('child', f.inner.id, { explicitReceiver: { name: 'obj' } }),
      ).toEqual([]);
    }
  });

  it('resolves only explicitly exported namespace targets', () => {
    const f = fixture();
    const library = mkScope({ id: 'scope:library', parent: null, filePath: 'library.ts' });
    const edge: ImportEdge = {
      kind: 'namespace',
      localName: 'ns',
      targetFile: 'library.ts',
      targetExportedName: '*',
      targetModuleScope: library.id,
    };
    const outer = { ...f.outer, imports: [edge] };
    const collision = { ...f.decoy, nodeId: 'function:private', qualifiedName: 'ns.save' };
    const ctx = {
      ...f.ctx,
      scopes: buildScopeTree([outer, f.inner, library]),
      defs: buildDefIndex([...f.defs, collision]),
      qualifiedNames: buildQualifiedNameIndex([...f.defs, collision]),
      lookupExport: vi
        .fn<NonNullable<RegistryContext['lookupExport']>>()
        .mockReturnValue([f.target]),
    };
    expect(
      buildMethodRegistry(ctx)
        .lookup('save', f.inner.id, { explicitReceiver: { name: 'ns' } })
        .map((hit) => hit.def),
    ).toEqual([f.target]);
    ctx.lookupExport.mockReturnValue([]);
    expect(
      buildMethodRegistry(ctx).lookup('save', f.inner.id, { explicitReceiver: { name: 'ns' } }),
    ).toEqual([]);
    expect(
      buildMethodRegistry(ctx).lookup('ns.save', f.inner.id, {
        explicitReceiver: { name: 'unknown' },
      }),
    ).toEqual([]);
  });

  it.each([
    'arity',
    'unknown-arity',
    'missing-return',
    'ambiguous-member',
    'ambiguous-declaration',
    'field-call',
    'method-without-call',
  ] as const)('rejects %s continuation', (reason) => {
    const f = fixture();
    let ctx = f.ctx;
    let steps = [f.member('getChild'), f.call(reason === 'arity' ? 1 : 0)];
    if (reason === 'unknown-arity') ctx = { ...ctx, providers: {} };
    if (reason === 'missing-return') f.method.returnType = undefined;
    if (reason === 'ambiguous-member') {
      const duplicate = { ...f.method, nodeId: 'method:other' };
      ctx = { ...ctx, defs: buildDefIndex([...f.defs, duplicate]) };
    }
    if (reason === 'ambiguous-declaration') {
      const inner = { ...f.inner, ownedDefs: [f.method] };
      ctx = { ...ctx, scopes: buildScopeTree([f.outer, inner]) };
    }
    if (reason === 'field-call') steps = [f.member('child'), f.call()];
    if (reason === 'method-without-call') steps = [f.member('getChild')];
    expect(
      buildMethodRegistry(ctx).lookup('save', f.inner.id, { explicitReceiver: f.chain(steps) }),
    ).toEqual([]);
  });

  it('accepts 64 steps and rejects 65 or zero', () => {
    const f = fixture();
    const registry = buildMethodRegistry(f.ctx);
    const steps = [f.member('child'), ...Array.from({ length: 63 }, () => f.member('next'))];
    expect(
      registry
        .lookup('save', f.inner.id, { explicitReceiver: f.chain(steps) })
        .map((hit) => hit.def),
    ).toEqual([f.target]);
    expect(
      registry.lookup('save', f.inner.id, {
        explicitReceiver: f.chain([...steps, f.member('next')]),
      }),
    ).toEqual([]);
    expect(registry.lookup('save', f.inner.id, { explicitReceiver: f.chain([]) })).toEqual([]);
  });

  it('keeps implicit receiver and lexical behavior for unqualified calls', () => {
    const f = fixture();
    expect(
      buildMethodRegistry(f.ctx)
        .lookup('save', f.inner.id)
        .map((hit) => hit.def),
    ).toContain(f.decoy);
    const inner = { ...f.inner, bindings: new Map() };
    const ctx = { ...f.ctx, scopes: buildScopeTree([f.outer, inner]) };
    expect(
      buildMethodRegistry(ctx)
        .lookup('save', inner.id)
        .map((hit) => hit.def),
    ).toEqual([f.target]);
    expect(
      buildMethodRegistry(ctx).lookup('save', inner.id, { explicitReceiver: { name: 'missing' } }),
    ).toEqual([]);
  });
});

describe('exported namespace member candidates', () => {
  const fixture = (kind: SymbolDefinition['type'] = 'Function') => {
    const exported = mkDef({ nodeId: 'def:exported', type: kind, qualifiedName: 'lib.Internal' });
    const collision = mkDef({ nodeId: 'def:collision', type: kind, qualifiedName: 'ns.Public' });
    const namespace = mkDef({ nodeId: 'def:namespace', type: 'Namespace' });
    const module = mkScope({ id: 'scope:lib', parent: null, filePath: 'lib.ts' });
    const edge: ImportEdge = {
      kind: 'namespace',
      localName: 'ns',
      namespace: 'both',
      targetFile: 'lib.ts',
      targetModuleScope: module.id,
      targetExportedName: '*',
    };
    const declaration = mkScope({ id: 'scope:app', parent: null, imports: [edge] });
    const lookupExport = vi
      .fn<NonNullable<RegistryContext['lookupExport']>>()
      .mockReturnValue([exported]);
    const ctx = {
      ...makeCtx([module, declaration], [exported, collision, namespace]),
      lookupExport,
    };
    const params = {
      acceptedKinds: [kind],
      lexicalNamespace: 'value' as const,
      useReceiverTypeBinding: false,
      ownerScopedContributor: null,
    };
    return { exported, collision, namespace, module, edge, declaration, lookupExport, ctx, params };
  };

  it.each(['Function', 'Method', 'Property', 'Variable', 'Class'] as const)(
    'resolves an import-edge-only alias to an exported %s with namespace evidence',
    (kind) => {
      const f = fixture(kind);
      const lexicalNamespace = kind === 'Class' ? ('type' as const) : ('value' as const);
      const results = lookupCore(
        'ns.Public',
        f.declaration.id,
        { ...f.params, lexicalNamespace },
        f.ctx,
      );
      expect(results.map((result) => result.def)).toEqual([f.exported]);
      expect(f.lookupExport).toHaveBeenCalledExactlyOnceWith(
        f.module.id,
        'Public',
        lexicalNamespace,
      );
      expect(evidenceOfKind(results[0]!, 'import')?.weight).toBe(EvidenceWeights.namespace);
      expect(evidenceOfKind(results[0]!, 'global-qualified')).toBeUndefined();
    },
  );

  it.each(['binding', 'via', 'edge'] as const)(
    'filters %s namespace tags before claiming the alias',
    (source) => {
      for (const requested of ['type', 'value'] as const) {
        for (const tag of ['type', 'value', 'both', undefined] as const) {
          const f = fixture();
          const via = {
            ...f.edge,
            namespace: source === 'via' || source === 'edge' ? tag : ('both' as const),
          };
          const declaration = {
            ...f.declaration,
            imports: source === 'edge' ? [via] : [],
            bindings: new Map(
              source === 'edge'
                ? []
                : [
                    [
                      'ns',
                      [
                        {
                          ...mkBinding(f.namespace, 'namespace', via),
                          namespace: source === 'binding' ? tag : ('both' as const),
                        },
                      ],
                    ],
                  ],
            ),
          };
          const ctx = { ...f.ctx, scopes: buildScopeTree([f.module, declaration]) };
          const results = lookupCore(
            'ns.Public',
            declaration.id,
            { ...f.params, lexicalNamespace: requested },
            ctx,
          );
          const eligible = tag === undefined || tag === 'both' || tag === requested;
          expect(results.map((result) => result.def)).toEqual(eligible ? [f.exported] : []);
          expect(f.lookupExport).toHaveBeenCalledTimes(eligible ? 1 : 0);
        }
      }
    },
  );

  it('skips opposite-space shadows and measures depth from the lookup scope', () => {
    const f = fixture();
    const inner = mkScope({
      id: 'scope:inner',
      parent: f.declaration.id,
      kind: 'Function',
      bindings: { ns: [{ ...mkBinding(f.collision, 'local'), namespace: 'type' }] },
      imports: [{ ...f.edge, namespace: 'type', targetModuleScope: 'scope:missing' }],
    });
    const results = lookupCore('ns.Public', inner.id, f.params, {
      ...f.ctx,
      scopes: buildScopeTree([f.module, f.declaration, inner]),
    });
    expect(results.map((result) => result.def)).toEqual([f.exported]);
    expect(evidenceOfKind(results[0]!, 'import')?.weight).toBe(EvidenceWeights.namespace);
    expect(evidenceOfKind(results[0]!, 'scope-chain')).toEqual({
      kind: 'scope-chain',
      weight: EvidenceWeights.scopeChainPerDepth,
      note: 'depth=1',
    });
  });

  it.each(['local', 'import', 'wildcard'] as const)(
    'a nearer %s alias claim suppresses outer exports and canonical collisions',
    (origin) => {
      const f = fixture();
      const inner = mkScope({
        id: 'scope:inner',
        parent: f.declaration.id,
        kind: 'Function',
        bindings: { ns: [mkBinding(f.collision, origin)] },
      });
      expect(
        lookupCore('ns.Public', inner.id, f.params, {
          ...f.ctx,
          scopes: buildScopeTree([f.module, f.declaration, inner]),
        }),
      ).toEqual([]);
      expect(f.lookupExport).not.toHaveBeenCalled();
    },
  );

  it.each(['unresolved', 'missing-target', 'missing-scope', 'non-module', 'conflict'] as const)(
    'refuses %s alias targets without canonical fallback',
    (state) => {
      const f = fixture();
      const edge =
        state === 'unresolved'
          ? { ...f.edge, linkStatus: 'unresolved' as const }
          : state === 'missing-target'
            ? { ...f.edge, targetModuleScope: undefined }
            : state === 'missing-scope'
              ? { ...f.edge, targetModuleScope: 'scope:missing' }
              : f.edge;
      const module =
        state === 'non-module'
          ? {
              ...f.module,
              kind: 'Function' as const,
              parent: 'scope:other',
              filePath: 'other.ts',
              range: r(2, 0, 3, 0),
            }
          : f.module;
      const other = mkScope({ id: 'scope:other', parent: null, filePath: 'other.ts' });
      const declaration = {
        ...f.declaration,
        imports: state === 'conflict' ? [edge, { ...edge, targetModuleScope: other.id }] : [edge],
      };
      expect(
        lookupCore('ns.Public', declaration.id, f.params, {
          ...f.ctx,
          scopes: buildScopeTree([module, other, declaration]),
        }),
      ).toEqual([]);
      expect(f.lookupExport).not.toHaveBeenCalled();
    },
  );

  it('deduplicates matching binding and import targets and authoritative export IDs', () => {
    const f = fixture();
    const declaration = {
      ...f.declaration,
      imports: [f.edge, { ...f.edge }],
      bindings: new Map([['ns', [mkBinding(f.namespace, 'namespace', f.edge)]]]),
    };
    const forged = { ...f.exported, qualifiedName: 'forged.Public', type: 'Class' as const };
    f.lookupExport.mockReturnValue([forged, forged]);
    const results = lookupCore('ns.Public', declaration.id, f.params, {
      ...f.ctx,
      scopes: buildScopeTree([f.module, declaration]),
    });
    expect(results.map((result) => result.def)).toEqual([f.exported]);
    expect(results[0]!.def).toBe(f.exported);
    expect(f.lookupExport).toHaveBeenCalledTimes(1);
  });

  it.each(['absent', 'wrong-kind', 'dangling'] as const)(
    'refuses %s exports without canonical fallback',
    (state) => {
      const f = fixture();
      const wrongKind = mkDef({ nodeId: 'def:class', type: 'Class' });
      f.lookupExport.mockReturnValue(
        state === 'absent'
          ? []
          : state === 'wrong-kind'
            ? [{ ...wrongKind, type: 'Function' }]
            : [mkDef({ nodeId: 'def:missing', type: 'Function' })],
      );
      expect(
        lookupCore('ns.Public', f.declaration.id, f.params, {
          ...f.ctx,
          defs: buildDefIndex([f.exported, f.collision, wrongKind]),
        }),
      ).toEqual([]);
    },
  );

  it('retains multiple exported functions until normal arity filtering', () => {
    const f = fixture();
    const other = mkDef({ nodeId: 'def:other', type: 'Function' });
    f.lookupExport.mockReturnValue([f.exported, other]);
    const ctx = { ...f.ctx, defs: buildDefIndex([f.exported, f.collision, other]) };
    expect(
      lookupCore('ns.Public', f.declaration.id, f.params, ctx)
        .map((result) => result.def.nodeId)
        .sort(),
    ).toEqual([f.exported.nodeId, other.nodeId].sort());
    const results = lookupCore(
      'ns.Public',
      f.declaration.id,
      { ...f.params, callsite: { arity: 1 } },
      {
        ...ctx,
        providers: {
          arityCompatibility: (_callsite, def) => (def === other ? 'compatible' : 'incompatible'),
        },
      },
    );
    expect(results.map((result) => result.def)).toEqual([other]);
    expect(evidenceOfKind(results[0]!, 'arity-match')?.weight).toBe(
      EvidenceWeights.arityMatchCompatible,
    );
    expect(evidenceOfKind(results[0]!, 'import')?.weight).toBe(EvidenceWeights.namespace);
  });

  it('keeps exact lexical success and wrong-kind shadowing ahead of alias traversal', () => {
    for (const kind of ['Function', 'Class'] as const) {
      const f = fixture();
      const exact = mkDef({ nodeId: 'def:exact', type: kind });
      const declaration = {
        ...f.declaration,
        bindings: new Map([['ns.Public', [mkBinding(exact, 'local')]]]),
      };
      const results = lookupCore('ns.Public', declaration.id, f.params, {
        ...f.ctx,
        scopes: buildScopeTree([f.module, declaration]),
      });
      expect(results.map((result) => result.def)).toEqual(kind === 'Function' ? [exact] : []);
      expect(f.lookupExport).not.toHaveBeenCalled();
    }
  });

  it('keeps the omitted selector and missing callback paths unchanged', () => {
    const f = fixture();
    const { lexicalNamespace: _lexicalNamespace, ...legacyParams } = f.params;
    expect(
      lookupCore('ns.Public', f.declaration.id, legacyParams, f.ctx).map((result) => result.def),
    ).toEqual([f.collision]);
    expect(f.lookupExport).not.toHaveBeenCalled();
    const { lookupExport: _lookupExport, ...withoutExports } = f.ctx;
    expect(lookupCore('ns.Public', f.declaration.id, f.params, withoutExports)).toEqual([]);
  });

  it('preserves owner candidates when a claimed namespace has no matching export', () => {
    const f = fixture();
    f.lookupExport.mockReturnValue([]);
    const results = lookupCore(
      'ns.Public',
      f.declaration.id,
      {
        ...f.params,
        ownerScopedContributor: {
          ownerDefId: 'def:owner',
          byName: () => [f.exported],
        },
      },
      f.ctx,
    );
    expect(results.map((result) => result.def)).toEqual([f.exported]);
    expect(evidenceOfKind(results[0]!, 'local')?.weight).toBe(EvidenceWeights.local);
  });
});

// ─── §4.2 Step 1 — lexical scope-chain walk + shadowing ────────────────────

describe('lexical namespaces', () => {
  describe.each([
    ['class', 'Class', buildClassRegistry],
    ['method', 'Function', buildMethodRegistry],
    ['field', 'Variable', buildFieldRegistry],
  ] as const)('%s public wrapper', (_registry, kind, buildRegistry) => {
    it.each(['type', 'value'] as const)(
      'forwards %s filtering and preserves omitted-selector compatibility',
      (namespace) => {
        const defs = ['type', 'value', 'both', 'legacy'].map((tag) =>
          mkDef({ nodeId: `def:${tag}`, type: kind }),
        );
        const scope = mkScope({
          id: 'scope:m',
          parent: null,
          bindings: {
            Name: defs.map((def, index) => ({
              ...mkBinding(def, 'local'),
              ...(index < 3 ? { namespace: (['type', 'value', 'both'] as const)[index]! } : {}),
            })),
          },
        });
        const registry = buildRegistry(makeCtx([scope], defs));
        expect(
          registry
            .lookup('Name', scope.id, { lexicalNamespace: namespace })
            .map((result) => result.def.nodeId)
            .sort(),
        ).toEqual([`def:${namespace}`, 'def:both', 'def:legacy'].sort());
        const unified = registry.lookup('Name', scope.id);
        expect(unified.map((result) => result.def.nodeId).sort()).toEqual(
          defs.map((def) => def.nodeId).sort(),
        );
        expect(registry.lookup('Name', scope.id, {})).toEqual(unified);
      },
    );

    it.each(['type', 'value'] as const)(
      'forwards %s to one-hop exported namespace lookup',
      (namespace) => {
        const exported = mkDef({ nodeId: 'def:exported', type: kind });
        const collision = mkDef({
          nodeId: 'def:collision',
          type: kind,
          qualifiedName: 'ns.Public',
        });
        const lib = mkScope({ id: 'scope:lib', parent: null, filePath: 'lib.ts' });
        const app = mkScope({
          id: 'scope:app',
          parent: null,
          imports: [
            {
              kind: 'namespace',
              localName: 'ns',
              namespace: 'both',
              targetFile: 'lib.ts',
              targetModuleScope: lib.id,
              targetExportedName: '*',
            },
          ],
        });
        const lookupExport = vi
          .fn<NonNullable<RegistryContext['lookupExport']>>()
          .mockReturnValue([exported]);
        const registry = buildRegistry({
          ...makeCtx([lib, app], [exported, collision]),
          lookupExport,
        });
        const results = registry.lookup('ns.Public', app.id, { lexicalNamespace: namespace });
        expect(results.map((result) => result.def)).toEqual([exported]);
        expect(lookupExport).toHaveBeenCalledExactlyOnceWith(lib.id, 'Public', namespace);
        expect(evidenceOfKind(results[0]!, 'import')?.weight).toBe(EvidenceWeights.namespace);
        expect(evidenceOfKind(results[0]!, 'global-qualified')).toBeUndefined();
      },
    );
  });

  it.each(['type', 'value'] as const)(
    'selects only %s and shared bindings from a mixed bucket',
    (namespace) => {
      const typeDef = mkDef({ nodeId: 'def:type' });
      const valueDef = mkDef({ nodeId: 'def:value' });
      const bothDef = mkDef({ nodeId: 'def:both' });
      const legacyDef = mkDef({ nodeId: 'def:legacy' });
      const defs = [typeDef, valueDef, bothDef, legacyDef];
      const scope = mkScope({
        id: 'scope:m',
        parent: null,
        bindings: {
          Name: [
            { ...mkBinding(typeDef, 'local'), namespace: 'type' },
            { ...mkBinding(valueDef, 'local'), namespace: 'value' },
            { ...mkBinding(bothDef, 'local'), namespace: 'both' },
            mkBinding(legacyDef, 'local'),
          ],
        },
      });
      const results = lookupCore(
        'Name',
        scope.id,
        {
          acceptedKinds: ['Class'],
          lexicalNamespace: namespace,
          useReceiverTypeBinding: false,
          ownerScopedContributor: null,
        },
        makeCtx([scope], defs),
      );
      expect(results.map((result) => result.def.nodeId).sort()).toEqual(
        [
          bothDef.nodeId,
          legacyDef.nodeId,
          namespace === 'type' ? typeDef.nodeId : valueDef.nodeId,
        ].sort(),
      );

      const unified = lookupCore(
        'Name',
        scope.id,
        {
          acceptedKinds: ['Class'],
          useReceiverTypeBinding: false,
          ownerScopedContributor: null,
        },
        makeCtx([scope], defs),
      );
      expect(unified.map((result) => result.def.nodeId).sort()).toEqual(
        defs.map((def) => def.nodeId).sort(),
      );
    },
  );

  it.each(['type', 'value'] as const)(
    'skips the other namespace before %s shadowing',
    (namespace) => {
      const outer = mkDef({
        nodeId: 'def:outer',
        type: namespace === 'type' ? 'Class' : 'Function',
      });
      const inner = mkDef({ nodeId: 'def:inner', type: 'Class' });
      const mod = mkScope({
        id: 'scope:m',
        parent: null,
        bindings: { Name: [{ ...mkBinding(outer, 'local'), namespace }] },
      });
      const fn = mkScope({
        id: 'scope:f',
        parent: mod.id,
        kind: 'Function',
        bindings: {
          Name: [
            { ...mkBinding(inner, 'local'), namespace: namespace === 'type' ? 'value' : 'type' },
          ],
        },
      });
      const params = {
        acceptedKinds: [outer.type],
        lexicalNamespace: namespace,
        useReceiverTypeBinding: false,
        ownerScopedContributor: null,
      };
      expect(
        lookupCore('Name', fn.id, params, makeCtx([mod, fn], [outer, inner])).map(
          (result) => result.def,
        ),
      ).toEqual([outer]);
    },
  );

  it.each(['type', 'value'] as const)(
    'preserves wrong-kind hard shadowing inside %s',
    (namespace) => {
      const outer = mkDef({
        nodeId: 'def:outer',
        type: namespace === 'type' ? 'Class' : 'Function',
      });
      const inner = mkDef({ nodeId: 'def:inner', type: 'Variable' });
      const mod = mkScope({
        id: 'scope:m',
        parent: null,
        bindings: { Name: [{ ...mkBinding(outer, 'local'), namespace }] },
      });
      const fn = mkScope({
        id: 'scope:f',
        parent: mod.id,
        kind: 'Function',
        bindings: { Name: [{ ...mkBinding(inner, 'local'), namespace }] },
      });
      expect(
        lookupCore(
          'Name',
          fn.id,
          {
            acceptedKinds: [outer.type],
            lexicalNamespace: namespace,
            useReceiverTypeBinding: false,
            ownerScopedContributor: null,
          },
          makeCtx([mod, fn], [outer, inner]),
        ),
      ).toEqual([]);
    },
  );
});

describe('Step 1: lexical scope-chain walk', () => {
  it('finds a class declared at the start scope with origin=local', () => {
    const userClass = mkDef({ nodeId: 'def:User', type: 'Class' });
    const mod = mkScope({
      id: 'scope:m',
      parent: null,
      bindings: { User: [mkBinding(userClass, 'local')] },
    });
    const ctx = makeCtx([mod], [userClass]);
    const registry = buildClassRegistry(ctx);
    const results = registry.lookup('User', 'scope:m');

    expect(results).toHaveLength(1);
    expect(results[0]!.def).toBe(userClass);
    expect(evidenceOfKind(results[0]!, 'local')?.weight).toBe(EvidenceWeights.local);
  });

  it('walks parent scopes when the name is not bound at the start scope', () => {
    const userClass = mkDef({ nodeId: 'def:User', type: 'Class' });
    const mod = mkScope({
      id: 'scope:m',
      parent: null,
      bindings: { User: [mkBinding(userClass, 'import')] },
    });
    const fn = mkScope({
      id: 'scope:f',
      parent: 'scope:m',
      kind: 'Function',
      range: r(2, 0, 10, 0),
    });
    const ctx = makeCtx([mod, fn], [userClass]);
    const results = buildClassRegistry(ctx).lookup('User', 'scope:f');

    expect(results[0]!.def).toBe(userClass);
    const scopeChain = evidenceOfKind(results[0]!, 'scope-chain');
    expect(scopeChain?.weight).toBe(EvidenceWeights.scopeChainPerDepth * 1);
  });

  it('enforces hard shadow: outer bindings are ignored once a name is bound at an inner scope', () => {
    const outerClass = mkDef({ nodeId: 'def:outer', type: 'Class' });
    const innerVar = mkDef({ nodeId: 'def:inner', type: 'Variable' });
    const mod = mkScope({
      id: 'scope:m',
      parent: null,
      bindings: { User: [mkBinding(outerClass, 'local')] },
    });
    const fn = mkScope({
      id: 'scope:f',
      parent: 'scope:m',
      kind: 'Function',
      range: r(2, 0, 10, 0),
      bindings: { User: [mkBinding(innerVar, 'local')] },
    });
    const ctx = makeCtx([mod, fn], [outerClass, innerVar]);

    // Inner binding is a Variable (not a Class) → class registry returns empty.
    const results = buildClassRegistry(ctx).lookup('User', 'scope:f');
    expect(results).toEqual([]);
  });

  it('emits origin=import evidence when the binding is imported', () => {
    const userClass = mkDef({ nodeId: 'def:User', type: 'Class' });
    const mod = mkScope({
      id: 'scope:m',
      parent: null,
      bindings: { User: [mkBinding(userClass, 'import')] },
    });
    const ctx = makeCtx([mod], [userClass]);
    const res = buildClassRegistry(ctx).lookup('User', 'scope:m');
    expect(evidenceOfKind(res[0]!, 'import')?.weight).toBe(EvidenceWeights.import);
  });
});

// ─── §4.2 Step 5 — arity filter ────────────────────────────────────────────

describe('Step 5: arity filter', () => {
  it('drops incompatible candidates when at least one compatible candidate exists', () => {
    const save2 = mkDef({
      nodeId: 'def:save-two',
      type: 'Method',
      qualifiedName: 'User.save',
      parameterCount: 2,
    });
    const save1 = mkDef({
      nodeId: 'def:save-one',
      type: 'Method',
      qualifiedName: 'User.save',
      parameterCount: 1,
    });
    const mod = mkScope({
      id: 'scope:m',
      parent: null,
      bindings: { save: [mkBinding(save2, 'local'), mkBinding(save1, 'local')] },
    });
    const ctx = makeCtx([mod], [save2, save1], {
      arity: (callsite, def) => {
        const count = def.parameterCount ?? 0;
        if (count === callsite.arity) return 'compatible';
        return 'incompatible';
      },
    });
    const results = buildMethodRegistry(ctx).lookup('save', 'scope:m', {
      callsite: { arity: 1 },
    });
    expect(results).toHaveLength(1);
    expect(results[0]!.def.nodeId).toBe('def:save-one');
    expect(evidenceOfKind(results[0]!, 'arity-match')?.weight).toBe(
      EvidenceWeights.arityMatchCompatible,
    );
  });

  it('keeps incompatible candidates when no compatible candidate exists (soft penalty)', () => {
    const save3 = mkDef({
      nodeId: 'def:save-three',
      type: 'Method',
      qualifiedName: 'User.save',
      parameterCount: 3,
    });
    const mod = mkScope({
      id: 'scope:m',
      parent: null,
      bindings: { save: [mkBinding(save3, 'local')] },
    });
    const ctx = makeCtx([mod], [save3], {
      arity: () => 'incompatible',
    });
    const results = buildMethodRegistry(ctx).lookup('save', 'scope:m', {
      callsite: { arity: 1 },
    });
    expect(results).toHaveLength(1);
    expect(evidenceOfKind(results[0]!, 'arity-match')?.weight).toBe(
      EvidenceWeights.arityMatchIncompatible,
    );
  });

  it('records arity=unknown when the provider is missing (neutral signal)', () => {
    const m = mkDef({ nodeId: 'def:m', type: 'Method', qualifiedName: 'C.m' });
    const mod = mkScope({
      id: 'scope:m',
      parent: null,
      bindings: { m: [mkBinding(m, 'local')] },
    });
    const ctx = makeCtx([mod], [m]); // no arity provider
    const results = buildMethodRegistry(ctx).lookup('m', 'scope:m', {
      callsite: { arity: 7 },
    });
    expect(evidenceOfKind(results[0]!, 'arity-match')?.weight).toBe(
      EvidenceWeights.arityMatchUnknown,
    );
  });
});

// ─── §4.2 Step 6 — global-qualified fallback ───────────────────────────────

describe('Step 6: global-qualified fallback', () => {
  const guardedParams = {
    acceptedKinds: ['Class'] as const,
    lexicalNamespace: 'type' as const,
    useReceiverTypeBinding: false,
    ownerScopedContributor: null,
  };

  it.each(['type', 'value', 'both', undefined] as const)(
    'refuses namespace bindings tagged %s at full names and segment prefixes in either lookup namespace',
    (namespace) => {
      const global = mkDef({ nodeId: 'def:global', qualifiedName: 'app.models.User' });
      const claimed = mkDef({ nodeId: 'def:claimed', type: 'Namespace' });
      for (const name of ['app', 'app.models', 'app.models.User']) {
        const mod = mkScope({
          id: 'scope:m',
          parent: null,
          bindings: {
            [name]: [{ ...mkBinding(claimed, 'namespace'), namespace }],
          },
        });
        const fn = mkScope({ id: 'scope:f', parent: mod.id, kind: 'Function' });
        const ctx = makeCtx([mod, fn], [global, claimed]);
        for (const lexicalNamespace of ['type', 'value'] as const) {
          expect(
            lookupCore('app.models.User', fn.id, { ...guardedParams, lexicalNamespace }, ctx),
          ).toEqual([]);
        }
      }
    },
  );

  it.each(['type', 'value', 'both', undefined] as const)(
    'refuses namespace-import edges tagged %s regardless of link state',
    (namespace) => {
      const global = mkDef({ nodeId: 'def:global', qualifiedName: 'app.models.User' });
      const importedNamespace = mkDef({ nodeId: 'def:module', type: 'Namespace' });
      for (const localName of ['app', 'app.models', 'app.models.User']) {
        for (const link of [
          {},
          { targetDefId: importedNamespace.nodeId },
          { linkStatus: 'unresolved' },
        ] as const) {
          const mod = mkScope({
            id: 'scope:m',
            parent: null,
            imports: [
              {
                kind: 'namespace',
                localName,
                namespace,
                targetFile: 'models.ts',
                targetExportedName: '*',
                ...link,
              },
            ],
          });
          const ctx = makeCtx([mod], [global, importedNamespace]);
          for (const lexicalNamespace of ['type', 'value'] as const) {
            expect(
              lookupCore(
                global.qualifiedName!,
                mod.id,
                { ...guardedParams, lexicalNamespace },
                ctx,
              ),
            ).toEqual([]);
          }
        }
      }
    },
  );

  it.each(['type', 'value'] as const)(
    'does not recover an opposite-space exact class binding through %s fallback',
    (lexicalNamespace) => {
      const global = mkDef({ nodeId: 'def:global', qualifiedName: 'app.User' });
      const scope = mkScope({
        id: 'scope:m',
        parent: null,
        bindings: {
          'app.User': [
            {
              ...mkBinding(global, 'import'),
              namespace: lexicalNamespace === 'type' ? 'value' : 'type',
            },
          ],
        },
      });
      expect(
        lookupCore(
          'app.User',
          scope.id,
          { ...guardedParams, lexicalNamespace },
          makeCtx([scope], [global]),
        ),
      ).toEqual([]);
    },
  );

  it('matches prefixes only at dot boundaries', () => {
    const global = mkDef({ nodeId: 'def:global', qualifiedName: 'app.models.User' });
    const claimed = mkDef({ nodeId: 'def:claimed', type: 'Namespace' });
    const mod = mkScope({
      id: 'scope:m',
      parent: null,
      bindings: {
        'app.modelsExtra': [mkBinding(claimed, 'namespace')],
        'app.model': [{ ...mkBinding(claimed, 'namespace'), namespace: 'type' }],
      },
      imports: [
        {
          kind: 'namespace',
          localName: 'app.modelsExtra',
          targetFile: 'models.ts',
          targetExportedName: '*',
        },
        {
          kind: 'namespace',
          localName: 'app.mod',
          namespace: 'both',
          targetFile: 'models.ts',
          targetExportedName: '*',
        },
      ],
    });
    expect(
      lookupCore(global.qualifiedName!, mod.id, guardedParams, makeCtx([mod], [global, claimed]))[0]
        ?.def,
    ).toBe(global);
  });

  it('preserves canonical fallback past an untagged non-namespace local prefix', () => {
    const global = mkDef({ nodeId: 'def:global', qualifiedName: 'app.User' });
    const local = mkDef({ nodeId: 'def:local', type: 'Variable' });
    const mod = mkScope({
      id: 'scope:m',
      parent: null,
      bindings: {
        app: [mkBinding(local, 'local')],
      },
    });
    expect(
      lookupCore('app.User', mod.id, guardedParams, makeCtx([mod], [global, local]))[0]?.def,
    ).toBe(global);
  });

  it.each(['type', undefined] as const)(
    'preserves omitted selectors and direct canonical lookup despite a namespace prefix tagged %s',
    (namespace) => {
      const global = mkDef({ nodeId: 'def:global', qualifiedName: 'app.User' });
      const claimed = mkDef({ nodeId: 'def:claimed', type: 'Namespace' });
      const mod = mkScope({
        id: 'scope:m',
        parent: null,
        bindings: {
          app: [{ ...mkBinding(claimed, 'namespace'), namespace }],
        },
      });
      const ctx = makeCtx([mod], [global, claimed]);
      const legacyParams = {
        acceptedKinds: guardedParams.acceptedKinds,
        useReceiverTypeBinding: false,
        ownerScopedContributor: null,
      };
      expect(lookupCore('app.User', mod.id, legacyParams, ctx)[0]?.def).toBe(global);
      expect(lookupQualified('app.User', { acceptedKinds: ['Class'] }, ctx)[0]?.def).toBe(global);
    },
  );

  it.each(['value', undefined] as const)(
    'keeps an exact lexical success ahead of a namespace prefix tagged %s',
    (namespace) => {
      const local = mkDef({ nodeId: 'def:local' });
      const global = mkDef({ nodeId: 'def:global', qualifiedName: 'app.User' });
      const mod = mkScope({
        id: 'scope:m',
        parent: null,
        bindings: {
          app: [{ ...mkBinding(global, 'namespace'), namespace }],
          'app.User': [{ ...mkBinding(local, 'import'), namespace: 'type' }],
        },
      });
      expect(
        lookupCore('app.User', mod.id, guardedParams, makeCtx([mod], [local, global])).map(
          (hit) => hit.def,
        ),
      ).toEqual([local]);
    },
  );

  it.each(['missing-start', 'missing-parent', 'cycle'] as const)(
    'refuses guarded fallback for a %s scope chain',
    (shape) => {
      const global = mkDef({ nodeId: 'def:global', qualifiedName: 'app.User' });
      const scope = mkScope({
        id: 'scope:m',
        parent: shape === 'cycle' ? 'scope:m' : 'scope:missing',
      });
      const ctx: RegistryContext = {
        ...makeCtx([], [global]),
        scopes: {
          getScope: (id) => (shape !== 'missing-start' && id === scope.id ? scope : undefined),
        },
      };
      expect(lookupCore('app.User', scope.id, guardedParams, ctx)).toEqual([]);
    },
  );

  it('falls back to the qualified-name index when no lexical candidate is found', () => {
    const cls = mkDef({ nodeId: 'def:app.User', qualifiedName: 'app.User', type: 'Class' });
    const mod = mkScope({ id: 'scope:m', parent: null }); // no lexical binding
    const ctx = makeCtx([mod], [cls]);
    const results = buildClassRegistry(ctx).lookup('app.User', 'scope:m');
    expect(results).toHaveLength(1);
    expect(results[0]!.def).toBe(cls);
    expect(evidenceOfKind(results[0]!, 'global-qualified')?.weight).toBe(
      EvidenceWeights.globalQualified,
    );
  });

  it('does NOT consult the global index when a lexical hit exists (shadowing)', () => {
    const localCls = mkDef({ nodeId: 'def:local', type: 'Class' });
    const globalCls = mkDef({
      nodeId: 'def:global',
      qualifiedName: 'other.User',
      type: 'Class',
    });
    const mod = mkScope({
      id: 'scope:m',
      parent: null,
      bindings: { User: [mkBinding(localCls, 'local')] },
    });
    const ctx = makeCtx([mod], [localCls, globalCls]);
    const results = buildClassRegistry(ctx).lookup('User', 'scope:m');
    expect(results).toHaveLength(1);
    expect(results[0]!.def).toBe(localCls);
  });

  it('does NOT apply the global fallback for non-dotted names', () => {
    const cls = mkDef({ nodeId: 'def:x', qualifiedName: 'User', type: 'Class' });
    const mod = mkScope({ id: 'scope:m', parent: null });
    const ctx = makeCtx([mod], [cls]);
    // 'User' has no dot → no qname fallback.
    const results = buildClassRegistry(ctx).lookup('User', 'scope:m');
    expect(results).toEqual([]);
  });
});

// ─── §4.2 Step 7 — tie-breaks ──────────────────────────────────────────────

describe('Step 7: tie-break cascade', () => {
  it('inner scope shadows outer, yielding single result (hard-shadow baseline)', () => {
    // Baseline: the hard-shadow rule in Step 1 means a near binding fully
    // replaces the far one. No "confidence DESC" ordering to observe here
    // because there is only one candidate — the far class never enters
    // the result set. See the next test for true multi-candidate ranking.
    const nearClass = mkDef({ nodeId: 'def:near', type: 'Class' });
    const farClass = mkDef({ nodeId: 'def:far', type: 'Class' });
    const mod = mkScope({
      id: 'scope:m',
      parent: null,
      bindings: { User: [mkBinding(farClass, 'local')] },
    });
    const fn = mkScope({
      id: 'scope:f',
      parent: 'scope:m',
      kind: 'Function',
      range: r(2, 0, 10, 0),
      bindings: { User: [mkBinding(nearClass, 'local')] },
    });
    const ctx = makeCtx([mod, fn], [nearClass, farClass]);
    const results = buildClassRegistry(ctx).lookup('User', 'scope:f');

    expect(results).toHaveLength(1);
    expect(results[0]!.def).toBe(nearClass);
  });

  it('orders multiple same-scope candidates by confidence DESC', () => {
    // Two candidates co-exist at the same scope, one with origin=local
    // (weight 0.55) and one with origin=wildcard (weight 0.30). Both pass
    // the Class kind filter; confidence DESC should sort local first.
    const localClass = mkDef({ nodeId: 'def:local', type: 'Class' });
    const wildcardClass = mkDef({ nodeId: 'def:wildcard', type: 'Class' });
    const mod = mkScope({
      id: 'scope:m',
      parent: null,
      bindings: {
        User: [mkBinding(wildcardClass, 'wildcard'), mkBinding(localClass, 'local')],
      },
    });
    const ctx = makeCtx([mod], [localClass, wildcardClass]);
    const results = buildClassRegistry(ctx).lookup('User', 'scope:m');
    expect(results).toHaveLength(2);
    expect(results[0]!.def).toBe(localClass); // local (0.55) > wildcard (0.30)
    expect(results[1]!.def).toBe(wildcardClass);
    expect(results[0]!.confidence).toBeGreaterThan(results[1]!.confidence);
  });

  it('breaks ties by DefId.localeCompare when all secondary keys are equal', () => {
    const a = mkDef({ nodeId: 'def:aaa', type: 'Class' });
    const b = mkDef({ nodeId: 'def:bbb', type: 'Class' });
    const mod = mkScope({
      id: 'scope:m',
      parent: null,
      bindings: { User: [mkBinding(b, 'local'), mkBinding(a, 'local')] }, // reversed
    });
    const ctx = makeCtx([mod], [a, b]);
    const results = buildClassRegistry(ctx).lookup('User', 'scope:m');
    expect(results[0]!.def.nodeId).toBe('def:aaa');
    expect(results[1]!.def.nodeId).toBe('def:bbb');
  });
});

// ─── Corroborators: unresolved-import cap (per-signal) ─────────────────────

describe('unresolved-import cap (per-signal)', () => {
  it('halves the import evidence weight when via.linkStatus is unresolved', () => {
    const cls = mkDef({ nodeId: 'def:User', type: 'Class' });
    const unresolvedEdge: ImportEdge = {
      localName: 'User',
      targetFile: null,
      targetExportedName: 'User',
      kind: 'named',
      linkStatus: 'unresolved',
    };
    const mod = mkScope({
      id: 'scope:m',
      parent: null,
      bindings: { User: [mkBinding(cls, 'import', unresolvedEdge)] },
    });
    const ctx = makeCtx([mod], [cls]);
    const results = buildClassRegistry(ctx).lookup('User', 'scope:m');
    const importEv = evidenceOfKind(results[0]!, 'import');
    expect(importEv?.weight).toBe(
      EvidenceWeights.import * EvidenceWeights.unlinkedImportMultiplier,
    );
  });

  it('leaves arity & owner-match signals unaffected by the unresolved-import cap', () => {
    const m = mkDef({
      nodeId: 'def:m',
      type: 'Method',
      qualifiedName: 'User.save',
      parameterCount: 1,
    });
    const unresolved: ImportEdge = {
      localName: 'save',
      targetFile: null,
      targetExportedName: 'save',
      kind: 'named',
      linkStatus: 'unresolved',
    };
    const mod = mkScope({
      id: 'scope:m',
      parent: null,
      bindings: { save: [mkBinding(m, 'import', unresolved)] },
    });
    const ctx = makeCtx([mod], [m], {
      arity: () => 'compatible',
    });
    const results = buildMethodRegistry(ctx).lookup('save', 'scope:m', {
      callsite: { arity: 1 },
    });
    expect(evidenceOfKind(results[0]!, 'arity-match')?.weight).toBe(
      EvidenceWeights.arityMatchCompatible,
    );
  });
});

// ─── Corroborators: dynamic-unresolved degraded signal ─────────────────────

describe('dynamic-unresolved passthrough', () => {
  it('emits a degraded dynamic-import-unresolved signal for dynamic edges', () => {
    const cls = mkDef({ nodeId: 'def:X', type: 'Class' });
    const dynEdge: ImportEdge = {
      localName: 'X',
      targetFile: null,
      targetExportedName: '',
      kind: 'dynamic-unresolved',
    };
    const mod = mkScope({
      id: 'scope:m',
      parent: null,
      bindings: { X: [mkBinding(cls, 'import', dynEdge)] },
    });
    const ctx = makeCtx([mod], [cls]);
    const results = buildClassRegistry(ctx).lookup('X', 'scope:m');
    expect(evidenceOfKind(results[0]!, 'dynamic-import-unresolved')?.weight).toBe(
      EvidenceWeights.dynamicImportUnresolved,
    );
  });
});

// ─── lookupQualified helper (§4.5) ─────────────────────────────────────────

describe('lookupQualified (§4.5)', () => {
  it('filters by acceptedKinds', () => {
    const cls = mkDef({ nodeId: 'def:c', qualifiedName: 'app.User', type: 'Class' });
    const fn = mkDef({ nodeId: 'def:f', qualifiedName: 'app.User', type: 'Function' });
    const ctx = makeCtx([mkScope({ id: 'scope:m', parent: null })], [cls, fn]);
    const results = lookupQualified('app.User', { acceptedKinds: ['Class'] }, ctx);
    expect(results).toHaveLength(1);
    expect(results[0]!.def).toBe(cls);
  });

  it('returns empty for unknown qualified names', () => {
    const ctx = makeCtx([mkScope({ id: 'scope:m', parent: null })], []);
    expect(lookupQualified('app.Ghost', { acceptedKinds: ['Class'] }, ctx)).toEqual([]);
  });

  it('orders multiple partial-class defs deterministically by defId', () => {
    const a = mkDef({ nodeId: 'def:aaa', qualifiedName: 'app.User', type: 'Class' });
    const b = mkDef({ nodeId: 'def:bbb', qualifiedName: 'app.User', type: 'Class' });
    const ctx = makeCtx([mkScope({ id: 'scope:m', parent: null })], [b, a]);
    const results = lookupQualified('app.User', { acceptedKinds: ['Class'] }, ctx);
    expect(results.map((r) => r.def.nodeId)).toEqual(['def:aaa', 'def:bbb']);
  });
});

// ─── lookupCore with owner-scoped contributor (Step 3) ─────────────────────

describe('Step 3: owner-scoped contributor', () => {
  it('merges contributor hits as origin=local at the receiver scope', () => {
    const userClass = mkDef({ nodeId: 'def:User', type: 'Class', qualifiedName: 'User' });
    const saveMethod = mkDef({
      nodeId: 'def:User.save',
      type: 'Method',
      qualifiedName: 'User.save',
      ownerId: 'def:User',
    });
    const mod = mkScope({ id: 'scope:m', parent: null });
    const ctx = makeCtx([mod], [userClass, saveMethod]);
    const results = buildMethodRegistry(ctx).lookup('save', 'scope:m', {
      ownerScopedContributor: {
        ownerDefId: 'def:User',
        byName: (n) => (n === 'save' ? [saveMethod] : []),
      },
    });
    expect(results).toHaveLength(1);
    expect(results[0]!.def).toBe(saveMethod);
    expect(evidenceOfKind(results[0]!, 'local')?.weight).toBe(EvidenceWeights.local);
    expect(evidenceOfKind(results[0]!, 'owner-match')?.weight).toBe(EvidenceWeights.ownerMatch);
  });
});

// ─── Step 2: type-binding / MRO walk ───────────────────────────────────────

describe('Step 2: type-binding + MRO walk', () => {
  it('emits type-binding evidence with MRO-depth-decayed weight (explicit receiver)', () => {
    const userClass = mkDef({ nodeId: 'def:User', type: 'Class', qualifiedName: 'User' });
    const saveMethod = mkDef({
      nodeId: 'def:User.save',
      type: 'Method',
      qualifiedName: 'User.save',
      ownerId: 'def:User',
    });
    const callScope = mkScope({
      id: 'scope:call',
      parent: null,
      bindings: { User: [mkBinding(userClass, 'local')] },
      typeBindings: { user: typeRef('User', 'scope:call') },
    });
    const ctx = makeCtx([callScope], [userClass, saveMethod]);
    const results = buildMethodRegistry(ctx).lookup('save', 'scope:call', {
      explicitReceiver: { name: 'user' },
    });
    expect(results).toHaveLength(1);
    expect(results[0]!.def).toBe(saveMethod);
    const typeBinding = evidenceOfKind(results[0]!, 'type-binding');
    expect(typeBinding?.weight).toBe(EvidenceWeights.typeBindingByMroDepth[0]);
  });

  it('demotes Step-2-only candidates to tieBreakKey.origin=import (pins rank vs same-origin siblings)', () => {
    // Two method defs named `impl`, both owned by the same interface and
    // both reached ONLY via the Step 2 type-binding MRO walk (no lexical
    // binding). Each candidate's `recordTypeBindingHit` path demotes its
    // `tieBreakKey.origin` from the `ensureCandidate` default `'local'`
    // to `'import'`. With both at equal confidence (owner-match + type-
    // binding at depth 0), the tie-break cascade must fall through
    // scope-depth / MRO-depth / origin (all equal) to DefId.localeCompare.
    //
    // If the demotion regressed (e.g., tieBreakKey.origin left as `'local'`),
    // both candidates would still share the same origin and this test would
    // pass by coincidence — so the test ALSO asserts `signals.origin` is
    // absent from the evidence list (no false where-found weight emitted),
    // which is the strongest observable invariant the demotion guarantees.
    const iface = mkDef({
      nodeId: 'def:Iface',
      type: 'Interface',
      qualifiedName: 'Iface',
    });
    const implA = mkDef({
      nodeId: 'def:aaa.impl',
      type: 'Method',
      qualifiedName: 'Iface.impl',
      ownerId: 'def:Iface',
    });
    const implB = mkDef({
      nodeId: 'def:bbb.impl',
      type: 'Method',
      qualifiedName: 'Iface.impl',
      ownerId: 'def:Iface',
    });
    const scope = mkScope({
      id: 'scope:call',
      parent: null,
      bindings: { Iface: [mkBinding(iface, 'local')] },
      typeBindings: { x: typeRef('Iface', 'scope:call') },
    });
    const ctx = makeCtx([scope], [iface, implA, implB]);
    const results = buildMethodRegistry(ctx).lookup('impl', 'scope:call', {
      explicitReceiver: { name: 'x' },
    });
    expect(results).toHaveLength(2);
    // DefId.localeCompare: 'def:aaa.impl' < 'def:bbb.impl'.
    expect(results[0]!.def).toBe(implA);
    expect(results[1]!.def).toBe(implB);
    // Demotion invariant: Step-2-only candidates have no `signals.origin`,
    // so composeEvidence never emits a where-found signal for them.
    for (const res of results) {
      expect(evidenceOfKind(res, 'local')).toBeUndefined();
      expect(evidenceOfKind(res, 'import')).toBeUndefined();
      expect(evidenceOfKind(res, 'type-binding')).toBeDefined();
    }
  });

  it('walks up the MRO when the method is declared on an ancestor', () => {
    const baseClass = mkDef({ nodeId: 'def:Base', type: 'Class', qualifiedName: 'Base' });
    const derivedClass = mkDef({ nodeId: 'def:Derived', type: 'Class', qualifiedName: 'Derived' });
    const saveOnBase = mkDef({
      nodeId: 'def:Base.save',
      type: 'Method',
      qualifiedName: 'Base.save',
      ownerId: 'def:Base',
    });
    const callScope = mkScope({
      id: 'scope:call',
      parent: null,
      bindings: { Derived: [mkBinding(derivedClass, 'local')] },
      typeBindings: { d: typeRef('Derived', 'scope:call') },
    });
    const ctx = makeCtx([callScope], [baseClass, derivedClass, saveOnBase], {
      mro: { 'def:Derived': ['def:Base'] },
    });
    const results = buildMethodRegistry(ctx).lookup('save', 'scope:call', {
      explicitReceiver: { name: 'd' },
    });
    expect(results).toHaveLength(1);
    expect(results[0]!.def).toBe(saveOnBase);
    // MRO depth for Base when receiver is Derived = 1.
    expect(evidenceOfKind(results[0]!, 'type-binding')?.weight).toBe(
      EvidenceWeights.typeBindingByMroDepth[1],
    );
  });
});

describe.each([
  ['method', 'Method', buildMethodRegistry],
  ['field', 'Property', buildFieldRegistry],
] as const)('Step 2: strict %s receiver types', (_label, memberKind, buildRegistry) => {
  const memberOf = (owner: SymbolDefinition): SymbolDefinition =>
    mkDef({
      nodeId: `${owner.nodeId}.member`,
      type: memberKind,
      qualifiedName: `${owner.qualifiedName}.member`,
      ownerId: owner.nodeId,
    });

  it.each([true, false])(
    'forwards exported namespace lookup for receiver types (exported: %s)',
    (exported) => {
      const owner = mkDef({ nodeId: 'def:User', qualifiedName: 'lib.Internal' });
      const collision = mkDef({ nodeId: 'def:collision', qualifiedName: 'ns.Public' });
      const member = memberOf(owner);
      const otherMember = memberOf(collision);
      const lib = mkScope({ id: 'scope:lib', parent: null, filePath: 'lib.ts' });
      const mod = mkScope({
        id: 'scope:m',
        parent: null,
        filePath: 'app.ts',
        imports: [
          {
            kind: 'namespace',
            localName: 'ns',
            namespace: 'type',
            targetFile: 'lib.ts',
            targetModuleScope: lib.id,
            targetExportedName: '*',
          },
        ],
        typeBindings: { receiver: typeRef('ns.Public', 'scope:m') },
      });
      const call = mkScope({
        id: 'scope:call',
        parent: mod.id,
        kind: 'Function',
        filePath: 'app.ts',
        bindings: { ns: [mkBinding(collision, 'local')] },
      });
      const lookups: unknown[][] = [];
      const context: RegistryContext = {
        ...makeCtx([lib, mod, call], [owner, collision, member, otherMember]),
        lookupExport: (scope, name, namespace) => {
          lookups.push([scope, name, namespace]);
          return exported ? [owner] : [];
        },
      };
      const results = buildRegistry(context).lookup('member', call.id, {
        explicitReceiver: { name: 'receiver' },
      });
      expect(results.map((hit) => hit.def)).toEqual(exported ? [member] : []);
      expect(lookups).toEqual([[lib.id, 'Public', 'type']]);
      if (exported) expect(evidenceOfKind(results[0]!, 'type-binding')).toBeDefined();
    },
  );

  it('resolves an imported alias ahead of an unrelated canonical name', () => {
    const owner = mkDef({ nodeId: 'def:User', qualifiedName: 'models.User' });
    const unrelated = mkDef({ nodeId: 'def:Account', qualifiedName: 'Account' });
    const member = memberOf(owner);
    const otherMember = memberOf(unrelated);
    const mod = mkScope({
      id: 'scope:m',
      parent: null,
      bindings: {
        Account: [
          mkBinding(owner, 'import', {
            kind: 'alias',
            localName: 'Account',
            targetExportedName: 'User',
            targetFile: 'models.ts',
            targetDefId: owner.nodeId,
          }),
        ],
      },
      typeBindings: { receiver: typeRef('Account', 'scope:m') },
    });
    const results = buildRegistry(makeCtx([mod], [owner, unrelated, member, otherMember])).lookup(
      'member',
      mod.id,
      { explicitReceiver: { name: 'receiver' } },
    );
    expect(results.map((hit) => hit.def)).toEqual([member]);
    expect(evidenceOfKind(results[0]!, 'type-binding')).toBeDefined();
  });

  it('resolves the annotation at its declaration scope despite callsite shadowing', () => {
    const owner = mkDef({ nodeId: 'def:User', qualifiedName: 'models.User' });
    const shadow = mkDef({ nodeId: 'def:shadow', qualifiedName: 'local.User' });
    const member = memberOf(owner);
    const otherMember = memberOf(shadow);
    const mod = mkScope({
      id: 'scope:m',
      parent: null,
      bindings: { User: [mkBinding(owner, 'import')] },
      typeBindings: { receiver: typeRef('User', 'scope:m') },
    });
    const call = mkScope({
      id: 'scope:call',
      parent: mod.id,
      kind: 'Function',
      bindings: { User: [mkBinding(shadow, 'local')] },
    });
    expect(
      buildRegistry(makeCtx([mod, call], [owner, shadow, member, otherMember]))
        .lookup('member', call.id, { explicitReceiver: { name: 'receiver' } })
        .map((hit) => hit.def),
    ).toEqual([member]);
  });

  it('skips a value-only class binding before resolving an outer type', () => {
    const owner = mkDef({ nodeId: 'def:User', qualifiedName: 'models.User' });
    const shadow = mkDef({ nodeId: 'def:shadow', qualifiedName: 'User' });
    const member = memberOf(owner);
    const otherMember = memberOf(shadow);
    const mod = mkScope({
      id: 'scope:m',
      parent: null,
      bindings: { User: [{ ...mkBinding(owner, 'import'), namespace: 'type' }] },
    });
    const call = mkScope({
      id: 'scope:call',
      parent: mod.id,
      kind: 'Function',
      bindings: { User: [{ ...mkBinding(shadow, 'local'), namespace: 'value' }] },
      typeBindings: { receiver: typeRef('User', 'scope:call') },
    });
    expect(
      buildRegistry(makeCtx([mod, call], [owner, shadow, member, otherMember]))
        .lookup('member', call.id, { explicitReceiver: { name: 'receiver' } })
        .map((hit) => hit.def),
    ).toEqual([member]);
  });

  it.each([
    ['binding', 'type'],
    ['binding', undefined],
    ['import', 'type'],
    ['import', undefined],
    ['unresolved-import', undefined],
  ] as const)('blocks dotted fallback claimed by namespace %s tagged %s', (claim, namespaceTag) => {
    const owner = mkDef({ nodeId: 'def:User', qualifiedName: 'models.User' });
    const namespace = mkDef({ nodeId: 'def:models', type: 'Namespace' });
    const member = memberOf(owner);
    const mod = mkScope({
      id: 'scope:m',
      parent: null,
      bindings:
        claim === 'binding'
          ? { models: [{ ...mkBinding(namespace, 'namespace'), namespace: namespaceTag }] }
          : {},
      imports:
        claim !== 'binding'
          ? [
              {
                kind: 'namespace',
                localName: 'models',
                namespace: namespaceTag,
                targetFile: 'models.ts',
                targetExportedName: '*',
                ...(claim === 'unresolved-import'
                  ? { linkStatus: 'unresolved' as const }
                  : { targetDefId: namespace.nodeId }),
              },
            ]
          : [],
      typeBindings: { receiver: typeRef('models.User', 'scope:m') },
    });
    expect(
      buildRegistry(makeCtx([mod], [owner, namespace, member])).lookup('member', mod.id, {
        explicitReceiver: { name: 'receiver' },
      }),
    ).toEqual([]);
  });

  it.each([
    ['wildcard', 'Class', 'wildcard'],
    ['non-type', 'Function', 'local'],
  ] as const)('refuses a %s target instead of using its canonical owner', (_case, type, origin) => {
    const owner = mkDef({ nodeId: 'def:User', qualifiedName: 'User', type });
    const member = memberOf(owner);
    const mod = mkScope({
      id: 'scope:m',
      parent: null,
      bindings: { User: [mkBinding(owner, origin)] },
      typeBindings: { receiver: typeRef('User', 'scope:m') },
    });
    expect(
      buildRegistry(makeCtx([mod], [owner, member])).lookup('member', mod.id, {
        explicitReceiver: { name: 'receiver' },
      }),
    ).toEqual([]);
  });

  it('stops at an unresolved nearest receiver binding despite a resolvable outer receiver', () => {
    const owner = mkDef({ nodeId: 'def:User', qualifiedName: 'models.User' });
    const member = memberOf(owner);
    const mod = mkScope({
      id: 'scope:m',
      parent: null,
      bindings: { User: [mkBinding(owner, 'import')] },
      typeBindings: { receiver: typeRef('User', 'scope:m') },
    });
    const call = mkScope({
      id: 'scope:call',
      parent: mod.id,
      kind: 'Function',
      typeBindings: { receiver: typeRef('Missing', 'scope:call') },
    });
    expect(
      buildRegistry(makeCtx([mod, call], [owner, member])).lookup('member', call.id, {
        explicitReceiver: { name: 'receiver' },
      }),
    ).toEqual([]);
  });

  it.each([
    ['User', false],
    ['models.User', true],
  ] as const)('allows unbound canonical fallback for %s: %s', (rawName, resolves) => {
    const owner = mkDef({ nodeId: 'def:User', qualifiedName: rawName });
    const member = memberOf(owner);
    const mod = mkScope({
      id: 'scope:m',
      parent: null,
      typeBindings: { receiver: typeRef(rawName, 'scope:m') },
    });
    expect(
      buildRegistry(makeCtx([mod], [owner, member]))
        .lookup('member', mod.id, { explicitReceiver: { name: 'receiver' } })
        .map((hit) => hit.def),
    ).toEqual(resolves ? [member] : []);
  });

  it.each(['self', 'this'])('resolves implicit %s through its lexical type and MRO', (receiver) => {
    const base = mkDef({ nodeId: 'def:Base', qualifiedName: 'models.Base' });
    const owner = mkDef({ nodeId: 'def:Derived', qualifiedName: 'models.Derived' });
    const member = memberOf(base);
    const mod = mkScope({
      id: 'scope:m',
      parent: null,
      bindings: { Derived: [mkBinding(owner, 'import')] },
    });
    const call = mkScope({
      id: 'scope:call',
      parent: mod.id,
      kind: 'Function',
      typeBindings: { [receiver]: typeRef('Derived', mod.id) },
    });
    const results = buildRegistry(
      makeCtx([mod, call], [base, owner, member], {
        mro: { [owner.nodeId]: [base.nodeId] },
      }),
    ).lookup('member', call.id);
    expect(results.map((hit) => hit.def)).toEqual([member]);
    expect(evidenceOfKind(results[0]!, 'type-binding')?.weight).toBe(
      EvidenceWeights.typeBindingByMroDepth[1],
    );
  });
});

// ─── §4.7 invariants ──────────────────────────────────────────────────────

describe('§4.7 invariants', () => {
  it('Resolution has confidence per-candidate (not per-tier)', () => {
    const cls = mkDef({ nodeId: 'def:c', type: 'Class' });
    const mod = mkScope({
      id: 'scope:m',
      parent: null,
      bindings: { X: [mkBinding(cls, 'local')] },
    });
    const ctx = makeCtx([mod], [cls]);
    const results = buildClassRegistry(ctx).lookup('X', 'scope:m');
    expect(typeof results[0]!.confidence).toBe('number');
    expect(results[0]!.confidence).toBeGreaterThan(0);
    expect(results[0]!.confidence).toBeLessThanOrEqual(1);
  });

  it('Resolution confidence is capped at 1.0', () => {
    const cls = mkDef({ nodeId: 'def:c', type: 'Class' });
    const dummyVia: ImportEdge = {
      localName: 'X',
      targetFile: 't.ts',
      targetExportedName: 'X',
      kind: 'named',
    };
    const mod = mkScope({
      id: 'scope:m',
      parent: null,
      // Same def bound via multiple origins — evidence may stack.
      bindings: { X: [mkBinding(cls, 'local', dummyVia)] },
    });
    const ctx = makeCtx([mod], [cls], { arity: () => 'compatible' });
    const results = buildClassRegistry(ctx).lookup('X', 'scope:m');
    expect(results[0]!.confidence).toBeLessThanOrEqual(1);
  });

  it('kind-match evidence is always present (weight 0) for debuggability', () => {
    const cls = mkDef({ nodeId: 'def:c', type: 'Class' });
    const mod = mkScope({
      id: 'scope:m',
      parent: null,
      bindings: { X: [mkBinding(cls, 'local')] },
    });
    const ctx = makeCtx([mod], [cls]);
    const results = buildClassRegistry(ctx).lookup('X', 'scope:m');
    expect(evidenceOfKind(results[0]!, 'kind-match')).toBeDefined();
    expect(evidenceOfKind(results[0]!, 'kind-match')!.weight).toBe(0);
  });

  it('caller can read [0] for one-shot answers', () => {
    const cls = mkDef({ nodeId: 'def:c', type: 'Class' });
    const mod = mkScope({
      id: 'scope:m',
      parent: null,
      bindings: { X: [mkBinding(cls, 'local')] },
    });
    const ctx = makeCtx([mod], [cls]);
    const results = buildClassRegistry(ctx).lookup('X', 'scope:m');
    expect(results[0]!.def).toBe(cls);
  });
});

// ─── Misses ───────────────────────────────────────────────────────────────

describe('misses', () => {
  it('returns empty for an unknown name with no lexical or global hit', () => {
    const mod = mkScope({ id: 'scope:m', parent: null });
    const ctx = makeCtx([mod], []);
    expect(buildClassRegistry(ctx).lookup('Ghost', 'scope:m')).toEqual([]);
  });

  it('filters out candidates whose kind is not in acceptedKinds', () => {
    const method = mkDef({ nodeId: 'def:m', type: 'Method' });
    const mod = mkScope({
      id: 'scope:m',
      parent: null,
      bindings: { save: [mkBinding(method, 'local')] },
    });
    const ctx = makeCtx([mod], [method]);
    // ClassRegistry excludes Method kind → empty.
    expect(buildClassRegistry(ctx).lookup('save', 'scope:m')).toEqual([]);
    // FieldRegistry also excludes Method → empty.
    expect(buildFieldRegistry(ctx).lookup('save', 'scope:m')).toEqual([]);
  });
});

// ─── lookupCore direct invocation ─────────────────────────────────────────

describe('lookupCore direct invocation', () => {
  it('accepts an empty params surface and returns empty for an unknown name', () => {
    const mod = mkScope({ id: 'scope:m', parent: null });
    const ctx = makeCtx([mod], []);
    const results = lookupCore(
      'Ghost',
      'scope:m',
      {
        acceptedKinds: ['Class'],
        useReceiverTypeBinding: false,
        ownerScopedContributor: null,
      },
      ctx,
    );
    expect(results).toEqual([]);
  });
});
