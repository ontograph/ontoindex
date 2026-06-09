/**
 * Integration Test: Parsing Fallback
 *
 * Verifies that when the worker pool fails (e.g. timeout, OOM),
 * the ingestion pipeline correctly falls back to sequential parsing
 * and produces a complete knowledge graph without silent data loss.
 */
import { describe, it, expect } from 'vitest';
import {
  PARSE_WORKER_RECOVERY_WINDOW_SIZE,
  PARSE_WORKER_RETRY_POLICY_QUARANTINE,
  processParsing,
} from '../../src/core/ingestion/parsing-processor.js';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import { createASTCache } from '../../src/core/ingestion/ast-cache.js';
import { createResolutionContext } from '../../src/core/ingestion/model/resolution-context.js';
import type { WorkerPool } from '../../src/core/ingestion/workers/worker-pool.js';
import { createEmptyResult } from '../../src/core/ingestion/workers/parse-types.js';
import { SupportedLanguages } from 'ontoindex-shared';

describe('processParsing fallback', () => {
  it('falls back to sequential parsing when the worker pool throws an error', async () => {
    const graph = createKnowledgeGraph();
    const ctx = createResolutionContext();
    const symbolTable = ctx.model.symbols;
    const astCache = createASTCache(1);

    const files = [
      { path: 'test.ts', content: 'export const testVar = 1; export function testFunc() {}' },
    ];

    const failingWorkerPool: WorkerPool = {
      size: 1,
      isolation: 'thread',
      startupDurationMs: 0,
      workerStartupDurationsMs: [0],
      terminate: async () => {},
      dispatch: async () => {
        throw new Error('Simulated worker crash');
      },
    };

    const result = await processParsing(
      graph,
      files,
      '/dummy/repo/path',
      symbolTable,
      astCache,
      undefined,
      failingWorkerPool,
    );

    // Sequential fallback returns null for worker-extracted data
    expect(result).toBeNull();

    // Verify that the fallback still parsed the batch and populated the graph
    const nodes = graph.nodes;
    expect(nodes.length).toBeGreaterThan(0);

    const names = nodes.map((n) => n.properties.name);
    expect(names).toContain('testVar');
    expect(names).toContain('testFunc');

    // Verify that symbolTable is also populated (proves extraction ran)
    const symbols = symbolTable.lookupCallableByName('testFunc');
    expect(symbols.length).toBeGreaterThan(0);
    expect(symbols[0].nodeId).toContain('testFunc');
  });

  it('preserves existing graph state when worker failure triggers fallback', async () => {
    const graph = createKnowledgeGraph();
    graph.addNode({
      id: 'File:existing.ts',
      label: 'File',
      properties: {
        name: 'existing.ts',
        filePath: 'existing.ts',
      },
    });
    const ctx = createResolutionContext();
    const astCache = createASTCache(1);

    const failingWorkerPool: WorkerPool = {
      size: 1,
      isolation: 'thread',
      startupDurationMs: 0,
      workerStartupDurationsMs: [0],
      terminate: async () => {},
      dispatch: async () => {
        throw new Error('Simulated worker crash');
      },
    };

    const result = await processParsing(
      graph,
      [{ path: 'new.ts', content: 'export function parsedAfterCrash() {}' }],
      '/dummy/repo/path',
      ctx.model.symbols,
      astCache,
      undefined,
      failingWorkerPool,
    );

    expect(result).toBeNull();
    expect(graph.getNode('File:existing.ts')).toMatchObject({
      id: 'File:existing.ts',
      properties: { filePath: 'existing.ts' },
    });
    expect(graph.nodes.map((node) => node.properties.name)).toContain('parsedAfterCrash');
  });

  it('discards streamed worker graph mutations before retry fallback', async () => {
    const graph = createKnowledgeGraph();
    const ctx = createResolutionContext();
    const symbolTable = ctx.model.symbols;
    const astCache = createASTCache(1);
    const files = [{ path: 'dupe.ts', content: 'export function streamedThenRecovered() {}' }];

    const streamedPart = createEmptyResult();
    streamedPart.nodes.push({
      id: 'Function:dupe.ts:streamedThenRecovered',
      label: 'Function',
      properties: {
        name: 'streamedThenRecovered',
        filePath: 'dupe.ts',
        startLine: 0,
        endLine: 0,
        language: SupportedLanguages.TypeScript,
        isExported: true,
      },
    });
    streamedPart.symbols.push({
      filePath: 'dupe.ts',
      name: 'streamedThenRecovered',
      nodeId: 'Function:dupe.ts:streamedThenRecovered',
      type: 'Function',
    });
    streamedPart.fileCount = 1;
    streamedPart.processedPaths.push('dupe.ts');

    const lateFailingWorkerPool: WorkerPool = {
      size: 1,
      isolation: 'process',
      startupDurationMs: 0,
      workerStartupDurationsMs: [0],
      terminate: async () => {},
      dispatch: async (_items, _progress, _subBatchStart, _workerResult, options) => {
        options?.onResultPart?.(streamedPart, {
          workerIndex: 0,
          workerChunkSize: 1,
          workerIsolation: 'process',
        });
        throw new Error('Simulated late worker exit');
      },
    };

    const result = await processParsing(
      graph,
      files,
      '/dummy/repo/path',
      symbolTable,
      astCache,
      undefined,
      lateFailingWorkerPool,
    );

    expect(result).toBeNull();
    expect(symbolTable.lookupCallableByName('streamedThenRecovered')).toHaveLength(1);
    expect(
      graph.nodes.filter((node) => node.id === 'Function:dupe.ts:streamedThenRecovered'),
    ).toHaveLength(1);
  });

  it('quarantines failed worker inputs with deterministic degraded metadata', async () => {
    const graph = createKnowledgeGraph();
    const ctx = createResolutionContext();
    const astCache = createASTCache(2);
    const files = [
      { path: 'a.ts', content: 'export const a = 1;' },
      { path: 'b.ts', content: 'export const b = 2;' },
    ];

    const failingWorkerPool: WorkerPool = {
      size: 1,
      isolation: 'process',
      startupDurationMs: 0,
      workerStartupDurationsMs: [0],
      terminate: async () => {},
      dispatch: async () => {
        throw new Error('Simulated native parser crash');
      },
    };

    const result = await processParsing(
      graph,
      files,
      '/dummy/repo/path',
      ctx.model.symbols,
      astCache,
      undefined,
      failingWorkerPool,
      undefined,
      undefined,
      PARSE_WORKER_RETRY_POLICY_QUARANTINE,
    );

    expect(result?.degraded).toEqual({
      reason: expect.stringContaining('Simulated native parser crash'),
      filesSkipped: 2,
      policy: PARSE_WORKER_RETRY_POLICY_QUARANTINE,
      action: 'quarantine-files',
      recoveryWindowSize: PARSE_WORKER_RECOVERY_WINDOW_SIZE,
      fatal: false,
    });
    expect(result?.fileTimings).toEqual([
      {
        filePath: 'a.ts',
        language: 'typescript',
        durationMs: 0,
        status: 'skipped',
      },
      {
        filePath: 'b.ts',
        language: 'typescript',
        durationMs: 0,
        status: 'skipped',
      },
    ]);
    expect(graph.nodeCount).toBe(0);
  });
});
