/**
 * Phase: parse
 *
 * Chunked parse + resolve loop: reads source in byte-budget chunks,
 * parses via worker pool (or sequential fallback), resolves imports,
 * heritage, and calls, synthesizes wildcard bindings.
 *
 * This phase encapsulates the entire `runChunkedParseAndResolve` function
 * from the original pipeline. The chunk loop is a memory optimization
 * internal to this phase, not a phase boundary.
 *
 * @deps    structure, markdown, cobol
 * @reads   scannedFiles, allPaths, totalFiles (from structure)
 * @writes  graph (Symbol nodes, IMPORTS/CALLS/EXTENDS/IMPLEMENTS/ACCESSES edges)
 * @output  exportedTypeMap, allFetchCalls, allExtractedRoutes, allDecoratorRoutes,
 *          allToolDefs, allORMQueries, bindingAccumulator
 */

import type { PipelinePhase, PipelineContext, PhaseResult } from './types.js';
import { getPhaseOutput } from './types.js';
import type { StructureOutput } from './structure.js';
import type { BindingAccumulator } from '../binding-accumulator.js';
import type {
  ExtractedFetchCall,
  ExtractedRoute,
  ExtractedDecoratorRoute,
  ExtractedToolDef,
  ExtractedORMQuery,
} from '../workers/parse-worker.js';
import type { createResolutionContext } from '../model/resolution-context.js';
import { runChunkedParseAndResolve } from './parse-impl.js';
import { createKnowledgeGraph } from '../../graph/graph.js';
import { admitScopeRetentionParseReplay, reconstructScopeRetentionParse } from './parse-replay.js';

export interface ParseOutput {
  readonly parseMode: 'full' | 'retained-replay';
  /**
   * Read-only snapshot of exported type bindings keyed by file path.
   *
   * Fully populated by `parse` (sequential path via `enrichExportedTypeMap`
   * and worker path via `buildExportedTypeMapFromGraph` in the main thread).
   * Downstream phases — including `crossFile` — receive it as a true
   * `ReadonlyMap`; `crossFile` builds its own mutable working copy locally
   * for per-file re-resolution writes, so this snapshot is never mutated
   * after parse returns.
   */
  readonly exportedTypeMap: ReadonlyMap<string, ReadonlyMap<string, string>>;
  readonly allFetchCalls: readonly ExtractedFetchCall[];
  readonly allExtractedRoutes: readonly ExtractedRoute[];
  readonly allDecoratorRoutes: readonly ExtractedDecoratorRoute[];
  readonly allToolDefs: readonly ExtractedToolDef[];
  readonly allORMQueries: readonly ExtractedORMQuery[];
  bindingAccumulator: BindingAccumulator;
  /** Resolution context from the parse phase — carries importMap, namedImportMap, etc. */
  resolutionContext: ReturnType<typeof createResolutionContext>;
  /** Parse-owned snapshot of all file paths for downstream phases. */
  readonly allPaths: readonly string[];
  /** Parse-owned snapshot of the path set for downstream phases. */
  readonly allPathSet: ReadonlySet<string>;
  /** Pass-through: total file count for progress reporting. */
  totalFiles: number;
  /**
   * True if the parse phase spawned a live worker pool for this run.
   * False means every chunk ran through the sequential fallback (skipWorkers,
   * thresholds not met, or pool-creation failure). Primarily a test affordance:
   * see `PipelineOptions.workerThresholdsForTest`.
   */
  readonly usedWorkerPool: boolean;
  /**
   * Releases large parse-owned collections once all parse consumers have run.
   * Scalar summary fields stay readable in the final phase-results map.
   */
  dispose?(): void | Promise<void>;
  /** Releases route/fetch extraction arrays once the routes phase has copied/consumed them. */
  releaseRouteExtractionData?(): void;
  /** Releases tool-definition extraction arrays once the tools phase has consumed them. */
  releaseToolDefinitions?(): void;
  /** Releases ORM extraction arrays once the ORM phase has consumed them. */
  releaseORMQueries?(): void;
}

function clearExportedTypeMap(map: Map<string, Map<string, string>>): void {
  for (const exportsForFile of map.values()) {
    exportsForFile.clear();
  }
  map.clear();
}

export const parsePhase: PipelinePhase<ParseOutput> = {
  name: 'parse',
  deps: ['structure', 'markdown', 'cobol'],

  async execute(
    ctx: PipelineContext,
    deps: ReadonlyMap<string, PhaseResult<unknown>>,
  ): Promise<ParseOutput> {
    const { scannedFiles, allPaths, totalFiles, skippedLargeFiles } =
      getPhaseOutput<StructureOutput>(deps, 'structure');

    let result: Awaited<ReturnType<typeof runChunkedParseAndResolve>>;
    let replayed = false;
    try {
      const replay = ctx.options?.scopeReplay;
      if (replay && (ctx.options?.profile ?? 'full') === 'full') {
        const checkRequest = () => {
          if (replay.request.signal?.aborted)
            throw new Error('scope-retention-parse-replay: cancelled');
          if (!Number.isFinite(replay.request.deadline))
            throw new Error('scope-retention-parse-replay: invalid request');
          if (Date.now() >= replay.request.deadline)
            throw new Error('scope-retention-parse-replay: deadline');
        };
        const disposeStaged = (
          staged: Awaited<ReturnType<typeof reconstructScopeRetentionParse>>,
        ) => {
          staged.allFetchCalls.length = 0;
          staged.allExtractedRoutes.length = 0;
          staged.allDecoratorRoutes.length = 0;
          staged.allToolDefs.length = 0;
          staged.allORMQueries.length = 0;
          clearExportedTypeMap(staged.exportedTypeMap);
          try {
            staged.resolutionContext.clear();
          } catch {
            /* Preserve the primary failure. */
          }
          try {
            staged.bindingAccumulator.dispose();
          } catch {
            /* Preserve the primary failure. */
          }
        };
        checkRequest();
        let admitted = false;
        try {
          await admitScopeRetentionParseReplay(
            replay.candidate,
            {
              repoPath: ctx.repoPath,
              allPaths,
              scannedFiles,
              skippedLargeFiles: skippedLargeFiles ?? [],
            },
            replay.request,
          );
          admitted = true;
        } catch {
          checkRequest();
        }
        if (admitted) {
          const stagedGraph = createKnowledgeGraph();
          for (const node of ctx.graph.iterNodes()) stagedGraph.addNode(structuredClone(node));
          for (const edge of ctx.graph.iterRelationships())
            stagedGraph.addRelationship(structuredClone(edge));
          let staged: Awaited<ReturnType<typeof reconstructScopeRetentionParse>> | undefined;
          try {
            staged = await reconstructScopeRetentionParse(
              replay.candidate.families,
              stagedGraph,
              ctx.onProgress,
            );
            checkRequest();
          } catch {
            if (staged) disposeStaged(staged);
            staged = undefined;
            checkRequest();
          }
          if (staged) {
            // Preservation is the commit boundary: its failures must propagate without parsing.
            try {
              await replay.preserve();
              checkRequest();
              for (const node of stagedGraph.iterNodes()) ctx.graph.addNode(node);
              for (const edge of stagedGraph.iterRelationships()) ctx.graph.addRelationship(edge);
              result = staged;
              replayed = true;
            } catch (error) {
              disposeStaged(staged);
              throw error;
            }
          }
        }
      }
      if (!replayed) {
        result = await runChunkedParseAndResolve(
          ctx.graph,
          scannedFiles,
          allPaths,
          totalFiles,
          ctx.repoPath,
          ctx.pipelineStart,
          ctx.onProgress,
          ctx.options,
          skippedLargeFiles,
        );
      }
    } finally {
      scannedFiles.length = 0;
    }

    const allPathsSnapshot = [...allPaths];
    const allPathSetSnapshot: ReadonlySet<string> = new Set(allPathsSnapshot);

    const releaseRouteExtractionData = () => {
      result.allFetchCalls.length = 0;
      result.allExtractedRoutes.length = 0;
      result.allDecoratorRoutes.length = 0;
    };
    const releaseToolDefinitions = () => {
      result.allToolDefs.length = 0;
    };
    const releaseORMQueries = () => {
      result.allORMQueries.length = 0;
    };

    const { scopeRetention, ...parseResult } = result;
    const releaseFailedResult = () => {
      for (const cleanup of [
        releaseRouteExtractionData,
        releaseToolDefinitions,
        releaseORMQueries,
        () => clearExportedTypeMap(result.exportedTypeMap),
        () => result.resolutionContext.clear(),
        () => result.bindingAccumulator.dispose(),
        () => {
          allPathsSnapshot.length = 0;
          (allPathSetSnapshot as Set<string>).clear();
        },
      ]) {
        try {
          cleanup();
        } catch {
          /* Preserve the primary failure. */
        }
      }
    };
    if (scopeRetention) {
      let failed = false;
      try {
        await ctx.options?.scopeRetention?.consume(scopeRetention);
      } catch (error) {
        failed = true;
        releaseFailedResult();
        throw error;
      } finally {
        try {
          await scopeRetention.dispose();
        } catch (error) {
          if (!failed) {
            releaseFailedResult();
            throw error;
          }
        }
      }
    }

    return {
      ...parseResult,
      parseMode: replayed ? 'retained-replay' : 'full',
      allPaths: allPathsSnapshot,
      allPathSet: allPathSetSnapshot,
      totalFiles,
      releaseRouteExtractionData,
      releaseToolDefinitions,
      releaseORMQueries,
      dispose: () => {
        releaseRouteExtractionData();
        releaseToolDefinitions();
        releaseORMQueries();
        allPathsSnapshot.length = 0;
        (allPathSetSnapshot as Set<string>).clear();
        clearExportedTypeMap(result.exportedTypeMap);
        result.resolutionContext.clear();
        result.bindingAccumulator.dispose();
      },
    };
  },
};
