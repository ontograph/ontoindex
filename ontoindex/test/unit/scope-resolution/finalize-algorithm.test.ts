/**
 * Unit tests for `finalize` (RFC #909 Ring 2 SHARED #915).
 *
 * Covers: acyclic chain · single-SCC cycle · multi-SCC · wildcard
 * expansion · re-export flattening · dynamic-unresolved passthrough ·
 * bounded fixpoint cap · module-scope binding materialization · unresolved
 * target · external target · provider `mergeBindings` precedence.
 */

import { describe, it, expect } from 'vitest';
import {
  finalize,
  type FinalizeFile,
  type FinalizeHooks,
  type ParsedImport,
  type BindingRef,
  type SymbolDefinition,
  type ScopeId,
} from 'ontoindex-shared';

// ─── Test helpers ───────────────────────────────────────────────────────────

const def = (
  nodeId: string,
  type: SymbolDefinition['type'] = 'Class',
  qualifiedName?: string,
): SymbolDefinition => ({
  nodeId,
  filePath: 'x',
  type,
  ...(qualifiedName !== undefined ? { qualifiedName } : {}),
});

const file = (
  filePath: string,
  localDefs: SymbolDefinition[] = [],
  parsedImports: ParsedImport[] = [],
): FinalizeFile => ({
  filePath,
  moduleScope: `scope:${filePath}#1:0-9999:0:Module`,
  localDefs: localDefs.map((d) => ({ ...d, filePath })),
  parsedImports,
});

/** Simple hook set: `resolveImportTarget` does a direct path lookup; wildcard
 *  expansion returns the concrete names from the target's own local defs;
 *  `mergeBindings` appends (no precedence logic). */
const defaultHooks = (files: readonly FinalizeFile[]): FinalizeHooks => ({
  resolveImportTarget(targetRaw) {
    if (targetRaw === null || targetRaw.length === 0) return null;
    return files.some((f) => f.filePath === targetRaw) ? targetRaw : null;
  },
  expandsWildcardTo(targetModuleScope) {
    const target = files.find((f) => f.moduleScope === targetModuleScope);
    if (target === undefined) return [];
    return target.localDefs.map((d) => deriveSimple(d)).filter((n): n is string => n !== null);
  },
  mergeBindings(existing, incoming) {
    return [...existing, ...incoming];
  },
});

function deriveSimple(d: SymbolDefinition): string | null {
  const q = d.qualifiedName;
  if (q === undefined || q.length === 0) return null;
  const dot = q.lastIndexOf('.');
  return dot === -1 ? q : q.slice(dot + 1);
}

const named = (localName: string, importedName: string, targetRaw: string): ParsedImport => ({
  kind: 'named',
  localName,
  importedName,
  targetRaw,
});

const aliased = (
  localName: string,
  importedName: string,
  alias: string,
  targetRaw: string,
): ParsedImport => ({ kind: 'alias', localName, importedName, alias, targetRaw });

const namespace = (localName: string, importedName: string, targetRaw: string): ParsedImport => ({
  kind: 'namespace',
  localName,
  importedName,
  targetRaw,
});

const reexport = (localName: string, importedName: string, targetRaw: string): ParsedImport => ({
  kind: 'reexport',
  localName,
  importedName,
  targetRaw,
});

const wildcard = (targetRaw: string): ParsedImport => ({ kind: 'wildcard', targetRaw });

const dynamic = (localName: string, targetRaw: string | null): ParsedImport => ({
  kind: 'dynamic-unresolved',
  localName,
  targetRaw,
});

const firstImport = (out: ReturnType<typeof finalize>, scope: ScopeId) => {
  const imports = out.imports.get(scope);
  return imports?.[0];
};

const bindingsFor = (
  out: ReturnType<typeof finalize>,
  scope: ScopeId,
  name: string,
): readonly BindingRef[] => {
  const scopeBindings = out.bindings.get(scope);
  return scopeBindings?.get(name) ?? [];
};

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('finalize', () => {
  describe('namespace export intersection', () => {
    const exporter = (): FinalizeFile => ({
      ...file('b', [
        def('def:type', 'Interface', 'b.Shared'),
        def('def:value', 'Function', 'b.Shared'),
        def('def:class', 'Class', 'b.Dual'),
      ]),
      exportsByNamespace: {
        type: new Map([
          ['Shared', 'def:type'],
          ['Dual', 'def:class'],
        ]),
        value: new Map([
          ['Shared', 'def:value'],
          ['Dual', 'def:class'],
        ]),
      },
    });

    it('keeps distinct meanings together for an incoming-replaces-existing hook', () => {
      const b = exporter();
      const a = file('a', [], [named('Shared', 'Shared', 'b')]);
      const files = [a, b];
      const seen: (readonly BindingRef[])[] = [];
      const out = finalize(
        { files, workspaceIndex: undefined },
        {
          ...defaultHooks(files),
          mergeBindings(_existing, incoming, scope) {
            if (scope === a.moduleScope) seen.push(incoming);
            return incoming;
          },
        },
      );
      expect(
        out.imports.get(a.moduleScope)?.map((edge) => [edge.targetDefId, edge.namespace]),
      ).toEqual([
        ['def:type', 'type'],
        ['def:value', 'value'],
      ]);
      expect(
        bindingsFor(out, a.moduleScope, 'Shared').map((binding) => [
          binding.def.nodeId,
          binding.namespace,
          binding.via?.namespace,
        ]),
      ).toEqual([
        ['def:type', 'type', 'type'],
        ['def:value', 'value', 'value'],
      ]);
      expect(seen.map((bucket) => bucket.length)).toEqual([2]);
      expect(out.stats).toMatchObject({ totalEdges: 1, linkedEdges: 1, unresolvedEdges: 0 });
    });

    it.each(['type', 'value', 'both', undefined] as const)(
      'intersects %s imports and coalesces a dual-space class by identity',
      (namespace) => {
        const b = exporter();
        const a = file('a', [], [{ ...named('Dual', 'Dual', 'b'), namespace }]);
        const files = [a, b];
        const out = finalize({ files, workspaceIndex: undefined }, defaultHooks(files));
        expect(
          out.imports.get(a.moduleScope)?.map((edge) => [edge.targetDefId, edge.namespace]),
        ).toEqual([['def:class', namespace === undefined ? 'both' : namespace]]);
        expect(bindingsFor(out, a.moduleScope, 'Dual').map((binding) => binding.namespace)).toEqual(
          [namespace === undefined ? 'both' : namespace],
        );
      },
    );

    it('rejects opposite meanings, missing names and dangling explicit IDs without legacy fallback', () => {
      const b: FinalizeFile = {
        ...exporter(),
        exports: new Map([
          ['Shared', 'def:type'],
          ['Missing', 'def:class'],
        ]),
        exportsByNamespace: {
          type: new Map([
            ['Shared', 'def:type'],
            ['Dangling', 'def:absent'],
          ]),
          value: new Map(),
        },
      };
      const a = file(
        'a',
        [],
        [
          { ...named('Shared', 'Shared', 'b'), namespace: 'value' },
          { ...named('Missing', 'Missing', 'b'), namespace: 'type' },
          { ...named('Dangling', 'Dangling', 'b'), namespace: 'type' },
        ],
      );
      const files = [a, b];
      const out = finalize({ files, workspaceIndex: undefined }, defaultHooks(files));
      expect(
        out.imports
          .get(a.moduleScope)
          ?.map((edge) => [edge.namespace, edge.linkStatus, edge.targetDefId]),
      ).toEqual([
        ['value', 'unresolved', undefined],
        ['type', 'unresolved', undefined],
        ['type', 'unresolved', undefined],
      ]);
      expect([...out.bindings.get(a.moduleScope)!]).toEqual([]);
      expect(out.stats).toMatchObject({ totalEdges: 3, linkedEdges: 0, unresolvedEdges: 3 });
    });

    it.each([true, false])('treats empty namespace maps as authoritative: %s', (explicit) => {
      const b: FinalizeFile = {
        ...exporter(),
        exports: new Map([['Shared', 'def:value']]),
        exportsByNamespace: explicit ? { type: new Map(), value: new Map() } : undefined,
      };
      const a = file('a', [], [{ ...named('Shared', 'Shared', 'b'), namespace: 'type' }]);
      const files = [a, b];
      const out = finalize({ files, workspaceIndex: undefined }, defaultHooks(files));
      expect(firstImport(out, a.moduleScope)).toMatchObject(
        explicit
          ? { namespace: 'type', linkStatus: 'unresolved' }
          : { namespace: 'type', targetDefId: 'def:value' },
      );
      expect(bindingsFor(out, a.moduleScope, 'Shared').map((binding) => binding.namespace)).toEqual(
        explicit ? [] : ['type'],
      );
    });

    it('narrows unknown legacy exports without inferring their definition kind', () => {
      const b = file('b', [def('def:value', 'Function', 'b.Shared')]);
      const a = file('a', [], [{ ...named('Shared', 'Shared', 'b'), namespace: 'type' }]);
      const files = [a, b];
      const out = finalize({ files, workspaceIndex: undefined }, defaultHooks(files));
      expect(
        bindingsFor(out, a.moduleScope, 'Shared').map((binding) => [
          binding.def.nodeId,
          binding.namespace,
        ]),
      ).toEqual([['def:value', 'type']]);
    });

    it('retains alias and static reexport restrictions without following reexport closure', () => {
      const b = exporter();
      const a = file(
        'a',
        [],
        [
          { ...aliased('Renamed', 'Shared', 'Renamed', 'b'), namespace: 'type' },
          { ...reexport('Published', 'Shared', 'b'), namespace: 'value' },
        ],
      );
      const c = file('c', [], [named('Published', 'Published', 'a')]);
      const files = [a, b, c];
      const out = finalize({ files, workspaceIndex: undefined }, defaultHooks(files));
      expect(
        out.imports
          .get(a.moduleScope)
          ?.map((edge) => [edge.localName, edge.targetDefId, edge.namespace, edge.transitiveVia]),
      ).toEqual([
        ['Renamed', 'def:type', 'type', undefined],
        ['Published', 'def:value', 'value', ['b']],
      ]);
      expect(firstImport(out, c.moduleScope)?.linkStatus).toBe('unresolved');
    });

    it('expands only hook-selected names, intersects wildcard meanings, and retains duplicate hook ordering', () => {
      const b = exporter();
      const a = file('a', [], [{ ...wildcard('b'), namespace: 'type' }, wildcard('b')]);
      const files = [a, b];
      const buckets: number[] = [];
      const out = finalize(
        { files, workspaceIndex: undefined },
        {
          ...defaultHooks(files),
          expandsWildcardTo: () => ['Shared', 'Missing', 'Shared'],
          mergeBindings(existing, incoming, scope) {
            if (scope === a.moduleScope) buckets.push(incoming.length);
            return [...existing, ...incoming];
          },
        },
      );
      expect(
        out.imports.get(a.moduleScope)?.map((edge) => [edge.targetDefId, edge.namespace]),
      ).toEqual([
        ['def:type', 'type'],
        ['def:type', 'type'],
        ['def:type', 'type'],
        ['def:value', 'value'],
        ['def:type', 'type'],
        ['def:value', 'value'],
      ]);
      expect(buckets).toEqual([1, 1, 2, 2]);
      expect(out.stats).toMatchObject({ totalEdges: 2, linkedEdges: 2, unresolvedEdges: 0 });
    });

    it('links namespace modules even when their optional synthetic definition has no eligible meaning', () => {
      const b = exporter();
      const a = file(
        'a',
        [],
        [
          { ...namespace('module', 'Absent', 'b'), namespace: 'type' },
          { ...namespace('dual', 'Dual', 'b'), namespace: 'type' },
        ],
      );
      const files = [a, b];
      const out = finalize({ files, workspaceIndex: undefined }, defaultHooks(files));
      expect(
        out.imports
          .get(a.moduleScope)
          ?.map((edge) => [
            edge.targetModuleScope,
            edge.targetDefId,
            edge.namespace,
            edge.linkStatus,
          ]),
      ).toEqual([
        [b.moduleScope, undefined, 'type', undefined],
        [b.moduleScope, 'def:class', 'type', undefined],
      ]);
      expect(bindingsFor(out, a.moduleScope, 'module')).toEqual([]);
      expect(bindingsFor(out, a.moduleScope, 'dual')[0]?.namespace).toBe('type');
    });

    it('preserves requested restrictions on dynamic, unresolved, and external targets', () => {
      const a = file(
        'a',
        [],
        [
          { ...dynamic('', 'expr'), namespace: 'type' },
          { ...named('Missing', 'Missing', 'missing'), namespace: 'value' },
          { ...wildcard('missing'), namespace: 'type' },
          { ...named('External', 'External', 'external'), namespace: 'both' },
        ],
      );
      const out = finalize(
        { files: [a], workspaceIndex: undefined },
        {
          ...defaultHooks([a]),
          resolveImportTarget: (raw) => (raw === 'external' ? raw : null),
        },
      );
      expect(
        out.imports
          .get(a.moduleScope)
          ?.map((edge) => [edge.namespace, edge.targetFile, edge.linkStatus]),
      ).toEqual([
        ['type', null, undefined],
        ['value', null, 'unresolved'],
        ['type', null, 'unresolved'],
        ['both', 'external', undefined],
      ]);
      expect([...out.bindings.get(a.moduleScope)!]).toEqual([]);
      expect(out.stats).toMatchObject({ totalEdges: 4, linkedEdges: 2, unresolvedEdges: 2 });
    });

    it('keeps provider precedence authoritative across separate parsed imports', () => {
      const b = exporter();
      const a = file(
        'a',
        [],
        [
          { ...named('Shared', 'Shared', 'b'), namespace: 'type' },
          { ...named('Shared', 'Shared', 'b'), namespace: 'value' },
        ],
      );
      const files = [a, b];
      const out = finalize(
        { files, workspaceIndex: undefined },
        {
          ...defaultHooks(files),
          mergeBindings: (_existing, incoming) => incoming,
        },
      );
      expect(
        bindingsFor(out, a.moduleScope, 'Shared').map((binding) => [
          binding.def.nodeId,
          binding.namespace,
        ]),
      ).toEqual([['def:value', 'value']]);
    });
  });

  describe('trivial / acyclic', () => {
    it('handles an empty workspace', () => {
      const out = finalize({ files: [], workspaceIndex: undefined }, defaultHooks([]));
      expect(out.stats.totalFiles).toBe(0);
      expect(out.stats.totalEdges).toBe(0);
      expect(out.sccs).toEqual([]);
    });

    it('resolves a single named import across two files', () => {
      const b = file('b', [def('def:b.User', 'Class', 'b.User')]);
      const a = file('a', [], [named('User', 'User', 'b')]);
      const files = [a, b];
      const out = finalize({ files, workspaceIndex: undefined }, defaultHooks(files));

      const edge = firstImport(out, a.moduleScope)!;
      expect(edge.kind).toBe('named');
      expect(edge.targetFile).toBe('b');
      expect(edge.targetModuleScope).toBe(b.moduleScope);
      expect(edge.targetDefId).toBe('def:b.User');
      expect(edge.linkStatus).toBeUndefined();
      expect(out.stats.linkedEdges).toBe(1);
      expect(out.stats.unresolvedEdges).toBe(0);
    });

    it('marks an edge unresolved when target file cannot be resolved', () => {
      const a = file('a', [], [named('User', 'User', 'external-pkg')]);
      const out = finalize({ files: [a], workspaceIndex: undefined }, defaultHooks([a]));
      const edge = firstImport(out, a.moduleScope)!;
      expect(edge.linkStatus).toBe('unresolved');
      expect(edge.targetFile).toBeNull();
    });

    it('marks an edge unresolved when target file exists but name is not exported', () => {
      const b = file('b', [def('def:b.Other', 'Class', 'b.Other')]);
      const a = file('a', [], [named('User', 'User', 'b')]);
      const files = [a, b];
      const out = finalize({ files, workspaceIndex: undefined }, defaultHooks(files));
      const edge = firstImport(out, a.moduleScope)!;
      expect(edge.linkStatus).toBe('unresolved');
      // targetFile still known — unresolvability is at the name level.
      expect(edge.targetFile).toBe('b');
    });

    it('passes dynamic-unresolved edges through without linking', () => {
      const a = file('a', [], [dynamic('', 'runtime.computed')]);
      const out = finalize({ files: [a], workspaceIndex: undefined }, defaultHooks([a]));
      const edge = firstImport(out, a.moduleScope)!;
      expect(edge.kind).toBe('dynamic-unresolved');
      expect(edge.targetFile).toBeNull();
      expect(edge.linkStatus).toBeUndefined();
    });
  });

  describe('explicit export maps', () => {
    it('restricts named imports while retaining private local bindings', () => {
      const b: FinalizeFile = {
        ...file('b', [
          def('def:b.Public', 'Class', 'b.Public'),
          def('def:b.Private', 'Class', 'b.Private'),
        ]),
        exports: new Map([['Public', 'def:b.Public']]),
      };
      const a = file('a', [], [named('Public', 'Public', 'b'), named('Private', 'Private', 'b')]);
      const files = [a, b];
      const out = finalize({ files, workspaceIndex: undefined }, defaultHooks(files));

      const edges = out.imports.get(a.moduleScope)!;
      expect(edges[0]!.targetDefId).toBe('def:b.Public');
      expect(edges[1]!.linkStatus).toBe('unresolved');
      expect(edges[1]!.targetDefId).toBeUndefined();
      expect(bindingsFor(out, a.moduleScope, 'Private')).toEqual([]);
      expect(
        bindingsFor(out, b.moduleScope, 'Private').map((binding) => [
          binding.origin,
          binding.def.nodeId,
        ]),
      ).toEqual([['local', 'def:b.Private']]);
    });

    it('resolves exported aliases and default to the original local definition IDs', () => {
      const b: FinalizeFile = {
        ...file('b', [def('def:b.Internal', 'Class', 'b.Internal')]),
        exports: new Map([
          ['Public', 'def:b.Internal'],
          ['default', 'def:b.Internal'],
        ]),
      };
      const a = file(
        'a',
        [],
        [
          named('Public', 'Public', 'b'),
          aliased('Renamed', 'Public', 'Renamed', 'b'),
          named('DefaultValue', 'default', 'b'),
        ],
      );
      const files = [a, b];
      const out = finalize({ files, workspaceIndex: undefined }, defaultHooks(files));

      expect(
        out.imports
          .get(a.moduleScope)!
          .map((edge) => [edge.localName, edge.targetExportedName, edge.targetDefId]),
      ).toEqual([
        ['Public', 'Public', 'def:b.Internal'],
        ['Renamed', 'Public', 'def:b.Internal'],
        ['DefaultValue', 'default', 'def:b.Internal'],
      ]);
      expect(bindingsFor(out, a.moduleScope, 'DefaultValue')[0]!.def.nodeId).toBe('def:b.Internal');
    });

    it('fails closed for missing names and dangling IDs even when local simple names match', () => {
      const b: FinalizeFile = {
        ...file('b', [
          def('def:b.Missing', 'Class', 'b.Missing'),
          def('def:b.Dangling', 'Class', 'b.Dangling'),
        ]),
        exports: new Map([['Dangling', 'def:elsewhere.Dangling']]),
      };
      // A definition in another file must not satisfy B's dangling export ID.
      const c = file('c', [def('def:elsewhere.Dangling', 'Class', 'c.Dangling')]);
      const a = file(
        'a',
        [],
        [named('Missing', 'Missing', 'b'), named('Dangling', 'Dangling', 'b')],
      );
      const files = [a, b, c];
      const out = finalize({ files, workspaceIndex: undefined }, defaultHooks(files));

      expect(
        out.imports.get(a.moduleScope)!.map((edge) => [edge.linkStatus, edge.targetDefId]),
      ).toEqual([
        ['unresolved', undefined],
        ['unresolved', undefined],
      ]);
      expect(bindingsFor(out, a.moduleScope, 'Missing')).toEqual([]);
      expect(bindingsFor(out, a.moduleScope, 'Dangling')).toEqual([]);
    });

    it('distinguishes an empty export map from omitted legacy metadata', () => {
      const legacy = file('legacy', [def('def:legacy.X', 'Class', 'legacy.X')]);
      const explicit: FinalizeFile = {
        ...file('explicit', [def('def:explicit.X', 'Class', 'explicit.X')]),
        exports: new Map(),
      };
      const a = file(
        'a',
        [],
        [named('LegacyX', 'X', 'legacy'), named('ExplicitX', 'X', 'explicit')],
      );
      const files = [a, legacy, explicit];
      const out = finalize({ files, workspaceIndex: undefined }, defaultHooks(files));

      const edges = out.imports.get(a.moduleScope)!;
      expect(edges[0]!.targetDefId).toBe('def:legacy.X');
      expect(edges[1]!.linkStatus).toBe('unresolved');
      expect(edges[1]!.targetDefId).toBeUndefined();
    });

    it('filters wildcard candidates through the export map and resolves exported aliases', () => {
      const b: FinalizeFile = {
        ...file('b', [
          def('def:b.Internal', 'Class', 'b.Internal'),
          def('def:b.Private', 'Class', 'b.Private'),
          def('def:b.Dangling', 'Class', 'b.Dangling'),
        ]),
        exports: new Map([
          ['Public', 'def:b.Internal'],
          ['Dangling', 'def:missing'],
        ]),
      };
      const a = file('a', [], [wildcard('b')]);
      const files = [a, b];
      const hooks: FinalizeHooks = {
        ...defaultHooks(files),
        expandsWildcardTo: () => ['Public', 'Internal', 'Private', 'Dangling'],
      };
      const out = finalize({ files, workspaceIndex: undefined }, hooks);

      expect(
        out.imports.get(a.moduleScope)!.map((edge) => [edge.localName, edge.targetDefId]),
      ).toEqual([['Public', 'def:b.Internal']]);
      expect(bindingsFor(out, a.moduleScope, 'Public')[0]!.origin).toBe('wildcard');
      expect(bindingsFor(out, a.moduleScope, 'Private')).toEqual([]);
    });

    it('links namespace imports to the module without exposing a private matching definition', () => {
      const b: FinalizeFile = {
        ...file('b', [def('def:b.Private', 'Namespace', 'b.Private')]),
        exports: new Map(),
      };
      const a = file('a', [], [namespace('ns', 'Private', 'b')]);
      const files = [a, b];
      const out = finalize({ files, workspaceIndex: undefined }, defaultHooks(files));

      const edge = firstImport(out, a.moduleScope)!;
      expect(edge.targetModuleScope).toBe(b.moduleScope);
      expect(edge.linkStatus).toBeUndefined();
      expect(edge.targetDefId).toBeUndefined();
      expect(bindingsFor(out, a.moduleScope, 'ns')).toEqual([]);
    });

    it('uses export maps for direct reexports without adding transitive resolution', () => {
      const c: FinalizeFile = {
        ...file('c', [def('def:c.Internal', 'Class', 'c.Internal')]),
        exports: new Map([['Public', 'def:c.Internal']]),
      };
      const b: FinalizeFile = {
        ...file(
          'b',
          [],
          [reexport('Public', 'Public', 'c'), reexport('Internal', 'Internal', 'c')],
        ),
        exports: new Map([['Public', 'def:c.Internal']]),
      };
      const a = file('a', [], [named('Public', 'Public', 'b')]);
      const files = [a, b, c];
      const out = finalize({ files, workspaceIndex: undefined }, defaultHooks(files));

      const edges = out.imports.get(b.moduleScope)!;
      expect(edges[0]!.targetDefId).toBe('def:c.Internal');
      expect(edges[0]!.transitiveVia).toEqual(['c']);
      expect(edges[1]!.linkStatus).toBe('unresolved');
      expect(firstImport(out, a.moduleScope)!.linkStatus).toBe('unresolved');
      expect(firstImport(out, a.moduleScope)!.targetDefId).toBeUndefined();
    });
  });

  describe('definition lookup indexes', () => {
    it.each(
      (['named', 'wildcard'] as const).flatMap((kind) =>
        (['explicit', 'legacy'] as const).flatMap((exports) =>
          [128, 256].map((size) => ({ kind, exports, size })),
        ),
      ),
    )(
      'reads definitions linearly for $size distinct $kind imports with $exports exports',
      ({ kind, exports, size }) => {
        const names = Array.from({ length: size }, (_, i) => `Name${i}`);
        const ids = names.map((name) => `def:b.${name}`);
        const b: FinalizeFile = {
          ...file(
            'b',
            names.map((name, i) => def(ids[i]!, 'Class', `b.${name}`)),
          ),
          ...(exports === 'explicit'
            ? { exports: new Map(names.map((name, i) => [name, ids[i]!])) }
            : {}),
        };
        const a = file(
          'a',
          [],
          kind === 'named' ? names.map((name) => named(name, name, 'b')) : [wildcard('b')],
        );
        let nodeIdReads = 0;
        let qualifiedNameReads = 0;
        // Instrument the cloned definitions that finalize actually receives.
        for (const definition of b.localDefs) {
          const { nodeId, qualifiedName } = definition;
          Object.defineProperties(definition, {
            nodeId: {
              enumerable: true,
              get: () => {
                nodeIdReads++;
                return nodeId;
              },
            },
            qualifiedName: {
              enumerable: true,
              get: () => {
                qualifiedNameReads++;
                return qualifiedName;
              },
            },
          });
        }
        const files = [a, b];
        const out = finalize(
          { files, workspaceIndex: undefined },
          {
            ...defaultHooks(files),
            expandsWildcardTo: () => names,
          },
        );
        const reads = { nodeId: nodeIdReads, qualifiedName: qualifiedNameReads };

        expect(reads.nodeId).toBeLessThanOrEqual(24 * size);
        expect(reads.qualifiedName).toBeLessThanOrEqual(24 * size);
        expect(
          out.imports.get(a.moduleScope)!.map((edge) => [edge.localName, edge.targetDefId]),
        ).toEqual(names.map((name, i) => [name, ids[i]]));
        expect(out.bindings.get(a.moduleScope)!.size).toBe(size);
        expect(
          names.map((name) => bindingsFor(out, a.moduleScope, name).map((ref) => ref.def.nodeId)),
        ).toEqual(ids.map((id) => [id]));
      },
    );

    it('keeps the first definition when an explicit provider repeats a definition ID', () => {
      const b: FinalizeFile = {
        ...file('b', [
          def('def:shared', 'Class', 'b.First'),
          def('def:shared', 'Function', 'b.Second'),
        ]),
        exports: new Map([['Public', 'def:shared']]),
      };
      const a = file('a', [], [named('Public', 'Public', 'b')]);
      const files = [a, b];
      const out = finalize({ files, workspaceIndex: undefined }, defaultHooks(files));

      expect(firstImport(out, a.moduleScope)!.targetDefId).toBe('def:shared');
      expect(bindingsFor(out, a.moduleScope, 'Public')).toHaveLength(1);
      expect(bindingsFor(out, a.moduleScope, 'Public')[0]!.def).toBe(b.localDefs[0]);
    });

    it('keeps workspace input order when distinct files repeat a definition ID', () => {
      const first = file('first', [def('def:shared', 'Class', 'first.Other')]);
      const provider: FinalizeFile = {
        ...file('provider', [def('def:shared', 'Function', 'provider.Public')]),
        exports: new Map([['Public', 'def:shared']]),
      };
      const a = file('a', [], [named('Public', 'Public', 'provider')]);
      const files = [first, a, provider];
      const out = finalize({ files, workspaceIndex: undefined }, defaultHooks(files));

      expect(firstImport(out, a.moduleScope)!.targetDefId).toBe('def:shared');
      expect(bindingsFor(out, a.moduleScope, 'Public')[0]!.def).toBe(first.localDefs[0]);
    });

    it('keeps the first legacy name without discarding other names with duplicate IDs', () => {
      const b = file('b', [
        def('def:b.First', 'Class', 'b.Public'),
        def('def:b.Second', 'Function', 'b.nested.Public'),
        def('def:b.First', 'Variable', 'b.Other'),
      ]);
      const a = file('a', [], [named('Public', 'Public', 'b'), named('Other', 'Other', 'b')]);
      const files = [a, b];
      const out = finalize({ files, workspaceIndex: undefined }, defaultHooks(files));

      expect(
        out.imports.get(a.moduleScope)!.map((edge) => [edge.localName, edge.targetDefId]),
      ).toEqual([
        ['Public', 'def:b.First'],
        ['Other', 'def:b.First'],
      ]);
      expect(bindingsFor(out, a.moduleScope, 'Public')[0]!.def).toBe(b.localDefs[0]);
      expect(bindingsFor(out, a.moduleScope, 'Other')[0]!.def).toBe(b.localDefs[0]);
    });

    it.each(['explicit', 'legacy'] as const)(
      'isolates %s lookups between invocations with reused paths and IDs',
      (exports) => {
        const run = (type: SymbolDefinition['type'], name: string) => {
          const b: FinalizeFile = {
            ...file('b', [def('def:b.Shared', type, `b.${name}`)]),
            ...(exports === 'explicit' ? { exports: new Map([[name, 'def:b.Shared']]) } : {}),
          };
          const a = file('a', [], [named(name, name, 'b'), named('Old', 'Old', 'b')]);
          const files = [a, b];
          return { a, b, out: finalize({ files, workspaceIndex: undefined }, defaultHooks(files)) };
        };
        const first = run('Class', 'Old');
        const second = run('Function', 'New');

        expect(bindingsFor(first.out, first.a.moduleScope, 'Old')[0]!.def).toBe(
          first.b.localDefs[0],
        );
        expect(bindingsFor(second.out, second.a.moduleScope, 'New')[0]!.def).toBe(
          second.b.localDefs[0],
        );
        expect(bindingsFor(second.out, second.a.moduleScope, 'Old')).toEqual([]);
        expect(
          second.out.imports
            .get(second.a.moduleScope)!
            .map((edge) => [edge.targetDefId, edge.linkStatus]),
        ).toEqual([
          ['def:b.Shared', undefined],
          [undefined, 'unresolved'],
        ]);
      },
    );
  });

  describe('cycles + bounded fixpoint', () => {
    it('finalizes a two-file cycle (A → B → A) without hanging', () => {
      const a = file('a', [def('def:a.X', 'Class', 'a.X')], [named('Y', 'Y', 'b')]);
      const b = file('b', [def('def:b.Y', 'Class', 'b.Y')], [named('X', 'X', 'a')]);
      const files = [a, b];
      const out = finalize({ files, workspaceIndex: undefined }, defaultHooks(files));

      const aEdge = firstImport(out, a.moduleScope)!;
      const bEdge = firstImport(out, b.moduleScope)!;
      expect(aEdge.targetDefId).toBe('def:b.Y');
      expect(bEdge.targetDefId).toBe('def:a.X');
      expect(out.stats.sccCount).toBeGreaterThanOrEqual(1);
    });

    it('packs cyclic files into a single SCC with isCycle=true', () => {
      const a = file('a', [def('def:a.X', 'Class', 'a.X')], [named('Y', 'Y', 'b')]);
      const b = file('b', [def('def:b.Y', 'Class', 'b.Y')], [named('X', 'X', 'a')]);
      const files = [a, b];
      const out = finalize({ files, workspaceIndex: undefined }, defaultHooks(files));
      const cycles = out.sccs.filter((scc) => scc.isCycle);
      expect(cycles.length).toBe(1);
      expect(cycles[0]!.files.length).toBe(2);
      expect(new Set(cycles[0]!.files)).toEqual(new Set(['a', 'b']));
    });

    it('separates disjoint SCCs', () => {
      // a↔b cycle, c↔d cycle — disjoint.
      const a = file('a', [def('def:a.X', 'Class', 'a.X')], [named('Y', 'Y', 'b')]);
      const b = file('b', [def('def:b.Y', 'Class', 'b.Y')], [named('X', 'X', 'a')]);
      const c = file('c', [def('def:c.P', 'Class', 'c.P')], [named('Q', 'Q', 'd')]);
      const d = file('d', [def('def:d.Q', 'Class', 'd.Q')], [named('P', 'P', 'c')]);
      const files = [a, b, c, d];
      const out = finalize({ files, workspaceIndex: undefined }, defaultHooks(files));
      const cycleSCCs = out.sccs.filter((scc) => scc.isCycle);
      expect(cycleSCCs.length).toBe(2);
    });

    it('reports stats distinguishing linked from unresolved edges in a cycle', () => {
      const a = file(
        'a',
        [def('def:a.X', 'Class', 'a.X')],
        [named('Y', 'Y', 'b'), named('Ghost', 'Ghost', 'b')],
      );
      const b = file('b', [def('def:b.Y', 'Class', 'b.Y')], [named('X', 'X', 'a')]);
      const files = [a, b];
      const out = finalize({ files, workspaceIndex: undefined }, defaultHooks(files));
      expect(out.stats.linkedEdges).toBe(2); // a→b.Y and b→a.X resolve
      expect(out.stats.unresolvedEdges).toBe(1); // a→b.Ghost doesn't
    });

    it('transitions an intra-SCC edge to linkStatus=unresolved when the cap is reached', () => {
      // A↔B cycle; A imports a name that B never exports. The file-level
      // target resolves (b exists), but the name-level lookup never
      // succeeds, so the fixpoint exhausts its cap and we fall through to
      // `linkStatus: 'unresolved'` (distinct from `targetFile: null`).
      const a = file(
        'a',
        [def('def:a.X', 'Class', 'a.X')],
        [named('Ghost', 'Ghost', 'b'), named('Y', 'Y', 'b')],
      );
      const b = file('b', [def('def:b.Y', 'Class', 'b.Y')], [named('X', 'X', 'a')]);
      const files = [a, b];
      const out = finalize({ files, workspaceIndex: undefined }, defaultHooks(files));

      const aEdges = out.imports.get(a.moduleScope) ?? [];
      const ghost = aEdges.find((e) => e.localName === 'Ghost');
      expect(ghost).toBeDefined();
      // Cap-hit distinction: file target is known, but name never resolved.
      expect(ghost!.targetFile).toBe('b');
      expect(ghost!.linkStatus).toBe('unresolved');
      expect(ghost!.targetDefId).toBeUndefined();
    });
  });

  describe('wildcard expansion', () => {
    it('expands `wildcard` into one ImportEdge per exported name', () => {
      const b = file('b', [
        def('def:b.X', 'Class', 'b.X'),
        def('def:b.Y', 'Class', 'b.Y'),
        def('def:b.Z', 'Class', 'b.Z'),
      ]);
      const a = file('a', [], [wildcard('b')]);
      const files = [a, b];
      const out = finalize({ files, workspaceIndex: undefined }, defaultHooks(files));
      const edges = out.imports.get(a.moduleScope) ?? [];
      expect(edges.length).toBe(3);
      expect(edges.every((e) => e.kind === 'wildcard-expanded')).toBe(true);
      expect(new Set(edges.map((e) => e.localName))).toEqual(new Set(['X', 'Y', 'Z']));
      expect(new Set(edges.map((e) => e.targetDefId))).toEqual(
        new Set(['def:b.X', 'def:b.Y', 'def:b.Z']),
      );
    });

    it('leaves a wildcard unresolved when the target file cannot be resolved', () => {
      const a = file('a', [], [wildcard('external-pkg')]);
      const out = finalize({ files: [a], workspaceIndex: undefined }, defaultHooks([a]));
      const edges = out.imports.get(a.moduleScope) ?? [];
      expect(edges.length).toBe(1);
      expect(edges[0]!.linkStatus).toBe('unresolved');
    });

    it('expanded bindings land at `origin: wildcard`', () => {
      const b = file('b', [def('def:b.X', 'Class', 'b.X')]);
      const a = file('a', [], [wildcard('b')]);
      const files = [a, b];
      const out = finalize({ files, workspaceIndex: undefined }, defaultHooks(files));
      const bindings = bindingsFor(out, a.moduleScope, 'X');
      expect(bindings.length).toBeGreaterThanOrEqual(1);
      const imported = bindings.find((br) => br.origin === 'wildcard');
      expect(imported).toBeDefined();
      expect(imported!.def.nodeId).toBe('def:b.X');
    });
  });

  describe('re-export flattening', () => {
    it('sets transitiveVia on reexport edges', () => {
      const c = file('c', [def('def:c.X', 'Class', 'c.X')]);
      const b = file('b', [], [reexport('X', 'X', 'c')]);
      const a = file('a', [], [named('X', 'X', 'b')]);
      const files = [a, b, c];
      const out = finalize({ files, workspaceIndex: undefined }, defaultHooks(files));
      const reexportEdge = firstImport(out, b.moduleScope)!;
      expect(reexportEdge.kind).toBe('reexport');
      expect(reexportEdge.transitiveVia).toEqual(['c']);
    });

    it('multi-hop re-export chains only resolve when intermediate files include the name in localDefs', () => {
      // Contract (see FinalizeFile.localDefs doc): `finalize` looks up
      // `importedName` in `B.localDefs`. If B re-exports X from C but does
      // NOT include X in its own localDefs, A's import of X from B cannot
      // resolve — the fixpoint doesn't mutate localDefs across iterations.
      //
      // This test documents the current behavior: parsers that want
      // multi-hop chains to settle end-to-end must surface re-exported
      // names in the intermediate file's localDefs (with the original
      // source DefId).
      const c = file('c', [def('def:c.X', 'Class', 'c.X')]);
      // Variant 1: B does NOT include X in its own localDefs → A's import
      // fails.
      const bThin = file('b', [], [reexport('X', 'X', 'c')]);
      const aThin = file('a', [], [named('X', 'X', 'b')]);
      const thinFiles = [aThin, bThin, c];
      const thinOut = finalize(
        { files: thinFiles, workspaceIndex: undefined },
        defaultHooks(thinFiles),
      );
      expect(firstImport(thinOut, aThin.moduleScope)!.linkStatus).toBe('unresolved');

      // Variant 2: B includes X in its localDefs (re-exports surfaced) → A resolves.
      const bThick = file(
        'b',
        [def('def:c.X', 'Class', 'b.X')], // B surfaces X with its own qname
        [reexport('X', 'X', 'c')],
      );
      const aThick = file('a', [], [named('X', 'X', 'b')]);
      const thickFiles = [aThick, bThick, c];
      const thickOut = finalize(
        { files: thickFiles, workspaceIndex: undefined },
        defaultHooks(thickFiles),
      );
      expect(firstImport(thickOut, aThick.moduleScope)!.linkStatus).toBeUndefined();
      expect(firstImport(thickOut, aThick.moduleScope)!.targetDefId).toBe('def:c.X');
    });
  });

  describe('aliased + namespace imports', () => {
    it('resolves an alias under its local name while preserving targetExportedName', () => {
      const b = file('b', [def('def:b.User', 'Class', 'b.User')]);
      const a = file('a', [], [aliased('Account', 'User', 'Account', 'b')]);
      const files = [a, b];
      const out = finalize({ files, workspaceIndex: undefined }, defaultHooks(files));
      const edge = firstImport(out, a.moduleScope)!;
      expect(edge.kind).toBe('alias');
      expect(edge.localName).toBe('Account');
      expect(edge.targetExportedName).toBe('User');
      expect(edge.targetDefId).toBe('def:b.User');
    });

    it('records namespace imports with origin=namespace in bindings', () => {
      // Provider emits a synthetic module-representing def so the namespace
      // binding can anchor to a real SymbolDefinition.
      const numpyFile = file('numpy.py', [
        def('def:numpy', 'Namespace', 'numpy'),
        def('def:numpy.array', 'Function', 'numpy.array'),
      ]);
      const a = file('a', [], [namespace('np', 'numpy', 'numpy.py')]);
      const files = [a, numpyFile];
      const out = finalize({ files, workspaceIndex: undefined }, defaultHooks(files));
      const npEdge = firstImport(out, a.moduleScope)!;
      expect(npEdge.kind).toBe('namespace');
      expect(npEdge.targetModuleScope).toBe(numpyFile.moduleScope);

      const bindings = bindingsFor(out, a.moduleScope, 'np');
      expect(bindings.some((b) => b.origin === 'namespace')).toBe(true);
      expect(bindings.find((b) => b.origin === 'namespace')!.def.nodeId).toBe('def:numpy');
    });

    it('links a namespace import to the module scope even when no module-def exists', () => {
      // No synthetic def in target — the edge still resolves to the module
      // scope, just without a `targetDefId`. Bindings materialization skips
      // the binding (no def to anchor to), but the edge itself is linked.
      const numpyFile = file('numpy.py', [def('def:numpy.array', 'Function', 'numpy.array')]);
      const a = file('a', [], [namespace('np', 'numpy', 'numpy.py')]);
      const files = [a, numpyFile];
      const out = finalize({ files, workspaceIndex: undefined }, defaultHooks(files));
      const npEdge = firstImport(out, a.moduleScope)!;
      expect(npEdge.kind).toBe('namespace');
      expect(npEdge.linkStatus).toBeUndefined();
      expect(npEdge.targetModuleScope).toBe(numpyFile.moduleScope);
      expect(npEdge.targetDefId).toBeUndefined();
    });
  });

  describe('module-scope binding materialization', () => {
    it('distinguishes authoritative empty bindings from omitted legacy bindings', () => {
      const legacy = file('legacy', [def('def:legacy.X', 'Class', 'legacy.X')]);
      const explicit: FinalizeFile = {
        ...file('explicit', [def('def:explicit.secret', 'Variable', 'explicit.fn.secret')]),
        localBindings: new Map(),
      };
      const files = [legacy, explicit];
      const out = finalize({ files, workspaceIndex: undefined }, defaultHooks(files));

      expect(bindingsFor(out, legacy.moduleScope, 'X').map((ref) => ref.def.nodeId)).toEqual([
        'def:legacy.X',
      ]);
      expect([...out.bindings.get(explicit.moduleScope)!]).toEqual([]);
      expect(explicit.localDefs).toHaveLength(1);
    });

    it('preserves extracted alias and hoisted buckets without remerging local definitions', () => {
      const base = file('a', [
        def('def:a.X', 'Class', 'a.X'),
        def('def:a.nested.X', 'Class', 'a.fn.X'),
        def('def:a.secret', 'Variable', 'a.fn.secret'),
        def('def:a.hoisted', 'Variable', 'a.fn.hoisted'),
      ]);
      const localBindings = new Map<string, readonly BindingRef[]>([
        ['Alias', [{ def: base.localDefs[0]!, origin: 'local' }]],
        ['hoisted', [{ def: base.localDefs[3]!, origin: 'local' }]],
      ]);
      const original = [...localBindings].map(([name, refs]) => [name, [...refs]]);
      const a: FinalizeFile = { ...base, localBindings };
      const hooks: FinalizeHooks = {
        ...defaultHooks([a]),
        mergeBindings() {
          throw new Error('authoritative local buckets must not be remerged');
        },
      };
      const out = finalize({ files: [a], workspaceIndex: undefined }, hooks);

      expect([...out.bindings.get(a.moduleScope)!]).toEqual(original);
      expect(bindingsFor(out, a.moduleScope, 'X')).toEqual([]);
      expect(bindingsFor(out, a.moduleScope, 'secret')).toEqual([]);
      expect([...localBindings]).toEqual(original);
      expect(a.localDefs).toHaveLength(4);
    });

    it('merges imports into authoritative local buckets with provider precedence without mutating input', () => {
      const base = file('a', [def('def:a.X', 'Class', 'a.X')], [named('X', 'X', 'b')]);
      const refs: readonly BindingRef[] = Object.freeze([
        { def: base.localDefs[0]!, origin: 'local' },
      ]);
      const localBindings = new Map([['X', refs]]);
      const a: FinalizeFile = { ...base, localBindings };
      const b = file('b', [def('def:b.X', 'Class', 'b.X')]);
      const files = [a, b];
      const calls: unknown[] = [];
      const out = finalize(
        { files, workspaceIndex: undefined },
        {
          ...defaultHooks(files),
          mergeBindings(existing, incoming, scope) {
            if (scope === a.moduleScope) calls.push([existing, incoming.map((ref) => ref.origin)]);
            return incoming;
          },
        },
      );

      expect(calls).toEqual([[refs, ['import']]]);
      expect(
        bindingsFor(out, a.moduleScope, 'X').map((ref) => [ref.def.nodeId, ref.origin]),
      ).toEqual([['def:b.X', 'import']]);
      expect([...localBindings]).toEqual([['X', refs]]);
      expect(refs).toEqual([{ def: base.localDefs[0]!, origin: 'local' }]);
    });

    it('lays down local defs with origin=local', () => {
      const a = file('a', [def('def:a.X', 'Class', 'a.X')]);
      const out = finalize({ files: [a], workspaceIndex: undefined }, defaultHooks([a]));
      const bindings = bindingsFor(out, a.moduleScope, 'X');
      expect(bindings.length).toBe(1);
      expect(bindings[0]!.origin).toBe('local');
      expect(bindings[0]!.def.nodeId).toBe('def:a.X');
    });

    it('layers imports on top of local defs via mergeBindings', () => {
      const b = file('b', [def('def:b.User', 'Class', 'b.User')]);
      const a = file('a', [def('def:a.User', 'Class', 'a.User')], [named('User', 'User', 'b')]);
      const files = [a, b];
      const out = finalize({ files, workspaceIndex: undefined }, defaultHooks(files));
      const bindings = bindingsFor(out, a.moduleScope, 'User');
      expect(bindings.length).toBe(2);
      expect(bindings.some((br) => br.origin === 'local')).toBe(true);
      expect(bindings.some((br) => br.origin === 'import')).toBe(true);
    });

    it('honors provider precedence: mergeBindings can drop existing bindings', () => {
      // Provider decides imports win over locals (Python-ish precedence).
      const b = file('b', [def('def:b.User', 'Class', 'b.User')]);
      const a = file('a', [def('def:a.User', 'Class', 'a.User')], [named('User', 'User', 'b')]);
      const files = [a, b];
      const hooks: FinalizeHooks = {
        ...defaultHooks(files),
        mergeBindings(_existing, incoming) {
          // Replace existing with incoming — last-write-wins across tiers.
          return incoming;
        },
      };
      const out = finalize({ files, workspaceIndex: undefined }, hooks);
      const bindings = bindingsFor(out, a.moduleScope, 'User');
      // Only the last merged layer (the import) remains.
      expect(bindings.length).toBe(1);
      expect(bindings[0]!.origin).toBe('import');
    });
  });

  describe('SCC-DAG exposure for parallelism', () => {
    it('returns SCCs in reverse-topological order (leaves first)', () => {
      // c ← b ← a (a imports b, b imports c, c has no imports)
      const c = file('c', [def('def:c.C', 'Class', 'c.C')]);
      const b = file('b', [def('def:b.B', 'Class', 'b.B')], [named('C', 'C', 'c')]);
      const a = file('a', [def('def:a.A', 'Class', 'a.A')], [named('B', 'B', 'b')]);
      const files = [a, b, c];
      const out = finalize({ files, workspaceIndex: undefined }, defaultHooks(files));
      // First SCC processed must be `c` (leaf), last must be `a`.
      expect(out.sccs[0]!.files[0]).toBe('c');
      expect(out.sccs[out.sccs.length - 1]!.files[0]).toBe('a');
    });
  });
});
