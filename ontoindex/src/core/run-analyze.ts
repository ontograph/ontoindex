/**
 * Shared Analysis Orchestrator
 *
 * Extracts the core analysis pipeline from the CLI analyze command into a
 * reusable function that can be called from both the CLI and a server-side
 * worker process.
 *
 * IMPORTANT: This module must NEVER call process.exit(). The caller (CLI
 * wrapper or server worker) is responsible for process lifecycle.
 */

import path from 'path';
import fs from 'fs/promises';
import * as fsSync from 'fs';
import { type PipelineOptions, type PipelineProfile } from './ingestion/pipeline.js';
import { normalizeRepositoryIncludePaths } from './ingestion/filesystem-walker.js';
import { createTypeScriptAnalyzeRuntime, type AnalyzeRuntime } from './ingestion/runtime/index.js';
import {
  initLbug,
  loadGraphToLbug,
  getLbugStats,
  executeQuery,
  streamQuery,
  executeWithReusedStatement,
  closeLbug,
  loadCachedEmbeddings,
  createFTSIndex,
} from './lbug/lbug-adapter.js';
import {
  getStoragePaths,
  saveMeta,
  loadMeta,
  addToGitignore,
  registerRepo,
  cleanupOldKuzuFiles,
} from '../storage/repo-manager.js';
import { getCurrentCommit, hasGitDir } from '../storage/git.js';
import type { CachedEmbedding } from './embeddings/types.js';
import { generateAIContextFiles } from '../cli/ai-context.js';
import type { PipelineResult } from '../types/pipeline.js';
import type { PipelineProgress } from 'ontoindex-shared';
import { EMBEDDING_TABLE_NAME } from './lbug/schema.js';
import { STALE_HASH_SENTINEL } from './lbug/schema.js';
import {
  buildAnnNeighborsFromEmbeddingRows,
  type AnnEmbeddingRow,
} from './embeddings/ann-neighbor.js';
import { persistAnnNeighborEdges } from './embeddings/ann-neighbor-store.js';
import type { KnowledgeGraph } from './graph/types.js';
import { FTS_INDEXES } from './search/bm25-index.js';
import v8 from 'node:v8';
import { PerformanceObserver } from 'node:perf_hooks';
import {
  collectMarkdownSidecarDocuments,
  createMarkdownDocumentEnrichmentQueueRequest,
  getSidecarStorePath,
  LocalSidecarStore,
} from './ingestion/enrichment/index.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

interface AnalyzeCallbacks {
  onProgress: (phase: string, percent: number, message: string) => void;
  onLog?: (message: string) => void;
}

export interface RunFullAnalysisDependencies {
  analyzeRuntime?: AnalyzeRuntime;
}

export interface AnalyzeOptions {
  /**
   * Force a full re-index of the pipeline. Callers may OR this with
   * other flags that imply re-analysis (e.g. `--skills`), so the value
   * here is the PIPELINE-force signal, NOT the registry-collision
   * bypass. See `allowDuplicateName` below.
   */
  force?: boolean;
  embeddings?: boolean;
  /**
   * Build ANN_NEIGHBOR edges for retrieval-only symbol-neighborhood search.
   * This path currently requires embeddings for vector-based neighbor derivation.
   */
  annNeighbors?: boolean;
  skipGit?: boolean;
  /** Skip AGENTS.md and CLAUDE.md ontoindex block updates. */
  skipAgentsMd?: boolean;
  /** Omit volatile symbol/relationship counts from AGENTS.md and CLAUDE.md. */
  noStats?: boolean;
  /**
   * User-provided alias for the registry `name` (#829). When set,
   * forwarded to `registerRepo` so the indexed repo is stored under
   * this alias instead of the path-derived basename.
   */
  registryName?: string;
  /**
   * Bypass the `RegistryNameCollisionError` guard and allow two paths
   * to register under the same `name` (#829). Controlled by the
   * dedicated `--allow-duplicate-name` CLI flag, intentionally
   * independent from `--force` — users who hit the collision guard
   * should be able to accept the duplicate without paying the cost
   * of a pipeline re-index.
   */
  allowDuplicateName?: boolean;
  /** Queue post-index Markdown sidecar enrichment. Default off. */
  markdownSidecar?: boolean;
  /** Pipeline profile to run. Defaults to full. */
  profile?: PipelineProfile;
  /** Optional repository-relative roots to scan before ignore filtering. */
  includePaths?: string[];
}

export interface AnalyzeResult {
  repoName: string;
  repoPath: string;
  stats: {
    files?: number;
    nodes?: number;
    edges?: number;
    communities?: number;
    processes?: number;
    embeddings?: number;
  };
  alreadyUpToDate?: boolean;
  /** The raw pipeline result — only populated when needed by callers (e.g. skill generation). */
  pipelineResult?: PipelineResult;
}

/** Threshold: auto-skip embeddings for repos with more nodes than this */
const EMBEDDING_NODE_LIMIT = 50_000;

interface GraphDiffSnapshot {
  lastCommit: string;
  savedAt: string;
  calleesMap: Record<string, string[]>;
  fileToSymbols: Record<string, string[]>;
}

type AnalyzeTelemetryEvent = Parameters<NonNullable<PipelineOptions['onTelemetry']>>[0];

type AnalyzeDegradedFile = NonNullable<AnalyzeTelemetryEvent['degradedFiles']>[number];

function requestedPipelineProfile(profile: PipelineProfile | undefined): PipelineProfile {
  return profile ?? 'full';
}

function persistedPipelineProfile(meta: {
  indexMode?: string;
  pipelineProfile?: string;
}): PipelineProfile {
  if (meta.pipelineProfile === 'symbols' || meta.pipelineProfile === 'huge-repo-symbols') {
    return meta.pipelineProfile;
  }
  if (meta.indexMode === 'symbols-only') return 'symbols';
  return 'full';
}

function sameStringList(left?: readonly string[], right?: readonly string[]): boolean {
  const a = left ?? [];
  const b = right ?? [];
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

interface PartialAnalysisTelemetryEvent extends Omit<AnalyzeTelemetryEvent, 'event' | 'phaseName'> {
  event: string;
  phaseName: string;
}

interface PartialAnalysisParseChunk {
  chunkIndex: number;
  chunkCount?: number;
  chunkFiles?: number;
  chunkBytes?: number;
  durationMs?: number;
  firstFilePath?: string;
  lastFilePath?: string;
  graphNodes: number;
  graphRelationships: number;
  completedAt: string;
}

interface PartialAnalysisCheckpoint {
  version: 1;
  status: 'running' | 'partial' | 'failed';
  repoPath: '.';
  currentCommit: string;
  startedAt: string;
  updatedAt: string;
  phase?: string;
  phaseStatus?: 'started' | 'completed' | 'failed';
  completedPhases: string[];
  completedParseChunks: PartialAnalysisParseChunk[];
  lastEvent?: {
    event: string;
    phaseName: string;
    elapsedMs: number;
    graphNodes: number;
    graphRelationships: number;
  };
  failure?: {
    phase?: string;
    message: string;
  };
  stats: {
    graphNodes: number;
    graphRelationships: number;
    totalParseableFiles?: number;
    totalParseableBytes?: number;
    usedWorkerPool?: boolean;
  };
  note: string;
}

const DIAGNOSTIC_PROFILE_NAMES = new Set<PipelineProfile>(['symbols', 'huge-repo-symbols']);

function shouldWriteAnalysisCheckpoint(
  options: AnalyzeOptions,
  telemetryEnabled: boolean,
): boolean {
  return (
    telemetryEnabled ||
    (options.profile !== undefined && DIAGNOSTIC_PROFILE_NAMES.has(options.profile))
  );
}

function createPartialAnalysisCheckpointWriter(
  storagePath: string,
  currentCommit: string,
  startedAt: string,
  log: (msg: string) => void,
) {
  const checkpointPath = path.join(storagePath, 'analysis-checkpoint.json');
  const tmpPath = `${checkpointPath}.${process.pid}.tmp`;
  const completedPhases = new Set<string>();
  const completedParseChunks = new Map<number, PartialAnalysisParseChunk>();
  const checkpoint: PartialAnalysisCheckpoint = {
    version: 1,
    status: 'running',
    repoPath: '.',
    currentCommit,
    startedAt,
    updatedAt: startedAt,
    completedPhases: [],
    completedParseChunks: [],
    stats: {
      graphNodes: 0,
      graphRelationships: 0,
    },
    note: 'Diagnostic analysis checkpoint only. This is not a complete OntoIndex index and is not registered.',
  };
  let warned = false;

  const persist = () => {
    try {
      checkpoint.updatedAt = new Date().toISOString();
      checkpoint.completedPhases = [...completedPhases].sort();
      checkpoint.completedParseChunks = [...completedParseChunks.values()].sort(
        (a, b) => a.chunkIndex - b.chunkIndex,
      );
      fsSync.mkdirSync(storagePath, { recursive: true });
      fsSync.writeFileSync(tmpPath, JSON.stringify(checkpoint, null, 2), 'utf-8');
      fsSync.renameSync(tmpPath, checkpointPath);
    } catch (err) {
      try {
        fsSync.rmSync(tmpPath, { force: true });
      } catch {
        /* swallow */
      }
      if (!warned) {
        warned = true;
        log(
          `Could not write partial analysis checkpoint: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  };

  persist();

  return {
    record(event: PartialAnalysisTelemetryEvent): void {
      checkpoint.phase = event.phaseName;
      checkpoint.lastEvent = {
        event: event.event,
        phaseName: event.phaseName,
        elapsedMs: event.elapsedMs,
        graphNodes: event.graphNodes,
        graphRelationships: event.graphRelationships,
      };
      checkpoint.stats.graphNodes = event.graphNodes;
      checkpoint.stats.graphRelationships = event.graphRelationships;
      if (event.totalParseableFiles !== undefined) {
        checkpoint.stats.totalParseableFiles = event.totalParseableFiles;
      }
      if (event.totalParseableBytes !== undefined) {
        checkpoint.stats.totalParseableBytes = event.totalParseableBytes;
      }
      if (event.usedWorkerPool !== undefined) {
        checkpoint.stats.usedWorkerPool = event.usedWorkerPool;
      }

      if (event.event === 'phase-start') {
        checkpoint.status = 'running';
        checkpoint.phaseStatus = 'started';
        persist();
        return;
      }

      if (event.event === 'phase-end') {
        completedPhases.add(event.phaseName);
        checkpoint.status = 'partial';
        checkpoint.phaseStatus = 'completed';
        persist();
        return;
      }

      if (event.event === 'phase-error') {
        checkpoint.status = 'failed';
        checkpoint.phaseStatus = 'failed';
        checkpoint.failure = {
          phase: event.phaseName,
          message: event.error ?? `Phase '${event.phaseName}' failed`,
        };
        persist();
        return;
      }

      if (event.event === 'parse-plan') {
        checkpoint.status = 'running';
        checkpoint.phaseStatus = 'started';
        persist();
        return;
      }

      if (event.event === 'parse-chunk-end' && event.chunkIndex !== undefined) {
        checkpoint.status = 'partial';
        checkpoint.phaseStatus = 'completed';
        completedParseChunks.set(event.chunkIndex, {
          chunkIndex: event.chunkIndex,
          chunkCount: event.chunkCount,
          chunkFiles: event.chunkFiles,
          chunkBytes: event.chunkBytes,
          durationMs: event.durationMs,
          firstFilePath: event.firstFilePath,
          lastFilePath: event.lastFilePath,
          graphNodes: event.graphNodes,
          graphRelationships: event.graphRelationships,
          completedAt: new Date().toISOString(),
        });
        persist();
      }
    },

    markFailed(err: unknown): void {
      checkpoint.status = 'failed';
      checkpoint.phaseStatus = 'failed';
      checkpoint.failure = {
        phase: checkpoint.phase,
        message: err instanceof Error ? err.message : String(err),
      };
      persist();
    },

    clear(): void {
      try {
        fsSync.rmSync(checkpointPath, { force: true });
        fsSync.rmSync(tmpPath, { force: true });
      } catch {
        /* swallow */
      }
    },
  };
}

function emptyGraphDiffSnapshot(savedAt: string, lastCommit: string): GraphDiffSnapshot {
  return {
    lastCommit,
    savedAt,
    calleesMap: {},
    fileToSymbols: {},
  };
}

async function countEmbeddableGraphNodes(): Promise<number | undefined> {
  const { EMBEDDABLE_LABELS } = await import('./embeddings/types.js');
  let total = 0;
  let counted = false;
  for (const label of EMBEDDABLE_LABELS) {
    try {
      const rows = await executeQuery(`MATCH (n:\`${label}\`) RETURN count(n) AS cnt`);
      const row = rows[0] as Record<string, unknown> | readonly unknown[] | undefined;
      let raw: unknown;
      if (Array.isArray(row)) {
        raw = row[0];
      } else if (row !== undefined) {
        raw = (row as Record<string, unknown>).cnt;
      }
      if (typeof raw === 'number') {
        total += raw;
        counted = true;
      }
    } catch {
      // Older or partial schemas may not have every embeddable table.
    }
  }
  return counted ? total : undefined;
}

const ANN_NEIGHBOR_MODEL_FALLBACK = 'unknown-embedding-model';

type QueryRow = Record<string, unknown> | readonly unknown[];

const rowField = <T>(row: QueryRow, field: string, index: number): T | undefined => {
  return Array.isArray(row) ? ((row[index] as T | undefined) ?? undefined) : ((row[field] as T | undefined) ?? undefined);
};

const toNumericVector = (value: unknown): number[] | undefined => {
  if (value == null) return undefined;

  if (Array.isArray(value)) {
    const array = value as unknown[];
    if (!array.every((item) => typeof item === 'number' && Number.isFinite(item))) return undefined;
    return array as number[];
  }

  if (ArrayBuffer.isView(value)) {
    const arrayLike = Array.from(value as unknown as ArrayLike<number>);
    if (!arrayLike.every((item) => typeof item === 'number' && Number.isFinite(item))) return undefined;
    return arrayLike;
  }

  return undefined;
};

const toIntegerIfFinite = (value: unknown): number | undefined => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.round(value);
};

const loadAnnNeighborEmbeddingRows = async (
  model: string,
  buildId: string,
  builtAt: string,
): Promise<AnnEmbeddingRow[]> => {
  const rows = await executeQuery(
    `MATCH (e:${EMBEDDING_TABLE_NAME}) RETURN e.nodeId AS nodeId, e.embedding AS embedding, e.chunkIndex AS chunkIndex, e.contentHash AS contentHash`,
  );

  const rowsByNodeId = new Map<
    string,
    {
      embedding: number[];
      chunkIndex: number;
      contentHash: string;
    }
  >();

  for (const row of rows) {
    const nodeId = rowField<string>(row, 'nodeId', 0);
    if (!nodeId || typeof nodeId !== 'string' || nodeId.trim().length === 0) continue;

    const embedding = toNumericVector(rowField<unknown>(row, 'embedding', 1));
    if (!embedding || embedding.length === 0) continue;

    const chunkIndex = toIntegerIfFinite(rowField<unknown>(row, 'chunkIndex', 2)) ?? Number.MAX_SAFE_INTEGER;
    const contentHash = rowField<string>(row, 'contentHash', 3) ?? STALE_HASH_SENTINEL;

    const existing = rowsByNodeId.get(nodeId);
    if (!existing || chunkIndex < existing.chunkIndex) {
      rowsByNodeId.set(nodeId.trim(), {
        embedding,
        chunkIndex,
        contentHash,
      });
    }
  }

  const annRows: AnnEmbeddingRow[] = [];
  for (const [nodeId, row] of rowsByNodeId) {
    annRows.push({
      nodeId,
      model,
      buildId,
      builtAt,
      contentHash: row.contentHash,
      embedding: row.embedding,
    });
  }

  return annRows;
};

function buildGraphDiffSnapshot(
  graph: KnowledgeGraph,
  savedAt: string,
  lastCommit: string,
): GraphDiffSnapshot {
  const calleesMap = new Map<string, Set<string>>();
  const fileToSymbols = new Map<string, string[]>();

  graph.forEachNode((node) => {
    const filePath = node.properties?.filePath;
    if (typeof filePath !== 'string' || filePath.length === 0) return;
    const ids = fileToSymbols.get(filePath);
    if (ids) ids.push(node.id);
    else fileToSymbols.set(filePath, [node.id]);
  });

  graph.forEachRelationship((rel) => {
    if (rel.type !== 'CALLS' && rel.type !== 'IMPORTS') return;
    let targetIds = calleesMap.get(rel.sourceId);
    if (!targetIds) {
      targetIds = new Set<string>();
      calleesMap.set(rel.sourceId, targetIds);
    }
    targetIds.add(rel.targetId);
  });

  const snapshot = emptyGraphDiffSnapshot(savedAt, lastCommit);

  for (const [sourceId, targetIds] of calleesMap) {
    snapshot.calleesMap[sourceId] = [...targetIds].sort();
  }
  for (const [filePath, ids] of fileToSymbols) {
    snapshot.fileToSymbols[filePath] = [...new Set(ids)].sort();
  }

  return snapshot;
}

function countGraphNodesByLabel(graph: KnowledgeGraph): Map<string, number> {
  const counts = new Map<string, number>();
  graph.forEachNode((node) => {
    counts.set(node.label, (counts.get(node.label) ?? 0) + 1);
  });
  return counts;
}

interface GcTelemetrySnapshot {
  gcAvailable: boolean;
  gcCount: number;
  gcDurationMs: number;
}

interface GcTelemetryTracker {
  snapshot: () => GcTelemetrySnapshot;
  stop: () => void;
}

function createGcTelemetryTracker(): GcTelemetryTracker {
  let gcAvailable = false;
  let gcCount = 0;
  let gcDurationMs = 0;
  let observer: PerformanceObserver | undefined;

  try {
    observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        gcCount++;
        gcDurationMs += entry.duration;
      }
    });
    observer.observe({ entryTypes: ['gc'] });
    gcAvailable = true;
  } catch {
    gcAvailable = false;
  }

  return {
    snapshot: () => ({
      gcAvailable,
      gcCount,
      gcDurationMs: Math.round(gcDurationMs * 100) / 100,
    }),
    stop: () => {
      observer?.disconnect();
    },
  };
}

function largeRepoFileContentDisabled(graph: KnowledgeGraph): boolean {
  const configured = Number.parseInt(process.env.ONTOINDEX_MAX_FILE_CONTENT_CHARS ?? '', 10);
  if (Number.isFinite(configured)) return configured <= 0;
  return graph.nodeCount > 25_000;
}

function selectAnalyzeFTSProperties(
  table: string,
  properties: readonly string[],
  graph: KnowledgeGraph,
): string[] {
  if (table === 'File' && largeRepoFileContentDisabled(graph)) {
    return properties.filter((property) => property !== 'content');
  }
  return [...properties];
}

async function buildGraphDiffSnapshotFromDb(
  savedAt: string,
  lastCommit: string,
): Promise<GraphDiffSnapshot> {
  const snapshot = emptyGraphDiffSnapshot(savedAt, lastCommit);
  const calleesMap = new Map<string, Set<string>>();
  const fileToSymbols = new Map<string, Set<string>>();

  await streamQuery(
    `
      MATCH (a)-[r:CodeRelation]->(b)
      WHERE r.type IN ['CALLS', 'IMPORTS']
      RETURN a.id AS sourceId, b.id AS targetId
    `,
    (row) => {
      const sourceId = row.sourceId ?? row[0];
      const targetId = row.targetId ?? row[1];
      if (typeof sourceId !== 'string' || typeof targetId !== 'string') return;
      let targets = calleesMap.get(sourceId);
      if (!targets) {
        targets = new Set<string>();
        calleesMap.set(sourceId, targets);
      }
      targets.add(targetId);
    },
  );

  await streamQuery(
    `
      MATCH (n)
      WHERE n.filePath IS NOT NULL AND n.id IS NOT NULL
      RETURN n.id AS id, n.filePath AS filePath
    `,
    (row) => {
      const id = row.id ?? row[0];
      const filePath = row.filePath ?? row[1];
      if (typeof id !== 'string' || typeof filePath !== 'string' || filePath.length === 0) return;
      let ids = fileToSymbols.get(filePath);
      if (!ids) {
        ids = new Set<string>();
        fileToSymbols.set(filePath, ids);
      }
      ids.add(id);
    },
  );

  for (const [sourceId, targetIds] of calleesMap) {
    snapshot.calleesMap[sourceId] = [...targetIds].sort();
  }
  for (const [filePath, ids] of fileToSymbols) {
    snapshot.fileToSymbols[filePath] = [...ids].sort();
  }

  return snapshot;
}

async function saveGraphDiffSnapshot(
  storagePath: string,
  graph: KnowledgeGraph,
  savedAt: string,
  lastCommit: string,
): Promise<void> {
  const snapshotPath = path.join(storagePath, 'snapshot.json');
  let snapshot: GraphDiffSnapshot;
  try {
    // Persist the graph shape that actually made it into LadybugDB so
    // graph_diff compares DB-to-DB, not DB-to-in-memory-pipeline state.
    snapshot = await buildGraphDiffSnapshotFromDb(savedAt, lastCommit);
  } catch {
    snapshot = buildGraphDiffSnapshot(graph, savedAt, lastCommit);
  }
  await fs.mkdir(storagePath, { recursive: true });
  await fs.writeFile(snapshotPath, JSON.stringify(snapshot, null, 2), 'utf-8');
}

export const PHASE_LABELS: Record<string, string> = {
  extracting: 'Scanning files',
  structure: 'Building structure',
  parsing: 'Parsing code',
  imports: 'Resolving imports',
  calls: 'Tracing calls',
  heritage: 'Extracting inheritance',
  communities: 'Detecting communities',
  processes: 'Detecting processes',
  complete: 'Pipeline complete',
  lbug: 'Loading into LadybugDB',
  fts: 'Creating search indexes',
  embeddings: 'Generating embeddings',
  done: 'Done',
};

export async function runAnalysisPipeline(
  repoPath: string,
  onProgress: (progress: PipelineProgress) => void,
  options?: PipelineOptions,
  analyzeRuntime: AnalyzeRuntime = createTypeScriptAnalyzeRuntime(),
): Promise<PipelineResult> {
  return analyzeRuntime.analyzeRepo({ repoPath, onProgress, options });
}

// ---------------------------------------------------------------------------
// Main orchestrator
// ---------------------------------------------------------------------------

/**
 * Run the full OntoIndex analysis pipeline.
 *
 * This is the shared core extracted from the CLI `analyze` command. It
 * handles: pipeline execution, LadybugDB loading, FTS indexing, embedding
 * generation, metadata persistence, and AI context file generation.
 *
 * The function communicates progress and log messages exclusively through
 * the {@link AnalyzeCallbacks} interface — it never writes to stdout/stderr
 * directly and never calls `process.exit()`.
 */
export async function runFullAnalysis(
  repoPath: string,
  options: AnalyzeOptions,
  callbacks: AnalyzeCallbacks,
  dependencies: RunFullAnalysisDependencies = {},
): Promise<AnalyzeResult> {
  const log = (msg: string) => callbacks.onLog?.(msg);
  const progress = (phase: string, percent: number, message: string) =>
    callbacks.onProgress(phase, percent, message);
  const telemetryEnabled = process.env.ONTOINDEX_ANALYZE_TELEMETRY === '1';
  const checkpointEnabled = shouldWriteAnalysisCheckpoint(options, telemetryEnabled);
  const analysisStart = Date.now();
  const gcTelemetry = telemetryEnabled ? createGcTelemetryTracker() : null;
  let partialCheckpoint: ReturnType<typeof createPartialAnalysisCheckpointWriter> | undefined;
  const emitTelemetry = (event: Record<string, unknown>): void => {
    const memory = process.memoryUsage();
    const heap = v8.getHeapStatistics();
    const telemetryEvent = {
      elapsedMs: Date.now() - analysisStart,
      rssBytes: memory.rss,
      heapUsedBytes: memory.heapUsed,
      heapTotalBytes: memory.heapTotal,
      heapLimitBytes: heap.heap_size_limit,
      ...gcTelemetry?.snapshot(),
      ...event,
    } as PartialAnalysisTelemetryEvent;
    partialCheckpoint?.record(telemetryEvent);
    if (!telemetryEnabled) return;
    log(
      `[ontoindex:telemetry] ${JSON.stringify({
        ...telemetryEvent,
      })}`,
    );
  };

  const { storagePath, lbugPath } = getStoragePaths(repoPath);
  const includePaths = await normalizeRepositoryIncludePaths(repoPath, options.includePaths);
  const requestedProfile = requestedPipelineProfile(options.profile);
  const embeddingsEnabledForRun = options.embeddings === true || options.annNeighbors === true;
  const annNeighborBuildRequested = options.annNeighbors === true;

  // Clean up stale KuzuDB files from before the LadybugDB migration.
  const kuzuResult = await cleanupOldKuzuFiles(storagePath);
  if (kuzuResult.found && kuzuResult.needsReindex) {
    log('Migrating from KuzuDB to LadybugDB — rebuilding index...');
  }

  const repoHasGit = hasGitDir(repoPath);
  const currentCommit = repoHasGit ? getCurrentCommit(repoPath) : '';
  const existingMeta = await loadMeta(storagePath);

  // ── Embedding model hash guard ────────────────────────────────────
  // Refuse to re-embed against an existing index built with a different
  // embedding model — mixing vectors from different models in the same
  // store silently corrupts similarity scores. Only fires when the user
  // asked for embeddings (`--embeddings`) and BOTH the persisted hash
  // and the env hash are present and disagree.
  if (embeddingsEnabledForRun && existingMeta?.model_hash) {
    const envHash = process.env['ONTOINDEX_EMBEDDING_MODEL_HASH'];
    if (envHash && envHash !== existingMeta.model_hash) {
      gcTelemetry?.stop();
      throw new Error(
        `Embedding model mismatch: existing index was built with model hash ` +
          `"${existingMeta.model_hash}" but the current environment has ` +
          `"${envHash}". Run \`ontoindex clean\` and re-analyze, or unset ` +
          `ONTOINDEX_EMBEDDING_MODEL_HASH to use the existing index.`,
      );
    }
  }

  // ── Early-return: already up to date ──────────────────────────────
  if (
    existingMeta &&
    !options.force &&
    existingMeta.lastCommit === currentCommit &&
    persistedPipelineProfile(existingMeta) === requestedProfile &&
    sameStringList(existingMeta.includePaths, includePaths)
  ) {
    // Non-git folders have currentCommit = '' — always rebuild since we can't detect changes
    if (currentCommit !== '') {
      const projectName = await registerRepo(repoPath, existingMeta, {
        name: options.registryName,
        allowDuplicateName: options.allowDuplicateName,
      });
      gcTelemetry?.stop();
      return {
        repoName: projectName,
        repoPath,
        stats: existingMeta.stats ?? {},
        alreadyUpToDate: true,
      };
    }
  }

  if (checkpointEnabled) {
    partialCheckpoint = createPartialAnalysisCheckpointWriter(
      storagePath,
      currentCommit,
      new Date(analysisStart).toISOString(),
      log,
    );
  }

  // ── Cache embeddings from existing index before rebuild ────────────
  let cachedEmbeddingNodeIds = new Set<string>();
  let cachedEmbeddings: CachedEmbedding[] = [];

  if (embeddingsEnabledForRun && existingMeta && !options.force) {
    try {
      progress('embeddings', 0, 'Caching embeddings...');
      await initLbug(lbugPath);
      const cached = await loadCachedEmbeddings();
      cachedEmbeddingNodeIds = cached.embeddingNodeIds;
      cachedEmbeddings = cached.embeddings;
      await closeLbug();
    } catch {
      try {
        await closeLbug();
      } catch {
        /* swallow */
      }
    }
  }

  // ── Phase 1: Full Pipeline (0–60%) ────────────────────────────────
  let pipelineResult: PipelineResult;
  const degradedFiles = new Map<string, string>();
  const recordDegradedFiles = (files?: readonly AnalyzeDegradedFile[]): void => {
    if (!files) return;
    for (const file of files) {
      if (!degradedFiles.has(file.filePath)) {
        degradedFiles.set(file.filePath, file.reason);
      }
    }
  };
  try {
    const pipelineOptions: PipelineOptions = {};
    if (checkpointEnabled || telemetryEnabled) {
      pipelineOptions.onTelemetry = (event) => {
        recordDegradedFiles(event.degradedFiles);
        partialCheckpoint?.record(event);
        if (telemetryEnabled) {
          log(
            `[ontoindex:telemetry] ${JSON.stringify({
              ...gcTelemetry?.snapshot(),
              ...event,
            })}`,
          );
        }
      };
    }
    if (options.profile !== undefined) {
      pipelineOptions.profile = options.profile;
    }
    if (includePaths.length > 0) {
      pipelineOptions.includePaths = includePaths;
    }

    pipelineResult = await runAnalysisPipeline(
      repoPath,
      (p) => {
        const phaseLabel = PHASE_LABELS[p.phase] || p.phase;
        const scaled = Math.round(p.percent * 0.6);
        progress(p.phase, scaled, phaseLabel);
      },
      pipelineOptions,
      dependencies.analyzeRuntime,
    );
  } catch (err) {
    partialCheckpoint?.markFailed(err);
    gcTelemetry?.stop();
    throw err;
  }

  // ── Phase 2: LadybugDB (60–85%) ──────────────────────────────────
  progress('lbug', 60, 'Loading into LadybugDB...');
  emitTelemetry({
    event: 'phase-start',
    phaseName: 'lbug',
    graphNodes: pipelineResult.graph.nodeCount,
    graphRelationships: pipelineResult.graph.relationshipCount,
  });
  const lbugStart = Date.now();

  await closeLbug();
  const lbugFiles = [lbugPath, `${lbugPath}.wal`, `${lbugPath}.lock`];
  for (const f of lbugFiles) {
    try {
      await fs.rm(f, { recursive: true, force: true });
    } catch {
      /* swallow */
    }
  }

  await initLbug(lbugPath);
  try {
    // All work after initLbug is wrapped in try/finally to ensure closeLbug()
    // is called even if an error occurs — the module-level singleton DB handle
    // must be released to avoid blocking subsequent invocations.

    let lbugMsgCount = 0;
    await loadGraphToLbug(
      pipelineResult.graph,
      pipelineResult.repoPath,
      storagePath,
      (msg, event) => {
        lbugMsgCount++;
        const pct = Math.min(84, 60 + Math.round((lbugMsgCount / (lbugMsgCount + 10)) * 24));
        progress('lbug', pct, msg);
        if (event) {
          emitTelemetry({
            phaseName: 'lbug',
            graphNodes: pipelineResult.graph.nodeCount,
            graphRelationships: pipelineResult.graph.relationshipCount,
            ...event,
            lbugEvent: event.event,
            event: 'lbug-step',
          });
        }
      },
    );
    emitTelemetry({
      event: 'phase-end',
      phaseName: 'lbug',
      durationMs: Date.now() - lbugStart,
      graphNodes: pipelineResult.graph.nodeCount,
      graphRelationships: pipelineResult.graph.relationshipCount,
    });

    // ── Phase 3: FTS (85–90%) ─────────────────────────────────────────
    // Materialize the standard FTS indexes while we still have a writable
    // connection. The MCP/query path opens read-only pools, so relying on
    // lazy CREATE_FTS_INDEX at first query can fail operationally.
    progress('fts', 85, 'Creating search indexes...');
    emitTelemetry({
      event: 'phase-start',
      phaseName: 'fts',
      graphNodes: pipelineResult.graph.nodeCount,
      graphRelationships: pipelineResult.graph.relationshipCount,
    });
    const ftsStart = Date.now();
    const nodeCountsByLabel = countGraphNodesByLabel(pipelineResult.graph);
    const createEmptyFTSIndexes = process.env.ONTOINDEX_CREATE_EMPTY_FTS_INDEXES === '1';
    for (const { table, indexName, properties } of FTS_INDEXES) {
      const rowCount = nodeCountsByLabel.get(table) ?? 0;
      const selectedProperties = selectAnalyzeFTSProperties(
        table,
        properties,
        pipelineResult.graph,
      );
      if (rowCount === 0 && !createEmptyFTSIndexes) {
        emitTelemetry({
          event: 'fts-index-skip',
          phaseName: 'fts',
          table,
          indexName,
          properties: selectedProperties,
          rowCount,
          reason: 'empty-table',
          graphNodes: pipelineResult.graph.nodeCount,
          graphRelationships: pipelineResult.graph.relationshipCount,
        });
        continue;
      }
      const ftsIndexStart = Date.now();
      emitTelemetry({
        event: 'fts-index-start',
        phaseName: 'fts',
        table,
        indexName,
        properties: selectedProperties,
        rowCount,
        graphNodes: pipelineResult.graph.nodeCount,
        graphRelationships: pipelineResult.graph.relationshipCount,
      });
      await createFTSIndex(table, indexName, selectedProperties);
      emitTelemetry({
        event: 'fts-index-end',
        phaseName: 'fts',
        table,
        indexName,
        properties: selectedProperties,
        rowCount,
        durationMs: Date.now() - ftsIndexStart,
        graphNodes: pipelineResult.graph.nodeCount,
        graphRelationships: pipelineResult.graph.relationshipCount,
      });
    }
    emitTelemetry({
      event: 'phase-end',
      phaseName: 'fts',
      durationMs: Date.now() - ftsStart,
      graphNodes: pipelineResult.graph.nodeCount,
      graphRelationships: pipelineResult.graph.relationshipCount,
    });

    // ── Phase 3.5: Re-insert cached embeddings ────────────────────────
    if (cachedEmbeddings.length > 0) {
      const cachedDims = cachedEmbeddings[0].embedding.length;
      const { EMBEDDING_DIMS } = await import('./lbug/schema.js');
      if (cachedDims !== EMBEDDING_DIMS) {
        // Dimensions changed (e.g. switched embedding model) — discard cache and re-embed all
        log(
          `Embedding dimensions changed (${cachedDims}d -> ${EMBEDDING_DIMS}d), discarding cache`,
        );
        cachedEmbeddings = [];
        cachedEmbeddingNodeIds = new Set();
      } else {
        progress('embeddings', 88, `Restoring ${cachedEmbeddings.length} cached embeddings...`);
        const { batchInsertEmbeddings: batchInsert } =
          await import('./embeddings/embedding-pipeline.js');
        const EMBED_BATCH = 200;
        for (let i = 0; i < cachedEmbeddings.length; i += EMBED_BATCH) {
          const batch = cachedEmbeddings.slice(i, i + EMBED_BATCH);

          try {
            await batchInsert(executeWithReusedStatement, batch);
          } catch {
            /* some may fail if node was removed, that's fine */
          }
        }
      }
    }

    // ── Phase 4: Embeddings (90–98%) ──────────────────────────────────
    const stats = await getLbugStats();
    let embeddingSkipped = true;

    if (embeddingsEnabledForRun) {
      const embeddableNodeCount = await countEmbeddableGraphNodes();
      const embeddingLimitCount = embeddableNodeCount ?? stats.nodes;
      if (embeddingLimitCount <= EMBEDDING_NODE_LIMIT) {
        embeddingSkipped = false;
      } else {
        log(
          `Skipping embeddings for ${embeddingLimitCount} embeddable nodes (limit ${EMBEDDING_NODE_LIMIT}).`,
        );
      }
    }

    if (!embeddingSkipped) {
      const { isHttpMode } = await import('./embeddings/http-client.js');
      const httpMode = isHttpMode();
      progress(
        'embeddings',
        90,
        httpMode ? 'Connecting to embedding endpoint...' : 'Loading embedding model...',
      );
      const { runEmbeddingPipeline } = await import('./embeddings/embedding-pipeline.js');
      // Build a Map<nodeId, contentHash> from cached embeddings for incremental mode
      let existingEmbeddings: Map<string, string> | undefined;
      if (cachedEmbeddingNodeIds.size > 0) {
        existingEmbeddings = new Map<string, string>();
        for (const e of cachedEmbeddings) {
          existingEmbeddings.set(e.nodeId, e.contentHash ?? STALE_HASH_SENTINEL);
        }
      }

      const { readServerMapping } = await import('./embeddings/server-mapping.js');
      const projectName = path.basename(repoPath);
      const serverName = await readServerMapping(projectName);
      await runEmbeddingPipeline(
        executeQuery,
        executeWithReusedStatement,
        (p) => {
          const scaled = 90 + Math.round((p.percent / 100) * 8);
          const label =
            p.phase === 'loading-model'
              ? httpMode
                ? 'Connecting to embedding endpoint...'
                : 'Loading embedding model...'
              : `Embedding ${p.nodesProcessed || 0}/${p.totalNodes || '?'}`;
          progress('embeddings', scaled, label);
        },
        {},
        cachedEmbeddingNodeIds.size > 0 ? cachedEmbeddingNodeIds : undefined,
        { repoName: projectName, serverName },
        existingEmbeddings,
      );
    }

    // ── Phase 5: Finalize (98–100%) ───────────────────────────────────
    progress('done', 98, 'Saving metadata...');

    // Count embeddings in the index (cached + newly generated)
    let embeddingCount = 0;
    try {
      const embResult = await executeQuery(
        `MATCH (e:${EMBEDDING_TABLE_NAME}) RETURN count(e) AS cnt`,
      );
      embeddingCount = embResult?.[0]?.cnt ?? 0;
    } catch {
      /* table may not exist if embeddings never ran */
    }

    const indexedAt = new Date().toISOString();
    if (annNeighborBuildRequested) {
      if (embeddingCount <= 0) {
        throw new Error(
          'symbol-neighborhood requested, but no embeddings were generated. Check embedding provider configuration and rerun --ann-neighbors.',
        );
      }

      const model =
        process.env.ONTOINDEX_EMBEDDING_MODEL_HASH ??
        existingMeta?.model_hash ??
        ANN_NEIGHBOR_MODEL_FALLBACK;
      const buildId = currentCommit && currentCommit.length > 0 ? currentCommit : `commit:${Date.now()}`;
      const annRows = await loadAnnNeighborEmbeddingRows(model, buildId, indexedAt);
      if (annRows.length === 0) {
        throw new Error(
          'symbol-neighborhood requested, but no embedding rows could be loaded. Check embedding provider configuration and rerun --ann-neighbors.',
        );
      }

      const annEdges = buildAnnNeighborsFromEmbeddingRows({ embeddings: annRows });
      await persistAnnNeighborEdges(executeWithReusedStatement, annEdges);
    }

    const symbolsProfile = options.profile === 'symbols' || options.profile === 'huge-repo-symbols';
    const symbolsOnlyMetadata = symbolsProfile
      ? {
          indexMode: 'symbols-only' as const,
          pipelineProfile: options.profile,
          skippedPhases: [
            'git-mining',
            'markdown',
            'cobol',
            'routes',
            'tools',
            'orm',
            'cross-file',
            'pagerank',
            'mro',
            'communities',
            'processes',
          ],
          capabilities: {
            symbols: true,
            impact: 'degraded' as const,
            processes: false,
          },
        }
      : {};
    const meta = {
      repoPath,
      lastCommit: currentCommit,
      indexedAt,
      stats: {
        files: pipelineResult.totalFileCount,
        nodes: stats.nodes,
        edges: stats.edges,
        communities: pipelineResult.communityResult?.stats.totalCommunities,
        processes: pipelineResult.processResult?.stats.totalProcesses,
        embeddings: embeddingCount,
      },
      ...(includePaths.length > 0 ? { includePaths } : {}),
      ...(degradedFiles.size > 0
        ? {
            degradedFiles: [...degradedFiles.entries()].map(([filePath, reason]) => ({
              filePath,
              reason,
            })),
          }
        : {}),
      ...symbolsOnlyMetadata,
    };
    await saveMeta(storagePath, meta);
    // Forward the --name alias and the registry-collision bypass bit.
    // `allowDuplicateName` is its own concern — independent from the
    // pipeline `force` above. The CLI maps it from
    // `--allow-duplicate-name` only; `--force` and `--skills` both
    // trigger pipeline re-run but never bypass the registry guard.
    // The returned name is the one actually written to the registry
    // (after applying the precedence chain in registerRepo) — reuse it
    // so AGENTS.md / skill files reference the same name MCP clients
    // will look up (#979).
    const projectName = await registerRepo(repoPath, meta, {
      name: options.registryName,
      allowDuplicateName: options.allowDuplicateName,
    });

    await saveGraphDiffSnapshot(storagePath, pipelineResult.graph, indexedAt, currentCommit);
    partialCheckpoint?.clear();

    if (options.markdownSidecar === true) {
      progress('sidecar', 98, 'Queueing Markdown sidecar enrichment...');
      const markdownCollection = await collectMarkdownSidecarDocuments(repoPath, currentCommit);
      if (markdownCollection.documents.length > 0) {
        const decision = createMarkdownDocumentEnrichmentQueueRequest({
          enabled: true,
          repoId: projectName,
          sourceIndexId: indexedAt,
          scopeHash: markdownCollection.scopeHash,
          requestedAt: indexedAt,
        });
        if (decision.queued) {
          const store = new LocalSidecarStore(getSidecarStorePath(storagePath));
          await store.submitRequest(decision.request);
          log(
            `  Queued Markdown sidecar enrichment for ${markdownCollection.documents.length} document(s)`,
          );
        }
      } else {
        log('  Markdown sidecar enrichment enabled, but no Markdown documents were found');
      }
    }

    // Only attempt to update .gitignore when a .git directory is present.
    if (hasGitDir(repoPath)) {
      await addToGitignore(repoPath);
    }

    // ── Generate AI context files (best-effort) ───────────────────────
    let aggregatedClusterCount = 0;
    if (pipelineResult.communityResult?.communities) {
      const groups = new Map<string, number>();
      for (const c of pipelineResult.communityResult.communities) {
        const label = c.heuristicLabel || c.label || 'Unknown';
        groups.set(label, (groups.get(label) || 0) + c.symbolCount);
      }
      aggregatedClusterCount = Array.from(groups.values()).filter((count) => count >= 5).length;
    }

    try {
      await generateAIContextFiles(
        repoPath,
        storagePath,
        projectName,
        {
          files: pipelineResult.totalFileCount,
          nodes: stats.nodes,
          edges: stats.edges,
          communities: pipelineResult.communityResult?.stats.totalCommunities,
          clusters: aggregatedClusterCount,
          processes: pipelineResult.processResult?.stats.totalProcesses,
        },
        undefined,
        { skipAgentsMd: options.skipAgentsMd, noStats: options.noStats },
      );
    } catch {
      // Best-effort — don't fail the entire analysis for context file issues
    }

    // ── Close LadybugDB ──────────────────────────────────────────────
    await closeLbug();

    partialCheckpoint?.clear();
    progress('done', 100, 'Done');

    gcTelemetry?.stop();
    return {
      repoName: projectName,
      repoPath,
      stats: meta.stats,
      pipelineResult,
    };
  } catch (err) {
    // Ensure LadybugDB is closed even on error
    try {
      await closeLbug();
    } catch {
      /* swallow */
    }
    partialCheckpoint?.markFailed(err);
    gcTelemetry?.stop();
    throw err;
  }
}
