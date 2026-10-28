import { afterAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runPipelineFromRepo } from '../../src/core/ingestion/pipeline.js';
import { parsePhase } from '../../src/core/ingestion/pipeline-phases/parse.js';
import { reconstructScopeRetentionParse } from '../../src/core/ingestion/pipeline-phases/parse-replay.js';
import { persistScopeRetentionCandidate } from '../../src/core/ingestion/pipeline-phases/scope-retention-candidate.js';
import { loadPersistedReplayFamilies } from '../helpers/scope-retention-replay.js';
import { processCalls } from '../../src/core/ingestion/call-processor.js';
import { createASTCache } from '../../src/core/ingestion/ast-cache.js';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import type { KnowledgeGraph } from '../../src/core/graph/types.js';

function snapshot(graph: KnowledgeGraph) {
  return {
    nodes: structuredClone(graph.nodes).sort((left, right) => left.id.localeCompare(right.id)),
    relationships: structuredClone(graph.relationships).sort((left, right) =>
      left.id.localeCompare(right.id),
    ),
  };
}

describe.each([
  { language: 'typescript', extension: 'ts', flag: 'REGISTRY_PRIMARY_TYPESCRIPT' },
  { language: 'javascript', extension: 'js', flag: 'REGISTRY_PRIMARY_JAVASCRIPT' },
])('exclusive scope CALLS publication ($language)', ({ extension, flag }) => {
  const directories: string[] = [];

  afterAll(() => {
    for (const directory of directories) fs.rmSync(directory, { recursive: true, force: true });
  });

  it.each([
    { mode: 'sequential', skipWorkers: true },
    { mode: 'worker', skipWorkers: false },
  ])(
    '$mode publishes only exact, callable scope sites',
    async ({ mode, skipWorkers }) => {
      if (!skipWorkers) {
        expect(
          fs.existsSync(
            path.resolve(__dirname, '../../dist/core/ingestion/workers/parse-worker.js'),
          ),
          'Build the production dist/ worker before this integration suite',
        ).toBe(true);
      }
      const previous = process.env[flag];

      const directory = fs.mkdtempSync(
        path.join(os.tmpdir(), `ontoindex-scope-call-${extension}-`),
      );
      directories.push(directory);
      const source = [
        "import { imported } from './dependency';",
        'export function target() {}',
        'class Service { target() {} }',
        'export function invoke() {',
        '  target();',
        '  { const target = 1; target(); }',
        '  target(1);',
        '  imported();',
        '  const service = new Service();',
        '  service.target();',
        '}',
        'export function shadowOnly(target) { target(); }',
        'export function wrongArityOnly() { target(1); }',
      ].join('\n');
      const refusedSource = [
        'export function fallbackTarget() {}',
        'export function fallbackCaller() { fallbackTarget(); }',
        // Array holes remain refused by the emitter, which forces the legacy fallback.
        'const sparse = [,,];',
      ].join('\n');
      fs.writeFileSync(path.join(directory, `calls.${extension}`), source);
      fs.writeFileSync(
        path.join(directory, `dependency.${extension}`),
        'export function imported() {}\n',
      );
      fs.writeFileSync(path.join(directory, `refused.${extension}`), refusedSource);

      let baseline!: Awaited<ReturnType<typeof runPipelineFromRepo>>;
      let scoped!: Awaited<ReturnType<typeof runPipelineFromRepo>>;
      let generationDirectory: string | undefined;
      let expected: Parameters<typeof loadPersistedReplayFamilies>[1] | undefined;
      let producer: ReturnType<typeof snapshot> | undefined;
      const executeParse = parsePhase.execute;
      const parseSpy = vi.spyOn(parsePhase, 'execute').mockImplementation(async (ctx, deps) => {
        const output = await executeParse(ctx, deps);
        producer = snapshot(ctx.graph);
        return output;
      });
      try {
        vi.stubEnv(flag, '0');
        baseline = await runPipelineFromRepo(directory, () => {}, {
          skipGraphPhases: true,
          skipWorkers,
          workerThresholdsForTest: { minFiles: 1, minBytes: 0 },
        });
        vi.stubEnv(flag, '1');
        scoped = await runPipelineFromRepo(directory, () => {}, {
          skipGraphPhases: true,
          skipWorkers,
          workerThresholdsForTest: { minFiles: 1, minBytes: 0 },
          scopeRetention: {
            deadline: Date.now() + 60_000,
            artifactAllowance: { remainingBytes: 64 * 1024 * 1024 },
            consume: async (handle) => {
              generationDirectory = fs.mkdtempSync(
                path.join(os.tmpdir(), 'ontoindex-scope-call-replay-'),
              );
              directories.push(generationDirectory);
              const identity = {
                sourceManifestDigest: 'b'.repeat(64),
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
              expect(manifest.seedReady).toBe(false);
              expected = { identity, parserCodeIdentity: handle.inputEvidence.parserCodeIdentity };
            },
          },
        });
        expect(producer).toBeDefined();
        expect(generationDirectory).toBeDefined();
        expect(expected).toBeDefined();
        const families = await loadPersistedReplayFamilies(generationDirectory!, expected!);
        const replayGraph = createKnowledgeGraph();
        const replay = await reconstructScopeRetentionParse(families, replayGraph);
        expect(snapshot(replayGraph)).toEqual(producer);
        if (skipWorkers) expect(scoped.usedWorkerPool).toBe(false);
        else expect(scoped.usedWorkerPool).toBe(true);

        const invoke = scoped.graph.nodes.find(
          ({ properties }) =>
            properties.filePath === `calls.${extension}` && properties.name === 'invoke',
        );
        const target = scoped.graph.nodes.find(
          ({ properties, label }) =>
            properties.filePath === `calls.${extension}` &&
            properties.name === 'target' &&
            label === 'Function',
        );
        const member = scoped.graph.nodes.find(
          ({ properties, label }) =>
            properties.filePath === `calls.${extension}` &&
            properties.name === 'target' &&
            label === 'Method',
        );
        const imported = scoped.graph.nodes.find(
          ({ properties }) =>
            properties.filePath === `dependency.${extension}` && properties.name === 'imported',
        );
        expect(invoke).toBeDefined();
        expect(target).toBeDefined();
        expect(imported).toBeDefined();
        expect(member).toBeDefined();
        const negativeCallers = ['shadowOnly', 'wrongArityOnly'].map((name) => {
          const caller = scoped.graph.nodes.find(
            ({ properties }) =>
              properties.filePath === `calls.${extension}` && properties.name === name,
          );
          expect(caller).toBeDefined();
          return caller!;
        });
        const fallbackCaller = scoped.graph.nodes.find(
          ({ properties }) =>
            properties.filePath === `refused.${extension}` && properties.name === 'fallbackCaller',
        );
        const fallbackTarget = scoped.graph.nodes.find(
          ({ properties }) =>
            properties.filePath === `refused.${extension}` && properties.name === 'fallbackTarget',
        );
        expect(fallbackCaller).toBeDefined();
        expect(fallbackTarget).toBeDefined();

        const assertNegativeCalls = (graph: KnowledgeGraph) => {
          for (const caller of negativeCallers) {
            expect(
              graph.relationships.filter(
                (edge) =>
                  edge.type === 'CALLS' &&
                  edge.sourceId === caller.id &&
                  edge.targetId === target!.id,
              ),
            ).toHaveLength(0);
          }
        };
        const fallbackCalls = (graph: KnowledgeGraph) =>
          graph.relationships.filter(
            (edge) =>
              edge.type === 'CALLS' &&
              edge.sourceId === fallbackCaller!.id &&
              edge.targetId === fallbackTarget!.id,
          );
        const baselineFallbackCalls = fallbackCalls(baseline.graph);
        expect(baselineFallbackCalls.length).toBeGreaterThan(0);
        const assertFallbackCalls = (graph: KnowledgeGraph) => {
          expect(fallbackCalls(graph)).toEqual(baselineFallbackCalls);
          expect(
            fallbackCalls(graph).some((edge) => edge.reason?.startsWith('scope-resolution:')),
          ).toBe(false);
        };

        const callsFromInvoke = (graph: typeof scoped.graph) =>
          graph.relationships.filter(
            (edge) => edge.type === 'CALLS' && edge.sourceId === invoke!.id,
          );
        const scopeCalls = callsFromInvoke(scoped.graph).filter((edge) =>
          edge.reason?.startsWith('scope-resolution:'),
        );
        expect(scopeCalls).toHaveLength(1);
        const scopeCallId = `rel:CALLS:${invoke!.id}->${target!.id}:5:2`;
        expect(scopeCalls[0]).toEqual(
          expect.objectContaining({ id: scopeCallId, targetId: target!.id }),
        );
        expect(
          callsFromInvoke(scoped.graph).filter((edge) => edge.targetId === target!.id),
        ).toHaveLength(1);
        assertNegativeCalls(scoped.graph);
        assertFallbackCalls(scoped.graph);
        expect(
          callsFromInvoke(baseline.graph).some((edge) =>
            edge.reason?.startsWith('scope-resolution:'),
          ),
        ).toBe(false);
        expect(
          scoped.graph.relationships.some(
            (edge) =>
              edge.type === 'CALLS' &&
              edge.sourceId === invoke!.id &&
              edge.targetId === imported!.id,
          ),
        ).toBe(true);
        expect(
          callsFromInvoke(scoped.graph).filter((edge) => edge.targetId === member!.id),
        ).toEqual(callsFromInvoke(baseline.graph).filter((edge) => edge.targetId === member!.id));
        expect(callsFromInvoke(scoped.graph).some((edge) => edge.targetId === member!.id)).toBe(
          true,
        );

        // Re-resolving the same source from the replay context has no extraction
        // callback, so this checks that ownership itself prevents legacy revival.
        const cache = createASTCache();
        try {
          await processCalls(
            replayGraph,
            [
              { path: `calls.${extension}`, content: source },
              { path: `refused.${extension}`, content: refusedSource },
            ],
            cache,
            replay.resolutionContext,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            replay.bindingAccumulator,
          );
          const refinedTargetCalls = replayGraph.relationships.filter(
            (edge) =>
              edge.type === 'CALLS' && edge.sourceId === invoke!.id && edge.targetId === target!.id,
          );
          expect(refinedTargetCalls).toHaveLength(1);
          expect(refinedTargetCalls[0]?.id).toBe(scopeCallId);
          expect(refinedTargetCalls[0]?.reason).toMatch(/^scope-resolution:/);
          assertNegativeCalls(replayGraph);
          assertFallbackCalls(replayGraph);
        } finally {
          cache.clear();
          replay.resolutionContext.clear();
          replay.bindingAccumulator.dispose();
        }
      } finally {
        parseSpy.mockRestore();
        if (previous === undefined) delete process.env[flag];
        else process.env[flag] = previous;
        vi.unstubAllEnvs();
      }
      expect(mode).toBe(skipWorkers ? 'sequential' : 'worker');
    },
    90_000,
  );
});
