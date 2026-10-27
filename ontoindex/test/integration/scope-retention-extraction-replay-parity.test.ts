import { afterAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runPipelineFromRepo } from '../../src/core/ingestion/pipeline.js';
import * as workerPoolModule from '../../src/core/ingestion/workers/worker-pool.js';
import { parsePhase, type ParseOutput } from '../../src/core/ingestion/pipeline-phases/parse.js';
import { routesPhase } from '../../src/core/ingestion/pipeline-phases/routes.js';
import { toolsPhase } from '../../src/core/ingestion/pipeline-phases/tools.js';
import type {
  PipelineContext,
  PhaseResult,
} from '../../src/core/ingestion/pipeline-phases/types.js';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import type { KnowledgeGraph } from '../../src/core/graph/types.js';
import { persistScopeRetentionCandidate } from '../../src/core/ingestion/pipeline-phases/scope-retention-candidate.js';
import { verifyScopeRetentionCandidate } from '../../src/core/ingestion/pipeline-phases/scope-retention-candidate-reader.js';
import { loadPersistedReplayFamilies } from '../helpers/scope-retention-replay.js';

function snapshot(graph: KnowledgeGraph) {
  return {
    nodes: structuredClone(graph.nodes).sort((a, b) => a.id.localeCompare(b.id)),
    relationships: structuredClone(graph.relationships).sort((a, b) => a.id.localeCompare(b.id)),
  };
}
type Snapshot = ReturnType<typeof snapshot>;
function graphFrom(state: Snapshot) {
  const graph = createKnowledgeGraph();
  for (const node of structuredClone(state.nodes)) graph.addNode(node);
  for (const edge of structuredClone(state.relationships)) graph.addRelationship(edge);
  return graph;
}
function dependencies(output: Partial<ParseOutput>) {
  return new Map<string, PhaseResult<unknown>>([
    ['parse', { phaseName: 'parse', output: output as ParseOutput, durationMs: 0 }],
  ]);
}

describe('persisted parse extraction phase replay', () => {
  const directories: string[] = [];
  afterAll(() =>
    directories.forEach((directory) => fs.rmSync(directory, { recursive: true, force: true })),
  );

  it.each(['sequential', 'worker', 'recovery'] as const)(
    '%s preserves routes and tools at their live boundaries',
    async (mode) => {
      const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ontoindex-extraction-replay-'));
      const generation = fs.mkdtempSync(path.join(os.tmpdir(), 'ontoindex-extraction-candidate-'));
      directories.push(repo, generation);
      const files = {
        'app/api/items/route.ts':
          'export function GET() { return Response.json({ items: [], count: 1 }); }',
        'src/client.ts': 'export async function load() { return fetch("/api/items"); }',
        'src/server.ts': 'app.get("/express-only", handler);',
        'routes/web.php': "<?php\nRoute::get('/laravel-only', function () { return 'ok'; });",
        'src/registry.py':
          '@server.tool("Search retained input")\ndef retained_search():\n    return "ok"\n',
        'src/registry-tools.ts': [
          'export const definitions = [{',
          'name: "source_search",',
          'description: "Read from source",',
          'inputSchema: {}',
          '}];',
        ].join('\n'),
      };
      for (const [filePath, content] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(repo, filePath)), { recursive: true });
        fs.writeFileSync(path.join(repo, filePath), content);
      }
      let recoveryPool: workerPoolModule.WorkerPool | undefined;
      if (mode === 'recovery') {
        const stub = fs.mkdtempSync(path.join(os.tmpdir(), 'ontoindex-extraction-worker-'));
        directories.push(stub);
        const workerPath = path.join(stub, 'error-worker.cjs');
        fs.writeFileSync(
          workerPath,
          [
            "const { parentPort } = require('node:worker_threads');",
            "parentPort.on('message', msg => {",
            " if (msg && msg.type === 'sub-batch') {",
            "  parentPort.postMessage({ type: 'diagnostic', diagnostics: { ...msg.diagnostics, phase: 'process-file', currentFilePath: msg.files[0].path } });",
            "  parentPort.postMessage({ type: 'error', error: 'Controlled extraction replay recovery' });",
            ' }',
            '});',
          ].join('\n'),
        );
        const factory = workerPoolModule.createWorkerPool;
        vi.spyOn(workerPoolModule, 'createWorkerPool').mockImplementationOnce(() => {
          recoveryPool = factory(pathToFileURL(workerPath), 1, { isolation: 'thread' });
          return recoveryPool;
        });
      }
      let expected: Parameters<typeof verifyScopeRetentionCandidate>[1] | undefined;
      let liveInputs:
        | Pick<
            ParseOutput,
            | 'allFetchCalls'
            | 'allExtractedRoutes'
            | 'allDecoratorRoutes'
            | 'allToolDefs'
            | 'allPaths'
          >
        | undefined;
      let beforeRoutes: Snapshot | undefined;
      let afterRoutes: Snapshot | undefined;
      let beforeTools: Snapshot | undefined;
      let afterTools: Snapshot | undefined;
      const executeParse = parsePhase.execute;
      const executeRoutes = routesPhase.execute;
      const executeTools = toolsPhase.execute;
      const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const parseSpy = vi.spyOn(parsePhase, 'execute').mockImplementation(async (ctx, deps) => {
        const output = await executeParse(ctx, deps);
        liveInputs = structuredClone({
          allFetchCalls: output.allFetchCalls,
          allExtractedRoutes: output.allExtractedRoutes,
          allDecoratorRoutes: output.allDecoratorRoutes,
          allToolDefs: output.allToolDefs,
          allPaths: output.allPaths,
        });
        return output;
      });
      const routesSpy = vi.spyOn(routesPhase, 'execute').mockImplementation(async (ctx, deps) => {
        beforeRoutes = snapshot(ctx.graph);
        const output = await executeRoutes(ctx, deps);
        afterRoutes = snapshot(ctx.graph);
        return output;
      });
      const toolsSpy = vi.spyOn(toolsPhase, 'execute').mockImplementation(async (ctx, deps) => {
        beforeTools = snapshot(ctx.graph);
        const output = await executeTools(ctx, deps);
        afterTools = snapshot(ctx.graph);
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
              // Framework syntax can leave scope capture incomplete; observed extraction replay grants no admission.
              expect(handle.seedReady).toBe(false);
              const manifest = await persistScopeRetentionCandidate(
                handle,
                generation,
                expected.identity,
                {
                  deadline: Date.now() + 60_000,
                  artifactAllowance: { remainingBytes: 64 * 1024 * 1024 },
                },
              );
              expect(manifest.version).toBe(5);
              expect(manifest.seedReady).toBe(false);
            },
          },
        });
        expect(result.usedWorkerPool).toBe(mode === 'worker');
        expect(parseSpy).toHaveBeenCalledTimes(1);
        expect(routesSpy).toHaveBeenCalledTimes(1);
        expect(toolsSpy).toHaveBeenCalledTimes(1);
        if (mode === 'recovery')
          expect(warning).toHaveBeenCalledWith(
            'Worker pool parsing failed, falling back to sequential:',
            expect.stringMatching(/Controlled extraction replay recovery/),
          );
      } finally {
        vi.restoreAllMocks();
        await recoveryPool?.terminate();
      }

      const families = await loadPersistedReplayFamilies(generation, expected!);
      expect(families.fetchCalls).toEqual(liveInputs!.allFetchCalls);
      expect(families.routes).toEqual(liveInputs!.allExtractedRoutes);
      expect(families.decoratorRoutes).toEqual(liveInputs!.allDecoratorRoutes);
      expect(families.toolDefinitions).toEqual(liveInputs!.allToolDefs);
      expect(families.fetchCalls.length).toBeGreaterThan(0);
      expect(families.routes).toEqual(
        expect.arrayContaining([expect.objectContaining({ routePath: '/laravel-only' })]),
      );
      expect(families.decoratorRoutes).toEqual(
        expect.arrayContaining([expect.objectContaining({ routePath: '/express-only' })]),
      );
      expect(families.toolDefinitions).toEqual(
        expect.arrayContaining([expect.objectContaining({ toolName: 'retained_search' })]),
      );
      const output: Partial<ParseOutput> = {
        allPaths: liveInputs!.allPaths,
        allFetchCalls: families.fetchCalls,
        allExtractedRoutes: families.routes,
        allDecoratorRoutes: families.decoratorRoutes,
        allToolDefs: families.toolDefinitions,
      };
      const context = (graph: KnowledgeGraph) =>
        ({
          repoPath: repo,
          graph,
          onProgress: () => {},
          pipelineStart: Date.now(),
        }) as PipelineContext;
      const routeGraph = graphFrom(beforeRoutes!);
      await routesPhase.execute(context(routeGraph), dependencies(output));
      expect(snapshot(routeGraph)).toEqual(afterRoutes);
      expect(snapshot(routeGraph)).not.toEqual(beforeRoutes);
      expect(routeGraph.nodes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            label: 'Route',
            properties: expect.objectContaining({
              name: '/api/items',
              responseKeys: ['items', 'count'],
            }),
          }),
        ]),
      );
      expect(routeGraph.relationships).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'FETCHES',
            sourceId: 'File:src/client.ts',
            targetId: 'Route:/api/items',
            confidence: 0.9,
            reason: 'fetch-url-match',
          }),
        ]),
      );
      const toolGraph = graphFrom(beforeTools!);
      await toolsPhase.execute(context(toolGraph), dependencies(output));
      expect(snapshot(toolGraph)).toEqual(afterTools);
      expect(snapshot(toolGraph)).not.toEqual(beforeTools);
      expect(toolGraph.nodes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            label: 'Tool',
            properties: expect.objectContaining({
              name: 'source_search',
              description: 'Read from source',
            }),
          }),
        ]),
      );
      for (const family of ['allFetchCalls', 'allExtractedRoutes', 'allDecoratorRoutes'] as const) {
        const graph = graphFrom(beforeRoutes!);
        await routesPhase.execute(context(graph), dependencies({ ...output, [family]: [] }));
        expect(snapshot(graph)).not.toEqual(afterRoutes);
      }
      const missingTools = graphFrom(beforeTools!);
      await toolsPhase.execute(context(missingTools), dependencies({ ...output, allToolDefs: [] }));
      expect(snapshot(missingTools)).not.toEqual(afterTools);
    },
    90_000,
  );
});
