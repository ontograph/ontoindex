/**
 * Unit tests for `resolveTypeRef` (RFC #909 Ring 2 SHARED #916).
 *
 * Covers: local type, parameter/return annotation via scope walk, aliased
 * import, re-exported type, shadowing by local variable, wildcard-origin
 * ignored, qualified-name fallback (unique + ambiguous), broken scope chain,
 * cycle guard.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  resolveTypeRef,
  buildDefIndex,
  buildQualifiedNameIndex,
  type ResolveTypeRefContext,
  type ScopeLookup,
  type BindingRef,
  type ImportEdge,
  type Scope,
  type ScopeId,
  type SymbolDefinition,
  type TypeRef,
} from 'ontoindex-shared';

// ─── Test helpers ───────────────────────────────────────────────────────────

const mkDef = (overrides: Partial<SymbolDefinition> & { nodeId: string }): SymbolDefinition => ({
  nodeId: overrides.nodeId,
  filePath: overrides.filePath ?? 'src/test.ts',
  type: overrides.type ?? 'Class',
  ...overrides,
});

const mkBinding = (
  def: SymbolDefinition,
  origin: BindingRef['origin'],
  via?: ImportEdge,
): BindingRef => ({ def, origin, ...(via !== undefined ? { via } : {}) });

const mkScope = (
  id: ScopeId,
  parent: ScopeId | null,
  bindings: Record<string, BindingRef[]> = {},
  filePath = 'src/test.ts',
  imports: readonly ImportEdge[] = [],
): Scope => ({
  id,
  parent,
  kind: 'Module',
  range: { startLine: 1, startCol: 0, endLine: 100, endCol: 0 },
  filePath,
  bindings: new Map(Object.entries(bindings)),
  ownedDefs: [],
  imports,
  typeBindings: new Map(),
});

const mkLookup = (scopes: Scope[]): ScopeLookup => {
  const byId = new Map(scopes.map((s) => [s.id, s]));
  return { getScope: (id) => byId.get(id) };
};

const mkCtx = (scopes: Scope[], defs: SymbolDefinition[]): ResolveTypeRefContext => ({
  scopes: mkLookup(scopes),
  defIndex: buildDefIndex(defs),
  qualifiedNameIndex: buildQualifiedNameIndex(defs),
});

const typeRef = (
  rawName: string,
  declaredAtScope: ScopeId,
  source: TypeRef['source'] = 'parameter-annotation',
): TypeRef => ({ rawName, declaredAtScope, source });

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('resolveTypeRef: same-scope ambiguity', () => {
  it('rejects two distinct eligible types instead of picking the first', () => {
    const first = mkDef({ nodeId: 'type:first' });
    const second = mkDef({ nodeId: 'type:second' });
    const scope = mkScope('scope:types', null, {
      T: [mkBinding(first, 'local'), mkBinding(second, 'import')],
    });
    expect(resolveTypeRef(typeRef('T', scope.id), mkCtx([scope], [first, second]))).toBeNull();
  });

  it('allows duplicate bindings to the same node', () => {
    const def = mkDef({ nodeId: 'type:one' });
    const scope = mkScope('scope:types', null, {
      T: [mkBinding(def, 'local'), mkBinding(def, 'import')],
    });
    expect(resolveTypeRef(typeRef('T', scope.id), mkCtx([scope], [def]))).toBe(def);
  });
});

describe('resolveTypeRef: exported namespace members', () => {
  const fixture = () => {
    const exported = mkDef({ nodeId: 'def:exported', qualifiedName: 'lib.Internal' });
    const collision = mkDef({ nodeId: 'def:collision', qualifiedName: 'ns.Public' });
    const module = mkScope('scope:lib', null, {}, 'lib.ts');
    const edge: ImportEdge = {
      kind: 'namespace',
      localName: 'ns',
      namespace: 'type',
      targetFile: 'lib.ts',
      targetModuleScope: module.id,
      targetExportedName: '*',
    };
    const declaration = mkScope('scope:declaration', null, {}, 'app.ts', [edge]);
    const lookupExport = vi
      .fn<NonNullable<ResolveTypeRefContext['lookupExport']>>()
      .mockReturnValue([exported]);
    const context = {
      ...mkCtx([module, declaration], [exported, collision]),
      lookupExport,
    };
    return { exported, collision, module, edge, declaration, lookupExport, context };
  };

  it.each(['type', 'both', undefined] as const)(
    'resolves a %s namespace through its actual export spelling',
    (namespace) => {
      const f = fixture();
      const declaration = { ...f.declaration, imports: [{ ...f.edge, namespace }] };
      const context = { ...f.context, scopes: mkLookup([declaration, f.module]) };
      expect(resolveTypeRef(typeRef('ns.Public', declaration.id), context)).toBe(f.exported);
      expect(f.lookupExport).toHaveBeenCalledExactlyOnceWith(f.module.id, 'Public', 'type');
    },
  );

  it('resolves at the annotation declaration despite callsite namespace shadowing', () => {
    const f = fixture();
    const callsite = mkScope('scope:call', f.declaration.id, {
      ns: [mkBinding(f.collision, 'local')],
    });
    const context = { ...f.context, scopes: mkLookup([f.module, f.declaration, callsite]) };
    expect(resolveTypeRef(typeRef('ns.Public', f.declaration.id), context)).toBe(f.exported);
  });

  it('skips a value-only namespace alias to reach the outer type alias', () => {
    const f = fixture();
    const inner = mkScope(
      'scope:inner',
      f.declaration.id,
      {
        ns: [{ ...mkBinding(f.collision, 'local'), namespace: 'value' }],
      },
      'app.ts',
      [{ ...f.edge, namespace: 'value', targetModuleScope: 'scope:missing' }],
    );
    expect(
      resolveTypeRef(typeRef('ns.Public', inner.id), {
        ...f.context,
        scopes: mkLookup([f.module, f.declaration, inner]),
      }),
    ).toBe(f.exported);
  });

  it.each(['local', 'import', 'wildcard'] as const)(
    'stops at a nearer %s alias binding',
    (origin) => {
      const f = fixture();
      const inner = mkScope('scope:inner', f.declaration.id, {
        ns: [mkBinding(f.collision, origin)],
      });
      expect(
        resolveTypeRef(typeRef('ns.Public', inner.id), {
          ...f.context,
          scopes: mkLookup([f.module, f.declaration, inner]),
        }),
      ).toBeNull();
      expect(f.lookupExport).not.toHaveBeenCalled();
    },
  );

  it.each(['unresolved', 'missing-target', 'missing-scope', 'non-module', 'conflict'] as const)(
    'rejects %s namespace evidence without canonical fallback',
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
      const module = state === 'non-module' ? { ...f.module, kind: 'Function' as const } : f.module;
      const otherModule = mkScope('scope:other', null, {}, 'other.ts');
      const declaration = {
        ...f.declaration,
        imports:
          state === 'conflict' ? [edge, { ...f.edge, targetModuleScope: otherModule.id }] : [edge],
      };
      expect(
        resolveTypeRef(typeRef('ns.Public', declaration.id), {
          ...f.context,
          scopes: mkLookup([module, otherModule, declaration]),
        }),
      ).toBeNull();
      expect(f.lookupExport).not.toHaveBeenCalled();
    },
  );

  it('deduplicates namespace edges pointing to the same module', () => {
    const f = fixture();
    const declaration = { ...f.declaration, imports: [f.edge, { ...f.edge }] };
    expect(
      resolveTypeRef(typeRef('ns.Public', declaration.id), {
        ...f.context,
        scopes: mkLookup([f.module, declaration]),
      }),
    ).toBe(f.exported);
    expect(f.lookupExport).toHaveBeenCalledTimes(1);
  });

  it('accepts a linked namespace binding with its matching import edge', () => {
    const f = fixture();
    const namespace = mkDef({ nodeId: 'def:namespace', type: 'Namespace' });
    const declaration = {
      ...f.declaration,
      bindings: new Map([
        ['ns', [{ ...mkBinding(namespace, 'namespace', f.edge), namespace: 'type' as const }]],
      ]),
    };
    expect(
      resolveTypeRef(typeRef('ns.Public', declaration.id), {
        ...f.context,
        scopes: mkLookup([f.module, declaration]),
      }),
    ).toBe(f.exported);
  });

  it('rejects a value-only namespace import despite an unrelated canonical hit', () => {
    const f = fixture();
    const declaration = { ...f.declaration, imports: [{ ...f.edge, namespace: 'value' as const }] };
    expect(
      resolveTypeRef(typeRef('ns.Public', declaration.id), {
        ...f.context,
        scopes: mkLookup([f.module, declaration]),
      }),
    ).toBeNull();
    expect(f.lookupExport).not.toHaveBeenCalled();
  });

  it.each(['binding', 'via'] as const)(
    'filters %s tags before a namespace binding shadows an outer type alias',
    (source) => {
      for (const tag of ['type', 'value', 'both', undefined] as const) {
        const f = fixture();
        const namespace = mkDef({ nodeId: 'def:namespace', type: 'Namespace' });
        const inner = mkScope('scope:inner', f.declaration.id, {
          ns: [
            {
              ...mkBinding(namespace, 'namespace', {
                ...f.edge,
                namespace: source === 'via' ? tag : 'both',
                targetModuleScope: 'scope:missing',
              }),
              namespace: source === 'binding' ? tag : 'both',
            },
          ],
        });
        const result = resolveTypeRef(typeRef('ns.Public', inner.id), {
          ...f.context,
          scopes: mkLookup([f.module, f.declaration, inner]),
        });
        expect(result).toBe(tag === 'value' ? f.exported : null);
        expect(f.lookupExport).toHaveBeenCalledTimes(tag === 'value' ? 1 : 0);
      }
    },
  );

  it('keeps multiple exported type candidates ambiguous after non-type filtering', () => {
    const f = fixture();
    const functionDef = mkDef({ nodeId: 'def:function', type: 'Function' });
    f.lookupExport.mockReturnValue([functionDef, f.exported]);
    const context = {
      ...f.context,
      defIndex: buildDefIndex([functionDef, f.exported, f.collision]),
    };
    expect(resolveTypeRef(typeRef('ns.Public', f.declaration.id), context)).toBe(f.exported);
    f.lookupExport.mockReturnValue([functionDef, f.exported, f.collision]);
    expect(resolveTypeRef(typeRef('ns.Public', f.declaration.id), context)).toBeNull();
  });

  it.each(['absent', 'wrong-kind', 'dangling', 'ambiguous'] as const)(
    'rejects %s exported definitions without canonical fallback',
    (state) => {
      const f = fixture();
      const wrongKind = mkDef({ nodeId: 'def:function', type: 'Function' });
      const dangling = mkDef({ nodeId: 'def:missing' });
      f.lookupExport.mockReturnValue(
        state === 'absent'
          ? []
          : state === 'wrong-kind'
            ? [wrongKind]
            : state === 'dangling'
              ? [dangling]
              : [f.exported, f.collision],
      );
      expect(
        resolveTypeRef(typeRef('ns.Public', f.declaration.id), {
          ...f.context,
          defIndex: buildDefIndex([f.exported, f.collision, wrongKind]),
        }),
      ).toBeNull();
    },
  );

  it('deduplicates exported IDs and returns their authoritative indexed definition', () => {
    const f = fixture();
    const copy = { ...f.exported, qualifiedName: 'forged.Public' };
    f.lookupExport.mockReturnValue([copy, copy]);
    expect(resolveTypeRef(typeRef('ns.Public', f.declaration.id), f.context)).toBe(f.exported);
  });

  it('checks the indexed kind even if the export callback reports a class', () => {
    const f = fixture();
    const indexed = { ...f.exported, type: 'Function' as const };
    expect(
      resolveTypeRef(typeRef('ns.Public', f.declaration.id), {
        ...f.context,
        defIndex: buildDefIndex([indexed, f.collision]),
      }),
    ).toBeNull();
  });

  it('keeps exact lexical resolution ahead of namespace traversal', () => {
    const f = fixture();
    const declaration = {
      ...f.declaration,
      bindings: new Map([['ns.Public', [mkBinding(f.collision, 'local')]]]),
    };
    expect(
      resolveTypeRef(typeRef('ns.Public', declaration.id), {
        ...f.context,
        scopes: mkLookup([f.module, declaration]),
      }),
    ).toBe(f.collision);
    expect(f.lookupExport).not.toHaveBeenCalled();
  });

  it('does not admit deeper namespace traversal', () => {
    const f = fixture();
    const global = mkDef({ nodeId: 'def:deep', qualifiedName: 'ns.nested.Public' });
    expect(
      resolveTypeRef(typeRef(global.qualifiedName!, f.declaration.id), {
        ...f.context,
        defIndex: buildDefIndex([f.exported, global]),
        qualifiedNameIndex: buildQualifiedNameIndex([global]),
      }),
    ).toBeNull();
    expect(f.lookupExport).not.toHaveBeenCalled();
  });

  it('preserves fail-closed namespace behavior when lookupExport is absent', () => {
    const f = fixture();
    const { lookupExport: _lookupExport, ...context } = f.context;
    expect(resolveTypeRef(typeRef('ns.Public', f.declaration.id), context)).toBeNull();
  });
});

describe('resolveTypeRef', () => {
  describe('lexical namespaces', () => {
    it('skips value-only bindings before shadowing, even when they target a class', () => {
      const outer = mkDef({ nodeId: 'def:outer' });
      const inner = mkDef({ nodeId: 'def:inner' });
      const mod = mkScope('scope:m', null, {
        Name: [{ ...mkBinding(outer, 'local'), namespace: 'type' }],
      });
      const fn = mkScope('scope:f', mod.id, {
        Name: [{ ...mkBinding(inner, 'local'), namespace: 'value' }],
      });
      expect(resolveTypeRef(typeRef('Name', fn.id), mkCtx([mod, fn], [outer, inner]))).toBe(outer);
    });

    it.each(['type', 'both', undefined] as const)(
      'accepts a %s binding from a mixed bucket',
      (namespace) => {
        const valueDef = mkDef({ nodeId: 'def:value' });
        const typeDef = mkDef({ nodeId: 'def:type' });
        const scope = mkScope('scope:m', null, {
          Name: [
            { ...mkBinding(valueDef, 'local'), namespace: 'value' },
            { ...mkBinding(typeDef, 'local'), ...(namespace !== undefined ? { namespace } : {}) },
          ],
        });
        expect(resolveTypeRef(typeRef('Name', scope.id), mkCtx([scope], [valueDef, typeDef]))).toBe(
          typeDef,
        );
      },
    );

    it.each(['type', 'both', undefined] as const)(
      'retains wrong-kind shadowing for a %s binding',
      (namespace) => {
        const outer = mkDef({ nodeId: 'def:outer' });
        const inner = mkDef({ nodeId: 'def:inner', type: 'Variable' });
        const mod = mkScope('scope:m', null, { Name: [mkBinding(outer, 'local')] });
        const fn = mkScope('scope:f', mod.id, {
          Name: [
            { ...mkBinding(inner, 'local'), ...(namespace !== undefined ? { namespace } : {}) },
          ],
        });
        expect(resolveTypeRef(typeRef('Name', fn.id), mkCtx([mod, fn], [outer, inner]))).toBeNull();
      },
    );
  });

  describe('scope-chain walk', () => {
    it('resolves a local type defined in the same scope', () => {
      const userClass = mkDef({ nodeId: 'def:User', type: 'Class' });
      const moduleScope = mkScope('scope:module', null, {
        User: [mkBinding(userClass, 'local')],
      });
      const ctx = mkCtx([moduleScope], [userClass]);
      const result = resolveTypeRef(typeRef('User', 'scope:module'), ctx);
      expect(result).toBe(userClass);
    });

    it('walks parent scopes when the name is not bound locally (return-annotation case)', () => {
      const userClass = mkDef({ nodeId: 'def:User', type: 'Class' });
      const moduleScope = mkScope('scope:module', null, {
        User: [mkBinding(userClass, 'local')],
      });
      const functionScope = mkScope('scope:fn', 'scope:module');
      const ctx = mkCtx([moduleScope, functionScope], [userClass]);
      const result = resolveTypeRef(typeRef('User', 'scope:fn', 'return-annotation'), ctx);
      expect(result).toBe(userClass);
    });

    it('returns the closest binding when the name is bound at multiple levels', () => {
      const outerUser = mkDef({ nodeId: 'def:outer', type: 'Class' });
      const innerUser = mkDef({ nodeId: 'def:inner', type: 'Class' });
      const moduleScope = mkScope('scope:module', null, {
        User: [mkBinding(outerUser, 'local')],
      });
      const classScope = mkScope('scope:class', 'scope:module', {
        User: [mkBinding(innerUser, 'local')],
      });
      const ctx = mkCtx([moduleScope, classScope], [outerUser, innerUser]);
      const result = resolveTypeRef(typeRef('User', 'scope:class'), ctx);
      expect(result).toBe(innerUser); // inner shadows outer
    });
  });

  describe('import origins', () => {
    it('resolves a plain named import', () => {
      const userClass = mkDef({ nodeId: 'def:User', filePath: 'models.ts', type: 'Class' });
      const moduleScope = mkScope('scope:module', null, {
        User: [mkBinding(userClass, 'import')],
      });
      const ctx = mkCtx([moduleScope], [userClass]);
      expect(resolveTypeRef(typeRef('User', 'scope:module'), ctx)).toBe(userClass);
    });

    it('resolves an aliased import under the alias (e.g., `import { User as Account }`)', () => {
      // In `def save_user(user: Account)` where `Account` is an aliased import
      // of `User`, we resolve `Account` to the underlying `User` class def.
      const userClass = mkDef({ nodeId: 'def:User', filePath: 'models.ts', type: 'Class' });
      const importEdge: ImportEdge = {
        localName: 'Account',
        targetFile: 'models.ts',
        targetExportedName: 'User',
        targetDefId: 'def:User',
        kind: 'alias',
      };
      const moduleScope = mkScope('scope:module', null, {
        Account: [mkBinding(userClass, 'import', importEdge)],
      });
      const ctx = mkCtx([moduleScope], [userClass]);
      expect(resolveTypeRef(typeRef('Account', 'scope:module'), ctx)).toBe(userClass);
    });

    it('returns null for a namespace-origin binding whose def is not a type kind', () => {
      const numpyMod = mkDef({ nodeId: 'def:numpy-mod', type: 'Namespace' });
      // A namespace binding must resolve to a type-kind def to satisfy strict
      // mode. Here the binding is the namespace module itself — `Namespace`
      // is intentionally NOT in `TYPE_KINDS` (see resolve-type-ref.ts), so
      // the binding is treated as a shadowing non-type and we fail fast.
      const moduleScope = mkScope('scope:module', null, {
        np: [mkBinding(numpyMod, 'namespace')],
      });
      const ctx = mkCtx([moduleScope], [numpyMod]);
      expect(resolveTypeRef(typeRef('np', 'scope:module'), ctx)).toBeNull();
    });

    it('resolves a re-exported type (`export { X } from `./y`)', () => {
      const userClass = mkDef({ nodeId: 'def:User', filePath: 'y.ts', type: 'Class' });
      const moduleScope = mkScope('scope:module', null, {
        User: [mkBinding(userClass, 'reexport')],
      });
      const ctx = mkCtx([moduleScope], [userClass]);
      expect(resolveTypeRef(typeRef('User', 'scope:module'), ctx)).toBe(userClass);
    });

    it('ignores wildcard origin — not in the strict set', () => {
      const userClass = mkDef({ nodeId: 'def:User', filePath: 'models.ts', type: 'Class' });
      const moduleScope = mkScope('scope:module', null, {
        User: [mkBinding(userClass, 'wildcard')],
      });
      const ctx = mkCtx([moduleScope], [userClass]);
      // Binding exists but wildcard is not strict → return null (shadow).
      expect(resolveTypeRef(typeRef('User', 'scope:module'), ctx)).toBeNull();
    });

    it('prefers a strict-origin type binding over a non-strict binding at the same scope', () => {
      const wildcardClass = mkDef({ nodeId: 'def:wild', type: 'Class' });
      const importClass = mkDef({ nodeId: 'def:import', type: 'Class' });
      const moduleScope = mkScope('scope:module', null, {
        // The strict-origin binding wins regardless of input order.
        User: [mkBinding(wildcardClass, 'wildcard'), mkBinding(importClass, 'import')],
      });
      const ctx = mkCtx([moduleScope], [wildcardClass, importClass]);
      expect(resolveTypeRef(typeRef('User', 'scope:module'), ctx)).toBe(importClass);
    });
  });

  describe('shadowing (non-type binding fails fast)', () => {
    it('returns null when a local variable shadows an outer imported type', () => {
      // Outer module has `import { User }`; inner function declares `User = 5`.
      // Per RFC §4.6, the local non-type shadows; strict resolver returns null.
      const importedUser = mkDef({ nodeId: 'def:imp', type: 'Class' });
      const localUser = mkDef({ nodeId: 'def:local', type: 'Variable' });
      const moduleScope = mkScope('scope:module', null, {
        User: [mkBinding(importedUser, 'import')],
      });
      const functionScope = mkScope('scope:fn', 'scope:module', {
        User: [mkBinding(localUser, 'local')],
      });
      const ctx = mkCtx([moduleScope, functionScope], [importedUser, localUser]);
      expect(resolveTypeRef(typeRef('User', 'scope:fn'), ctx)).toBeNull();
    });

    it('returns null when the only binding at the declaration scope is a Method', () => {
      const method = mkDef({ nodeId: 'def:m', type: 'Method' });
      const scope = mkScope('scope:class', null, {
        save: [mkBinding(method, 'local')],
      });
      const ctx = mkCtx([scope], [method]);
      expect(resolveTypeRef(typeRef('save', 'scope:class'), ctx)).toBeNull();
    });

    it('does NOT fall through to the qualified-name index when shadowed', () => {
      // Even if `app.User` is a unique type in the qualified-name index, a
      // shadowing non-type binding at the declaration scope should short-circuit.
      const shadowVar = mkDef({ nodeId: 'def:v', type: 'Variable' });
      const globalType = mkDef({
        nodeId: 'def:g',
        qualifiedName: 'app.User',
        type: 'Class',
      });
      const scope = mkScope('scope:s', null, {
        'app.User': [mkBinding(shadowVar, 'local')],
      });
      const ctx = mkCtx([scope], [shadowVar, globalType]);
      expect(resolveTypeRef(typeRef('app.User', 'scope:s'), ctx)).toBeNull();
    });
  });

  describe('dotted qualified-name fallback', () => {
    it.each(['type', 'value', 'both', undefined] as const)(
      'refuses namespace bindings tagged %s at full spelling and nested prefixes',
      (namespace) => {
        const global = mkDef({ nodeId: 'def:global', qualifiedName: 'app.models.User' });
        const claimed = mkDef({ nodeId: 'def:claimed', type: 'Namespace' });
        for (const name of ['app', 'app.models', 'app.models.User']) {
          const mod = mkScope('scope:m', null, {
            [name]: [{ ...mkBinding(claimed, 'namespace'), namespace }],
          });
          const fn = mkScope('scope:f', mod.id);
          expect(
            resolveTypeRef(
              typeRef(global.qualifiedName!, fn.id),
              mkCtx([mod, fn], [global, claimed]),
            ),
          ).toBeNull();
        }
      },
    );

    it.each(['type', 'value', 'both', undefined] as const)(
      'refuses namespace edges tagged %s regardless of link state',
      (namespace) => {
        const global = mkDef({ nodeId: 'def:global', qualifiedName: 'app.models.User' });
        const importedNamespace = mkDef({ nodeId: 'def:module', type: 'Namespace' });
        for (const localName of ['app', 'app.models', 'app.models.User']) {
          for (const link of [
            {},
            { targetDefId: importedNamespace.nodeId },
            { linkStatus: 'unresolved' },
          ] as const) {
            const scope = mkScope('scope:m', null, {}, 'src/test.ts', [
              {
                kind: 'namespace',
                localName,
                namespace,
                targetFile: 'models.ts',
                targetExportedName: '*',
                ...link,
              },
            ]);
            expect(
              resolveTypeRef(
                typeRef(global.qualifiedName!, scope.id),
                mkCtx([scope], [global, importedNamespace]),
              ),
            ).toBeNull();
          }
        }
      },
    );

    it('does not recover a value-only exact class binding through canonical fallback', () => {
      const global = mkDef({ nodeId: 'def:global', qualifiedName: 'app.User' });
      const scope = mkScope('scope:m', null, {
        'app.User': [{ ...mkBinding(global, 'import'), namespace: 'value' }],
      });
      expect(resolveTypeRef(typeRef('app.User', scope.id), mkCtx([scope], [global]))).toBeNull();
    });

    it('requires dot-boundary prefix matches', () => {
      const global = mkDef({ nodeId: 'def:global', qualifiedName: 'app.models.User' });
      const claimed = mkDef({ nodeId: 'def:claimed', type: 'Namespace' });
      const scope = mkScope(
        'scope:m',
        null,
        {
          'app.modelsExtra': [mkBinding(claimed, 'namespace')],
          'app.model': [{ ...mkBinding(claimed, 'namespace'), namespace: 'type' }],
        },
        'src/test.ts',
        [
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
      );
      expect(
        resolveTypeRef(typeRef(global.qualifiedName!, scope.id), mkCtx([scope], [global, claimed])),
      ).toBe(global);
    });

    it('preserves canonical fallback past an untagged non-namespace local prefix', () => {
      const global = mkDef({ nodeId: 'def:global', qualifiedName: 'app.User' });
      const local = mkDef({ nodeId: 'def:local', type: 'Variable' });
      const scope = mkScope('scope:m', null, { app: [mkBinding(local, 'local')] });
      expect(resolveTypeRef(typeRef('app.User', scope.id), mkCtx([scope], [global, local]))).toBe(
        global,
      );
    });

    it.each(['value', undefined] as const)(
      'keeps an exact lexical type success despite a namespace prefix tagged %s',
      (namespace) => {
        const local = mkDef({ nodeId: 'def:local' });
        const global = mkDef({ nodeId: 'def:global', qualifiedName: 'app.User' });
        const scope = mkScope('scope:m', null, {
          app: [{ ...mkBinding(global, 'namespace'), namespace }],
          'app.User': [{ ...mkBinding(local, 'import'), namespace: 'type' }],
        });
        expect(resolveTypeRef(typeRef('app.User', scope.id), mkCtx([scope], [local, global]))).toBe(
          local,
        );
      },
    );

    it.each(['missing-start', 'missing-parent', 'cycle'] as const)(
      'refuses a global hit with a %s scope chain',
      (shape) => {
        const global = mkDef({ nodeId: 'def:global', qualifiedName: 'app.User' });
        const scope = mkScope('scope:m', shape === 'cycle' ? 'scope:m' : 'scope:missing');
        expect(
          resolveTypeRef(
            typeRef('app.User', scope.id),
            mkCtx(shape === 'missing-start' ? [] : [scope], [global]),
          ),
        ).toBeNull();
      },
    );

    it('resolves a unique qualified name when no scope binding matches', () => {
      const userClass = mkDef({
        nodeId: 'def:appUser',
        qualifiedName: 'app.models.User',
        type: 'Class',
      });
      const scope = mkScope('scope:s', null); // no bindings for `app.models.User`
      const ctx = mkCtx([scope], [userClass]);
      expect(resolveTypeRef(typeRef('app.models.User', 'scope:s'), ctx)).toBe(userClass);
    });

    it('does NOT apply the qualified-name fallback for non-dotted names', () => {
      const simple = mkDef({ nodeId: 'def:s', qualifiedName: 'User', type: 'Class' });
      const scope = mkScope('scope:s', null);
      const ctx = mkCtx([scope], [simple]);
      // Even though `User` is in the qname index as `User`, the fallback only
      // fires for dotted names (scope walk is the answer for simple names).
      expect(resolveTypeRef(typeRef('User', 'scope:s'), ctx)).toBeNull();
    });

    it('returns null when the qualified name is ambiguous across type defs', () => {
      const a = mkDef({ nodeId: 'def:a', qualifiedName: 'app.User', type: 'Class' });
      const b = mkDef({ nodeId: 'def:b', qualifiedName: 'app.User', type: 'Class' });
      const scope = mkScope('scope:s', null);
      const ctx = mkCtx([scope], [a, b]);
      expect(resolveTypeRef(typeRef('app.User', 'scope:s'), ctx)).toBeNull();
    });

    it('ignores non-type-kind hits and accepts the single type hit', () => {
      const cls = mkDef({ nodeId: 'def:c', qualifiedName: 'app.User', type: 'Class' });
      const fn = mkDef({ nodeId: 'def:f', qualifiedName: 'app.User', type: 'Function' });
      const scope = mkScope('scope:s', null);
      const ctx = mkCtx([scope], [cls, fn]);
      expect(resolveTypeRef(typeRef('app.User', 'scope:s'), ctx)).toBe(cls);
    });

    it('returns null when no qualified-name hit is a type kind', () => {
      const fn = mkDef({ nodeId: 'def:f', qualifiedName: 'app.User', type: 'Function' });
      const scope = mkScope('scope:s', null);
      const ctx = mkCtx([scope], [fn]);
      expect(resolveTypeRef(typeRef('app.User', 'scope:s'), ctx)).toBeNull();
    });
  });

  describe('robustness', () => {
    it('returns null for a missing type (no scope binding, no qname hit)', () => {
      const scope = mkScope('scope:s', null);
      const ctx = mkCtx([scope], []);
      expect(resolveTypeRef(typeRef('User', 'scope:s'), ctx)).toBeNull();
    });

    it('returns null when the declaredAtScope id is not known to the lookup', () => {
      const ctx = mkCtx([], []);
      expect(resolveTypeRef(typeRef('User', 'scope:missing'), ctx)).toBeNull();
    });

    it('returns null when a parent pointer references an unknown scope (broken chain)', () => {
      const functionScope = mkScope('scope:fn', 'scope:ghost');
      const ctx = mkCtx([functionScope], []);
      expect(resolveTypeRef(typeRef('User', 'scope:fn'), ctx)).toBeNull();
    });

    it('terminates cleanly on a cyclic parent chain (defensive guard)', () => {
      // A well-formed scope tree is acyclic; construction bugs shouldn't hang.
      const a: Scope = mkScope('scope:a', 'scope:b');
      const b: Scope = mkScope('scope:b', 'scope:a');
      const ctx = mkCtx([a, b], []);
      expect(resolveTypeRef(typeRef('User', 'scope:a'), ctx)).toBeNull();
    });

    it('accepts all annotation source flavors uniformly', () => {
      const userClass = mkDef({ nodeId: 'def:User', type: 'Class' });
      const scope = mkScope('scope:s', null, {
        User: [mkBinding(userClass, 'local')],
      });
      const ctx = mkCtx([scope], [userClass]);
      for (const source of [
        'annotation',
        'parameter-annotation',
        'return-annotation',
        'self',
        'assignment-inferred',
        'constructor-inferred',
        'receiver-propagated',
      ] as const) {
        expect(resolveTypeRef(typeRef('User', 'scope:s', source), ctx)).toBe(userClass);
      }
    });
  });
});
