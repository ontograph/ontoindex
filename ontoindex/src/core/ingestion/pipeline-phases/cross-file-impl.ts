/**
 * Cross-file binding propagation — extracted from pipeline.ts.
 *
 * Seeds downstream files with resolved type bindings from upstream exports.
 * Files are processed in topological import order so upstream bindings
 * are available when downstream files are re-resolved.
 *
 * @module
 */

import v8 from 'node:v8';
import {
  processCalls,
  buildImportedReturnTypeMaps,
  type ExportedTypeMap,
} from '../call-processor.js';
import type { createResolutionContext } from '../model/resolution-context.js';
import { createASTCache } from '../ast-cache.js';
import { type PipelineProgress, getLanguageFromFilename } from 'ontoindex-shared';
import { readFileContents } from '../filesystem-walker.js';
import { isLanguageAvailable } from '../../tree-sitter/parser-loader.js';
import { topologicalLevelSort } from '../utils/graph-sort.js';
import type { KnowledgeGraph } from '../../graph/types.js';
import { isDev } from '../utils/env.js';
import type { PipelineOptions } from '../pipeline.js';

/** Max AST trees to keep in LRU cache for cross-file binding propagation. */
const AST_CACHE_CAP = 50;

/** Minimum percentage of files that must benefit from cross-file seeding. */
const CROSS_FILE_SKIP_THRESHOLD = 0.03;
/** Hard cap on files re-processed during cross-file propagation. */
const MAX_CROSS_FILE_REPROCESS = 2000;
const CROSS_FILE_SLOW_FILE_LIMIT = 10;

type CrossFileTelemetry = NonNullable<PipelineOptions['onTelemetry']>;

interface CrossFileFileTiming {
  filePath: string;
  language?: string;
  durationMs: number;
  seededBindings: number;
  importedReturnTypes: number;
  importedRawReturnTypes: number;
}

/**
 * Cross-file binding propagation.
 * Returns the number of files re-processed.
 */
export async function runCrossFileBindingPropagation(
  graph: KnowledgeGraph,
  ctx: ReturnType<typeof createResolutionContext>,
  parseExportedTypeMap: ReadonlyMap<string, ReadonlyMap<string, string>>,
  allPathSet: ReadonlySet<string>,
  totalFiles: number,
  repoPath: string,
  pipelineStart: number,
  onProgress: (progress: PipelineProgress) => void,
  onTelemetry?: CrossFileTelemetry,
): Promise<number> {
  if (parseExportedTypeMap.size === 0 || ctx.namedImportMap.size === 0) return 0;

  // Build a local mutable working copy. Per-file re-resolution below mutates
  // this map (each `processCalls` writes that file's exports back into it so
  // later iterations in the same level/loop can resolve transitive bindings).
  // Owning a local copy here keeps `ParseOutput.exportedTypeMap` truly
  // read-only at the phase boundary — no cast, no shared-mutable handoff.
  const exportedTypeMap: ExportedTypeMap = new Map();
  for (const [fp, exports] of parseExportedTypeMap) {
    exportedTypeMap.set(fp, new Map(exports));
  }

  const { levels, cycleCount } = topologicalLevelSort(ctx.importMap);

  if (isDev && cycleCount > 0) {
    console.log(`🔄 ${cycleCount} files in import cycles (processed last in undefined order)`);
  }

  let filesWithGaps = 0;
  const gapThreshold = Math.max(1, Math.ceil(totalFiles * CROSS_FILE_SKIP_THRESHOLD));
  outer: for (const level of levels) {
    for (const filePath of level) {
      const imports = ctx.namedImportMap.get(filePath);
      if (!imports) continue;
      for (const [, binding] of imports) {
        const upstream = exportedTypeMap.get(binding.sourcePath);
        if (upstream?.has(binding.exportedName)) {
          filesWithGaps++;
          break;
        }
        const def = ctx.model.symbols.lookupExactFull(binding.sourcePath, binding.exportedName);
        if (def?.returnType) {
          filesWithGaps++;
          break;
        }
      }
      if (filesWithGaps >= gapThreshold) break outer;
    }
  }

  const gapRatio = totalFiles > 0 ? filesWithGaps / totalFiles : 0;
  emitCrossFileTelemetry(graph, pipelineStart, onTelemetry, 'cross-file-plan', {
    crossFileFilesWithGaps: filesWithGaps,
    crossFileGapRatio: gapRatio,
    crossFileLevelCount: levels.length,
    crossFileCycleCount: cycleCount,
    crossFileMaxReprocess: MAX_CROSS_FILE_REPROCESS,
  });

  if (gapRatio < CROSS_FILE_SKIP_THRESHOLD && filesWithGaps < gapThreshold) {
    if (isDev) {
      console.log(
        `⏭️ Cross-file re-resolution skipped (${filesWithGaps}/${totalFiles} files, ${(gapRatio * 100).toFixed(1)}% < ${CROSS_FILE_SKIP_THRESHOLD * 100}% threshold)`,
      );
    }
    return 0;
  }

  // Intentionally reports `phase: 'parsing'` rather than a separate
  // 'crossFile' phase: cross-file re-resolution is logically a continuation of
  // the parsing/resolution work and is bucketed under "parsing" in any
  // telemetry that groups events by phase name. Kept consistent with the
  // upstream `parse` phase's progress events so the UI shows one continuous
  // progress segment instead of a phase flicker. If a future change splits
  // this out into its own phase, also rename `parse-impl.ts` per-chunk
  // progress events accordingly.
  onProgress({
    phase: 'parsing',
    percent: 82,
    message: `Cross-file type propagation (${filesWithGaps}+ files)...`,
    stats: { filesProcessed: totalFiles, totalFiles, nodesCreated: graph.nodeCount },
  });

  let crossFileResolved = 0;
  const crossFileStart = Date.now();
  const astCache = createASTCache(AST_CACHE_CAP);
  const fileTimings: CrossFileFileTiming[] = [];

  for (const level of levels) {
    const levelCandidates: {
      filePath: string;
      language: string;
      seeded: Map<string, string>;
      importedReturns: ReadonlyMap<string, string>;
      importedRawReturns: ReadonlyMap<string, string>;
    }[] = [];
    for (const filePath of level) {
      if (crossFileResolved + levelCandidates.length >= MAX_CROSS_FILE_REPROCESS) break;
      const imports = ctx.namedImportMap.get(filePath);
      if (!imports) continue;

      const seeded = new Map<string, string>();
      for (const [localName, binding] of imports) {
        const upstream = exportedTypeMap.get(binding.sourcePath);
        if (upstream) {
          const type = upstream.get(binding.exportedName);
          if (type) seeded.set(localName, type);
        }
      }

      const { importedReturnTypes: importedReturns, importedRawReturnTypes: importedRawReturns } =
        buildImportedReturnTypeMaps(filePath, ctx.namedImportMap, ctx.model.symbols);
      if (seeded.size === 0 && importedReturns.size === 0) continue;
      if (!allPathSet.has(filePath)) continue;

      const lang = getLanguageFromFilename(filePath);
      if (!lang || !isLanguageAvailable(lang)) continue;

      levelCandidates.push({
        filePath,
        language: lang,
        seeded,
        importedReturns,
        importedRawReturns,
      });
    }

    if (levelCandidates.length === 0) continue;

    const levelPaths = levelCandidates.map((c) => c.filePath);
    const contentMap = await readFileContents(repoPath, levelPaths);

    for (const {
      filePath,
      language,
      seeded,
      importedReturns,
      importedRawReturns,
    } of levelCandidates) {
      const content = contentMap.get(filePath);
      if (!content) continue;

      const reFile = [{ path: filePath, content }];
      const bindings = new Map<string, ReadonlyMap<string, string>>();
      if (seeded.size > 0) bindings.set(filePath, seeded);

      const importedReturnTypesMap = new Map<string, ReadonlyMap<string, string>>();
      if (importedReturns.size > 0) {
        importedReturnTypesMap.set(filePath, importedReturns);
      }

      const importedRawReturnTypesMap = new Map<string, ReadonlyMap<string, string>>();
      if (importedRawReturns.size > 0) {
        importedRawReturnTypesMap.set(filePath, importedRawReturns);
      }

      const fileStart = Date.now();
      await processCalls(
        graph,
        reFile,
        astCache,
        ctx,
        undefined,
        exportedTypeMap,
        bindings.size > 0 ? bindings : undefined,
        importedReturnTypesMap.size > 0 ? importedReturnTypesMap : undefined,
        importedRawReturnTypesMap.size > 0 ? importedRawReturnTypesMap : undefined,
      );
      fileTimings.push({
        filePath,
        language,
        durationMs: Date.now() - fileStart,
        seededBindings: seeded.size,
        importedReturnTypes: importedReturns.size,
        importedRawReturnTypes: importedRawReturns.size,
      });
      crossFileResolved++;
    }

    if (crossFileResolved >= MAX_CROSS_FILE_REPROCESS) {
      if (isDev)
        console.log(`⚠️ Cross-file re-resolution capped at ${MAX_CROSS_FILE_REPROCESS} files`);
      break;
    }
  }

  astCache.clear();

  emitCrossFileTelemetry(graph, pipelineStart, onTelemetry, 'cross-file-slowest-files', {
    slowCrossFileFiles: fileTimings
      .sort((a, b) => b.durationMs - a.durationMs)
      .slice(0, CROSS_FILE_SLOW_FILE_LIMIT),
  });

  if (isDev) {
    const elapsed = Date.now() - crossFileStart;
    const totalElapsed = Date.now() - pipelineStart;
    const reResolutionPct = totalElapsed > 0 ? ((elapsed / totalElapsed) * 100).toFixed(1) : '0';
    console.log(
      `🔗 Cross-file re-resolution: ${crossFileResolved} candidates re-processed` +
        ` in ${elapsed}ms (${reResolutionPct}% of total ingestion time so far)`,
    );
  }

  return crossFileResolved;
}

function emitCrossFileTelemetry(
  graph: KnowledgeGraph,
  pipelineStart: number,
  onTelemetry: CrossFileTelemetry | undefined,
  event: 'cross-file-plan' | 'cross-file-slowest-files',
  details: Pick<
    Parameters<CrossFileTelemetry>[0],
    | 'crossFileFilesWithGaps'
    | 'crossFileGapRatio'
    | 'crossFileLevelCount'
    | 'crossFileCycleCount'
    | 'crossFileMaxReprocess'
    | 'slowCrossFileFiles'
  >,
): void {
  if (!onTelemetry) return;
  const memory = process.memoryUsage();
  const heap = v8.getHeapStatistics();
  try {
    onTelemetry({
      event,
      phaseName: 'crossFile',
      elapsedMs: Date.now() - pipelineStart,
      rssBytes: memory.rss,
      heapUsedBytes: memory.heapUsed,
      heapTotalBytes: memory.heapTotal,
      heapLimitBytes: heap.heap_size_limit,
      graphNodes: graph.nodeCount,
      graphRelationships: graph.relationshipCount,
      ...details,
    });
  } catch {
    // Telemetry must never change pipeline behavior.
  }
}
