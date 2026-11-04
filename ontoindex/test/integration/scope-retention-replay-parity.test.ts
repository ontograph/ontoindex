import { afterAll, describe, expect, it, vi } from 'vitest';
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
import {
  loadScopeRetentionCandidate,
  verifyScopeRetentionCandidate,
} from '../../src/core/ingestion/pipeline-phases/scope-retention-candidate-reader.js';
import { loadPersistedReplayFamilies } from '../helpers/scope-retention-replay.js';
import { summarizeScopeRetentionCoverage } from '../../src/core/ingestion/pipeline-phases/scope-retention-coverage.js';
import { parsePhase } from '../../src/core/ingestion/pipeline-phases/parse.js';
import { pageRankPhase } from '../../src/core/ingestion/pipeline-phases/pagerank.js';

function snapshot(graph: KnowledgeGraph) {
  return {
    nodes: structuredClone(graph.nodes).sort((left, right) => left.id.localeCompare(right.id)),
    relationships: structuredClone(graph.relationships).sort((left, right) =>
      left.id.localeCompare(right.id),
    ),
  };
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
              const coverage = summarizeScopeRetentionCoverage(handle.inventory);
              coverageByMode.set(mode, coverage);
              expect(coverage).toEqual({
                version: 1,
                languages: [
                  {
                    language: fixture.language,
                    files: fixture.retained + fixture.refused,
                    retained: fixture.retained + fixture.refused,
                    skipped: 0,
                    refused: 0,
                    unaccounted: 0,
                    unparsed: 0,
                    refusalReasons: [],
                  },
                ],
                complete: true,
              });
              expect(
                [...handle.inventory].sort((left, right) =>
                  left.filePath.localeCompare(right.filePath),
                ),
              ).toEqual(
                Object.keys(fixture.files)
                  .sort()
                  .map((filePath) => ({ filePath, status: 'retained' })),
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
              expect(handle.inputEvidence.complete).toBe(true);
              expect(handle.inputEvidence.sources.map(({ filePath }) => filePath).sort()).toEqual(
                Object.keys(fixture.files).sort(),
              );
              expect(handle.graphNodesCaptured).toBe(true);
              expect(handle.graphRelationshipsCaptured).toBe(true);
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
      const { calls, events, importStates, declarationNodes } = families;
      let replaySnapshot: ReturnType<typeof snapshot> | undefined;
      expect(events.length).toBeGreaterThan(0);
      if (fixture.refused) {
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

it('persists mixed TypeScript and Go as incomplete and falls back without losing Go nodes', async () => {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), 'ontoindex-mixed-retention-'));
  const generation = fs.mkdtempSync(path.join(os.tmpdir(), 'ontoindex-mixed-candidate-'));
  const request = () => ({
    deadline: Date.now() + 60_000,
    artifactAllowance: { remainingBytes: 64 * 1024 * 1024 },
  });
  const identity = {
    sourceManifestDigest: 'b'.repeat(64),
    targetCommit: 'mixed-fixture',
    baseGenerationId: null,
  };
  try {
    fs.writeFileSync(path.join(repository, 'main.ts'), 'export function typescriptControl() {}\n');
    fs.writeFileSync(
      path.join(repository, 'main.go'),
      'package main\nfunc goTarget() {}\nfunc goCaller() { goTarget() }\n',
    );
    let parserCodeIdentity: string | null = null;
    const full = await runPipelineFromRepo(repository, () => {}, {
      profile: 'full',
      skipGraphPhases: true,
      skipWorkers: true,
      scopeRetention: {
        ...request(),
        consume: async (handle) => {
          expect(handle.status).toBe('incomplete');
          expect(handle.inventory).toEqual(
            expect.arrayContaining([
              { filePath: 'main.ts', status: 'retained' },
              { filePath: 'main.go', status: 'unsupported' },
            ]),
          );
          const manifest = await persistScopeRetentionCandidate(
            handle,
            generation,
            identity,
            request(),
          );
          expect(manifest.coverage.complete).toBe(false);
          expect(manifest.coverage.languages).toContainEqual(
            expect.objectContaining({
              language: 'go',
              files: 1,
              retained: 0,
              refused: 1,
              refusalReasons: [{ reason: 'unsupported', count: 1 }],
            }),
          );
          parserCodeIdentity = handle.inputEvidence.parserCodeIdentity;
        },
      },
    });
    expect(full.graph.nodes.some((node) => node.properties.name === 'goTarget')).toBe(true);
    expect(full.graph.nodes.some((node) => node.properties.name === 'typescriptControl')).toBe(
      true,
    );
    const candidate = await loadScopeRetentionCandidate(
      generation,
      { identity, parserCodeIdentity },
      request(),
    );
    expect(candidate.manifest.retention.status).toBe('incomplete');
    const preserve = vi.fn(async () => {});
    const fallback = await runPipelineFromRepo(repository, () => {}, {
      profile: 'full',
      skipGraphPhases: true,
      skipWorkers: true,
      scopeReplay: { candidate, request: request(), preserve },
    });
    expect(fallback.parseMode).toBe('full');
    expect(preserve).not.toHaveBeenCalled();
    expect(snapshot(fallback.graph)).toEqual(snapshot(full.graph));
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
    fs.rmSync(generation, { recursive: true, force: true });
  }
}, 60_000);

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
      {
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
      for (const directory of directories) fs.rmSync(directory, { recursive: true, force: true });
    }
  },
  180_000,
);
