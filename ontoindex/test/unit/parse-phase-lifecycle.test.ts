import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import { parsePhase } from '../../src/core/ingestion/pipeline-phases/parse.js';

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

function makeCtx(): { -readonly [K in keyof PipelineContext]: PipelineContext[K] } {
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
