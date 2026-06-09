/**
 * Parse implementation — chunked parse + resolve loop.
 *
 * This is the core parsing engine of the ingestion pipeline. It reads
 * source files in byte-budget chunks (~20MB each), parses via worker
 * pool (or sequential fallback), resolves imports/calls/heritage per
 * chunk, and synthesizes wildcard import bindings.
 *
 * Consumed by the parse phase (`parse.ts`) — the phase file handles
 * dependency wiring while the heavy implementation lives here.
 *
 * @module
 */

import {
  BindingAccumulator,
  enrichExportedTypeMap,
  type BindingEntry,
} from '../binding-accumulator.js';
import {
  processParsing,
  PARSE_WORKER_RECOVERY_WINDOW_SIZE,
  PARSE_WORKER_RETRY_POLICY_QUARANTINE,
  PARSE_WORKER_RETRY_POLICY_SEQUENTIAL,
  type ParseWorkerRetryPolicy,
} from '../parsing-processor.js';
import {
  processImports,
  processImportsFromExtracted,
  buildImportResolutionContext,
} from '../import-processor.js';
import { EMPTY_INDEX } from '../import-resolvers/utils.js';
import {
  processCalls,
  processCallsFromExtracted,
  seedCrossFileReceiverTypes,
  buildExportedTypeMapFromGraph,
  type ExportedTypeMap,
} from '../call-processor.js';
import { processRoutesFromExtracted } from '../call-resolution/route-processor.js';
import { processAssignmentsFromExtracted } from '../call-resolution/assignment-processor.js';
import { buildHeritageMap } from '../model/heritage-map.js';
import {
  processHeritage,
  processHeritageFromExtracted,
  extractExtractedHeritageFromFiles,
  getHeritageStrategyForLanguage,
} from '../heritage-processor.js';
import { createResolutionContext } from '../model/resolution-context.js';
import { createASTCache } from '../ast-cache.js';
import { type PipelineProgress, getLanguageFromFilename } from 'ontoindex-shared';
import { readFileContents } from '../filesystem-walker.js';
import { isLanguageAvailable } from '../../tree-sitter/parser-loader.js';
import { createWorkerPool, WORKER_SUB_BATCH_SIZE } from '../workers/worker-pool.js';
import type { WorkerIsolationMode, WorkerPool } from '../workers/worker-pool.js';
import type {
  ExtractedAssignment,
  ExtractedCall,
  ExtractedDecoratorRoute,
  ExtractedFetchCall,
  ExtractedORMQuery,
  ExtractedRoute,
  ExtractedToolDef,
  FileConstructorBindings,
} from '../workers/parse-worker.js';
import type { ExtractedHeritage } from '../model/heritage-map.js';
import type { KnowledgeGraph } from '../../graph/types.js';
import type { PipelineOptions } from '../pipeline.js';
import { extractFetchCallsFromFiles } from '../call-processor.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import v8 from 'node:v8';

import { isDev } from '../utils/env.js';
import { synthesizeWildcardImportBindings, needsSynthesis } from './wildcard-synthesis.js';
import { extractORMQueriesInline } from './orm-extraction.js';
import { getActiveORMClientIdentifiers } from '../../../analysis-packs/execution.js';

// ── Constants ──────────────────────────────────────────────────────────────

/** Max bytes of source content to load per parse chunk. */
const CHUNK_BYTE_BUDGET = 50 * 1024 * 1024; // 50MB
const LARGE_REPO_SINGLE_WORKER_THRESHOLD_BYTES = 100 * 1024 * 1024;
const LARGE_REPO_DEGRADED_PARSE_THRESHOLD_BYTES = 180 * 1024 * 1024;
const MAX_PARSE_TIMING_REPORTS = 10;

// ── Main parse + resolve function ──────────────────────────────────────────

type ScannedFile = { path: string; size: number };
type ProgressFn = (progress: PipelineProgress) => void;
type ChunkWorkerData = NonNullable<Awaited<ReturnType<typeof processParsing>>>;
type FileTiming = {
  filePath: string;
  language?: string;
  durationMs: number;
  status: 'processed' | 'skipped' | 'error';
};
type ExtractorTiming = {
  family: string;
  filePath?: string;
  language?: string;
  durationMs: number;
  count?: number;
};

class JsonlStage<T> {
  private dirPath: string | undefined;
  private filePath: string | undefined;
  private count = 0;

  constructor(private readonly name: string) {}

  async append(items: readonly T[]): Promise<void> {
    if (items.length === 0) return;

    if (!this.filePath) {
      this.dirPath = await fs.promises.mkdtemp(path.join(os.tmpdir(), `ontoindex-${this.name}-`));
      this.filePath = path.join(this.dirPath, 'stage.jsonl');
    }

    await fs.promises.appendFile(
      this.filePath,
      items.map((item) => JSON.stringify(item)).join('\n') + '\n',
      'utf8',
    );
    this.count += items.length;
  }

  async drain(): Promise<T[]> {
    if (!this.filePath || this.count === 0) return [];

    const content = await fs.promises.readFile(this.filePath, 'utf8');
    const items: T[] = [];
    for (const line of content.split('\n')) {
      if (line.length === 0) continue;
      items.push(JSON.parse(line) as T);
    }
    return items;
  }

  async dispose(): Promise<void> {
    if (!this.dirPath) return;
    await fs.promises.rm(this.dirPath, { recursive: true, force: true });
    this.dirPath = undefined;
    this.filePath = undefined;
    this.count = 0;
  }
}

function trackSlowTiming<T extends { durationMs: number }>(slowTimings: T[], timing: T): void {
  if (slowTimings.length < MAX_PARSE_TIMING_REPORTS) {
    slowTimings.push(timing);
    return;
  }

  let minIndex = 0;
  for (let i = 1; i < slowTimings.length; i++) {
    if (slowTimings[i].durationMs < slowTimings[minIndex].durationMs) minIndex = i;
  }
  if (timing.durationMs > slowTimings[minIndex].durationMs) {
    slowTimings[minIndex] = timing;
  }
}

function getSlowTimings<T extends { durationMs: number }>(slowTimings: readonly T[]): T[] {
  return [...slowTimings].sort((a, b) => b.durationMs - a.durationMs).slice(0, 10);
}

async function disposeJsonlStages(stages: readonly { dispose(): Promise<void> }[]): Promise<void> {
  await Promise.all(stages.map((stage) => stage.dispose()));
}

function readEnvKilobytes(name: string, defaultBytes: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === '') return defaultBytes;

  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return defaultBytes;
  return Math.floor(value * 1024);
}

function readOptionalEnvKilobytes(name: string): number | null {
  const raw = process.env[name];
  if (raw == null || raw.trim() === '') return null;

  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.floor(value * 1024);
}

function getLargeRepoParseMaxFileBytes(totalParseableBytes: number): number | null {
  const minTotalBytes = readEnvKilobytes(
    'ONTOINDEX_LARGE_REPO_PARSE_CAP_MIN_KB',
    LARGE_REPO_SINGLE_WORKER_THRESHOLD_BYTES,
  );
  if (totalParseableBytes < minTotalBytes) return null;

  const maxFileBytes = readOptionalEnvKilobytes('ONTOINDEX_LARGE_REPO_PARSE_MAX_FILE_KB');
  if (maxFileBytes === null) return null;
  return maxFileBytes > 0 ? maxFileBytes : null;
}

function emitParseTelemetry(
  options: PipelineOptions | undefined,
  graph: KnowledgeGraph,
  pipelineStart: number,
  event:
    | 'parse-plan'
    | 'parse-chunk-start'
    | 'parse-chunk-end'
    | 'parse-sub-batch-start'
    | 'parse-worker-result'
    | 'parse-degraded-files'
    | 'parse-slowest-files'
    | 'parse-slowest-extractors',
  details: {
    durationMs?: number;
    chunkIndex?: number;
    chunkCount?: number;
    chunkFiles?: number;
    chunkBytes?: number;
    chunkByteBudget?: number;
    totalParseableFiles?: number;
    totalParseableBytes?: number;
    workerPoolSize?: number;
    usedWorkerPool?: boolean;
    subBatchSize?: number;
    subBatchIndex?: number;
    workerIndex?: number;
    workerChunkSize?: number;
    payloadBytes?: number;
    resultBytes?: number;
    resultCounts?: Record<string, number>;
    workerIsolation?: WorkerIsolationMode;
    workerStartupDurationMs?: number;
    workerStartupDurationsMs?: readonly number[];
    parseWorkerRetryPolicy?: ParseWorkerRetryPolicy;
    parseWorkerRecoveryWindowSize?: number;
    firstFilePath?: string;
    lastFilePath?: string;
    degradedReason?: string;
    degradedAction?:
      | 'quarantine-files'
      | 'skip-remaining'
      | 'large-file-cap'
      | 'lightweight-fallback';
    degradedFiles?: {
      filePath: string;
      reason: string;
    }[];
    slowFiles?: {
      filePath: string;
      language?: string;
      durationMs: number;
      status: 'processed' | 'skipped' | 'error';
    }[];
    slowExtractors?: {
      family: string;
      language?: string;
      filePath?: string;
      durationMs: number;
      count?: number;
    }[];
  },
): void {
  const onTelemetry = options?.onTelemetry;
  if (!onTelemetry) return;

  const memory = process.memoryUsage();
  const heap = v8.getHeapStatistics();
  try {
    onTelemetry({
      event,
      phaseName: 'parse',
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
    // Telemetry must never change parse behavior.
  }
}

function clearChunkWorkerData(data: ChunkWorkerData): void {
  data.imports.length = 0;
  data.calls.length = 0;
  data.assignments.length = 0;
  data.heritage.length = 0;
  data.routes.length = 0;
  data.fetchCalls.length = 0;
  data.decoratorRoutes.length = 0;
  data.toolDefs.length = 0;
  data.ormQueries.length = 0;
  data.constructorBindings.length = 0;
  data.fileScopeBindings.length = 0;
  data.fileTimings.length = 0;
  data.extractorTimings.length = 0;
  data.parsedFiles.length = 0;
  data.degraded = undefined;
}

/**
 * Chunked parse + resolve loop.
 *
 * Reads source in byte-budget chunks (~20MB each). For each chunk:
 * 1. Parse via worker pool (or sequential fallback)
 * 2. Resolve imports from extracted data
 * 3. Synthesize wildcard import bindings (Go/Ruby/C++/Swift/Python)
 * 4. Resolve heritage + routes per chunk; defer worker CALLS until all chunks
 *    have contributed heritage so interface-dispatch implementor map is complete
 * 5. Collect TypeEnv bindings for cross-file propagation
 */
export async function runChunkedParseAndResolve(
  graph: KnowledgeGraph,
  scannedFiles: ScannedFile[],
  allPaths: string[],
  totalFiles: number,
  repoPath: string,
  pipelineStart: number,
  onProgress: ProgressFn,
  options?: PipelineOptions,
): Promise<{
  exportedTypeMap: ExportedTypeMap;
  allFetchCalls: ExtractedFetchCall[];
  allExtractedRoutes: ExtractedRoute[];
  allDecoratorRoutes: ExtractedDecoratorRoute[];
  allToolDefs: ExtractedToolDef[];
  allORMQueries: ExtractedORMQuery[];
  bindingAccumulator: BindingAccumulator;
  resolutionContext: ReturnType<typeof createResolutionContext>;
  usedWorkerPool: boolean;
}> {
  const ctx = createResolutionContext();
  const symbolTable = ctx.model.symbols;

  let parseableScanned = scannedFiles.filter((f) => {
    const lang = getLanguageFromFilename(f.path);
    return lang && isLanguageAvailable(lang);
  });

  const uncappedParseableBytes = parseableScanned.reduce((sum, file) => sum + file.size, 0);
  const largeRepoParseMaxFileBytes = getLargeRepoParseMaxFileBytes(uncappedParseableBytes);
  if (largeRepoParseMaxFileBytes !== null) {
    const exceedsCap = parseableScanned.filter((file) => file.size > largeRepoParseMaxFileBytes);
    if (exceedsCap.length > 0) {
      const cappedPaths = new Set(exceedsCap.map((file) => file.path));
      console.warn(
        `Using lightweight fallback for ${exceedsCap.length} large parseable file(s) (>${Math.round(
          largeRepoParseMaxFileBytes / 1024,
        )}KB) due to large-repo parse budget. Set ONTOINDEX_LARGE_REPO_PARSE_MAX_FILE_KB=0 for full parsing.`,
      );
      emitParseTelemetry(options, graph, pipelineStart, 'parse-degraded-files', {
        chunkFiles: exceedsCap.length,
        degradedReason: 'large-repo-parse-file-size-cap',
        degradedAction: 'lightweight-fallback',
        degradedFiles: exceedsCap.slice(0, 100).map((file) => ({
          filePath: file.path,
          reason: `file exceeds large-repo parse cap (${file.size} bytes > ${largeRepoParseMaxFileBytes} bytes); falling back to regex extraction`,
        })),
      });
      parseableScanned = parseableScanned.filter((file) => !cappedPaths.has(file.path));
    }
  }

  // Warn about files skipped due to unavailable parsers
  const skippedByLang = new Map<string, number>();
  for (const f of scannedFiles) {
    const lang = getLanguageFromFilename(f.path);
    if (lang && !isLanguageAvailable(lang)) {
      skippedByLang.set(lang, (skippedByLang.get(lang) || 0) + 1);
    }
  }
  for (const [lang, count] of skippedByLang) {
    console.warn(
      `Skipping ${count} ${lang} file(s) — ${lang} parser not available (native binding may not have built). Try: npm rebuild tree-sitter-${lang}`,
    );
  }

  const totalParseable = parseableScanned.length;

  if (totalParseable === 0) {
    onProgress({
      phase: 'parsing',
      percent: 82,
      message: 'No parseable files found — skipping parsing phase',
      stats: { filesProcessed: 0, totalFiles: 0, nodesCreated: graph.nodeCount },
    });
  }

  // Build byte-budget chunks
  const chunks: string[][] = [];
  let currentChunk: string[] = [];
  let currentBytes = 0;
  for (const file of parseableScanned) {
    if (currentChunk.length > 0 && currentBytes + file.size > CHUNK_BYTE_BUDGET) {
      chunks.push(currentChunk);
      currentChunk = [];
      currentBytes = 0;
    }
    currentChunk.push(file.path);
    currentBytes += file.size;
  }
  if (currentChunk.length > 0) chunks.push(currentChunk);

  const numChunks = chunks.length;

  if (isDev) {
    const totalMB = parseableScanned.reduce((s, f) => s + f.size, 0) / (1024 * 1024);
    console.log(
      `📂 Scan: ${totalFiles} paths, ${totalParseable} parseable (${totalMB.toFixed(0)}MB), ${numChunks} chunks @ ${CHUNK_BYTE_BUDGET / (1024 * 1024)}MB budget`,
    );
  }

  onProgress({
    phase: 'parsing',
    percent: 20,
    message: `Parsing ${totalParseable} files in ${numChunks} chunk${numChunks !== 1 ? 's' : ''}...`,
    stats: { filesProcessed: 0, totalFiles: totalParseable, nodesCreated: graph.nodeCount },
  });

  // Don't spawn workers for tiny repos — overhead exceeds benefit.
  // Test suites may lower the thresholds via `options.workerThresholdsForTest`
  // to exercise the worker-pool path with small fixtures; see PipelineOptions.
  const MIN_FILES_FOR_WORKERS = options?.workerThresholdsForTest?.minFiles ?? 15;
  const MIN_BYTES_FOR_WORKERS = options?.workerThresholdsForTest?.minBytes ?? 512 * 1024;
  const totalBytes = parseableScanned.reduce((s, f) => s + f.size, 0);
  const sizeByPath = new Map(parseableScanned.map((file) => [file.path, file.size]));
  const requestedWorkerIsolation = process.env.ONTOINDEX_PARSE_WORKER_ISOLATION;
  const workerIsolation: WorkerIsolationMode =
    requestedWorkerIsolation === 'thread' || requestedWorkerIsolation === 'process'
      ? requestedWorkerIsolation
      : totalBytes >= LARGE_REPO_DEGRADED_PARSE_THRESHOLD_BYTES
        ? 'process'
        : 'thread';
  const workerFailureMode: ParseWorkerRetryPolicy =
    totalBytes >= LARGE_REPO_SINGLE_WORKER_THRESHOLD_BYTES
      ? PARSE_WORKER_RETRY_POLICY_QUARANTINE
      : PARSE_WORKER_RETRY_POLICY_SEQUENTIAL;
  const largeRepoSafeMode =
    totalBytes >= LARGE_REPO_DEGRADED_PARSE_THRESHOLD_BYTES &&
    process.env.ONTOINDEX_DISABLE_LARGE_REPO_PARSE === '1' &&
    process.env.ONTOINDEX_ENABLE_LARGE_REPO_PARSE !== '1';

  // Create worker pool once, reuse across chunks
  let workerPool: WorkerPool | undefined;
  if (
    !largeRepoSafeMode &&
    !options?.skipWorkers &&
    (totalParseable >= MIN_FILES_FOR_WORKERS || totalBytes >= MIN_BYTES_FOR_WORKERS)
  ) {
    try {
      let workerUrl = new URL('../workers/parse-worker.js', import.meta.url);
      // When running under vitest, import.meta.url points to src/ where no .js exists.
      // Fall back to the compiled dist/ worker so the pool can spawn real worker threads.
      const thisDir = fileURLToPath(new URL('.', import.meta.url));
      if (!fs.existsSync(fileURLToPath(workerUrl))) {
        const distWorker = path.resolve(
          thisDir,
          '..',
          '..',
          '..',
          '..',
          'dist',
          'core',
          'ingestion',
          'workers',
          'parse-worker.js',
        );
        if (fs.existsSync(distWorker)) {
          workerUrl = pathToFileURL(distWorker);
        }
      }
      const forcedWorkerCount = process.env.ONTOINDEX_MAX_WORKERS;
      const poolSize =
        !forcedWorkerCount &&
        workerIsolation === 'thread' &&
        totalBytes >= LARGE_REPO_SINGLE_WORKER_THRESHOLD_BYTES
          ? 1
          : undefined;
      workerPool = createWorkerPool(workerUrl, poolSize, { isolation: workerIsolation });
    } catch (err) {
      console.warn(
        'Worker pool creation failed, using sequential fallback:',
        (err as Error).message,
      );
    }
  }

  emitParseTelemetry(options, graph, pipelineStart, 'parse-plan', {
    chunkCount: numChunks,
    chunkByteBudget: CHUNK_BYTE_BUDGET,
    totalParseableFiles: totalParseable,
    totalParseableBytes: totalBytes,
    workerPoolSize: workerPool?.size ?? 0,
    usedWorkerPool: workerPool !== undefined,
    workerIsolation: workerPool ? workerIsolation : undefined,
    workerStartupDurationMs: workerPool?.startupDurationMs,
    workerStartupDurationsMs: workerPool?.workerStartupDurationsMs,
    parseWorkerRetryPolicy: workerFailureMode,
    parseWorkerRecoveryWindowSize: PARSE_WORKER_RECOVERY_WINDOW_SIZE,
    subBatchSize: workerPool ? WORKER_SUB_BATCH_SIZE : undefined,
  });

  let filesParsedSoFar = 0;

  // AST cache sized for one chunk (sequential fallback uses it for import/call/heritage)
  const maxChunkFiles = chunks.reduce((max, c) => Math.max(max, c.length), 0);
  let astCache = createASTCache(maxChunkFiles);

  // Build import resolution context once — suffix index, file lists, resolve cache.
  const importCtx = buildImportResolutionContext(allPaths);
  const allPathObjects = allPaths.map((p) => ({ path: p }));

  const sequentialChunkPaths: string[][] = [];
  const chunkNeedsSynthesis = chunks.map((paths) =>
    paths.some((p) => {
      const lang = getLanguageFromFilename(p);
      return lang != null && needsSynthesis(lang);
    }),
  );
  const exportedTypeMap: ExportedTypeMap = new Map();
  const bindingAccumulator = new BindingAccumulator();
  // Tracks whether per-chunk or fallback wildcard-binding synthesis already
  // ran, so the unconditional final call below can be skipped when redundant.
  // synthesizeWildcardImportBindings is graph-global; once any chunk runs it
  // after parsing wildcard files, later non-wildcard chunks add no work for
  // it, and later wildcard chunks re-run it themselves.
  let hasSynthesized = false;
  const fetchCallStage = new JsonlStage<ExtractedFetchCall>('parse-fetch-calls');
  const extractedRouteStage = new JsonlStage<ExtractedRoute>('parse-routes');
  const decoratorRouteStage = new JsonlStage<ExtractedDecoratorRoute>('parse-decorator-routes');
  const toolDefStage = new JsonlStage<ExtractedToolDef>('parse-tool-defs');
  const ormQueryStage = new JsonlStage<ExtractedORMQuery>('parse-orm-queries');
  const extractedDataStages = [
    fetchCallStage,
    extractedRouteStage,
    decoratorRouteStage,
    toolDefStage,
    ormQueryStage,
  ] as const;
  const slowFileTimings: FileTiming[] = [];
  const slowExtractorTimings: ExtractorTiming[] = [];
  const ormClientIdentifiers = await getActiveORMClientIdentifiers(repoPath);
  const deferredWorkerCalls: ExtractedCall[] = [];
  const deferredWorkerHeritage: ExtractedHeritage[] = [];
  const deferredConstructorBindings: FileConstructorBindings[] = [];
  const deferredAssignments: ExtractedAssignment[] = [];
  let skipRemainingParseChunksReason: string | undefined = largeRepoSafeMode
    ? `Large-repo safe mode skipped parse for ${totalParseable} files / ${totalBytes} bytes. Set ONTOINDEX_ENABLE_LARGE_REPO_PARSE=1 to force parser execution.`
    : undefined;
  if (skipRemainingParseChunksReason) {
    console.warn(skipRemainingParseChunksReason);
  }

  let workerParseCompleted = false;
  try {
    for (let chunkIdx = 0; chunkIdx < numChunks; chunkIdx++) {
      const chunkPaths = chunks[chunkIdx];
      const chunkBytes = chunkPaths.reduce((sum, p) => sum + (sizeByPath.get(p) ?? 0), 0);
      const chunkStarted = Date.now();
      emitParseTelemetry(options, graph, pipelineStart, 'parse-chunk-start', {
        chunkIndex: chunkIdx + 1,
        chunkCount: numChunks,
        chunkFiles: chunkPaths.length,
        chunkBytes,
        chunkByteBudget: CHUNK_BYTE_BUDGET,
        workerPoolSize: workerPool?.size ?? 0,
        usedWorkerPool: workerPool !== undefined,
        workerIsolation: workerPool ? workerIsolation : undefined,
        workerStartupDurationMs: workerPool?.startupDurationMs,
        workerStartupDurationsMs: workerPool?.workerStartupDurationsMs,
        parseWorkerRetryPolicy: workerFailureMode,
        parseWorkerRecoveryWindowSize: PARSE_WORKER_RECOVERY_WINDOW_SIZE,
        subBatchSize: workerPool ? WORKER_SUB_BATCH_SIZE : undefined,
        firstFilePath: chunkPaths[0],
        lastFilePath: chunkPaths[chunkPaths.length - 1],
      });

      if (skipRemainingParseChunksReason) {
        for (const filePath of chunkPaths) {
          trackSlowTiming(slowFileTimings, {
            filePath,
            language: getLanguageFromFilename(filePath) ?? undefined,
            durationMs: 0,
            status: 'skipped',
          });
        }
        emitParseTelemetry(options, graph, pipelineStart, 'parse-degraded-files', {
          chunkIndex: chunkIdx + 1,
          chunkCount: numChunks,
          chunkFiles: chunkPaths.length,
          chunkBytes,
          chunkByteBudget: CHUNK_BYTE_BUDGET,
          workerPoolSize: workerPool?.size ?? 0,
          usedWorkerPool: workerPool !== undefined,
          workerIsolation: workerPool ? workerIsolation : undefined,
          workerStartupDurationMs: workerPool?.startupDurationMs,
          workerStartupDurationsMs: workerPool?.workerStartupDurationsMs,
          parseWorkerRetryPolicy: workerFailureMode,
          parseWorkerRecoveryWindowSize: PARSE_WORKER_RECOVERY_WINDOW_SIZE,
          degradedReason: skipRemainingParseChunksReason,
          degradedAction: 'skip-remaining',
          degradedFiles: chunkPaths.slice(0, 25).map((filePath) => ({
            filePath,
            reason: skipRemainingParseChunksReason,
          })),
        });
        filesParsedSoFar += chunkPaths.length;
        emitParseTelemetry(options, graph, pipelineStart, 'parse-chunk-end', {
          durationMs: Date.now() - chunkStarted,
          chunkIndex: chunkIdx + 1,
          chunkCount: numChunks,
          chunkFiles: chunkPaths.length,
          chunkBytes,
          chunkByteBudget: CHUNK_BYTE_BUDGET,
          workerPoolSize: 0,
          usedWorkerPool: false,
          firstFilePath: chunkPaths[0],
          lastFilePath: chunkPaths[chunkPaths.length - 1],
        });
        continue;
      }

      const chunkContents = await readFileContents(repoPath, chunkPaths);
      const chunkFiles = chunkPaths
        .filter((p) => chunkContents.has(p))
        .map((p) => ({ path: p, content: chunkContents.get(p)! }));
      const chunkFileCount = chunkFiles.length;

      const chunkWorkerData = await processParsing(
        graph,
        chunkFiles,
        repoPath,
        symbolTable,
        astCache,
        (current, _total, filePath) => {
          const globalCurrent = filesParsedSoFar + current;
          const parsingProgress = 20 + (globalCurrent / totalParseable) * 62;
          onProgress({
            phase: 'parsing',
            percent: Math.round(parsingProgress),
            message: `Parsing chunk ${chunkIdx + 1}/${numChunks}...`,
            detail: filePath,
            stats: {
              filesProcessed: globalCurrent,
              totalFiles: totalParseable,
              nodesCreated: graph.nodeCount,
            },
          });
        },
        workerPool,
        (event) => {
          emitParseTelemetry(options, graph, pipelineStart, 'parse-sub-batch-start', {
            chunkIndex: chunkIdx + 1,
            chunkCount: numChunks,
            chunkFiles: chunkPaths.length,
            chunkBytes,
            chunkByteBudget: CHUNK_BYTE_BUDGET,
            workerPoolSize: workerPool?.size ?? 0,
            usedWorkerPool: workerPool !== undefined,
            workerIsolation: workerPool ? workerIsolation : undefined,
            workerStartupDurationsMs: workerPool?.workerStartupDurationsMs,
            parseWorkerRetryPolicy: workerFailureMode,
            parseWorkerRecoveryWindowSize: PARSE_WORKER_RECOVERY_WINDOW_SIZE,
            subBatchSize: event.subBatchSize,
            subBatchIndex: event.subBatchIndex,
            workerIndex: event.workerIndex,
            workerChunkSize: event.workerChunkSize,
            workerStartupDurationMs: event.workerStartupDurationMs,
            payloadBytes: event.payloadBytes,
            firstFilePath: event.firstFilePath,
            lastFilePath: event.lastFilePath,
          });
        },
        options?.onTelemetry
          ? (event) => {
              emitParseTelemetry(options, graph, pipelineStart, 'parse-worker-result', {
                chunkIndex: chunkIdx + 1,
                chunkCount: numChunks,
                chunkFiles: chunkPaths.length,
                chunkBytes,
                chunkByteBudget: CHUNK_BYTE_BUDGET,
                workerPoolSize: workerPool?.size ?? 0,
                usedWorkerPool: workerPool !== undefined,
                workerIsolation: workerPool ? workerIsolation : undefined,
                workerIndex: event.workerIndex,
                workerChunkSize: event.workerChunkSize,
                workerStartupDurationMs: event.workerStartupDurationMs,
                parseWorkerRetryPolicy: workerFailureMode,
                parseWorkerRecoveryWindowSize: PARSE_WORKER_RECOVERY_WINDOW_SIZE,
                resultBytes: event.resultBytes,
                resultCounts: event.resultCounts,
              });
            }
          : undefined,
        workerFailureMode,
      );
      if (chunkWorkerData) {
        chunkFiles.length = 0;
        chunkContents.clear();
      }
      if (!chunkWorkerData && workerPool) {
        await workerPool.terminate();
        workerPool = undefined;
        console.warn(
          'Worker pool disabled for remaining parse chunks after fallback to sequential parsing.',
        );
      }
      if (chunkWorkerData?.degraded) {
        if (chunkWorkerData.degraded.fatal) {
          skipRemainingParseChunksReason = chunkWorkerData.degraded.reason;
          await workerPool?.terminate();
          workerPool = undefined;
        }
        console.warn(
          chunkWorkerData.degraded.fatal
            ? `Parse chunk ${chunkIdx + 1}/${numChunks} degraded: skipped ${chunkWorkerData.degraded.filesSkipped} files. Remaining parse chunks will be skipped with the same reason.`
            : `Parse chunk ${chunkIdx + 1}/${numChunks} degraded: quarantined ${chunkWorkerData.degraded.filesSkipped} file(s); continuing with remaining parse chunks.`,
        );
        const degradedFiles = chunkWorkerData.fileTimings
          .filter((timing) => timing.status === 'skipped')
          .slice(0, 25)
          .map((timing) => ({
            filePath: timing.filePath,
            reason: chunkWorkerData.degraded!.reason,
          }));
        emitParseTelemetry(options, graph, pipelineStart, 'parse-degraded-files', {
          chunkIndex: chunkIdx + 1,
          chunkCount: numChunks,
          chunkFiles: chunkFileCount,
          chunkBytes,
          chunkByteBudget: CHUNK_BYTE_BUDGET,
          workerPoolSize: 0,
          usedWorkerPool: false,
          degradedReason: chunkWorkerData.degraded.reason,
          degradedAction: chunkWorkerData.degraded.action,
          parseWorkerRetryPolicy: chunkWorkerData.degraded.policy,
          parseWorkerRecoveryWindowSize: chunkWorkerData.degraded.recoveryWindowSize,
          degradedFiles,
        });
      }

      const chunkBasePercent = 20 + (filesParsedSoFar / totalParseable) * 62;

      if (chunkWorkerData) {
        await processImportsFromExtracted(
          graph,
          allPathObjects,
          chunkWorkerData.imports,
          ctx,
          (current, total) => {
            onProgress({
              phase: 'parsing',
              percent: Math.round(chunkBasePercent),
              message: `Resolving imports (chunk ${chunkIdx + 1}/${numChunks})...`,
              detail: `${current}/${total} files`,
              stats: {
                filesProcessed: filesParsedSoFar,
                totalFiles: totalParseable,
                nodesCreated: graph.nodeCount,
              },
            });
          },
          repoPath,
          importCtx,
        );
        if (chunkNeedsSynthesis[chunkIdx]) {
          synthesizeWildcardImportBindings(graph, ctx);
          hasSynthesized = true;
        }
        if (exportedTypeMap.size > 0 && ctx.namedImportMap.size > 0) {
          const { enrichedCount } = seedCrossFileReceiverTypes(
            chunkWorkerData.calls,
            ctx.namedImportMap,
            exportedTypeMap,
          );
          if (isDev && enrichedCount > 0) {
            console.log(
              `🔗 E1: Seeded ${enrichedCount} cross-file receiver types (chunk ${chunkIdx + 1})`,
            );
          }
        }
        for (const item of chunkWorkerData.calls) deferredWorkerCalls.push(item);
        for (const item of chunkWorkerData.heritage) deferredWorkerHeritage.push(item);
        for (const item of chunkWorkerData.constructorBindings)
          deferredConstructorBindings.push(item);
        if (chunkWorkerData.assignments?.length) {
          for (const item of chunkWorkerData.assignments) deferredAssignments.push(item);
        }

        await Promise.all([
          processHeritageFromExtracted(graph, chunkWorkerData.heritage, ctx, (current, total) => {
            onProgress({
              phase: 'parsing',
              percent: Math.round(chunkBasePercent),
              message: `Resolving heritage (chunk ${chunkIdx + 1}/${numChunks})...`,
              detail: `${current}/${total} records`,
              stats: {
                filesProcessed: filesParsedSoFar,
                totalFiles: totalParseable,
                nodesCreated: graph.nodeCount,
              },
            });
          }),
          processRoutesFromExtracted(graph, chunkWorkerData.routes ?? [], ctx, (current, total) => {
            onProgress({
              phase: 'parsing',
              percent: Math.round(chunkBasePercent),
              message: `Resolving routes (chunk ${chunkIdx + 1}/${numChunks})...`,
              detail: `${current}/${total} routes`,
              stats: {
                filesProcessed: filesParsedSoFar,
                totalFiles: totalParseable,
                nodesCreated: graph.nodeCount,
              },
            });
          }),
        ]);

        if (chunkWorkerData.fileScopeBindings?.length) {
          for (const { filePath, bindings } of chunkWorkerData.fileScopeBindings) {
            if (typeof filePath !== 'string' || filePath.length === 0) continue;
            if (!Array.isArray(bindings)) continue;
            const entries: BindingEntry[] = [];
            for (const tuple of bindings) {
              if (!Array.isArray(tuple) || tuple.length !== 2) continue;
              const [varName, typeName] = tuple;
              if (typeof varName !== 'string' || typeof typeName !== 'string') continue;
              entries.push({ scope: '', varName, typeName });
            }
            if (entries.length > 0) {
              bindingAccumulator.appendFile(filePath, entries);
            }
          }
        }
        await Promise.all([
          fetchCallStage.append(chunkWorkerData.fetchCalls ?? []),
          extractedRouteStage.append(chunkWorkerData.routes ?? []),
          decoratorRouteStage.append(chunkWorkerData.decoratorRoutes ?? []),
          toolDefStage.append(chunkWorkerData.toolDefs ?? []),
          ormQueryStage.append(chunkWorkerData.ormQueries ?? []),
        ]);
        if (chunkWorkerData.fileTimings?.length) {
          for (const item of chunkWorkerData.fileTimings) trackSlowTiming(slowFileTimings, item);
        }
        if (chunkWorkerData.extractorTimings?.length) {
          for (const item of chunkWorkerData.extractorTimings) {
            trackSlowTiming(slowExtractorTimings, item);
          }
        }
      } else {
        await processImports(graph, chunkFiles, astCache, ctx, undefined, repoPath, allPaths);
        sequentialChunkPaths.push(chunkPaths);
      }

      filesParsedSoFar += chunkFileCount;
      astCache.clear();
      emitParseTelemetry(options, graph, pipelineStart, 'parse-chunk-end', {
        durationMs: Date.now() - chunkStarted,
        chunkIndex: chunkIdx + 1,
        chunkCount: numChunks,
        chunkFiles: chunkFileCount,
        chunkBytes,
        chunkByteBudget: CHUNK_BYTE_BUDGET,
        workerPoolSize: workerPool?.size ?? 0,
        usedWorkerPool: workerPool !== undefined,
        workerIsolation: workerPool ? workerIsolation : undefined,
        workerStartupDurationMs: workerPool?.startupDurationMs,
        workerStartupDurationsMs: workerPool?.workerStartupDurationsMs,
        parseWorkerRetryPolicy: workerFailureMode,
        parseWorkerRecoveryWindowSize: PARSE_WORKER_RECOVERY_WINDOW_SIZE,
        subBatchSize: workerPool ? WORKER_SUB_BATCH_SIZE : undefined,
        firstFilePath: chunkPaths[0],
        lastFilePath: chunkPaths[chunkPaths.length - 1],
      });
      if (chunkWorkerData) {
        clearChunkWorkerData(chunkWorkerData);
      }
    }

    const fullWorkerHeritageMap =
      deferredWorkerHeritage.length > 0
        ? await buildHeritageMap(deferredWorkerHeritage, ctx, getHeritageStrategyForLanguage)
        : undefined;

    try {
      if (deferredWorkerCalls.length > 0) {
        if (exportedTypeMap.size === 0 && graph.nodeCount > 0) {
          const graphExports = buildExportedTypeMapFromGraph(graph, ctx.model.symbols);
          for (const [fp, exports] of graphExports) exportedTypeMap.set(fp, exports);
        }
        if (exportedTypeMap.size > 0 && ctx.namedImportMap.size > 0) {
          const { enrichedCount } = seedCrossFileReceiverTypes(
            deferredWorkerCalls,
            ctx.namedImportMap,
            exportedTypeMap,
          );
          if (isDev && enrichedCount > 0) {
            console.log(`🔗 E1: Seeded ${enrichedCount} deferred cross-file receiver types`);
          }
        }
        await processCallsFromExtracted(
          graph,
          deferredWorkerCalls,
          ctx,
          (current, total) => {
            onProgress({
              phase: 'parsing',
              percent: 82,
              message: 'Resolving calls (all chunks)...',
              detail: `${current}/${total} files`,
              stats: {
                filesProcessed: filesParsedSoFar,
                totalFiles: totalParseable,
                nodesCreated: graph.nodeCount,
              },
            });
          },
          deferredConstructorBindings.length > 0 ? deferredConstructorBindings : undefined,
          fullWorkerHeritageMap,
          bindingAccumulator,
        );
      }

      if (deferredAssignments.length > 0) {
        processAssignmentsFromExtracted(
          graph,
          deferredAssignments,
          ctx,
          deferredConstructorBindings.length > 0 ? deferredConstructorBindings : undefined,
          bindingAccumulator,
        );
      }
    } finally {
      deferredWorkerCalls.length = 0;
      deferredWorkerHeritage.length = 0;
      deferredConstructorBindings.length = 0;
      deferredAssignments.length = 0;
    }
    workerParseCompleted = true;
  } finally {
    if (!workerParseCompleted) {
      await disposeJsonlStages(extractedDataStages);
    }
    await workerPool?.terminate();
  }

  // Sequential fallback chunks.
  //
  // U6: wrap the fallback loop and the finalize/enrich steps in a try/finally
  // so cleanup still runs on a mid-fallback throw. The `finally` guarantees:
  //   1. `astCache.clear()` releases any tree-sitter trees held by the most
  //      recently allocated per-chunk cache, mirroring the per-chunk
  //      `astCache.clear()` calls on the happy path.
  //   2. `bindingAccumulator.finalize()` runs before `crossFile` disposes the
  //      accumulator downstream — callers that inspect partial TypeEnv state
  //      (or consume it via `enrichExportedTypeMap` on a partial recovery)
  //      still see a finalized accumulator.
  //   3. `enrichExportedTypeMap` runs so any bindings already accumulated
  //      are propagated into `exportedTypeMap` even if the fallback aborted.
  //
  // Disposal of the accumulator remains with `crossFile` (owned by U2). We do
  // NOT call `bindingAccumulator.dispose()` here.
  let sequentialFallbackCompleted = false;
  try {
    if (sequentialChunkPaths.length > 0) {
      synthesizeWildcardImportBindings(graph, ctx);
      hasSynthesized = true;
    }
    const allSequentialHeritage: ExtractedHeritage[] = [];
    for (const chunkPaths of sequentialChunkPaths) {
      const chunkContents = await readFileContents(repoPath, chunkPaths);
      const chunkFiles = chunkPaths
        .filter((p) => chunkContents.has(p))
        .map((p) => ({ path: p, content: chunkContents.get(p)! }));
      astCache = createASTCache(chunkFiles.length);
      const sequentialHeritage = await extractExtractedHeritageFromFiles(chunkFiles, astCache);
      for (const h of sequentialHeritage) allSequentialHeritage.push(h);
      sequentialHeritage.length = 0;
      chunkFiles.length = 0;
      chunkContents.clear();
      astCache.clear();
    }
    const sequentialHeritageMap =
      allSequentialHeritage.length > 0
        ? await buildHeritageMap(allSequentialHeritage, ctx, getHeritageStrategyForLanguage)
        : undefined;
    allSequentialHeritage.length = 0;

    for (let chunkIdx = 0; chunkIdx < sequentialChunkPaths.length; chunkIdx++) {
      const chunkPaths = sequentialChunkPaths[chunkIdx];
      const chunkContents = await readFileContents(repoPath, chunkPaths);
      const chunkFiles = chunkPaths
        .filter((p) => chunkContents.has(p))
        .map((p) => ({ path: p, content: chunkContents.get(p)! }));

      astCache = createASTCache(chunkFiles.length);
      const rubyHeritage = await processCalls(
        graph,
        chunkFiles,
        astCache,
        ctx,
        (current, total) => {
          onProgress({
            phase: 'parsing',
            percent: 85,
            message: `Resolving calls (sequential chunk ${chunkIdx + 1}/${numChunks})...`,
            detail: `${current}/${total} files`,
          });
        },
        exportedTypeMap,
        undefined,
        undefined,
        undefined,
        sequentialHeritageMap,
        bindingAccumulator,
      );
      await processHeritage(graph, chunkFiles, astCache, ctx, (current, total) => {
        onProgress({
          phase: 'parsing',
          percent: 90,
          message: `Resolving heritage (sequential chunk ${chunkIdx + 1}/${numChunks})...`,
          detail: `${current}/${total} files`,
        });
      });
      if (rubyHeritage.length > 0) {
        await processHeritageFromExtracted(graph, rubyHeritage, ctx);
      }
      const chunkFetchCalls = await extractFetchCallsFromFiles(chunkFiles, astCache);
      if (chunkFetchCalls.length > 0) {
        await fetchCallStage.append(chunkFetchCalls);
      }
      const chunkORMQueries: ExtractedORMQuery[] = [];
      for (const f of chunkFiles) {
        extractORMQueriesInline(f.path, f.content, chunkORMQueries, ormClientIdentifiers);
      }
      await ormQueryStage.append(chunkORMQueries);
      chunkORMQueries.length = 0;
      rubyHeritage.length = 0;
      chunkFiles.length = 0;
      chunkContents.clear();
      astCache.clear();
    }

    // Log resolution cache stats
    if (isDev) {
      const rcStats = ctx.getStats();
      const total = rcStats.cacheHits + rcStats.cacheMisses;
      const hitRate = total > 0 ? ((rcStats.cacheHits / total) * 100).toFixed(1) : '0';
      console.log(
        `🔍 Resolution cache: ${rcStats.cacheHits} hits, ${rcStats.cacheMisses} misses (${hitRate}% hit rate)`,
      );
    }
    sequentialFallbackCompleted = true;
  } finally {
    if (!sequentialFallbackCompleted) {
      await disposeJsonlStages(extractedDataStages);
    }
    // Clearing an already-empty cache is a no-op, so this is idempotent-safe
    // on the happy path where every per-chunk block already cleared astCache.
    astCache.clear();

    // Run finalize + enrichment inside try/catch so a cleanup failure never
    // masks the original fallback error. finalize must precede crossFile's
    // dispose (U2) and enrichExportedTypeMap depends on finalized bindings.
    try {
      bindingAccumulator.finalize();
      const enriched = enrichExportedTypeMap(bindingAccumulator, graph, exportedTypeMap);
      if (isDev && enriched > 0) {
        console.log(
          `🔗 Worker TypeEnv enrichment: ${enriched} fixpoint-inferred exports added to ExportedTypeMap`,
        );
      }
    } catch (enrichErr) {
      if (isDev) {
        console.warn(
          'Post-fallback finalize/enrich failed during cleanup:',
          (enrichErr as Error).message,
        );
      }
    }
  }

  if (!hasSynthesized) {
    const synthesized = synthesizeWildcardImportBindings(graph, ctx);
    if (isDev && synthesized > 0) {
      console.log(
        `🔗 Synthesized ${synthesized} additional wildcard import bindings (Go/Ruby/C++/Swift/Python)`,
      );
    }
  }

  if (slowFileTimings.length > 0) {
    emitParseTelemetry(options, graph, pipelineStart, 'parse-slowest-files', {
      slowFiles: getSlowTimings(slowFileTimings),
    });
    slowFileTimings.length = 0;
  }
  if (slowExtractorTimings.length > 0) {
    emitParseTelemetry(options, graph, pipelineStart, 'parse-slowest-extractors', {
      slowExtractors: getSlowTimings(slowExtractorTimings),
    });
    slowExtractorTimings.length = 0;
  }

  // Worker-path enrichment: if exportedTypeMap is empty (e.g. the worker pool
  // built TypeEnv inside workers without access to SymbolTable), reconstruct
  // the map from graph nodes + SymbolTable here in the main thread before
  // handing the (now read-only) map to downstream phases. Doing it here means
  // crossFile receives a fully-populated map and never needs to mutate it for
  // initial-graph enrichment.
  if (exportedTypeMap.size === 0 && graph.nodeCount > 0) {
    const graphExports = buildExportedTypeMapFromGraph(graph, ctx.model.symbols);
    for (const [fp, exports] of graphExports) exportedTypeMap.set(fp, exports);
  }

  allPathObjects.length = 0;
  // Safe to reset importCtx caches here: `importCtx` (ImportResolutionContext)
  // is a scratch workspace used only during import path resolution. The
  // `resolutionContext` (`ctx`) returned below is a distinct object — it owns
  // the fully-populated, post-parse `importMap` / `namedImportMap` /
  // `packageMap` / `moduleAliasMap` / `model`, and never references
  // `importCtx`. Cross-file re-resolution in cross-file-impl.ts consumes only
  // `ctx` (via `processCalls`), so clearing the suffix index / resolveCache /
  // normalizedFileList here cannot lose import matches downstream.
  importCtx.resolveCache.clear();
  importCtx.index = EMPTY_INDEX;
  importCtx.normalizedFileList = [];

  let allFetchCalls: ExtractedFetchCall[] = [];
  let allExtractedRoutes: ExtractedRoute[] = [];
  let allDecoratorRoutes: ExtractedDecoratorRoute[] = [];
  let allToolDefs: ExtractedToolDef[] = [];
  let allORMQueries: ExtractedORMQuery[] = [];
  try {
    [allFetchCalls, allExtractedRoutes, allDecoratorRoutes, allToolDefs, allORMQueries] =
      await Promise.all([
        fetchCallStage.drain(),
        extractedRouteStage.drain(),
        decoratorRouteStage.drain(),
        toolDefStage.drain(),
        ormQueryStage.drain(),
      ]);
  } finally {
    await disposeJsonlStages(extractedDataStages);
  }

  return {
    exportedTypeMap,
    allFetchCalls,
    allExtractedRoutes,
    allDecoratorRoutes,
    allToolDefs,
    allORMQueries,
    bindingAccumulator,
    resolutionContext: ctx,
    // Whether a worker pool was actually live for this run. False means the
    // sequential fallback handled every chunk (either due to `skipWorkers`,
    // the file-count/byte thresholds, or a pool-creation failure).
    usedWorkerPool: workerPool !== undefined,
  };
}
