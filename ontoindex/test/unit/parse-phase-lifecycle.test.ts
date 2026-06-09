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
}));

vi.mock('../../src/core/ingestion/pipeline-phases/parse-impl.js', () => ({
  runChunkedParseAndResolve: mocks.runChunkedParseAndResolve,
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

describe('parsePhase lifecycle', () => {
  beforeEach(() => {
    mocks.runChunkedParseAndResolve.mockReset();
  });

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
  });
});
