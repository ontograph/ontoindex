/**
 * Unit tests for `finalize-orchestrator` (RFC #909 Ring 2 PKG #921).
 *
 * Covers empty-input, single-file, multi-file-with-imports, and the
 * `MutableSemanticModel.attachScopeIndexes` one-shot contract.
 *
 * Builds synthetic `ParsedFile` inputs directly — the orchestrator is
 * below the extraction layer and independent of tree-sitter, so the
 * tests don't need a real parser.
 */

import { describe, it, expect } from 'vitest';
import type {
  BindingRef,
  ParsedFile,
  ParsedImport,
  Scope,
  ScopeId,
  SymbolDefinition,
} from 'ontoindex-shared';
import { finalizeScopeModel } from '../../../src/core/ingestion/finalize-orchestrator.js';
import { ScopeRetentionStage } from '../../../src/core/ingestion/pipeline-phases/scope-retention-stage.js';
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
});

const mkDef = (nodeId: string, filePath: string, qname: string): SymbolDefinition => ({
  nodeId,
  filePath,
  type: 'Class',
  qualifiedName: qname,
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

describe('finalizeScopeModel: cross-file imports', () => {
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
      for (const file of files)
        for (const scope of file.scopes) {
          (scope.bindings as Map<string, readonly BindingRef[]>).clear();
          (scope.typeBindings as Map<string, unknown>).clear();
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
    const scope = mkScope(
      `scope:${filePath}#module`,
      null,
      filePath,
      Object.fromEntries(
        defs.map((def) => [def.qualifiedName!, [{ def, origin: 'local' as const }]]),
      ),
    );
    (scope.typeBindings as Map<string, unknown>).set('Declared', {
      rawName: 'Declared',
      declaredAtScope: scope.id,
      source: 'annotation',
    });
    return mkFile(filePath, { scopes: [scope], localDefs: defs, parsedImports: imports });
  }

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
