/**
 * Pipeline orchestrator — dependency-ordered ingestion pipeline.
 *
 * The pipeline is composed of named phases with explicit dependencies.
 * Each phase is defined in its own file under `pipeline-phases/`.
 * The runner in `pipeline-phases/runner.ts` executes phases in
 * topological order, passing typed outputs from upstream phases as
 * inputs to downstream phases.
 *
 * To add a new phase:
 * 1. Create a new file in `pipeline-phases/` following the pattern
 * 2. Export it from `pipeline-phases/index.ts`
 * 3. Add it to the `ALL_PHASES` array below
 *
 * See ARCHITECTURE.md for the full phase dependency diagram.
 */

import { createKnowledgeGraph } from '../graph/graph.js';
import { type PipelineProgress } from 'ontoindex-shared';
import { PipelineResult } from '../../types/pipeline.js';
import {
  runPipeline,
  getPhaseOutput,
  scanPhase,
  gitMiningPhase,
  structurePhase,
  markdownPhase,
  cobolPhase,
  parsePhase,
  optionalPrecisionPhase,
  routesPhase,
  toolsPhase,
  ormPhase,
  crossFilePhase,
  pageRankPhase,
  mroPhase,
  communitiesPhase,
  conceptsPhase,
  processesPhase,
  summaryTreePhase,
  type PipelinePhase,
  type OptionalPrecisionAnalyzerOptions,
  type CommunitiesOutput,
  type ProcessesOutput,
} from './pipeline-phases/index.js';

export interface PipelineOptions {
  /** Selects the ingestion phase set. Defaults to the full index profile. */
  profile?: PipelineProfile;
  /** Skip MRO, community detection, and process extraction for faster test runs. */
  skipGraphPhases?: boolean;
  /** Force sequential parsing (no worker pool). Useful for testing the sequential path. */
  skipWorkers?: boolean;
  /** Optional normalized repository-relative roots to scan before ignore filtering. */
  includePaths?: string[];
  /** Optional structured telemetry sink for benchmark and diagnostic runs. */
  onTelemetry?: (event: {
    event:
      | 'phase-start'
      | 'phase-end'
      | 'phase-error'
      | 'scan-degraded-files'
      | 'parse-plan'
      | 'parse-chunk-start'
      | 'parse-chunk-end'
      | 'parse-sub-batch-start'
      | 'parse-worker-result'
      | 'parse-degraded-files'
      | 'parse-slowest-files'
      | 'parse-slowest-extractors'
      | 'cross-file-plan'
      | 'cross-file-slowest-files';
    phaseName: string;
    elapsedMs: number;
    durationMs?: number;
    rssBytes: number;
    heapUsedBytes: number;
    heapTotalBytes: number;
    heapLimitBytes: number;
    gcAvailable?: boolean;
    gcCount?: number;
    gcDurationMs?: number;
    graphNodes: number;
    graphRelationships: number;
    error?: string;
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
    workerIsolation?: 'thread' | 'process';
    workerStartupDurationMs?: number;
    workerStartupDurationsMs?: readonly number[];
    parseWorkerRetryPolicy?: 'sequential' | 'quarantine';
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
    crossFileFilesWithGaps?: number;
    crossFileGapRatio?: number;
    crossFileLevelCount?: number;
    crossFileCycleCount?: number;
    crossFileMaxReprocess?: number;
    slowCrossFileFiles?: {
      filePath: string;
      language?: string;
      durationMs: number;
      seededBindings: number;
      importedReturnTypes: number;
      importedRawReturnTypes: number;
    }[];
  }) => void;
  /**
   * @internal Test-only override for worker-pool gating thresholds.
   * When unset, production defaults apply (15 files OR 512 KB total bytes).
   * Setting either field lowers the corresponding threshold so small test
   * fixtures can still exercise the worker-pool path. Do not use from
   * production call sites.
   */
  workerThresholdsForTest?: {
    minFiles?: number;
    minBytes?: number;
  };
  /** Optional policy-gated placeholder for future precision analysis. */
  optionalPrecisionAnalyzer?: OptionalPrecisionAnalyzerOptions;
}

export type PipelineProfile = 'full' | 'symbols' | 'huge-repo-symbols';

// ── Phase registry ─────────────────────────────────────────────────────────

const symbolsParsePhase: PipelinePhase = {
  ...parsePhase,
  deps: ['structure'],
};

const usesGraphSummaryPhases = (options?: PipelineOptions): boolean => {
  return (
    options?.profile !== 'symbols' &&
    options?.profile !== 'huge-repo-symbols' &&
    !options?.skipGraphPhases
  );
};

/**
 * All pipeline phases with their dependency relationships.
 *
 * Phase dependency graph:
 *
 *   scan → structure → [markdown, cobol] → parse → [routes, tools, orm]
 *     → crossFile → mro → communities → processes
 *
 * To add a new phase: create a file in pipeline-phases/, export the phase
 * object, and add it to the appropriate position in this array.
 */
export function buildPhaseList(options?: PipelineOptions): PipelinePhase[] {
  if (options?.profile === 'symbols' || options?.profile === 'huge-repo-symbols') {
    return [scanPhase, structurePhase, symbolsParsePhase];
  }

  const phases: PipelinePhase[] = [
    scanPhase,
    gitMiningPhase,
    structurePhase,
    markdownPhase,
    cobolPhase,
    parsePhase,
  ];

  if (options?.optionalPrecisionAnalyzer) {
    phases.push(optionalPrecisionPhase);
  }

  phases.push(routesPhase, toolsPhase, ormPhase, crossFilePhase, pageRankPhase);

  if (!options?.skipGraphPhases) {
    phases.push(mroPhase, communitiesPhase, conceptsPhase, processesPhase, summaryTreePhase);
  }

  return phases;
}

interface ResolvedPipelineOutputs {
  totalFiles: number;
  usedWorkerPool: boolean;
  communityResult?: CommunitiesOutput['communityResult'];
  processResult?: ProcessesOutput['processResult'];
}

const resolvePipelineOutputs = (
  results: Awaited<ReturnType<typeof runPipeline>>,
  options?: PipelineOptions,
): ResolvedPipelineOutputs => {
  const { totalFiles, usedWorkerPool } = getPhaseOutput<{
    totalFiles: number;
    usedWorkerPool: boolean;
  }>(results, 'parse');

  if (!usesGraphSummaryPhases(options)) {
    return { totalFiles, usedWorkerPool };
  }

  return {
    totalFiles,
    usedWorkerPool,
    communityResult: getPhaseOutput<CommunitiesOutput>(results, 'communities').communityResult,
    processResult: getPhaseOutput<ProcessesOutput>(results, 'processes').processResult,
  };
};

const reportPipelineCompletion = (
  onProgress: (progress: PipelineProgress) => void,
  graphNodeCount: number,
  outputs: ResolvedPipelineOutputs,
): void => {
  onProgress({
    phase: 'complete',
    percent: 100,
    message:
      outputs.communityResult && outputs.processResult
        ? `Graph complete! ${outputs.communityResult.stats.totalCommunities} communities, ${outputs.processResult.stats.totalProcesses} processes detected.`
        : 'Graph complete! (graph phases skipped)',
    stats: {
      filesProcessed: outputs.totalFiles,
      totalFiles: outputs.totalFiles,
      nodesCreated: graphNodeCount,
    },
  });
};

// ── Pipeline orchestrator ─────────────────────────────────────────────────

export const runPipelineFromRepo = async (
  repoPath: string,
  onProgress: (progress: PipelineProgress) => void,
  options?: PipelineOptions,
): Promise<PipelineResult> => {
  const graph = createKnowledgeGraph();
  const pipelineStart = Date.now();

  const phases = buildPhaseList(options);

  const results = await runPipeline(phases, {
    repoPath,
    graph,
    onProgress,
    options,
    pipelineStart,
  });

  const outputs = resolvePipelineOutputs(results, options);
  reportPipelineCompletion(onProgress, graph.nodeCount, outputs);

  return {
    graph,
    repoPath,
    totalFileCount: outputs.totalFiles,
    communityResult: outputs.communityResult,
    processResult: outputs.processResult,
    usedWorkerPool: outputs.usedWorkerPool,
  };
};
