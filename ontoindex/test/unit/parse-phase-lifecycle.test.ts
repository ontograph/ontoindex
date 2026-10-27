import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import type { ParsedFile } from 'ontoindex-shared';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import { emitReferencesToGraph } from '../../src/core/ingestion/emit-references.js';
import { finalizeScopeModel } from '../../src/core/ingestion/finalize-orchestrator.js';
import { resolveReferences } from '../../src/core/ingestion/resolve-references.js';
import { parsePhase } from '../../src/core/ingestion/pipeline-phases/parse.js';
import {
  ScopeRetentionStage,
  type ScopeRetentionHandle,
} from '../../src/core/ingestion/pipeline-phases/scope-retention-stage.js';
import type { StructureOutput } from '../../src/core/ingestion/pipeline-phases/structure.js';
import type {
  PhaseResult,
  PipelineContext,
} from '../../src/core/ingestion/pipeline-phases/types.js';

const mocks = vi.hoisted(() => ({
  runChunkedParseAndResolve: vi.fn(),
  admitScopeRetentionParseReplay: vi.fn(),
  reconstructScopeRetentionParse: vi.fn(),
}));

vi.mock('../../src/core/ingestion/pipeline-phases/parse-impl.js', () => ({
  runChunkedParseAndResolve: mocks.runChunkedParseAndResolve,
}));

vi.mock('../../src/core/ingestion/pipeline-phases/parse-replay.js', () => ({
  admitScopeRetentionParseReplay: mocks.admitScopeRetentionParseReplay,
  reconstructScopeRetentionParse: mocks.reconstructScopeRetentionParse,
}));

function makeCtx(): PipelineContext {
  return {
    repoPath: '/tmp/repo',
    graph: createKnowledgeGraph(),
    onProgress: () => {},
    pipelineStart: Date.now(),
  };
}

function makeParseResult() {
  return {
    exportedTypeMap: new Map<string, Map<string, string>>(),
    allFetchCalls: [],
    allExtractedRoutes: [],
    allDecoratorRoutes: [],
    allToolDefs: [],
    allORMQueries: [],
    bindingAccumulator: { dispose: vi.fn() },
    resolutionContext: { clear: vi.fn() },
    usedWorkerPool: false,
  };
}

function callFixture(): ParsedFile {
  const filePath = 'app.ts';
  const moduleScope = 'scope:app.ts#module';
  const callerScope = 'scope:app.ts#caller';
  const range = { startLine: 1, startCol: 0, endLine: 3, endCol: 0 };
  const target = {
    nodeId: 'def:target',
    filePath,
    type: 'Function' as const,
    qualifiedName: 'target',
  };
  const caller = {
    nodeId: 'def:caller',
    filePath,
    type: 'Function' as const,
    qualifiedName: 'caller',
  };
  return {
    filePath,
    moduleScope,
    localDefs: [target, caller],
    parsedImports: [],
    scopes: [
      {
        id: moduleScope,
        parent: null,
        kind: 'Module',
        filePath,
        range,
        bindings: new Map([['target', [{ def: target, origin: 'local' as const }]]]),
        ownedDefs: [target, caller],
        imports: [],
        typeBindings: new Map(),
      },
      {
        id: callerScope,
        parent: moduleScope,
        kind: 'Function',
        filePath,
        range: { startLine: 2, startCol: 0, endLine: 2, endCol: 31 },
        bindings: new Map(),
        ownedDefs: [caller],
        imports: [],
        typeBindings: new Map(),
      },
    ],
    referenceSites: [
      {
        name: 'target',
        inScope: callerScope,
        kind: 'call',
        callForm: 'free',
        atRange: { startLine: 2, startCol: 20, endLine: 2, endCol: 26 },
      },
    ],
  };
}

describe('parsePhase lifecycle', () => {
  beforeEach(() => {
    mocks.runChunkedParseAndResolve.mockReset();
    mocks.admitScopeRetentionParseReplay.mockReset();
    mocks.reconstructScopeRetentionParse.mockReset();
  });

  it('uses an admitted replay after preservation without invoking the parser', async () => {
    const ctx = makeCtx();
    const parsed = makeParseResult();
    const candidate = { manifest: {}, families: {} } as never;
    const preserve = vi.fn(async () => {});
    const request = { deadline: Date.now() + 30_000 };
    ctx.options = { scopeReplay: { candidate, request, preserve } };
    mocks.reconstructScopeRetentionParse.mockImplementation(async (_families, graph) => {
      graph.addNode({ id: 'replayed', label: 'Function', properties: {} });
      return parsed;
    });
    const output = await parsePhase.execute(
      ctx,
      new Map([
        [
          'structure',
          {
            phaseName: 'structure',
            durationMs: 0,
            output: { scannedFiles: [], allPaths: [], allPathSet: new Set(), totalFiles: 0 },
          },
        ],
      ]),
    );
    expect(mocks.admitScopeRetentionParseReplay).toHaveBeenCalledOnce();
    expect(mocks.reconstructScopeRetentionParse).toHaveBeenCalledOnce();
    expect(preserve).toHaveBeenCalledOnce();
    expect(mocks.runChunkedParseAndResolve).not.toHaveBeenCalled();
    expect(ctx.graph.getNode('replayed')).toBeDefined();
    expect(output.parseMode).toBe('retained-replay');
    output.dispose?.();
    expect(output.parseMode).toBe('retained-replay');
  });

  it('falls back once when admission refuses the candidate', async () => {
    const ctx = makeCtx();
    const candidate = { manifest: {}, families: {} } as never;
    const preserve = vi.fn(async () => {});
    ctx.options = {
      scopeReplay: {
        candidate,
        request: { deadline: Date.now() + 30_000 },
        preserve,
      },
    };
    mocks.admitScopeRetentionParseReplay.mockRejectedValueOnce(new Error('candidate mismatch'));
    mocks.runChunkedParseAndResolve.mockResolvedValueOnce(makeParseResult());
    const output = await parsePhase.execute(
      ctx,
      new Map([
        [
          'structure',
          {
            phaseName: 'structure',
            durationMs: 0,
            output: { scannedFiles: [], allPaths: [], allPathSet: new Set(), totalFiles: 0 },
          },
        ],
      ]),
    );
    expect(mocks.runChunkedParseAndResolve).toHaveBeenCalledOnce();
    expect(mocks.reconstructScopeRetentionParse).not.toHaveBeenCalled();
    expect(preserve).not.toHaveBeenCalled();
    expect(output.parseMode).toBe('full');
    output.dispose?.();
  });

  it('propagates cancellation without parsing or changing the graph', async () => {
    const ctx = makeCtx();
    const before = { nodes: ctx.graph.nodes, relationships: ctx.graph.relationships };
    const controller = new AbortController();
    controller.abort();
    ctx.options = {
      scopeReplay: {
        candidate: { manifest: {}, families: {} } as never,
        request: { deadline: Date.now() + 30_000, signal: controller.signal },
        preserve: async () => {},
      },
    };
    await expect(
      parsePhase.execute(
        ctx,
        new Map([
          [
            'structure',
            {
              phaseName: 'structure',
              durationMs: 0,
              output: { scannedFiles: [], allPaths: [], allPathSet: new Set(), totalFiles: 0 },
            },
          ],
        ]),
      ),
    ).rejects.toThrow('cancelled');
    expect(mocks.runChunkedParseAndResolve).not.toHaveBeenCalled();
    expect({ nodes: ctx.graph.nodes, relationships: ctx.graph.relationships }).toEqual(before);
  });

  it('propagates preservation failure before committing staged graph state', async () => {
    const ctx = makeCtx();
    const before = { nodes: ctx.graph.nodes, relationships: ctx.graph.relationships };
    const failure = new Error('copy failed');
    const parsed = makeParseResult();
    const preserve = vi.fn(async () => {
      throw failure;
    });
    ctx.options = {
      scopeReplay: {
        candidate: { manifest: {}, families: {} } as never,
        request: { deadline: Date.now() + 30_000 },
        preserve,
      },
    };
    mocks.reconstructScopeRetentionParse.mockImplementation(async (_families, graph) => {
      graph.addNode({ id: 'staged-only', label: 'Function', properties: {} });
      return parsed;
    });
    await expect(
      parsePhase.execute(
        ctx,
        new Map([
          [
            'structure',
            {
              phaseName: 'structure',
              durationMs: 0,
              output: { scannedFiles: [], allPaths: [], allPathSet: new Set(), totalFiles: 0 },
            },
          ],
        ]),
      ),
    ).rejects.toBe(failure);
    expect(preserve).toHaveBeenCalledOnce();
    expect(mocks.runChunkedParseAndResolve).not.toHaveBeenCalled();
    expect(ctx.graph.getNode('staged-only')).toBeUndefined();
    expect({ nodes: ctx.graph.nodes, relationships: ctx.graph.relationships }).toEqual(before);
    expect(parsed.bindingAccumulator.dispose).toHaveBeenCalledOnce();
    expect(parsed.resolutionContext.clear).toHaveBeenCalledOnce();
  });

  it.each(['reconstruction', 'preservation'] as const)(
    'rejects cancellation during %s without committing or parsing',
    async (phase) => {
      const ctx = makeCtx();
      const controller = new AbortController();
      const parsed = makeParseResult();
      // A cleanup failure must not hide the cancellation or prevent remaining cleanup.
      parsed.resolutionContext.clear.mockImplementation(() => {
        throw new Error('cleanup failed');
      });
      const preserve = vi.fn(async () => {
        controller.abort();
      });
      ctx.options = {
        scopeReplay: {
          candidate: { manifest: {}, families: {} } as never,
          request: { deadline: Date.now() + 30_000, signal: controller.signal },
          preserve,
        },
      };
      mocks.reconstructScopeRetentionParse.mockImplementation(async (_families, graph) => {
        graph.addNode({ id: 'uncommitted', label: 'Function', properties: {} });
        if (phase === 'reconstruction') controller.abort();
        return parsed;
      });
      await expect(
        parsePhase.execute(
          ctx,
          new Map([
            [
              'structure',
              {
                phaseName: 'structure',
                durationMs: 0,
                output: { scannedFiles: [], allPaths: [], allPathSet: new Set(), totalFiles: 0 },
              },
            ],
          ]),
        ),
      ).rejects.toThrow('cancelled');
      expect(ctx.graph.getNode('uncommitted')).toBeUndefined();
      expect(mocks.runChunkedParseAndResolve).not.toHaveBeenCalled();
      expect(preserve).toHaveBeenCalledTimes(phase === 'preservation' ? 1 : 0);
      expect(parsed.bindingAccumulator.dispose).toHaveBeenCalledOnce();
    },
  );

  it('discards a failed reconstruction and falls back exactly once', async () => {
    const ctx = makeCtx();
    const preserve = vi.fn();
    ctx.options = {
      scopeReplay: {
        candidate: { manifest: {}, families: {} } as never,
        request: { deadline: Date.now() + 30_000 },
        preserve,
      },
    };
    mocks.reconstructScopeRetentionParse.mockImplementation(async (_families, graph) => {
      graph.addNode({ id: 'uncommitted', label: 'Function', properties: {} });
      throw new Error('reconstruction refused');
    });
    mocks.runChunkedParseAndResolve.mockResolvedValueOnce(makeParseResult());
    const output = await parsePhase.execute(
      ctx,
      new Map([
        [
          'structure',
          {
            phaseName: 'structure',
            durationMs: 0,
            output: { scannedFiles: [], allPaths: [], allPathSet: new Set(), totalFiles: 0 },
          },
        ],
      ]),
    );
    expect(ctx.graph.getNode('uncommitted')).toBeUndefined();
    expect(mocks.runChunkedParseAndResolve).toHaveBeenCalledOnce();
    expect(preserve).not.toHaveBeenCalled();
    expect(output.parseMode).toBe('full');
    output.dispose?.();
  });

  it.each([NaN, Infinity, 0])(
    'refuses invalid or expired deadline %s before parsing',
    async (deadline) => {
      const ctx = makeCtx();
      ctx.options = {
        scopeReplay: {
          candidate: { manifest: {}, families: {} } as never,
          request: { deadline },
          preserve: vi.fn(),
        },
      };
      await expect(
        parsePhase.execute(
          ctx,
          new Map([
            [
              'structure',
              {
                phaseName: 'structure',
                durationMs: 0,
                output: { scannedFiles: [], allPaths: [], allPathSet: new Set(), totalFiles: 0 },
              },
            ],
          ]),
        ),
      ).rejects.toThrow(Number.isFinite(deadline) ? 'deadline' : 'invalid request');
      expect(mocks.admitScopeRetentionParseReplay).not.toHaveBeenCalled();
      expect(mocks.runChunkedParseAndResolve).not.toHaveBeenCalled();
    },
  );

  it.each(['admitted', 'incomplete', 'cancelled-during-drain'] as const)(
    'consumes real retained observed calls or refuses %s before finalization',
    async (scenario) => {
      const incomplete = scenario === 'incomplete';
      const refused = scenario !== 'admitted';
      const controller = new AbortController();
      const request = {
        deadline: Date.now() + 30_000,
        signal: controller.signal,
        artifactAllowance: { remainingBytes: 1024 * 1024 },
      };
      const initialAllowance = request.artifactAllowance.remainingBytes;
      const stage = new ScopeRetentionStage(request);
      const primary = new Error('observed scope inputs incomplete');
      const disposeStage = stage.dispose.bind(stage);
      const dispose = vi.spyOn(stage, 'dispose').mockImplementation(async () => {
        await disposeStage();
        if (refused) throw new Error('secondary retention cleanup failure');
      });
      const iterateStage = stage.iterate.bind(stage);
      const iterate = vi.spyOn(stage, 'iterate');
      if (scenario === 'cancelled-during-drain') {
        iterate.mockImplementation(async function* () {
          for await (const batch of iterateStage()) yield batch;
          controller.abort();
        });
      }
      const finalize = vi.fn(finalizeScopeModel);
      const emit = vi.fn(emitReferencesToGraph);
      const ctx = makeCtx();
      const graphBefore = { nodes: ctx.graph.nodes, relationships: ctx.graph.relationships };
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let entered!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const consume = vi.fn(async (handle: ScopeRetentionHandle) => {
        expect(handle).toBe(stage);
        expect(handle.seedReady).toBe(false);
        entered();
        await gate;
        const requireObservedInputs = () => {
          if (handle.status !== 'retained' || !handle.inputEvidence.complete) throw primary;
        };
        requireObservedInputs();
        const files: ParsedFile[] = [];
        for await (const batch of handle.iterate()) files.push(...batch);
        requireObservedInputs();
        expect(files).toEqual([callFixture()]);
        expect(handle.seedReady).toBe(false);
        const scopes = finalize(files);
        const resolved = resolveReferences(scopes);
        expect(resolved.stats).toEqual({
          totalSites: 1,
          resolvedSites: 1,
          unresolvedSites: 0,
          ambiguousSites: 0,
          unsupportedSites: 0,
        });
        const reference = resolved.referenceIndex.byTargetDef.get('def:target')![0]!;
        expect(
          emit({ graph: ctx.graph, scopes, referenceIndex: resolved.referenceIndex }).edgesEmitted,
        ).toBe(1);
        expect(ctx.graph.relationships.filter((edge) => edge.type === 'CALLS')).toEqual([
          {
            id: 'rel:CALLS:def:caller->def:target:2:20',
            sourceId: 'def:caller',
            targetId: 'def:target',
            type: 'CALLS',
            confidence: reference.confidence,
            reason: `scope-resolution: call | confidence ${reference.confidence.toFixed(3)}`,
            evidence: reference.evidence,
          },
        ]);
      });
      ctx.options = { scopeRetention: { ...request, consume } };
      const result = makeParseResult();
      const scannedFiles = [{ path: 'app.ts', size: 1 }];
      try {
        stage.captureDiscovery(['app.ts'], scannedFiles, []);
        stage.captureConfigObservations({
          version: 1,
          complete: true,
          records: [],
          issues: [],
          digest: createHash('sha256')
            .update(JSON.stringify({ version: 1, records: [] }))
            .digest('hex'),
        });
        stage.captureParserInputs([
          { path: 'app.ts', content: 'function target() {}\nfunction caller() { target(); }\n' },
        ]);
        stage.capture([callFixture()]);
        stage.recordOutcomes([{ filePath: 'app.ts', status: 'success' }]);
        stage.reconcile(incomplete ? ['app.ts', 'missing.ts'] : ['app.ts']);
        expect(stage.status).toBe(incomplete ? 'incomplete' : 'retained');
        expect(stage.inputEvidence.complete).toBe(!incomplete);
        expect(stage.seedReady).toBe(false);
        mocks.runChunkedParseAndResolve.mockResolvedValueOnce({ ...result, scopeRetention: stage });
        let settled = false;
        const outcome = parsePhase
          .execute(
            ctx,
            new Map([
              [
                'structure',
                {
                  phaseName: 'structure',
                  durationMs: 0,
                  output: {
                    scannedFiles,
                    allPaths: ['app.ts'],
                    allPathSet: new Set(['app.ts']),
                    totalFiles: 1,
                  },
                },
              ],
            ]),
          )
          .then(
            (output) => {
              settled = true;
              return { output, error: undefined };
            },
            (error: unknown) => {
              settled = true;
              return { output: undefined, error };
            },
          );
        await started;
        expect(settled).toBe(false);
        expect(dispose).not.toHaveBeenCalled();
        expect(finalize).not.toHaveBeenCalled();
        expect(emit).not.toHaveBeenCalled();
        release();
        const completed = await outcome;
        expect(completed.error).toBe(refused ? primary : undefined);
        expect(consume).toHaveBeenCalledOnce();
        expect(dispose).toHaveBeenCalledOnce();
        expect(scannedFiles).toEqual([]);
        expect(request.artifactAllowance.remainingBytes).toBe(initialAllowance);
        expect(stage.inventory).toEqual([]);
        if (refused) {
          expect(iterate).toHaveBeenCalledTimes(incomplete ? 0 : 1);
          expect(finalize).not.toHaveBeenCalled();
          expect(emit).not.toHaveBeenCalled();
          expect({ nodes: ctx.graph.nodes, relationships: ctx.graph.relationships }).toEqual(
            graphBefore,
          );
          expect(result.bindingAccumulator.dispose).toHaveBeenCalledOnce();
          expect(result.resolutionContext.clear).toHaveBeenCalledOnce();
        } else {
          expect(iterate).toHaveBeenCalledOnce();
          expect(finalize).toHaveBeenCalledOnce();
          expect(emit).toHaveBeenCalledOnce();
          completed.output?.dispose?.();
        }
      } finally {
        release();
        await disposeStage();
      }
    },
  );

  it('keeps downstream path data after structure output is disposed', async () => {
    const scannedFiles = [
      { path: 'src/a.ts', size: 1 },
      { path: 'src/b.ts', size: 1 },
    ];
    const allPaths = scannedFiles.map((file) => file.path);
    const allPathSet = new Set(allPaths);
    const structureOutput: StructureOutput = {
      scannedFiles,
      allPaths,
      allPathSet,
      totalFiles: allPaths.length,
      dispose: () => {
        scannedFiles.length = 0;
        allPaths.length = 0;
        allPathSet.clear();
      },
    };

    mocks.runChunkedParseAndResolve.mockResolvedValueOnce(makeParseResult());

    const output = await parsePhase.execute(
      makeCtx(),
      new Map<string, PhaseResult<unknown>>([
        ['structure', { phaseName: 'structure', output: structureOutput, durationMs: 0 }],
      ]),
    );

    structureOutput.dispose?.();

    expect(output.allPaths).toEqual(['src/a.ts', 'src/b.ts']);
    expect([...output.allPathSet]).toEqual(['src/a.ts', 'src/b.ts']);
    expect(output.allPaths).not.toBe(allPaths);
    expect(output.allPathSet).not.toBe(allPathSet);
    expect(output.parseMode).toBe('full');
    output.dispose?.();
    expect(output.parseMode).toBe('full');
  });

  it.each([false, true])(
    'awaits retention consumption and disposes it on consumer failure=%s',
    async (fail) => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let started!: () => void;
      const entered = new Promise<void>((resolve) => {
        started = resolve;
      });
      const failure = new Error('consumer failed');
      const dispose = vi.fn(async () => {});
      const handle = { dispose };
      const consume = vi.fn(async (received: unknown) => {
        expect(received).toBe(handle);
        started();
        await gate;
        if (fail) throw failure;
      });
      const ctx = makeCtx();
      ctx.options = {
        scopeRetention: {
          deadline: Date.now() + 30_000,
          artifactAllowance: { remainingBytes: 1024 },
          consume,
        },
      };
      const scannedFiles = [{ path: 'a.ts', size: 1 }];
      const structure: StructureOutput = {
        scannedFiles,
        allPaths: ['a.ts'],
        allPathSet: new Set(['a.ts']),
        totalFiles: 1,
      };
      mocks.runChunkedParseAndResolve.mockResolvedValueOnce({
        ...makeParseResult(),
        scopeRetention: handle,
      });
      let settled = false;
      const outcome = parsePhase
        .execute(
          ctx,
          new Map([['structure', { phaseName: 'structure', output: structure, durationMs: 0 }]]),
        )
        .then(
          (output) => {
            settled = true;
            return { output, error: undefined };
          },
          (error: unknown) => {
            settled = true;
            return { output: undefined, error };
          },
        );
      try {
        await entered;
        expect(settled).toBe(false);
        expect(dispose).not.toHaveBeenCalled();
      } finally {
        release();
      }
      const result = await outcome;
      expect(result.error).toBe(fail ? failure : undefined);
      expect(dispose).toHaveBeenCalledOnce();
      expect(consume).toHaveBeenCalledOnce();
      expect(scannedFiles).toEqual([]);
    },
  );

  it('preserves a consumer rejection over retention cleanup failure', async () => {
    const primary = new Error('primary consumer failure');
    const dispose = vi.fn(async () => {
      throw new Error('secondary disposal failure');
    });
    const ctx = makeCtx();
    ctx.options = {
      scopeRetention: {
        deadline: Date.now() + 30_000,
        artifactAllowance: { remainingBytes: 1024 },
        consume: async () => {
          throw primary;
        },
      },
    };
    mocks.runChunkedParseAndResolve.mockResolvedValueOnce({
      ...makeParseResult(),
      scopeRetention: { dispose },
    });
    await expect(
      parsePhase.execute(
        ctx,
        new Map([
          [
            'structure',
            {
              phaseName: 'structure',
              durationMs: 0,
              output: {
                scannedFiles: [],
                allPaths: [],
                allPathSet: new Set(),
                totalFiles: 0,
              },
            },
          ],
        ]),
      ),
    ).rejects.toBe(primary);
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('releases parse collections when retention disposal alone fails', async () => {
    const failure = new Error('retention removal failed');
    const dispose = vi.fn(async () => {
      throw failure;
    });
    const result = makeParseResult();
    result.exportedTypeMap.set('a.ts', new Map([['User', 'User']]));
    const ctx = makeCtx();
    ctx.options = {
      scopeRetention: {
        deadline: Date.now() + 30_000,
        artifactAllowance: { remainingBytes: 1024 },
        consume: async () => {},
      },
    };
    mocks.runChunkedParseAndResolve.mockResolvedValueOnce({
      ...result,
      scopeRetention: { dispose },
    });
    const scannedFiles = [{ path: 'a.ts', size: 1 }];
    await expect(
      parsePhase.execute(
        ctx,
        new Map([
          [
            'structure',
            {
              phaseName: 'structure',
              durationMs: 0,
              output: {
                scannedFiles,
                allPaths: ['a.ts'],
                allPathSet: new Set(['a.ts']),
                totalFiles: 1,
              },
            },
          ],
        ]),
      ),
    ).rejects.toBe(failure);
    expect(result.exportedTypeMap.size).toBe(0);
    expect(result.bindingAccumulator.dispose).toHaveBeenCalledOnce();
    expect(result.resolutionContext.clear).toHaveBeenCalledOnce();
    expect(scannedFiles).toEqual([]);
    expect(dispose).toHaveBeenCalledOnce();
  });
});
