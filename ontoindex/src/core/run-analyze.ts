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
import {
  planDirtyOverlay,
  captureWorkspaceInputs,
  type WorkspaceInputCapture,
} from './analyze-delta.js';
import { createTypeScriptAnalyzeRuntime, type AnalyzeRuntime } from './ingestion/runtime/index.js';
import {
  initLbug,
  loadGraphToLbug,
  getLbugStats,
  executeQuery,
  streamQuery,
  executeWithReusedStatement,
  closeLbug,
  closeLbugForPath,
  loadCachedEmbeddings,
  fetchExistingEmbeddingHashes,
  type ExistingEmbeddingHashEntry,
  createFTSIndex,
} from './lbug/lbug-adapter.js';
import {
  getStoragePaths,
  OVERLAY_ARTIFACT_BUDGET_BYTES,
  overlayArtifactBytes,
  pruneOverlayGenerations,
  acquireOverlayGenerationPin,
  readActiveGenerationMeta,
  saveMeta,
  loadMeta,
  addToGitignore,
  registerRepo,
  cleanupOldKuzuFiles,
  createIndexGeneration,
  discardIndexGeneration,
  publishIndexGenerationTransaction,
  type IndexGenerationPaths,
} from '../storage/repo-manager.js';
import type { DegradedFileGroupCount } from '../storage/repo-manager.js';
import { getCurrentCommit, hasGitDir } from '../storage/git.js';
import { getLanguageFromFilename } from 'ontoindex-shared';
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
import { createKnowledgeGraph } from './graph/graph.js';
import {
  summarizeRelationshipDistributions,
  type RelationshipDistributions,
} from './graph/fact-provenance.js';
import { FTS_INDEXES } from './search/bm25-index.js';
import v8 from 'node:v8';
import { PerformanceObserver } from 'node:perf_hooks';
import {
  collectMarkdownSidecarDocuments,
  createMarkdownDocumentEnrichmentQueueRequest,
  getSidecarStorePath,
  LocalSidecarStore,
} from './ingestion/enrichment/index.js';
import { EMBEDDING_TEXT_VERSION } from './embeddings/embedding-pipeline.js';
import {
  computeSourceManifest,
  manifestsMatch,
  sourceManifestDigest,
  sourceInputsMatch,
} from './indexing/source-manifest.js';
import {
  assertValidManagedAnalysisContext,
  commitSourceIdentity,
  writeAnalysisPublicationReceipt,
  type ManagedAnalysisContext,
} from './analysis/analysis-publication-receipt.js';
import {
  beginManagedAnalysisPublication,
  claimManagedAnalysisAnalyzer,
  commitManagedAnalysisPublication,
} from './analysis/analysis-coordinator.js';
import { execFileText } from './process/exec-file.js';
import { digestDatabaseFile } from './lbug/database-digest.js';
import { syncPath, syncTree } from './durable-publish.js';
import {
  workspaceParserIdentity,
  supervisedWorkspaceParserIdentity,
} from './tree-sitter/parser-identity.js';
import type { ScopeRetentionRequest } from './ingestion/pipeline-phases/scope-retention-stage.js';
import {
  persistScopeRetentionCandidate,
  copyScopeRetentionCandidate,
} from './ingestion/pipeline-phases/scope-retention-candidate.js';
import { loadScopeRetentionCandidate } from './ingestion/pipeline-phases/scope-retention-candidate-reader.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

interface AnalyzeCallbacks {
  onProgress: (phase: string, percent: number, message: string) => void;
  onLog?: (message: string) => void;
}

export interface RunFullAnalysisDependencies {
  analyzeRuntime?: AnalyzeRuntime;
  scopeRetention?: ScopeRetentionRequest;
}

export interface AnalyzeOptions {
  /**
   * Force a full re-index of the pipeline. Callers may OR this with
   * other flags that imply re-analysis (e.g. `--skills`), so the value
   * here is the pipeline-force signal.
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
  /** Queue post-index Markdown sidecar enrichment. Default off. */
  markdownSidecar?: boolean;
  /** Skip native LadybugDB close; callers must terminate the process promptly. */
  skipNativeClose?: boolean;
  /** Pipeline profile to run. Defaults to full. */
  profile?: PipelineProfile;
  /** Optional repository-relative roots to scan before ignore filtering. */
  includePaths?: string[];
  /** Build a disposable graph without publishing an index generation. */
  dirtyOverlay?: boolean;
  /** Build an isolated complete graph of captured workspace inputs. */
  workspaceGraph?: boolean;
  /** Repository-relative dirty source files; at most 50, never directory roots. */
  overlayPaths?: string[];
  /** Publication identity supplied only by the managed analysis runner. */
  managedAnalysis?: ManagedAnalysisContext;
}

export type EmbeddingLifecycleMode = 'off' | 'preserve' | 'refresh';
export type EmbeddingLifecycleState =
  | 'available'
  | 'preserved'
  | 'refreshed'
  | 'skipped'
  | 'absent';

export interface EmbeddingLifecycleSummary {
  mode: EmbeddingLifecycleMode;
  state: EmbeddingLifecycleState;
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
    scopeSkippedUnsupportedRustFiles?: number;
  };
  embeddingLifecycle?: EmbeddingLifecycleSummary;
  alreadyUpToDate?: boolean;
  /** The raw pipeline result — only populated when needed by callers (e.g. skill generation). */
  pipelineResult?: PipelineResult;
}

export function resolveEmbeddingLifecycleMode(
  options?: Pick<AnalyzeOptions, 'embeddings' | 'annNeighbors' | 'force'>,
): EmbeddingLifecycleMode {
  if (options?.embeddings !== true && options?.annNeighbors !== true) return 'off';
  return options?.force ? 'refresh' : 'preserve';
}

/**
 * Threshold: auto-skip embeddings for repos with more nodes than this.
 * Override with ONTOINDEX_EMBEDDING_NODE_LIMIT for large first-party repos
 * that would otherwise never populate embeddings, leaving semantic search
 * permanently empty. A non-positive value disables the cap.
 */
const DEFAULT_EMBEDDING_NODE_LIMIT = 50_000;

function embeddingNodeLimit(): number {
  const configured = Number.parseInt(process.env.ONTOINDEX_EMBEDDING_NODE_LIMIT ?? '', 10);
  if (!Number.isFinite(configured)) return DEFAULT_EMBEDDING_NODE_LIMIT;
  return configured <= 0 ? Number.POSITIVE_INFINITY : configured;
}
const MANAGED_GIT_STATUS_TIMEOUT_MS = 5_000;
const MANAGED_GIT_STATUS_MAX_BUFFER = 1024 * 1024;

async function verifyManagedAnalysisSource(
  repoPath: string,
  context: ManagedAnalysisContext,
  boundary: 'before analysis' | 'before publication',
): Promise<string> {
  const currentCommit = getCurrentCommit(repoPath);
  if (currentCommit !== context.targetHead) {
    throw new Error(
      `Managed analysis target HEAD does not match the current repository HEAD ${boundary}.`,
    );
  }

  let status: string;
  try {
    status = await execFileText('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
      cwd: repoPath,
      timeoutMs: MANAGED_GIT_STATUS_TIMEOUT_MS,
      maxBuffer: MANAGED_GIT_STATUS_MAX_BUFFER,
    });
  } catch (error) {
    throw new Error(
      `Managed analysis could not verify a clean Git worktree ${boundary}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (
    status.trim().length > 0 &&
    context.sourceIdentity === commitSourceIdentity(context.targetHead)
  ) {
    throw new Error(`Managed analysis requires a clean Git worktree ${boundary}.`);
  }
  return currentCommit;
}

interface GraphDiffSnapshot {
  lastCommit: string;
  savedAt: string;
  calleesMap: Record<string, string[]>;
  fileToSymbols: Record<string, string[]>;
}

type AnalyzeTelemetryEvent = Parameters<NonNullable<PipelineOptions['onTelemetry']>>[0];

type AnalyzeDegradedFile = NonNullable<AnalyzeTelemetryEvent['degradedFiles']>[number];

/** Maximum degraded groups persisted/projected; remainder is counted, not listed. */
const DEGRADED_GROUP_LIMIT = 20;
/** Maximum degraded sample files persisted in meta.json. */
const DEGRADED_SAMPLE_LIMIT = 100;

/**
 * Collapse a raw degradation reason into a stable cause category so variable
 * details (byte sizes, per-file limits, counts) do not fragment grouping into
 * one group per file. Bounded samples retain the original reason.
 */
function normalizeDegradationCause(reason: string): string {
  return reason.replace(/\d+/g, 'N').replace(/\s+/g, ' ').trim();
}

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
  return Array.isArray(row)
    ? ((row[index] as T | undefined) ?? undefined)
    : ((row[field] as T | undefined) ?? undefined);
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
    if (!arrayLike.every((item) => typeof item === 'number' && Number.isFinite(item)))
      return undefined;
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

    const chunkIndex =
      toIntegerIfFinite(rowField<unknown>(row, 'chunkIndex', 2)) ?? Number.MAX_SAFE_INTEGER;
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

async function runDirtyOverlayAnalysis(
  repoPath: string,
  overlayPaths: string[],
  callbacks: AnalyzeCallbacks,
  dependencies: RunFullAnalysisDependencies,
): Promise<AnalyzeResult> {
  return runWorkspaceAnalysis(repoPath, overlayPaths, callbacks, dependencies, false);
}

async function runWorkspaceAnalysis(
  repoPath: string,
  overlayPaths: string[],
  callbacks: AnalyzeCallbacks,
  dependencies: RunFullAnalysisDependencies,
  workspaceGraph: boolean,
): Promise<AnalyzeResult> {
  if (overlayPaths.length > 50) {
    throw new Error('Dirty overlay is limited to 50 source files; refusing a full scan.');
  }
  const includePaths = await normalizeRepositoryIncludePaths(repoPath, overlayPaths);
  for (const filePath of includePaths) {
    if (!(await fs.lstat(path.join(repoPath, filePath))).isFile()) {
      throw new Error(
        `Dirty overlay paths must be source files, not directories or symlinks: ${filePath}`,
      );
    }
  }

  const { storagePath } = getStoragePaths(repoPath);
  const overlayPath = path.join(storagePath, 'overlay');
  await fs.mkdir(overlayPath, { recursive: true });
  if (!(await fs.lstat(overlayPath)).isDirectory()) {
    throw new Error('Dirty overlay directory must not be a symlink.');
  }
  const previousCurrent = (
    await fs.readFile(path.join(overlayPath, 'CURRENT'), 'utf8').catch(() => '')
  ).trim();
  await pruneOverlayGenerations(overlayPath, previousCurrent);
  const bytes = await overlayArtifactBytes(overlayPath);
  const configuredBudget = Number(process.env.ONTOINDEX_OVERLAY_BUDGET_BYTES);
  const budget =
    Number.isSafeInteger(configuredBudget) &&
    configuredBudget >= 0 &&
    process.env.ONTOINDEX_OVERLAY_BUDGET_BYTES !== undefined
      ? configuredBudget
      : OVERLAY_ARTIFACT_BUDGET_BYTES;
  if (bytes > budget) {
    throw Object.assign(
      new Error(`Overlay artifacts use ${bytes} bytes, exceeding budget ${budget} bytes.`),
      {
        code: 'overlay_budget_exceeded',
      },
    );
  }
  const generationId = `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2)}`;
  const generationPath = path.join(overlayPath, generationId);
  const overlayDbPath = path.join(generationPath, 'lbug');
  const currentTempPath = path.join(overlayPath, `.CURRENT-${generationId}.tmp`);
  await fs.mkdir(generationPath);
  let capture: WorkspaceInputCapture | undefined;
  let persistedCandidateBytes = 0;
  let published = false;
  let replayPin: Awaited<ReturnType<typeof acquireOverlayGenerationPin>> | undefined;
  try {
    const captureStart = performance.now();
    // Build from one verified byte snapshot so the stored manifest identifies the exact inputs.
    if (workspaceGraph) capture = await captureWorkspaceInputs(repoPath);
    else if (includePaths.length > 0)
      capture = await captureWorkspaceInputs(repoPath, { includePaths });
    const inventory: Record<string, [number, number | null, number | null, string]> = {};
    let inventoryTruncated = false;
    if (workspaceGraph) {
      const entries = capture!.manifest.workspaceCapture!.entries;
      inventoryTruncated = entries.length > 100_000;
      if (!inventoryTruncated) {
        for (const entry of entries) {
          const stat = await fs.lstat(path.join(repoPath, entry.path)).catch(() => null);
          inventory[entry.path] = [
            entry.byteLength,
            stat?.mtimeMs ?? null,
            stat?.ino ?? null,
            entry.digest,
          ];
        }
        inventoryTruncated = Buffer.byteLength(JSON.stringify(inventory)) > 64 * 1024 * 1024;
      }
    }
    const captureAndInventoryMs = performance.now() - captureStart;
    const phases: { name: string; durationMs: number }[] = [];
    const activeBase = await readActiveGenerationMeta(storagePath);
    if (
      capture &&
      ((getCurrentCommit(repoPath) || null) !== capture!.head ||
        (activeBase.activeGeneration?.generationId ?? null) !== capture!.baseGenerationId ||
        (activeBase.meta?.lastCommit ?? null) !== capture!.baseCommit)
    ) {
      throw new Error('Workspace graph base or HEAD changed after capture; rebuild required.');
    }
    const dirtyPlan = workspaceGraph ? await planDirtyOverlay(repoPath) : undefined;
    const dirtyPathSet = new Set(dirtyPlan?.allDirtyPaths ?? includePaths);
    let degraded = inventoryTruncated;
    let parseErrorCount = 0;
    const parseErrorFiles = new Set<string>();
    const overlayBase = {
      head: capture?.head ?? (getCurrentCommit(repoPath) || null),
      baseGenerationId: activeBase.activeGeneration?.generationId ?? null,
      baseCommit: activeBase.meta?.lastCommit ?? null,
      manifestDigest: capture?.manifestDigest ?? null,
      configurationDigest: capture?.manifest.workspaceCapture?.configurationDigest ?? null,
      parserIdentity: capture?.manifest.workspaceCapture?.parserIdentity ?? null,
      includePaths,
      ...(workspaceGraph
        ? {
            inventory: inventoryTruncated ? undefined : inventory,
            inventoryTruncated,
            ...(inventoryTruncated
              ? {
                  inventoryReason:
                    'workspace graph input inventory exceeds 100000 entries or 64 MiB',
                }
              : {}),
            capability: 'workspace-graph',
            profile: 'full',
            coverage: 'complete',
            parseErrorCount: 0,
            parseErrorFiles: [] as string[],
            ftsIndexes: undefined as string[] | undefined,
            ftsDurationMs: undefined as number | undefined,
            dirtyPaths: [...dirtyPathSet].sort(),
            tombstones: [...dirtyPlan!.tombstones].sort(),
          }
        : {}),
      inputs: Object.fromEntries(
        (capture?.manifest.workspaceCapture?.entries ?? [])
          .filter((entry) => dirtyPathSet.has(entry.path))
          .map((entry) => [entry.path, entry.digest]),
      ),
    };
    const retentionCapture = workspaceGraph ? capture : undefined;
    const retentionRequest = dependencies.scopeRetention;
    let scopeReplay: PipelineOptions['scopeReplay'];
    if (
      retentionRequest &&
      retentionCapture &&
      /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(previousCurrent)
    ) {
      const checkReplayRequest = () => {
        if (retentionRequest.signal?.aborted) throw new Error('Workspace replay cancelled');
        if (!Number.isFinite(retentionRequest.deadline) || Date.now() >= retentionRequest.deadline)
          throw new Error('Workspace replay deadline');
      };
      checkReplayRequest();
      // Only the supervised child captures a baseline before loading analyzer code.
      const parserCodeIdentity = await supervisedWorkspaceParserIdentity();
      checkReplayRequest();
      if (parserCodeIdentity !== null) {
        const sourceGenerationPath = path.join(overlayPath, previousCurrent);
        const expected = {
          identity: {
            sourceManifestDigest: retentionCapture.manifestDigest,
            targetCommit: retentionCapture.head ?? '',
            baseGenerationId: retentionCapture.baseGenerationId,
          },
          parserCodeIdentity,
        };
        try {
          replayPin = await acquireOverlayGenerationPin(sourceGenerationPath);
          const candidate = await loadScopeRetentionCandidate(
            sourceGenerationPath,
            expected,
            retentionRequest,
          );
          checkReplayRequest();
          scopeReplay = {
            candidate,
            request: retentionRequest,
            preserve: async () => {
              const before = retentionRequest.artifactAllowance.remainingBytes;
              try {
                await copyScopeRetentionCandidate(
                  sourceGenerationPath,
                  generationPath,
                  expected,
                  retentionRequest,
                );
              } finally {
                persistedCandidateBytes =
                  before - retentionRequest.artifactAllowance.remainingBytes;
              }
            },
          };
        } catch {
          checkReplayRequest();
          // Missing, stale or corrupt candidates are ordinary full-parse misses.
        }
      }
    }
    const scopeRetention: PipelineOptions['scopeRetention'] =
      retentionRequest && retentionCapture
        ? {
            ...retentionRequest,
            consume: async (handle) => {
              const before = retentionRequest.artifactAllowance.remainingBytes;
              try {
                await persistScopeRetentionCandidate(
                  handle,
                  generationPath,
                  {
                    sourceManifestDigest: retentionCapture.manifestDigest,
                    targetCommit: retentionCapture.head ?? '',
                    baseGenerationId: retentionCapture.baseGenerationId,
                  },
                  retentionRequest,
                );
              } finally {
                persistedCandidateBytes =
                  before - retentionRequest.artifactAllowance.remainingBytes;
              }
            },
          }
        : undefined;
    const pipelineStart = performance.now();
    const pipelineResult: PipelineResult =
      !workspaceGraph && includePaths.length === 0
        ? { graph: createKnowledgeGraph(), repoPath, totalFileCount: 0, usedWorkerPool: false }
        : await runAnalysisPipeline(
            repoPath,
            (p) =>
              callbacks.onProgress(
                p.phase,
                Math.round(p.percent * 0.6),
                PHASE_LABELS[p.phase] || p.phase,
              ),
            {
              profile: workspaceGraph ? 'full' : 'symbols',
              ...(scopeRetention ? { scopeRetention } : {}),
              ...(scopeReplay ? { scopeReplay } : {}),
              ...(workspaceGraph
                ? {
                    onTelemetry: (
                      event: Parameters<NonNullable<PipelineOptions['onTelemetry']>>[0],
                    ) => {
                      if (
                        event.event === 'phase-end' &&
                        typeof event.phaseName === 'string' &&
                        event.phaseName.length > 0 &&
                        typeof event.durationMs === 'number' &&
                        Number.isFinite(event.durationMs) &&
                        event.durationMs >= 0 &&
                        phases.length < 128
                      ) {
                        phases.push({ name: event.phaseName, durationMs: event.durationMs });
                      }
                      if (event.event === 'parse-error-files') {
                        parseErrorCount += event.parseErrorCount ?? 0;
                        for (const filePath of event.parseErrorFiles ?? []) {
                          if (parseErrorFiles.size < 1000) parseErrorFiles.add(filePath);
                        }
                      }
                      if (
                        event.degradedFiles?.length ||
                        event.event === 'phase-error' ||
                        event.degradedReason ||
                        event.slowFiles?.some((file) => file.status !== 'processed')
                      ) {
                        degraded = true;
                      }
                    },
                  }
                : { includePaths }),
              capturedWorkspace: {
                captureRoot: capture!.captureRoot,
                canonicalRepoPath: capture!.canonicalRepoPath,
              },
            },
            dependencies.analyzeRuntime,
          );
    const pipelineMs = performance.now() - pipelineStart;
    const storageStart = performance.now();
    await initLbug(overlayDbPath, { maxDBSize: 2 ** 32 });
    await loadGraphToLbug(
      pipelineResult.graph,
      capture?.captureRoot ?? repoPath,
      generationPath,
      (message) => {
        callbacks.onProgress('lbug', 80, message);
      },
    );
    const stats = await getLbugStats();
    const storageLoadMs = performance.now() - storageStart;
    let ftsIndexes: string[] | undefined;
    let ftsDurationMs: number | undefined;
    if (workspaceGraph) {
      // Pool readers are read-only and cannot create indexes, so build them before publishing.
      const ftsStart = performance.now();
      const counts = countGraphNodesByLabel(pipelineResult.graph);
      ftsIndexes = [];
      for (const { table, indexName, properties } of FTS_INDEXES) {
        if ((counts.get(table) ?? 0) === 0) continue;
        try {
          await createFTSIndex(
            table,
            indexName,
            selectAnalyzeFTSProperties(table, properties, pipelineResult.graph),
          );
          ftsIndexes.push(indexName);
        } catch (error) {
          // Without the extension the generation stays valid but cannot rank lexical queries.
          if (!/FTS extension unavailable/.test(error instanceof Error ? error.message : '')) {
            throw error;
          }
          ftsIndexes = [];
          break;
        }
      }
      ftsDurationMs = performance.now() - ftsStart;
    }
    // A swallowed native close failure must not be followed by publication of the generation.
    await closeLbugForPath(overlayDbPath, { strict: true });
    const databaseDigest = await digestDatabaseFile(overlayDbPath);
    if (workspaceGraph) {
      overlayBase.ftsIndexes = ftsIndexes;
      overlayBase.ftsDurationMs = ftsDurationMs;
      Object.assign(overlayBase, {
        buildTimings: {
          ...(pipelineResult.parseMode === 'full' || pipelineResult.parseMode === 'retained-replay'
            ? { parseMode: pipelineResult.parseMode }
            : {}),
          captureAndInventoryMs,
          pipelineMs,
          storageLoadMs,
          ftsMs: ftsDurationMs,
          phases,
        },
      });
      // A truncated path list cannot say which files failed, so no path may be called authoritative.
      const parseErrorListTruncated = parseErrorCount > parseErrorFiles.size;
      overlayBase.coverage =
        degraded || parseErrorListTruncated
          ? 'degraded'
          : parseErrorCount > 0
            ? 'partial'
            : 'complete';
      overlayBase.parseErrorCount = parseErrorCount;
      overlayBase.parseErrorFiles = [...parseErrorFiles].sort();
    }
    const currentBase = await readActiveGenerationMeta(storagePath);
    if (
      (getCurrentCommit(repoPath) || null) !== overlayBase.head ||
      (currentBase.activeGeneration?.generationId ?? null) !== overlayBase.baseGenerationId ||
      (currentBase.meta?.lastCommit ?? null) !== overlayBase.baseCommit
    ) {
      throw new Error('Workspace graph base or HEAD changed during analysis; rebuild required.');
    }
    await fs.writeFile(
      path.join(generationPath, 'base.json'),
      JSON.stringify({ ...overlayBase, databaseDigest }),
    );
    callbacks.onProgress('done', 100, 'Dirty overlay built; active index unchanged');
    await fs.writeFile(currentTempPath, `${generationId}\n`);
    await syncTree(generationPath);
    await syncPath(currentTempPath);
    if (capture && (await workspaceParserIdentity()) !== capture.parserIdentity) {
      throw new Error('Workspace parser identity changed during analysis; restart required.');
    }
    await fs.rename(currentTempPath, path.join(overlayPath, 'CURRENT'));
    published = true;
    await syncPath(overlayPath, { bestEffort: true }).catch(() => {});

    // Published stores are immutable. A Windows reader may retain a file lock,
    // so pruning is only housekeeping, never a condition of build success.
    let pruneFailed = false;
    try {
      pruneFailed = await pruneOverlayGenerations(overlayPath, generationId);
      const publishedBytes = await overlayArtifactBytes(overlayPath);
      if (publishedBytes > budget) {
        // The budget is checked before a build, so one build can overshoot; say so instead of hiding it.
        try {
          callbacks.onLog?.(
            `Overlay artifacts now use ${publishedBytes} bytes, above the ${budget} byte budget; the next build will be refused until older generations are released.`,
          );
        } catch {
          // A logging callback must not turn housekeeping into a failed build.
        }
      }
      // Legacy single-file overlays are never opened by generation readers.
      await fs.rm(path.join(overlayPath, 'lbug'), { recursive: true, force: true }).catch(() => {
        pruneFailed = true;
      });
    } catch {
      pruneFailed = true;
    }
    if (pruneFailed) {
      try {
        callbacks.onLog?.('Dirty overlay published; some old generations could not be pruned.');
      } catch {
        // A logging callback must not turn housekeeping into a failed build.
      }
    }
    return {
      repoName: path.basename(repoPath),
      repoPath,
      stats: {
        ...stats,
        files: pipelineResult.totalFileCount,
        embeddings: 0,
        scopeSkippedUnsupportedRustFiles: pipelineResult.scopeSkippedUnsupportedRustFiles,
      },
      embeddingLifecycle: { mode: 'off', state: 'absent' },
      pipelineResult,
    };
  } catch (err) {
    await closeLbugForPath(overlayDbPath).catch(() => {});
    if (!published) {
      await fs.rm(currentTempPath, { force: true }).catch(() => {});
      await fs
        .rm(generationPath, { recursive: true, force: true })
        .then(() => {
          if (dependencies.scopeRetention) {
            dependencies.scopeRetention.artifactAllowance.remainingBytes += persistedCandidateBytes;
            persistedCandidateBytes = 0;
          }
        })
        .catch(() => {});
    }
    throw err;
  } finally {
    await replayPin?.release().catch(() => {});
    await capture?.dispose().catch(() => {});
  }
}

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
  // Keep overlay builds outside every active-index lifecycle operation below.
  if (options.workspaceGraph === true) {
    return runWorkspaceAnalysis(repoPath, [], callbacks, dependencies, true);
  }
  if (options.dirtyOverlay === true) {
    return runDirtyOverlayAnalysis(repoPath, options.overlayPaths ?? [], callbacks, dependencies);
  }
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

  const { storagePath, lbugPath: activeLbugPath } = getStoragePaths(repoPath);
  const repoHasGit = hasGitDir(repoPath);
  let currentCommit = repoHasGit ? getCurrentCommit(repoPath) : '';
  if (options.managedAnalysis) {
    assertValidManagedAnalysisContext(options.managedAnalysis);
    if (options.force !== true) {
      gcTelemetry?.stop();
      throw new Error('Managed analysis requires force=true.');
    }
    if (!repoHasGit) {
      gcTelemetry?.stop();
      throw new Error('Managed analysis requires a Git worktree with a readable HEAD.');
    }
    if (
      options.managedAnalysis.requestedCapabilities.embeddings &&
      options.embeddings !== true &&
      options.annNeighbors !== true
    ) {
      gcTelemetry?.stop();
      throw new Error(
        'Managed analysis requested embeddings, but no embedding analysis option was enabled.',
      );
    }
    try {
      await claimManagedAnalysisAnalyzer(repoPath, options.managedAnalysis);
      currentCommit = await verifyManagedAnalysisSource(
        repoPath,
        options.managedAnalysis,
        'before analysis',
      );
    } catch (error) {
      gcTelemetry?.stop();
      throw error;
    }
  }
  if (repoHasGit && !options.managedAnalysis) {
    await addToGitignore(repoPath);
  }
  const includePaths = await normalizeRepositoryIncludePaths(repoPath, options.includePaths);
  const requestedProfile = requestedPipelineProfile(options.profile);
  const inputManifest = await computeSourceManifest(repoPath, {
    includePaths,
    pipelineProfile: requestedProfile,
  });
  if (
    options.managedAnalysis &&
    sourceManifestDigest(inputManifest).toLowerCase() !==
      options.managedAnalysis.sourceManifestDigest.toLowerCase()
  ) {
    gcTelemetry?.stop();
    throw new Error(
      'Managed analysis source manifest does not match the submission-time manifest digest.',
    );
  }
  const embeddingLifecycleMode = resolveEmbeddingLifecycleMode(options);
  const embeddingsEnabledForRun = embeddingLifecycleMode !== 'off';
  const annNeighborBuildRequested = options.annNeighbors === true;

  // Clean up stale KuzuDB files from before the LadybugDB migration.
  const kuzuResult = await cleanupOldKuzuFiles(storagePath);
  if (kuzuResult.found && kuzuResult.needsReindex) {
    log('Migrating from KuzuDB to LadybugDB — rebuilding index...');
  }

  const existingMeta = await loadMeta(storagePath);
  let embeddingVectorIndexDigest = existingMeta?.embeddingVectorIndexDigest;

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
    !dependencies.scopeRetention &&
    existingMeta.lastCommit === currentCommit &&
    persistedPipelineProfile(existingMeta) === requestedProfile &&
    sameStringList(existingMeta.includePaths, includePaths) &&
    manifestsMatch(existingMeta.sourceManifest, inputManifest) &&
    existingMeta.sourceManifest?.coverage === 'complete'
  ) {
    // Non-git folders have currentCommit = '' — always rebuild since we can't detect changes
    if (currentCommit !== '') {
      const projectName = await registerRepo(repoPath, existingMeta, {
        name: options.registryName,
      });
      gcTelemetry?.stop();
      return {
        repoName: projectName,
        repoPath,
        stats: existingMeta.stats ?? {},
        embeddingLifecycle: {
          mode: embeddingLifecycleMode,
          state: (existingMeta.stats?.embeddings ?? 0) > 0 ? 'available' : 'absent',
        },
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
  let existingEmbeddings: Map<string, ExistingEmbeddingHashEntry> | undefined;

  if (embeddingsEnabledForRun && existingMeta && !options.force) {
    try {
      progress('embeddings', 0, 'Caching embeddings...');
      await initLbug(activeLbugPath);
      const cached = await loadCachedEmbeddings();
      cachedEmbeddingNodeIds = cached.embeddingNodeIds;
      cachedEmbeddings = cached.embeddings;
      existingEmbeddings = await fetchExistingEmbeddingHashes(executeQuery);
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
  let stagedGeneration: IndexGenerationPaths | null = null;
  let persistedCandidateBytes = 0;
  const degradedFiles = new Map<string, { reason: string; phase: string; language: string }>();
  const recordDegradedFiles = (
    files?: readonly AnalyzeDegradedFile[],
    phaseName?: string,
  ): void => {
    if (!files) return;
    for (const file of files) {
      if (!degradedFiles.has(file.filePath)) {
        const phase = phaseName ?? 'unknown';
        const lang = getLanguageFromFilename(file.filePath);
        const language = lang ?? 'unknown';
        degradedFiles.set(file.filePath, {
          reason: file.reason,
          phase,
          language,
        });
      }
    }
  };
  try {
    const pipelineOptions: PipelineOptions = {};
    pipelineOptions.onTelemetry = (event) => {
      recordDegradedFiles(event.degradedFiles, event.phaseName);
      if (checkpointEnabled || telemetryEnabled) {
        partialCheckpoint?.record(event);
        if (telemetryEnabled) {
          log(
            `[ontoindex:telemetry] ${JSON.stringify({
              ...gcTelemetry?.snapshot(),
              ...event,
            })}`,
          );
        }
      }
    };
    if (options.profile !== undefined) {
      pipelineOptions.profile = options.profile;
    }
    if (includePaths.length > 0) {
      pipelineOptions.includePaths = includePaths;
    }
    if (dependencies.scopeRetention) {
      const request = dependencies.scopeRetention;
      const generation = await createIndexGeneration(
        storagePath,
        `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2)}`,
      );
      stagedGeneration = generation;
      pipelineOptions.scopeRetention = {
        ...request,
        consume: async (handle) => {
          const before = request.artifactAllowance.remainingBytes;
          try {
            await persistScopeRetentionCandidate(
              handle,
              generation.generationPath,
              {
                sourceManifestDigest: sourceManifestDigest(inputManifest),
                targetCommit: currentCommit,
                baseGenerationId: existingMeta?.generationId ?? null,
              },
              request,
            );
          } finally {
            persistedCandidateBytes = before - request.artifactAllowance.remainingBytes;
          }
        },
      };
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
    if (stagedGeneration !== null) {
      await discardIndexGeneration(stagedGeneration)
        .then(() => {
          if (dependencies.scopeRetention) {
            dependencies.scopeRetention.artifactAllowance.remainingBytes += persistedCandidateBytes;
            persistedCandidateBytes = 0;
          }
        })
        .catch(() => {});
    }
    partialCheckpoint?.markFailed(err);
    gcTelemetry?.stop();
    throw err;
  }

  // ── Phase 2: LadybugDB (60–85%) ──────────────────────────────────
  try {
    progress('lbug', 60, 'Loading into LadybugDB...');
    emitTelemetry({
      event: 'phase-start',
      phaseName: 'lbug',
      graphNodes: pipelineResult.graph.nodeCount,
      graphRelationships: pipelineResult.graph.relationshipCount,
    });
    const lbugStart = Date.now();

    stagedGeneration ??= await createIndexGeneration(
      storagePath,
      `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2)}`,
    );
    const generationStoragePath = stagedGeneration.generationPath;
    const lbugPath = stagedGeneration.lbugPath;

    await initLbug(lbugPath);
    // Initialization and all subsequent work are wrapped in try/finally to ensure closeLbug()
    // is called even if an error occurs — the module-level singleton DB handle
    // must be released to avoid blocking subsequent invocations.

    let lbugMsgCount = 0;
    await loadGraphToLbug(
      pipelineResult.graph,
      pipelineResult.repoPath,
      generationStoragePath,
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
      try {
        await createFTSIndex(table, indexName, selectedProperties);
      } catch (error) {
        // A missing FTS extension must not fail the whole analysis: publish the
        // graph without full-text indexes and say how to enable them.
        if (!/FTS extension unavailable/.test(error instanceof Error ? error.message : '')) {
          throw error;
        }
        log(
          '  FTS extension unavailable; skipping full-text indexes (keyword search is degraded). Install libfts.lbug_extension or set ONTOINDEX_ALLOW_EXTENSION_INSTALL=1, then re-run analyze --force.',
        );
        emitTelemetry({
          event: 'fts-index-skip',
          phaseName: 'fts',
          table,
          indexName,
          properties: selectedProperties,
          rowCount,
          reason: 'extension-unavailable',
          graphNodes: pipelineResult.graph.nodeCount,
          graphRelationships: pipelineResult.graph.relationshipCount,
        });
        break;
      }
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
      const nodeLimit = embeddingNodeLimit();
      if (embeddingLimitCount <= nodeLimit) {
        embeddingSkipped = false;
      } else {
        log(
          `Skipping embeddings for ${embeddingLimitCount} embeddable nodes (limit ${nodeLimit}). ` +
            `Set ONTOINDEX_EMBEDDING_NODE_LIMIT to raise or disable this cap.`,
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
      // Use durable rows as the incremental source of truth when available.
      let incrementalEmbeddings: Map<string, ExistingEmbeddingHashEntry> | undefined =
        existingEmbeddings;

      // If durable rows are not available, keep previous fast path behavior.
      if (cachedEmbeddingNodeIds.size > 0) {
        if (!incrementalEmbeddings) {
          incrementalEmbeddings = new Map<string, ExistingEmbeddingHashEntry>();
        }
        for (const e of cachedEmbeddings) {
          if (!incrementalEmbeddings.has(e.nodeId)) {
            incrementalEmbeddings.set(e.nodeId, e.contentHash ?? STALE_HASH_SENTINEL);
          }
        }
      }

      const { readServerMapping } = await import('./embeddings/server-mapping.js');
      const projectName = path.basename(repoPath);
      const serverName = await readServerMapping(projectName);
      const embeddingCheckpointOptions = {
        path: path.join(generationStoragePath, 'embedding-checkpoint.json'),
        embeddingTextVersion: EMBEDDING_TEXT_VERSION,
        modelHash: process.env.ONTOINDEX_EMBEDDING_MODEL_HASH ?? existingMeta?.model_hash ?? '',
        headCommit: currentCommit,
      };
      const embeddingPipelineResult = await runEmbeddingPipeline(
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
        incrementalEmbeddings,
        undefined,
        embeddingVectorIndexDigest,
        embeddingCheckpointOptions,
      );

      if (embeddingPipelineResult?.vectorIndexDigest) {
        embeddingVectorIndexDigest = embeddingPipelineResult.vectorIndexDigest;
      }
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
    if (
      options.managedAnalysis?.requestedCapabilities.embeddings === true &&
      (embeddingSkipped || embeddingCount <= 0)
    ) {
      throw new Error(
        'Managed analysis requested embeddings, but no embeddings were successfully published.',
      );
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
      const buildId =
        currentCommit && currentCommit.length > 0 ? currentCommit : `commit:${Date.now()}`;
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
    const pipelineCapabilityMetadata = symbolsProfile
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
      : {
          pipelineProfile: requestedProfile,
          capabilities: {
            symbols: true,
            impact: 'full' as const,
            processes: pipelineResult.processResult !== undefined,
          },
        };
    if (options.managedAnalysis) {
      const publishedGraphCapabilities = pipelineCapabilityMetadata.capabilities;
      const missingGraphCapability =
        options.managedAnalysis.requestedCapabilities.graphCapabilities.find((capability) => {
          if (capability === 'symbols') return publishedGraphCapabilities.symbols !== true;
          if (capability === 'impact') return publishedGraphCapabilities.impact !== 'full';
          return publishedGraphCapabilities.processes !== true;
        });
      if (missingGraphCapability) {
        throw new Error(
          `Managed analysis requested graph capability "${missingGraphCapability}", but it was not successfully published.`,
        );
      }
    }
    const embeddingLifecycle: EmbeddingLifecycleSummary = !embeddingsEnabledForRun
      ? {
          mode: embeddingLifecycleMode,
          state: embeddingCount > 0 ? 'available' : 'absent',
        }
      : embeddingSkipped
        ? {
            mode: embeddingLifecycleMode,
            state: 'skipped',
          }
        : options.force
          ? {
              mode: embeddingLifecycleMode,
              state: 'refreshed',
            }
          : cachedEmbeddings.length > 0
            ? {
                mode: embeddingLifecycleMode,
                state: 'preserved',
              }
            : {
                mode: embeddingLifecycleMode,
                state: 'available',
              };
    const persistedModelHash =
      process.env.ONTOINDEX_EMBEDDING_MODEL_HASH?.trim() || existingMeta?.model_hash?.trim();
    // Single bounded pass over existing relationships; retains aggregate maps
    // only, never per-edge provenance. Reuses classifyGraphFactProvenance via
    // summarizeRelationshipDistributions with only relationType and confidence.
    const relationshipDistributions: RelationshipDistributions = summarizeRelationshipDistributions(
      (visit) =>
        pipelineResult.graph.forEachRelationship((rel) =>
          visit({ type: rel.type, confidence: rel.confidence }),
        ),
    );
    emitTelemetry({
      event: 'relationship-distributions',
      phaseName: 'meta',
      graphNodes: pipelineResult.graph.nodeCount,
      graphRelationships: pipelineResult.graph.relationshipCount,
      relationshipDistributions,
    });
    const finalManifest = await computeSourceManifest(repoPath, {
      includePaths,
      pipelineProfile: requestedProfile,
      degradedPaths: [...degradedFiles.keys()],
    });
    const finalManifestDigest = sourceManifestDigest(finalManifest);
    if (!sourceInputsMatch(inputManifest, finalManifest)) {
      throw new Error(
        'Source inputs changed during analysis; refusing to publish graph generation.',
      );
    }
    if (
      options.managedAnalysis &&
      finalManifestDigest.toLowerCase() !==
        options.managedAnalysis.sourceManifestDigest.toLowerCase()
    ) {
      throw new Error(
        'Managed analysis final source manifest does not match the submission-time manifest digest.',
      );
    }
    const meta = {
      repoPath,
      lastCommit: currentCommit,
      indexedAt,
      generationId: stagedGeneration.generationId,
      sourceManifest: finalManifest,
      stats: {
        files: pipelineResult.totalFileCount,
        nodes: stats.nodes,
        edges: stats.edges,
        communities: pipelineResult.communityResult?.stats.totalCommunities,
        processes: pipelineResult.processResult?.stats.totalProcesses,
        embeddings: embeddingCount,
        scopeSkippedUnsupportedRustFiles: pipelineResult.scopeSkippedUnsupportedRustFiles,
      },
      relationshipDistributions,
      ...(includePaths.length > 0 ? { includePaths } : {}),
      ...(persistedModelHash ? { model_hash: persistedModelHash } : {}),
      ...(embeddingVectorIndexDigest !== undefined ? { embeddingVectorIndexDigest } : {}),
      ...(degradedFiles.size > 0
        ? (() => {
            const allEntries = [...degradedFiles.entries()].map(([filePath, data]) => ({
              filePath,
              reason: data.reason,
              phase: data.phase,
              language: data.language,
            }));
            const groupMap = new Map<string, DegradedFileGroupCount>();
            for (const entry of allEntries) {
              const cause = normalizeDegradationCause(entry.reason);
              const key = `${cause}|${entry.phase}|${entry.language}`;
              const existing = groupMap.get(key);
              if (existing) {
                existing.count++;
              } else {
                groupMap.set(key, {
                  cause,
                  phase: entry.phase,
                  language: entry.language,
                  count: 1,
                });
              }
            }
            const allGroups = [...groupMap.values()].sort((a, b) => {
              if (b.count !== a.count) return b.count - a.count;
              if (a.cause !== b.cause) return a.cause.localeCompare(b.cause);
              if (a.phase !== b.phase) return a.phase.localeCompare(b.phase);
              return a.language.localeCompare(b.language);
            });
            const groups = allGroups.slice(0, DEGRADED_GROUP_LIMIT);
            const sampleFiles = allEntries.slice(0, DEGRADED_SAMPLE_LIMIT);
            return {
              degradedFiles: sampleFiles,
              degradedFileAggregates: {
                sampledDegradedCount: allEntries.length,
                groups,
                omittedGroupCount: allGroups.length - groups.length,
              },
            };
          })()
        : {}),
      ...pipelineCapabilityMetadata,
    };
    await saveGraphDiffSnapshot(
      generationStoragePath,
      pipelineResult.graph,
      indexedAt,
      currentCommit,
    );
    await saveMeta(generationStoragePath, meta);
    if (options.managedAnalysis) {
      const managedContext = options.managedAnalysis as ManagedAnalysisContext;
      await beginManagedAnalysisPublication(repoPath, managedContext);
      await verifyManagedAnalysisSource(repoPath, managedContext, 'before publication');
      const publicationManifest = await computeSourceManifest(repoPath, {
        includePaths,
        pipelineProfile: requestedProfile,
        degradedPaths: [...degradedFiles.keys()],
      });
      if (
        sourceManifestDigest(publicationManifest).toLowerCase() !==
        managedContext.sourceManifestDigest.toLowerCase()
      ) {
        throw new Error(
          'Managed analysis publication source manifest does not match the submission-time manifest digest.',
        );
      }
      await writeAnalysisPublicationReceipt(generationStoragePath, {
        version: 1,
        jobId: managedContext.jobId,
        repoPath: path.resolve(repoPath),
        targetHead: managedContext.targetHead,
        optionsDigest: managedContext.optionsDigest,
        sourceIdentity: managedContext.sourceIdentity,
        sourceManifestDigest: finalManifestDigest,
        generationId: stagedGeneration.generationId,
        requestedCapabilities: managedContext.requestedCapabilities,
        analyzerContractVersion: finalManifest.analyzerContractVersion,
        publishedAt: new Date().toISOString(),
      });
      await closeLbug({ strict: true });
      const publishedGeneration = stagedGeneration;
      await publishIndexGenerationTransaction(storagePath, publishedGeneration, (activation) =>
        commitManagedAnalysisPublication(
          repoPath,
          managedContext,
          activation.activeGeneration.generationId,
          finalManifestDigest,
        ),
      );
      stagedGeneration = null;
    } else {
      await closeLbug({ strict: true });
      await publishIndexGenerationTransaction(storagePath, stagedGeneration, async () => undefined);
      stagedGeneration = null;
    }

    // Forward the --name alias after the complete generation is active.
    const projectName = await registerRepo(repoPath, meta, {
      name: options.registryName,
    });

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
    if (!options.skipNativeClose) {
      await closeLbug();
    }

    partialCheckpoint?.clear();
    progress('done', 100, 'Done');

    gcTelemetry?.stop();
    return {
      repoName: projectName,
      repoPath,
      stats: meta.stats,
      embeddingLifecycle,
      pipelineResult,
    };
  } catch (err) {
    // Ensure LadybugDB is closed even on error
    try {
      if (!options.skipNativeClose) {
        await closeLbug();
      }
    } catch {
      /* swallow */
    }
    if (stagedGeneration !== null) {
      await discardIndexGeneration(stagedGeneration)
        .then(() => {
          if (dependencies.scopeRetention) {
            dependencies.scopeRetention.artifactAllowance.remainingBytes += persistedCandidateBytes;
            persistedCandidateBytes = 0;
          }
        })
        .catch(() => {});
    }
    partialCheckpoint?.markFailed(err);
    gcTelemetry?.stop();
    throw err;
  }
}
