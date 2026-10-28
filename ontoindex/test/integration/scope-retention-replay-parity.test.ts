import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { pathToFileURL } from 'node:url';
import * as workerPoolModule from '../../src/core/ingestion/workers/worker-pool.js';
import { runPipelineFromRepo } from '../../src/core/ingestion/pipeline.js';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import type { KnowledgeGraph } from '../../src/core/graph/types.js';
import { reconstructScopeRetentionParse } from '../../src/core/ingestion/pipeline-phases/parse-replay.js';
import { persistScopeRetentionCandidate } from '../../src/core/ingestion/pipeline-phases/scope-retention-candidate.js';
import { verifyScopeRetentionCandidate } from '../../src/core/ingestion/pipeline-phases/scope-retention-candidate-reader.js';
import { loadPersistedReplayFamilies } from '../helpers/scope-retention-replay.js';
import { summarizeScopeRetentionCoverage } from '../../src/core/ingestion/pipeline-phases/scope-retention-coverage.js';
import { parsePhase } from '../../src/core/ingestion/pipeline-phases/parse.js';
import { pageRankPhase } from '../../src/core/ingestion/pipeline-phases/pagerank.js';
import { finalizeScopeModel } from '../../src/core/ingestion/finalize-orchestrator.js';
import { resolveReferences } from '../../src/core/ingestion/resolve-references.js';
import { emitReferencesToGraph } from '../../src/core/ingestion/emit-references.js';
import type { ParsedFile } from 'ontoindex-shared';

beforeEach(() => vi.stubEnv('INGESTION_EMIT_SCOPES', '0'));
afterEach(() => vi.unstubAllEnvs());

// Fixture-only links; deliberately leave unknown targets (including ./types.js) unresolved.
const fixtureImports = new Map([
  ['src/main.ts:./util', 'src/util.ts'],
  ['src/ns.ts:./util', 'src/util.ts'],
  ['src/ordinary-types.tsx:./util', 'src/util.ts'],
  ['src/ordinary-types.tsx:./reference-site', 'src/reference-site.tsx'],
  ['src/mixed-types.tsx:./util', 'src/util.ts'],
  ['src/barrel.ts:./util', 'src/util.ts'],
  ['src/barrel.ts:./reference-site', 'src/reference-site.tsx'],
  ['src/barrel-consumer.ts:./barrel', 'src/barrel.ts'],
  ['src/main.js:./util', 'src/util.js'],
  ['src/ns.js:./util', 'src/util.js'],
]);

function snapshot(graph: KnowledgeGraph) {
  return {
    nodes: structuredClone(graph.nodes).sort((left, right) => left.id.localeCompare(right.id)),
    relationships: structuredClone(graph.relationships).sort((left, right) =>
      left.id.localeCompare(right.id),
    ),
  };
}

function scopeSnapshot(parsedFiles: readonly ParsedFile[]) {
  const files = structuredClone(parsedFiles);
  const scopes = finalizeScopeModel(files, {
    hooks: {
      resolveImportTarget: (targetRaw, fromFile) =>
        fixtureImports.get(`${fromFile}:${targetRaw}`) ?? null,
    },
  });
  const resolved = resolveReferences(scopes);
  const graph = createKnowledgeGraph();
  for (const file of files) {
    for (const def of file.localDefs) {
      graph.addNode({
        id: def.nodeId,
        label: def.type,
        properties: { name: def.qualifiedName ?? def.nodeId, filePath: def.filePath },
      });
    }
  }
  const previous = process.env.INGESTION_EMIT_SCOPES;
  try {
    process.env.INGESTION_EMIT_SCOPES = '1';
    const emissionStats = emitReferencesToGraph({
      graph,
      scopes,
      referenceIndex: resolved.referenceIndex,
    });
    expect(emissionStats.scopeNodesEmitted).toBeGreaterThan(0);
    expect(emissionStats.scopeEdgesEmitted).toBeGreaterThan(0);
    for (const edge of graph.relationships) {
      expect(graph.getNode(edge.sourceId), edge.id).toBeDefined();
      expect(graph.getNode(edge.targetId), edge.id).toBeDefined();
    }
    return {
      ...snapshot(graph),
      unresolvedImports: [...scopes.imports]
        .flatMap(([scopeId, imports]) =>
          imports
            .filter(({ linkStatus }) => linkStatus === 'unresolved')
            .map(({ localName, linkStatus, targetModuleScope }) => ({
              scopeId,
              localName,
              linkStatus,
              targetModuleScope,
            })),
        )
        .sort(
          (left, right) =>
            left.scopeId.localeCompare(right.scopeId) ||
            left.localName.localeCompare(right.localName),
        ),
      finalizeStats: scopes.stats,
      resolutionStats: resolved.stats,
      emissionStats,
    };
  } finally {
    if (previous === undefined) delete process.env.INGESTION_EMIT_SCOPES;
    else process.env.INGESTION_EMIT_SCOPES = previous;
  }
}

function expectRankedSnapshotsEqual(
  actual: ReturnType<typeof snapshot>,
  expected: ReturnType<typeof snapshot>,
) {
  expect(actual.relationships).toEqual(expected.relationships);
  const withoutImportance = (nodes: ReturnType<typeof snapshot>['nodes']) =>
    nodes.map((node) => {
      const { importance: _importance, ...properties } = node.properties;
      return { ...node, properties };
    });
  expect(withoutImportance(actual.nodes)).toEqual(withoutImportance(expected.nodes));
  for (const [index, node] of actual.nodes.entries()) {
    const expectedProperties = expected.nodes[index]!.properties;
    const hasImportance = Object.hasOwn(node.properties, 'importance');
    expect(hasImportance).toBe(Object.hasOwn(expectedProperties, 'importance'));
    if (hasImportance) {
      const actualImportance = node.properties.importance;
      const expectedImportance = expectedProperties.importance;
      expect(typeof actualImportance).toBe('number');
      expect(typeof expectedImportance).toBe('number');
      expect(Number.isFinite(actualImportance)).toBe(true);
      expect(Number.isFinite(expectedImportance)).toBe(true);
      // Worker traversal order can change floating-point accumulation by a few ulps.
      expect(Math.abs(actualImportance! - expectedImportance!)).toBeLessThanOrEqual(1e-14);
    }
  }
}

const pythonFiles = {
  'src/first.py': 'def first():\n    first()\ndef second():\n    first()\nsecond()\n',
  'src/other.py': 'def other():\n    other()\ndef entry():\n    other()\nentry()\n',
};

const objectAndBindingSource = [
  'function switchReturn(value) { switch (value) { case helper(0): case 1: return helper(value); default: return value; } }',
  'function unbracedSum(items) { let sum = 0; for (const item of items) sum += helper(item); return sum; }',
  'function spreadOperands(first, second) { return { ...first, own: helper(second), ...second }; }',
  'function computedPairs(key, value) { return { [helper(key)]: helper(value), [key]: value }; }',
  'function optionalOptions(first, second, options = {}) { return helper(first, second); }',
  'function optionalOptionsCalls() { optionalOptions(1, 2); optionalOptions(1, 2, {}); }',
  'function capturedObjects(closure, items) {',
  '  const spread = [closure, ...items];',
  '  for (const [left, right] of items) { helper(left); helper(right); }',
  '  for (const { value: item } of items) { helper(item); }',
  '  return {',
  '    method(parameter) { return helper(parameter, closure); },',
  '    withOptions(first, second, options = {}) { return helper(first, second); },',
  '    get value() { return helper(closure); }',
  '  };',
  '}',
  'function blockArrowOwner(closure) {',
  '  const callback = (parameter) => {',
  '    const local = helper(parameter);',
  '    return helper(local, closure);',
  '  };',
  '  callback(closure);',
  '  return callback;',
  '}',
  'function regexOwner(value) { const pattern = /helper[0-9]+/gi; return helper(value, pattern, /value/); }',
  'function conditionalOwner(flag, first, second, arg) { return (flag ? first : helper(second)).trim(arg); }',
  'function computedReceiverOwner(file, space, name) { return file.exportsByNamespace[space].get(name); }',
  'function arrowInvocationOwner(value) { return ((parameter) => { return helper(parameter); })(value); }',
  'function optionalCallOwner(value, arg) { return value?.trim(helper(arg)); }',
  'function membershipOwner(key, registry, arg) { return key in helper(registry, arg); }',
];

const fixtures: Array<{
  name: string;
  language: string;
  retained: number;
  refused: number;
  files: Record<string, string>;
  targets: string[];
}> = [
  {
    name: 'typescript',
    language: 'typescript',
    retained: 11,
    refused: 0,
    files: {
      'src/string-enum.ts': 'export enum Status { Ready = "ready", Done = "done" }\n',
      'src/resolution.ts':
        [
          'export interface TypeResolver { resolveType(expression: string, location: { filePath: string; line: number }): string | null; getFileScopeBindings(filePath: string): Array<[string, string]>; }',
          'export interface CallResolver { resolveCall(call: { calledName: string; receiverTypeName?: string; argCount?: number }): string[]; }',
        ].join('\n') + '\n',
      'src/backend-port.ts':
        [
          'export interface BackendPort { init(): Promise<boolean>; callTool(method: string, params: unknown): Promise<unknown>; dispose(): Promise<void>; }',
          'export interface GroupBackendPort extends BackendPort { listGroups(): Promise<unknown>; syncGroup(groupName: string): Promise<unknown>; }',
        ].join('\n') + '\n',
      'src/reference-site.tsx':
        [
          'import type { Range, ScopeId } from "./types.js";',
          'export type ReferenceKind = "call" | "read";',
          'export interface ReferenceSite { readonly name: string; readonly atRange: Range; readonly inScope: ScopeId; readonly kind: ReferenceKind; readonly arity?: number; }',
        ].join('\n') + '\n',
      'src/ordinary-types.tsx':
        [
          'import Main, { helper, other as Renamed, type T, type U as Local } from "./util";',
          'import * as util from "./util";',
          'import type { ReferenceSite } from "./reference-site";',
          'export type Imported = Main | typeof helper | typeof Renamed | typeof util | ReferenceSite | T | Local;',
          'export interface ImportedPort { value: Imported; }',
        ].join('\n') + '\n',
      'src/mixed-types.tsx':
        [
          'import { helper, type T, type U as Local } from "./util";',
          'export type Imported = T | Local;',
          'export interface ImportedPort { value: Imported; }',
          'export const count = 1;',
          'export function mixedEntry() { helper(); }',
        ].join('\n') + '\n',
      'src/util.ts': 'export function helper() {}\nexport function other() {}\n',
      'src/barrel.ts':
        [
          'export { helper as forwarded } from "./util";',
          'export type { ReferenceSite as Site } from "./reference-site";',
        ].join('\n') + '\n',
      'src/barrel-consumer.ts':
        [
          'import { forwarded } from "./barrel";',
          'export function viaBarrel() { forwarded(); }',
        ].join('\n') + '\n',
      'src/main.ts':
        [
          "import { helper, other as renamed } from './util';",
          'class Local { field: string; }',
          'function memberRead(owner: Local) { owner.field; }',
          'function conditional(value) { if ((value - 1) >= helper()) return !value ? (helper() * value && renamed()) : (value ?? (true || helper())); else if (value !== undefined) renamed(); else ; }',
          'new Local<string>();',
          'function run() {',
          '  helper();',
          '  renamed();',
          '  missing();',
          '}',
          'export function entry() {',
          '  run();',
          '}',
          'let generic: Array<string>;',
          'let dotted: Models.User[];',
          'let nullable: Models.User | null;',
          'function annotated(input: readonly Models.User[]): Array<string> {}',
          'function assignment(value) { value = value; }',
          'class Holder { child: Local; }',
          'function nestedRead(owner: Holder) { return owner.child.field; }',
          'function computedSelections(table, indexes, key) { return table[key] + table[indexes[key]]; }',
          'function satisfiesOperand(value) { return value satisfies Models.User; }',
          'function assertionOperand(value) { const asserted = helper(value) as [Models.User, readonly string[],][]; return asserted as Models.User; }',
          ...objectAndBindingSource,
        ].join('\n') + '\n',
      'src/ns.ts':
        [
          "import * as util from './util';",
          'export function viaNamespace() {',
          '  util.helper();',
          '}',
          'export function loopBindings(items: string[], object: Record<string, string>) {',
          '  for (let item of items) { use(item); }',
          '  for (const key in object) { use(key); }',
          '}',
          'export function continueBindings(items: string[]) {',
          '  for (const item of items) { if (item) continue; util.helper(); }',
          '  util.helper();',
          '}',
        ].join('\n') + '\n',
    },
    targets: ['helper', 'other', 'run'],
  },
  {
    name: 'javascript',
    language: 'javascript',
    retained: 3,
    refused: 0,
    files: {
      'src/util.js': 'export function helper() {}\nexport function other() {}\n',
      'src/main.js':
        [
          "import { helper, other as renamed } from './util';",
          'function nestedRead(owner) { return owner.child.field; }',
          'function computedSelections(table, indexes, key) { return table[key] + table[indexes[key]]; }',
          'function run() {',
          '  helper();',
          '  renamed();',
          '  missing();',
          '}',
          'export function entry() {',
          '  run();',
          '}',
          ...objectAndBindingSource,
        ].join('\n') + '\n',
      'src/ns.js':
        [
          "import * as util from './util';",
          'export function viaNamespace() {',
          '  util.helper();',
          '}',
        ].join('\n') + '\n',
    },
    targets: ['helper', 'other', 'run'],
  },
  {
    name: 'cpp',
    language: 'cpp',
    retained: 2,
    refused: 0,
    files: {
      'src/first.cpp':
        ['void first() { first(); return; }', 'void second() { first(); second(); }'].join('\n') +
        '\n',
      'src/other.cpp':
        ['void other() { other(); return; }', 'void entry() { other(); entry(); }'].join('\n') +
        '\n',
    },
    targets: ['first', 'second', 'other', 'entry'],
  },
  {
    name: 'rust',
    language: 'rust',
    retained: 2,
    refused: 0,
    files: {
      'src/first.rs':
        [
          'pub fn first() { second(); first(); return; }',
          'fn second() { first(); second(); }',
        ].join('\n') + '\n',
      'src/other.rs':
        ['pub fn other() { entry(); other(); return; }', 'fn entry() { other(); entry(); }'].join(
          '\n',
        ) + '\n',
    },
    targets: ['first', 'second', 'other', 'entry'],
  },
  {
    name: 'supported Python',
    language: 'python',
    retained: 2,
    refused: 0,
    files: pythonFiles,
    targets: ['first', 'second', 'other', 'entry'],
  },
  {
    name: 'mixed Python',
    language: 'python',
    retained: 2,
    refused: 1,
    files: {
      ...pythonFiles,
      'src/refused.py':
        'import os\ndef legacyTarget():\n    pass\ndef legacyCaller():\n    legacyTarget()\n',
    },
    targets: ['first', 'second', 'other', 'entry', 'legacyTarget'],
  },
];

describe.sequential.each(fixtures)('multi-file scope retention replay parity: $name', (fixture) => {
  const directories: string[] = [];
  const producers = new Map<string, ReturnType<typeof snapshot>>();
  const rankedProducers = new Map<string, ReturnType<typeof snapshot>>();
  const coverageByMode = new Map<string, ReturnType<typeof summarizeScopeRetentionCoverage>>();
  const scopeOutputs = new Map<string, ReturnType<typeof scopeSnapshot>>();

  afterAll(() => {
    for (const directory of directories) fs.rmSync(directory, { recursive: true, force: true });
  });

  it.each(['sequential', 'worker', 'recovery'] as const)(
    '%s replays retained resolution inputs',
    async (mode) => {
      if (mode !== 'sequential') {
        expect(
          fs.existsSync(
            path.resolve(__dirname, '../../dist/core/ingestion/workers/parse-worker.js'),
          ),
          'Build the production dist/ worker before this integration suite',
        ).toBe(true);
      }
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ontoindex-retention-parity-'));
      directories.push(directory);
      fs.mkdirSync(path.join(directory, 'src'));
      for (const [filePath, source] of Object.entries(fixture.files)) {
        fs.writeFileSync(path.join(directory, filePath), source);
      }
      let recoveryPool: workerPoolModule.WorkerPool | undefined;
      const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
      if (mode === 'recovery') {
        // Controlled protocol failure; parsing and sequential recovery use production source.
        // Keep the stub outside the scanned repository so it is not part of the input inventory.
        const stubDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'ontoindex-retention-stub-'));
        directories.push(stubDirectory);
        const workerPath = path.join(stubDirectory, 'error-worker.cjs');
        fs.writeFileSync(
          workerPath,
          [
            "const { parentPort } = require('node:worker_threads');",
            "parentPort.on('message', (msg) => {",
            "  if (msg && msg.type === 'sub-batch') {",
            "    parentPort.postMessage({ type: 'diagnostic', diagnostics: { ...msg.diagnostics, phase: 'process-file', currentFilePath: msg.files[0].path } });",
            "    parentPort.postMessage({ type: 'error', error: 'Controlled recovery protocol error' });",
            '  }',
            '});',
          ].join('\n'),
        );
        const originalFactory = workerPoolModule.createWorkerPool;
        vi.spyOn(workerPoolModule, 'createWorkerPool').mockImplementationOnce(() => {
          recoveryPool = originalFactory(pathToFileURL(workerPath), 1, { isolation: 'thread' });
          return recoveryPool;
        });
      }
      let generationDirectory: string | undefined;
      let expected: Parameters<typeof verifyScopeRetentionCandidate>[1] | undefined;
      let consumed = false;
      let result: Awaited<ReturnType<typeof runPipelineFromRepo>>;
      let producer: ReturnType<typeof snapshot> | undefined;
      let beforePageRank: ReturnType<typeof snapshot> | undefined;
      let rankedProducer: ReturnType<typeof snapshot> | undefined;
      let liveScopeOutput: ReturnType<typeof scopeSnapshot> | undefined;
      let liveParsedFiles: ParsedFile[] | undefined;
      const executeParse = parsePhase.execute;
      const parseSpy = vi.spyOn(parsePhase, 'execute').mockImplementation(async (ctx, deps) => {
        const output = await executeParse(ctx, deps);
        producer = snapshot(ctx.graph);
        return output;
      });
      const executePageRank = pageRankPhase.execute;
      const pageRankSpy = vi
        .spyOn(pageRankPhase, 'execute')
        .mockImplementation(async (ctx, deps) => {
          beforePageRank = snapshot(ctx.graph);
          const output = await executePageRank(ctx, deps);
          rankedProducer = snapshot(ctx.graph);
          return output;
        });
      try {
        result = await runPipelineFromRepo(directory, () => {}, {
          skipGraphPhases: true,
          ...(mode === 'sequential'
            ? { skipWorkers: true }
            : { workerThresholdsForTest: { minFiles: 1, minBytes: 0 } }),
          scopeRetention: {
            deadline: Date.now() + 60_000,
            artifactAllowance: { remainingBytes: 64 * 1024 * 1024 },
            consume: async (handle) => {
              consumed = true;
              const liveFiles: ParsedFile[] = [];
              for await (const batch of handle.iterate()) liveFiles.push(...batch);
              liveParsedFiles = structuredClone(liveFiles);
              liveScopeOutput = scopeSnapshot(liveFiles);
              expect(process.env.INGESTION_EMIT_SCOPES).toBe('0');
              const coverage = summarizeScopeRetentionCoverage(handle.inventory);
              coverageByMode.set(mode, coverage);
              expect(coverage).toEqual({
                version: 1,
                languages: [
                  {
                    language: fixture.language,
                    files: fixture.retained + fixture.refused,
                    retained: fixture.retained,
                    skipped: 0,
                    refused: fixture.refused,
                    unaccounted: 0,
                    unparsed: 0,
                    refusalReasons: fixture.refused
                      ? [{ reason: 'unsupported-syntax', count: 1 }]
                      : [],
                  },
                ],
                complete: fixture.refused === 0,
              });
              expect(
                [...handle.inventory].sort((left, right) =>
                  left.filePath.localeCompare(right.filePath),
                ),
              ).toEqual(
                Object.keys(fixture.files)
                  .sort()
                  .map((filePath) =>
                    filePath === 'src/refused.py'
                      ? { filePath, status: 'failed', reason: 'unsupported-syntax' }
                      : { filePath, status: 'retained' },
                  ),
              );
              generationDirectory = fs.mkdtempSync(
                path.join(os.tmpdir(), 'ontoindex-retention-candidate-'),
              );
              directories.push(generationDirectory);
              const identity = {
                sourceManifestDigest: 'a'.repeat(64),
                targetCommit: 'head',
                baseGenerationId: null,
              };
              const manifest = await persistScopeRetentionCandidate(
                handle,
                generationDirectory,
                identity,
                {
                  deadline: Date.now() + 60_000,
                  artifactAllowance: { remainingBytes: 64 * 1024 * 1024 },
                },
              );
              expected = { identity, parserCodeIdentity: handle.inputEvidence.parserCodeIdentity };
              expect(
                await verifyScopeRetentionCandidate(generationDirectory, expected, {
                  deadline: Date.now() + 60_000,
                }),
              ).toEqual(manifest);
              expect(manifest.coverage).toEqual(coverage);
              expect(manifest.seedReady).toBe(false);
              expect(handle.seedReady).toBe(false);
              expect(handle.inputEvidence.complete).toBe(fixture.refused === 0);
              expect(handle.inputEvidence.sources.map(({ filePath }) => filePath).sort()).toEqual(
                Object.keys(fixture.files).sort(),
              );
              if (fixture.refused)
                expect(handle.inputEvidence.reasons).toContain('artifact-incomplete');
              expect(handle.graphNodesCaptured).toBe(fixture.refused === 0);
              expect(handle.graphRelationshipsCaptured).toBe(fixture.refused === 0);
            },
          },
        });
        expect(parseSpy).toHaveBeenCalledTimes(1);
        expect(producer).toBeDefined();
        expect(pageRankSpy).toHaveBeenCalledTimes(1);
        expect(beforePageRank).toBeDefined();
        expect(rankedProducer).toBeDefined();
        // These fixtures require no graph mutations from routes, tools, ORM or cross-file propagation.
        expect(beforePageRank).toEqual(producer);
        expect(producer!.nodes.every(({ properties }) => properties.importance === undefined)).toBe(
          true,
        );
      } finally {
        vi.restoreAllMocks();
        await recoveryPool?.terminate();
      }
      expect(consumed).toBe(true);
      expect(result.usedWorkerPool).toBe(mode === 'worker');
      if (mode === 'recovery') {
        expect(warning).toHaveBeenCalledWith(
          'Worker pool parsing failed, falling back to sequential:',
          expect.stringMatching(/Controlled recovery protocol error/),
        );
      }
      expect(generationDirectory).toBeDefined();
      expect(expected).toBeDefined();
      const families = await loadPersistedReplayFamilies(generationDirectory!, expected!);
      const { parsedFiles, calls, events, importStates, declarationNodes } = families;
      const byFilePath = (left: ParsedFile, right: ParsedFile) =>
        left.filePath.localeCompare(right.filePath);
      expect([...parsedFiles].sort(byFilePath)).toEqual(liveParsedFiles!.sort(byFilePath));
      // Verify persisted call identity against the independent scope capture, not only graph parity.
      if (fixture.language === 'typescript' || fixture.language === 'javascript') {
        let comparedCalls = 0;
        for (const file of parsedFiles) {
          for (const site of file.referenceSites.filter((site) => site.kind === 'call')) {
            expect(calls, `${file.filePath}:${site.name}`).toContainEqual(
              expect.objectContaining({
                filePath: file.filePath,
                calledName: site.name,
                atRange: site.atRange,
              }),
            );
            comparedCalls++;
          }
        }
        expect(comparedCalls).toBeGreaterThan(0);
      }
      expect(liveScopeOutput).toBeDefined();
      const persistedScopeOutput = scopeSnapshot(parsedFiles);
      expect(persistedScopeOutput).toEqual(liveScopeOutput);
      expect(persistedScopeOutput.relationships.some((edge) => edge.type === 'CALLS')).toBe(true);
      if (fixture.name === 'typescript') {
        expect(persistedScopeOutput.relationships.some((edge) => edge.type === 'ACCESSES')).toBe(
          true,
        );
      }
      if (fixture.language === 'typescript' || fixture.language === 'javascript') {
        const extension = fixture.language === 'typescript' ? 'ts' : 'js';
        const util = parsedFiles.find(({ filePath }) => filePath === `src/util.${extension}`)!;
        const main = parsedFiles.find(({ filePath }) => filePath === `src/main.${extension}`)!;
        const mainSource = fixture.files[`src/main.${extension}`]!;
        const mainLines = mainSource.split('\n');
        const lineOf = (text: string) => mainLines.findIndex((line) => line.includes(text)) + 1;
        const blockArrowLine = lineOf('function blockArrowOwner(');
        const blockArrowScope = main.scopes.find(
          (scope) => scope.kind === 'Function' && scope.range.startLine === blockArrowLine,
        )!;
        expect(blockArrowScope).toBeDefined();
        expect([...blockArrowScope.bindings.keys()]).toEqual(['closure']);
        const blockArrowOwnerBody = main.scopes.find(
          (scope) => scope.parent === blockArrowScope.id && scope.kind === 'Block',
        )!;
        expect(blockArrowOwnerBody).toBeDefined();
        const callbackLine = lineOf('  const callback = (parameter) => {');
        const callbackScope = main.scopes.find(
          (scope) => scope.kind === 'Function' && scope.range.startLine === callbackLine,
        )!;
        expect(callbackScope).toBeDefined();
        expect([...callbackScope.bindings.keys()]).toEqual(['parameter']);
        const callbackBody = main.scopes.find(
          (scope) => scope.parent === callbackScope.id && scope.kind === 'Block',
        )!;
        expect(callbackBody).toBeDefined();
        expect(callbackBody.bindings.has('local')).toBe(true);
        expect(blockArrowOwnerBody.bindings.has('local')).toBe(false);
        const callbackCallLine = lineOf('    const local = helper(parameter);');
        const callbackReturnLine = lineOf('    return helper(local, closure);');
        const callbackInvocationLine = lineOf('  callback(closure);');
        const getNames = (line: number) =>
          main.referenceSites
            .filter((site) => site.atRange.startLine === line)
            .map(({ name, kind, inScope, arity }) => ({ name, kind, inScope, arity }));
        expect(getNames(callbackCallLine)).toEqual([
          { name: 'helper', kind: 'call', inScope: callbackBody.id, arity: 1 },
          { name: 'parameter', kind: 'read', inScope: callbackBody.id, arity: undefined },
        ]);
        expect(getNames(callbackReturnLine)).toEqual([
          { name: 'helper', kind: 'call', inScope: callbackBody.id, arity: 2 },
          { name: 'local', kind: 'read', inScope: callbackBody.id, arity: undefined },
          { name: 'closure', kind: 'read', inScope: callbackBody.id, arity: undefined },
        ]);
        expect(getNames(callbackInvocationLine)).toEqual([
          { name: 'callback', kind: 'call', inScope: blockArrowOwnerBody.id, arity: 1 },
          { name: 'closure', kind: 'read', inScope: blockArrowOwnerBody.id, arity: undefined },
        ]);
        const unbracedLine = lineOf('function unbracedSum(');
        const unbracedSource = mainLines[unbracedLine - 1]!;
        const unbracedScope = main.scopes.find(
          (scope) => scope.kind === 'Function' && scope.range.startLine === unbracedLine,
        )!;
        expect(unbracedScope).toBeDefined();
        const unbracedBody = main.scopes.find(
          (scope) => scope.parent === unbracedScope.id && scope.kind === 'Block',
        )!;
        expect(unbracedBody).toBeDefined();
        expect(unbracedBody.bindings.has('sum')).toBe(true);
        const unbracedLoop = main.scopes.find(
          (scope) => scope.parent === unbracedBody.id && scope.kind === 'Block',
        )!;
        expect(unbracedLoop).toBeDefined();
        expect([...unbracedLoop.bindings.keys()]).toEqual(['item']);
        expect(unbracedBody.bindings.has('item')).toBe(false);
        const unbracedRange = (text: string, from: number) => {
          const startCol = unbracedSource.indexOf(text, from);
          return {
            startLine: unbracedLine,
            startCol,
            endLine: unbracedLine,
            endCol: startCol + text.length,
          };
        };
        const iterableStart = unbracedSource.indexOf('items', unbracedSource.indexOf('for ('));
        const targetStart = unbracedSource.indexOf('sum +=');
        const callStart = unbracedSource.indexOf('helper(item)');
        const argumentStart = callStart + 'helper('.length;
        const returnStart = unbracedSource.indexOf('return sum') + 'return '.length;
        expect(
          main.referenceSites
            .filter((site) => site.atRange.startLine === unbracedLine)
            .map(({ name, kind, inScope, arity, atRange }) => ({
              name,
              kind,
              inScope,
              arity,
              atRange,
            })),
        ).toEqual([
          {
            name: 'items',
            kind: 'read',
            inScope: unbracedLoop.id,
            arity: undefined,
            atRange: unbracedRange('items', iterableStart),
          },
          {
            name: 'sum',
            kind: 'read',
            inScope: unbracedLoop.id,
            arity: undefined,
            atRange: unbracedRange('sum', targetStart),
          },
          {
            name: 'sum',
            kind: 'write',
            inScope: unbracedLoop.id,
            arity: undefined,
            atRange: unbracedRange('sum', targetStart),
          },
          {
            name: 'helper',
            kind: 'call',
            inScope: unbracedLoop.id,
            arity: 1,
            atRange: unbracedRange('helper(item)', callStart),
          },
          {
            name: 'item',
            kind: 'read',
            inScope: unbracedLoop.id,
            arity: undefined,
            atRange: unbracedRange('item', argumentStart),
          },
          {
            name: 'sum',
            kind: 'read',
            inScope: unbracedBody.id,
            arity: undefined,
            atRange: unbracedRange('sum', returnStart),
          },
        ]);
        const switchLine = lineOf('function switchReturn(');
        const switchSource = mainLines[switchLine - 1]!;
        const switchFunction = main.scopes.find(
          (scope) => scope.kind === 'Function' && scope.range.startLine === switchLine,
        )!;
        expect(switchFunction).toBeDefined();
        const switchFunctionBody = main.scopes.find(
          (scope) => scope.parent === switchFunction.id && scope.kind === 'Block',
        )!;
        expect(switchFunctionBody).toBeDefined();
        const switchBody = main.scopes.find(
          (scope) => scope.parent === switchFunctionBody.id && scope.kind === 'Block',
        )!;
        expect(switchBody).toBeDefined();
        const switchRange = (text: string, from: number) => {
          const startCol = switchSource.indexOf(text, from);
          return {
            startLine: switchLine,
            startCol,
            endLine: switchLine,
            endCol: startCol + text.length,
          };
        };
        const discriminantStart = switchSource.indexOf('value', switchSource.indexOf('switch ('));
        const labelCallStart = switchSource.indexOf('helper(0)');
        const bodyCallStart = switchSource.indexOf('helper(value)');
        const bodyArgumentStart = bodyCallStart + 'helper('.length;
        const defaultReturnStart = switchSource.indexOf('value', switchSource.indexOf('default:'));
        expect(
          main.referenceSites
            .filter((site) => site.atRange.startLine === switchLine)
            .map(({ name, kind, inScope, arity, atRange }) => ({
              name,
              kind,
              inScope,
              arity,
              atRange,
            })),
        ).toEqual([
          {
            name: 'value',
            kind: 'read',
            inScope: switchFunctionBody.id,
            arity: undefined,
            atRange: switchRange('value', discriminantStart),
          },
          {
            name: 'helper',
            kind: 'call',
            inScope: switchBody.id,
            arity: 1,
            atRange: switchRange('helper(0)', labelCallStart),
          },
          {
            name: 'helper',
            kind: 'call',
            inScope: switchBody.id,
            arity: 1,
            atRange: switchRange('helper(value)', bodyCallStart),
          },
          {
            name: 'value',
            kind: 'read',
            inScope: switchBody.id,
            arity: undefined,
            atRange: switchRange('value', bodyArgumentStart),
          },
          {
            name: 'value',
            kind: 'read',
            inScope: switchBody.id,
            arity: undefined,
            atRange: switchRange('value', defaultReturnStart),
          },
        ]);
        const capturedLine = lineOf('function capturedObjects(');
        const capturedScope = main.scopes.find(
          (scope) => scope.kind === 'Function' && scope.range.startLine === capturedLine,
        )!;
        expect(capturedScope).toBeDefined();
        expect([...capturedScope.bindings.keys()].sort()).toEqual(['closure', 'items']);
        const capturedBody = main.scopes.find(
          (scope) => scope.parent === capturedScope.id && scope.kind === 'Block',
        )!;
        expect(capturedBody).toBeDefined();
        expect(capturedBody.bindings.has('spread')).toBe(true);
        const spreadOperandsLine = lineOf('function spreadOperands(');
        const spreadOperandsSource = mainLines[spreadOperandsLine - 1]!;
        const spreadOperandsScope = main.scopes.find(
          (scope) => scope.kind === 'Function' && scope.range.startLine === spreadOperandsLine,
        )!;
        const spreadOperandsBody = main.scopes.find(
          (scope) => scope.parent === spreadOperandsScope.id && scope.kind === 'Block',
        )!;
        const rangeOfOperand = (text: string, from = 0) => {
          const startCol = spreadOperandsSource.indexOf(text, from);
          return {
            startLine: spreadOperandsLine,
            startCol,
            endLine: spreadOperandsLine,
            endCol: startCol + text.length,
          };
        };
        const firstSpreadStart = spreadOperandsSource.indexOf('...first') + 3;
        const helperStart = spreadOperandsSource.indexOf('helper(');
        const secondCallStart = spreadOperandsSource.indexOf('second', helperStart);
        const secondSpreadStart = spreadOperandsSource.lastIndexOf('...second') + 3;
        expect(
          main.referenceSites
            .filter((site) => site.atRange.startLine === spreadOperandsLine)
            .map(({ name, kind, inScope, arity, atRange }) => ({
              name,
              kind,
              inScope,
              arity,
              atRange,
            })),
        ).toEqual([
          {
            name: 'first',
            kind: 'read',
            inScope: spreadOperandsBody.id,
            arity: undefined,
            atRange: rangeOfOperand('first', firstSpreadStart),
          },
          {
            name: 'helper',
            kind: 'call',
            inScope: spreadOperandsBody.id,
            arity: 1,
            atRange: rangeOfOperand('helper(second)', helperStart),
          },
          {
            name: 'second',
            kind: 'read',
            inScope: spreadOperandsBody.id,
            arity: undefined,
            atRange: rangeOfOperand('second', secondCallStart),
          },
          {
            name: 'second',
            kind: 'read',
            inScope: spreadOperandsBody.id,
            arity: undefined,
            atRange: rangeOfOperand('second', secondSpreadStart),
          },
        ]);
        const computedPairsLine = lineOf('function computedPairs(');
        const computedPairsSource = mainLines[computedPairsLine - 1]!;
        const computedPairsScope = main.scopes.find(
          (scope) => scope.kind === 'Function' && scope.range.startLine === computedPairsLine,
        )!;
        const computedPairsBody = main.scopes.find(
          (scope) => scope.parent === computedPairsScope.id && scope.kind === 'Block',
        )!;
        const rangeOfComputedOperand = (text: string, from = 0) => {
          const startCol = computedPairsSource.indexOf(text, from);
          return {
            startLine: computedPairsLine,
            startCol,
            endLine: computedPairsLine,
            endCol: startCol + text.length,
          };
        };
        const keyCallStart = computedPairsSource.indexOf('helper(key)');
        const keyReadStart = computedPairsSource.indexOf('key', keyCallStart);
        const valueCallStart = computedPairsSource.indexOf('helper(value)');
        const valueReadStart = computedPairsSource.indexOf('value', valueCallStart);
        const computedKeyReadStart = computedPairsSource.indexOf('[key]', valueCallStart) + 1;
        const computedValueReadStart =
          computedPairsSource.indexOf(': value', computedKeyReadStart) + 2;
        expect(
          main.referenceSites
            .filter((site) => site.atRange.startLine === computedPairsLine)
            .map(({ name, kind, inScope, arity, atRange }) => ({
              name,
              kind,
              inScope,
              arity,
              atRange,
            })),
        ).toEqual([
          {
            name: 'helper',
            kind: 'call',
            inScope: computedPairsBody.id,
            arity: 1,
            atRange: rangeOfComputedOperand('helper(key)', keyCallStart),
          },
          {
            name: 'key',
            kind: 'read',
            inScope: computedPairsBody.id,
            arity: undefined,
            atRange: rangeOfComputedOperand('key', keyReadStart),
          },
          {
            name: 'helper',
            kind: 'call',
            inScope: computedPairsBody.id,
            arity: 1,
            atRange: rangeOfComputedOperand('helper(value)', valueCallStart),
          },
          {
            name: 'value',
            kind: 'read',
            inScope: computedPairsBody.id,
            arity: undefined,
            atRange: rangeOfComputedOperand('value', valueReadStart),
          },
          {
            name: 'key',
            kind: 'read',
            inScope: computedPairsBody.id,
            arity: undefined,
            atRange: rangeOfComputedOperand('key', computedKeyReadStart),
          },
          {
            name: 'value',
            kind: 'read',
            inScope: computedPairsBody.id,
            arity: undefined,
            atRange: rangeOfComputedOperand('value', computedValueReadStart),
          },
        ]);
        if (extension === 'ts') {
          const satisfiesLine = lineOf('function satisfiesOperand(');
          const satisfiesSource = mainLines[satisfiesLine - 1]!;
          const satisfiesBody = main.scopes.find(
            (scope) => scope.kind === 'Block' && scope.range.startLine === satisfiesLine,
          )!;
          const operandStart = satisfiesSource.indexOf('value satisfies');
          expect(
            main.referenceSites
              .filter((site) => site.atRange.startLine === satisfiesLine)
              .map(({ name, kind, inScope, atRange }) => ({ name, kind, inScope, atRange })),
          ).toEqual([
            {
              name: 'value',
              kind: 'read',
              inScope: satisfiesBody.id,
              atRange: {
                startLine: satisfiesLine,
                startCol: operandStart,
                endLine: satisfiesLine,
                endCol: operandStart + 'value'.length,
              },
            },
          ]);
          expect(
            main.referenceSites
              .filter((site) => site.atRange.startLine === satisfiesLine)
              .some((site) => site.name === 'Models' || site.name === 'User'),
          ).toBe(false);

          const assertionLine = lineOf('function assertionOperand(');
          const assertionSource = mainLines[assertionLine - 1]!;
          const assertionBody = main.scopes.find(
            (scope) => scope.kind === 'Block' && scope.range.startLine === assertionLine,
          )!;
          const assertedReadStart = assertionSource.indexOf('asserted as');
          const helperCallStart = assertionSource.indexOf('helper(value)');
          const valueReadStart = assertionSource.indexOf('value', helperCallStart);
          const assertedBindings = assertionBody.bindings.get('asserted');
          expect(assertedBindings).toHaveLength(1);
          expect(assertedBindings?.[0]?.def.declaredType).toBeUndefined();
          expect(
            main.referenceSites
              .filter((site) => site.atRange.startLine === assertionLine)
              .map(({ name, kind, callForm, arity, inScope, atRange }) => ({
                name,
                kind,
                callForm,
                arity,
                inScope,
                atRange,
              })),
          ).toEqual([
            {
              name: 'helper',
              kind: 'call',
              callForm: 'free',
              arity: 1,
              inScope: assertionBody.id,
              atRange: {
                startLine: assertionLine,
                startCol: helperCallStart,
                endLine: assertionLine,
                endCol: helperCallStart + 'helper(value)'.length,
              },
            },
            {
              name: 'value',
              kind: 'read',
              callForm: undefined,
              arity: undefined,
              inScope: assertionBody.id,
              atRange: {
                startLine: assertionLine,
                startCol: valueReadStart,
                endLine: assertionLine,
                endCol: valueReadStart + 'value'.length,
              },
            },
            {
              name: 'asserted',
              kind: 'read',
              callForm: undefined,
              arity: undefined,
              inScope: assertionBody.id,
              atRange: {
                startLine: assertionLine,
                startCol: assertedReadStart,
                endLine: assertionLine,
                endCol: assertedReadStart + 'asserted'.length,
              },
            },
          ]);
        }
        const regexLine = lineOf('function regexOwner(');
        const regexSource = mainLines[regexLine - 1]!;
        const regexScope = main.scopes.find(
          (scope) => scope.kind === 'Function' && scope.range.startLine === regexLine,
        )!;
        const regexBody = main.scopes.find(
          (scope) => scope.parent === regexScope.id && scope.kind === 'Block',
        )!;
        const patternBindings = regexBody.bindings.get('pattern');
        expect(patternBindings).toHaveLength(1);
        expect(patternBindings?.[0]?.def.declaredType).toBeUndefined();
        const regexCallStart = regexSource.indexOf('helper(value, pattern, /value/)');
        const regexValueStart = regexSource.indexOf('value', regexCallStart);
        const regexPatternStart = regexSource.indexOf('pattern', regexValueStart);
        expect(
          main.referenceSites
            .filter((site) => site.atRange.startLine === regexLine)
            .map(({ name, kind, callForm, arity, inScope, atRange }) => ({
              name,
              kind,
              callForm,
              arity,
              inScope,
              atRange,
            })),
        ).toEqual([
          {
            name: 'helper',
            kind: 'call',
            callForm: 'free',
            arity: 3,
            inScope: regexBody.id,
            atRange: {
              startLine: regexLine,
              startCol: regexCallStart,
              endLine: regexLine,
              endCol: regexCallStart + 'helper(value, pattern, /value/)'.length,
            },
          },
          {
            name: 'value',
            kind: 'read',
            callForm: undefined,
            arity: undefined,
            inScope: regexBody.id,
            atRange: {
              startLine: regexLine,
              startCol: regexValueStart,
              endLine: regexLine,
              endCol: regexValueStart + 'value'.length,
            },
          },
          {
            name: 'pattern',
            kind: 'read',
            callForm: undefined,
            arity: undefined,
            inScope: regexBody.id,
            atRange: {
              startLine: regexLine,
              startCol: regexPatternStart,
              endLine: regexLine,
              endCol: regexPatternStart + 'pattern'.length,
            },
          },
        ]);
        const conditionalOwnerLine = lineOf('function conditionalOwner(');
        const conditionalOwnerSource = mainLines[conditionalOwnerLine - 1]!;
        const conditionalOwnerScope = main.scopes.find(
          (scope) => scope.kind === 'Function' && scope.range.startLine === conditionalOwnerLine,
        )!;
        const conditionalOwnerBody = main.scopes.find(
          (scope) => scope.parent === conditionalOwnerScope.id && scope.kind === 'Block',
        )!;
        const conditionalCall = '(flag ? first : helper(second)).trim(arg)';
        const conditionalCallStart = conditionalOwnerSource.indexOf(conditionalCall);
        const conditionalTrimStart = conditionalOwnerSource.indexOf('.trim(') + 1;
        const conditionalFlagStart = conditionalOwnerSource.indexOf('flag', conditionalCallStart);
        const conditionalFirstStart = conditionalOwnerSource.indexOf('first', conditionalCallStart);
        const conditionalHelperStart = conditionalOwnerSource.indexOf(
          'helper(',
          conditionalCallStart,
        );
        const conditionalSecondStart = conditionalOwnerSource.indexOf(
          'second',
          conditionalHelperStart,
        );
        const conditionalArgStart = conditionalOwnerSource.indexOf('arg', conditionalTrimStart);
        const conditionalRange = (startCol: number, length: number) => ({
          startLine: conditionalOwnerLine,
          startCol,
          endLine: conditionalOwnerLine,
          endCol: startCol + length,
        });
        const conditionalOwnerSites = main.referenceSites.filter(
          (site) => site.atRange.startLine === conditionalOwnerLine,
        );
        expect(
          conditionalOwnerSites.map(
            ({ name, kind, callForm, arity, explicitReceiver, inScope, atRange }) => ({
              name,
              kind,
              callForm,
              arity,
              explicitReceiver,
              inScope,
              atRange,
            }),
          ),
        ).toEqual([
          {
            name: 'trim',
            kind: 'call',
            callForm: 'member',
            arity: 1,
            explicitReceiver: { kind: 'unknown' },
            inScope: conditionalOwnerBody.id,
            atRange: conditionalRange(conditionalCallStart, conditionalCall.length),
          },
          {
            name: 'flag',
            kind: 'read',
            callForm: undefined,
            arity: undefined,
            explicitReceiver: undefined,
            inScope: conditionalOwnerBody.id,
            atRange: conditionalRange(conditionalFlagStart, 4),
          },
          {
            name: 'first',
            kind: 'read',
            callForm: undefined,
            arity: undefined,
            explicitReceiver: undefined,
            inScope: conditionalOwnerBody.id,
            atRange: conditionalRange(conditionalFirstStart, 5),
          },
          {
            name: 'helper',
            kind: 'call',
            callForm: 'free',
            arity: 1,
            explicitReceiver: undefined,
            inScope: conditionalOwnerBody.id,
            atRange: conditionalRange(conditionalHelperStart, 'helper(second)'.length),
          },
          {
            name: 'second',
            kind: 'read',
            callForm: undefined,
            arity: undefined,
            explicitReceiver: undefined,
            inScope: conditionalOwnerBody.id,
            atRange: conditionalRange(conditionalSecondStart, 6),
          },
          {
            name: 'arg',
            kind: 'read',
            callForm: undefined,
            arity: undefined,
            explicitReceiver: undefined,
            inScope: conditionalOwnerBody.id,
            atRange: conditionalRange(conditionalArgStart, 3),
          },
        ]);
        expect(conditionalOwnerBody.bindings.get('trim')).toBeUndefined();
        const computedReceiverLine = lineOf('function computedReceiverOwner(');
        const computedReceiverSource = mainLines[computedReceiverLine - 1]!;
        const computedReceiverScope = main.scopes.find(
          (scope) => scope.kind === 'Function' && scope.range.startLine === computedReceiverLine,
        )!;
        const computedReceiverBody = main.scopes.find(
          (scope) => scope.parent === computedReceiverScope.id && scope.kind === 'Block',
        )!;
        const computedReceiverCall = 'file.exportsByNamespace[space].get(name)';
        const computedReceiverStart = computedReceiverSource.indexOf(computedReceiverCall);
        expect(
          main.referenceSites
            .filter((site) => site.atRange.startLine === computedReceiverLine)
            .map(({ name, kind }) => [name, kind]),
        ).toEqual([
          ['get', 'call'],
          [undefined, 'read'],
          ['exportsByNamespace', 'read'],
          ['file', 'read'],
          ['space', 'read'],
          ['name', 'read'],
        ]);
        expect(
          main.referenceSites.find(
            (site) => site.atRange.startLine === computedReceiverLine && site.kind === 'call',
          ),
        ).toEqual({
          name: 'get',
          kind: 'call',
          callForm: 'member',
          arity: 1,
          explicitReceiver: { kind: 'unknown' },
          inScope: computedReceiverBody.id,
          atRange: {
            startLine: computedReceiverLine,
            startCol: computedReceiverStart,
            endLine: computedReceiverLine,
            endCol: computedReceiverStart + computedReceiverCall.length,
          },
        });
        const arrowInvocationLine = lineOf('function arrowInvocationOwner(');
        expect(
          main.referenceSites
            .filter((site) => site.atRange.startLine === arrowInvocationLine)
            .map(({ name, kind }) => [name, kind]),
        ).toEqual([
          ['helper', 'call'],
          ['parameter', 'read'],
          ['value', 'read'],
        ]);
        const optionalCallLine = lineOf('function optionalCallOwner(');
        const optionalCallSource = mainLines[optionalCallLine - 1]!;
        const optionalCallScope = main.scopes.find(
          (scope) => scope.kind === 'Function' && scope.range.startLine === optionalCallLine,
        )!;
        const optionalCallBody = main.scopes.find(
          (scope) => scope.parent === optionalCallScope.id && scope.kind === 'Block',
        )!;
        const optionalValueStart = optionalCallSource.indexOf('value?.');
        const optionalHelperStart = optionalCallSource.indexOf('helper(');
        const optionalArgStart = optionalCallSource.indexOf('arg', optionalHelperStart);
        const optionalRange = (startCol: number, length: number) => ({
          startLine: optionalCallLine,
          startCol,
          endLine: optionalCallLine,
          endCol: startCol + length,
        });
        expect(
          main.referenceSites
            .filter((site) => site.atRange.startLine === optionalCallLine)
            .map(({ name, kind, callForm, arity, explicitReceiver, inScope, atRange }) => ({
              name,
              kind,
              callForm,
              arity,
              explicitReceiver,
              inScope,
              atRange,
            })),
        ).toEqual([
          {
            name: 'trim',
            kind: 'call',
            callForm: 'member',
            arity: 1,
            explicitReceiver: { name: 'value' },
            inScope: optionalCallBody.id,
            atRange: optionalRange(optionalValueStart, 'value?.trim(helper(arg))'.length),
          },
          {
            name: 'value',
            kind: 'read',
            callForm: undefined,
            arity: undefined,
            explicitReceiver: undefined,
            inScope: optionalCallBody.id,
            atRange: optionalRange(optionalValueStart, 5),
          },
          {
            name: 'helper',
            kind: 'call',
            callForm: 'free',
            arity: 1,
            explicitReceiver: undefined,
            inScope: optionalCallBody.id,
            atRange: optionalRange(optionalHelperStart, 'helper(arg)'.length),
          },
          {
            name: 'arg',
            kind: 'read',
            callForm: undefined,
            arity: undefined,
            explicitReceiver: undefined,
            inScope: optionalCallBody.id,
            atRange: optionalRange(optionalArgStart, 3),
          },
        ]);
        const membershipLine = lineOf('function membershipOwner(');
        const membershipSource = mainLines[membershipLine - 1]!;
        const membershipScope = main.scopes.find(
          (scope) => scope.kind === 'Function' && scope.range.startLine === membershipLine,
        )!;
        const membershipBody = main.scopes.find(
          (scope) => scope.parent === membershipScope.id && scope.kind === 'Block',
        )!;
        const membershipKeyStart = membershipSource.indexOf('key in');
        const membershipCallStart = membershipSource.indexOf('helper(');
        const membershipRegistryStart = membershipSource.indexOf('registry', membershipCallStart);
        const membershipArgStart = membershipSource.indexOf('arg', membershipRegistryStart);
        const membershipRange = (startCol: number, length: number) => ({
          startLine: membershipLine,
          startCol,
          endLine: membershipLine,
          endCol: startCol + length,
        });
        expect(
          main.referenceSites
            .filter((site) => site.atRange.startLine === membershipLine)
            .map(({ name, kind, callForm, arity, explicitReceiver, inScope, atRange }) => ({
              name,
              kind,
              callForm,
              arity,
              explicitReceiver,
              inScope,
              atRange,
            })),
        ).toEqual([
          {
            name: 'key',
            kind: 'read',
            callForm: undefined,
            arity: undefined,
            explicitReceiver: undefined,
            inScope: membershipBody.id,
            atRange: membershipRange(membershipKeyStart, 3),
          },
          {
            name: 'helper',
            kind: 'call',
            callForm: 'free',
            arity: 2,
            explicitReceiver: undefined,
            inScope: membershipBody.id,
            atRange: membershipRange(membershipCallStart, 'helper(registry, arg)'.length),
          },
          {
            name: 'registry',
            kind: 'read',
            callForm: undefined,
            arity: undefined,
            explicitReceiver: undefined,
            inScope: membershipBody.id,
            atRange: membershipRange(membershipRegistryStart, 8),
          },
          {
            name: 'arg',
            kind: 'read',
            callForm: undefined,
            arity: undefined,
            explicitReceiver: undefined,
            inScope: membershipBody.id,
            atRange: membershipRange(membershipArgStart, 3),
          },
        ]);
        const spreadLine = lineOf('const spread =');
        expect(
          main.referenceSites
            .filter((site) => site.atRange.startLine === spreadLine)
            .map(({ name, kind, inScope }) => ({ name, kind, inScope })),
        ).toEqual([
          { name: 'closure', kind: 'read', inScope: capturedBody.id },
          { name: 'items', kind: 'read', inScope: capturedBody.id },
        ]);
        for (const [text, bindings] of [
          ['for (const [left, right]', ['left', 'right']],
          ['for (const { value: item }', ['item']],
        ] as const) {
          const line = lineOf(text);
          const loopScope = main.scopes.find(
            (scope) =>
              scope.kind === 'Block' &&
              scope.parent === capturedBody.id &&
              scope.range.startLine === line,
          )!;
          expect(loopScope).toBeDefined();
          expect([...loopScope.bindings.keys()].sort()).toEqual([...bindings].sort());
          const loopBody = main.scopes.find(
            (scope) => scope.parent === loopScope.id && scope.kind === 'Block',
          )!;
          expect(loopBody).toBeDefined();
          const sites = main.referenceSites.filter((site) => site.atRange.startLine === line);
          expect(sites).toContainEqual(
            expect.objectContaining({ name: 'items', kind: 'read', inScope: loopScope.id }),
          );
          for (const name of bindings) {
            expect(sites).toContainEqual(
              expect.objectContaining({ name, kind: 'read', inScope: loopBody.id }),
            );
            expect(capturedScope.bindings.has(name)).toBe(false);
            expect(capturedBody.bindings.has(name)).toBe(false);
          }
        }
        const methodScopes = [];
        for (const [text, parameters, reads] of [
          ['method(parameter)', ['parameter'], ['parameter', 'closure']],
          ['get value()', [], ['closure']],
        ] as const) {
          const line = lineOf(text);
          const methodScope = main.scopes.find(
            (scope) => scope.kind === 'Function' && scope.range.startLine === line,
          )!;
          expect(methodScope).toBeDefined();
          methodScopes.push(methodScope.id);
          expect(methodScope.parent).toBe(capturedBody.id);
          expect([...methodScope.bindings.keys()]).toEqual(parameters);
          const methodBody = main.scopes.find(
            (scope) => scope.parent === methodScope.id && scope.kind === 'Block',
          )!;
          expect(methodBody).toBeDefined();
          const sites = main.referenceSites.filter((site) => site.atRange.startLine === line);
          expect(sites.map(({ name, kind, inScope }) => ({ name, kind, inScope }))).toEqual([
            { name: 'helper', kind: 'call', inScope: methodBody.id },
            ...reads.map((name) => ({ name, kind: 'read', inScope: methodBody.id })),
          ]);
          expect(sites.find(({ name }) => name === 'helper')!.arity).toBe(reads.length);
          expect(methodScope.bindings.has('closure')).toBe(false);
        }
        const optionsLine = lineOf('function optionalOptions(');
        const optionsScope = main.scopes.find(
          (scope) => scope.kind === 'Function' && scope.range.startLine === optionsLine,
        )!;
        expect(optionsScope).toBeDefined();
        expect([...optionsScope.bindings.keys()]).toEqual(['first', 'second', 'options']);
        const optionsBody = main.scopes.find(
          (scope) => scope.parent === optionsScope.id && scope.kind === 'Block',
        )!;
        expect(optionsBody).toBeDefined();
        const optionsCall = main.referenceSites.find(
          (site) => site.atRange.startLine === optionsLine && site.kind === 'call',
        );
        expect(optionsCall).toMatchObject({ name: 'helper', arity: 2, inScope: optionsBody.id });
        const optionsCallsLine = lineOf('function optionalOptionsCalls(');
        const optionsCalls = main.referenceSites.filter(
          (site) => site.atRange.startLine === optionsCallsLine && site.name === 'optionalOptions',
        );
        expect(optionsCalls.map(({ kind, arity }) => ({ kind, arity }))).toEqual([
          { kind: 'call', arity: 2 },
          { kind: 'call', arity: 3 },
        ]);
        const optionalOptionsDef = main.localDefs.find(
          ({ qualifiedName }) => qualifiedName === 'optionalOptions',
        )!;
        expect(optionalOptionsDef).toMatchObject({ parameterCount: 3, requiredParameterCount: 2 });
        expect(
          persistedScopeOutput.relationships.filter(
            (edge) => edge.type === 'CALLS' && edge.targetId === optionalOptionsDef.nodeId,
          ),
        ).toHaveLength(2);
        const optionsMethodLine = lineOf('withOptions(first, second, options = {})');
        const optionsMethod = main.scopes.find(
          (scope) => scope.kind === 'Function' && scope.range.startLine === optionsMethodLine,
        )!;
        expect(optionsMethod).toBeDefined();
        expect(optionsMethod.parent).toBe(capturedBody.id);
        expect([...optionsMethod.bindings.keys()]).toEqual(['first', 'second', 'options']);
        const optionsMethodBody = main.scopes.find(
          (scope) => scope.parent === optionsMethod.id && scope.kind === 'Block',
        )!;
        expect(optionsMethodBody).toBeDefined();
        expect(
          main.referenceSites
            .filter((site) => site.atRange.startLine === optionsMethodLine)
            .map(({ name, kind, inScope, arity }) => ({ name, kind, inScope, arity })),
        ).toEqual([
          { name: 'helper', kind: 'call', inScope: optionsMethodBody.id, arity: 2 },
          { name: 'first', kind: 'read', inScope: optionsMethodBody.id, arity: undefined },
          { name: 'second', kind: 'read', inScope: optionsMethodBody.id, arity: undefined },
        ]);
        expect(new Set(methodScopes).size).toBe(2);
        const computedLine = lineOf('function computedSelections(');
        const computedSource = mainLines[computedLine - 1]!;
        const computedSites = main.referenceSites.filter(
          (site) => site.atRange.startLine === computedLine,
        );
        const computedSelections = computedSites.filter(
          (site) => site.selection?.kind === 'computed',
        );
        expect(computedSelections).toHaveLength(3);
        const rangeOf = (text: string, from = 0) => {
          const startCol = computedSource.indexOf(text, from);
          return {
            startLine: computedLine,
            startCol,
            endLine: computedLine,
            endCol: startCol + text.length,
          };
        };
        const firstSelectionStart = computedSource.indexOf('table[key]');
        const secondSelectionStart = computedSource.indexOf('table[indexes[key]]');
        const nestedSelectionStart = computedSource.indexOf('indexes[key]', secondSelectionStart);
        const computedScope = computedSelections[0]!.inScope;
        expect(computedSelections.every((site) => site.inScope === computedScope)).toBe(true);
        expect(
          computedSelections.map(({ atRange, selection }) => ({ atRange, selection })),
        ).toEqual([
          {
            atRange: rangeOf('table[key]', firstSelectionStart),
            selection: {
              kind: 'computed',
              objectRange: rangeOf('table', firstSelectionStart),
              indexRange: rangeOf('key', firstSelectionStart + 'table['.length),
            },
          },
          {
            atRange: rangeOf('table[indexes[key]]', secondSelectionStart),
            selection: {
              kind: 'computed',
              objectRange: rangeOf('table', secondSelectionStart),
              indexRange: rangeOf('indexes[key]', secondSelectionStart + 'table['.length),
            },
          },
          {
            atRange: rangeOf('indexes[key]', nestedSelectionStart),
            selection: {
              kind: 'computed',
              objectRange: rangeOf('indexes', nestedSelectionStart),
              indexRange: rangeOf('key', nestedSelectionStart + 'indexes['.length),
            },
          },
        ]);
        expect(computedSites.map((site) => site.selection?.kind ?? site.name)).toEqual([
          'computed',
          'table',
          'key',
          'computed',
          'table',
          'computed',
          'indexes',
          'key',
        ]);
        for (const site of computedSelections) expect(site).not.toHaveProperty('name');
        const computedOperands = computedSites.filter((site) => site.selection === undefined);
        expect(computedOperands.map(({ name, kind }) => ({ name, kind }))).toEqual([
          { name: 'table', kind: 'read' },
          { name: 'key', kind: 'read' },
          { name: 'table', kind: 'read' },
          { name: 'indexes', kind: 'read' },
          { name: 'key', kind: 'read' },
        ]);
        expect(computedOperands.every((site) => site.inScope === computedScope)).toBe(true);
        const persistedComputed = parsedFiles
          .find(({ filePath }) => filePath === `src/main.${extension}`)!
          .referenceSites.filter((site) => site.atRange.startLine === computedLine);
        expect(persistedComputed).toEqual(computedSites);
        const nestedLine =
          mainSource.split('\n').findIndex((line) => line.includes('function nestedRead')) + 1;
        const nestedSource = mainSource.split('\n')[nestedLine - 1]!;
        const rangeAt = (name: string, from = 0) => {
          const startCol = nestedSource.indexOf(name, from);
          return {
            startLine: nestedLine,
            startCol,
            endLine: nestedLine,
            endCol: startCol + name.length,
          };
        };
        const readStart = nestedSource.indexOf('return');
        const nestedSites = main.referenceSites.filter(
          (site) => site.atRange.startLine === nestedLine,
        );
        expect(nestedSites.map(({ atRange }) => atRange)).toEqual([
          rangeAt('owner.child.field', readStart),
          rangeAt('owner.child', readStart),
          rangeAt('owner', readStart),
        ]);
        expect(
          nestedSites.map(({ name, kind, explicitReceiver }) => ({ name, kind, explicitReceiver })),
        ).toEqual([
          {
            name: 'field',
            kind: 'read',
            explicitReceiver: {
              kind: 'chain',
              root: { name: 'owner', range: rangeAt('owner', readStart) },
              steps: [{ kind: 'member', name: 'child', range: rangeAt('child', readStart) }],
            },
          },
          { name: 'child', kind: 'read', explicitReceiver: { name: 'owner' } },
          { name: 'owner', kind: 'read', explicitReceiver: undefined },
        ]);
        const run = main.localDefs.find(({ qualifiedName }) => qualifiedName === 'run')!;
        expect(persistedScopeOutput.finalizeStats.linkedEdges).toBeGreaterThan(0);
        expect(persistedScopeOutput.relationships).toContainEqual(
          expect.objectContaining({
            type: 'IMPORTS',
            sourceId: main.moduleScope,
            targetId: util.moduleScope,
            confidence: 1,
          }),
        );
        for (const name of ['helper', 'other']) {
          const target = util.localDefs.find(({ qualifiedName }) => qualifiedName === name)!;
          expect(persistedScopeOutput.relationships).toContainEqual(
            expect.objectContaining({
              type: 'CALLS',
              sourceId: run.nodeId,
              targetId: target.nodeId,
            }),
          );
        }
        if (extension === 'ts') {
          const barrel = parsedFiles.find(({ filePath }) => filePath === 'src/barrel.ts')!;
          const consumer = parsedFiles.find(
            ({ filePath }) => filePath === 'src/barrel-consumer.ts',
          )!;
          const caller = consumer.localDefs.find(
            ({ qualifiedName }) => qualifiedName === 'viaBarrel',
          )!;
          const helper = util.localDefs.find(({ qualifiedName }) => qualifiedName === 'helper')!;
          expect(persistedScopeOutput.relationships).toContainEqual(
            expect.objectContaining({
              type: 'IMPORTS',
              sourceId: barrel.moduleScope,
              targetId: util.moduleScope,
              confidence: 1,
            }),
          );
          // Finalize uses static exports: the consumer's reexport chain remains unresolved.
          expect(persistedScopeOutput.unresolvedImports).toContainEqual({
            scopeId: consumer.moduleScope,
            localName: 'forwarded',
            linkStatus: 'unresolved',
            targetModuleScope: undefined,
          });
          expect(
            persistedScopeOutput.relationships.some(
              (edge) => edge.type === 'IMPORTS' && edge.sourceId === consumer.moduleScope,
            ),
          ).toBe(false);
          expect(persistedScopeOutput.relationships).not.toContainEqual(
            expect.objectContaining({
              type: 'CALLS',
              sourceId: caller.nodeId,
              targetId: helper.nodeId,
            }),
          );
        }
        if (mode === 'sequential') {
          const withoutImport = structuredClone(parsedFiles).map((file) =>
            file.filePath === main.filePath
              ? {
                  ...file,
                  parsedImports: file.parsedImports.filter(
                    ({ localName }) => localName !== 'helper',
                  ),
                }
              : file,
          );
          const removedImport = scopeSnapshot(withoutImport);
          const helper = util.localDefs.find(({ qualifiedName }) => qualifiedName === 'helper')!;
          expect(removedImport.relationships).not.toEqual(persistedScopeOutput.relationships);
          expect(
            removedImport.relationships.some(
              (edge) =>
                edge.type === 'CALLS' &&
                edge.sourceId === run.nodeId &&
                edge.targetId === helper.nodeId,
            ),
          ).toBe(false);
        }
      }
      scopeOutputs.set(mode, persistedScopeOutput);
      if (mode === 'sequential') {
        const changedRangeFiles = structuredClone(parsedFiles).map((file, index) =>
          index === 0
            ? {
                ...file,
                scopes: file.scopes.map((scope) =>
                  scope.id === file.moduleScope
                    ? { ...scope, range: { ...scope.range, endLine: scope.range.endLine + 1 } }
                    : scope,
                ),
              }
            : file,
        );
        const changedRange = scopeSnapshot(changedRangeFiles);
        expect(changedRange.nodes).not.toEqual(persistedScopeOutput.nodes);
        expect(changedRange.relationships).toEqual(persistedScopeOutput.relationships);
        expect(changedRange.finalizeStats).toEqual(persistedScopeOutput.finalizeStats);
        expect(changedRange.resolutionStats).toEqual(persistedScopeOutput.resolutionStats);
        expect(changedRange.emissionStats).toEqual(persistedScopeOutput.emissionStats);
        // Change real resolver inputs, retaining exact definition and relationship identities.
        const changedFiles = structuredClone(parsedFiles);
        const file = changedFiles.find(
          (candidate) =>
            candidate.localDefs.filter((def) => def.type === 'Function').length > 1 &&
            candidate.referenceSites.some(
              (site) =>
                site.kind === 'call' &&
                site.callForm === 'free' &&
                candidate.localDefs.some(
                  (def) =>
                    def.qualifiedName === site.name &&
                    persistedScopeOutput.relationships.some(
                      (edge) => edge.type === 'CALLS' && edge.targetId === def.nodeId,
                    ),
                ),
            ),
        );
        expect(file).toBeDefined();
        const siteIndex = file!.referenceSites.findIndex(
          (site) =>
            site.kind === 'call' &&
            site.callForm === 'free' &&
            file!.localDefs.some(
              (def) =>
                def.qualifiedName === site.name &&
                persistedScopeOutput.relationships.some(
                  (edge) => edge.type === 'CALLS' && edge.targetId === def.nodeId,
                ),
            ),
        );
        const site = file!.referenceSites[siteIndex]!;
        const replacement = file!.localDefs.find(
          (def) => def.type === 'Function' && def.qualifiedName !== site.name,
        )!;
        expect(replacement).toBeDefined();
        const changedTargetFiles = structuredClone(changedFiles);
        changedTargetFiles.find(({ filePath }) => filePath === file!.filePath)!.referenceSites[
          siteIndex
        ] = {
          ...site,
          name: replacement.qualifiedName,
          arity: undefined,
        };
        const changedTarget = scopeSnapshot(changedTargetFiles);
        expect(changedTarget.relationships).not.toEqual(persistedScopeOutput.relationships);
        expect(
          changedTarget.relationships.some(
            (edge) =>
              edge.type === 'CALLS' &&
              edge.targetId === replacement.nodeId &&
              !persistedScopeOutput.relationships.some((original) => original.id === edge.id),
          ),
        ).toBe(true);
        expect(changedTarget.resolutionStats.resolvedSites).toBe(
          persistedScopeOutput.resolutionStats.resolvedSites,
        );
        file!.referenceSites.splice(siteIndex, 1);
        const removedReference = scopeSnapshot(changedFiles);
        expect(removedReference.relationships).not.toEqual(persistedScopeOutput.relationships);
        expect(removedReference.resolutionStats.totalSites).toBe(
          persistedScopeOutput.resolutionStats.totalSites - 1,
        );
        expect(removedReference.emissionStats.edgesEmitted).toBe(
          persistedScopeOutput.emissionStats.edgesEmitted - 1,
        );
      }
      if (fixture.name === 'typescript') {
        const mixed = parsedFiles.find(({ filePath }) => filePath === 'src/mixed-types.tsx');
        expect(mixed).toBeDefined();
        expect(
          mixed!.localDefs.map(({ qualifiedName, type }) => ({ qualifiedName, type })),
        ).toEqual([
          { qualifiedName: 'Imported', type: 'TypeAlias' },
          { qualifiedName: 'ImportedPort', type: 'Interface' },
          { qualifiedName: 'count', type: 'Variable' },
          { qualifiedName: 'mixedEntry', type: 'Function' },
        ]);
        expect(mixed!.exports).toEqual(
          new Map(mixed!.localDefs.map((def) => [def.qualifiedName, def.nodeId])),
        );
        expect(mixed!.exportsByNamespace).toEqual({
          type: new Map(mixed!.localDefs.slice(0, 2).map((def) => [def.qualifiedName, def.nodeId])),
          value: new Map(mixed!.localDefs.slice(2).map((def) => [def.qualifiedName, def.nodeId])),
        });
        expect(mixed!.parsedImports).toEqual([
          { kind: 'named', localName: 'helper', importedName: 'helper', targetRaw: './util' },
          {
            kind: 'named',
            localName: 'T',
            importedName: 'T',
            targetRaw: './util',
            namespace: 'type',
          },
          {
            kind: 'alias',
            localName: 'Local',
            importedName: 'U',
            alias: 'Local',
            targetRaw: './util',
            namespace: 'type',
          },
        ]);
        expect(
          mixed!.referenceSites.map(({ name, kind, callForm }) => ({ name, kind, callForm })),
        ).toEqual([{ name: 'helper', kind: 'call', callForm: 'free' }]);
        expect(mixed!.scopes.some((scope) => scope.kind === 'Class')).toBe(true);
        expect([...mixed!.scopes[0]!.bindings]).toEqual(
          mixed!.localDefs.map((def) => [
            def.qualifiedName,
            [
              {
                def,
                origin: 'local',
                namespace: ['TypeAlias', 'Interface'].includes(def.type) ? 'type' : 'value',
              },
            ],
          ]),
        );
        for (const scope of mixed!.scopes) {
          expect([...scope.typeBindings]).toEqual([]);
          for (const name of ['Imported', 'ImportedPort']) {
            if (scope.kind !== 'Module') expect(scope.bindings.has(name)).toBe(false);
          }
        }
        expect(
          mixed!.scopes
            .flatMap((scope) => scope.ownedDefs)
            .sort((left, right) => left.nodeId.localeCompare(right.nodeId)),
        ).toEqual(
          [...mixed!.localDefs].sort((left, right) => left.nodeId.localeCompare(right.nodeId)),
        );
        const barrel = parsedFiles.find(({ filePath }) => filePath === 'src/barrel.ts');
        expect(barrel).toBeDefined();
        expect(barrel!.parsedImports).toEqual([
          {
            kind: 'reexport',
            localName: 'forwarded',
            importedName: 'helper',
            alias: 'forwarded',
            targetRaw: './util',
          },
          {
            kind: 'reexport',
            localName: 'Site',
            importedName: 'ReferenceSite',
            alias: 'Site',
            targetRaw: './reference-site',
            namespace: 'type',
          },
        ]);
        expect(barrel!.localDefs).toEqual([]);
        expect(barrel!.exports).toEqual(new Map());
        expect(barrel!.exportsByNamespace).toEqual({ type: new Map(), value: new Map() });
        expect(barrel!.referenceSites).toEqual([]);
        expect(barrel!.scopes).toHaveLength(1);
        expect([...barrel!.scopes[0]!.bindings]).toEqual([]);
        expect([...barrel!.scopes[0]!.typeBindings]).toEqual([]);
        const consumer = parsedFiles.find(({ filePath }) => filePath === 'src/barrel-consumer.ts');
        expect(consumer).toBeDefined();
        expect(consumer!.parsedImports).toEqual([
          {
            kind: 'named',
            localName: 'forwarded',
            importedName: 'forwarded',
            targetRaw: './barrel',
          },
        ]);
        const enumFile = parsedFiles.find(({ filePath }) => filePath === 'src/string-enum.ts');
        expect(enumFile).toBeDefined();
        expect(enumFile!.localDefs).toEqual([
          {
            nodeId: 'def:src/string-enum.ts#1:7:Enum:Status',
            filePath: 'src/string-enum.ts',
            type: 'Enum',
            qualifiedName: 'Status',
          },
        ]);
        const enumDef = enumFile!.localDefs[0]!;
        expect(enumFile!.scopes).toHaveLength(1);
        expect(enumFile!.scopes[0]!.bindings.get('Status')).toEqual([
          { def: enumDef, origin: 'local', namespace: 'both' },
        ]);
        expect(enumFile!.exports).toEqual(new Map([['Status', enumDef.nodeId]]));
        expect(enumFile!.exportsByNamespace).toEqual({
          type: new Map([['Status', enumDef.nodeId]]),
          value: new Map([['Status', enumDef.nodeId]]),
        });
        expect(enumFile!.referenceSites).toEqual([]);
        const enumFileNodes = declarationNodes.filter(
          ({ properties }) => properties.filePath === 'src/string-enum.ts',
        );
        expect(enumFileNodes.map(({ label }) => label).sort()).toEqual(['Enum', 'File']);
        const graphEnum = enumFileNodes.filter(({ label }) => label === 'Enum');
        expect(graphEnum).toHaveLength(1);
        expect(graphEnum[0]).toMatchObject({ label: 'Enum', properties: { name: 'Status' } });
        expect(graphEnum[0]!.id).not.toBe(enumDef.nodeId);
        expect(events).toContainEqual(
          expect.objectContaining({
            kind: 'symbol.add',
            filePath: 'src/string-enum.ts',
            name: 'Status',
            nodeId: graphEnum[0]!.id,
          }),
        );
        expect(producer!.nodes).toContainEqual(graphEnum[0]);
        for (const [filePath, scopeCount, definitions] of [
          [
            'src/resolution.ts',
            3,
            [
              ['TypeResolver', 'Interface'],
              ['CallResolver', 'Interface'],
            ],
          ],
          [
            'src/backend-port.ts',
            3,
            [
              ['BackendPort', 'Interface'],
              ['GroupBackendPort', 'Interface'],
            ],
          ],
          [
            'src/reference-site.tsx',
            2,
            [
              ['ReferenceKind', 'TypeAlias'],
              ['ReferenceSite', 'Interface'],
            ],
          ],
          [
            'src/ordinary-types.tsx',
            2,
            [
              ['Imported', 'TypeAlias'],
              ['ImportedPort', 'Interface'],
            ],
          ],
        ] as const) {
          const parsed = parsedFiles.find((file) => file.filePath === filePath);
          expect(parsed).toBeDefined();
          expect(parsed!.scopes).toHaveLength(scopeCount);
          expect(parsed!.localDefs.map(({ qualifiedName, type }) => [qualifiedName, type])).toEqual(
            definitions,
          );
          expect([...parsed!.scopes[0]!.bindings]).toEqual(
            parsed!.localDefs.map((def) => [
              def.qualifiedName,
              [{ def, origin: 'local', namespace: 'type' }],
            ]),
          );
          expect(parsed!.scopes.slice(1).map((scope) => [...scope.bindings])).toEqual(
            Array.from({ length: scopeCount - 1 }, () => []),
          );
          expect(parsed!.scopes.every((scope) => scope.typeBindings.size === 0)).toBe(true);
          expect(parsed!.scopes.flatMap((scope) => scope.ownedDefs)).toEqual(parsed!.localDefs);
          expect(parsed!.parsedImports).toEqual(
            filePath === 'src/ordinary-types.tsx'
              ? [
                  {
                    kind: 'alias',
                    localName: 'Main',
                    importedName: 'default',
                    alias: 'Main',
                    targetRaw: './util',
                  },
                  {
                    kind: 'named',
                    localName: 'helper',
                    importedName: 'helper',
                    targetRaw: './util',
                  },
                  {
                    kind: 'alias',
                    localName: 'Renamed',
                    importedName: 'other',
                    alias: 'Renamed',
                    targetRaw: './util',
                  },
                  {
                    kind: 'named',
                    localName: 'T',
                    importedName: 'T',
                    targetRaw: './util',
                    namespace: 'type',
                  },
                  {
                    kind: 'alias',
                    localName: 'Local',
                    importedName: 'U',
                    alias: 'Local',
                    targetRaw: './util',
                    namespace: 'type',
                  },
                  {
                    kind: 'namespace',
                    localName: 'util',
                    importedName: './util',
                    targetRaw: './util',
                  },
                  {
                    kind: 'named',
                    localName: 'ReferenceSite',
                    importedName: 'ReferenceSite',
                    targetRaw: './reference-site',
                    namespace: 'type',
                  },
                ]
              : filePath === 'src/reference-site.tsx'
                ? [
                    {
                      kind: 'named',
                      localName: 'Range',
                      importedName: 'Range',
                      targetRaw: './types.js',
                      namespace: 'type',
                    },
                    {
                      kind: 'named',
                      localName: 'ScopeId',
                      importedName: 'ScopeId',
                      targetRaw: './types.js',
                      namespace: 'type',
                    },
                  ]
                : [],
          );
          const exports = new Map(parsed!.localDefs.map((def) => [def.qualifiedName, def.nodeId]));
          expect(parsed!.exports).toEqual(exports);
          expect(parsed!.exportsByNamespace).toEqual({ type: exports, value: new Map() });
          expect(parsed!.referenceSites).toEqual([]);
        }
        const loops = parsedFiles.find((file) => file.filePath === 'src/ns.ts');
        const main = parsedFiles.find((file) => file.filePath === 'src/main.ts')!;
        const assignmentLine =
          fixture.files['src/main.ts']!.split('\n').findIndex((line) =>
            line.startsWith('function assignment('),
          ) + 1;
        const assignmentSource = fixture.files['src/main.ts']!.split('\n')[assignmentLine - 1]!;
        const assignment = main.scopes.find(
          (scope) => scope.kind === 'Function' && scope.range.startLine === assignmentLine,
        )!;
        expect(assignment).toBeDefined();
        const assignmentBody = main.scopes.find((scope) => scope.parent === assignment.id)!;
        expect(assignmentBody.kind).toBe('Block');
        const assignmentWriteColumn = assignmentSource.indexOf(
          'value',
          assignmentSource.indexOf('{'),
        );
        const assignmentReadColumn = assignmentSource.indexOf(
          'value',
          assignmentSource.indexOf('=') + 1,
        );
        expect(
          main.referenceSites.filter((site) => site.atRange.startLine === assignmentLine),
        ).toEqual([
          {
            name: 'value',
            kind: 'write',
            inScope: assignmentBody.id,
            atRange: {
              startLine: assignmentLine,
              startCol: assignmentWriteColumn,
              endLine: assignmentLine,
              endCol: assignmentWriteColumn + 5,
            },
          },
          {
            name: 'value',
            kind: 'read',
            inScope: assignmentBody.id,
            atRange: {
              startLine: assignmentLine,
              startCol: assignmentReadColumn,
              endLine: assignmentLine,
              endCol: assignmentReadColumn + 5,
            },
          },
        ]);
        // Exercise persisted artifacts explicitly; pipeline replay does not invoke this resolver.
        const assignmentTarget = assignment.ownedDefs.find((def) => def.qualifiedName === 'value')!;
        const assignmentCaller = assignment.ownedDefs.find(
          (def) => def.qualifiedName === 'assignment',
        )!;
        expect(assignmentTarget).toBeDefined();
        expect(assignmentCaller).toBeDefined();
        const indexes = finalizeScopeModel(parsedFiles);
        const resolved = resolveReferences(indexes);
        const assignmentReferences = resolved.referenceIndex.bySourceScope.get(assignmentBody.id)!;
        expect(assignmentReferences).toEqual([
          expect.objectContaining({
            kind: 'write',
            toDef: assignmentTarget.nodeId,
            atRange: {
              startLine: assignmentLine,
              startCol: assignmentWriteColumn,
              endLine: assignmentLine,
              endCol: assignmentWriteColumn + 5,
            },
          }),
          expect.objectContaining({
            kind: 'read',
            toDef: assignmentTarget.nodeId,
            atRange: {
              startLine: assignmentLine,
              startCol: assignmentReadColumn,
              endLine: assignmentLine,
              endCol: assignmentReadColumn + 5,
            },
          }),
        ]);
        expect(resolved.referenceIndex.byTargetDef.get(assignmentTarget.nodeId)).toEqual(
          assignmentReferences,
        );
        const assignmentGraph = createKnowledgeGraph();
        emitReferencesToGraph({
          graph: assignmentGraph,
          scopes: indexes,
          referenceIndex: resolved.referenceIndex,
        });
        const accessEdges = assignmentGraph.relationships.filter(
          (edge) => edge.sourceId === assignmentCaller.nodeId,
        );
        expect(accessEdges).toEqual(
          assignmentReferences.map((reference) => ({
            id: `rel:ACCESSES:${assignmentCaller.nodeId}->${assignmentTarget.nodeId}:${assignmentLine}:${reference.atRange.startCol}:${reference.kind}`,
            sourceId: assignmentCaller.nodeId,
            targetId: assignmentTarget.nodeId,
            type: 'ACCESSES',
            step: reference.kind === 'write' ? 2 : 1,
            confidence: reference.confidence,
            evidence: reference.evidence,
            reason: `scope-resolution: ${reference.kind} | confidence ${reference.confidence.toFixed(3)}`,
          })),
        );
        emitReferencesToGraph({
          graph: assignmentGraph,
          scopes: indexes,
          referenceIndex: resolved.referenceIndex,
        });
        expect(
          assignmentGraph.relationships.filter((edge) => edge.sourceId === assignmentCaller.nodeId),
        ).toEqual(accessEdges);
        const conditional = main.scopes.find(
          (scope) => scope.kind === 'Function' && scope.range.startLine === 4,
        )!;
        expect(conditional).toBeDefined();
        const conditionalBlocks = main.scopes.filter((scope) => scope.parent === conditional.id);
        expect(conditionalBlocks).toHaveLength(1);
        const conditionalBody = conditionalBlocks[0]!;
        expect(conditionalBody.kind).toBe('Block');
        const conditionalSource = fixture.files['src/main.ts']!.split('\n')[3]!;
        expect(conditionalBody.range).toEqual({
          startLine: 4,
          startCol: conditionalSource.indexOf('{'),
          endLine: 4,
          endCol: conditionalSource.length,
        });
        expect(
          main.referenceSites
            .filter((site) => site.atRange.startLine === 4)
            .map(({ name, kind, inScope }) => ({ name, kind, inScope })),
        ).toEqual([
          { name: 'value', kind: 'read', inScope: conditionalBody.id },
          { name: 'helper', kind: 'call', inScope: conditionalBody.id },
          { name: 'value', kind: 'read', inScope: conditionalBody.id },
          { name: 'helper', kind: 'call', inScope: conditionalBody.id },
          { name: 'value', kind: 'read', inScope: conditionalBody.id },
          { name: 'renamed', kind: 'call', inScope: conditionalBody.id },
          { name: 'value', kind: 'read', inScope: conditionalBody.id },
          { name: 'helper', kind: 'call', inScope: conditionalBody.id },
          { name: 'value', kind: 'read', inScope: conditionalBody.id },
          { name: 'undefined', kind: 'read', inScope: conditionalBody.id },
          { name: 'renamed', kind: 'call', inScope: conditionalBody.id },
        ]);
        const undefinedColumn = conditionalSource.indexOf('undefined');
        expect(main.referenceSites.find((site) => site.name === 'undefined')).toEqual({
          name: 'undefined',
          kind: 'read',
          inScope: conditionalBody.id,
          atRange: {
            startLine: 4,
            startCol: undefinedColumn,
            endLine: 4,
            endCol: undefinedColumn + 'undefined'.length,
          },
        });
        expect(main.scopes.filter((scope) => scope.parent === conditionalBody.id)).toEqual([]);
        const memberRead = main.referenceSites.find(
          (site) => site.kind === 'read' && site.name === 'field',
        );
        expect(memberRead).toMatchObject({
          name: 'field',
          kind: 'read',
          explicitReceiver: { name: 'owner' },
        });
        const memberIndex = main.referenceSites.indexOf(memberRead!);
        expect(main.referenceSites[memberIndex + 1]).toMatchObject({
          name: 'owner',
          kind: 'read',
          inScope: memberRead!.inScope,
        });
        expect(loops).toBeDefined();
        expect(loops!.localDefs.map(({ qualifiedName }) => qualifiedName)).toContain(
          'loopBindings',
        );
        expect(loops!.referenceSites.map(({ name, kind }) => [name, kind])).toEqual([
          ['helper', 'call'],
          ['util', 'read'],
          ['items', 'read'],
          ['use', 'call'],
          ['item', 'read'],
          ['object', 'read'],
          ['use', 'call'],
          ['key', 'read'],
          ['items', 'read'],
          ['item', 'read'],
          ['helper', 'call'],
          ['util', 'read'],
          ['helper', 'call'],
          ['util', 'read'],
        ]);
        const loopScopes = loops!.scopes.filter(
          (scope) => scope.bindings.has('item') || scope.bindings.has('key'),
        );
        expect(loopScopes.map((scope) => [...scope.bindings.keys()])).toEqual([
          ['item'],
          ['key'],
          ['item'],
        ]);
        const continued = loops!.scopes.find(
          (scope) => scope.kind === 'Function' && scope.range.startLine === 9,
        )!;
        const continuedBody = loops!.scopes.find((scope) => scope.parent === continued.id)!;
        const continuedLoop = loopScopes[2]!;
        const continuedLoopBody = loops!.scopes.find((scope) => scope.parent === continuedLoop.id)!;
        expect(continuedLoop.parent).toBe(continuedBody.id);
        expect(loops!.referenceSites.filter((site) => site.atRange.startLine >= 10)).toEqual([
          {
            name: 'items',
            kind: 'read',
            inScope: continuedLoop.id,
            atRange: { startLine: 10, startCol: 21, endLine: 10, endCol: 26 },
          },
          {
            name: 'item',
            kind: 'read',
            inScope: continuedLoopBody.id,
            atRange: { startLine: 10, startCol: 34, endLine: 10, endCol: 38 },
          },
          {
            name: 'helper',
            kind: 'call',
            callForm: 'member',
            arity: 0,
            explicitReceiver: { name: 'util' },
            inScope: continuedLoopBody.id,
            atRange: { startLine: 10, startCol: 50, endLine: 10, endCol: 63 },
          },
          {
            name: 'util',
            kind: 'read',
            inScope: continuedLoopBody.id,
            atRange: { startLine: 10, startCol: 50, endLine: 10, endCol: 54 },
          },
          {
            name: 'helper',
            kind: 'call',
            callForm: 'member',
            arity: 0,
            explicitReceiver: { name: 'util' },
            inScope: continuedBody.id,
            atRange: { startLine: 11, startCol: 2, endLine: 11, endCol: 15 },
          },
          {
            name: 'util',
            kind: 'read',
            inScope: continuedBody.id,
            atRange: { startLine: 11, startCol: 2, endLine: 11, endCol: 6 },
          },
        ]);
      }
      let replaySnapshot: ReturnType<typeof snapshot> | undefined;
      expect(new Set(parsedFiles.map(({ filePath }) => filePath)).size).toBeGreaterThan(1);
      expect(events.length).toBeGreaterThan(0);
      if (fixture.refused) {
        expect(parsedFiles.some(({ filePath }) => filePath === 'src/refused.py')).toBe(false);
        expect(calls).toContainEqual(
          expect.objectContaining({
            filePath: 'src/refused.py',
            calledName: 'legacyTarget',
          }),
        );
        expect(declarationNodes).toContainEqual(
          expect.objectContaining({
            properties: expect.objectContaining({
              filePath: 'src/refused.py',
              name: 'legacyTarget',
            }),
          }),
        );
        expect(events).toContainEqual(
          expect.objectContaining({
            kind: 'symbol.add',
            filePath: 'src/refused.py',
            name: 'legacyTarget',
          }),
        );
      }
      expect(importStates).toHaveLength(1);
      expect(parsedFiles[0]!.scopes[0]!.bindings).toBeInstanceOf(Map);
      const replay = createKnowledgeGraph();
      const { resolutionContext: context, bindingAccumulator: bindings } =
        await reconstructScopeRetentionParse(families, replay);
      try {
        expect(replay.relationships.some((edge) => edge.type === 'CALLS')).toBe(true);
        replaySnapshot = snapshot(replay);
        expect(replaySnapshot).toEqual(producer);
        await executePageRank(
          {
            graph: replay,
            repoPath: directory,
            onProgress: () => {},
            pipelineStart: Date.now(),
          },
          new Map(),
        );
        expect(snapshot(replay)).toEqual(rankedProducer);
        const scoredNodes = rankedProducer!.nodes.filter(
          ({ properties }) => properties.importance !== undefined,
        );
        expect(scoredNodes.length).toBeGreaterThan(0);
        for (const { properties } of scoredNodes) {
          expect(Number.isFinite(properties.importance)).toBe(true);
          expect(properties.importance).toBeGreaterThan(0);
        }
        expect(
          scoredNodes.some(
            (node) =>
              beforePageRank!.nodes.find(({ id }) => id === node.id)?.properties.importance ===
              undefined,
          ),
        ).toBe(true);
        rankedProducers.set(mode, rankedProducer!);
      } finally {
        context.clear();
        bindings.dispose();
      }
      expect(producer!.relationships.some((edge) => edge.type === 'CALLS')).toBe(true);
      expect(replaySnapshot).toEqual(producer);
      producers.set(mode, producer!);
      if (mode === 'sequential') {
        await expect(
          loadPersistedReplayFamilies(generationDirectory!, {
            ...expected!,
            identity: { ...expected!.identity, targetCommit: 'wrong-identity' },
          }),
        ).rejects.toThrow();
        const callsPath = path.join(
          generationDirectory!,
          'scope-retention-candidate',
          'calls.jsonl',
        );
        fs.appendFileSync(callsPath, '{}\n');
        await expect(
          loadPersistedReplayFamilies(generationDirectory!, expected!),
        ).rejects.toThrow();
      }
    },
    90_000,
  );

  it('complete snapshots detect changes to existing node and relationship facts', () => {
    const producer = producers.get('sequential')!;
    expect(producer).toBeDefined();
    const changedNode = structuredClone(producer);
    const node = changedNode.nodes.find(({ properties }) => typeof properties.name === 'string');
    expect(node).toBeDefined();
    node!.properties.name += '-changed';
    expect(snapshot(changedNode as KnowledgeGraph)).not.toEqual(producer);

    const structuralIndex = producer.relationships.findIndex((edge) => edge.type === 'CONTAINS');
    expect(structuralIndex).toBeGreaterThanOrEqual(0);
    const removedRelationship = structuredClone(producer);
    removedRelationship.relationships.splice(structuralIndex, 1);
    expect(snapshot(removedRelationship as KnowledgeGraph)).not.toEqual(producer);

    const changedRelationship = structuredClone(producer);
    changedRelationship.relationships[structuralIndex]!.reason += '-changed';
    expect(snapshot(changedRelationship as KnowledgeGraph)).not.toEqual(producer);

    const rankedProducer = rankedProducers.get('sequential')!;
    expect(rankedProducer).toBeDefined();
    const removedImportance = structuredClone(rankedProducer);
    const scoredNode = removedImportance.nodes.find(
      ({ properties }) => properties.importance !== undefined,
    );
    expect(scoredNode).toBeDefined();
    delete scoredNode!.properties.importance;
    expect(snapshot(removedImportance as KnowledgeGraph)).not.toEqual(rankedProducer);
  });

  it('sequential, worker and recovery producers agree', () => {
    expect(scopeOutputs.size).toBe(3);
    expect(scopeOutputs.get('worker')).toEqual(scopeOutputs.get('sequential'));
    expect(scopeOutputs.get('recovery')).toEqual(scopeOutputs.get('sequential'));
    expect(producers.size).toBe(3);
    expect(producers.get('worker')).toEqual(producers.get('sequential'));
    expect(producers.get('recovery')).toEqual(producers.get('sequential'));
    expect(rankedProducers.size).toBe(3);
    expectRankedSnapshotsEqual(rankedProducers.get('worker')!, rankedProducers.get('sequential')!);
    expectRankedSnapshotsEqual(
      rankedProducers.get('recovery')!,
      rankedProducers.get('sequential')!,
    );
    expect(coverageByMode.size).toBe(3);
    expect(coverageByMode.get('worker')).toEqual(coverageByMode.get('sequential'));
    expect(coverageByMode.get('recovery')).toEqual(coverageByMode.get('sequential'));
    const targets = producers
      .get('sequential')!
      .relationships.filter((edge) => edge.type === 'CALLS')
      .map((edge) => edge.targetId);
    for (const name of fixture.targets) {
      expect(
        targets.some((id: string) => id.endsWith(`:${name}`)),
        `expected call to ${name}`,
      ).toBe(true);
    }
    expect(targets.some((id: string) => id.endsWith(':missing'))).toBe(false);
  });

  it('ranked comparison accepts roundoff but rejects score and graph defects', () => {
    const ranked = rankedProducers.get('sequential')!;
    expect(ranked).toBeDefined();
    const index = ranked.nodes.findIndex(({ properties }) => properties.importance !== undefined);
    expect(index).toBeGreaterThanOrEqual(0);
    const rounded = structuredClone(ranked);
    rounded.nodes[index]!.properties.importance! += 7e-18;
    expect(() => expectRankedSnapshotsEqual(rounded, ranked)).not.toThrow();
    for (const importance of [
      undefined,
      NaN,
      Infinity,
      -Infinity,
      ranked.nodes[index]!.properties.importance! + 1e-8,
    ]) {
      const changed = structuredClone(ranked);
      if (importance === undefined) delete changed.nodes[index]!.properties.importance;
      else changed.nodes[index]!.properties.importance = importance;
      expect(() => expectRankedSnapshotsEqual(changed, ranked)).toThrow();
      expect(() => expectRankedSnapshotsEqual(ranked, changed)).toThrow();
    }
    const changedNode = structuredClone(ranked);
    changedNode.nodes[index]!.properties.name += '-changed';
    expect(() => expectRankedSnapshotsEqual(changedNode, ranked)).toThrow();
    const changedEdge = structuredClone(ranked);
    expect(changedEdge.relationships.length).toBeGreaterThan(0);
    changedEdge.relationships[0]!.reason += '-changed';
    expect(() => expectRankedSnapshotsEqual(changedEdge, ranked)).toThrow();
  });
});

// Supply the physical shared-package root containing the frozen src/ and configs.
// This qualifies only the admitted subset; Git history and graph-summary phases are excluded.
it.skipIf(!process.env.ONTOINDEX_FROZEN_PARITY_ROOT)(
  'frozen accepted TypeScript subset replays through production pipeline',
  async () => {
    const directories: string[] = [];
    const request = () => ({
      deadline: Date.now() + 60_000,
      artifactAllowance: { remainingBytes: 64 * 1024 * 1024 },
    });
    const temporaryDirectory = () => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ontoindex-frozen-parity-'));
      directories.push(directory);
      return directory;
    };
    const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
    try {
      const evidenceDirectory = path.resolve(
        __dirname,
        '../../../eval/results/ontoindex-shared-pair-87x1w40f',
      );
      const manifestBytes = fs.readFileSync(path.join(evidenceDirectory, 'input.json'));
      const classificationBytes = fs.readFileSync(
        path.join(evidenceDirectory, 'capture-classification-60.json'),
      );
      const manifest: {
        snapshotCommit: string;
        files: Array<{ path: string; sha256: string; bytes: number }>;
      } = JSON.parse(manifestBytes.toString('utf8'));
      const classification: {
        inputSha256: string;
        fixtureCommit: string;
        verifiedSourceFiles: number;
        accepted: number;
        refused: number;
        records: Array<{ path: string; status: 'accepted' | 'refused'; reason?: string }>;
      } = JSON.parse(classificationBytes.toString('utf8'));
      const manifestDigest = sha256(manifestBytes);
      expect(manifestDigest).toBe(classification.inputSha256);
      expect(classification.fixtureCommit).toBe(manifest.snapshotCommit);
      expect(classification).toMatchObject({ verifiedSourceFiles: 43, accepted: 41, refused: 0 });
      expect(manifest.files).toHaveLength(43);
      const root = fs.realpathSync(process.env.ONTOINDEX_FROZEN_PARITY_ROOT!);
      const verified = new Map<string, Buffer>();
      for (const file of manifest.files) {
        expect(file.path.length).toBeGreaterThan(0);
        expect(path.isAbsolute(file.path) || path.win32.isAbsolute(file.path)).toBe(false);
        expect(/[\\\u0000-\u001f\u007f]/.test(file.path)).toBe(false);
        expect(file.path.split('/').some((part) => !part || part === '.' || part === '..')).toBe(
          false,
        );
        expect(verified.has(file.path), file.path).toBe(false);
        const filename = path.join(root, file.path);
        // Reject symlink escapes as well as lexical traversal before reading frozen bytes.
        expect(fs.realpathSync(filename)).toBe(filename);
        expect(fs.lstatSync(filename).isFile()).toBe(true);
        const bytes = fs.readFileSync(filename);
        expect(bytes.length, file.path).toBe(file.bytes);
        expect(sha256(bytes), file.path).toBe(file.sha256);
        verified.set(file.path, bytes);
      }
      const sources = manifest.files.filter((file) => file.path.endsWith('.ts'));
      expect(sources).toHaveLength(41);
      expect(
        manifest.files
          .filter((file) => !file.path.endsWith('.ts'))
          .map((file) => file.path)
          .sort(),
      ).toEqual(['package.json', 'tsconfig.json']);
      expect(classification.records).toHaveLength(41);
      expect(new Set(classification.records.map((record) => record.path)).size).toBe(41);
      expect(classification.records.map((record) => record.path).sort()).toEqual(
        sources.map((file) => file.path).sort(),
      );
      expect(
        classification.records.every(
          (record) => record.status === 'accepted' || record.status === 'refused',
        ),
      ).toBe(true);
      const accepted = classification.records.filter((record) => record.status === 'accepted');
      const refused = classification.records.filter((record) => record.status === 'refused');
      expect(accepted).toHaveLength(41);
      expect(refused).toHaveLength(0);

      const { workspaceParserIdentity } =
        await import('../../src/core/tree-sitter/parser-identity.js');
      const parserCodeIdentity = await workspaceParserIdentity();
      const { createParserForLanguage } =
        await import('../../src/core/tree-sitter/parser-loader.js');
      const { SupportedLanguages } = await import('ontoindex-shared');
      const { emitTypeScriptCaptures } =
        await import('../../src/core/ingestion/languages/typescript-captures.js');
      const { ScopeUnsupportedSyntaxError } =
        await import('../../src/core/ingestion/scope-unsupported-syntax.js');
      for (const record of refused) {
        // Retention-record refusals pass the emitter but exceed the codec record cap.
        if (record.reason?.startsWith('retention record rejected')) continue;
        const parser = await createParserForLanguage(SupportedLanguages.TypeScript, record.path);
        const tree = parser.parse(verified.get(record.path)!.toString('utf8'));
        expect(() => emitTypeScriptCaptures(tree.rootNode), record.path).toThrow(
          ScopeUnsupportedSyntaxError,
        );
      }

      const repository = temporaryDirectory();
      const subsetPaths = [
        ...accepted.map((record) => record.path),
        'package.json',
        'tsconfig.json',
      ].sort();
      for (const filePath of subsetPaths) {
        const filename = path.join(repository, filePath);
        fs.mkdirSync(path.dirname(filename), { recursive: true });
        fs.writeFileSync(filename, verified.get(filePath)!);
      }
      for (const record of refused)
        expect(fs.existsSync(path.join(repository, record.path))).toBe(false);
      const subsetManifest = manifest.files.filter((file) => subsetPaths.includes(file.path));
      const identity = {
        sourceManifestDigest: sha256(JSON.stringify(subsetManifest)),
        targetCommit: manifest.snapshotCommit,
        baseGenerationId: null,
      };
      const expectedSources = sources
        .filter((file) => accepted.some((record) => record.path === file.path))
        .map((file) => ({ filePath: file.path, sha256: file.sha256, byteLength: file.bytes }))
        .sort((left, right) => left.filePath.localeCompare(right.filePath));
      const { loadScopeRetentionCandidate } =
        await import('../../src/core/ingestion/pipeline-phases/scope-retention-candidate-reader.js');
      const { copyScopeRetentionCandidate } =
        await import('../../src/core/ingestion/pipeline-phases/scope-retention-candidate.js');
      const parseImplementation =
        await import('../../src/core/ingestion/pipeline-phases/parse-impl.js');
      const results: Array<Record<string, unknown>> = [];
      for (const registryPrimary of ['0', '1']) {
        vi.stubEnv('REGISTRY_PRIMARY_TYPESCRIPT', registryPrimary);
        vi.stubEnv('INGESTION_EMIT_SCOPES', '0');
        const generation = temporaryDirectory();
        const expected = { identity, parserCodeIdentity };
        let consumed = false;
        let coverage: ReturnType<typeof summarizeScopeRetentionCoverage> | undefined;
        const full = await runPipelineFromRepo(repository, () => {}, {
          profile: 'full',
          skipGraphPhases: true,
          skipWorkers: true,
          capturedWorkspace: { captureRoot: repository, canonicalRepoPath: repository },
          scopeRetention: {
            ...request(),
            consume: async (handle) => {
              consumed = true;
              expect(
                [...handle.inventory].sort((left, right) =>
                  left.filePath.localeCompare(right.filePath),
                ),
              ).toEqual(
                accepted
                  .map((record) => ({ filePath: record.path, status: 'retained' }))
                  .sort((left, right) => left.filePath.localeCompare(right.filePath)),
              );
              coverage = summarizeScopeRetentionCoverage(handle.inventory);
              expect(coverage).toEqual({
                version: 1,
                complete: true,
                languages: [
                  {
                    language: 'typescript',
                    files: accepted.length,
                    retained: accepted.length,
                    skipped: 0,
                    refused: 0,
                    unaccounted: 0,
                    unparsed: 0,
                    refusalReasons: [],
                  },
                ],
              });
              expect(handle.inputEvidence.complete).toBe(true);
              expect(handle.inputEvidence.reasons).toEqual([]);
              expect(handle.inputEvidence.configuration?.complete).toBe(true);
              expect(handle.inputEvidence.parserCodeIdentity).toBe(parserCodeIdentity);
              expect(
                [...handle.inputEvidence.sources].sort((left, right) =>
                  left.filePath.localeCompare(right.filePath),
                ),
              ).toEqual(expectedSources);
              expect(handle.graphNodesCaptured).toBe(true);
              expect(handle.graphRelationshipsCaptured).toBe(true);
              const candidateManifest = await persistScopeRetentionCandidate(
                handle,
                generation,
                identity,
                request(),
              );
              expect(await verifyScopeRetentionCandidate(generation, expected, request())).toEqual(
                candidateManifest,
              );
            },
          },
        });
        expect(consumed).toBe(true);
        expect(full.parseMode).toBe('full');
        expect(full.usedWorkerPool).toBe(false);
        const candidate = await loadScopeRetentionCandidate(generation, expected, request());
        expect(candidate.families.parsedFiles).toHaveLength(accepted.length);
        expect(candidate.families.calls.length).toBeGreaterThan(0);
        const promotedGeneration = temporaryDirectory();
        const preserve = vi.fn(async () => {
          await copyScopeRetentionCandidate(generation, promotedGeneration, expected, request());
        });
        const parser = vi.spyOn(parseImplementation, 'runChunkedParseAndResolve');
        let replay: Awaited<ReturnType<typeof runPipelineFromRepo>>;
        try {
          replay = await runPipelineFromRepo(repository, () => {}, {
            profile: 'full',
            skipGraphPhases: true,
            skipWorkers: true,
            capturedWorkspace: { captureRoot: repository, canonicalRepoPath: repository },
            scopeReplay: { candidate, request: request(), preserve },
          });
          expect(parser).not.toHaveBeenCalled();
        } finally {
          parser.mockRestore();
        }
        expect(replay.parseMode).toBe('retained-replay');
        expect(replay.usedWorkerPool).toBe(false);
        expect(preserve).toHaveBeenCalledTimes(1);
        expect(
          (await loadScopeRetentionCandidate(promotedGeneration, expected, request())).manifest,
        ).toEqual(candidate.manifest);
        const expectedGraph = snapshot(full.graph);
        expect(snapshot(replay.graph)).toEqual(expectedGraph);
        expect(expectedGraph.nodes.length).toBeGreaterThan(0);
        expect(expectedGraph.relationships.length).toBeGreaterThan(0);
        const calls = expectedGraph.relationships.filter((edge) => edge.type === 'CALLS').length;
        expect(calls).toBeGreaterThan(0);
        for (const graph of [full.graph, replay.graph]) {
          const unresolvedHeritage: string[] = [];
          for (const edge of graph.relationships) {
            expect(graph.getNode(edge.sourceId), edge.id).toBeDefined();
            if (graph.getNode(edge.targetId)) continue;
            // The legacy heritage processor leaves an unresolved external parent (here `Error`) as a
            // bare `Class:<name>` target; any other dangling edge is a defect.
            expect(edge.type, edge.id).toBe('EXTENDS');
            expect(edge.targetId, edge.id).toMatch(/^Class:[A-Za-z_$][\w$]*$/);
            unresolvedHeritage.push(edge.id);
          }
          expect(unresolvedHeritage).toEqual([
            'EXTENDS:Class:src/scope-resolution/scope-tree.ts:ScopeTreeInvariantError->Class:Error',
          ]);
        }
        // Whole facts, including IDs, targets and ranges, must remain discriminating.
        const detects = (mutate: (graph: ReturnType<typeof snapshot>) => void) => {
          const changed = structuredClone(expectedGraph);
          mutate(changed);
          expect(isDeepStrictEqual(changed, expectedGraph)).toBe(false);
        };
        detects((graph) => {
          graph.nodes.pop();
        });
        detects((graph) => {
          graph.nodes.push({ ...graph.nodes[0]!, id: 'extra-node' });
        });
        detects((graph) => {
          graph.nodes[0]!.properties.name += '-changed';
        });
        detects((graph) => {
          graph.relationships.pop();
        });
        detects((graph) => {
          graph.relationships.push({ ...graph.relationships[0]!, id: 'extra-edge' });
        });
        detects((graph) => {
          graph.relationships[0]!.reason += '-changed';
        });
        detects((graph) => {
          graph.relationships[0]!.targetId += '-changed';
        });
        const rangedNode = expectedGraph.nodes.findIndex(
          (node) => typeof node.properties.startLine === 'number',
        );
        if (rangedNode >= 0)
          detects((graph) => {
            graph.nodes[rangedNode]!.properties.startLine! += 1;
          });
        results.push({
          registryPrimary,
          emitScopes: false,
          coverage,
          parseMode: replay.parseMode,
          nodes: expectedGraph.nodes.length,
          relationships: expectedGraph.relationships.length,
          calls,
          parserCodeIdentity,
          candidateIdentity: candidate.manifest.identity,
        });
      }
      if (process.env.ONTOINDEX_FROZEN_PARITY_REPORT) {
        fs.writeFileSync(
          process.env.ONTOINDEX_FROZEN_PARITY_REPORT,
          JSON.stringify(
            {
              scope:
                'production captured-workspace skipGraphPhases correctness on the accepted frozen subset; Git history excluded; no performance claim',
              manifestSha256: manifestDigest,
              classifierSha256: sha256(classificationBytes),
              frozenFilesVerified: 43,
              sourceFiles: 41,
              accepted: accepted.length,
              refused: refused.length,
              copiedConfigurations: ['package.json', 'tsconfig.json'],
              subsetIdentity: identity,
              results,
            },
            null,
            2,
          ) + '\n',
        );
      }
    } finally {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      for (const directory of directories) fs.rmSync(directory, { recursive: true, force: true });
    }
  },
  180_000,
);
