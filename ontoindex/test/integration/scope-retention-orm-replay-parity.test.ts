import { afterAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runPipelineFromRepo } from '../../src/core/ingestion/pipeline.js';
import * as workerPoolModule from '../../src/core/ingestion/workers/worker-pool.js';
import { parsePhase, type ParseOutput } from '../../src/core/ingestion/pipeline-phases/parse.js';
import { ormPhase } from '../../src/core/ingestion/pipeline-phases/orm.js';
import type {
  PipelineContext,
  PhaseResult,
} from '../../src/core/ingestion/pipeline-phases/types.js';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import type { KnowledgeGraph } from '../../src/core/graph/types.js';
import { persistScopeRetentionCandidate } from '../../src/core/ingestion/pipeline-phases/scope-retention-candidate.js';
import { verifyScopeRetentionCandidate } from '../../src/core/ingestion/pipeline-phases/scope-retention-candidate-reader.js';
import { loadPersistedReplayFamilies } from '../helpers/scope-retention-replay.js';
import { pathToFileURL } from 'node:url';
import type { ParsedFile } from 'ontoindex-shared';

function snapshot(graph: KnowledgeGraph) {
  return {
    nodes: structuredClone(graph.nodes).sort((a, b) => a.id.localeCompare(b.id)),
    relationships: structuredClone(graph.relationships).sort((a, b) => a.id.localeCompare(b.id)),
  };
}

function expectVariableMetadata(nodes: KnowledgeGraph['nodes']) {
  for (const [name, declaredType, isConst, isExported] of [
    ['prisma', 'any', true, false],
    ['supabase', 'any', true, false],
    ['ambientLet', 'number', false, false],
    ['exportedConst', 'boolean', true, true],
  ] as const) {
    const declarations = nodes.filter((node) => node.properties.name === name);
    expect(declarations).toHaveLength(1);
    expect(declarations[0].properties).toMatchObject({
      declaredType,
      isConst,
      isMutable: !isConst,
      isStatic: false,
      scope: 'module',
      visibility: isExported ? 'public' : 'private',
      isExported,
    });
  }
}

describe.each(['ambient', 'supported'] as const)(
  'scope retention ORM replay parity: %s',
  (fixture) => {
    const directories: string[] = [];
    const producers = new Map<
      string,
      { before: ReturnType<typeof snapshot>; after: ReturnType<typeof snapshot> }
    >();
    const parsedFilesByMode = new Map<string, ParsedFile[]>();
    afterAll(() =>
      directories.forEach((directory) => fs.rmSync(directory, { recursive: true, force: true })),
    );

    it.each(['sequential', 'worker', 'recovery'] as const)(
      '%s replays persisted ORM inputs to the live ORM graph',
      async (mode) => {
        const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ontoindex-orm-replay-'));
        directories.push(repo);
        fs.mkdirSync(path.join(repo, 'src'));
        const prefix =
          fixture === 'ambient'
            ? [
                'declare const prisma: any;',
                'declare const supabase: any;',
                'declare let ambientLet: number;',
                'export const exportedConst: boolean = true;',
              ]
            : [];
        fs.writeFileSync(
          path.join(repo, 'src', 'queries.ts'),
          [
            ...prefix,
            'prisma.user.findMany();',
            'supabase.from("bookings").select("*");',
            'prisma.user.findMany();',
          ].join('\n'),
        );
        const generation = fs.mkdtempSync(path.join(os.tmpdir(), 'ontoindex-orm-candidate-'));
        directories.push(generation);
        let recoveryPool: workerPoolModule.WorkerPool | undefined;
        if (mode === 'recovery') {
          const stubDirectory = fs.mkdtempSync(
            path.join(os.tmpdir(), 'ontoindex-orm-worker-stub-'),
          );
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

        let expected: Parameters<typeof verifyScopeRetentionCandidate>[1] | undefined;
        let parseSnapshot: ReturnType<typeof snapshot> | undefined;
        let liveAfterOrm: ReturnType<typeof snapshot> | undefined;
        let liveBeforeOrm: ReturnType<typeof snapshot> | undefined;
        const retainedFiles: ParsedFile[] = [];
        const executeParse = parsePhase.execute;
        const executeORM = ormPhase.execute;
        const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const parseSpy = vi.spyOn(parsePhase, 'execute').mockImplementation(async (ctx, deps) => {
          const output = await executeParse(ctx, deps);
          parseSnapshot = snapshot(ctx.graph);
          return output;
        });
        const ormSpy = vi.spyOn(ormPhase, 'execute').mockImplementation(async (ctx, deps) => {
          liveBeforeOrm = snapshot(ctx.graph);
          const output = await executeORM(ctx, deps);
          liveAfterOrm = snapshot(ctx.graph);
          return output;
        });
        try {
          const result = await runPipelineFromRepo(repo, () => {}, {
            skipGraphPhases: true,
            ...(mode === 'sequential'
              ? { skipWorkers: true }
              : { workerThresholdsForTest: { minFiles: 1, minBytes: 0 } }),
            scopeRetention: {
              deadline: Date.now() + 60_000,
              artifactAllowance: { remainingBytes: 64 * 1024 * 1024 },
              consume: async (handle) => {
                expected = {
                  identity: {
                    sourceManifestDigest: 'a'.repeat(64),
                    targetCommit: 'head',
                    baseGenerationId: null,
                  },
                  parserCodeIdentity: handle.inputEvidence.parserCodeIdentity,
                };
                expect(handle.seedReady).toBe(false);
                expect(handle.producerCompletion['orm-queries']).toBe(true);
                expect(handle.reasons).not.toContain('unsupported-syntax');
                expect(handle.ormQueryRecordCount).toBe(3);
                for await (const batch of handle.iterate()) retainedFiles.push(...batch);
                const manifest = await persistScopeRetentionCandidate(
                  handle,
                  generation,
                  expected.identity,
                  {
                    deadline: Date.now() + 60_000,
                    artifactAllowance: { remainingBytes: 64 * 1024 * 1024 },
                  },
                );
                expect(manifest.seedReady).toBe(false);
              },
            },
          });
          expect(result.usedWorkerPool).toBe(mode === 'worker');
          expect(parseSpy).toHaveBeenCalledTimes(1);
          expect(ormSpy).toHaveBeenCalledTimes(1);
        } finally {
          parseSpy.mockRestore();
          ormSpy.mockRestore();
          vi.restoreAllMocks();
          await recoveryPool?.terminate();
        }
        expect(parseSnapshot).toBeDefined();
        if (fixture === 'ambient') expectVariableMetadata(parseSnapshot!.nodes);
        expect(parseSnapshot!.relationships.some((edge) => edge.type === 'QUERIES')).toBe(false);
        expect(liveBeforeOrm).toEqual(parseSnapshot);
        expect(liveAfterOrm).toBeDefined();
        producers.set(mode, { before: liveBeforeOrm!, after: liveAfterOrm! });
        if (mode === 'recovery') {
          expect(warning).toHaveBeenCalledWith(
            'Worker pool parsing failed, falling back to sequential:',
            expect.stringMatching(/Controlled recovery protocol error/),
          );
        }
        const families = await loadPersistedReplayFamilies(generation, expected!);
        if (fixture === 'ambient') expectVariableMetadata(families.declarationNodes);
        expect(families.ormQueries).toEqual([
          {
            filePath: 'src/queries.ts',
            orm: 'prisma',
            model: 'user',
            method: 'findMany',
            lineNumber: prefix.length,
          },
          {
            filePath: 'src/queries.ts',
            orm: 'prisma',
            model: 'user',
            method: 'findMany',
            lineNumber: prefix.length + 2,
          },
          {
            filePath: 'src/queries.ts',
            orm: 'supabase',
            model: 'bookings',
            method: 'select',
            lineNumber: prefix.length + 1,
          },
        ]);
        expect(families.parsedFiles).toEqual(retainedFiles);
        parsedFilesByMode.set(mode, families.parsedFiles);
        {
          expect(families.parsedFiles).toHaveLength(1);
          const range = (line: number, startCol: number, endCol: number) => ({
            startLine: line + prefix.length,
            startCol,
            endLine: line + prefix.length,
            endCol,
          });
          const parsed = families.parsedFiles[0];
          const module = parsed.scopes.find((scope) => scope.id === parsed.moduleScope)!;
          expect([...module.typeBindings]).toEqual(
            fixture === 'ambient'
              ? [
                  ['prisma', { rawName: 'any', declaredAtScope: module.id, source: 'annotation' }],
                  [
                    'supabase',
                    { rawName: 'any', declaredAtScope: module.id, source: 'annotation' },
                  ],
                  [
                    'ambientLet',
                    { rawName: 'number', declaredAtScope: module.id, source: 'annotation' },
                  ],
                  [
                    'exportedConst',
                    { rawName: 'boolean', declaredAtScope: module.id, source: 'annotation' },
                  ],
                ]
              : [],
          );
          expect(
            families.parsedFiles[0].referenceSites
              .filter(({ explicitReceiver }) => explicitReceiver && 'kind' in explicitReceiver)
              .map(({ name, explicitReceiver }) => ({ name, explicitReceiver })),
          ).toEqual([
            {
              name: 'findMany',
              explicitReceiver: {
                kind: 'chain',
                root: { name: 'prisma', range: range(1, 0, 6) },
                steps: [{ kind: 'member', name: 'user', range: range(1, 7, 11) }],
              },
            },
            {
              name: 'select',
              explicitReceiver: {
                kind: 'chain',
                root: { name: 'supabase', range: range(2, 0, 8) },
                steps: [
                  { kind: 'member', name: 'from', range: range(2, 9, 13) },
                  { kind: 'call', arity: 1, range: range(2, 0, 25) },
                ],
              },
            },
            {
              name: 'findMany',
              explicitReceiver: {
                kind: 'chain',
                root: { name: 'prisma', range: range(3, 0, 6) },
                steps: [{ kind: 'member', name: 'user', range: range(3, 7, 11) }],
              },
            },
          ]);
        }

        const replay = createKnowledgeGraph();
        for (const node of families.declarationNodes) replay.addNode(node);
        for (const edge of families.structuralRelationships) replay.addRelationship(edge);
        expect(snapshot(replay)).toEqual(parseSnapshot);
        const parseOutput = { allORMQueries: families.ormQueries } as ParseOutput;
        const context = {
          repoPath: repo,
          graph: replay,
          onProgress: () => {},
          pipelineStart: Date.now(),
        } as PipelineContext;
        const deps = new Map<string, PhaseResult<unknown>>([
          ['parse', { phaseName: 'parse', output: parseOutput, durationMs: 0 }],
        ]);
        await ormPhase.execute(context, deps);
        expect(replay.relationships.some((edge) => edge.type === 'QUERIES')).toBe(true);
        expect(snapshot(replay)).toEqual(liveAfterOrm);
        expect(snapshot(replay)).not.toEqual(liveBeforeOrm);

        if (mode === 'sequential') {
          const missing = createKnowledgeGraph();
          for (const node of families.declarationNodes) missing.addNode(node);
          for (const edge of families.structuralRelationships) missing.addRelationship(edge);
          await ormPhase.execute(
            { ...context, graph: missing },
            new Map([
              [
                'parse',
                {
                  phaseName: 'parse',
                  output: {
                    allORMQueries: families.ormQueries.filter(({ orm }) => orm !== 'supabase'),
                  } as ParseOutput,
                  durationMs: 0,
                },
              ],
            ]),
          );
          expect(snapshot(missing)).not.toEqual(liveAfterOrm);
          const changed = createKnowledgeGraph();
          for (const node of families.declarationNodes) changed.addNode(structuredClone(node));
          for (const edge of families.structuralRelationships)
            changed.addRelationship(structuredClone(edge));
          await ormPhase.execute(
            { ...context, graph: changed },
            new Map([
              [
                'parse',
                {
                  phaseName: 'parse',
                  output: {
                    allORMQueries: families.ormQueries.map((query) => ({
                      ...query,
                      method: 'changedMethod',
                    })),
                  } as ParseOutput,
                  durationMs: 0,
                },
              ],
            ]),
          );
          expect(snapshot(changed)).not.toEqual(liveAfterOrm);
          const ormFile = path.join(generation, 'scope-retention-candidate', 'orm-queries.jsonl');
          fs.appendFileSync(ormFile, '{}\n');
          await expect(loadPersistedReplayFamilies(generation, expected!)).rejects.toThrow();
        }
      },
      90_000,
    );

    it('sequential, worker and recovery runs produce identical ORM graph deltas', () => {
      expect(producers.size).toBe(3);
      expect(producers.get('worker')).toEqual(producers.get('sequential'));
      expect(producers.get('recovery')).toEqual(producers.get('sequential'));
      expect(parsedFilesByMode.size).toBe(3);
      expect(parsedFilesByMode.get('worker')).toEqual(parsedFilesByMode.get('sequential'));
      expect(parsedFilesByMode.get('recovery')).toEqual(parsedFilesByMode.get('sequential'));
    });
  },
);
