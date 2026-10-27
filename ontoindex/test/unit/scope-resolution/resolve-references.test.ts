import { describe, expect, it, vi } from 'vitest';
import {
  buildClassRegistry,
  buildFieldRegistry,
  buildMethodRegistry,
  SupportedLanguages,
} from 'ontoindex-shared';
import type {
  NamedReferenceSite,
  ParsedFile,
  ReferenceSite,
  RegistryProviders,
  Scope,
  SymbolDefinition,
} from 'ontoindex-shared';
import {
  buildScopeRegistryContext,
  finalizeScopeModel,
} from '../../../src/core/ingestion/finalize-orchestrator.js';
import {
  resolveFreeCallReferences,
  resolveReferences,
} from '../../../src/core/ingestion/resolve-references.js';
import { createKnowledgeGraph } from '../../../src/core/graph/graph.js';
import { emitReferencesToGraph } from '../../../src/core/ingestion/emit-references.js';
import {
  buildImportTargetWorkspace,
  resolveImportTargetAcrossLanguages,
} from '../../../src/core/ingestion/import-target-adapter.js';
import type { ResolveCtx } from '../../../src/core/ingestion/import-resolvers/types.js';
import { buildSuffixIndex } from '../../../src/core/ingestion/import-resolvers/utils.js';
import {
  javascriptProvider,
  typescriptProvider,
} from '../../../src/core/ingestion/languages/typescript.js';
import { extract } from '../../../src/core/ingestion/scope-extractor.js';
import { createParserForLanguage } from '../../../src/core/tree-sitter/parser-loader.js';
import { emitTypeScriptCaptures } from '../../../src/core/ingestion/languages/typescript-captures.js';
import {
  selectTypeScriptLocalBindings,
  typeScriptDeclarationBindingScope,
} from '../../../src/core/ingestion/languages/typescript-declaration-captures.js';
import { interpretTypeScriptImport } from '../../../src/core/ingestion/languages/typescript-import-captures.js';
import { interpretTypeScriptExports } from '../../../src/core/ingestion/languages/typescript-export-captures.js';

const moduleId = 'scope:app.ts#module';
const definition = (nodeId = 'def:run'): SymbolDefinition => ({
  nodeId,
  filePath: 'app.ts',
  type: 'Function',
  qualifiedName: 'run',
});

describe('resolveReferences', () => {
  const read = (overrides: Partial<NamedReferenceSite> = {}): NamedReferenceSite =>
    site({ kind: 'read', callForm: undefined, ...overrides });
  const write = (overrides: Partial<NamedReferenceSite> = {}): NamedReferenceSite =>
    read({ kind: 'write', ...overrides });

  it('returns empty indexes and counters for no files', () => {
    expect(resolveReferences(finalizeScopeModel([]))).toEqual(
      resolveFreeCallReferences(finalizeScopeModel([])),
    );
  });

  it('counts a computed selection as unsupported before scope or lexical lookup', () => {
    const named = site();
    const computed: ReferenceSite = {
      kind: 'read',
      inScope: 'scope:missing',
      atRange: { startLine: 3, startCol: 0, endLine: 3, endCol: 8 },
      selection: {
        kind: 'computed',
        objectRange: { startLine: 3, startCol: 0, endLine: 3, endCol: 3 },
        indexRange: { startLine: 3, startCol: 4, endLine: 3, endCol: 7 },
      },
    };
    const indexes = finalizeScopeModel([fixture([definition()], [computed, named])]);
    for (const resolve of [resolveReferences, resolveFreeCallReferences]) {
      const out = resolve(indexes);
      expect(out.stats).toEqual({
        totalSites: 2,
        resolvedSites: 1,
        unresolvedSites: 0,
        ambiguousSites: 0,
        unsupportedSites: 1,
      });
      expect(out.referenceIndex.byTargetDef.get('def:run')).toEqual([
        expect.objectContaining({ atRange: named.atRange, kind: 'call' }),
      ]);
    }
  });

  it.each(['ts', 'tsx', 'js', 'jsx'])(
    'resolves computed-read operands without inventing an indexed target in %s',
    async (extension) => {
      const app = await parse(
        [
          'let table; let key; let field;',
          'function owner() {',
          '  table[key]; table["field"];',
          '  { let key; table[key]; }',
          '}',
        ].join('\n'),
        `app.${extension}`,
      );
      expect(
        app.referenceSites
          .filter((site) => site.selection === undefined)
          .map(({ name, kind, explicitReceiver }) => ({ name, kind, explicitReceiver })),
      ).toEqual(
        ['table', 'key', 'table', 'table', 'key'].map((name) => ({
          name,
          kind: 'read',
          explicitReceiver: undefined,
        })),
      );
      const selected = app.referenceSites.filter((site) => site.selection !== undefined);
      expect(selected).toHaveLength(3);
      for (const selection of selected) expect(selection).not.toHaveProperty('name');
      expect(app.referenceSites.map((site) => site.selection?.kind ?? site.name)).toEqual([
        'computed',
        'table',
        'key',
        'computed',
        'table',
        'computed',
        'table',
        'key',
      ]);
      const indexes = finalizeScopeModel([app]);
      const out = resolveReferences(indexes);
      expect(out.stats).toEqual({
        totalSites: 8,
        resolvedSites: 5,
        unresolvedSites: 0,
        ambiguousSites: 0,
        unsupportedSites: 3,
      });
      expect(resolveFreeCallReferences(indexes).stats).toEqual({
        totalSites: 8,
        resolvedSites: 0,
        unresolvedSites: 0,
        ambiguousSites: 0,
        unsupportedSites: 8,
      });
      const references = [...out.referenceIndex.bySourceScope.values()].flat();
      for (const selection of selected) {
        expect(
          references.some(
            (reference) => JSON.stringify(reference.atRange) === JSON.stringify(selection.atRange),
          ),
        ).toBe(false);
      }
      const module = app.scopes.find((scope) => scope.kind === 'Module')!;
      const definition = (name: string) =>
        module.ownedDefs.find((def) => def.qualifiedName === name)!;
      expect(out.referenceIndex.byTargetDef.get(definition('table').nodeId)).toHaveLength(3);
      expect(out.referenceIndex.byTargetDef.get(definition('key').nodeId)).toHaveLength(1);
      expect(out.referenceIndex.byTargetDef.has(definition('field').nodeId)).toBe(false);
      const innerKey = app.localDefs.find(
        (def) => def.qualifiedName === 'key' && def.nodeId !== definition('key').nodeId,
      )!;
      expect(out.referenceIndex.byTargetDef.get(innerKey.nodeId)).toHaveLength(1);
    },
  );

  it('resolves typed field reads without lexical fallback or free-call resolution', async () => {
    const app = await parse(
      [
        'class Owner { field: string; }',
        'let field;',
        'function caller(owner: Owner, unknown) {',
        '  owner.field;',
        '  unknown.field;',
        '  missing.field;',
        '  owner.absent;',
        '  { let owner; owner.field; }',
        '}',
      ].join('\n'),
      'app.ts',
    );
    const indexes = finalizeScopeModel([app]);
    const arityCompatibility = vi.fn(() => 'incompatible' as const);
    const out = resolveReferences(indexes, { arityCompatibility });
    const target = app.localDefs.find((def) => def.qualifiedName === 'Owner.field')!;
    const decoy = app.localDefs.find((def) => def.qualifiedName === 'field')!;
    expect(target).toBeDefined();
    expect(decoy).toBeDefined();
    expect(
      out.referenceIndex.byTargetDef
        .get(target.nodeId)
        ?.map(({ kind, atRange }) => [kind, atRange.startLine]),
    ).toEqual([['read', 4]]);
    expect(out.referenceIndex.byTargetDef.has(decoy.nodeId)).toBe(false);
    const members = app.referenceSites.filter(
      (input) => input.kind === 'read' && input.explicitReceiver,
    );
    expect(members).toHaveLength(5);
    const references = [...out.referenceIndex.bySourceScope.values()].flat();
    for (const member of members.slice(1)) {
      expect(
        references.some(
          (reference) =>
            reference.atRange.startLine === member.atRange.startLine &&
            reference.atRange.startCol === member.atRange.startCol &&
            reference.atRange.endCol === member.atRange.endCol,
        ),
      ).toBe(false);
    }
    expect(arityCompatibility).not.toHaveBeenCalled();
    expect(resolveFreeCallReferences(indexes).referenceIndex.byTargetDef.size).toBe(0);
  });

  it('resolves pure member-read chains by receiver type and preserves each source range', async () => {
    const app = await parse(
      [
        'class Leaf { field: string; }',
        'class Owner { child: Leaf; }',
        'let child; let field;',
        'function caller(owner: Owner) {',
        '  owner.child.field;',
        '  {',
        '    let owner;',
        '    owner.child.field;',
        '  }',
        '}',
      ].join('\n'),
      'app.ts',
    );
    const indexes = finalizeScopeModel([app]);
    const out = resolveReferences(indexes);
    const target = (name: string) => app.localDefs.find((def) => def.qualifiedName === name)!;
    for (const name of ['Owner.child', 'Leaf.field', 'child', 'field'])
      expect(target(name)).toBeDefined();
    const range = (line: number, startCol: number, endCol: number) => ({
      startLine: line,
      startCol,
      endLine: line,
      endCol,
    });
    const readSites = app.referenceSites.filter((input) => input.kind === 'read');
    expect(readSites.map(({ name, atRange }) => ({ name, atRange }))).toEqual(
      expect.arrayContaining([
        { name: 'owner', atRange: range(5, 2, 7) },
        { name: 'child', atRange: range(5, 2, 13) },
        { name: 'field', atRange: range(5, 2, 19) },
        { name: 'owner', atRange: range(8, 4, 9) },
        { name: 'child', atRange: range(8, 4, 15) },
        { name: 'field', atRange: range(8, 4, 21) },
      ]),
    );
    expect(readSites).toHaveLength(6);
    for (const [name, endCol] of [
      ['Owner.child', 13],
      ['Leaf.field', 19],
    ] as const) {
      expect(out.referenceIndex.byTargetDef.get(target(name).nodeId)).toEqual([
        expect.objectContaining({ kind: 'read', atRange: range(5, 2, endCol) }),
      ]);
    }
    for (const name of ['child', 'field']) {
      expect(out.referenceIndex.byTargetDef.has(target(name).nodeId)).toBe(false);
    }
    const shadowedMembers = readSites.filter(
      (input) => input.atRange.startLine === 8 && input.explicitReceiver,
    );
    const resolved = [...out.referenceIndex.bySourceScope.values()].flat();
    for (const input of shadowedMembers) {
      expect(
        resolved.some(
          (reference) =>
            reference.fromScope === input.inScope &&
            reference.atRange.startLine === input.atRange.startLine &&
            reference.atRange.startCol === input.atRange.startCol &&
            reference.atRange.endCol === input.atRange.endCol,
        ),
      ).toBe(false);
    }
    expect(out.stats).toEqual({
      totalSites: 6,
      resolvedSites: 4,
      unresolvedSites: 2,
      ambiguousSites: 0,
      unsupportedSites: 0,
    });
    expect(resolveFreeCallReferences(indexes).stats).toEqual({
      totalSites: 6,
      resolvedSites: 0,
      unresolvedSites: 0,
      ambiguousSites: 0,
      unsupportedSites: 6,
    });
  });

  it('materializes typed member chains and rejects untyped shadows and wrong arity', async () => {
    const app = await parse(
      [
        'class Child { save(value: Child): Child { return value; } }',
        'class Owner { child: Child; }',
        'function factory(): Owner { return new Owner(); }',
        'function save(value: Child) {}',
        'function caller(owner: Owner, child: Child) {',
        '  owner.child.save(child);',
        '  factory().child.save(child);',
        '  child.save(child);',
        '  child.save();',
        '  { let child; child.save(child); }',
        '}',
      ].join('\n'),
      'app.ts',
    );
    const providers: RegistryProviders = {
      arityCompatibility: (callsite, def) =>
        typescriptProvider.arityCompatibility?.(def, callsite) ?? 'unknown',
    };
    const indexes = finalizeScopeModel([app]);
    const out = resolveReferences(indexes, providers);
    const target = app.localDefs.find(
      (def) => def.type === 'Method' && def.qualifiedName === 'Child.save',
    )!;
    const decoy = app.localDefs.find(
      (def) => def.type === 'Function' && def.qualifiedName === 'save',
    )!;
    expect(target).toBeDefined();
    expect(decoy).toBeDefined();
    const memberSites = app.referenceSites.filter((input) => input.callForm === 'member');
    expect(memberSites).toHaveLength(5);
    expect(
      out.referenceIndex.byTargetDef
        .get(target.nodeId)
        ?.map((reference) => reference.atRange.startLine),
    ).toEqual([6, 7, 8]);
    expect(out.referenceIndex.byTargetDef.has(decoy.nodeId)).toBe(false);
    for (const input of memberSites.slice(3)) {
      expect(
        out.referenceIndex.bySourceScope
          .get(input.inScope)
          ?.some(
            (reference) =>
              reference.kind === 'call' && reference.atRange.startLine === input.atRange.startLine,
          ),
      ).not.toBe(true);
    }
    expect(out.stats.unresolvedSites).toBeGreaterThanOrEqual(2);
    const freeOnly = resolveFreeCallReferences(indexes, providers);
    expect(freeOnly.referenceIndex.byTargetDef.has(target.nodeId)).toBe(false);
    expect(freeOnly.stats.unsupportedSites).toBeGreaterThanOrEqual(5);
  });

  it('partitions explicit member singleton, missing and ambiguous targets', () => {
    const owner: SymbolDefinition = {
      ...definition('def:Owner'),
      type: 'Class',
      qualifiedName: 'Owner',
    };
    const first = {
      ...definition('def:first'),
      type: 'Method' as const,
      ownerId: owner.nodeId,
      qualifiedName: 'Owner.run',
    };
    const second = { ...first, nodeId: 'def:second' };
    for (const [members, verdict, expected] of [
      [[first], 'compatible', { resolvedSites: 1, unresolvedSites: 0, ambiguousSites: 0 }],
      [[], 'compatible', { resolvedSites: 0, unresolvedSites: 1, ambiguousSites: 0 }],
      [[first, second], 'compatible', { resolvedSites: 0, unresolvedSites: 0, ambiguousSites: 1 }],
      [[first], 'incompatible', { resolvedSites: 0, unresolvedSites: 1, ambiguousSites: 0 }],
    ] as const) {
      const file = fixture(
        [owner, ...members],
        [site({ callForm: 'member', explicitReceiver: { name: 'obj' }, arity: 0 })],
      );
      const scope = {
        ...file.scopes[0]!,
        bindings: new Map([['Owner', [{ def: owner, origin: 'local' as const }]]]),
        typeBindings: new Map([
          ['obj', { rawName: 'Owner', declaredAtScope: moduleId, source: 'annotation' as const }],
        ]),
      };
      const indexes = finalizeScopeModel([{ ...file, scopes: [scope] }]);
      const out = resolveReferences(indexes, { arityCompatibility: () => verdict });
      expect(out.stats).toEqual({ totalSites: 1, unsupportedSites: 0, ...expected });
      expect(resolveFreeCallReferences(indexes).stats.unsupportedSites).toBe(1);
    }
  });

  it('keeps malformed member calls and explicit non-member forms unsupported', () => {
    const receiver = { name: 'obj' };
    const inputs = [
      site({ callForm: 'member' }),
      site({ explicitReceiver: receiver }),
      site({ callForm: 'constructor', explicitReceiver: receiver }),
      site({ kind: 'read', callForm: undefined, explicitReceiver: receiver }),
    ];
    const out = resolveReferences(finalizeScopeModel([fixture([definition()], inputs)]));
    expect(out.stats).toEqual({
      totalSites: 4,
      resolvedSites: 0,
      unresolvedSites: 1,
      ambiguousSites: 0,
      unsupportedSites: 3,
    });
  });

  it.each(['ts', 'tsx', 'js', 'jsx'])(
    'keeps untyped %s receiver chains unresolved without resolving member-name decoys',
    async (extension) => {
      const app = await parse(
        [
          'function factory(value) {}',
          'function save(value) {}',
          'function select(value) {}',
          'function from(value) {}',
          'function findMany() {}',
          'let prisma; let supabase;',
          'function owner(value) {',
          '  factory(value).save(value);',
          '  prisma.user.findMany(); supabase.from(value).select(value);',
          '  { let value; let prisma; let supabase;',
          '    factory(value).save(value);',
          '    prisma.user.findMany(); supabase.from(value).select(value);',
          '  }',
          '}',
        ].join('\n'),
        `src/app.${extension}`,
      );
      const indexes = finalizeScopeModel([app]);
      const out = resolveReferences(indexes);
      expect(out.stats).toEqual({
        totalSites: 24,
        resolvedSites: 14,
        unresolvedSites: 10,
        ambiguousSites: 0,
        unsupportedSites: 0,
      });
      const memberReads = app.referenceSites.filter((reference) => reference.name === 'user');
      expect(memberReads.map(({ kind, explicitReceiver }) => ({ kind, explicitReceiver }))).toEqual(
        [
          { kind: 'read', explicitReceiver: { name: 'prisma' } },
          { kind: 'read', explicitReceiver: { name: 'prisma' } },
        ],
      );
      const resolved = [...out.referenceIndex.bySourceScope.values()].flat();
      for (const read of memberReads) {
        expect(
          resolved.some(
            (reference) => JSON.stringify(reference.atRange) === JSON.stringify(read.atRange),
          ),
        ).toBe(false);
      }
      const def = (name: string) =>
        app.localDefs.find((candidate) => candidate.qualifiedName === name)!;
      expect(out.referenceIndex.byTargetDef.get(def('factory').nodeId)).toHaveLength(2);
      for (const name of ['save', 'select', 'from', 'findMany']) {
        expect(out.referenceIndex.byTargetDef.has(def(name).nodeId), name).toBe(false);
      }
      const blocks = app.scopes.filter((scope) => scope.kind === 'Block');
      const body = blocks[blocks.length - 2]!;
      const nested = blocks[blocks.length - 1]!;
      const owner = app.scopes.find(
        (scope) =>
          scope.kind === 'Function' &&
          scope.ownedDefs.some((candidate) => candidate.qualifiedName === 'owner'),
      )!;
      for (const [scope, definitions] of [
        [
          body,
          [
            owner.ownedDefs.find((candidate) => candidate.qualifiedName === 'value')!,
            def('prisma'),
            def('supabase'),
          ],
        ],
        [
          nested,
          ['value', 'prisma', 'supabase'].map(
            (name) => nested.ownedDefs.find((candidate) => candidate.qualifiedName === name)!,
          ),
        ],
      ] as const) {
        for (const [index, definition] of definitions.entries()) {
          const references = out.referenceIndex.byTargetDef.get(definition.nodeId)!;
          expect(references).toHaveLength(index === 0 ? 4 : 1);
          expect(
            references.every(
              (reference) => reference.kind === 'read' && reference.fromScope === scope.id,
            ),
          ).toBe(true);
        }
      }
      expect(resolveFreeCallReferences(indexes).stats).toEqual({
        totalSites: 24,
        resolvedSites: 2,
        unresolvedSites: 0,
        ambiguousSites: 0,
        unsupportedSites: 22,
      });
      const graph = createKnowledgeGraph();
      emitReferencesToGraph({ graph, scopes: indexes, referenceIndex: out.referenceIndex });
      expect(
        graph.relationships
          .filter((relationship) => relationship.type === 'CALLS')
          .map((relationship) => relationship.targetId),
      ).toEqual([def('factory').nodeId, def('factory').nodeId]);
    },
  );

  it.each([
    ['free', 'export function Public() {}', 'Live(); Erased();'],
    ['read', 'export const Public = 1;', 'Live; Erased;'],
    ['constructor', 'export class Public {}', 'new Live(); new Erased();'],
  ] as const)(
    'keeps inline type imports out of parsed %s value resolution',
    async (form, declaration, use) => {
      const lib = await parse(declaration, 'lib.ts');
      const app = await parse(
        'import { Public as Live, type Public as Erased } from "./lib";\n' + use,
        'app.ts',
      );
      expect(app.parsedImports).toEqual([
        {
          kind: 'alias',
          localName: 'Live',
          importedName: 'Public',
          alias: 'Live',
          targetRaw: './lib',
        },
        {
          kind: 'alias',
          localName: 'Erased',
          importedName: 'Public',
          alias: 'Erased',
          targetRaw: './lib',
          namespace: 'type',
        },
      ]);
      expect(app.referenceSites.map(({ name }) => name)).toEqual(['Live', 'Erased']);
      const indexes = finalizeScopeModel([app, lib], {
        hooks: { resolveImportTarget: (targetRaw) => (targetRaw === './lib' ? 'lib.ts' : null) },
      });
      const out = resolveReferences(indexes);
      expect(out.stats).toEqual({
        totalSites: 2,
        resolvedSites: 1,
        unresolvedSites: 1,
        ambiguousSites: 0,
        unsupportedSites: 0,
      });
      const references = out.referenceIndex.byTargetDef.get(lib.localDefs[0]!.nodeId)!;
      expect(references).toHaveLength(1);
      expect(references[0]!.atRange).toEqual(app.referenceSites[0]!.atRange);
      expect(references[0]!.evidence).toContainEqual(expect.objectContaining({ kind: 'import' }));
      if (form === 'free') expect(resolveFreeCallReferences(indexes)).toEqual(out);
    },
  );

  it.each([
    ['free', 'Function'],
    ['read', 'Variable'],
    ['write', 'Variable'],
    ['constructor', 'Class'],
  ] as const)(
    'materializes %s references in the value namespace before shadowing',
    (form, type) => {
      const value = { ...definition('def:value'), type };
      const typeOnly = { ...definition('def:type'), type };
      const input = site({
        inScope: 'scope:inner',
        kind: form === 'read' || form === 'write' ? form : 'call',
        callForm: form === 'read' || form === 'write' ? undefined : form,
      });
      const file = fixture([value, typeOnly], [input]);
      const outer = {
        ...file.scopes[0]!,
        bindings: new Map([
          [
            'run',
            [
              {
                def: value,
                origin: 'local' as const,
                namespace: 'value' as const,
              },
            ],
          ],
        ]),
      };
      const inner: Scope = {
        ...outer,
        id: input.inScope,
        parent: outer.id,
        kind: 'Function',
        ownedDefs: [typeOnly],
        bindings: new Map([['run', [{ def: typeOnly, origin: 'local', namespace: 'type' }]]]),
      };
      const indexes = finalizeScopeModel([{ ...file, scopes: [outer, inner] }]);
      const out = resolveReferences(indexes);
      expect([...out.referenceIndex.byTargetDef.keys()]).toEqual([value.nodeId]);
      expect(out.stats).toEqual({
        totalSites: 1,
        resolvedSites: 1,
        unresolvedSites: 0,
        ambiguousSites: 0,
        unsupportedSites: 0,
      });
      if (form === 'free') expect(resolveFreeCallReferences(indexes)).toEqual(out);

      const shadow: Scope = {
        ...inner,
        bindings: new Map([
          [
            'run',
            [
              {
                def: typeOnly,
                origin: 'local',
                namespace: 'value',
              },
            ],
          ],
        ]),
      };
      const shadowed = resolveReferences(
        finalizeScopeModel([{ ...file, scopes: [outer, shadow] }]),
      );
      expect([...shadowed.referenceIndex.byTargetDef.keys()]).toEqual([typeOnly.nodeId]);
    },
  );

  it.each([
    ['free', 'Function'],
    ['read', 'Variable'],
    ['constructor', 'Class'],
  ] as const)(
    'uses value export identity for %s and suppresses private or missing canonical collisions',
    (form, type) => {
      const value = {
        ...definition('def:value'),
        type,
        filePath: 'lib.ts',
        qualifiedName: 'lib.InternalValue',
      };
      const typeOnly = {
        ...definition('def:type'),
        type,
        filePath: 'lib.ts',
        qualifiedName: 'lib.InternalType',
      };
      const privateDef = {
        ...definition('def:private'),
        type,
        filePath: 'lib.ts',
        qualifiedName: 'lib.Private',
      };
      const libScope: Scope = {
        ...fixture([], []).scopes[0]!,
        id: 'scope:lib.ts#module',
        filePath: 'lib.ts',
        ownedDefs: [value, typeOnly, privateDef],
      };
      const lib: ParsedFile = {
        filePath: 'lib.ts',
        moduleScope: libScope.id,
        scopes: [libScope],
        localDefs: [value, typeOnly, privateDef],
        referenceSites: [],
        parsedImports: [],
        exports: new Map([['Public', value.nodeId]]),
        exportsByNamespace: {
          type: new Map([['Public', typeOnly.nodeId]]),
          value: new Map([['Public', value.nodeId]]),
        },
      };
      const inputs = ['ns.Public', 'Alias', 'ns.Private', 'ns.Missing'].map((name) =>
        site({
          name,
          kind: form === 'read' ? 'read' : 'call',
          callForm: form === 'read' ? undefined : form,
        }),
      );
      inputs.push(
        site({ name: 'ns.Public', callForm: 'member' }),
        site({
          ...inputs[0]!,
          explicitReceiver: { name: 'ns' },
        }),
      );
      const collisions = ['Private', 'Missing'].map((name) => ({
        ...definition(`def:collision:${name}`),
        type,
        qualifiedName: `ns.${name}`,
      }));
      const app = {
        ...fixture(collisions, inputs),
        parsedImports: [
          { kind: 'namespace' as const, localName: 'ns', targetRaw: 'lib.ts' },
          {
            kind: 'named' as const,
            localName: 'Alias',
            importedName: 'Public',
            targetRaw: 'lib.ts',
          },
        ],
      };
      const indexes = finalizeScopeModel([app, lib], {
        hooks: { resolveImportTarget: (targetRaw) => (targetRaw === 'lib.ts' ? 'lib.ts' : null) },
      });
      const out = resolveReferences(indexes);
      expect([...out.referenceIndex.byTargetDef.keys()]).toEqual([value.nodeId]);
      expect(out.referenceIndex.byTargetDef.get(value.nodeId)).toHaveLength(2);
      for (const reference of out.referenceIndex.byTargetDef.get(value.nodeId)!) {
        expect(reference.evidence).toContainEqual(expect.objectContaining({ kind: 'import' }));
        expect(reference.evidence).not.toContainEqual(
          expect.objectContaining({ kind: 'global-qualified' }),
        );
      }
      expect(out.stats).toEqual({
        totalSites: 6,
        resolvedSites: 2,
        unresolvedSites: form === 'read' ? 3 : 2,
        ambiguousSites: 0,
        unsupportedSites: form === 'read' ? 1 : 2,
      });
      if (form === 'free') expect(resolveFreeCallReferences(indexes)).toEqual(out);
    },
  );

  describe.each([resolveReferences, resolveFreeCallReferences])(
    '%s arity materialization',
    (resolve) => {
      it('rejects an explicitly incompatible singleton without discarding the registry suggestion', () => {
        const def = definition();
        const indexes = finalizeScopeModel([fixture([def], [site({ arity: 1 })])]);
        const arityCompatibility = vi.fn(() => 'incompatible' as const);
        const providers = { arityCompatibility };
        const candidates = buildMethodRegistry(
          buildScopeRegistryContext(indexes, providers),
        ).lookup('run', moduleId, { callsite: { arity: 1 } });
        expect(candidates).toHaveLength(1);
        expect(candidates[0]!.evidence).toContainEqual(
          expect.objectContaining({ kind: 'arity-match', note: 'incompatible' }),
        );
        arityCompatibility.mockClear();

        const out = resolve(indexes, providers);
        expect(out.stats).toEqual({
          totalSites: 1,
          resolvedSites: 0,
          unresolvedSites: 1,
          ambiguousSites: 0,
          unsupportedSites: 0,
        });
        expect([...out.referenceIndex.bySourceScope]).toEqual([]);
        expect([...out.referenceIndex.byTargetDef]).toEqual([]);
        expect(arityCompatibility).toHaveBeenCalledExactlyOnceWith({ arity: 1 }, def);
      });

      it.each(['compatible', 'unknown'] as const)(
        'retains a singleton with %s arity evidence',
        (verdict) => {
          const def = definition();
          const indexes = finalizeScopeModel([fixture([def], [site({ arity: 1 })])]);
          const arityCompatibility = vi.fn(() => verdict);
          const out = resolve(indexes, { arityCompatibility });
          expect(out.stats).toEqual({
            totalSites: 1,
            resolvedSites: 1,
            unresolvedSites: 0,
            ambiguousSites: 0,
            unsupportedSites: 0,
          });
          const references = out.referenceIndex.byTargetDef.get(def.nodeId)!;
          expect(references).toHaveLength(1);
          expect(references[0]!.evidence).toContainEqual(
            expect.objectContaining({ kind: 'arity-match', note: verdict }),
          );
          expect(out.referenceIndex.bySourceScope.get(moduleId)).toEqual(references);
          expect(arityCompatibility).toHaveBeenCalledExactlyOnceWith({ arity: 1 }, def);
        },
      );

      it('keeps multiple incompatible suggestions ambiguous before checking singleton evidence', () => {
        const defs = [definition('def:first'), definition('def:second')];
        const indexes = finalizeScopeModel([fixture(defs, [site({ arity: 1 })])]);
        const arityCompatibility = vi.fn(() => 'incompatible' as const);
        const out = resolve(indexes, { arityCompatibility });
        expect(out.stats).toEqual({
          totalSites: 1,
          resolvedSites: 0,
          unresolvedSites: 0,
          ambiguousSites: 1,
          unsupportedSites: 0,
        });
        expect([...out.referenceIndex.bySourceScope]).toEqual([]);
        expect([...out.referenceIndex.byTargetDef]).toEqual([]);
        expect(arityCompatibility).toHaveBeenCalledTimes(2);
        for (const def of defs) expect(arityCompatibility).toHaveBeenCalledWith({ arity: 1 }, def);
      });
    },
  );

  it('materializes mixed calls and reads in input order with detached evidence and frozen dual indexes', () => {
    const callable = definition();
    const variable: SymbolDefinition = { ...definition('def:value'), type: 'Variable' };
    const sites = [
      site(),
      read(),
      site({ name: 'missing' }),
      read({ atRange: { startLine: 4, startCol: 0, endLine: 4, endCol: 3 } }),
    ];
    const indexes = finalizeScopeModel([fixture([callable, variable], sites)]);
    const savedBindings = [...indexes.bindings.get(moduleId)!];
    const savedSites = JSON.stringify(indexes.referenceSites);
    const context = buildScopeRegistryContext(indexes);
    const callCandidate = buildMethodRegistry(context).lookup('run', moduleId)[0]!;
    const readCandidate = buildFieldRegistry(context).lookup('run', moduleId)[0]!;
    const out = resolveReferences(indexes);
    const references = out.referenceIndex.bySourceScope.get(moduleId)!;
    expect(references).toEqual(
      [0, 1, 3].map((index) => {
        const input = sites[index]!;
        const candidate = input.kind === 'call' ? callCandidate : readCandidate;
        return {
          fromScope: moduleId,
          toDef: candidate.def.nodeId,
          kind: input.kind,
          atRange: input.atRange,
          confidence: candidate.confidence,
          evidence: candidate.evidence,
        };
      }),
    );
    expect(out.referenceIndex.byTargetDef.get(callable.nodeId)).toEqual([references[0]]);
    expect(out.referenceIndex.byTargetDef.get(variable.nodeId)).toEqual([
      references[1],
      references[2],
    ]);
    references.forEach((reference, index) => {
      const inputIndex = [0, 1, 3][index]!;
      expect(reference.atRange).not.toBe(indexes.referenceSites[inputIndex]!.atRange);
      const targetBucket = out.referenceIndex.byTargetDef.get(reference.toDef)!;
      expect(
        targetBucket.find((target) => target.atRange.startLine === reference.atRange.startLine),
      ).toBe(reference);
    });
    expect(Object.isFrozen(references)).toBe(true);
    for (const bucket of out.referenceIndex.byTargetDef.values())
      expect(Object.isFrozen(bucket)).toBe(true);
    expect(resolveReferences(indexes)).toEqual(out);
    expect([...indexes.bindings.get(moduleId)!]).toEqual(savedBindings);
    expect(JSON.stringify(indexes.referenceSites)).toBe(savedSites);
    sites[1]!.atRange.startLine = 99;
    expect(references[1]!.atRange.startLine).toBe(2);
    expect(out.stats).toEqual({
      totalSites: 4,
      resolvedSites: 3,
      unresolvedSites: 1,
      ambiguousSites: 0,
      unsupportedSites: 0,
    });
    expect(resolveFreeCallReferences(indexes).stats).toEqual({
      totalSites: 4,
      resolvedSites: 1,
      unresolvedSites: 1,
      ambiguousSites: 0,
      unsupportedSites: 2,
    });
  });

  it.each(['Variable', 'Property', 'Const', 'Static'] as const)(
    'accepts %s identifier reads without invoking call arity compatibility',
    (type) => {
      const def = { ...definition(), type };
      const indexes = finalizeScopeModel([fixture([def], [read({ arity: 17 })])]);
      const arityCompatibility = vi.fn(() => 'incompatible' as const);
      const out = resolveReferences(indexes, { arityCompatibility });
      expect(arityCompatibility).not.toHaveBeenCalled();
      expect(out.referenceIndex.byTargetDef.get(def.nodeId)).toHaveLength(1);
      expect(out.stats).toEqual({
        totalSites: 1,
        resolvedSites: 1,
        unresolvedSites: 0,
        ambiguousSites: 0,
        unsupportedSites: 0,
      });
    },
  );

  it.each(['Function', 'Class'] as const)('leaves %s identifier reads unresolved', (type) => {
    const out = resolveReferences(
      finalizeScopeModel([fixture([{ ...definition(), type }], [read()])]),
    );
    expect(out.stats).toEqual({
      totalSites: 1,
      resolvedSites: 0,
      unresolvedSites: 1,
      ambiguousSites: 0,
      unsupportedSites: 0,
    });
    expect(out.referenceIndex.bySourceScope.size).toBe(0);
    expect(out.referenceIndex.byTargetDef.size).toBe(0);
  });

  it('partitions ambiguous, unresolved and unsupported reads without selecting a winner', () => {
    const defs = ['def:first', 'def:second'].map(
      (id): SymbolDefinition => ({ ...definition(id), type: 'Variable' }),
    );
    const sites = [
      read(),
      read({ name: 'missing' }),
      read({ callForm: 'free' }),
      read({ callForm: 'member' }),
      read({ explicitReceiver: { name: 'object' } }),
      read({ kind: 'write' }),
      site({ callForm: 'member' }),
      site({ explicitReceiver: { name: 'object' } }),
    ];
    const out = resolveReferences(finalizeScopeModel([fixture(defs, sites)]));
    expect(out.stats).toEqual({
      totalSites: 8,
      resolvedSites: 0,
      unresolvedSites: 2,
      ambiguousSites: 2,
      unsupportedSites: 4,
    });
    expect(out.referenceIndex.bySourceScope.size).toBe(0);
    expect(out.referenceIndex.byTargetDef.size).toBe(0);
  });

  it('does not use a qualified global fallback for a read with an absent source scope', () => {
    const def: SymbolDefinition = { ...definition(), type: 'Variable', qualifiedName: 'pkg.run' };
    const out = resolveReferences(
      finalizeScopeModel([fixture([def], [read({ name: 'pkg.run', inScope: 'scope:missing' })])]),
    );
    expect(out.stats).toEqual({
      totalSites: 1,
      resolvedSites: 0,
      unresolvedSites: 1,
      ambiguousSites: 0,
      unsupportedSites: 0,
    });
    expect(out.referenceIndex.byTargetDef.size).toBe(0);
  });

  it.each(['Variable', 'Property', 'Const', 'Static'] as const)(
    'materializes syntactic %s writes with detached evidence and stable access edges',
    (type) => {
      const def = { ...definition('def:value'), type };
      const input = write({ arity: 17 });
      const indexes = finalizeScopeModel([fixture([def], [input])]);
      const candidate = buildFieldRegistry(buildScopeRegistryContext(indexes)).lookup(
        'run',
        moduleId,
        { lexicalNamespace: 'value' },
      )[0]!;
      const arityCompatibility = vi.fn(() => 'incompatible' as const);
      const out = resolveReferences(indexes, { arityCompatibility });
      const references = out.referenceIndex.bySourceScope.get(moduleId)!;
      expect(references).toEqual([
        {
          fromScope: moduleId,
          toDef: def.nodeId,
          kind: 'write',
          atRange: input.atRange,
          confidence: candidate.confidence,
          evidence: candidate.evidence,
        },
      ]);
      const reference = references[0]!;
      expect(out.referenceIndex.byTargetDef.get(def.nodeId)).toEqual(references);
      expect(out.referenceIndex.byTargetDef.get(def.nodeId)![0]).toBe(reference);
      expect(reference.atRange).not.toBe(input.atRange);
      expect(reference.evidence).not.toBe(candidate.evidence);
      reference.evidence.forEach((evidence, index) =>
        expect(evidence).not.toBe(candidate.evidence[index]),
      );
      expect(Object.isFrozen(references)).toBe(true);
      expect(Object.isFrozen(out.referenceIndex.byTargetDef.get(def.nodeId))).toBe(true);
      expect(arityCompatibility).not.toHaveBeenCalled();
      expect(out.stats).toEqual({
        totalSites: 1,
        resolvedSites: 1,
        unresolvedSites: 0,
        ambiguousSites: 0,
        unsupportedSites: 0,
      });
      expect(resolveFreeCallReferences(indexes).stats).toEqual({
        totalSites: 1,
        resolvedSites: 0,
        unresolvedSites: 0,
        ambiguousSites: 0,
        unsupportedSites: 1,
      });
      const graph = createKnowledgeGraph();
      emitReferencesToGraph({ graph, scopes: indexes, referenceIndex: out.referenceIndex });
      expect(graph.relationships.filter((edge) => edge.type === 'ACCESSES')).toEqual([
        {
          id: `rel:ACCESSES:${def.nodeId}->${def.nodeId}:2:0:write`,
          sourceId: def.nodeId,
          targetId: def.nodeId,
          type: 'ACCESSES',
          step: 2,
          confidence: reference.confidence,
          reason: `scope-resolution: write | confidence ${reference.confidence.toFixed(3)}`,
          evidence: reference.evidence,
        },
      ]);
      const emitted = structuredClone(graph.relationships);
      emitReferencesToGraph({
        graph,
        scopes: indexes,
        referenceIndex: resolveReferences(indexes).referenceIndex,
      });
      expect(graph.relationships).toEqual(emitted);
      input.atRange.startLine = 99;
      expect(reference.atRange.startLine).toBe(2);
    },
  );

  it('partitions ambiguous and missing writes from unsupported receivers and call forms', () => {
    const defs = ['def:first', 'def:second'].map(
      (id): SymbolDefinition => ({
        ...definition(id),
        type: 'Variable',
        qualifiedName: 'pkg.run',
      }),
    );
    const inputs = [
      write(),
      write({ name: 'missing' }),
      write({ name: 'pkg.run', inScope: 'scope:missing' }),
      write({ explicitReceiver: { name: 'object' } }),
      ...(['free', 'member', 'constructor'] as const).map((callForm) => write({ callForm })),
    ];
    const indexes = finalizeScopeModel([fixture(defs, inputs)]);
    const out = resolveReferences(indexes);
    expect(out.stats).toEqual({
      totalSites: 7,
      resolvedSites: 0,
      unresolvedSites: 2,
      ambiguousSites: 1,
      unsupportedSites: 4,
    });
    expect([...out.referenceIndex.bySourceScope]).toEqual([]);
    expect([...out.referenceIndex.byTargetDef]).toEqual([]);
    expect(resolveFreeCallReferences(indexes).stats).toEqual({
      totalSites: 7,
      resolvedSites: 0,
      unresolvedSites: 0,
      ambiguousSites: 0,
      unsupportedSites: 7,
    });
  });

  it('resolves constructor calls to the class definition without filtering by argument arity', () => {
    const def: SymbolDefinition = { ...definition('def:class'), type: 'Class' };
    const input = site({ callForm: 'constructor', arity: 17 });
    const indexes = finalizeScopeModel([fixture([def], [input])]);
    const candidate = buildClassRegistry(buildScopeRegistryContext(indexes)).lookup(
      'run',
      moduleId,
    )[0]!;
    const arityCompatibility = vi.fn(() => 'incompatible' as const);
    const out = resolveReferences(indexes, { arityCompatibility });
    const reference = out.referenceIndex.byTargetDef.get(def.nodeId)![0]!;
    expect(reference).toEqual({
      fromScope: moduleId,
      toDef: def.nodeId,
      kind: 'call',
      atRange: input.atRange,
      confidence: candidate.confidence,
      evidence: candidate.evidence,
    });
    expect(reference.atRange).not.toBe(indexes.referenceSites[0]!.atRange);
    expect(reference.evidence).not.toBe(candidate.evidence);
    expect(out.referenceIndex.bySourceScope.get(moduleId)![0]).toBe(reference);
    expect(Object.isFrozen(out.referenceIndex.bySourceScope.get(moduleId))).toBe(true);
    expect(Object.isFrozen(out.referenceIndex.byTargetDef.get(def.nodeId))).toBe(true);
    expect(arityCompatibility).not.toHaveBeenCalled();
    expect(out.stats).toEqual({
      totalSites: 1,
      resolvedSites: 1,
      unresolvedSites: 0,
      ambiguousSites: 0,
      unsupportedSites: 0,
    });
    expect(resolveFreeCallReferences(indexes, { arityCompatibility }).stats).toEqual({
      totalSites: 1,
      resolvedSites: 0,
      unresolvedSites: 0,
      ambiguousSites: 0,
      unsupportedSites: 1,
    });
    expect(arityCompatibility).not.toHaveBeenCalled();
  });

  it.each([
    'Interface',
    'Enum',
    'Struct',
    'Union',
    'Trait',
    'TypeAlias',
    'Typedef',
    'Record',
    'Delegate',
    'Annotation',
    'Template',
    'Namespace',
    'Function',
    'Method',
    'Constructor',
    'Variable',
  ] as const)('leaves a singleton %s constructor target unresolved', (type) => {
    const indexes = finalizeScopeModel([
      fixture([{ ...definition(), type }], [site({ callForm: 'constructor' })]),
    ]);
    const out = resolveReferences(indexes);
    expect(out.stats).toEqual({
      totalSites: 1,
      resolvedSites: 0,
      unresolvedSites: 1,
      ambiguousSites: 0,
      unsupportedSites: 0,
    });
    expect(out.referenceIndex.bySourceScope.size).toBe(0);
    expect(out.referenceIndex.byTargetDef.size).toBe(0);
  });

  it.each([
    ['Class', 'Class'],
    ['Class', 'Interface'],
    ['Interface', 'Enum'],
  ] as const)(
    'keeps %s/%s constructor candidates ambiguous before rejecting non-Class types',
    (firstType, secondType) => {
      const defs: SymbolDefinition[] = [
        { ...definition('def:first'), type: firstType },
        { ...definition('def:second'), type: secondType },
      ];
      const out = resolveReferences(
        finalizeScopeModel([fixture(defs, [site({ callForm: 'constructor' })])]),
      );
      expect(out.stats).toEqual({
        totalSites: 1,
        resolvedSites: 0,
        unresolvedSites: 0,
        ambiguousSites: 1,
        unsupportedSites: 0,
      });
      expect(out.referenceIndex.bySourceScope.size).toBe(0);
      expect(out.referenceIndex.byTargetDef.size).toBe(0);
    },
  );

  it('partitions missing constructor names and scopes from unsupported explicit receivers', () => {
    const def: SymbolDefinition = { ...definition(), type: 'Class', qualifiedName: 'pkg.run' };
    const inputs = [
      site({ callForm: 'constructor', name: 'missing' }),
      site({ callForm: 'constructor', name: 'pkg.run', inScope: 'scope:missing' }),
      site({ callForm: 'constructor', explicitReceiver: { name: 'object' } }),
    ];
    const out = resolveReferences(finalizeScopeModel([fixture([def], inputs)]));
    expect(out.stats).toEqual({
      totalSites: 3,
      resolvedSites: 0,
      unresolvedSites: 2,
      ambiguousSites: 0,
      unsupportedSites: 1,
    });
    expect(out.referenceIndex.bySourceScope.size).toBe(0);
    expect(out.referenceIndex.byTargetDef.size).toBe(0);
  });

  it('materializes mixed free calls, reads and constructor calls in input order', () => {
    const defs: SymbolDefinition[] = [
      definition('def:call'),
      { ...definition('def:value'), type: 'Variable' },
      { ...definition('def:class'), type: 'Class' },
    ];
    const inputs = [site(), read(), site({ callForm: 'constructor' })];
    const indexes = finalizeScopeModel([fixture(defs, inputs)]);
    const out = resolveReferences(indexes);
    const references = out.referenceIndex.bySourceScope.get(moduleId)!;
    expect(references.map((reference) => [reference.toDef, reference.kind])).toEqual([
      ['def:call', 'call'],
      ['def:value', 'read'],
      ['def:class', 'call'],
    ]);
    references.forEach((reference) =>
      expect(out.referenceIndex.byTargetDef.get(reference.toDef)).toEqual([reference]),
    );
    expect(out.stats).toEqual({
      totalSites: 3,
      resolvedSites: 3,
      unresolvedSites: 0,
      ambiguousSites: 0,
      unsupportedSites: 0,
    });
    expect(resolveFreeCallReferences(indexes).stats).toEqual({
      totalSites: 3,
      resolvedSites: 1,
      unresolvedSites: 0,
      ambiguousSites: 0,
      unsupportedSites: 2,
    });
  });

  it.each(['ts', 'tsx', 'js', 'jsx'])(
    'resolves real %s class imports while rejecting private, missing and shadowed constructor names',
    async (extension) => {
      const lib = await parse('export class Public {}\nclass Private {}', `src/lib.${extension}`);
      const app = await parse(
        "import { Public as Alias, Private } from './lib';\n" +
          "import { Unknown } from './missing';\n" +
          'function caller() { new Alias(); new Alias; new Private(); new Unknown(); }\n' +
          'function shadow(Alias) { new Alias(); }',
        `src/app.${extension}`,
      );
      const paths = [app.filePath, lib.filePath];
      const ctx: ResolveCtx = {
        allFilePaths: new Set(paths),
        allFileList: paths,
        normalizedFileList: paths,
        index: buildSuffixIndex(paths, paths),
        resolveCache: new Map(),
        configs: {
          tsconfigPaths: null,
          goModule: null,
          composerConfig: null,
          swiftPackageConfig: null,
          csharpConfigs: [],
        },
      };
      const workspaceIndex = buildImportTargetWorkspace(
        new Map([
          [SupportedLanguages.TypeScript, typescriptProvider],
          [SupportedLanguages.JavaScript, javascriptProvider],
        ]),
        ctx,
      );
      const indexes = finalizeScopeModel([app, lib], {
        workspaceIndex,
        hooks: { resolveImportTarget: resolveImportTargetAcrossLanguages },
      });
      const savedBindings = [...indexes.bindings].map(([id, bindings]) => [id, [...bindings]]);
      const out = resolveReferences(indexes);
      const publicDef = lib.localDefs.find(
        (def) => def.type === 'Class' && def.qualifiedName === 'Public',
      )!;
      const aliasSites = app.referenceSites.filter((input) => input.name === 'Alias');
      expect(aliasSites).toHaveLength(3);
      expect(aliasSites.map((input) => input.callForm)).toEqual([
        'constructor',
        'constructor',
        'constructor',
      ]);
      const references = out.referenceIndex.byTargetDef.get(publicDef.nodeId)!;
      expect(references).toHaveLength(2);
      references.forEach((reference, index) => {
        expect(reference).toMatchObject({
          toDef: publicDef.nodeId,
          fromScope: aliasSites[index]!.inScope,
          atRange: aliasSites[index]!.atRange,
          kind: 'call',
        });
        expect(reference.evidence).toContainEqual(expect.objectContaining({ kind: 'import' }));
        expect(out.referenceIndex.bySourceScope.get(reference.fromScope)).toContain(reference);
      });
      expect(out.referenceIndex.bySourceScope.has(aliasSites[2]!.inScope)).toBe(false);
      expect(out.referenceIndex.byTargetDef.size).toBe(1);
      expect(out.stats).toEqual({
        totalSites: 5,
        resolvedSites: 2,
        unresolvedSites: 3,
        ambiguousSites: 0,
        unsupportedSites: 0,
      });
      expect(resolveFreeCallReferences(indexes).stats).toEqual({
        totalSites: 5,
        resolvedSites: 0,
        unresolvedSites: 0,
        ambiguousSites: 0,
        unsupportedSites: 5,
      });
      expect([...indexes.bindings].map(([id, bindings]) => [id, [...bindings]])).toEqual(
        savedBindings,
      );
    },
  );

  it.each(['ts', 'tsx', 'js', 'jsx'])(
    'resolves real %s imported reads, calls and local shadows through the existing registries',
    async (extension) => {
      const lib = await parse(
        'export const publicValue = 1;\nconst privateValue = 2;\nexport function Public() {}',
        `src/lib.${extension}`,
      );
      const app = await parse(
        "import { publicValue as Alias, privateValue, Public } from './lib';\n" +
          "import { Unknown } from './missing';\n" +
          'function caller() { Alias; Public(); privateValue; Unknown; missing; }\n' +
          'function shadow(Alias) { Alias; }',
        `src/app.${extension}`,
      );
      const paths = [app.filePath, lib.filePath];
      const ctx: ResolveCtx = {
        allFilePaths: new Set(paths),
        allFileList: paths,
        normalizedFileList: paths,
        index: buildSuffixIndex(paths, paths),
        resolveCache: new Map(),
        configs: {
          tsconfigPaths: null,
          goModule: null,
          composerConfig: null,
          swiftPackageConfig: null,
          csharpConfigs: [],
        },
      };
      const workspaceIndex = buildImportTargetWorkspace(
        new Map([
          [SupportedLanguages.TypeScript, typescriptProvider],
          [SupportedLanguages.JavaScript, javascriptProvider],
        ]),
        ctx,
      );
      const indexes = finalizeScopeModel([app, lib], {
        workspaceIndex,
        hooks: { resolveImportTarget: resolveImportTargetAcrossLanguages },
      });
      const savedBindings = [...indexes.bindings].map(([id, bindings]) => [id, [...bindings]]);
      const out = resolveReferences(indexes);
      const aliasSites = app.referenceSites.filter((input) => input.name === 'Alias');
      expect(aliasSites).toHaveLength(2);
      const imported = lib.localDefs.find((def) => def.qualifiedName === 'publicValue')!;
      const callable = lib.localDefs.find((def) => def.qualifiedName === 'Public')!;
      const shadow = app.localDefs.find(
        (def) => def.type === 'Variable' && def.qualifiedName.endsWith('Alias'),
      )!;
      expect(shadow).toBeDefined();
      const importedReferences = out.referenceIndex.byTargetDef.get(imported.nodeId)!;
      expect(importedReferences).toHaveLength(1);
      expect(importedReferences[0]).toMatchObject({
        fromScope: aliasSites[0]!.inScope,
        toDef: imported.nodeId,
        kind: 'read',
        atRange: aliasSites[0]!.atRange,
      });
      expect(importedReferences[0]!.evidence).toContainEqual(
        expect.objectContaining({ kind: 'import' }),
      );
      const localReferences = out.referenceIndex.byTargetDef.get(shadow.nodeId)!;
      expect(localReferences).toHaveLength(1);
      expect(localReferences[0]).toMatchObject({
        fromScope: aliasSites[1]!.inScope,
        toDef: shadow.nodeId,
        kind: 'read',
        atRange: aliasSites[1]!.atRange,
      });
      expect(out.referenceIndex.byTargetDef.get(callable.nodeId)).toHaveLength(1);
      expect(out.referenceIndex.byTargetDef.size).toBe(3);
      const callerDef = app.localDefs.find(
        (def) => def.type === 'Function' && def.qualifiedName === 'caller',
      )!;
      const shadowDef = app.localDefs.find(
        (def) => def.type === 'Function' && def.qualifiedName === 'shadow',
      )!;
      expect(callerDef).toBeDefined();
      expect(shadowDef).toBeDefined();
      const graph = createKnowledgeGraph();
      expect(
        emitReferencesToGraph({ graph, scopes: indexes, referenceIndex: out.referenceIndex }),
      ).toEqual({
        edgesEmitted: 3,
        skippedNoCaller: 0,
        skippedMissingTarget: 0,
        scopeNodesEmitted: 0,
        scopeEdgesEmitted: 0,
      });
      const callReference = out.referenceIndex.byTargetDef.get(callable.nodeId)![0]!;
      expect(graph.relationships).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            sourceId: callerDef.nodeId,
            targetId: callable.nodeId,
            type: 'CALLS',
            confidence: callReference.confidence,
            evidence: callReference.evidence,
          }),
          expect.objectContaining({
            sourceId: callerDef.nodeId,
            targetId: imported.nodeId,
            type: 'ACCESSES',
            step: 1,
            confidence: importedReferences[0]!.confidence,
            evidence: importedReferences[0]!.evidence,
          }),
          expect.objectContaining({
            sourceId: shadowDef.nodeId,
            targetId: shadow.nodeId,
            type: 'ACCESSES',
            step: 1,
            confidence: localReferences[0]!.confidence,
            evidence: localReferences[0]!.evidence,
          }),
        ]),
      );
      expect(graph.relationships).toHaveLength(3);
      expect(graph.relationships.map((edge) => edge.targetId).sort()).toEqual(
        [callable.nodeId, imported.nodeId, shadow.nodeId].sort(),
      );
      expect(out.stats).toEqual({
        totalSites: 6,
        resolvedSites: 3,
        unresolvedSites: 3,
        ambiguousSites: 0,
        unsupportedSites: 0,
      });
      expect(resolveFreeCallReferences(indexes).stats).toEqual({
        totalSites: 6,
        resolvedSites: 1,
        unresolvedSites: 0,
        ambiguousSites: 0,
        unsupportedSites: 5,
      });
      for (const references of out.referenceIndex.byTargetDef.values()) {
        expect(Object.isFrozen(references)).toBe(true);
        for (const reference of references) {
          expect(
            out.referenceIndex.bySourceScope
              .get(reference.fromScope)
              ?.find((source) => source.toDef === reference.toDef),
          ).toBe(reference);
        }
      }
      expect([...indexes.bindings].map(([id, bindings]) => [id, [...bindings]])).toEqual(
        savedBindings,
      );
    },
  );
});
const site = (overrides: Partial<NamedReferenceSite> = {}): NamedReferenceSite => ({
  name: 'run',
  inScope: moduleId,
  kind: 'call',
  callForm: 'free',
  atRange: { startLine: 2, startCol: 0, endLine: 2, endCol: 3 },
  ...overrides,
});

function fixture(defs: SymbolDefinition[], sites: ReferenceSite[]): ParsedFile {
  const scope: Scope = {
    id: moduleId,
    parent: null,
    kind: 'Module',
    filePath: 'app.ts',
    range: { startLine: 1, startCol: 0, endLine: 100, endCol: 0 },
    bindings: new Map([['run', defs.map((def) => ({ def, origin: 'local' as const }))]]),
    ownedDefs: defs,
    imports: [],
    typeBindings: new Map(),
  };
  return {
    filePath: 'app.ts',
    moduleScope: moduleId,
    scopes: [scope],
    localDefs: defs,
    referenceSites: sites,
    parsedImports: [],
  };
}

async function parse(source: string, filePath: string): Promise<ParsedFile> {
  const language = /\.jsx?$/.test(filePath)
    ? SupportedLanguages.JavaScript
    : SupportedLanguages.TypeScript;
  const parser = await createParserForLanguage(language, filePath);
  const root = parser.parse(source).rootNode;
  expect(root.hasError).toBe(false);
  return extract(emitTypeScriptCaptures(root), filePath, {
    bindingScopeFor: typeScriptDeclarationBindingScope,
    selectLocalBindings: selectTypeScriptLocalBindings,
    interpretImport: interpretTypeScriptImport,
    interpretExports: interpretTypeScriptExports,
    interpretTypeBinding: typescriptProvider.interpretTypeBinding,
  });
}

describe('resolveFreeCallReferences', () => {
  it('returns empty indexes and counters for no files', () => {
    const out = resolveFreeCallReferences(finalizeScopeModel([]));
    expect([...out.referenceIndex.bySourceScope]).toEqual([]);
    expect([...out.referenceIndex.byTargetDef]).toEqual([]);
    expect(out.stats).toEqual({
      totalSites: 0,
      resolvedSites: 0,
      unresolvedSites: 0,
      ambiguousSites: 0,
      unsupportedSites: 0,
    });
  });

  it('indexes singleton calls in input order with detached ranges and frozen buckets', () => {
    const def = definition();
    const first = site();
    const second = site({ atRange: { ...first.atRange, startLine: 3, endLine: 3 } });
    const indexes = finalizeScopeModel([fixture([def], [first, second])]);
    const beforeBindings = [...indexes.bindings.get(moduleId)!];
    const resolution = buildMethodRegistry(buildScopeRegistryContext(indexes)).lookup(
      'run',
      moduleId,
    )[0]!;
    const out = resolveFreeCallReferences(indexes);
    const source = out.referenceIndex.bySourceScope.get(moduleId)!;
    const target = out.referenceIndex.byTargetDef.get(def.nodeId)!;
    expect(source).toEqual(
      [first, second].map((input) => ({
        fromScope: moduleId,
        toDef: def.nodeId,
        atRange: input.atRange,
        kind: 'call',
        confidence: resolution.confidence,
        evidence: resolution.evidence,
      })),
    );
    expect(target).toEqual(source);
    source.forEach((reference, i) => {
      expect(target[i]).toBe(reference);
      expect(reference.atRange).not.toBe(indexes.referenceSites[i]!.atRange);
      expect(reference.evidence).toEqual(resolution.evidence);
    });
    expect(Object.isFrozen(source)).toBe(true);
    expect(Object.isFrozen(target)).toBe(true);
    expect(resolveFreeCallReferences(indexes)).toEqual(out);
    expect([...indexes.bindings.get(moduleId)!]).toEqual(beforeBindings);
    expect(indexes.referenceSites).toEqual([first, second]);
    Object.assign(first.atRange, { startLine: 99 });
    expect(source[0]!.atRange.startLine).toBe(2);
    expect(out.stats).toEqual({
      totalSites: 2,
      resolvedSites: 2,
      unresolvedSites: 0,
      ambiguousSites: 0,
      unsupportedSites: 0,
    });
  });

  it('partitions unresolved, ambiguous and unsupported sites without selecting a ranked winner', () => {
    const defs = [definition('def:a'), definition('def:b')];
    const sites = [
      site(),
      site({ name: 'missing' }),
      site({ callForm: 'member' }),
      site({ callForm: 'constructor' }),
      site({ callForm: 'index' }),
      site({ kind: 'read' }),
      site({ callForm: undefined }),
      site({ explicitReceiver: { name: 'object' } }),
    ];
    const out = resolveFreeCallReferences(finalizeScopeModel([fixture(defs, sites)]));
    expect(out.stats).toEqual({
      totalSites: 8,
      resolvedSites: 0,
      unresolvedSites: 1,
      ambiguousSites: 1,
      unsupportedSites: 6,
    });
    expect([...out.referenceIndex.bySourceScope]).toEqual([]);
    expect([...out.referenceIndex.byTargetDef]).toEqual([]);
  });

  it('does not resolve a qualified global name when the source scope is absent', () => {
    const def = { ...definition(), qualifiedName: 'pkg.run' };
    const out = resolveFreeCallReferences(
      finalizeScopeModel([fixture([def], [site({ name: 'pkg.run', inScope: 'scope:missing' })])]),
    );
    expect(out.stats).toEqual({
      totalSites: 1,
      resolvedSites: 0,
      unresolvedSites: 1,
      ambiguousSites: 0,
      unsupportedSites: 0,
    });
    expect(out.referenceIndex.byTargetDef.size).toBe(0);
  });

  it('forwards optional arity to the provider and keeps its compatibility filtering', () => {
    const defs = [definition('def:zero'), definition('def:one')];
    const indexes = finalizeScopeModel([fixture(defs, [site({ arity: 0 }), site()])]);
    const arityCompatibility = vi.fn((_callsite, def: SymbolDefinition) =>
      def.nodeId === 'def:zero' ? ('compatible' as const) : ('incompatible' as const),
    );
    const out = resolveFreeCallReferences(indexes, { arityCompatibility });
    expect(arityCompatibility).toHaveBeenCalledWith({ arity: 0 }, defs[0]);
    expect(arityCompatibility).toHaveBeenCalledWith({ arity: 0 }, defs[1]);
    expect(out.referenceIndex.byTargetDef.get('def:zero')).toHaveLength(1);
    expect(out.referenceIndex.byTargetDef.has('def:one')).toBe(false);
    expect(out.stats).toEqual({
      totalSites: 2,
      resolvedSites: 1,
      unresolvedSites: 0,
      ambiguousSites: 1,
      unsupportedSites: 0,
    });
  });

  it.each(['ts', 'tsx', 'js', 'jsx'])(
    'resolves imported aliases through real %s captures while honoring exports and shadowing',
    async (extension) => {
      const lib = await parse(
        'export function Public() {}\nfunction Private() {}',
        `src/lib.${extension}`,
      );
      const app = await parse(
        "import { Public as Alias, Private } from './lib';\n" +
          "import { Unknown } from './missing';\n" +
          'function caller() { Alias(); }\nfunction shadow(Alias) { Alias(); }\nPrivate(); Unknown(); missing();',
        `src/app.${extension}`,
      );
      const paths = [app.filePath, lib.filePath];
      const ctx: ResolveCtx = {
        allFilePaths: new Set(paths),
        allFileList: paths,
        normalizedFileList: paths,
        index: buildSuffixIndex(paths, paths),
        resolveCache: new Map(),
        configs: {
          tsconfigPaths: null,
          goModule: null,
          composerConfig: null,
          swiftPackageConfig: null,
          csharpConfigs: [],
        },
      };
      const workspaceIndex = buildImportTargetWorkspace(
        new Map([
          [SupportedLanguages.TypeScript, typescriptProvider],
          [SupportedLanguages.JavaScript, javascriptProvider],
        ]),
        ctx,
      );
      const indexes = finalizeScopeModel([app, lib], {
        workspaceIndex,
        hooks: { resolveImportTarget: resolveImportTargetAcrossLanguages },
      });
      const beforeBindings = [...indexes.bindings].map(([id, bindings]) => [id, [...bindings]]);
      const out = resolveFreeCallReferences(indexes);
      const publicDef = lib.localDefs.find((def) => def.qualifiedName === 'Public')!;
      const references = out.referenceIndex.byTargetDef.get(publicDef.nodeId)!;
      const aliasSites = app.referenceSites.filter((input) => input.name === 'Alias');
      expect(aliasSites).toHaveLength(2);
      expect(references).toHaveLength(1);
      expect(references[0]).toMatchObject({
        toDef: publicDef.nodeId,
        fromScope: aliasSites[0]!.inScope,
        atRange: aliasSites[0]!.atRange,
        kind: 'call',
      });
      expect(references[0]!.evidence).toContainEqual(expect.objectContaining({ kind: 'import' }));
      expect(out.referenceIndex.bySourceScope.get(aliasSites[0]!.inScope)?.[0]).toBe(references[0]);
      expect(out.referenceIndex.bySourceScope.has(aliasSites[1]!.inScope)).toBe(false);
      expect(out.referenceIndex.byTargetDef.size).toBe(1);
      expect(out.stats).toEqual({
        totalSites: 5,
        resolvedSites: 1,
        unresolvedSites: 4,
        ambiguousSites: 0,
        unsupportedSites: 0,
      });
      expect([...indexes.bindings].map(([id, bindings]) => [id, [...bindings]])).toEqual(
        beforeBindings,
      );
    },
  );
});
