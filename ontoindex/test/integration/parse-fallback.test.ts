/**
 * Integration Test: Parsing Fallback
 *
 * Verifies that when the worker pool fails (e.g. timeout, OOM),
 * the ingestion pipeline correctly falls back to sequential parsing
 * and produces a complete knowledge graph without silent data loss.
 */
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  PARSE_WORKER_RECOVERY_WINDOW_SIZE,
  PARSE_WORKER_RETRY_POLICY_QUARANTINE,
  processParsing,
} from '../../src/core/ingestion/parsing-processor.js';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import { createASTCache } from '../../src/core/ingestion/ast-cache.js';
import { createResolutionContext } from '../../src/core/ingestion/model/resolution-context.js';
import { createWorkerPool, type WorkerPool } from '../../src/core/ingestion/workers/worker-pool.js';
import { processCalls } from '../../src/core/ingestion/call-processor.js';
import { ScopeRetentionStage } from '../../src/core/ingestion/pipeline-phases/scope-retention-stage.js';
import { finalizeScopeModel } from '../../src/core/ingestion/finalize-orchestrator.js';
import { resolveReferences } from '../../src/core/ingestion/resolve-references.js';
import { emitReferencesToGraph } from '../../src/core/ingestion/emit-references.js';
import type { ExtractedCall } from '../../src/core/ingestion/workers/parse-types.js';
import type { ScopeExtractionRecord } from '../../src/core/ingestion/scope-extractor-bridge.js';
import { createEmptyResult } from '../../src/core/ingestion/workers/parse-types.js';
import { SupportedLanguages, type ParsedFile } from 'ontoindex-shared';

describe('processParsing fallback', () => {
  it.each([
    {
      fixture: 'plain',
      parameters: '',
      arguments: '',
      argCount: 0,
      argTypes: undefined,
      scopeRetained: true,
    },
    {
      fixture: 'typed',
      parameters: 'value: string',
      arguments: '"resolved"',
      argCount: 1,
      argTypes: ['string'],
      scopeRetained: true,
    },
  ])(
    'retains sequential artifacts and original calls after a real worker protocol error ($fixture)',
    async ({ parameters, arguments: callArguments, argCount, argTypes, scopeRetained }) => {
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ontoindex-retention-recovery-'));
      const workerPath = path.join(directory, 'error-worker.cjs');
      const graph = createKnowledgeGraph();
      const ctx = createResolutionContext();
      const astCache = createASTCache(1);
      const stage = new ScopeRetentionStage({
        deadline: Date.now() + 30_000,
        artifactAllowance: { remainingBytes: 1024 * 1024 },
      });
      const files = [
        {
          path: 'recovered.ts',
          content: [
            `export function target(${parameters}) {}`,
            `export function caller() { target(${callArguments}); missing("unresolved"); }`,
          ].join('\n'),
        },
      ];
      const parsedFiles: ParsedFile[] = [];
      const outcomes: ScopeExtractionRecord[] = [];
      const onParsedFiles = vi.fn((batch: readonly ParsedFile[]) => {
        parsedFiles.push(...structuredClone(batch));
        stage.capture(batch);
      });
      const onOutcomes = vi.fn((batch: readonly ScopeExtractionRecord[]) => {
        outcomes.push(...structuredClone(batch));
        stage.recordOutcomes(batch);
      });
      const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
      let pool: WorkerPool | undefined;
      try {
        // Real thread/dispatch failure; this is a controlled protocol error, not a native crash.
        await fs.writeFile(
          workerPath,
          `
        const { parentPort } = require('node:worker_threads');
        parentPort.on('message', (message) => {
          if (message && message.type === 'sub-batch') {
            parentPort.postMessage({ type: 'error', error: 'retention recovery fixture' });
          }
        });
      `,
        );
        pool = createWorkerPool(pathToFileURL(workerPath), 1, { isolation: 'thread' });
        const result = await processParsing(
          graph,
          files,
          directory,
          ctx.model.symbols,
          astCache,
          undefined,
          pool,
          undefined,
          undefined,
          undefined,
          undefined,
          onParsedFiles,
          onOutcomes,
        );

        expect(result).toBeNull();
        expect(warning).toHaveBeenCalledWith(
          'Worker pool parsing failed, falling back to sequential:',
          expect.stringContaining('retention recovery fixture'),
        );
        expect(onParsedFiles).toHaveBeenCalledTimes(1);
        expect(onOutcomes).toHaveBeenCalledTimes(1);
        expect(onParsedFiles).toHaveBeenCalledWith(scopeRetained ? parsedFiles : []);
        expect(parsedFiles.map((file) => file.filePath)).toEqual(
          scopeRetained ? ['recovered.ts'] : [],
        );
        expect(outcomes).toEqual([
          scopeRetained
            ? { filePath: 'recovered.ts', status: 'success' }
            : { filePath: 'recovered.ts', status: 'failed', reason: 'unsupported-syntax' },
        ]);
        for (const name of ['target', 'caller']) {
          expect(ctx.model.symbols.lookupCallableByName(name)).toHaveLength(1);
          expect(graph.nodes.filter((node) => node.properties.name === name)).toHaveLength(1);
        }

        const originalCalls: ExtractedCall[] = [];
        await processCalls(
          graph,
          files,
          astCache,
          ctx,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          (call) => {
            originalCalls.push(structuredClone(call));
            stage.captureCalls([call]);
          },
        );
        expect(originalCalls.map((call) => call.calledName)).toEqual(['target', 'missing']);
        expect(originalCalls).toEqual([
          expect.objectContaining({ calledName: 'target', callForm: 'free', argCount }),
          expect.objectContaining({
            calledName: 'missing',
            callForm: 'free',
            argCount: 1,
            argTypes: ['string'],
          }),
        ]);
        expect(originalCalls[0]!.argTypes).toEqual(argTypes);
        const edges = graph.relationships.filter((edge) => edge.type === 'CALLS');
        expect(edges).toEqual([
          expect.objectContaining({
            sourceId: ctx.model.symbols.lookupCallableByName('caller')[0]!.nodeId,
            targetId: ctx.model.symbols.lookupCallableByName('target')[0]!.nodeId,
          }),
        ]);

        // Scope emission is independent of the legacy CALLS graph asserted above.
        const graphOutput = (capturedFiles: ParsedFile[]) => {
          const indexes = finalizeScopeModel(capturedFiles);
          const resolved = resolveReferences(indexes);
          const scopeGraph = createKnowledgeGraph();
          const emitted = emitReferencesToGraph({
            graph: scopeGraph,
            scopes: indexes,
            referenceIndex: resolved.referenceIndex,
          });
          return structuredClone({
            finalizeStats: indexes.stats,
            resolveStats: resolved.stats,
            references: {
              bySourceScope: [...resolved.referenceIndex.bySourceScope].sort(([left], [right]) =>
                left.localeCompare(right),
              ),
              byTargetDef: [...resolved.referenceIndex.byTargetDef].sort(([left], [right]) =>
                left.localeCompare(right),
              ),
            },
            emitted,
            nodes: scopeGraph.nodes.sort((left, right) => left.id.localeCompare(right.id)),
            relationships: scopeGraph.relationships.sort((left, right) =>
              left.id.localeCompare(right.id),
            ),
          });
        };
        const capturedFiles = structuredClone(parsedFiles);
        const capturedCalls = structuredClone(originalCalls);
        // Build the baseline from original captures before releasing producer storage.
        const baseline = scopeRetained ? graphOutput(parsedFiles) : undefined;
        stage.reconcile(files.map((file) => file.path));
        parsedFiles.length = 0;
        originalCalls.length = 0;
        astCache.clear();
        expect(parsedFiles).toEqual([]);
        expect(originalCalls).toEqual([]);
        expect(astCache.stats().size).toBe(0);
        expect(stage.status).toBe(scopeRetained ? 'retained' : 'incomplete');
        expect(stage.recordCount).toBe(scopeRetained ? 1 : 0);
        expect(stage.callRecordCount).toBe(2);
        expect(stage.seedReady).toBe(false);
        const replayedFiles: ParsedFile[] = [];
        for await (const batch of stage.iterate()) replayedFiles.push(...batch);
        expect(replayedFiles).toEqual(capturedFiles);
        const replayedCalls: ExtractedCall[] = [];
        for await (const batch of stage.iterateCalls()) replayedCalls.push(...batch);
        expect(replayedCalls).toEqual(capturedCalls);
        if (scopeRetained) {
          const output = graphOutput(replayedFiles);
          expect(output).toEqual(baseline);
          expect(output.finalizeStats.totalFiles).toBe(1);
          expect(output.resolveStats).toMatchObject({
            resolvedSites: 1,
            unresolvedSites: 1,
            ambiguousSites: 0,
            unsupportedSites: 0,
          });
          expect(output.emitted).toMatchObject({
            edgesEmitted: 1,
            skippedNoCaller: 0,
            skippedMissingTarget: 0,
          });
          expect(output.relationships.filter((edge) => edge.type === 'CALLS')).toEqual([
            expect.objectContaining({
              sourceId: expect.stringMatching(/^def:recovered\.ts#\d+:\d+:Function:caller$/),
              targetId: expect.stringMatching(/^def:recovered\.ts#\d+:\d+:Function:target$/),
            }),
          ]);
          expect(
            output.relationships.filter(
              (edge) => edge.type === 'CALLS' && edge.targetId.includes('missing'),
            ),
          ).toEqual([]);
        } else {
          // The typed provider refusal stays incomplete; replay must not invent scope artifacts.
          expect(replayedFiles).toEqual([]);
          expect(stage.inventory).toEqual([
            {
              filePath: 'recovered.ts',
              status: 'failed',
              reason: 'unsupported-syntax',
            },
          ]);
        }
      } finally {
        try {
          await pool?.terminate();
        } finally {
          warning.mockRestore();
          astCache.clear();
          await stage.dispose();
          await fs.rm(directory, { recursive: true, force: true });
        }
      }
    },
  );

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

describe('processParsing extensionless shebang scripts', () => {
  const runSequential = async (files: { path: string; content: string }[]) => {
    const graph = createKnowledgeGraph();
    const ctx = createResolutionContext();
    const astCache = createASTCache(files.length);
    // No worker pool → sequential path (prepareSequentialFile) parses directly.
    const result = await processParsing(
      graph,
      files,
      '/dummy/repo/path',
      ctx.model.symbols,
      astCache,
      undefined,
      undefined,
    );
    return { graph, symbolTable: ctx.model.symbols, result };
  };

  it('parses an extensionless Python script from its shebang', async () => {
    const { graph } = await runSequential([
      { path: 'manage', content: '#!/usr/bin/env python3\ndef shebang_py():\n    return 1\n' },
    ]);
    expect(graph.nodes.map((n) => n.properties.name)).toContain('shebang_py');
  });

  it('parses an extensionless Node script from its shebang', async () => {
    const { symbolTable } = await runSequential([
      { path: 'cli', content: '#!/usr/bin/env node\nexport function shebangJs() {}\n' },
    ]);
    expect(symbolTable.lookupCallableByName('shebangJs').length).toBeGreaterThan(0);
  });

  it('drops an extensionless shell script — shell is never aliased', async () => {
    const { graph } = await runSequential([
      { path: 'deploy', content: '#!/bin/bash\ndeploy() { echo hi; }\n' },
    ]);
    expect(graph.nodeCount).toBe(0);
  });
});
