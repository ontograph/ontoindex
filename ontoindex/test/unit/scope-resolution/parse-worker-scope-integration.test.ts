/**
 * Unit tests for `extractParsedFile` — the parse-worker → ScopeExtractor
 * bridge (RFC #909 Ring 2 PKG #920).
 *
 * The goal is to pin three invariants:
 *
 *   1. When a provider does NOT implement `emitScopeCaptures`, the helper
 *      returns `undefined` silently and the legacy DAG continues unaffected.
 *   2. When a provider DOES implement the hook, the helper threads its
 *      output through `ScopeExtractor.extract` and returns a `ParsedFile`.
 *   3. Exceptions from either the hook or the extractor are caught
 *      locally. The helper returns `undefined` — scope-extraction
 *      failures must NEVER break legacy parsing on the same file.
 */

import { afterEach, describe, it, expect, vi } from 'vitest';
import Parser, { type SyntaxNode } from 'tree-sitter';
import {
  SupportedLanguages,
  type Capture,
  type CaptureMatch,
  type ParsedFile,
} from 'ontoindex-shared';
import {
  extractParsedFile,
  extractParsedFileOutcome,
} from '../../../src/core/ingestion/scope-extractor-bridge.js';
import type { LanguageProvider } from '../../../src/core/ingestion/language-provider.js';
import * as languageProviders from '../../../src/core/ingestion/languages/index.js';
import { processParsing } from '../../../src/core/ingestion/parsing-processor.js';
import { processCalls } from '../../../src/core/ingestion/call-processor.js';
import { createKnowledgeGraph } from '../../../src/core/graph/graph.js';
import { createASTCache } from '../../../src/core/ingestion/ast-cache.js';
import { createResolutionContext } from '../../../src/core/ingestion/model/resolution-context.js';
import type { WorkerPool } from '../../../src/core/ingestion/workers/worker-pool.js';
import {
  createEmptyResult,
  type ExtractedCall,
  type ParseWorkerResult,
} from '../../../src/core/ingestion/workers/parse-types.js';
import type { WorkerDispatchOptions } from '../../../src/core/ingestion/workers/worker-pool.js';
import { createParserForLanguage } from '../../../src/core/tree-sitter/parser-loader.js';
import { emitTypeScriptCaptures } from '../../../src/core/ingestion/languages/typescript-captures.js';
import {
  selectTypeScriptLocalBindings,
  typeScriptDeclarationBindingScope,
  typeScriptDeclarationNamespace,
} from '../../../src/core/ingestion/languages/typescript-declaration-captures.js';
import { interpretTypeScriptImport } from '../../../src/core/ingestion/languages/typescript-import-captures.js';
import { interpretTypeScriptExports } from '../../../src/core/ingestion/languages/typescript-export-captures.js';
import { emitPythonCaptures } from '../../../src/core/ingestion/languages/python-captures.js';
import { extract } from '../../../src/core/ingestion/scope-extractor.js';
import { finalizeScopeModel } from '../../../src/core/ingestion/finalize-orchestrator.js';
import { resolveReferences } from '../../../src/core/ingestion/resolve-references.js';
import { emitReferencesToGraph } from '../../../src/core/ingestion/emit-references.js';

const tsjsPaths = ['fixture.ts', 'fixture.tsx', 'fixture.js', 'fixture.jsx'];
const tsjsSource = [
  "import Main from './module';",
  'export function run(value) { const local = 1; return value; }',
  'run(Main);',
].join('\n');

function tsjsProvider(filePath: string): LanguageProvider {
  const language = /\.jsx?$/.test(filePath)
    ? SupportedLanguages.JavaScript
    : SupportedLanguages.TypeScript;
  const provider = languageProviders.getProvider(language);
  expect(provider.emitScopeCaptures).toBeTypeOf('function');
  expect(provider.bindingScopeFor).toBe(typeScriptDeclarationBindingScope);
  expect(provider.declarationNamespaceFor).toBe(typeScriptDeclarationNamespace);
  expect(provider.selectLocalBindings).toBe(selectTypeScriptLocalBindings);
  expect(provider.interpretImport).toBe(interpretTypeScriptImport);
  expect(provider.interpretExports).toBe(interpretTypeScriptExports);
  return provider;
}

// ─── Capture helpers ────────────────────────────────────────────────────────

const cap = (
  name: string,
  startLine: number,
  startCol: number,
  endLine: number,
  endCol: number,
  text = '',
): Capture => ({ name, range: { startLine, startCol, endLine, endCol }, text });

const moduleScopeMatch = (): CaptureMatch => ({
  '@scope.module': cap('@scope.module', 1, 0, 100, 0),
});

function scopeArtifact(parsedFile: ParsedFile) {
  const { definitionNodeIds: _mapping, ...scope } = parsedFile;
  return scope;
}

describe('processParsing sequential scope artifacts', () => {
  const caches: ReturnType<typeof createASTCache>[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const cache of caches) cache.clear();
    caches.length = 0;
  });

  function setup() {
    const graph = createKnowledgeGraph();
    const symbols = createResolutionContext().model.symbols;
    const cache = createASTCache();
    caches.push(cache);
    return { graph, symbols, cache };
  }

  function scopeHook(
    hook: LanguageProvider['emitScopeCaptures'],
    overrides: Partial<LanguageProvider> = {},
  ) {
    const getProvider = languageProviders.getProvider;
    vi.spyOn(languageProviders, 'getProvider').mockImplementation((language) => ({
      ...getProvider(language),
      ...overrides,
      emitScopeCaptures: hook,
    }));
  }

  function crashingWorkers() {
    const dispatch = vi.fn().mockRejectedValue(new Error('scope regression worker crash'));
    const pool: WorkerPool = {
      size: 1,
      isolation: 'thread',
      startupDurationMs: 0,
      workerStartupDurationsMs: [0],
      terminate: async () => {},
      dispatch,
    };
    return { pool, dispatch };
  }

  it.each(
    tsjsPaths.flatMap((path) =>
      (['sequential', 'mock rejection fallback'] as const).map((mode) => ({ path, mode })),
    ),
  )('attaches exact supported declaration targets in $path with $mode', async ({ path, mode }) => {
    tsjsProvider(path);
    const { graph, symbols, cache } = setup();
    const content = [
      'function unique() {}',
      'export function exposed() {}',
      'function sameLine() {} class SameLine {}',
      'export class ExposedClass {}',
    ].join('\n');
    const workers = crashingWorkers();
    const onArtifacts = vi.fn<(files: readonly ParsedFile[]) => void>();
    const onOutcomes = vi.fn();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(
      await processParsing(
        graph,
        [
          { path, content },
          {
            path: `nested-${path}`,
            content: 'function outer() { function inner() {} }',
          },
        ],
        '/scope-test',
        symbols,
        cache,
        undefined,
        mode === 'mock rejection fallback' ? workers.pool : undefined,
        undefined,
        undefined,
        'sequential',
        undefined,
        onArtifacts,
        onOutcomes,
      ),
    ).toBeNull();
    expect(workers.dispatch).toHaveBeenCalledTimes(mode === 'mock rejection fallback' ? 1 : 0);
    expect(onOutcomes).toHaveBeenCalledExactlyOnceWith([
      { filePath: path, status: 'success' },
      { filePath: `nested-${path}`, status: 'failed', reason: 'unsupported-syntax' },
    ]);
    expect(onArtifacts).toHaveBeenCalledTimes(1);
    expect(onArtifacts.mock.calls[0]![0]).toHaveLength(1);
    const artifact = onArtifacts.mock.calls[0]![0][0]!;
    const sources = artifact.declarationSources!;
    expect(sources.map(({ name }) => name)).toEqual([
      'unique',
      'exposed',
      'sameLine',
      'SameLine',
      'ExposedClass',
    ]);
    const expected = sources.map((source) => {
      const targets = graph.nodes.filter(
        (node) =>
          node.properties.filePath === path &&
          node.properties.name === source.name &&
          node.label === source.type,
      );
      expect(targets).toHaveLength(1);
      return { defId: source.defId, nodeId: targets[0]!.id };
    });
    expect(artifact.definitionNodeIds).toEqual(expected);
    for (const mapping of artifact.definitionNodeIds!) {
      expect(graph.nodes.some((node) => node.id === mapping.nodeId)).toBe(true);
    }
  });

  it.each(
    ['fixture.ts', 'fixture.tsx'].flatMap((path) =>
      (['sequential', 'worker fallback'] as const).flatMap((mode) =>
        [false, true].map((ordinary) => ({ path, mode, ordinary })),
      ),
    ),
  )(
    'retains nominal interface scopes through borrowed roots in $path with $mode (ordinary imports: $ordinary)',
    async ({ path, mode, ordinary }) => {
      const { graph, symbols, cache } = setup();
      const provider = tsjsProvider(path);
      const emit = provider.emitScopeCaptures!;
      const borrowedRoots: SyntaxNode[] = [];
      vi.spyOn(provider, 'emitScopeCaptures').mockImplementation((source, filePath, root) => {
        expect(root).toBe(cache.get(filePath)?.rootNode);
        if (!root) throw new Error('Missing borrowed root');
        borrowedRoots.push(root);
        return emit(source, filePath, root);
      });
      const content = [
        ...(ordinary
          ? [
              'import Main, { Value as Renamed } from "./module";',
              'import * as types from "./types.js";',
            ]
          : []),
        'import type { Range } from "./types.js";',
        'export type ReferenceKind = "call" | "read";',
        'export interface ReferenceSite { readonly name: string; readonly atRange: Range; readonly kind: ReferenceKind; }',
        'export interface ExtendedSite extends ReferenceSite { resolve(name: string): Promise<unknown>; }',
      ].join('\n');
      const files = [{ path, content }];
      const parse = vi.spyOn(Parser.prototype, 'parse');
      const workers = crashingWorkers();
      const onArtifacts = vi.fn<(files: readonly ParsedFile[]) => void>();
      const onOutcomes = vi.fn();
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      await processParsing(
        graph,
        files,
        '/scope-test',
        symbols,
        cache,
        undefined,
        mode === 'worker fallback' ? workers.pool : undefined,
        undefined,
        undefined,
        'sequential',
        undefined,
        onArtifacts,
        onOutcomes,
      );
      expect(parse).toHaveBeenCalledTimes(1);
      expect(borrowedRoots).toHaveLength(1);
      expect(workers.dispatch).toHaveBeenCalledTimes(mode === 'worker fallback' ? 1 : 0);
      const direct = extract(emitTypeScriptCaptures(cache.get(path)!.rootNode), path, provider);
      expect(onArtifacts).toHaveBeenCalledTimes(1);
      expect(onArtifacts.mock.calls[0]![0].map(scopeArtifact)).toEqual([direct]);
      expect(onOutcomes).toHaveBeenCalledExactlyOnceWith([{ filePath: path, status: 'success' }]);
      expect(direct.scopes.map(({ kind }) => kind)).toEqual(['Module', 'Class', 'Class']);
      expect(direct.scopes.slice(1).map(({ parent }) => parent)).toEqual([
        direct.scopes[0]!.id,
        direct.scopes[0]!.id,
      ]);
      expect(direct.localDefs.map(({ qualifiedName, type }) => ({ qualifiedName, type }))).toEqual([
        { qualifiedName: 'ReferenceKind', type: 'TypeAlias' },
        { qualifiedName: 'ReferenceSite', type: 'Interface' },
        { qualifiedName: 'ExtendedSite', type: 'Interface' },
      ]);
      expect([...direct.scopes[0]!.bindings]).toEqual(
        direct.localDefs.map((def) => [
          def.qualifiedName,
          [{ def, origin: 'local', namespace: 'type' }],
        ]),
      );
      expect(direct.scopes.slice(1).map((scope) => [...scope.bindings])).toEqual([[], []]);
      expect(direct.scopes.every((scope) => scope.typeBindings.size === 0)).toBe(true);
      expect(direct.parsedImports).toEqual([
        ...(ordinary
          ? [
              {
                kind: 'alias',
                localName: 'Main',
                importedName: 'default',
                alias: 'Main',
                targetRaw: './module',
              },
              {
                kind: 'alias',
                localName: 'Renamed',
                importedName: 'Value',
                alias: 'Renamed',
                targetRaw: './module',
              },
              {
                kind: 'namespace',
                localName: 'types',
                importedName: './types.js',
                targetRaw: './types.js',
              },
            ]
          : []),
        {
          kind: 'named',
          localName: 'Range',
          importedName: 'Range',
          targetRaw: './types.js',
          namespace: 'type',
        },
      ]);
      const exports = new Map(direct.localDefs.map((def) => [def.qualifiedName, def.nodeId]));
      expect(direct.exports).toEqual(exports);
      expect(direct.exportsByNamespace).toEqual({ type: exports, value: new Map() });
      expect(direct.referenceSites).toEqual([]);
      const detached = structuredClone(direct);
      cache.clear();
      expect(onArtifacts.mock.calls[0]![0].map(scopeArtifact)).toEqual([detached]);
      expect(finalizeScopeModel([detached]).scopeTree.byId.size).toBe(3);
    },
  );

  it.each(['sequential', 'worker fallback'] as const)(
    'matches production Python direct extraction and preserves refused legacy calls in %s mode',
    async (mode) => {
      const { graph, cache } = setup();
      const ctx = createResolutionContext();
      const symbols = ctx.model.symbols;
      const borrowedRoots: SyntaxNode[] = [];
      const provider = languageProviders.getProvider(SupportedLanguages.Python);
      const emit = provider.emitScopeCaptures!;
      vi.spyOn(provider, 'emitScopeCaptures').mockImplementation((source, path, root) => {
        expect(root).toBe(cache.get(path)?.rootNode);
        if (!root) throw new Error('Missing borrowed root');
        borrowedRoots.push(root);
        return emit(source, path, root);
      });
      const accepted = {
        path: 'accepted.py',
        content: 'def target():\n    pass\ndef caller():\n    target()\ncaller()\n',
      };
      const refused = {
        path: 'refused.py',
        content:
          'def refusedTarget(value):\n    pass\ndef refusedCaller():\n    refusedTarget(1)\n    missing()\n',
      };
      const files = [accepted, refused];
      const parse = vi.spyOn(Parser.prototype, 'parse');
      const workers = crashingWorkers();
      const onArtifacts = vi.fn<(files: readonly ParsedFile[]) => void>();
      const onOutcomes = vi.fn();
      vi.spyOn(console, 'warn').mockImplementation(() => {});

      expect(
        await processParsing(
          graph,
          files,
          '/scope-test',
          symbols,
          cache,
          undefined,
          mode === 'worker fallback' ? workers.pool : undefined,
          undefined,
          undefined,
          'sequential',
          undefined,
          onArtifacts,
          onOutcomes,
        ),
      ).toBeNull();
      expect(parse).toHaveBeenCalledTimes(files.length);
      expect(borrowedRoots).toHaveLength(files.length);
      expect(workers.dispatch).toHaveBeenCalledTimes(mode === 'worker fallback' ? 1 : 0);
      const direct = extract(
        emitPythonCaptures(cache.get(accepted.path)!.rootNode),
        accepted.path,
        provider,
      );
      expect(onArtifacts).toHaveBeenCalledExactlyOnceWith([direct]);
      expect(onOutcomes).toHaveBeenCalledExactlyOnceWith([
        { filePath: accepted.path, status: 'success' },
        { filePath: refused.path, status: 'failed', reason: 'unsupported-syntax' },
      ]);
      expect(direct.localDefs.map(({ qualifiedName }) => qualifiedName)).toEqual([
        'target',
        'caller',
      ]);
      expect(direct.referenceSites.map(({ name, kind }) => ({ name, kind }))).toEqual([
        { name: 'target', kind: 'call' },
        { name: 'caller', kind: 'call' },
      ]);
      expect(direct.exports).toEqual(
        new Map(direct.localDefs.map((def) => [def.qualifiedName, def.nodeId])),
      );
      for (const name of ['refusedTarget', 'refusedCaller']) {
        expect(symbols.lookupCallableByName(name)).toHaveLength(1);
        expect(graph.nodes.filter((node) => node.properties.name === name)).toHaveLength(1);
      }
      const calls: ExtractedCall[] = [];
      await processCalls(
        graph,
        [refused],
        cache,
        ctx,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        new Map(),
        (call) => calls.push(call),
      );
      expect(calls.map(({ calledName, argCount }) => ({ calledName, argCount }))).toEqual([
        { calledName: 'refusedTarget', argCount: 1 },
        { calledName: 'missing', argCount: 0 },
      ]);
      const caller = symbols.lookupCallableByName('refusedCaller')[0]!;
      const target = symbols.lookupCallableByName('refusedTarget')[0]!;
      expect(graph.relationships.filter((edge) => edge.type === 'CALLS')).toEqual([
        expect.objectContaining({ sourceId: caller.nodeId, targetId: target.nodeId }),
      ]);
      const detached = structuredClone(onArtifacts.mock.calls[0]![0]);
      cache.clear();
      expect(onArtifacts.mock.calls[0]![0]).toEqual(detached);
      expect(finalizeScopeModel(onArtifacts.mock.calls[0]![0]).scopeTree.byId.size).toBe(
        direct.scopes.length,
      );
    },
  );

  it.each(
    tsjsPaths.flatMap((path) =>
      (['sequential', 'mock rejection fallback'] as const).map((mode) => ({ path, mode })),
    ),
  )(
    'uses production hooks for canonical vars and catch scopes in $path with $mode',
    async ({ path, mode }) => {
      const provider = tsjsProvider(path);
      const { graph, symbols, cache } = setup();
      const source = [
        "import Main from './module';",
        'export function retained() {}',
        'var repeated;',
        'try { var repeated; Main(repeated); }',
        'catch (error) { recover(error); }',
        'finally { var repeated; cleanup(repeated); }',
        'export { repeated as exposed };',
      ].join('\n');
      const unsupportedPath = `unsupported-${path}`;
      const workers = crashingWorkers();
      const onArtifacts = vi.fn<(files: readonly ParsedFile[]) => void>();
      const onOutcomes = vi.fn();
      vi.spyOn(console, 'warn').mockImplementation(() => {});

      expect(
        await processParsing(
          graph,
          [
            { path, content: source },
            {
              path: unsupportedPath,
              content: 'export function unsupportedRetained() {}\ndebugger;',
            },
          ],
          '/scope-test',
          symbols,
          cache,
          undefined,
          mode === 'mock rejection fallback' ? workers.pool : undefined,
          undefined,
          undefined,
          'sequential',
          undefined,
          onArtifacts,
          onOutcomes,
        ),
      ).toBeNull();

      const direct = extract(emitTypeScriptCaptures(cache.get(path)!.rootNode), path, provider);
      expect(onArtifacts).toHaveBeenCalledTimes(1);
      expect(onArtifacts.mock.calls[0]![0].map(scopeArtifact)).toEqual([direct]);
      expect(onOutcomes).toHaveBeenCalledExactlyOnceWith([
        { filePath: path, status: 'success' },
        { filePath: unsupportedPath, status: 'failed', reason: 'unsupported-syntax' },
      ]);
      const module = direct.scopes.find((scope) => scope.id === direct.moduleScope)!;
      const exceptionBlocks = direct.scopes.filter(
        (scope) => scope.kind === 'Block' && scope.range.startLine >= 4,
      );
      expect(exceptionBlocks).toHaveLength(4);
      const [attempt, handler, caught, finalizer] = exceptionBlocks;
      expect([attempt, handler, caught, finalizer].map((scope) => scope!.parent)).toEqual([
        module.id,
        module.id,
        handler!.id,
        module.id,
      ]);
      const repeated = direct.localDefs.filter((def) => def.qualifiedName === 'repeated');
      expect(repeated).toHaveLength(3);
      expect(new Set(repeated.map((def) => def.nodeId)).size).toBe(3);
      expect(module.bindings.get('repeated')!.map(({ def }) => def.nodeId)).toEqual([
        repeated[0]!.nodeId,
      ]);
      expect(handler!.bindings.get('error')!.map(({ def }) => def.qualifiedName)).toEqual([
        'error',
      ]);
      expect(caught!.bindings.has('error')).toBe(false);
      expect(direct.parsedImports).toEqual([
        {
          kind: 'alias',
          localName: 'Main',
          importedName: 'default',
          alias: 'Main',
          targetRaw: './module',
        },
      ]);
      const retained = direct.localDefs.find((def) => def.qualifiedName === 'retained')!;
      expect(direct.exports).toEqual(
        new Map([
          ['retained', retained.nodeId],
          ['exposed', repeated[0]!.nodeId],
        ]),
      );
      expect(
        direct.referenceSites.map(({ name, kind, inScope }) => ({ name, kind, inScope })),
      ).toEqual([
        { name: 'Main', kind: 'call', inScope: attempt!.id },
        { name: 'repeated', kind: 'read', inScope: attempt!.id },
        { name: 'recover', kind: 'call', inScope: caught!.id },
        { name: 'error', kind: 'read', inScope: caught!.id },
        { name: 'cleanup', kind: 'call', inScope: finalizer!.id },
        { name: 'repeated', kind: 'read', inScope: finalizer!.id },
      ]);
      for (const name of ['retained', 'unsupportedRetained']) {
        expect(symbols.lookupCallableByName(name)).not.toHaveLength(0);
        expect(graph.nodes.some((node) => node.properties.name === name)).toBe(true);
      }
      expect(workers.dispatch).toHaveBeenCalledTimes(mode === 'mock rejection fallback' ? 1 : 0);
      const detached = structuredClone(onArtifacts.mock.calls[0]![0]);
      cache.clear();
      expect(onArtifacts.mock.calls[0]![0]).toEqual(detached);
      expect(finalizeScopeModel(onArtifacts.mock.calls[0]![0]).scopeTree.byId.size).toBe(
        direct.scopes.length,
      );
    },
  );

  it.each(
    tsjsPaths.flatMap((path) =>
      (['sequential', 'mock rejection fallback'] as const).map((mode) => ({ path, mode })),
    ),
  )(
    'emits direct-extraction CALLS parity after cache disposal for $path in $mode mode',
    async ({ path, mode }) => {
      const provider = tsjsProvider(path);
      const { graph, symbols, cache } = setup();
      const source = 'function target() {}\nfunction caller() { target(); missing(); }';
      const workers = crashingWorkers();
      const onArtifacts = vi.fn<(files: readonly ParsedFile[]) => void>();
      const onOutcomes = vi.fn();
      vi.spyOn(console, 'warn').mockImplementation(() => {});

      expect(
        await processParsing(
          graph,
          [{ path, content: source }],
          '/scope-test',
          symbols,
          cache,
          undefined,
          mode === 'mock rejection fallback' ? workers.pool : undefined,
          undefined,
          undefined,
          'sequential',
          undefined,
          onArtifacts,
          onOutcomes,
        ),
      ).toBeNull();
      expect(workers.dispatch).toHaveBeenCalledTimes(mode === 'mock rejection fallback' ? 1 : 0);
      expect(onArtifacts).toHaveBeenCalledTimes(1);
      expect(onOutcomes).toHaveBeenCalledExactlyOnceWith([{ filePath: path, status: 'success' }]);
      const direct = extract(emitTypeScriptCaptures(cache.get(path)!.rootNode), path, provider);
      const artifacts = onArtifacts.mock.calls[0]![0];
      expect(artifacts.map(scopeArtifact)).toEqual([direct]);
      cache.clear();

      const scopes = finalizeScopeModel(artifacts);
      const resolved = resolveReferences(scopes);
      expect(resolved.stats).toEqual({
        totalSites: 2,
        resolvedSites: 1,
        unresolvedSites: 1,
        ambiguousSites: 0,
        unsupportedSites: 0,
      });
      const emitted = createKnowledgeGraph();
      expect(
        emitReferencesToGraph({ graph: emitted, scopes, referenceIndex: resolved.referenceIndex }),
      ).toEqual({
        edgesEmitted: 1,
        skippedNoCaller: 0,
        skippedMissingTarget: 0,
        scopeNodesEmitted: 0,
        scopeEdgesEmitted: 0,
      });
      const caller = direct.localDefs.find((def) => def.qualifiedName === 'caller')!;
      const target = direct.localDefs.find((def) => def.qualifiedName === 'target')!;
      expect(caller).toBeDefined();
      expect(target).toBeDefined();
      expect(emitted.relationships).toEqual([
        expect.objectContaining({
          sourceId: caller.nodeId,
          targetId: target.nodeId,
          type: 'CALLS',
        }),
      ]);

      const directScopes = finalizeScopeModel([direct]);
      const directResolved = resolveReferences(directScopes);
      const baseline = createKnowledgeGraph();
      emitReferencesToGraph({
        graph: baseline,
        scopes: directScopes,
        referenceIndex: directResolved.referenceIndex,
      });
      expect({ nodes: emitted.nodes, relationships: emitted.relationships }).toEqual({
        nodes: baseline.nodes,
        relationships: baseline.relationships,
      });
    },
  );

  it.each(['fixture.ts', 'fixture.tsx'])(
    'preserves legacy symbols and calls after complex parameter scope rejection in %s',
    async (path) => {
      tsjsProvider(path);
      const { graph, cache } = setup();
      const ctx = createResolutionContext();
      const symbols = ctx.model.symbols;
      const file = {
        path,
        content:
          'export function target(value: string & number) {}\nexport function caller() { target("retained"); missing("unresolved"); }',
      };
      const onArtifacts = vi.fn<(files: readonly ParsedFile[]) => void>();
      const onOutcomes = vi.fn();
      vi.spyOn(console, 'warn').mockImplementation(() => {});

      expect(
        await processParsing(
          graph,
          [file],
          '/scope-test',
          symbols,
          cache,
          undefined,
          undefined,
          undefined,
          undefined,
          'sequential',
          undefined,
          onArtifacts,
          onOutcomes,
        ),
      ).toBeNull();
      expect(onArtifacts).toHaveBeenCalledExactlyOnceWith([]);
      expect(onOutcomes).toHaveBeenCalledExactlyOnceWith([
        { filePath: path, status: 'failed', reason: 'unsupported-syntax' },
      ]);
      for (const name of ['target', 'caller']) {
        expect(symbols.lookupCallableByName(name)).toHaveLength(1);
        expect(graph.nodes.filter((node) => node.properties.name === name)).toHaveLength(1);
      }
      expect(cache.get(path)!.rootNode.text).toBe(file.content);

      const calls: ExtractedCall[] = [];
      await processCalls(
        graph,
        [file],
        cache,
        ctx,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        new Map(),
        (call) => calls.push(call),
      );
      expect(calls.map(({ calledName, argCount }) => ({ calledName, argCount }))).toEqual([
        { calledName: 'target', argCount: 1 },
        { calledName: 'missing', argCount: 1 },
      ]);
      const caller = symbols.lookupCallableByName('caller')[0]!;
      const target = symbols.lookupCallableByName('target')[0]!;
      expect(graph.relationships.filter((edge) => edge.type === 'CALLS')).toEqual([
        expect.objectContaining({ sourceId: caller.nodeId, targetId: target.nodeId }),
      ]);
    },
  );

  it.each(['sequential', 'worker fallback'] as const)(
    'matches real TS/JS direct extraction without reparsing in %s mode',
    async (mode) => {
      const provider = tsjsProvider('fixture.ts');
      const { graph, symbols, cache } = setup();
      const borrowedRoots: SyntaxNode[] = [];
      scopeHook((_source, path, root) => {
        expect(root).toBe(cache.get(path)?.rootNode);
        if (!root) throw new Error('Missing borrowed root');
        borrowedRoots.push(root);
        return emitTypeScriptCaptures(root);
      });
      const files = tsjsPaths.map((path) => ({ path, content: tsjsSource }));
      files.push({
        path: 'unsupported.ts',
        content: 'export function retained() {}\ndebugger;',
      });
      const parse = vi.spyOn(Parser.prototype, 'parse');
      const workers = crashingWorkers();
      const onArtifacts = vi.fn<(files: readonly ParsedFile[]) => void>();
      const onOutcomes = vi.fn();
      vi.spyOn(console, 'warn').mockImplementation(() => {});

      expect(
        await processParsing(
          graph,
          files,
          '/scope-test',
          symbols,
          cache,
          undefined,
          mode === 'worker fallback' ? workers.pool : undefined,
          undefined,
          undefined,
          'sequential',
          undefined,
          onArtifacts,
          onOutcomes,
        ),
      ).toBeNull();

      expect(parse).toHaveBeenCalledTimes(files.length);
      expect(borrowedRoots).toHaveLength(files.length);
      const expected = tsjsPaths.map((path) =>
        extract(emitTypeScriptCaptures(cache.get(path)!.rootNode), path, provider),
      );
      expect(onArtifacts).toHaveBeenCalledTimes(1);
      expect(onArtifacts.mock.calls[0]![0].map(scopeArtifact)).toEqual(expected);
      expect(onOutcomes).toHaveBeenCalledExactlyOnceWith([
        ...tsjsPaths.map((filePath) => ({ filePath, status: 'success' })),
        { filePath: 'unsupported.ts', status: 'failed', reason: 'unsupported-syntax' },
      ]);
      expect(symbols.lookupCallableByName('retained')).not.toHaveLength(0);
      expect(workers.dispatch).toHaveBeenCalledTimes(mode === 'worker fallback' ? 1 : 0);
      const detached = structuredClone(expected);
      cache.clear();
      expect(onArtifacts.mock.calls[0]![0].map(scopeArtifact)).toEqual(detached);
    },
  );

  it.each(['sequential', 'worker fallback'] as const)(
    'delivers ordered artifacts while preserving legacy graph output in %s mode',
    async (mode) => {
      const parse = vi.spyOn(Parser.prototype, 'parse');
      const { graph, symbols, cache } = setup();
      const borrowedRoots: { path: string; text: string | undefined; cached: boolean }[] = [];
      scopeHook((_source, path, root) => {
        borrowedRoots.push({
          path,
          text: root?.text,
          cached: root !== undefined && root === cache.get(path)?.rootNode,
        });
        return [moduleScopeMatch()];
      });
      const files = [
        { path: 'z-last.ts', content: 'export function firstFunction() {}' },
        { path: 'a-first.ts', content: 'export function secondFunction() {}' },
      ];
      const workers = crashingWorkers();
      const onArtifacts = vi.fn<(files: readonly ParsedFile[]) => void>();
      const onParseErrors = vi.fn();
      const onOutcomes = vi.fn();

      const result = await processParsing(
        graph,
        files,
        '/scope-test',
        symbols,
        cache,
        undefined,
        mode === 'worker fallback' ? workers.pool : undefined,
        undefined,
        undefined,
        'sequential',
        onParseErrors,
        onArtifacts,
        onOutcomes,
      );

      expect(result).toBeNull();
      expect(parse).toHaveBeenCalledTimes(files.length);
      expect(borrowedRoots).toEqual(
        files.map((file) => ({ path: file.path, text: file.content, cached: true })),
      );
      expect(onArtifacts).toHaveBeenCalledTimes(1);
      expect(
        onArtifacts.mock.calls[0]![0].map((file) => ({
          path: file.filePath,
          kinds: file.scopes.map((scope) => scope.kind),
        })),
      ).toEqual([
        { path: 'z-last.ts', kinds: ['Module'] },
        { path: 'a-first.ts', kinds: ['Module'] },
      ]);
      expect(onParseErrors).toHaveBeenCalledExactlyOnceWith([]);
      expect(onOutcomes).toHaveBeenCalledExactlyOnceWith([
        { filePath: 'z-last.ts', status: 'success' },
        { filePath: 'a-first.ts', status: 'success' },
      ]);
      for (const name of ['firstFunction', 'secondFunction']) {
        expect(graph.nodes.some((node) => node.properties.name === name)).toBe(true);
        expect(symbols.lookupCallableByName(name)).not.toHaveLength(0);
      }
      expect(workers.dispatch).toHaveBeenCalledTimes(mode === 'worker fallback' ? 1 : 0);
    },
  );

  it.each(['sequential', 'worker fallback'] as const)(
    'passes the live extracted Vue script root to the scope provider in %s mode',
    async (mode) => {
      const script = '\nexport function componentFunction() {}\n';
      const { graph, symbols, cache } = setup();
      const borrowedRoots: { text: string | undefined; cached: boolean }[] = [];
      const emit = vi.fn<NonNullable<LanguageProvider['emitScopeCaptures']>>(
        (_source, path, root) => {
          borrowedRoots.push({
            text: root?.text,
            cached: root !== undefined && root === cache.get(path)?.rootNode,
          });
          return [moduleScopeMatch()];
        },
      );
      scopeHook(emit);
      const workers = crashingWorkers();
      const onArtifacts = vi.fn<(files: readonly ParsedFile[]) => void>();

      expect(
        await processParsing(
          graph,
          [
            {
              path: 'Component.vue',
              content: `<template><div /></template>\n<script setup lang="ts">${script}</script>`,
            },
          ],
          '/scope-test',
          symbols,
          cache,
          undefined,
          mode === 'worker fallback' ? workers.pool : undefined,
          undefined,
          undefined,
          'sequential',
          undefined,
          onArtifacts,
        ),
      ).toBeNull();

      expect(emit).toHaveBeenCalledExactlyOnceWith(
        script,
        'Component.vue',
        cache.get('Component.vue')!.rootNode,
      );
      const root = cache.get('Component.vue')!.rootNode;
      expect(borrowedRoots).toEqual([
        { text: script.slice(root.startIndex, root.endIndex), cached: true },
      ]);
      expect(onArtifacts.mock.calls[0]![0].map((file) => file.filePath)).toEqual(['Component.vue']);
      expect(symbols.lookupCallableByName('componentFunction')).not.toHaveLength(0);
      expect(workers.dispatch).toHaveBeenCalledTimes(mode === 'worker fallback' ? 1 : 0);
    },
  );

  it.each(['absent', 'throwing'] as const)(
    'keeps legacy definitions and emits an empty artifact list when the hook is %s',
    async (hook) => {
      scopeHook(
        hook === 'absent'
          ? undefined
          : () => {
              throw new Error('scope hook failed');
            },
      );
      const { graph, symbols, cache } = setup();
      const onArtifacts = vi.fn<(files: readonly ParsedFile[]) => void>();

      const result = await processParsing(
        graph,
        [{ path: 'legacy.ts', content: 'export function legacyFunction() {}' }],
        '/scope-test',
        symbols,
        cache,
        undefined,
        undefined,
        undefined,
        undefined,
        'sequential',
        undefined,
        onArtifacts,
      );

      expect(result).toBeNull();
      expect(onArtifacts).toHaveBeenCalledExactlyOnceWith([]);
      expect(graph.nodes.some((node) => node.properties.name === 'legacyFunction')).toBe(true);
      expect(symbols.lookupCallableByName('legacyFunction')).not.toHaveLength(0);
    },
  );

  it('accepts the original signature without an artifact callback', async () => {
    scopeHook(() => [moduleScopeMatch()]);
    const { graph, symbols, cache } = setup();
    const onProgress = vi.fn();

    expect(
      await processParsing(
        graph,
        [{ path: 'legacy.ts', content: 'export function originalSignature() {}' }],
        symbols,
        cache,
        onProgress,
      ),
    ).toBeNull();

    expect(onProgress).toHaveBeenCalledWith(1, 1, 'legacy.ts');
    expect(symbols.lookupCallableByName('originalSignature')).not.toHaveLength(0);
  });

  it.each(['sequential', 'worker fallback'] as const)(
    'reports ordered success, unsupported and failed attempts in %s mode',
    async (mode) => {
      const getProvider = languageProviders.getProvider;
      vi.spyOn(languageProviders, 'getProvider').mockImplementation((language) => ({
        ...getProvider(language),
        emitScopeCaptures:
          language === SupportedLanguages.JavaScript
            ? undefined
            : (_source, filePath) => {
                if (filePath === 'failed.ts') throw new Error('scope hook failed');
                if (filePath.endsWith('.cxx')) return [];
                return [moduleScopeMatch()];
              },
      }));
      const { graph, symbols, cache } = setup();
      const workers = crashingWorkers();
      const onOutcomes = vi.fn();
      const onArtifacts = vi.fn();

      const result = await processParsing(
        graph,
        [
          { path: 'z-success.ts', content: 'export function successful() {}' },
          { path: 'unsupported.js', content: 'export function unsupported() {}' },
          { path: 'failed.ts', content: 'export function failed() {}' },
          {
            path: 'sw/source/core/layout/pagechg.cxx',
            content: 'int nativeFunction() { return 1; }',
          },
          { path: 'skipped.txt', content: 'not a supported source file' },
        ],
        '/scope-test',
        symbols,
        cache,
        undefined,
        mode === 'worker fallback' ? workers.pool : undefined,
        undefined,
        undefined,
        'sequential',
        undefined,
        onArtifacts,
        onOutcomes,
      );

      expect(result).toBeNull();
      expect(onOutcomes).toHaveBeenCalledExactlyOnceWith([
        { filePath: 'z-success.ts', status: 'success' },
        { filePath: 'unsupported.js', status: 'unsupported', reason: 'missing-scope-hook' },
        { filePath: 'failed.ts', status: 'failed', reason: 'scope-extraction-error' },
        {
          filePath: 'sw/source/core/layout/pagechg.cxx',
          status: 'failed',
          reason: 'missing-module-scope',
        },
      ]);
      expect(onArtifacts.mock.calls[0]![0].map((file: ParsedFile) => file.filePath)).toEqual([
        'z-success.ts',
      ]);
      for (const name of ['successful', 'unsupported', 'failed']) {
        expect(symbols.lookupCallableByName(name)).not.toHaveLength(0);
      }
      expect(workers.dispatch).toHaveBeenCalledTimes(mode === 'worker fallback' ? 1 : 0);
    },
  );

  it.each(['streamed', 'final', 'legacy'] as const)(
    'retains %s worker outcomes after the worker result is cleared',
    async (mode) => {
      const { graph, symbols, cache } = setup();
      const workerResult = createEmptyResult();
      const expected = [
        { filePath: 'z.ts', status: 'success' } as const,
        { filePath: 'a.ts', status: 'failed', reason: 'scope-extraction-error' } as const,
      ];
      workerResult.scopeExtractionOutcomes = expected.slice();
      if (mode === 'legacy') delete workerResult.scopeExtractionOutcomes;
      const workers = crashingWorkers();
      workers.dispatch.mockImplementation(async (...args: unknown[]) => {
        if (mode !== 'streamed') return [workerResult];
        const options = args[4] as WorkerDispatchOptions<ParseWorkerResult>;
        options.onResultPart!(workerResult, {
          workerIndex: 0,
          workerChunkSize: 2,
          workerIsolation: 'thread',
        });
        return [createEmptyResult()];
      });
      const onOutcomes = vi.fn();

      const result = await processParsing(
        graph,
        [{ path: 'z.ts', content: 'export const z = 1;' }],
        '/scope-test',
        symbols,
        cache,
        undefined,
        workers.pool,
        undefined,
        undefined,
        'sequential',
        undefined,
        undefined,
        onOutcomes,
      );

      expect(result).not.toBeNull();
      expect(result!.scopeExtractionOutcomes).toEqual(mode === 'legacy' ? [] : expected);
      expect(result!.parsedFiles).toEqual([]);
      expect(workerResult.scopeExtractionOutcomes).toEqual(mode === 'legacy' ? undefined : []);
      expect(workers.dispatch).toHaveBeenCalledTimes(1);
      expect(onOutcomes).not.toHaveBeenCalled();
    },
  );

  it('propagates scope outcome callback failures to the caller', async () => {
    scopeHook(() => [moduleScopeMatch()]);
    const { graph, symbols, cache } = setup();
    const failure = new Error('scope outcome sink failed');

    await expect(
      processParsing(
        graph,
        [{ path: 'callback.ts', content: 'export function callbackFunction() {}' }],
        '/scope-test',
        symbols,
        cache,
        undefined,
        undefined,
        undefined,
        undefined,
        'sequential',
        undefined,
        undefined,
        () => {
          throw failure;
        },
      ),
    ).rejects.toBe(failure);
  });

  it('propagates artifact callback failures to the caller', async () => {
    scopeHook(() => [moduleScopeMatch()]);
    const { graph, symbols, cache } = setup();
    const failure = new Error('artifact sink failed');

    await expect(
      processParsing(
        graph,
        [{ path: 'callback.ts', content: 'export function callbackFunction() {}' }],
        '/scope-test',
        symbols,
        cache,
        undefined,
        undefined,
        undefined,
        undefined,
        'sequential',
        undefined,
        () => {
          throw failure;
        },
      ),
    ).rejects.toBe(failure);
  });
});

/**
 * Build a `LanguageProvider` whose shape is only as narrow as
 * `extractParsedFile` reads. Tests cast to the full provider type since
 * `extractParsedFile` is typed against `LanguageProvider` (not the narrow
 * `ScopeExtractorHooks`); the real worker always has a full provider.
 */
function fakeProvider(
  hooks: Partial<
    Pick<
      LanguageProvider,
      'emitScopeCaptures' | 'shouldCreateScope' | 'resolveScopeKind' | 'interpretExports'
    >
  >,
): LanguageProvider {
  return hooks as unknown as LanguageProvider;
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('production TS/JS provider bridge', () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([
    {
      name: 'skips a top-level call beside named sibling functions',
      source: 'function target() {}\nfunction sibling() {}\ntarget();',
      owners: [
        ['target', 'Function'],
        ['sibling', 'Function'],
      ],
      referenceScope: 'Module',
      callerName: undefined,
    },
    {
      name: 'skips a top-level call beside an unrelated module constant',
      source: 'const unrelated = 1;\nfunction target() {}\ntarget();',
      owners: [
        ['unrelated', 'Module'],
        ['target', 'Function'],
      ],
      referenceScope: 'Module',
      callerName: undefined,
    },
    {
      name: 'skips a top-level block call beside a block-local constant',
      source: 'function target() {}\n{ const unrelated = 1; target(); }',
      owners: [
        ['target', 'Function'],
        ['unrelated', 'Block'],
      ],
      referenceScope: 'Block',
      callerName: undefined,
    },
    {
      name: 'attributes a nested block call to its enclosing named function',
      source: 'function target() {}\nfunction caller() { { target(); } }',
      owners: [
        ['target', 'Function'],
        ['caller', 'Function'],
      ],
      referenceScope: 'Block',
      callerName: 'caller',
    },
    {
      name: 'attributes a block call beside a local constant to its enclosing named function',
      source: 'function target() {}\nfunction caller() { { const unrelated = 1; target(); } }',
      owners: [
        ['target', 'Function'],
        ['caller', 'Function'],
        ['unrelated', 'Block'],
      ],
      referenceScope: 'Block',
      callerName: 'caller',
    },
  ])(
    '$name with real TypeScript captures',
    async ({ source, owners, referenceScope, callerName }) => {
      const path = 'caller-characterization.ts';
      const provider = tsjsProvider(path);
      const parser = await createParserForLanguage(provider.id, path);
      const tree = parser.parse(source);
      const parsed = extract(emitTypeScriptCaptures(tree.rootNode), path, provider);
      expect(
        parsed.scopes.flatMap((scope) =>
          scope.ownedDefs.map((def) => [def.qualifiedName, scope.kind]),
        ),
      ).toEqual(owners);
      expect(parsed.referenceSites).toHaveLength(1);
      const site = parsed.referenceSites[0]!;
      const sourceScope = parsed.scopes.find((scope) => scope.id === site.inScope)!;
      expect({ name: site.name, kind: site.kind, scopeKind: sourceScope.kind }).toEqual({
        name: 'target',
        kind: 'call',
        scopeKind: referenceScope,
      });
      expect(sourceScope.ownedDefs.map((def) => def.qualifiedName)).toEqual(
        owners.filter(([, kind]) => kind === referenceScope).map(([name]) => name),
      );
      if (referenceScope === 'Module') expect(site.inScope).toBe(parsed.moduleScope);

      const scopes = finalizeScopeModel([parsed]);
      const resolved = resolveReferences(scopes);
      expect(resolved.stats).toEqual({
        totalSites: 1,
        resolvedSites: 1,
        unresolvedSites: 0,
        ambiguousSites: 0,
        unsupportedSites: 0,
      });
      const graph = createKnowledgeGraph();
      expect(
        emitReferencesToGraph({ graph, scopes, referenceIndex: resolved.referenceIndex }),
      ).toEqual({
        edgesEmitted: callerName === undefined ? 0 : 1,
        skippedNoCaller: callerName === undefined ? 1 : 0,
        skippedMissingTarget: 0,
        scopeNodesEmitted: 0,
        scopeEdgesEmitted: 0,
      });
      const target = parsed.localDefs.find((def) => def.qualifiedName === 'target')!;
      const caller = parsed.localDefs.find((def) => def.qualifiedName === callerName);
      expect(graph.relationships).toEqual(
        caller === undefined
          ? []
          : [
              expect.objectContaining({
                sourceId: caller.nodeId,
                targetId: target.nodeId,
                type: 'CALLS',
              }),
            ],
      );
    },
  );

  it.each(tsjsPaths)('matches direct extraction and detaches results for %s', async (path) => {
    const provider = tsjsProvider(path);
    const parser = await createParserForLanguage(provider.id, path);
    const parse = vi.spyOn(parser, 'parse');
    const tree = parser.parse(tsjsSource);
    const expected = extract(emitTypeScriptCaptures(tree.rootNode), path, provider);
    const warning = vi.fn();

    const outcome = extractParsedFileOutcome(provider, tsjsSource, path, warning, tree.rootNode);

    expect(outcome).toEqual({ status: 'success', parsedFile: expected });
    expect(expected.parsedImports).toEqual([
      {
        kind: 'alias',
        localName: 'Main',
        importedName: 'default',
        alias: 'Main',
        targetRaw: './module',
      },
    ]);
    expect(expected.exports).toEqual(new Map([['run', expected.localDefs[0]!.nodeId]]));
    expect(expected.referenceSites.map((site) => site.name)).toContain('value');
    expect(expected.referenceSites.map((site) => site.name)).toContain('run');
    expect(parse).toHaveBeenCalledTimes(1);
    expect(warning).not.toHaveBeenCalled();
    const detached = structuredClone(outcome);
    parser.parse('export function replacement() {}');
    expect(outcome).toEqual(detached);
  });

  it.each(tsjsPaths)('fails closed for unsupported whole-file source in %s', async (path) => {
    const provider = tsjsProvider(path);
    const parser = await createParserForLanguage(provider.id, path);
    const source = 'export function retained() {}\ndebugger;';
    const root = parser.parse(source).rootNode;
    const parse = vi.spyOn(parser, 'parse');
    const warning = vi.fn();

    expect(root.hasError).toBe(false);
    expect(extractParsedFileOutcome(provider, source, path, warning, root)).toEqual({
      status: 'failed',
      reason: 'unsupported-syntax',
    });
    expect(warning).toHaveBeenCalledExactlyOnceWith(expect.stringContaining(path));
    expect(parse).not.toHaveBeenCalled();
  });

  it('requires a borrowed root instead of reparsing when the production hook is called', () => {
    const provider = tsjsProvider('fixture.ts');
    const parse = vi.spyOn(Parser.prototype, 'parse');
    const warning = vi.fn();

    expect(() => provider.emitScopeCaptures!(tsjsSource, 'fixture.ts')).toThrow(
      'TS/JS scope captures require the borrowed root',
    );
    expect(extractParsedFileOutcome(provider, tsjsSource, 'fixture.ts', warning)).toEqual({
      status: 'failed',
      reason: 'scope-extraction-error',
    });
    expect(warning).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining('TS/JS scope captures require the borrowed root'),
    );
    expect(parse).not.toHaveBeenCalled();
  });
});

describe('extractParsedFileOutcome', () => {
  it('includes explicit exports in a successful bridge artifact', () => {
    const provider = fakeProvider({
      emitScopeCaptures: () => [
        moduleScopeMatch(),
        {
          '@declaration.function': cap('@declaration.function', 2, 0, 2, 6),
          '@declaration.name': cap('@declaration.name', 2, 0, 2, 6, 'render'),
        },
      ],
      interpretExports: (_matches, context) => new Map([['default', context.localDefs[0]!.nodeId]]),
    });
    const outcome = extractParsedFileOutcome(provider, 'source text', 'a.ts');

    expect(outcome.status).toBe('success');
    if (outcome.status !== 'success') throw new Error('Expected a successful extraction');
    expect(outcome.parsedFile.exports).toEqual(
      new Map([['default', outcome.parsedFile.localDefs[0]!.nodeId]]),
    );
    expect(extractParsedFile(provider, 'source text', 'a.ts')).toEqual(outcome.parsedFile);
  });

  it.each(['throwing', 'invalid result'] as const)(
    'preserves failure outcomes and legacy warnings for an export hook with %s',
    (mode) => {
      const provider = fakeProvider({
        emitScopeCaptures: () => [moduleScopeMatch()],
        interpretExports: () => {
          if (mode === 'throwing') throw new Error('export hook failed');
          return new Map([['default', 'foreign-definition']]);
        },
      });
      const onWarn = vi.fn();
      const legacyWarn = vi.fn();

      expect(extractParsedFileOutcome(provider, 'src', 'a.ts', onWarn)).toEqual({
        status: 'failed',
        reason: 'scope-extraction-error',
      });
      expect(extractParsedFile(provider, 'src', 'a.ts', legacyWarn)).toBeUndefined();
      expect(onWarn.mock.calls).toEqual(legacyWarn.mock.calls);
      expect(onWarn).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('a.ts'));
      if (mode === 'throwing') {
        expect(onWarn).toHaveBeenCalledWith(expect.stringContaining('export hook failed'));
      }
    },
  );

  it.each([
    ['outcome helper', extractParsedFileOutcome],
    ['legacy wrapper', extractParsedFile],
  ] as const)('forwards the exact borrowed root through the %s', (_name, extract) => {
    const root = { text: 'source text' } as SyntaxNode;
    const emit = vi.fn<NonNullable<LanguageProvider['emitScopeCaptures']>>(() => [
      moduleScopeMatch(),
    ]);
    const provider = fakeProvider({ emitScopeCaptures: emit });
    const onWarn = vi.fn();

    expect(extract(provider, 'source text', 'src/file.ts', onWarn, root)).toBeDefined();

    expect(emit).toHaveBeenCalledExactlyOnceWith('source text', 'src/file.ts', root);
    expect(emit.mock.calls[0]![2]).toBe(root);
    expect(onWarn).not.toHaveBeenCalled();
  });

  it('returns the extracted artifact after invoking the provider exactly once', () => {
    const emit = vi.fn(() => [moduleScopeMatch()]);
    const provider = fakeProvider({ emitScopeCaptures: emit });
    const onWarn = vi.fn();

    const outcome = extractParsedFileOutcome(provider, 'source text', 'src/file.ts', onWarn);

    expect(emit).toHaveBeenCalledExactlyOnceWith('source text', 'src/file.ts');
    expect(outcome.status).toBe('success');
    if (outcome.status !== 'success') throw new Error('Expected a successful extraction');
    expect(outcome.parsedFile.filePath).toBe('src/file.ts');
    expect(outcome.parsedFile.scopes.map((scope) => scope.kind)).toEqual(['Module']);
    expect(onWarn).not.toHaveBeenCalled();
    expect(extractParsedFile(provider, 'source text', 'src/file.ts', onWarn)).toEqual(
      outcome.parsedFile,
    );
  });

  it.each([
    {
      name: 'missing hook',
      hook: undefined,
      path: 'a.ts',
      expected: { status: 'unsupported', reason: 'missing-scope-hook' },
      warning: undefined,
    },
    {
      name: 'throwing hook',
      hook: () => {
        throw new Error('provider boom');
      },
      path: 'a.ts',
      expected: { status: 'failed', reason: 'scope-extraction-error' },
      warning: 'provider boom',
    },
    {
      name: 'overlapping captures',
      hook: () => [
        moduleScopeMatch(),
        { '@scope.function': cap('@scope.function', 10, 0, 20, 0) },
        { '@scope.function': cap('@scope.function', 15, 0, 25, 0) },
      ],
      path: 'a.ts',
      expected: { status: 'failed', reason: 'scope-extraction-error' },
      warning: 'overlap',
    },
    {
      name: 'unexpected missing module',
      hook: () => [],
      path: 'a.ts',
      expected: { status: 'failed', reason: 'scope-extraction-error' },
      warning: 'ScopeExtractor: no Module scope found',
    },
    ...['sw/source/core/layout/pagechg.cxx', 'include/sfx2/objsh.hxx'].map((path) => ({
      name: `expected missing module in ${path}`,
      hook: () => [],
      path,
      expected: { status: 'failed', reason: 'missing-module-scope' },
      warning: undefined,
    })),
  ])(
    'classifies $name and preserves legacy return values and warnings',
    ({ hook, path, expected, warning }) => {
      const provider = fakeProvider({ emitScopeCaptures: hook });
      const onWarn = vi.fn();
      const legacyWarn = vi.fn();

      expect(extractParsedFileOutcome(provider, 'src', path, onWarn)).toEqual(expected);
      expect(extractParsedFile(provider, 'src', path, legacyWarn)).toBeUndefined();
      expect(onWarn.mock.calls).toEqual(legacyWarn.mock.calls);
      if (warning === undefined) {
        expect(onWarn).not.toHaveBeenCalled();
      } else {
        expect(onWarn).toHaveBeenCalledExactlyOnceWith(expect.stringContaining(warning));
        expect(onWarn).toHaveBeenCalledWith(expect.stringContaining(path));
      }
    },
  );

  it.each([
    ['outcome helper', extractParsedFileOutcome],
    ['legacy wrapper', extractParsedFile],
  ] as const)('propagates warning callback failures from the %s', (_name, extract) => {
    const provider = fakeProvider({
      emitScopeCaptures: () => {
        throw new Error('provider boom');
      },
    });
    const failure = new Error('warning sink failed');

    expect(() =>
      extract(provider, 'src', 'a.ts', () => {
        throw failure;
      }),
    ).toThrow(failure);
  });
});

describe('extractParsedFile', () => {
  describe('provider has NOT migrated (no emitScopeCaptures)', () => {
    it('returns undefined — silent no-op for legacy languages', () => {
      const provider = fakeProvider({}); // no hook
      const result = extractParsedFile(provider, 'source text', 'src/file.ts');
      expect(result).toBeUndefined();
    });

    it('never calls the scope extractor when the hook is absent — cannot throw', () => {
      // If the extractor was wrongly invoked, it would complain about the
      // missing Module scope for empty captures. This test proves the
      // short-circuit actually fires.
      const provider = fakeProvider({});
      expect(() => extractParsedFile(provider, '', 'x.ts')).not.toThrow();
    });
  });

  describe('provider HAS migrated', () => {
    it('threads emitScopeCaptures output through ScopeExtractor', () => {
      const provider = fakeProvider({
        emitScopeCaptures: () => [moduleScopeMatch()],
      });
      const result = extractParsedFile(provider, 'source text', 'src/file.ts');
      expect(result).toBeDefined();
      expect(result!.filePath).toBe('src/file.ts');
      expect(result!.scopes).toHaveLength(1);
      expect(result!.scopes[0]!.kind).toBe('Module');
    });

    it('forwards the correct arguments to emitScopeCaptures', () => {
      let seenText: string | undefined;
      let seenPath: string | undefined;
      const provider = fakeProvider({
        emitScopeCaptures: (text, path) => {
          seenText = text;
          seenPath = path;
          return [moduleScopeMatch()];
        },
      });
      extractParsedFile(provider, 'the real text', 'deep/path/file.ts');
      expect(seenText).toBe('the real text');
      expect(seenPath).toBe('deep/path/file.ts');
    });

    it('honors provider hooks beyond emitScopeCaptures (shouldCreateScope)', () => {
      // A Block scope the provider declines to create — the resulting
      // ParsedFile should have only the Module scope, not the Block.
      const provider = fakeProvider({
        emitScopeCaptures: () => [
          moduleScopeMatch(),
          { '@scope.block': cap('@scope.block', 10, 0, 20, 0) },
        ],
        shouldCreateScope: (match) => match['@scope.block'] === undefined,
      });
      const result = extractParsedFile(provider, 'src', 'a.ts');
      expect(result!.scopes).toHaveLength(1);
      expect(result!.scopes[0]!.kind).toBe('Module');
    });
  });

  describe('error resilience — never breaks legacy parsing', () => {
    it('returns undefined when emitScopeCaptures throws', () => {
      const provider = fakeProvider({
        emitScopeCaptures: () => {
          throw new Error('provider boom');
        },
      });
      const result = extractParsedFile(provider, 'src', 'a.ts');
      expect(result).toBeUndefined();
    });

    it('routes errors through the onWarn callback when provided', () => {
      const warnings: string[] = [];
      const provider = fakeProvider({
        emitScopeCaptures: () => {
          throw new Error('provider boom');
        },
      });
      const result = extractParsedFile(provider, 'src', 'path/to/file.ts', (msg) => {
        warnings.push(msg);
      });
      expect(result).toBeUndefined();
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('path/to/file.ts');
      expect(warnings[0]).toContain('provider boom');
    });

    it('warns when ScopeExtractor throws an unexpected missing Module scope', () => {
      // Emits no scope captures, so the extractor reaches the missing
      // Module invariant. Legacy parsing on the same file continues
      // unaffected by this failure.
      const warnings: string[] = [];
      const provider = fakeProvider({
        emitScopeCaptures: () => [],
      });
      const result = extractParsedFile(provider, 'src', 'a.ts', (msg) => {
        warnings.push(msg);
      });
      expect(result).toBeUndefined();
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('ScopeExtractor: no Module scope found');
    });

    it('suppresses expected missing Module scope warnings for LO-style .cxx files', () => {
      const warnings: string[] = [];
      const provider = fakeProvider({
        emitScopeCaptures: () => [],
      });
      const result = extractParsedFile(
        provider,
        'namespace sw { void layout() {} }',
        'sw/source/core/layout/pagechg.cxx',
        (msg) => {
          warnings.push(msg);
        },
      );
      expect(result).toBeUndefined();
      expect(warnings).toHaveLength(0);
    });

    it('suppresses expected missing Module scope warnings for LO-style .hxx files', () => {
      const warnings: string[] = [];
      const provider = fakeProvider({
        emitScopeCaptures: () => [],
      });
      const result = extractParsedFile(
        provider,
        '#pragma once\nclass SfxObjectShell;',
        'include/sfx2/objsh.hxx',
        (msg) => {
          warnings.push(msg);
        },
      );
      expect(result).toBeUndefined();
      expect(warnings).toHaveLength(0);
    });

    it('returns undefined when ScopeExtractor throws on malformed captures (overlap)', () => {
      // Siblings with overlapping ranges trip the ScopeTreeInvariantError
      // from #912. The helper catches it and returns undefined.
      const provider = fakeProvider({
        emitScopeCaptures: () => [
          moduleScopeMatch(),
          { '@scope.function': cap('@scope.function', 10, 0, 20, 0) },
          { '@scope.function': cap('@scope.function', 15, 0, 25, 0) }, // overlap
        ],
      });
      const result = extractParsedFile(provider, 'src', 'a.ts');
      expect(result).toBeUndefined();
    });

    it('still warns for unexpected scope errors in .cxx files', () => {
      const warnings: string[] = [];
      const provider = fakeProvider({
        emitScopeCaptures: () => [
          moduleScopeMatch(),
          { '@scope.function': cap('@scope.function', 10, 0, 20, 0) },
          { '@scope.function': cap('@scope.function', 15, 0, 25, 0) }, // overlap
        ],
      });
      const result = extractParsedFile(
        provider,
        'src',
        'sw/source/core/layout/pagechg.cxx',
        (msg) => {
          warnings.push(msg);
        },
      );
      expect(result).toBeUndefined();
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('overlap');
    });
  });
});
