/**
 * Integration Tests: Worker Pool & Parse Worker
 *
 * Verifies that the worker pool can spawn real worker threads using the
 * compiled dist/ parse-worker.js and process files correctly.
 * This is critical for cross-platform CI where vitest runs from src/
 * but workers need compiled .js files.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  createWorkerPool,
  WorkerPool,
  WORKER_SUB_BATCH_TIMEOUT_MS,
} from '../../src/core/ingestion/workers/worker-pool.js';
import * as workerPoolModule from '../../src/core/ingestion/workers/worker-pool.js';
import { runChunkedParseAndResolve } from '../../src/core/ingestion/pipeline-phases/parse-impl.js';
import { createEmptyResult } from '../../src/core/ingestion/workers/parse-types.js';
import type {
  ParseWorkerInput,
  ParseWorkerResult,
} from '../../src/core/ingestion/workers/parse-types.js';
import {
  SupportedLanguages,
  type ParsedFile,
  type Scope,
  type SymbolDefinition,
} from 'ontoindex-shared';
import { getProvider } from '../../src/core/ingestion/languages/index.js';
import { createParserForLanguage } from '../../src/core/tree-sitter/parser-loader.js';
import {
  extractParsedFileOutcome,
  type ScopeExtractionRecord,
} from '../../src/core/ingestion/scope-extractor-bridge.js';
import { finalizeScopeModel } from '../../src/core/ingestion/finalize-orchestrator.js';
import { resolveFreeCallReferences } from '../../src/core/ingestion/resolve-references.js';
import { emitReferencesToGraph } from '../../src/core/ingestion/emit-references.js';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import { restoreSemanticModelRegistrations } from '../../src/core/ingestion/model/semantic-model.js';
import { createResolutionContext } from '../../src/core/ingestion/model/resolution-context.js';
import {
  processImports,
  processImportsFromExtracted,
} from '../../src/core/ingestion/import-processor.js';
import { createASTCache } from '../../src/core/ingestion/ast-cache.js';
import { BindingAccumulator } from '../../src/core/ingestion/binding-accumulator.js';
import {
  processCallsFromExtracted,
  seedCrossFileReceiverTypes,
} from '../../src/core/ingestion/call-processor.js';
import { processAssignmentsFromExtracted } from '../../src/core/ingestion/call-resolution/assignment-processor.js';
import { buildHeritageMap } from '../../src/core/ingestion/model/heritage-map.js';
import { getHeritageStrategyForLanguage } from '../../src/core/ingestion/heritage-processor.js';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const DIST_WORKER = path.resolve(
  __dirname,
  '..',
  '..',
  'dist',
  'core',
  'ingestion',
  'workers',
  'parse-worker.js',
);
const hasDistWorker = fs.existsSync(DIST_WORKER);

describe('worker pool integration', () => {
  let pool: WorkerPool | undefined;

  afterEach(async () => {
    if (pool) {
      await pool.terminate();
      pool = undefined;
    }
  });

  it('preserves destructured export metadata through the compiled TS/JS worker', async () => {
    expect(fs.existsSync(DIST_WORKER)).toBe(true);
    pool = createWorkerPool(pathToFileURL(DIST_WORKER), 1, { cooperativeShutdown: true });
    const inputs = ['ts', 'js'].flatMap((extension) => [
      {
        path: `base.${extension}`,
        content:
          'export const { value, key: local = fallback } = source; export const [item] = source; const { privateName } = source;',
      },
      { path: `app.${extension}`, content: `import * as ns from './base.${extension}';` },
    ]);
    const results = await pool.dispatch<ParseWorkerInput, ParseWorkerResult>(inputs);
    const imports = results.flatMap((result) => result.imports);
    for (const extension of ['ts', 'js']) {
      expect(
        imports
          .filter((record) => record.filePath === `base.${extension}` && record.isLocalExport)
          .flatMap((record) => record.namedBindings ?? []),
      ).toEqual(
        ['value', 'local', 'item'].map((name) => ({
          local: `#local-export:${name}`,
          exported: name,
        })),
      );
    }
    const serial = createResolutionContext();
    const worker = createResolutionContext();
    const cache = createASTCache(10);
    try {
      for (const context of [serial, worker]) {
        for (const extension of ['ts', 'js']) {
          for (const name of ['value', 'local', 'item', 'privateName', 'key', 'fallback']) {
            // Seed symbols to isolate export visibility from variable type inference.
            context.model.symbols.add(
              `base.${extension}`,
              name,
              `${extension}:${name}`,
              'Variable',
            );
          }
        }
      }
      await processImports(createKnowledgeGraph(), inputs, cache, serial);
      await processImportsFromExtracted(createKnowledgeGraph(), inputs, imports, worker);
      expect(worker.namedImportMap).toEqual(serial.namedImportMap);
      for (const context of [serial, worker]) {
        for (const extension of ['ts', 'js']) {
          for (const name of ['value', 'local', 'item', 'privateName', 'key', 'fallback']) {
            expect(
              context
                .resolve(`ns.${name}`, `app.${extension}`)
                ?.candidates.map((def) => def.nodeId) ?? [],
            ).toEqual(['value', 'local', 'item'].includes(name) ? [`${extension}:${name}`] : []);
          }
        }
      }
    } finally {
      cache.clear();
      serial.clear();
      worker.clear();
    }
  });

  it.each([true, false])(
    'extracts production TS/JS scope artifacts (collect=%s)',
    async (collectResultParts) => {
      expect(
        fs.existsSync(DIST_WORKER),
        'Build the production dist/ worker before this integration suite',
      ).toBe(true);
      const content = [
        "import Main from './module';",
        'export function target(value) {}',
        'export function caller(value) {',
        '  try { target(value); } catch (error) { recover(error); } finally { cleanup(value); }',
        '}',
        'var repeated;',
        'try { var repeated; } finally {}',
        'export { repeated };',
      ].join('\n');
      const inputs = ['ts', 'tsx', 'js', 'jsx'].map((extension) => ({
        path: `production.${extension}`,
        content,
      }));
      inputs.push({
        path: 'unsupported.ts',
        content: 'export function retained() {}\nexport function unsupported(value = 1) {}',
      });
      const expectedFiles: ParsedFile[] = [];
      const expectedOutcomes: ScopeExtractionRecord[] = [];
      for (const input of inputs) {
        const language = /\.jsx?$/.test(input.path)
          ? SupportedLanguages.JavaScript
          : SupportedLanguages.TypeScript;
        const provider = getProvider(language);
        const parser = await createParserForLanguage(language, input.path);
        const tree = parser.parse(input.content);
        expect(tree.rootNode.hasError, input.path).toBe(false);
        const outcome = extractParsedFileOutcome(
          provider,
          input.content,
          input.path,
          () => {},
          tree.rootNode,
        );
        if (outcome.status === 'success') {
          expectedFiles.push(structuredClone(outcome.parsedFile));
          expectedOutcomes.push({ filePath: input.path, status: 'success' });
          parser.parse('export function replacement() {}');
          expect(outcome.parsedFile).toEqual(expectedFiles.at(-1));
        } else {
          expectedOutcomes.push({ filePath: input.path, ...outcome });
        }
      }
      expect(expectedFiles.map((file) => file.filePath)).toEqual(
        inputs.slice(0, 4).map((file) => file.path),
      );
      expect(expectedOutcomes).toEqual([
        ...inputs.slice(0, 4).map((file) => ({ filePath: file.path, status: 'success' })),
        { filePath: 'unsupported.ts', status: 'failed', reason: 'unsupported-syntax' },
      ]);

      pool = createWorkerPool(pathToFileURL(DIST_WORKER), 1, { cooperativeShutdown: true });
      const streamed = createEmptyResult();
      let partCount = 0;
      const results = await pool.dispatch<ParseWorkerInput, ParseWorkerResult>(
        inputs,
        undefined,
        undefined,
        undefined,
        {
          collectResultParts,
          createEmptyResult,
          onResultPart: (part) => {
            partCount++;
            streamed.parsedFiles.push(...part.parsedFiles);
            streamed.scopeExtractionOutcomes!.push(...(part.scopeExtractionOutcomes ?? []));
            streamed.nodes.push(...part.nodes);
            streamed.calls.push(...part.calls);
          },
        },
      );
      expect(partCount).toBeGreaterThan(0);
      expect(streamed.parsedFiles).toHaveLength(4);
      expect(results).toHaveLength(1);
      if (!collectResultParts) {
        expect(results[0]!.parsedFiles).toEqual([]);
        expect(results[0]!.scopeExtractionOutcomes).toEqual([]);
      }
      const actual = collectResultParts ? results[0]! : streamed;
      expect(actual.parsedFiles.map(({ definitionNodeIds: _mapping, ...scope }) => scope)).toEqual(
        expectedFiles,
      );
      const outcomes = actual.scopeExtractionOutcomes ?? [];
      expect(outcomes).toHaveLength(inputs.length);
      expect(new Set(outcomes.map((outcome) => outcome.filePath)).size).toBe(inputs.length);
      // Worker batches group languages to minimize parser switches.
      const byPath = (a: ScopeExtractionRecord, b: ScopeExtractionRecord) =>
        a.filePath.localeCompare(b.filePath);
      expect([...outcomes].sort(byPath)).toEqual([...expectedOutcomes].sort(byPath));
      expect(actual.parsedFiles.some((file) => file.filePath === 'unsupported.ts')).toBe(false);
      expect(
        actual.nodes
          .filter((node) => node.properties.filePath === 'unsupported.ts')
          .map((node) => node.properties.name),
      ).toEqual(expect.arrayContaining(['retained', 'unsupported']));
      for (const file of actual.parsedFiles) {
        expect(
          actual.calls
            .filter((call) => call.filePath === file.filePath)
            .map(({ calledName, atRange }) => ({ name: calledName, atRange })),
        ).toEqual(
          file.referenceSites
            .filter((site) => site.kind === 'call')
            .map(({ name, atRange }) => ({ name, atRange })),
        );
        const sources = file.declarationSources!;
        const expectedMappings = ['target', 'caller'].map((name) => {
          const declarations = sources.filter((source) => source.name === name);
          expect(declarations).toHaveLength(1);
          const nodes = actual.nodes.filter(
            (node) =>
              node.properties.filePath === file.filePath &&
              node.properties.name === name &&
              node.label === 'Function',
          );
          expect(nodes).toHaveLength(1);
          return { defId: declarations[0]!.defId, nodeId: nodes[0]!.id };
        });
        expect(file.definitionNodeIds).toEqual(expectedMappings);
        expect(file.exports).toBeInstanceOf(Map);
        for (const scope of file.scopes) {
          expect(scope.bindings).toBeInstanceOf(Map);
          expect(scope.typeBindings).toBeInstanceOf(Map);
        }
        const module = file.scopes.find((scope) => scope.id === file.moduleScope)!;
        const repeated = module.bindings.get('repeated')!;
        expect(repeated).toHaveLength(1);
        expect(file.localDefs.filter((def) => def.qualifiedName === 'repeated')).toHaveLength(2);
        expect(file.exports!.get('repeated')).toBe(repeated[0]!.def.nodeId);
        expect([...file.exports!.keys()]).toEqual(['target', 'caller', 'repeated']);
        expect(file.parsedImports).toEqual([
          {
            kind: 'alias',
            localName: 'Main',
            importedName: 'default',
            alias: 'Main',
            targetRaw: './module',
          },
        ]);
        const catchScope = file.scopes.find((scope) => scope.bindings.has('error'))!;
        expect(catchScope).toBeDefined();
        const catchBody = file.scopes.find((scope) => scope.parent === catchScope.id)!;
        expect(catchBody).toBeDefined();
        expect(module.bindings.has('error')).toBe(false);
        expect(
          file.referenceSites.filter((site) => site.kind === 'call').map((site) => site.name),
        ).toEqual(['target', 'recover', 'cleanup']);
        expect(file.referenceSites).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ name: 'recover', inScope: catchBody.id, kind: 'call' }),
            expect.objectContaining({ name: 'error', inScope: catchBody.id, kind: 'read' }),
          ]),
        );
      }
    },
  );

  it.each([true, false])(
    'extracts production Python scope artifacts and retains refused legacy data (collect=%s)',
    async (collectResultParts) => {
      expect(
        fs.existsSync(DIST_WORKER),
        'Build the production dist/ worker before this integration suite',
      ).toBe(true);
      const inputs = [
        {
          path: 'production.py',
          content:
            'def target():\n    target()\n    return 1\ndef caller():\n    target()\ncaller()\n',
        },
        {
          path: 'parameterized.py',
          content: 'def retained():\n    pass\ndef parameterized(value):\n    retained()\n',
        },
        {
          path: 'imported.py',
          content: 'import os\ndef retained():\n    pass\ndef caller():\n    retained()\n',
        },
      ];
      const provider = getProvider(SupportedLanguages.Python);
      const parser = await createParserForLanguage(SupportedLanguages.Python, inputs[0]!.path);
      const expectedFiles: ParsedFile[] = [];
      const expectedOutcomes: ScopeExtractionRecord[] = [];
      for (const input of inputs) {
        const tree = parser.parse(input.content);
        expect(tree.rootNode.hasError, input.path).toBe(false);
        const outcome = extractParsedFileOutcome(
          provider,
          input.content,
          input.path,
          () => {},
          tree.rootNode,
        );
        if (outcome.status === 'success') {
          expectedFiles.push(structuredClone(outcome.parsedFile));
          expectedOutcomes.push({ filePath: input.path, status: 'success' });
          parser.parse('def replacement():\n    pass\n');
          expect(outcome.parsedFile).toEqual(expectedFiles.at(-1));
        } else {
          expectedOutcomes.push({ filePath: input.path, ...outcome });
        }
      }
      expect(expectedFiles.map((file) => file.filePath)).toEqual(['production.py']);
      expect(expectedOutcomes).toEqual([
        { filePath: 'production.py', status: 'success' },
        { filePath: 'parameterized.py', status: 'failed', reason: 'unsupported-syntax' },
        { filePath: 'imported.py', status: 'failed', reason: 'unsupported-syntax' },
      ]);

      pool = createWorkerPool(pathToFileURL(DIST_WORKER), 1, { cooperativeShutdown: true });
      const streamed = createEmptyResult();
      let partCount = 0;
      const results = await pool.dispatch<ParseWorkerInput, ParseWorkerResult>(
        inputs,
        undefined,
        undefined,
        undefined,
        {
          collectResultParts,
          createEmptyResult,
          onResultPart: (part) => {
            partCount++;
            streamed.parsedFiles.push(...part.parsedFiles);
            streamed.scopeExtractionOutcomes!.push(...(part.scopeExtractionOutcomes ?? []));
            streamed.nodes.push(...part.nodes);
            streamed.calls.push(...part.calls);
          },
        },
      );
      expect(partCount).toBeGreaterThan(0);
      expect(results).toHaveLength(1);
      expect(streamed.parsedFiles).toEqual(expectedFiles);
      if (!collectResultParts) {
        expect(results[0]!.parsedFiles).toEqual([]);
        expect(results[0]!.scopeExtractionOutcomes).toEqual([]);
      }
      const actual = collectResultParts ? results[0]! : streamed;
      expect(actual.parsedFiles).toEqual(expectedFiles);
      const byPath = (a: ScopeExtractionRecord, b: ScopeExtractionRecord) =>
        a.filePath.localeCompare(b.filePath);
      expect([...(actual.scopeExtractionOutcomes ?? [])].sort(byPath)).toEqual(
        [...expectedOutcomes].sort(byPath),
      );
      const file = actual.parsedFiles[0]!;
      expect(file.exports).toBeInstanceOf(Map);
      for (const scope of file.scopes) {
        expect(scope.bindings).toBeInstanceOf(Map);
        expect(scope.typeBindings).toBeInstanceOf(Map);
      }
      const module = file.scopes.find((scope) => scope.id === file.moduleScope)!;
      expect([...module.bindings.keys()]).toEqual(['target', 'caller']);
      expect([...file.exports!.keys()]).toEqual(['target', 'caller']);
      for (const name of ['target', 'caller']) {
        expect(file.exports!.get(name)).toBe(module.bindings.get(name)![0]!.def.nodeId);
      }
      expect(file.parsedImports).toEqual([]);
      expect(
        file.referenceSites.filter((site) => site.kind === 'call').map((site) => site.name),
      ).toEqual(['target', 'target', 'caller']);
      for (const [filePath, names] of [
        ['parameterized.py', ['retained', 'parameterized']],
        ['imported.py', ['retained', 'caller']],
      ] as const) {
        expect(actual.parsedFiles.some((parsed) => parsed.filePath === filePath)).toBe(false);
        expect(
          actual.nodes
            .filter((node) => node.properties.filePath === filePath)
            .map((node) => node.properties.name),
        ).toEqual(expect.arrayContaining([...names]));
        expect(actual.calls.filter((call) => call.filePath === filePath)).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ calledName: 'retained', callForm: 'free', argCount: 0 }),
          ]),
        );
      }
    },
  );

  it.each([
    { collectResultParts: true, delivery: 'result-part' },
    { collectResultParts: false, delivery: 'result-part' },
    { collectResultParts: true, delivery: 'result' },
    { collectResultParts: false, delivery: 'result' },
  ] as const)(
    'preserves synthetic scope artifacts via $delivery transport (collect=$collectResultParts)',
    async ({ collectResultParts, delivery }) => {
      // Synthetic artifact transport: this does not activate production parser extraction.
      const filePath = 'synthetic.ts';
      const moduleId = 'scope:synthetic.ts#module';
      const callerScopeId = 'scope:synthetic.ts#caller';
      const caller: SymbolDefinition = {
        nodeId: 'Function:synthetic.ts:caller',
        filePath,
        type: 'Function',
        qualifiedName: 'caller',
      };
      const target: SymbolDefinition = {
        nodeId: 'Function:synthetic.ts:target',
        filePath,
        type: 'Function',
        qualifiedName: 'target',
      };
      const range = { startLine: 1, startCol: 0, endLine: 4, endCol: 0 };
      const moduleScope: Scope = {
        id: moduleId,
        parent: null,
        kind: 'Module',
        filePath,
        range,
        bindings: new Map([
          ['caller', [{ def: caller, origin: 'local' as const }]],
          ['target', [{ def: target, origin: 'local' as const }]],
        ]),
        ownedDefs: [caller, target],
        imports: [],
        typeBindings: new Map([
          [
            'value',
            {
              rawName: 'string',
              declaredAtScope: moduleId,
              source: 'annotation' as const,
            },
          ],
        ]),
      };
      const callerScope: Scope = {
        ...moduleScope,
        id: callerScopeId,
        parent: moduleId,
        kind: 'Function',
        bindings: new Map(),
        ownedDefs: [caller],
      };
      const artifact: ParsedFile = {
        filePath,
        moduleScope: moduleId,
        scopes: [moduleScope, callerScope],
        localDefs: [caller, target],
        parsedImports: [],
        exports: new Map([['target', target.nodeId]]),
        referenceSites: ['target', 'missing'].map((name, index) => ({
          name,
          inScope: callerScopeId,
          kind: 'call',
          callForm: 'free',
          atRange: { startLine: index + 2, startCol: 0, endLine: index + 2, endCol: 9 },
        })),
      };
      const payload = { ...createEmptyResult(), parsedFiles: [artifact], fileCount: 1 };
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ontoindex-scope-transport-'));
      const workerPath = path.join(tempDir, 'artifact-worker.js');
      fs.writeFileSync(
        workerPath,
        `
        const { parentPort } = require('node:worker_threads');
        let finalResult;
        parentPort.on('message', (msg) => {
          if (msg && msg.type === 'sub-batch') {
            const input = msg.files[0];
            finalResult = input.emptyResult;
            if (input.delivery === 'result-part') {
              parentPort.postMessage({ type: 'result-part', data: input.payload });
            } else {
              finalResult = input.payload;
            }
            parentPort.postMessage({ type: 'sub-batch-done' });
          } else if (msg && msg.type === 'flush') {
            parentPort.postMessage({ type: 'result', data: finalResult });
          }
        });
      `,
      );
      const streamed: ParsedFile[] = [];
      try {
        pool = createWorkerPool(pathToFileURL(workerPath), 1);
        const results = await pool.dispatch<
          {
            path: string;
            payload: ParseWorkerResult;
            emptyResult: ParseWorkerResult;
            delivery: string;
          },
          ParseWorkerResult
        >(
          [{ path: filePath, payload, emptyResult: createEmptyResult(), delivery }],
          undefined,
          undefined,
          undefined,
          {
            collectResultParts,
            createEmptyResult,
            onResultPart: (part) => {
              streamed.push(...part.parsedFiles);
              if (!collectResultParts) part.parsedFiles.length = 0;
            },
          },
        );
        expect(results).toHaveLength(1);
        expect(streamed).toHaveLength(delivery === 'result-part' ? 1 : 0);
        const files =
          !collectResultParts && delivery === 'result-part' ? streamed : results[0]!.parsedFiles;
        expect(results[0]!.parsedFiles).toHaveLength(
          !collectResultParts && delivery === 'result-part' ? 0 : 1,
        );
        expect(files).toEqual([artifact]);
        expect(files[0]).not.toBe(artifact);
        expect(files[0]!.scopes[0]!.bindings).toBeInstanceOf(Map);
        expect(files[0]!.scopes[0]!.typeBindings).toBeInstanceOf(Map);
        expect(files[0]!.exports).toBeInstanceOf(Map);
        expect(files[0]!.scopes[0]!.bindings.get('target')![0]!.def).toEqual(target);
        expect(files[0]!.exports!.get('target')).toBe(target.nodeId);

        const emit = (parsedFiles: readonly ParsedFile[]) => {
          const scopes = finalizeScopeModel(parsedFiles);
          const resolved = resolveFreeCallReferences(scopes);
          const graph = createKnowledgeGraph();
          const stats = emitReferencesToGraph({
            graph,
            scopes,
            referenceIndex: resolved.referenceIndex,
          });
          return {
            nodes: graph.nodes,
            relationships: graph.relationships,
            stats,
            resolution: resolved.stats,
          };
        };
        const transported = emit(files);
        expect(transported).toEqual(emit([artifact]));
        expect(transported.resolution).toEqual({
          totalSites: 2,
          resolvedSites: 1,
          unresolvedSites: 1,
          ambiguousSites: 0,
          unsupportedSites: 0,
        });
        expect(transported.stats.edgesEmitted).toBe(1);
        expect(transported.relationships.filter((edge) => edge.type === 'CALLS')).toEqual([
          expect.objectContaining({ sourceId: caller.nodeId, targetId: target.nodeId }),
        ]);
      } finally {
        try {
          await pool?.terminate();
        } finally {
          pool = undefined;
          fs.rmSync(tempDir, { recursive: true, force: true });
        }
      }
    },
  );

  it.each(['thread', 'process'] as const)(
    'repeats four-worker native startup, dispatch and teardown (%s)',
    async (isolation) => {
      expect(
        fs.existsSync(DIST_WORKER),
        'Build the production dist/ worker before this integration suite',
      ).toBe(true);
      const inputs = [
        { path: 'native.js', content: 'function jsTarget() {}', name: 'jsTarget' },
        { path: 'native.ts', content: 'function tsTarget() {}', name: 'tsTarget' },
        { path: 'native.py', content: 'def pythonTarget():\n    pass\n', name: 'pythonTarget' },
        { path: 'native.cpp', content: 'void cppTarget() {}', name: 'cppTarget' },
        { path: 'native.rs', content: 'fn rust_target() {}', name: 'rust_target' },
        { path: 'native.go', content: 'package fixture\nfunc goTarget() {}\n', name: 'goTarget' },
      ];
      const expected = inputs
        .map(({ path, name }) => [path, name])
        .sort((left, right) => left[0]!.localeCompare(right[0]!));
      for (let cycle = 0; cycle < 3; cycle++) {
        pool = createWorkerPool(pathToFileURL(DIST_WORKER), 4, {
          isolation,
          cooperativeShutdown: true,
        });
        try {
          expect(pool.size).toBe(4);
          const results = await pool.dispatch<ParseWorkerInput, ParseWorkerResult>(
            inputs.map(({ path, content }) => ({ path, content })),
          );
          expect(results.reduce((count, result) => count + result.fileCount, 0)).toBe(6);
          expect(
            results
              .flatMap((result) => result.nodes)
              .filter((node) => node.label === 'Function')
              .map((node) => [node.properties.filePath, node.properties.name])
              .sort((left, right) => left[0]!.localeCompare(right[0]!)),
          ).toEqual(expected);
        } finally {
          await pool.terminate();
          pool = undefined;
        }
      }
    },
    120000,
  );

  it.each([0, 20, 80, 160, 320])(
    'awaits four native workers shutting down during startup after %dms',
    async (delayMs) => {
      expect(
        fs.existsSync(DIST_WORKER),
        'Build the production dist/ worker before this integration suite',
      ).toBe(true);
      for (let cycle = 0; cycle < 2; cycle++) {
        pool = createWorkerPool(pathToFileURL(DIST_WORKER), 4, { cooperativeShutdown: true });
        expect(pool.size).toBe(4);
        if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
        const closingPool = pool;
        await expect(
          Promise.all([closingPool.terminate(), closingPool.terminate()]),
        ).resolves.toEqual([undefined, undefined]);
        await expect(closingPool.dispatch([])).rejects.toThrow('Worker pool is closed');
        pool = undefined;
      }
    },
    120000,
  );

  it('queues cooperative shutdown until a delayed handler initializes', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ontoindex-worker-shutdown-'));
    const workerPath = path.join(tempDir, 'shutdown-worker.cjs');
    const eventsPath = path.join(tempDir, 'events.jsonl');
    fs.writeFileSync(
      workerPath,
      `
        const fs = require('node:fs');
        const { parentPort } = require('node:worker_threads');
        const record = (event) => fs.appendFileSync(${JSON.stringify(eventsPath)}, JSON.stringify(event) + '\\n');
        record('started');
        setTimeout(() => {
          record('initialized');
          const receive = (message) => {
            record(message.type);
            if (message.type === 'shutdown') {
              parentPort.close();
            }
          };
          parentPort.on('message', receive);
        }, 80);
      `,
    );
    pool = createWorkerPool(pathToFileURL(workerPath), 1, { cooperativeShutdown: true });
    const closingPool = pool;
    try {
      await expect(
        Promise.all([closingPool.terminate(), closingPool.terminate()]),
      ).resolves.toEqual([undefined, undefined]);
      pool = undefined;
      expect(
        fs
          .readFileSync(eventsPath, 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line)),
      ).toEqual(['started', 'initialized', 'shutdown']);
      await expect(closingPool.dispatch([])).rejects.toThrow('Worker pool is closed');
      await expect(closingPool.dispatch([{ path: 'closed.ts', content: '' }])).rejects.toThrow(
        'Worker pool is closed',
      );
      await expect(closingPool.terminate()).resolves.toBeUndefined();
    } finally {
      await closingPool.terminate();
      pool = undefined;
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }, 10000);

  it('does not replace a failing worker after concurrent termination', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ontoindex-worker-close-race-'));
    const workerPath = path.join(tempDir, 'shutdown-worker.cjs');
    const eventsPath = path.join(tempDir, 'events.jsonl');
    fs.writeFileSync(
      workerPath,
      `
        const fs = require('node:fs');
        const { parentPort } = require('node:worker_threads');
        const record = (event) => fs.appendFileSync(${JSON.stringify(eventsPath)}, JSON.stringify(event) + '\\n');
        record('started');
        const send = (message) => parentPort.postMessage(message);
        const receive = (message) => {
          record(message.type);
          if (message.type === 'sub-batch') {
            send({ type: 'progress', filesProcessed: 0, filePath: 'failing.ts' });
          } else if (message.type === 'shutdown') {
            send({ type: 'error', error: 'failure while closing' });
            parentPort.close();
          }
        };
        parentPort.on('message', receive);
      `,
    );
    pool = createWorkerPool(pathToFileURL(workerPath), 1, { cooperativeShutdown: true });
    const closingPool = pool;
    let termination: Promise<void> | undefined;
    try {
      const dispatch = closingPool.dispatch([{ path: 'failing.ts', content: '' }], () => {
        termination = closingPool.terminate();
      });
      await expect(dispatch).rejects.toThrow('failure while closing');
      expect(termination).toBeDefined();
      await termination;
      pool = undefined;
      expect(
        fs
          .readFileSync(eventsPath, 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line)),
      ).toEqual(['started', 'sub-batch', 'shutdown']);
      await expect(closingPool.dispatch([])).rejects.toThrow('Worker pool is closed');
    } finally {
      await closingPool.terminate();
      pool = undefined;
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }, 10000);

  it('replaces a timed-out cooperative worker once after its shutdown completes', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ontoindex-worker-timeout-'));
    const workerPath = path.join(tempDir, 'shutdown-worker.cjs');
    const eventsPath = path.join(tempDir, 'events.jsonl');
    fs.writeFileSync(
      workerPath,
      `
      const fs = require('node:fs');
      const { parentPort } = require('node:worker_threads');
      const record = (event) => fs.appendFileSync(${JSON.stringify(eventsPath)}, JSON.stringify(event) + '\\n');
      record('started');
      parentPort.on('message', (message) => {
        record(message.type);
        if (message.type === 'sub-batch') {
          if (message.files[0].path === 'timeout.ts') {
            parentPort.postMessage({ type: 'progress', filesProcessed: 0 });
          } else {
            parentPort.postMessage({ type: 'sub-batch-done' });
          }
        } else if (message.type === 'flush') {
          parentPort.postMessage({ type: 'result', data: { fileCount: 1 } });
        } else if (message.type === 'shutdown') {
          parentPort.close();
        }
      });
    `,
    );
    pool = createWorkerPool(pathToFileURL(workerPath), 1, { cooperativeShutdown: true });
    const timeoutPool = pool;
    try {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      let ready!: () => void;
      const started = new Promise<void>((resolve) => {
        ready = resolve;
      });
      const dispatch = timeoutPool.dispatch([{ path: 'timeout.ts', content: '' }], () => ready());
      const rejected = expect(dispatch).rejects.toThrow('timed out');
      await started;
      await vi.advanceTimersByTimeAsync(WORKER_SUB_BATCH_TIMEOUT_MS);
      await rejected;
      vi.useRealTimers();
      await expect(timeoutPool.dispatch([{ path: 'recovered.ts', content: '' }])).resolves.toEqual([
        { fileCount: 1 },
      ]);
      await timeoutPool.terminate();
      pool = undefined;
      expect(
        fs
          .readFileSync(eventsPath, 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line)),
      ).toEqual(['started', 'sub-batch', 'shutdown', 'started', 'sub-batch', 'flush', 'shutdown']);
    } finally {
      vi.useRealTimers();
      await timeoutPool.terminate();
      pool = undefined;
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }, 10000);

  it('forces an unresponsive cooperative worker to exit at the shutdown deadline', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ontoindex-worker-shutdown-timeout-'));
    const workerPath = path.join(tempDir, 'shutdown-worker.cjs');
    const eventsPath = path.join(tempDir, 'events.jsonl');
    fs.writeFileSync(
      workerPath,
      `
      const fs = require('node:fs');
      const { parentPort } = require('node:worker_threads');
      const record = (event) => fs.appendFileSync(${JSON.stringify(eventsPath)}, JSON.stringify(event) + '\\n');
      record('started');
      parentPort.on('message', (message) => {
        record(message.type);
        if (message.type === 'sub-batch') {
          parentPort.postMessage({ type: 'progress', filesProcessed: 0, filePath: 'hung.ts' });
        }
        // Deliberately ignore shutdown so the bounded fallback must terminate this thread.
      });
    `,
    );
    pool = createWorkerPool(pathToFileURL(workerPath), 1, { cooperativeShutdown: true });
    const closingPool = pool;
    try {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      let ready!: () => void;
      const started = new Promise<void>((resolve) => {
        ready = resolve;
      });
      const dispatch = closingPool.dispatch([{ path: 'hung.ts', content: '' }], () => ready());
      const rejected = expect(dispatch).rejects.toThrow();
      await started;

      const termination = closingPool.terminate();
      const repeatedTermination = closingPool.terminate();
      expect(repeatedTermination).toBe(termination);
      // Let the real worker thread receive the queued shutdown before the fake deadline fires.
      await vi.waitFor(
        () => {
          expect(fs.readFileSync(eventsPath, 'utf8')).toContain('"shutdown"');
        },
        { timeout: 5_000, interval: 10 },
      );
      await vi.advanceTimersByTimeAsync(30_000);
      await expect(termination).resolves.toBeUndefined();
      await rejected;
      await expect(closingPool.dispatch([])).rejects.toThrow('Worker pool is closed');
      expect(
        fs
          .readFileSync(eventsPath, 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line)),
      ).toEqual(['started', 'sub-batch', 'shutdown']);
      expect(vi.getTimerCount()).toBe(0);
      pool = undefined;
    } finally {
      vi.useRealTimers();
      await closingPool.terminate();
      pool = undefined;
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }, 10000);

  it.skipIf(!hasDistWorker)('creates a worker pool from dist/ worker', () => {
    const workerUrl = pathToFileURL(DIST_WORKER) as URL;
    pool = createWorkerPool(workerUrl, 1, { cooperativeShutdown: true });
    expect(pool.size).toBe(1);
  });

  it.skipIf(!hasDistWorker)('dispatches an empty batch without error', async () => {
    const workerUrl = pathToFileURL(DIST_WORKER) as URL;
    pool = createWorkerPool(workerUrl, 1, { cooperativeShutdown: true });
    const results = await pool.dispatch([]);
    expect(results).toEqual([]);
  });

  it.skipIf(!hasDistWorker)('parses a single TypeScript file through worker', async () => {
    const workerUrl = pathToFileURL(DIST_WORKER) as URL;
    pool = createWorkerPool(workerUrl, 1, { cooperativeShutdown: true });

    const fixtureFile = path.resolve(
      __dirname,
      '..',
      'fixtures',
      'mini-repo',
      'src',
      'validator.ts',
    );
    const content = fs.readFileSync(fixtureFile, 'utf-8');

    const results = await pool.dispatch<any, any>([{ path: 'src/validator.ts', content }]);

    // Worker returns an array of results (one per worker chunk)
    expect(results).toHaveLength(1);
    const result = results[0];
    expect(result.fileCount).toBe(1);
    expect(result.nodes.length).toBeGreaterThan(0);

    // Should find the validateInput function
    const names = result.nodes.map((n: any) => n.properties.name);
    expect(names).toContain('validateInput');
  });

  it.skipIf(!hasDistWorker)('can stream result parts without retaining them', async () => {
    const workerUrl = pathToFileURL(DIST_WORKER) as URL;
    pool = createWorkerPool(workerUrl, 1, { cooperativeShutdown: true });

    const fixtureFile = path.resolve(
      __dirname,
      '..',
      'fixtures',
      'mini-repo',
      'src',
      'validator.ts',
    );
    const content = fs.readFileSync(fixtureFile, 'utf-8');
    const streamedCounts: number[] = [];

    const results = await pool.dispatch<any, ReturnType<typeof createEmptyResult>>(
      [{ path: 'src/validator.ts', content }],
      undefined,
      undefined,
      undefined,
      {
        collectResultParts: false,
        createEmptyResult,
        onResultPart: (part) => {
          streamedCounts.push(part.nodes.length);
          part.nodes.length = 0;
          part.relationships.length = 0;
          part.symbols.length = 0;
        },
      },
    );

    expect(streamedCounts.some((count) => count > 0)).toBe(true);
    expect(results).toHaveLength(1);
    expect(results[0].nodes).toHaveLength(0);
    expect(results[0].relationships).toHaveLength(0);
    expect(results[0].symbols).toHaveLength(0);
  });

  it.skipIf(!hasDistWorker)(
    'parses a single TypeScript file through process isolation',
    async () => {
      const workerUrl = pathToFileURL(DIST_WORKER) as URL;
      pool = createWorkerPool(workerUrl, 1, { isolation: 'process', cooperativeShutdown: true });

      const fixtureFile = path.resolve(
        __dirname,
        '..',
        'fixtures',
        'mini-repo',
        'src',
        'validator.ts',
      );
      const content = fs.readFileSync(fixtureFile, 'utf-8');

      const results = await pool.dispatch<any, any>([{ path: 'src/validator.ts', content }]);

      expect(results).toHaveLength(1);
      const result = results[0];
      expect(result.fileCount).toBe(1);
      const names = result.nodes.map((n: any) => n.properties.name);
      expect(names).toContain('validateInput');
    },
  );

  it.skipIf(!hasDistWorker)(
    'uses route-model pack file patterns to trigger route extraction before provider defaults',
    async () => {
      const workerUrl = pathToFileURL(DIST_WORKER) as URL;
      pool = createWorkerPool(workerUrl, 1, { cooperativeShutdown: true });

      const content = `
        <?php
        use Illuminate\\Support\\Facades\\Route;
        Route::get('/shadow-users', [UserController::class, 'index']);
      `;

      const results = await pool.dispatch<any, any>([
        {
          path: 'custom/http/shadow-routes.php',
          content,
          routeFilePatterns: ['custom/http/**/*.php'],
        },
      ]);

      expect(results).toHaveLength(1);
      const result = results[0];
      expect(result.routes).toHaveLength(1);
      expect(result.routes[0]).toMatchObject({
        filePath: 'custom/http/shadow-routes.php',
        routePath: '/shadow-users',
        httpMethod: 'get',
      });
    },
  );

  it.skipIf(!hasDistWorker)(
    'uses component-model pack file patterns to trigger JSX component extraction before extension defaults',
    async () => {
      const workerUrl = pathToFileURL(DIST_WORKER) as URL;
      pool = createWorkerPool(workerUrl, 1, { cooperativeShutdown: true });

      const content = `
        import React from 'react';

        export function LegacyView() {
          return <UserCard title="Users" />;
        }
      `;

      const results = await pool.dispatch<any, any>([
        {
          path: 'custom/components/legacy-view.js',
          content,
          componentFilePatterns: ['custom/components/**/*.js'],
        },
      ]);

      expect(results).toHaveLength(1);
      const result = results[0];
      expect(result.calls).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            filePath: 'custom/components/legacy-view.js',
            calledName: 'UserCard',
            sourceId: 'File:custom/components/legacy-view.js',
            callForm: 'free',
          }),
        ]),
      );
    },
  );

  it.skipIf(!hasDistWorker)(
    'uses orm-model pack client identifiers to extract ORM queries before hard-coded client names',
    async () => {
      const workerUrl = pathToFileURL(DIST_WORKER) as URL;
      pool = createWorkerPool(workerUrl, 1, { cooperativeShutdown: true });

      const content = `
        export async function listUsers() {
          return db.user.findMany({ where: { active: true } });
        }

        export async function listBookings() {
          return adminDb.from('bookings').select('*');
        }
      `;

      const results = await pool.dispatch<any, any>([
        {
          path: 'custom/data/orm-aliases.ts',
          content,
          prismaClientIdentifiers: ['db'],
          supabaseClientIdentifiers: ['adminDb'],
        },
      ]);

      expect(results).toHaveLength(1);
      const result = results[0];
      expect(result.ormQueries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            filePath: 'custom/data/orm-aliases.ts',
            orm: 'prisma',
            model: 'user',
            method: 'findMany',
          }),
          expect.objectContaining({
            filePath: 'custom/data/orm-aliases.ts',
            orm: 'supabase',
            model: 'bookings',
            method: 'select',
          }),
        ]),
      );
    },
  );

  it.skipIf(!hasDistWorker)(
    'emits method call source IDs that match suffixed method node IDs',
    async () => {
      const workerUrl = pathToFileURL(DIST_WORKER) as URL;
      pool = createWorkerPool(workerUrl, 1, { cooperativeShutdown: true });

      const content = `
        const phase = {
          async execute(ctx: unknown, deps: unknown) {
            return helper();
          },
        };

        function helper() {
          return true;
        }
      `;

      const results = await pool.dispatch<any, any>([{ path: 'src/phase.ts', content }]);

      expect(results).toHaveLength(1);
      const result = results[0];
      const executeNode = result.nodes.find((n: any) => n.properties.name === 'execute');
      const helperCall = result.calls.find((c: any) => c.calledName === 'helper');

      expect(executeNode?.id).toBe('Method:src/phase.ts:execute#2');
      expect(helperCall?.sourceId).toBe(executeNode?.id);
    },
  );

  it.skipIf(!hasDistWorker)(
    'captures async generator function definitions used as call sources',
    async () => {
      const workerUrl = pathToFileURL(DIST_WORKER) as URL;
      pool = createWorkerPool(workerUrl, 1, { cooperativeShutdown: true });

      const content = `
        export async function* streamAgentResponse(messages: string[]) {
          yield formatChunk(messages);
        }

        function formatChunk(messages: string[]) {
          return messages.join(',');
        }
      `;

      const results = await pool.dispatch<any, any>([{ path: 'src/agent.ts', content }]);

      expect(results).toHaveLength(1);
      const result = results[0];
      const streamNode = result.nodes.find((n: any) => n.properties.name === 'streamAgentResponse');
      const helperCall = result.calls.find((c: any) => c.calledName === 'formatChunk');

      expect(streamNode?.id).toBe('Function:src/agent.ts:streamAgentResponse');
      expect(helperCall?.sourceId).toBe(streamNode?.id);
    },
  );

  it.skipIf(!hasDistWorker)('parses multiple files across workers', async () => {
    const workerUrl = pathToFileURL(DIST_WORKER) as URL;
    pool = createWorkerPool(workerUrl, 2, { cooperativeShutdown: true });

    const fixturesDir = path.resolve(__dirname, '..', 'fixtures', 'mini-repo', 'src');
    const files = fs
      .readdirSync(fixturesDir)
      .filter((f) => f.endsWith('.ts'))
      .map((f) => ({
        path: `src/${f}`,
        content: fs.readFileSync(path.join(fixturesDir, f), 'utf-8'),
      }));

    expect(files.length).toBeGreaterThanOrEqual(4);

    const results = await pool.dispatch<any, any>(files);

    // Each worker chunk returns a result
    expect(results.length).toBeGreaterThan(0);

    // Total files parsed should match input
    const totalParsed = results.reduce((sum: number, r: any) => sum + r.fileCount, 0);
    expect(totalParsed).toBe(files.length);

    // Should find symbols from multiple files
    const allNames = results.flatMap((r: any) => r.nodes.map((n: any) => n.properties.name));
    expect(allNames).toContain('handleRequest');
    expect(allNames).toContain('validateInput');
    expect(allNames).toContain('saveToDb');
    expect(allNames).toContain('formatResponse');
  });

  it.skipIf(!hasDistWorker)('reports progress during parsing', async () => {
    const workerUrl = pathToFileURL(DIST_WORKER) as URL;
    pool = createWorkerPool(workerUrl, 1, { cooperativeShutdown: true });

    const fixturesDir = path.resolve(__dirname, '..', 'fixtures', 'mini-repo', 'src');
    const files = fs
      .readdirSync(fixturesDir)
      .filter((f) => f.endsWith('.ts'))
      .map((f) => ({
        path: `src/${f}`,
        content: fs.readFileSync(path.join(fixturesDir, f), 'utf-8'),
      }));

    const progressCalls: number[] = [];
    await pool.dispatch<any, any>(files, (filesProcessed) => {
      progressCalls.push(filesProcessed);
    });

    // Progress callbacks are best-effort — with a small batch the worker may
    // process all files before the progress message is delivered. Just verify
    // that if progress was reported, the values are sensible.
    if (progressCalls.length > 0) {
      expect(progressCalls[progressCalls.length - 1]).toBe(files.length);
    }
  });

  it.skipIf(!hasDistWorker)('terminates cleanly', async () => {
    const workerUrl = pathToFileURL(DIST_WORKER) as URL;
    pool = createWorkerPool(workerUrl, 2, { cooperativeShutdown: true });
    await pool.terminate();
    pool = undefined; // already terminated
  });

  it('fails gracefully with invalid worker path', () => {
    const badUrl = pathToFileURL('/nonexistent/worker.js') as URL;
    // createWorkerPool validates the worker script exists before spawning
    expect(() => {
      pool = createWorkerPool(badUrl, 1);
    }).toThrow(/Worker script not found/);
  });

  // ─── Unhappy paths ──────────────────────────────────────────────────

  it.each(['ts', 'tsx', 'js', 'jsx'] as const)(
    'rebuilds the original .%s graph from retained inputs after a real worker protocol error and sequential recovery',
    async (extension) => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ontoindex-worker-recovery-'));
      const workerPath = path.join(tempDir, 'error-worker.cjs');
      const filePath = `recovery.${extension}`;
      const content =
        [
          'function target() {}',
          'function caller() {',
          '  target();',
          '  missing(unknownArg, "original", 42);',
          '  console.log("builtin");',
          '}',
        ].join('\n') + '\n';
      fs.writeFileSync(path.join(tempDir, filePath), content);
      // Controlled protocol failure; parsing and recovery use production source.
      fs.writeFileSync(
        workerPath,
        `
        const { parentPort } = require('node:worker_threads');
        parentPort.on('message', (msg) => {
          if (msg && msg.type === 'sub-batch') {
            parentPort.postMessage({
              type: 'diagnostic',
              diagnostics: {
                ...msg.diagnostics,
                phase: 'process-file',
                currentFilePath: msg.files[0].path,
              },
            });
            parentPort.postMessage({ type: 'error', error: 'Controlled recovery protocol error' });
          }
        });
      `,
      );
      const originalFactory = workerPoolModule.createWorkerPool;
      const factory = vi.spyOn(workerPoolModule, 'createWorkerPool').mockImplementationOnce(() => {
        pool = originalFactory(pathToFileURL(workerPath), 1, { isolation: 'thread' });
        return pool;
      });
      const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const allowance = { remainingBytes: 1024 * 1024 };
      const graph = createKnowledgeGraph();
      const bindings = new BindingAccumulator();
      let replayContext: ReturnType<typeof createResolutionContext> | undefined;
      let result: Awaited<ReturnType<typeof runChunkedParseAndResolve>> | undefined;
      try {
        result = await runChunkedParseAndResolve(
          graph,
          [{ path: filePath, size: Buffer.byteLength(content) }],
          [filePath],
          1,
          tempDir,
          Date.now(),
          () => {},
          {
            workerThresholdsForTest: { minFiles: 1, minBytes: 0 },
            scopeRetention: {
              deadline: Date.now() + 30_000,
              artifactAllowance: allowance,
              consume: async () => {},
            },
          },
        );
        expect(factory).toHaveBeenCalledTimes(1);
        expect(warning).toHaveBeenCalledWith(
          'Worker pool parsing failed, falling back to sequential:',
          expect.stringMatching(/Controlled recovery protocol error.*sub-batch: 1 size 1/),
        );
        expect(warning).toHaveBeenCalledWith(
          'Worker pool disabled for remaining parse chunks after fallback to sequential parsing.',
        );
        expect(result.usedWorkerPool).toBe(false);
        const retained = result.scopeRetention!;
        async function collect<T>(batches: AsyncIterable<readonly T[]>): Promise<T[]> {
          const records: T[] = [];
          for await (const batch of batches) records.push(...batch);
          return records;
        }
        const normalize = <T extends { id: string }>(records: readonly T[]): T[] =>
          JSON.parse(JSON.stringify(records)).sort((left: T, right: T) =>
            left.id.localeCompare(right.id),
          );
        const expectedNodes = normalize(graph.nodes);
        const expectedRelationships = normalize(graph.relationships);
        const identity = structuredClone(retained.inputEvidence);
        expect(identity.complete).toBe(true);
        expect(identity.sources).toEqual([
          {
            filePath,
            sha256: createHash('sha256').update(content, 'utf8').digest('hex'),
            byteLength: Buffer.byteLength(content, 'utf8'),
          },
        ]);
        // Decode all eleven families before clear() records a model lifecycle event.
        const parsedFiles = await collect(retained.iterate());
        const calls = await collect(retained.iterateCalls());
        const assignments = await collect(retained.iterateAssignments());
        const constructors = await collect(retained.iterateConstructorBindings());
        const heritage = await collect(retained.iterateHeritage());
        const fileBindings = await collect(retained.iterateFileBindings());
        const exportedTypes = await collect(retained.iterateExportedTypes());
        const events = await collect(retained.iterateModelRegistrations());
        const importStates = await collect(retained.iterateImportStates());
        const declarationNodes = await collect(retained.iterateGraphNodes());
        const structuralRelationships = await collect(retained.iterateGraphRelationships());
        expect(parsedFiles).toHaveLength(1);
        expect(parsedFiles[0]!.filePath).toBe(filePath);
        expect(retained.recordCount).toBe(1);
        expect(events.length).toBeGreaterThan(0);
        expect(importStates).toHaveLength(1);
        expect(retained.graphNodesCaptured).toBe(true);
        expect(retained.graphRelationshipsCaptured).toBe(true);
        expect(normalize(declarationNodes)).toEqual(expectedNodes);
        expect(calls).toEqual([
          {
            filePath,
            calledName: 'target',
            sourceId: `Function:${filePath}:caller`,
            callForm: 'free',
            argCount: 0,
            atRange: { startLine: 3, startCol: 2, endLine: 3, endCol: 10 },
          },
          {
            filePath,
            calledName: 'missing',
            sourceId: `Function:${filePath}:caller`,
            callForm: 'free',
            argCount: 3,
            argTypes: [undefined, 'string', 'number'],
            atRange: { startLine: 4, startCol: 2, endLine: 4, endCol: 37 },
          },
        ]);
        expect(retained.callRecordCount).toBe(2);
        expect(retained.evidenceScope).toBe('observed-inventory');
        expect(retained.callEvidenceScope).toBe('observed-parser-inputs');
        expect(retained.seedReady).toBe(false);
        expect(
          graph.relationships
            .filter((edge) => edge.type === 'CALLS')
            .map((edge) => ({
              sourceId: edge.sourceId,
              targetId: edge.targetId,
            })),
        ).toEqual([
          { sourceId: `Function:${filePath}:caller`, targetId: `Function:${filePath}:target` },
        ]);
        result.resolutionContext.clear();
        result.bindingAccumulator.dispose();
        result.exportedTypeMap.clear();
        for (const node of graph.iterNodes()) node.properties.name = 'producer-mutated';
        for (const edge of graph.iterRelationships()) edge.reason = 'producer-mutated';

        for (const { filePath, varName, typeName } of fileBindings) {
          bindings.appendFile(filePath, [{ scope: '', varName, typeName }]);
        }
        bindings.finalize();
        const exportedTypeMap = new Map<string, Map<string, string>>();
        for (const { filePath, exportName, typeName } of exportedTypes) {
          if (!exportedTypeMap.has(filePath)) exportedTypeMap.set(filePath, new Map());
          exportedTypeMap.get(filePath)!.set(exportName, typeName);
        }
        replayContext = createResolutionContext({
          model: restoreSemanticModelRegistrations({ version: 1, events }),
          importState: importStates[0]!,
        });
        const replay = createKnowledgeGraph();
        for (const node of declarationNodes) replay.addNode(node);
        for (const edge of structuralRelationships) replay.addRelationship(edge);
        seedCrossFileReceiverTypes(calls, replayContext.namedImportMap, exportedTypeMap);
        await processCallsFromExtracted(
          replay,
          calls,
          replayContext,
          undefined,
          constructors,
          buildHeritageMap(heritage, replayContext, getHeritageStrategyForLanguage),
          bindings,
        );
        processAssignmentsFromExtracted(replay, assignments, replayContext, constructors, bindings);
        expect(normalize(replay.nodes)).toEqual(expectedNodes);
        expect(normalize(replay.relationships)).toEqual(expectedRelationships);
        expect(replay.relationships.some((edge) => edge.targetId.includes('missing'))).toBe(false);
        expect(retained.inputEvidence).toEqual(identity);
        expect(retained.seedReady).toBe(false);
        expect(allowance.remainingBytes).toBeLessThan(1024 * 1024);
      } finally {
        factory.mockRestore();
        warning.mockRestore();
        try {
          replayContext?.clear();
          bindings.dispose();
          result?.resolutionContext.clear();
          await result?.scopeRetention?.dispose();
          result?.bindingAccumulator.dispose();
        } finally {
          // The pipeline owns normal termination; also cover assertions/early failures.
          try {
            await pool?.terminate();
          } finally {
            pool = undefined;
            fs.rmSync(tempDir, { recursive: true, force: true });
          }
        }
      }
      expect(allowance.remainingBytes).toBe(1024 * 1024);
    },
  );

  it('throws when a worker thread encounters an error', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ontoindex-worker-error-'));
    const workerPath = path.join(tempDir, 'error-worker.js');
    fs.writeFileSync(
      workerPath,
      `
      const { parentPort } = require('node:worker_threads');
      parentPort.on('message', (msg) => {
        if (msg && msg.type === 'sub-batch') {
          parentPort.postMessage({
            type: 'diagnostic',
            diagnostics: {
              ...msg.diagnostics,
              phase: 'process-file',
              currentFilePath: 'error.ts',
            },
          });
          parentPort.postMessage({ type: 'error', error: 'Simulated worker crash' });
        }
      });
    `,
    );

    const workerUrl = pathToFileURL(workerPath) as URL;
    pool = createWorkerPool(workerUrl, 1);

    try {
      await expect(
        pool.dispatch<any, any>([{ path: 'error.ts', content: 'const x = 1;' }]),
      ).rejects.toThrow(
        /Simulated worker crash.*sub-batch: 1 size 1.*current file: error\.ts.*active: file error\.ts/,
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('reports child-process exits with active parse context', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ontoindex-worker-process-exit-'));
    const workerPath = path.join(tempDir, 'exit-worker.js');
    fs.writeFileSync(
      workerPath,
      `
      process.on('message', (msg) => {
        if (msg && msg.type === 'sub-batch') {
          process.send({
            type: 'diagnostic',
            diagnostics: {
              ...msg.diagnostics,
              phase: 'process-file',
              currentFilePath: 'native-panic.ts',
            },
          });
          process.exit(134);
        }
      });
    `,
    );

    const workerUrl = pathToFileURL(workerPath) as URL;
    pool = createWorkerPool(workerUrl, 1, { isolation: 'process' });

    try {
      await expect(
        pool.dispatch<any, any>([{ path: 'native-panic.ts', content: 'const x = 1;' }]),
      ).rejects.toThrow(
        /Worker 0 exited with code 134.*sub-batch: 1 size 1.*current file: native-panic\.ts.*active: file native-panic\.ts.*native addon failure/,
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('escalates child-process termination when SIGTERM is ignored', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ontoindex-worker-process-kill-'));
    const workerPath = path.join(tempDir, 'ignore-term-worker.js');
    fs.writeFileSync(
      workerPath,
      `
      process.on('SIGTERM', () => {});
      process.on('message', (msg) => {
        if (msg && msg.type === 'sub-batch') {
          process.send({ type: 'sub-batch-done' });
          return;
        }
        if (msg && msg.type === 'flush') {
          process.send({ type: 'result', data: { items: [] } });
        }
      });
      setInterval(() => {}, 1000);
    `,
    );

    const workerUrl = pathToFileURL(workerPath) as URL;
    pool = createWorkerPool(workerUrl, 1, { isolation: 'process' });

    try {
      await pool.dispatch<any, any>([{ path: 'ignored-term.ts', content: 'const x = 1;' }]);
      const started = Date.now();
      await pool.terminate();
      pool = undefined;
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }, 7_000);

  it('emits process isolation startup metadata on worker events', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ontoindex-worker-process-meta-'));
    const workerPath = path.join(tempDir, 'metadata-worker.js');
    fs.writeFileSync(
      workerPath,
      `
      process.on('message', (msg) => {
        if (msg && msg.type === 'sub-batch') {
          process.send({ type: 'sub-batch-done' });
          return;
        }
        if (msg && msg.type === 'flush') {
          process.send({ type: 'result', data: { items: [] } });
        }
      });
    `,
    );

    const workerUrl = pathToFileURL(workerPath) as URL;
    pool = createWorkerPool(workerUrl, 1, { isolation: 'process' });
    const subBatchEvents: any[] = [];
    const resultEvents: any[] = [];

    try {
      await pool.dispatch<any, any>(
        [{ path: 'metadata.ts', content: 'const x = 1;' }],
        undefined,
        (event) => subBatchEvents.push(event),
        (event) => resultEvents.push(event),
      );

      expect(pool.isolation).toBe('process');
      expect(pool.startupDurationMs).toBeGreaterThanOrEqual(0);
      expect(pool.workerStartupDurationsMs).toHaveLength(1);
      expect(subBatchEvents[0]).toMatchObject({
        workerIsolation: 'process',
        workerIndex: 0,
      });
      expect(subBatchEvents[0].workerStartupDurationMs).toBeGreaterThanOrEqual(0);
      expect(resultEvents[0]).toMatchObject({
        workerIsolation: 'process',
        workerIndex: 0,
      });
      expect(resultEvents[0].workerStartupDurationMs).toBeGreaterThanOrEqual(0);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it.skipIf(!hasDistWorker)('dispatch after terminate rejects', async () => {
    const workerUrl = pathToFileURL(DIST_WORKER) as URL;
    pool = createWorkerPool(workerUrl, 1, { cooperativeShutdown: true });
    const terminatedPool = pool;
    await terminatedPool.terminate();
    pool = undefined; // already terminated — prevent afterEach double-terminate

    await expect(
      terminatedPool.dispatch([{ path: 'x.ts', content: 'const x = 1;' }]),
    ).rejects.toThrow();
  });

  it.skipIf(!hasDistWorker)('double terminate does not throw', async () => {
    const workerUrl = pathToFileURL(DIST_WORKER) as URL;
    pool = createWorkerPool(workerUrl, 1, { cooperativeShutdown: true });
    await pool.terminate();
    await expect(pool.terminate()).resolves.toBeUndefined();
    pool = undefined;
  });

  it.skipIf(!hasDistWorker)(
    'dispatches entries with empty content string without crashing',
    async () => {
      const workerUrl = pathToFileURL(DIST_WORKER) as URL;
      pool = createWorkerPool(workerUrl, 1, { cooperativeShutdown: true });

      const results = await pool.dispatch<any, any>([{ path: 'empty.ts', content: '' }]);

      expect(results).toHaveLength(1);
      const result = results[0];
      expect(typeof result.fileCount).toBe('number');
      expect(result.fileCount).toBeGreaterThanOrEqual(0);
      expect(Array.isArray(result.nodes)).toBe(true);
    },
  );

  it('treats warning messages as non-terminal and still resolves the worker result', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ontoindex-worker-warning-'));
    const workerPath = path.join(tempDir, 'warning-worker.js');
    fs.writeFileSync(
      workerPath,
      `
      const { parentPort } = require('node:worker_threads');
      parentPort.on('message', (msg) => {
        if (msg && msg.type === 'sub-batch') {
          parentPort.postMessage({ type: 'warning', message: 'warning before result' });
          parentPort.postMessage({ type: 'sub-batch-done' });
          return;
        }
        if (msg && msg.type === 'flush') {
          parentPort.postMessage({ type: 'result', data: { nodes: [], relationships: [], symbols: [], imports: [], calls: [], heritage: [], routes: [], fileCount: 1 } });
        }
      });
    `,
    );

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const workerUrl = pathToFileURL(workerPath) as URL;
    pool = createWorkerPool(workerUrl, 1);

    try {
      const results = await pool.dispatch<any, any>([
        { path: 'warning.ts', content: 'const x = 1;' },
      ]);
      expect(results).toHaveLength(1);
      expect(results[0].fileCount).toBe(1);
      expect(warnSpy).toHaveBeenCalledWith('warning before result');
    } finally {
      warnSpy.mockRestore();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it.skipIf(!hasDistWorker)('createWorkerPool with size 0 creates pool with zero workers', () => {
    const workerUrl = pathToFileURL(DIST_WORKER) as URL;
    const zeroPool = createWorkerPool(workerUrl, 0, { cooperativeShutdown: true });
    expect(zeroPool.size).toBe(0);
    return zeroPool.terminate();
  });
});
