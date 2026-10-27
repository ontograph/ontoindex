/**
 * Unit tests for `finalize-orchestrator` (RFC #909 Ring 2 PKG #921).
 *
 * Covers empty-input, single-file, multi-file-with-imports, and the
 * `MutableSemanticModel.attachScopeIndexes` one-shot contract.
 *
 * Uses synthetic ParsedFiles and capture matches, plus a real-parser
 * cross-file fixture through the TS/JS composer and extractor hooks.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  buildFieldRegistry,
  buildMethodRegistry,
  lookupCore,
  resolveTypeRef,
  SupportedLanguages,
} from 'ontoindex-shared';
import type {
  BindingRef,
  CaptureMatch,
  ImportEdge,
  ParsedFile,
  ParsedImport,
  Scope,
  ScopeId,
  SymbolDefinition,
} from 'ontoindex-shared';
import {
  buildScopeRegistryContext,
  finalizeScopeModel,
} from '../../../src/core/ingestion/finalize-orchestrator.js';
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
import { ScopeRetentionStage } from '../../../src/core/ingestion/pipeline-phases/scope-retention-stage.js';
import {
  decodeParsedFileRecord,
  encodeParsedFileRecord,
} from '../../../src/core/ingestion/pipeline-phases/parse-scope-codec.js';
import { createSemanticModel } from '../../../src/core/ingestion/model/semantic-model.js';
import type { ScopeResolutionIndexes } from '../../../src/core/ingestion/model/scope-resolution-indexes.js';

// ─── Fixture helpers ────────────────────────────────────────────────────────

const mkScope = (
  id: ScopeId,
  parent: ScopeId | null,
  filePath: string,
  bindings: Record<string, readonly BindingRef[]> = {},
): Scope => ({
  id,
  parent,
  kind: parent === null ? 'Module' : 'Class',
  range: { startLine: 1, startCol: 0, endLine: 100, endCol: 0 },
  filePath,
  bindings: new Map(Object.entries(bindings)),
  ownedDefs: [],
  imports: [],
  typeBindings: new Map(),
});

const mkFile = (filePath: string, overrides: Partial<ParsedFile> = {}): ParsedFile => ({
  filePath,
  moduleScope: `scope:${filePath}#module`,
  scopes: overrides.scopes ?? [mkScope(`scope:${filePath}#module`, null, filePath)],
  parsedImports: overrides.parsedImports ?? [],
  localDefs: overrides.localDefs ?? [],
  referenceSites: overrides.referenceSites ?? [],
  ...(Object.hasOwn(overrides, 'exports') ? { exports: overrides.exports } : {}),
  ...(Object.hasOwn(overrides, 'exportsByNamespace')
    ? { exportsByNamespace: overrides.exportsByNamespace }
    : {}),
});

const mkDef = (nodeId: string, filePath: string, qname: string): SymbolDefinition => ({
  nodeId,
  filePath,
  type: 'Class',
  qualifiedName: qname,
});

async function parseTypeScriptFixture(source: string, filePath: string): Promise<ParsedFile> {
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
  });
}

function extractedBindingsFixture(): ParsedFile {
  const capture = (name: string, text: string, startLine: number, endLine = startLine) => ({
    name,
    text,
    range: { startLine, startCol: 0, endLine, endCol: 1 },
  });
  const declaration = (name: string, line: number, qualifiedName: string): CaptureMatch => ({
    '@declaration.variable': capture('@declaration.variable', name, line),
    '@declaration.name': capture('@declaration.name', name, line),
    '@declaration.qualified_name': capture('@declaration.qualified_name', qualifiedName, line),
  });
  return extract(
    [
      { '@scope.module': capture('@scope.module', '', 1, 100) },
      { '@scope.function': capture('@scope.function', '', 10, 30) },
      declaration('X', 2, 'fixture.X'),
      declaration('X', 12, 'fixture.fn.X'),
      declaration('secret', 13, 'fixture.fn.secret'),
      declaration('hoisted', 14, 'fixture.fn.hoisted'),
      declaration('Alias', 3, 'fixture.Internal'),
    ],
    'fixture.ts',
    {
      bindingScopeFor(match, _innermost, tree) {
        if (match['@declaration.name']?.text !== 'hoisted') return null;
        return [...tree.byId.values()].find((scope) => scope.kind === 'Module')!.id;
      },
    },
  );
}

function expectExtractedBindings(out: ScopeResolutionIndexes, file: ParsedFile) {
  const module = file.scopes.find((scope) => scope.id === file.moduleScope)!;
  const fn = file.scopes.find((scope) => scope.kind === 'Function')!;
  const ids = (scope: ScopeId, name: string) =>
    (out.bindings.get(scope)?.get(name) ?? []).map((ref) => ref.def.qualifiedName);
  expect(ids(module.id, 'X')).toEqual(['fixture.X']);
  expect(ids(module.id, 'secret')).toEqual([]);
  expect(ids(module.id, 'hoisted')).toEqual(['fixture.fn.hoisted']);
  expect(ids(module.id, 'Alias')).toEqual(['fixture.Internal']);
  expect(ids(module.id, 'Internal')).toEqual([]);
  expect(out.scopeTree.byId.get(fn.id)?.bindings).toEqual(fn.bindings);
  expect(fn.bindings.get('X')?.map((ref) => ref.def.qualifiedName)).toEqual(['fixture.fn.X']);
  expect(fn.bindings.get('secret')?.map((ref) => ref.def.qualifiedName)).toEqual([
    'fixture.fn.secret',
  ]);
  expect(fn.bindings.has('hoisted')).toBe(false);
  expect(fn.ownedDefs.map((def) => def.qualifiedName)).toEqual([
    'fixture.fn.X',
    'fixture.fn.secret',
    'fixture.fn.hoisted',
  ]);
  expect([...out.defs.byId.values()]).toEqual(file.localDefs);
  for (const def of file.localDefs) {
    expect(out.qualifiedNames.get(def.qualifiedName!)).toEqual([def.nodeId]);
  }
}

describe('finalizeScopeModel: namespace retention', () => {
  const resolveImportTarget = (targetRaw: string) => (targetRaw === 'lib.ts' ? 'lib.ts' : null);
  const linkedState = (out: ScopeResolutionIndexes) => ({
    imports: out.imports,
    bindings: out.bindings,
    stats: out.stats,
    sccs: out.sccs,
  });

  it('matches direct finalization after retention for distinct identities and a type-only class', () => {
    const typeDef = { ...mkDef('def:type', 'lib.ts', 'lib.Shared'), type: 'Interface' as const };
    const valueDef = { ...mkDef('def:value', 'lib.ts', 'lib.Shared'), type: 'Variable' as const };
    const classDef = mkDef('def:class', 'lib.ts', 'lib.Class');
    const files = [
      mkFile('lib.ts', {
        localDefs: [typeDef, valueDef, classDef],
        exports: new Map([
          ['Shared', valueDef.nodeId],
          ['Class', classDef.nodeId],
        ]),
        exportsByNamespace: {
          type: new Map([
            ['Shared', typeDef.nodeId],
            ['Class', classDef.nodeId],
          ]),
          value: new Map([
            ['Shared', valueDef.nodeId],
            ['Class', classDef.nodeId],
          ]),
        },
      }),
      mkFile('app.ts', {
        parsedImports: [
          { kind: 'named', targetRaw: 'lib.ts', importedName: 'Shared', localName: 'Shared' },
          {
            kind: 'named',
            targetRaw: 'lib.ts',
            importedName: 'Class',
            localName: 'Class',
            namespace: 'type',
          },
        ],
      }),
    ];
    const direct = finalizeScopeModel(files, { hooks: { resolveImportTarget } });
    const retained = finalizeScopeModel(
      files.map((file) => decodeParsedFileRecord(encodeParsedFileRecord(file))),
      { hooks: { resolveImportTarget } },
    );
    expect(linkedState(retained)).toEqual(linkedState(direct));
    const bindings = retained.bindings.get('scope:app.ts#module')!;
    expect(
      bindings.get('Shared')?.map((binding) => [binding.def.nodeId, binding.namespace]),
    ).toEqual([
      ['def:type', 'type'],
      ['def:value', 'value'],
    ]);
    expect(
      bindings.get('Class')?.map((binding) => [binding.def.nodeId, binding.namespace]),
    ).toEqual([['def:class', 'type']]);
    expect(retained.stats.totalEdges).toBe(2);
    expect(retained.stats.linkedEdges).toBe(2);
  });

  it.each(['absent', 'undefined', 'empty', 'type-only'] as const)(
    'forwards %s namespace exports with authoritative empty maps and legacy fallback',
    (state) => {
      const def = mkDef('def:class', 'lib.ts', 'lib.Class');
      const lib = mkFile('lib.ts', {
        localDefs: [def],
        exports: new Map([['Class', def.nodeId]]),
        ...(state === 'absent'
          ? {}
          : {
              exportsByNamespace:
                state === 'undefined'
                  ? undefined
                  : {
                      type: new Map(state === 'type-only' ? [['Class', def.nodeId]] : []),
                      value: new Map(),
                    },
            }),
      });
      const files = [
        lib,
        mkFile('app.ts', {
          parsedImports: [
            {
              kind: 'named',
              targetRaw: 'lib.ts',
              importedName: 'Class',
              localName: 'Class',
              namespace: 'value',
            },
          ],
        }),
      ];
      const direct = finalizeScopeModel(files, { hooks: { resolveImportTarget } });
      const restored = finalizeScopeModel(
        files.map((file) => decodeParsedFileRecord(encodeParsedFileRecord(file))),
        { hooks: { resolveImportTarget } },
      );
      expect(linkedState(restored)).toEqual(linkedState(direct));
      const visible = restored.bindings.get('scope:app.ts#module')?.get('Class') ?? [];
      expect(visible.map((binding) => binding.def.nodeId)).toEqual(
        state === 'absent' || state === 'undefined' ? ['def:class'] : [],
      );
      expect(restored.stats.linkedEdges).toBe(state === 'absent' || state === 'undefined' ? 1 : 0);
    },
  );
});

// ─── Empty input ───────────────────────────────────────────────────────────

describe('finalizeScopeModel: empty input', () => {
  it('produces a valid but empty bundle for zero parsedFiles', () => {
    const out = finalizeScopeModel([]);
    expect(out.scopeTree.size).toBe(0);
    expect(out.defs.size).toBe(0);
    expect(out.qualifiedNames.size).toBe(0);
    expect(out.moduleScopes.size).toBe(0);
    expect(out.methodDispatch.mroByOwnerDefId.size).toBe(0);
    expect(out.imports.size).toBe(0);
    expect(out.bindings.size).toBe(0);
    expect(out.referenceSites).toEqual([]);
    expect(out.sccs).toEqual([]);
    expect(out.stats.totalFiles).toBe(0);
    expect(out.stats.totalEdges).toBe(0);
  });
});

// ─── Single file ───────────────────────────────────────────────────────────

describe('finalizeScopeModel: single file', () => {
  it('uses extracted module bindings while retaining nested definitions and function bindings', () => {
    const file = extractedBindingsFixture();
    const before = file.scopes.map((scope) => [...scope.bindings]);
    const out = finalizeScopeModel([file]);
    expectExtractedBindings(out, file);
    expect(file.scopes.map((scope) => [...scope.bindings])).toEqual(before);
  });

  it('honors an empty module binding map and falls back only when the module scope is absent', () => {
    const hidden = mkDef('def:hidden', 'empty.ts', 'empty.fn.hidden');
    const explicit = mkFile('empty.ts', { localDefs: [hidden] });
    const legacy = mkFile('legacy.ts', {
      scopes: [],
      localDefs: [mkDef('def:legacy', 'legacy.ts', 'legacy.X')],
    });
    const out = finalizeScopeModel([explicit, legacy]);
    expect([...out.bindings.get(explicit.moduleScope)!]).toEqual([]);
    expect(
      out.bindings
        .get(legacy.moduleScope)
        ?.get('X')
        ?.map((ref) => ref.def.nodeId),
    ).toEqual(['def:legacy']);
    expect(out.defs.get('def:hidden')).toBe(hidden);
  });

  it('builds all per-file indexes from a single ParsedFile', () => {
    const userClass = mkDef('def:User', 'models.ts', 'models.User');
    const file = mkFile('models.ts', {
      localDefs: [userClass],
    });
    const out = finalizeScopeModel([file]);

    expect(out.scopeTree.size).toBe(1);
    expect(out.defs.get('def:User')).toBe(userClass);
    expect(out.qualifiedNames.get('models.User')).toEqual(['def:User']);
    expect(out.moduleScopes.get('models.ts')).toBe(file.moduleScope);
    expect(out.stats.totalFiles).toBe(1);
  });

  it('forwards per-file referenceSites into the aggregated list', () => {
    const file = mkFile('a.ts', {
      referenceSites: [
        {
          name: 'save',
          atRange: { startLine: 5, startCol: 0, endLine: 5, endCol: 4 },
          inScope: 'scope:a.ts#module',
          kind: 'call',
        },
      ],
    });
    const out = finalizeScopeModel([file]);
    expect(out.referenceSites).toHaveLength(1);
    expect(out.referenceSites[0]!.name).toBe('save');
  });
});

// ─── Multi-file with cross-file imports ────────────────────────────────────

describe('buildScopeRegistryContext', () => {
  it.each(['flat', 'namespaced', 'private', 'empty', 'value-only', 'authoritative-empty'] as const)(
    'resolves namespace receiver types through the finalized %s export surface',
    (surface) => {
      const owner = mkDef('def:owner', 'lib.ts', 'lib.Internal');
      const privateDef = mkDef('def:private', 'lib.ts', 'lib.Private');
      const collision = mkDef('def:collision', 'unrelated.ts', 'ns.Public');
      const member = (owner: SymbolDefinition, type: 'Method' | 'Property'): SymbolDefinition => ({
        nodeId: `${owner.nodeId}:${type}`,
        filePath: owner.filePath,
        type,
        qualifiedName: `${owner.qualifiedName}.${type === 'Method' ? 'save' : 'field'}`,
        ownerId: owner.nodeId,
      });
      const methods = [member(owner, 'Method'), member(collision, 'Method')];
      const fields = [member(owner, 'Property'), member(collision, 'Property')];
      const exported = surface === 'flat' || surface === 'namespaced';
      const lib = mkFile('lib.ts', {
        localDefs: [owner, privateDef, methods[0]!, fields[0]!],
        ...(surface === 'private'
          ? {}
          : {
              exports: new Map(surface === 'empty' ? [] : [['Public', owner.nodeId]]),
            }),
        ...(['namespaced', 'value-only', 'authoritative-empty'].includes(surface)
          ? {
              exportsByNamespace: {
                type: new Map(surface === 'namespaced' ? [['Public', owner.nodeId]] : []),
                value: new Map(surface === 'value-only' ? [['Public', owner.nodeId]] : []),
              },
            }
          : {}),
      });
      const app = mkFile('app.ts', {
        parsedImports: [
          {
            kind: 'namespace',
            localName: 'ns',
            importedName: '*',
            targetRaw: 'lib.ts',
            namespace: 'type',
          },
        ],
      });
      const module = {
        ...app.scopes[0]!,
        typeBindings: new Map([
          [
            'receiver',
            {
              rawName: 'ns.Public',
              declaredAtScope: app.moduleScope,
              source: 'annotation' as const,
            },
          ],
        ]),
      };
      const indexes = finalizeScopeModel(
        [
          { ...app, scopes: [module] },
          lib,
          mkFile('unrelated.ts', { localDefs: [collision, methods[1]!, fields[1]!] }),
        ],
        { hooks: { resolveImportTarget: () => 'lib.ts' } },
      );
      const context = buildScopeRegistryContext(indexes);
      expect(context.lookupExport).toBe(indexes.lookupExport);
      expect(indexes.lookupExport?.(lib.moduleScope, 'Public', 'type')).toEqual(
        exported ? [owner] : [],
      );
      expect(indexes.lookupExport?.(lib.moduleScope, 'Private', 'type')).toEqual([]);
      expect(indexes.lookupExport?.('scope:missing', 'Public', 'type')).toEqual([]);
      expect(
        resolveTypeRef(
          {
            rawName: 'ns.Public',
            declaredAtScope: app.moduleScope,
            source: 'annotation',
          },
          {
            scopes: context.scopes,
            defIndex: context.defs,
            qualifiedNameIndex: context.qualifiedNames,
            lookupExport: context.lookupExport,
          },
        ),
      ).toBe(exported ? owner : null);
      for (const [registry, name, target] of [
        [buildMethodRegistry(context), 'save', methods[0]],
        [buildFieldRegistry(context), 'field', fields[0]],
      ] as const) {
        const hits = registry.lookup(name, app.moduleScope, {
          explicitReceiver: { name: 'receiver' },
        });
        expect(hits.map((hit) => hit.def)).toEqual(exported ? [target] : []);
        if (exported)
          expect(hits[0]!.evidence.some((item) => item.kind === 'type-binding')).toBe(true);
      }
    },
  );

  it('keeps exported type and value meanings separate', () => {
    const type = { ...mkDef('def:type', 'lib.ts', 'lib.Shared'), type: 'Interface' as const };
    const value = { ...mkDef('def:value', 'lib.ts', 'lib.Shared'), type: 'Variable' as const };
    const lib = mkFile('lib.ts', {
      localDefs: [type, value],
      exports: new Map([['Public', value.nodeId]]),
      exportsByNamespace: {
        type: new Map([['Public', type.nodeId]]),
        value: new Map([['Public', value.nodeId]]),
      },
    });
    const indexes = finalizeScopeModel([lib]);
    expect(indexes.lookupExport?.(lib.moduleScope, 'Public', 'type')).toEqual([type]);
    expect(indexes.lookupExport?.(lib.moduleScope, 'Public', 'value')).toEqual([value]);
  });

  it.each(['type', 'value'] as const)(
    'retains finalized module-only %s namespace imports when guarding qualified lookup',
    (namespace) => {
      const conflict = mkDef('def:conflict', 'unrelated.ts', 'ns.Member');
      const app = mkFile('app.ts', {
        parsedImports: [
          {
            kind: 'namespace',
            localName: 'ns',
            importedName: 'lib',
            targetRaw: 'lib.ts',
            namespace,
          },
        ],
      });
      const indexes = finalizeScopeModel(
        [app, mkFile('lib.ts'), mkFile('unrelated.ts', { localDefs: [conflict] })],
        { hooks: { resolveImportTarget: () => 'lib.ts' } },
      );
      const edges = indexes.imports.get(app.moduleScope)!;
      expect(edges).toEqual([
        {
          kind: 'namespace',
          localName: 'ns',
          targetExportedName: 'lib',
          targetFile: 'lib.ts',
          targetModuleScope: 'scope:lib.ts#module',
          namespace,
        },
      ]);
      expect(indexes.bindings.get(app.moduleScope)?.has('ns')).toBe(false);

      const context = buildScopeRegistryContext(indexes);
      expect(context.scopes.getScope(app.moduleScope)?.imports).toBe(edges);
      expect(context.qualifiedNames.get('ns.Member')).toEqual([conflict.nodeId]);
      for (const lexicalNamespace of ['type', 'value'] as const) {
        expect(
          lookupCore(
            'ns.Member',
            app.moduleScope,
            {
              acceptedKinds: ['Class'],
              lexicalNamespace,
              useReceiverTypeBinding: false,
              ownerScopedContributor: null,
            },
            context,
          ),
        ).toEqual([]);
      }
      expect(
        resolveTypeRef(
          {
            rawName: 'ns.Member',
            declaredAtScope: app.moduleScope,
            source: 'annotation',
          },
          {
            scopes: context.scopes,
            defIndex: context.defs,
            qualifiedNameIndex: context.qualifiedNames,
          },
        ),
      ).toBeNull();
      expect(indexes.scopeTree.getScope(app.moduleScope)).toBe(app.scopes[0]);
      expect(app.scopes[0]!.imports).toEqual([]);
    },
  );

  it('honors empty finalized imports, preserves absent entries and nested scopes without mutation', () => {
    const originalImports: readonly ImportEdge[] = Object.freeze([
      {
        kind: 'namespace',
        localName: 'original',
        targetExportedName: 'lib',
        targetFile: 'lib.ts',
        namespace: 'type',
      },
    ]);
    const explicit = Object.freeze({
      ...mkScope('scope:empty.ts#module', null, 'empty.ts'),
      imports: originalImports,
    });
    const fallback = Object.freeze({
      ...mkScope('scope:fallback.ts#module', null, 'fallback.ts'),
      imports: originalImports,
    });
    const nested = Object.freeze({
      ...mkScope('scope:empty.ts#nested', explicit.id, 'empty.ts'),
      imports: originalImports,
    });
    const finalized = finalizeScopeModel([
      mkFile('empty.ts', { scopes: [explicit, nested] }),
      mkFile('fallback.ts', { scopes: [fallback] }),
    ]);
    const emptyImports: readonly ImportEdge[] = Object.freeze([]);
    const indexes = {
      ...finalized,
      imports: new Map([
        [explicit.id, emptyImports],
        [nested.id, emptyImports],
      ]),
    };
    const context = buildScopeRegistryContext(indexes);

    expect(context.scopes.getScope(explicit.id)?.imports).toBe(emptyImports);
    expect(context.scopes.getScope(fallback.id)?.imports).toBe(originalImports);
    expect(context.scopes.getScope(nested.id)).toBe(nested);
    expect(indexes.scopeTree.getScope(explicit.id)).toBe(explicit);
    expect(explicit.imports).toBe(originalImports);
    expect(fallback.imports).toBe(originalImports);
    expect(indexes.imports.has(fallback.id)).toBe(false);
  });

  it('honors finalized empty bindings, falls back for absent entries, and forwards providers', () => {
    const callable: SymbolDefinition = {
      ...mkDef('def:callable', 'fallback.ts', 'fallback.callable'),
      type: 'Function',
    };
    const binding: BindingRef = { def: callable, origin: 'local' };
    const explicit = mkFile('empty.ts', {
      scopes: [mkScope('scope:empty.ts#module', null, 'empty.ts', { callable: [binding] })],
    });
    const fallback = mkFile('fallback.ts', {
      scopes: [mkScope('scope:fallback.ts#module', null, 'fallback.ts', { callable: [binding] })],
      localDefs: [callable],
    });
    const finalized = finalizeScopeModel([explicit, fallback]);
    const emptyBindings = new Map<string, readonly BindingRef[]>();
    const indexes = {
      ...finalized,
      bindings: new Map([[explicit.moduleScope, emptyBindings]]),
    };
    const providers = { arityCompatibility: vi.fn(() => 'compatible' as const) };
    const context = buildScopeRegistryContext(indexes, providers);
    const registry = buildMethodRegistry(context);

    expect(context.providers).toBe(providers);
    expect(buildScopeRegistryContext(indexes).providers).toEqual({});
    expect(context.scopes.getScope(explicit.moduleScope)?.bindings).toBe(emptyBindings);
    expect(context.scopes.getScope(fallback.moduleScope)?.bindings).toBe(
      fallback.scopes[0]!.bindings,
    );
    expect(registry.lookup('callable', explicit.moduleScope)).toEqual([]);
    expect(
      registry.lookup('callable', fallback.moduleScope, { callsite: { arity: 0 } })[0]?.def,
    ).toBe(callable);
    expect(providers.arityCompatibility).toHaveBeenCalledWith({ arity: 0 }, callable);
    expect(indexes.scopeTree.getScope(explicit.moduleScope)).toBe(explicit.scopes[0]);
    expect(explicit.scopes[0]!.bindings.get('callable')).toEqual([binding]);
    expect(indexes.bindings.size).toBe(1);
    expect(indexes.bindings.has(fallback.moduleScope)).toBe(false);
  });
});

describe('finalizeScopeModel: cross-file imports', () => {
  describe.each([
    { name: 'relative extensionless', targetRaw: './lib', targetStem: 'src/lib' },
    { name: 'directory index', targetRaw: './lib', targetStem: 'src/lib/index' },
    { name: 'configured alias', targetRaw: '@/lib', targetStem: 'src/lib' },
  ])('real resolver seam: $name', ({ targetRaw, targetStem }) => {
    it.each(['ts', 'tsx', 'js', 'jsx'])(
      'links only exported %s definitions and preserves local shadowing',
      async (extension) => {
        const lib = await parseTypeScriptFixture(
          'export function Public() {}\nfunction Private() {}',
          `${targetStem}.${extension}`,
        );
        const app = await parseTypeScriptFixture(
          `import { Public as Alias, Private } from '${targetRaw}';\n` +
            "import { Unknown } from './missing';\n" +
            'function owner(Alias) { Alias(); }\nAlias();',
          `src/app.${extension}`,
        );
        const allFileList = [app.filePath, lib.filePath];
        const ctx: ResolveCtx = {
          allFilePaths: new Set(allFileList),
          allFileList,
          normalizedFileList: allFileList,
          index: buildSuffixIndex(allFileList, allFileList),
          resolveCache: new Map(),
          configs: {
            tsconfigPaths: targetRaw.startsWith('@/')
              ? { baseUrl: '.', aliases: new Map([['@/', 'src/']]) }
              : null,
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
        const out = finalizeScopeModel([app, lib], {
          workspaceIndex,
          hooks: { resolveImportTarget: resolveImportTargetAcrossLanguages },
        });

        const publicDef = lib.localDefs.find((def) => def.qualifiedName === 'Public')!;
        const privateDef = lib.localDefs.find((def) => def.qualifiedName === 'Private')!;
        expect(publicDef).toBeDefined();
        expect(privateDef).toBeDefined();
        const imports = out.imports.get(app.moduleScope)!;
        expect(imports).toEqual([
          expect.objectContaining({
            localName: 'Alias',
            targetFile: lib.filePath,
            targetDefId: publicDef.nodeId,
          }),
          expect.objectContaining({
            localName: 'Private',
            targetFile: lib.filePath,
            linkStatus: 'unresolved',
          }),
          expect.objectContaining({
            localName: 'Unknown',
            targetFile: null,
            linkStatus: 'unresolved',
          }),
        ]);
        expect(imports[0]!.linkStatus).toBeUndefined();
        expect(imports.slice(1).map((edge) => edge.targetDefId)).toEqual([undefined, undefined]);
        expect(out.bindings.get(app.moduleScope)?.get('Alias')).toEqual([
          { def: publicDef, origin: 'import', via: imports[0] },
        ]);
        expect(out.bindings.get(app.moduleScope)?.has('Private')).toBe(false);
        expect(out.bindings.get(app.moduleScope)?.has('Unknown')).toBe(false);
        expect(out.defs.get(publicDef.nodeId)).toBe(publicDef);
        expect(out.defs.get(privateDef.nodeId)).toBe(privateDef);
        const owner = app.scopes.find((scope) => scope.kind === 'Function')!;
        const parameter = owner.bindings.get('Alias')![0]!;
        expect(parameter.origin).toBe('local');
        expect(parameter.def.nodeId).not.toBe(publicDef.nodeId);
        expect(out.scopeTree.byId.get(owner.id)?.bindings.get('Alias')).toEqual([parameter]);
        expect(out.scopeTree.byId.get(app.moduleScope)?.bindings.has('Alias')).toBe(false);
        const structuralScopes = [...out.scopeTree.byId.values()];
        const originalBindings = structuralScopes.map((scope) => [...scope.bindings]);
        const registryContext = buildScopeRegistryContext(out);
        const registry = buildMethodRegistry(registryContext);
        expect(registryContext.defs).toBe(out.defs);
        expect(registryContext.qualifiedNames).toBe(out.qualifiedNames);
        expect(registryContext.moduleScopes).toBe(out.moduleScopes);
        expect(registryContext.methodDispatch).toBe(out.methodDispatch);
        const registryModule = registryContext.scopes.getScope(app.moduleScope)!;
        expect(registryModule).not.toBe(out.scopeTree.getScope(app.moduleScope));
        expect(registryModule).toBe(registryContext.scopes.byId.get(app.moduleScope));
        expect(registryModule.bindings).toBe(out.bindings.get(app.moduleScope));
        expect(registryContext.scopes.getParent(owner.id)).toBe(registryModule);
        for (const scope of structuralScopes.filter((scope) => scope.kind !== 'Module')) {
          expect(registryContext.scopes.getScope(scope.id)).toBe(scope);
        }
        const aliasSites = out.referenceSites.filter((site) => site.name === 'Alias');
        expect(aliasSites).toHaveLength(2);
        for (const site of aliasSites) {
          expect(site.kind).toBe('call');
          expect(site.callForm).toBe('free');
          const resolutions = registry.lookup(site.name, site.inScope, {
            callsite: { arity: site.arity! },
          });
          if (site.inScope === app.moduleScope) {
            expect(resolutions).toHaveLength(1);
            expect(resolutions[0]!.def).toBe(publicDef);
            expect(resolutions[0]!.confidence).toBeGreaterThan(0);
            expect(resolutions[0]!.evidence).toEqual(
              expect.arrayContaining([expect.objectContaining({ kind: 'import' })]),
            );
          } else {
            expect(resolutions).toEqual([]);
          }
        }
        expect(registry.lookup('Private', app.moduleScope)).toEqual([]);
        expect(registry.lookup('Unknown', app.moduleScope)).toEqual([]);
        expect([...out.scopeTree.byId.values()]).toEqual(structuralScopes);
        expect(structuralScopes.map((scope) => [...scope.bindings])).toEqual(originalBindings);
        expect(
          app.scopes.find((scope) => scope.id === app.moduleScope)?.bindings.has('Alias'),
        ).toBe(false);
        expect(out.referenceSites).toEqual(app.referenceSites);
        expect(out.stats).toMatchObject({
          totalFiles: 2,
          totalEdges: 3,
          linkedEdges: 1,
          unresolvedEdges: 2,
        });
      },
    );
  });

  it.each(['ts', 'tsx', 'js', 'jsx'])(
    'finalizes real %s exports and import aliases while preserving lexical shadowing',
    async (extension) => {
      const lib = await parseTypeScriptFixture(
        'export function Public() {}\nfunction Private() {}',
        `lib.${extension}`,
      );
      const app = await parseTypeScriptFixture(
        "import { Public as Alias, Private } from './lib';\n" +
          'function owner(Alias) { Alias(); }\nAlias();\nmissing();',
        `app.${extension}`,
      );
      const publicDef = lib.localDefs.find((def) => def.qualifiedName === 'Public')!;
      const privateDef = lib.localDefs.find((def) => def.qualifiedName === 'Private')!;
      expect(publicDef).toBeDefined();
      expect(privateDef).toBeDefined();
      expect(lib.exports).toEqual(new Map([['Public', publicDef.nodeId]]));
      expect(app.exports).toEqual(new Map());
      expect(app.parsedImports).toHaveLength(2);

      const out = finalizeScopeModel([app, lib], {
        hooks: { resolveImportTarget: (raw) => (raw === './lib' ? lib.filePath : null) },
      });
      const imports = out.imports.get(app.moduleScope)!;
      expect(imports).toHaveLength(2);
      const aliasImport = imports.find((edge) => edge.localName === 'Alias')!;
      expect(aliasImport).toMatchObject({
        targetFile: lib.filePath,
        targetDefId: publicDef.nodeId,
      });
      expect(aliasImport.linkStatus).toBeUndefined();
      const privateImport = imports.find((edge) => edge.localName === 'Private')!;
      expect(privateImport.linkStatus).toBe('unresolved');
      expect(privateImport.targetDefId).toBeUndefined();
      expect(out.bindings.get(app.moduleScope)?.get('Alias')).toEqual([
        { def: publicDef, origin: 'import', via: aliasImport },
      ]);
      expect(out.bindings.get(app.moduleScope)?.has('Private')).toBe(false);
      expect(out.defs.get(publicDef.nodeId)).toBe(publicDef);
      expect(out.defs.get(privateDef.nodeId)).toBe(privateDef);

      const owner = app.scopes.find((scope) => scope.kind === 'Function')!;
      const parameter = owner.bindings.get('Alias')![0]!;
      expect(parameter.origin).toBe('local');
      expect(parameter.def.nodeId).not.toBe(publicDef.nodeId);
      expect(out.scopeTree.byId.get(owner.id)?.bindings.get('Alias')).toEqual([parameter]);
      expect(out.scopeTree.byId.get(app.moduleScope)?.bindings.has('Alias')).toBe(false);
      const body = app.scopes.find((scope) => scope.kind === 'Block')!;
      expect(out.scopeTree.byId.get(body.id)?.parent).toBe(owner.id);
      expect(
        out.referenceSites.map(({ name, inScope, kind, callForm, arity }) => ({
          name,
          inScope,
          kind,
          callForm,
          arity,
        })),
      ).toEqual([
        { name: 'Alias', inScope: body.id, kind: 'call', callForm: 'free', arity: 0 },
        { name: 'Alias', inScope: app.moduleScope, kind: 'call', callForm: 'free', arity: 0 },
        { name: 'missing', inScope: app.moduleScope, kind: 'call', callForm: 'free', arity: 0 },
      ]);
      expect(out.referenceSites).toEqual(app.referenceSites);
      expect(out.stats).toMatchObject({
        totalFiles: 2,
        totalEdges: 2,
        linkedEdges: 1,
        unresolvedEdges: 1,
      });
    },
  );

  it('links a named import when the caller provides resolveImportTarget', () => {
    const userClass = mkDef('def:User', 'models.ts', 'models.User');
    const modelsFile = mkFile('models.ts', { localDefs: [userClass] });

    const importOfUser: ParsedImport = {
      kind: 'named',
      localName: 'User',
      importedName: 'User',
      targetRaw: 'models.ts',
    };
    const appFile = mkFile('app.ts', { parsedImports: [importOfUser] });

    const out = finalizeScopeModel([appFile, modelsFile], {
      hooks: {
        resolveImportTarget: (targetRaw) => (targetRaw === 'models.ts' ? 'models.ts' : null),
      },
    });

    const appImports = out.imports.get(appFile.moduleScope) ?? [];
    expect(appImports).toHaveLength(1);
    expect(appImports[0]!.linkStatus).toBeUndefined();
    expect(appImports[0]!.targetFile).toBe('models.ts');
    expect(appImports[0]!.targetDefId).toBe('def:User');
  });

  it('leaves imports unresolved when no resolveImportTarget is supplied (default hook)', () => {
    // Default `resolveImportTarget: () => null` — every import ends up
    // with `linkStatus: 'unresolved'`. This is the zero-provider case
    // today; behavior is well-defined, not a crash.
    const importOfUser: ParsedImport = {
      kind: 'named',
      localName: 'User',
      importedName: 'User',
      targetRaw: 'models.ts',
    };
    const appFile = mkFile('app.ts', { parsedImports: [importOfUser] });

    const out = finalizeScopeModel([appFile]);
    const appImports = out.imports.get(appFile.moduleScope) ?? [];
    expect(appImports).toHaveLength(1);
    expect(appImports[0]!.linkStatus).toBe('unresolved');
  });

  it('surfaces FinalizeStats for observability', () => {
    const userClass = mkDef('def:User', 'models.ts', 'models.User');
    const modelsFile = mkFile('models.ts', { localDefs: [userClass] });
    const appFile = mkFile('app.ts', {
      parsedImports: [
        {
          kind: 'named',
          localName: 'User',
          importedName: 'User',
          targetRaw: 'models.ts',
        },
      ],
    });
    const out = finalizeScopeModel([appFile, modelsFile], {
      hooks: { resolveImportTarget: () => 'models.ts' },
    });
    expect(out.stats.totalFiles).toBe(2);
    expect(out.stats.totalEdges).toBe(1);
    expect(out.stats.linkedEdges).toBe(1);
    expect(out.stats.unresolvedEdges).toBe(0);
  });
});

// ─── Integration with MutableSemanticModel ─────────────────────────────────

describe('finalizeScopeModel: retained fixture replay', () => {
  // These bounded synthetic hooks exercise finalization, not provider completeness.
  const finalizeFixtures = (files: readonly ParsedFile[]) =>
    finalizeScopeModel(files, {
      hooks: {
        resolveImportTarget: (raw) => (files.some((file) => file.filePath === raw) ? raw : null),
        expandsWildcardTo: (scope) =>
          files
            .find((file) => file.moduleScope === scope)!
            .localDefs.map((def) => def.qualifiedName!.split('.').at(-1)!),
      },
    });
  const contents = (out: ScopeResolutionIndexes) => ({
    scopes: out.scopeTree.byId,
    defs: out.defs.byId,
    qualifiedNames: out.qualifiedNames.byQualifiedName,
    moduleScopes: [...out.scopeTree.byId.values()].map((scope) => [
      scope.filePath,
      out.moduleScopes.get(scope.filePath),
    ]),
    imports: out.imports,
    bindings: out.bindings,
    referenceSites: out.referenceSites,
    sccs: out.sccs,
    stats: out.stats,
  });
  const named = (name: string, targetRaw: string): ParsedImport => ({
    kind: 'named',
    localName: name,
    importedName: name,
    targetRaw,
  });
  const bindings = (out: ScopeResolutionIndexes, file: string, name: string) =>
    (out.bindings.get(`scope:${file}#module`)?.get(name) ?? []).map((ref) => ({
      id: ref.def.nodeId,
      origin: ref.origin,
    }));

  async function replayAfterMapMutation(makeFiles: () => ParsedFile[]) {
    const files = makeFiles();
    const stage = new ScopeRetentionStage(
      {
        deadline: Date.now() + 30_000,
        artifactAllowance: { remainingBytes: 1024 * 1024 },
      },
      { maxRecords: 10, batchRecords: 1 },
    );
    try {
      stage.capture(files);
      stage.recordOutcomes(files.map(({ filePath }) => ({ filePath, status: 'success' })));
      stage.reconcile(files.map(({ filePath }) => filePath));
      for (const file of files) {
        (file.exports as Map<string, string> | undefined)?.clear();
        for (const scope of file.scopes) {
          (scope.bindings as Map<string, readonly BindingRef[]>).clear();
          (scope.typeBindings as Map<string, unknown>).clear();
        }
      }
      const replayed: ParsedFile[] = [];
      for await (const batch of stage.iterate()) replayed.push(...batch);
      expect(stage.status).toBe('retained');
      expect(replayed).toEqual(makeFiles());
      const out = finalizeFixtures(replayed);
      expect(contents(out)).toEqual(contents(finalizeFixtures(makeFiles())));
      return out;
    } finally {
      await stage.dispose();
    }
  }

  function retainedFile(filePath: string, defs: SymbolDefinition[], imports: ParsedImport[] = []) {
    const localBindings: Record<string, BindingRef[]> = {};
    for (const def of defs) {
      const name = def.qualifiedName!.split('.').at(-1)!;
      (localBindings[name] ??= []).push({ def, origin: 'local' });
    }
    const scope = mkScope(`scope:${filePath}#module`, null, filePath, localBindings);
    (scope.typeBindings as Map<string, unknown>).set('Declared', {
      rawName: 'Declared',
      declaredAtScope: scope.id,
      source: 'annotation',
    });
    return mkFile(filePath, { scopes: [scope], localDefs: defs, parsedImports: imports });
  }

  it('replays extracted shadowing, nested-only locals and hoisted bindings unchanged', async () => {
    const out = await replayAfterMapMutation(() => [extractedBindingsFixture()]);
    expectExtractedBindings(out, extractedBindingsFixture());
  });

  it('retains legacy, empty and aliased exports while preserving every local definition', async () => {
    const out = await replayAfterMapMutation(() => {
      const hidden = retainedFile('hidden.ts', [mkDef('def:Hidden', 'hidden.ts', 'hidden.Hidden')]);
      const aliased = retainedFile('aliased.ts', [
        mkDef('def:Original', 'aliased.ts', 'aliased.Original'),
        mkDef('def:Private', 'aliased.ts', 'aliased.Private'),
      ]);
      return [
        retainedFile(
          'app.ts',
          [],
          [
            named('Legacy', 'legacy.ts'),
            named('Hidden', 'hidden.ts'),
            named('PublicAlias', 'aliased.ts'),
            named('Private', 'aliased.ts'),
          ],
        ),
        retainedFile('legacy.ts', [mkDef('def:Legacy', 'legacy.ts', 'legacy.Legacy')]),
        mkFile(hidden.filePath, { ...hidden, exports: new Map() }),
        mkFile(aliased.filePath, {
          ...aliased,
          exports: new Map([['PublicAlias', 'def:Original']]),
        }),
      ];
    });
    expect(out.imports.get('scope:app.ts#module')).toEqual([
      expect.objectContaining({ targetFile: 'legacy.ts', targetDefId: 'def:Legacy' }),
      expect.objectContaining({ targetFile: 'hidden.ts', linkStatus: 'unresolved' }),
      expect.objectContaining({ targetFile: 'aliased.ts', targetDefId: 'def:Original' }),
      expect.objectContaining({ targetFile: 'aliased.ts', linkStatus: 'unresolved' }),
    ]);
    expect(bindings(out, 'app.ts', 'Legacy')).toEqual([{ id: 'def:Legacy', origin: 'import' }]);
    expect(bindings(out, 'app.ts', 'PublicAlias')).toEqual([
      { id: 'def:Original', origin: 'import' },
    ]);
    expect(bindings(out, 'app.ts', 'Hidden')).toEqual([]);
    expect(bindings(out, 'app.ts', 'Private')).toEqual([]);
    expect([...out.defs.byId.keys()]).toEqual([
      'def:Legacy',
      'def:Hidden',
      'def:Original',
      'def:Private',
    ]);
    expect(bindings(out, 'hidden.ts', 'Hidden')).toEqual([{ id: 'def:Hidden', origin: 'local' }]);
    expect(bindings(out, 'aliased.ts', 'Original')).toEqual([
      { id: 'def:Original', origin: 'local' },
    ]);
    expect(bindings(out, 'aliased.ts', 'Private')).toEqual([
      { id: 'def:Private', origin: 'local' },
    ]);
    expect(out.qualifiedNames.get('aliased.Private')).toEqual(['def:Private']);
    expect(out.stats.linkedEdges).toBe(2);
    expect(out.stats.unresolvedEdges).toBe(2);
  });

  it('preserves a two-file cycle and its concrete linked bindings', async () => {
    const out = await replayAfterMapMutation(() => [
      retainedFile('a.ts', [mkDef('def:X', 'a.ts', 'a.X')], [named('Y', 'b.ts')]),
      retainedFile('b.ts', [mkDef('def:Y', 'b.ts', 'b.Y')], [named('X', 'a.ts')]),
    ]);
    expect(out.sccs).toHaveLength(1);
    expect(out.sccs[0]!.isCycle).toBe(true);
    expect(new Set(out.sccs[0]!.files)).toEqual(new Set(['a.ts', 'b.ts']));
    expect(out.imports.get('scope:a.ts#module')?.[0]).toMatchObject({
      targetFile: 'b.ts',
      targetModuleScope: 'scope:b.ts#module',
      targetDefId: 'def:Y',
    });
    expect(out.imports.get('scope:b.ts#module')?.[0]?.targetDefId).toBe('def:X');
    expect(bindings(out, 'a.ts', 'Y')).toEqual([{ id: 'def:Y', origin: 'import' }]);
    expect(bindings(out, 'b.ts', 'X')).toEqual([{ id: 'def:X', origin: 'import' }]);
    expect(out.stats.linkedEdges).toBe(2);
    expect(out.stats.unresolvedEdges).toBe(0);
  });

  it('preserves wildcard expansion and the thin reexport boundary', async () => {
    const out = await replayAfterMapMutation(() => [
      retainedFile(
        'app.ts',
        [],
        [named('X', 'barrel.ts'), { kind: 'wildcard', targetRaw: 'leaf.ts' }],
      ),
      retainedFile('barrel.ts', [], [{ ...named('X', 'leaf.ts'), kind: 'reexport' }]),
      retainedFile('leaf.ts', [mkDef('def:X', 'leaf.ts', 'leaf.X')]),
    ]);
    // Finalize does not promote reexports into the intermediate localDefs.
    expect(out.imports.get('scope:app.ts#module')).toEqual([
      expect.objectContaining({ kind: 'named', targetFile: 'barrel.ts', linkStatus: 'unresolved' }),
      expect.objectContaining({
        kind: 'wildcard-expanded',
        targetFile: 'leaf.ts',
        targetDefId: 'def:X',
      }),
    ]);
    expect(out.imports.get('scope:barrel.ts#module')?.[0]).toMatchObject({
      kind: 'reexport',
      targetDefId: 'def:X',
      transitiveVia: ['leaf.ts'],
    });
    expect(bindings(out, 'app.ts', 'X')).toEqual([{ id: 'def:X', origin: 'wildcard' }]);
    expect(bindings(out, 'barrel.ts', 'X')).toEqual([{ id: 'def:X', origin: 'reexport' }]);
    expect(out.sccs).toHaveLength(3);
    expect(out.sccs.every((scc) => !scc.isCycle)).toBe(true);
  });

  it('preserves collision buckets and current first-match named export selection', async () => {
    const out = await replayAfterMapMutation(() => [
      retainedFile('app.ts', [mkDef('def:local', 'app.ts', 'app.X')], [named('X', 'lib.ts')]),
      retainedFile('lib.ts', [
        mkDef('def:first', 'lib.ts', 'lib.X'),
        mkDef('def:second', 'lib.ts', 'lib.X'),
      ]),
    ]);
    expect(out.qualifiedNames.get('lib.X')).toEqual(['def:first', 'def:second']);
    expect(bindings(out, 'lib.ts', 'X')).toEqual([
      { id: 'def:first', origin: 'local' },
      { id: 'def:second', origin: 'local' },
    ]);
    expect(out.imports.get('scope:app.ts#module')?.[0]?.targetDefId).toBe('def:first');
    expect(bindings(out, 'app.ts', 'X')).toEqual([
      { id: 'def:local', origin: 'local' },
      { id: 'def:first', origin: 'import' },
    ]);
  });
});

describe('MutableSemanticModel.attachScopeIndexes', () => {
  it('starts as undefined and accepts a one-shot attach', () => {
    const model = createSemanticModel();
    expect(model.scopes).toBeUndefined();

    const indexes = finalizeScopeModel([]);
    model.attachScopeIndexes(indexes);

    expect(model.scopes).toBe(indexes);
    expect(model.scopes!.stats.totalFiles).toBe(0);
  });

  it('freezes the attached bundle (callers cannot mutate after attach)', () => {
    const model = createSemanticModel();
    const indexes: ScopeResolutionIndexes = finalizeScopeModel([]);
    model.attachScopeIndexes(indexes);

    expect(Object.isFrozen(model.scopes)).toBe(true);
  });

  it('throws on a second attach without clear()', () => {
    const model = createSemanticModel();
    model.attachScopeIndexes(finalizeScopeModel([]));
    expect(() => model.attachScopeIndexes(finalizeScopeModel([]))).toThrowError(/already attached/);
  });

  it('clear() resets the bundle, enabling re-attach', () => {
    const model = createSemanticModel();
    model.attachScopeIndexes(finalizeScopeModel([]));
    model.clear();
    expect(model.scopes).toBeUndefined();
    // Second attach now succeeds.
    model.attachScopeIndexes(finalizeScopeModel([]));
    expect(model.scopes).toBeDefined();
  });
});
