import fs from 'node:fs/promises';
import path from 'node:path';

import { execFileText } from '../process/exec-file.js';
import { summarizeGitPorcelainStatus } from '../../core/audit-lifecycle/freshness.js';
import { getCurrentCommit, hasGitDir } from '../../storage/git.js';
import {
  computeSourceManifest,
  sourceInputsMatch,
  SOURCE_MANIFEST_VERSION,
  SOURCE_MANIFEST_CONTRACT,
} from '../indexing/source-manifest.js';
import {
  getStoragePaths,
  loadMeta,
  type RepoMeta,
  type DegradedFileAggregates,
} from '../../storage/repo-manager.js';
import { planDirtyOverlay } from '../analyze-delta.js';

export type RuntimeHealthState =
  | 'clean'
  | 'stale'
  | 'dirty'
  | 'degraded'
  | 'untrusted'
  | 'failed-after-partial-run';

export interface RuntimeAnalyzeLockState {
  path: string;
  present: boolean;
  state: 'absent' | 'active' | 'stale' | 'unknown';
  pid?: number;
  startedAt?: string;
  processStartIdentity?: string;
  reason?: string;
}

export interface RuntimeRepairAction {
  tool: 'ontoindex';
  command: 'analyze' | 'status';
  args: string[];
  reason: string;
}

export interface RuntimeAnalysisCheckpointState {
  path: string;
  present: boolean;
  state: 'absent' | 'running' | 'partial' | 'failed' | 'unknown';
  phase?: string;
  phaseStatus?: 'started' | 'completed' | 'failed';
  updatedAt?: string;
  reason?: string;
}

export interface RuntimeEmbeddingCheckpointState {
  path: string;
  present: boolean;
  reason?: string;
}

export interface RuntimeBootstrapSourceState {
  path: string;
  present: boolean;
  restoredAt?: string;
  artifactGeneratedAt?: string;
  sourceIndexedCommit?: string | null;
  sourceRepoLabel?: string;
  sourceOntoindexVersion?: string;
  reason?: string;
}

export interface RuntimeHealthSnapshot {
  version: 1;
  repoLabel: string;
  repoPath: string;
  indexedCommit: string | null;
  currentCommit: string | null;
  dirtyWorktree: boolean | null;
  freshnessState: RuntimeHealthState;
  /** Commit-only freshness, excluding uncommitted source changes. */
  committedFreshness?: 'fresh' | 'stale' | 'unknown';
  /** Bounded source-file coverage available to a dirty overlay. */
  dirtyCoverage?: {
    state: 'none' | 'coverable' | 'over-cap' | 'unknown';
    dirtySourceFiles: number | null;
    coveredFiles?: number | null;
    uncoveredFiles?: number | null;
    cap: number;
  };
  /** Whether stored metadata reports at least one embedding vector. */
  embeddingsAvailable?: boolean | null;
  workspaceReadiness?: {
    /** Size check only; no workspace graph build is attempted. */
    state: 'not-checked' | 'within-limit' | 'over-limit';
    dirtyCoverageScope: 'symbol-overlay-eligibility';
    preparationChecked: false;
    indexedFiles?: number;
    maxIndexedFiles?: number;
    remediation?: string;
  };
  degradedReason: string | null;
  repairCommand: string;
  repairAction?: RuntimeRepairAction;
  hasRuntimeArtifacts: boolean;
  analyzeLock: RuntimeAnalyzeLockState;
  analysisCheckpoint: RuntimeAnalysisCheckpointState;
  embeddingCheckpoint: RuntimeEmbeddingCheckpointState;
  bootstrapSource: RuntimeBootstrapSourceState;
  /** Bounded degraded-file aggregates from meta.json, projected verbatim. */
  degradedFileAggregates?: DegradedFileAggregates;
  warnings: string[];
}

export interface ReadRuntimeHealthOptions {
  repoLabel?: string;
  storagePath?: string;
  meta?: RepoMeta | null;
  /** Override for tests; defaults to the workspace-graph file limit. */
  maxWorkspaceFiles?: number;
}

/** Measured: 1.3k files ~ 47 s and 1.9 GiB; cost grows with file count. */
// Builds cost about 33 ms per file (491 files 15 s, 1,225 files 42 s, 2,662 files 90 s on 8 cores), so the
// ADR's 55 s dirty-cold limit is reached near 1,600 files.
const DEFAULT_MAX_WORKSPACE_FILES = 1600;

/** Largest indexed file count for which a workspace graph build is attempted. */
export function workspaceMaxFiles(): number {
  const value = Number(process.env.ONTOINDEX_WORKSPACE_MAX_FILES);
  return Number.isSafeInteger(value) && value > 0 ? value : DEFAULT_MAX_WORKSPACE_FILES;
}

const GIT_TIMEOUT_MS = 5_000;
const GIT_MAX_BUFFER = 1024 * 1024;
const DIRTY_COVERAGE_CAP = 50;

type SourceFreshness = {
  state: 'clean' | 'stale' | 'degraded' | 'untrusted';
  reason: string | null;
};

const WORKSPACE_OVER_LIMIT_REMEDIATION =
  'Workspace-graph reads are refused for this repository size. Use read_mode="committed" for indexed evidence, or explicitly run `ONTOINDEX_AUTO_WORKSPACE=1 ontoindex analyze --workspace-graph` to prepare a bounded workspace graph.';

function workspaceReadinessFromMeta(
  meta: { stats?: { files?: number } } | null | undefined,
  maxWorkspaceFiles: number,
): NonNullable<RuntimeHealthSnapshot['workspaceReadiness']> {
  const base = {
    dirtyCoverageScope: 'symbol-overlay-eligibility' as const,
    preparationChecked: false as const,
  };
  const files = meta?.stats?.files;
  if (typeof files !== 'number' || !Number.isSafeInteger(files) || files < 0) {
    return { state: 'not-checked', ...base };
  }
  if (files > maxWorkspaceFiles) {
    return {
      state: 'over-limit',
      ...base,
      indexedFiles: files,
      maxIndexedFiles: maxWorkspaceFiles,
      remediation: WORKSPACE_OVER_LIMIT_REMEDIATION,
    };
  }
  return {
    state: 'within-limit',
    ...base,
    indexedFiles: files,
    maxIndexedFiles: maxWorkspaceFiles,
  };
}

export async function readRuntimeHealth(
  repoPath: string,
  options: ReadRuntimeHealthOptions = {},
): Promise<RuntimeHealthSnapshot> {
  const storagePath = options.storagePath ?? getStoragePaths(repoPath).storagePath;
  const repoLabel = options.repoLabel ?? path.basename(repoPath);
  const warnings: string[] = [];
  const meta = Object.hasOwn(options, 'meta')
    ? (options.meta ?? null)
    : await loadMeta(storagePath);
  const repoHasGit = hasGitDir(repoPath);
  const currentCommit = repoHasGit ? normalizeCommit(getCurrentCommit(repoPath)) : null;
  const dirtyWorktree = repoHasGit ? await readDirtyWorktree(repoPath, warnings) : null;
  const dirtyCoverage = await readDirtyCoverage(repoPath, repoHasGit, warnings);
  const analyzeLock = await readAnalyzeLock(storagePath, warnings);
  const analysisCheckpoint = await readAnalysisCheckpoint(storagePath, warnings);
  const embeddingCheckpoint = await readEmbeddingCheckpoint(storagePath, warnings);
  const bootstrapSource = await readBootstrapSource(storagePath, warnings);
  const indexedCommit = normalizeCommit(meta?.lastCommit);
  const sourceFreshness =
    meta && !indexedCommit ? await readSourceFreshness(repoPath, meta, warnings) : undefined;
  const metaReason =
    resolveMetaDegradedReason(meta, repoPath) ??
    (sourceFreshness?.state === 'degraded' ? sourceFreshness.reason : null);
  const hasRuntimeArtifacts =
    analyzeLock.present ||
    analysisCheckpoint.present ||
    embeddingCheckpoint.present ||
    Boolean(metaReason) ||
    Boolean(meta?.partialCheckpointPath);

  const { freshnessState, degradedReason, repairCommand, repairAction } = deriveRuntimeHealth({
    indexedCommit,
    currentCommit,
    dirtyWorktree,
    analyzeLock,
    analysisCheckpoint,
    embeddingCheckpoint,
    metaReason,
    hasMeta: Boolean(meta),
    sourceFreshness,
  });

  return {
    version: 1,
    repoLabel,
    repoPath,
    indexedCommit,
    currentCommit,
    dirtyWorktree,
    freshnessState,
    committedFreshness:
      indexedCommit !== null && currentCommit !== null
        ? indexedCommit === currentCommit
          ? 'fresh'
          : 'stale'
        : 'unknown',
    dirtyCoverage,
    workspaceReadiness: workspaceReadinessFromMeta(
      meta,
      options.maxWorkspaceFiles ?? workspaceMaxFiles(),
    ),
    embeddingsAvailable:
      typeof meta?.stats?.embeddings === 'number' && Number.isFinite(meta.stats.embeddings)
        ? meta.stats.embeddings > 0
        : null,
    degradedReason,
    repairCommand,
    repairAction,
    hasRuntimeArtifacts,
    analyzeLock,
    analysisCheckpoint,
    embeddingCheckpoint,
    bootstrapSource,
    ...(meta?.degradedFileAggregates
      ? { degradedFileAggregates: meta.degradedFileAggregates }
      : {}),
    warnings,
  };
}

export function deriveRuntimeHealth(input: {
  indexedCommit: string | null;
  currentCommit: string | null;
  dirtyWorktree: boolean | null;
  analyzeLock: RuntimeAnalyzeLockState;
  analysisCheckpoint: RuntimeAnalysisCheckpointState;
  embeddingCheckpoint: RuntimeEmbeddingCheckpointState;
  metaReason: string | null;
  hasMeta: boolean;
  sourceFreshness?: SourceFreshness;
}): Pick<
  RuntimeHealthSnapshot,
  'freshnessState' | 'degradedReason' | 'repairCommand' | 'repairAction'
> {
  const repair = (
    command: RuntimeRepairAction['command'],
    args: string[],
    reason: string,
  ): Pick<RuntimeHealthSnapshot, 'repairCommand' | 'repairAction'> => ({
    repairCommand: `ontoindex ${command}${args.length ? ` ${args.join(' ')}` : ''}`,
    repairAction: { tool: 'ontoindex', command, args, reason },
  });
  const dirtyReason =
    input.dirtyWorktree === true && !input.sourceFreshness
      ? 'committed index is current, but uncommitted files are not represented in the graph'
      : null;
  const staleReason =
    input.indexedCommit && input.currentCommit && input.indexedCommit !== input.currentCommit
      ? 'current commit does not match indexed commit'
      : input.sourceFreshness?.state === 'stale'
        ? input.sourceFreshness.reason
        : null;
  const lockReason =
    input.analyzeLock.state === 'active'
      ? (input.analyzeLock.reason ?? 'analyze.lock is present and owned by an active process')
      : input.analyzeLock.state === 'stale'
        ? (input.analyzeLock.reason ?? 'analyze.lock is stale')
        : null;
  const checkpointReason =
    input.analysisCheckpoint.state === 'failed'
      ? (input.analysisCheckpoint.reason ?? 'analysis-checkpoint.json recorded a failed run')
      : input.analysisCheckpoint.state === 'running'
        ? (input.analysisCheckpoint.reason ?? 'analysis-checkpoint.json shows an in-progress run')
        : input.analysisCheckpoint.state === 'partial'
          ? (input.analysisCheckpoint.reason ?? 'analysis-checkpoint.json shows a partial run')
          : null;
  const embeddingCheckpointReason = input.embeddingCheckpoint.present
    ? (input.embeddingCheckpoint.reason ??
      'embedding-checkpoint.json exists from an incomplete embedding run')
    : null;

  if (input.analysisCheckpoint.state === 'failed') {
    return {
      freshnessState: 'failed-after-partial-run',
      degradedReason: checkpointReason,
      ...repair('analyze', ['--force'], 'retry the managed analysis after a failed partial run'),
    };
  }

  if (
    !input.hasMeta ||
    ((!input.indexedCommit || !input.currentCommit) &&
      (!input.sourceFreshness || input.sourceFreshness.state === 'untrusted'))
  ) {
    return {
      freshnessState: 'untrusted',
      degradedReason:
        input.sourceFreshness?.reason ??
        (input.hasMeta && !input.indexedCommit
          ? 'meta.json does not contain an indexed commit'
          : 'runtime health lacks an indexed commit or current commit'),
      ...repair('analyze', ['--force'], 'rebuild untrusted runtime state through the lock owner'),
    };
  }

  if (input.analyzeLock.state === 'stale') {
    return {
      freshnessState: 'untrusted',
      degradedReason: lockReason,
      ...repair('analyze', ['--force'], 'recover the stale lock through managed analysis'),
    };
  }

  if (input.analyzeLock.state === 'unknown' || input.analysisCheckpoint.state === 'unknown') {
    return {
      freshnessState: 'untrusted',
      degradedReason:
        input.analyzeLock.state === 'unknown'
          ? (input.analyzeLock.reason ?? 'analyze.lock exists but could not be trusted')
          : (input.analysisCheckpoint.reason ??
            'analysis-checkpoint.json exists but could not be trusted'),
      ...repair('analyze', ['--force'], 'let managed analysis validate or recover runtime state'),
    };
  }

  if (staleReason) {
    return {
      freshnessState: 'stale',
      degradedReason: staleReason,
      ...repair('analyze', [], 'refresh the stale index'),
    };
  }

  if (dirtyReason) {
    return {
      freshnessState: 'dirty',
      degradedReason: dirtyReason,
      repairCommand:
        'ontoindex analyze supports working-tree sources; ontoindex analyze --dirty-overlay provides partial file coverage, with current relationships limited to covered files',
      repairAction: {
        tool: 'ontoindex',
        command: 'analyze',
        args: [],
        reason:
          'analyze working-tree sources; verify partial overlay coverage before relying on current relationships',
      },
    };
  }

  if (input.analyzeLock.state === 'active' || checkpointReason) {
    return {
      freshnessState: 'degraded',
      degradedReason:
        input.analyzeLock.state === 'active' ? (lockReason ?? checkpointReason) : checkpointReason,
      ...(input.analyzeLock.state === 'active'
        ? {
            repairCommand: 'wait for the active analyze run to finish',
            repairAction: {
              tool: 'ontoindex' as const,
              command: 'status' as const,
              args: [],
              reason: 'observe the live analysis owner without displacing it',
            },
          }
        : repair('analyze', [], 'resume analysis through the managed command')),
    };
  }

  if (input.metaReason) {
    return {
      freshnessState: 'degraded',
      degradedReason: input.metaReason,
      ...repair('analyze', [], 'restore full index capabilities'),
    };
  }

  if (input.embeddingCheckpoint.present) {
    return {
      freshnessState: 'degraded',
      degradedReason: embeddingCheckpointReason,
      ...repair('analyze', [], 'resume the incomplete embedding lifecycle'),
    };
  }

  return {
    freshnessState: 'clean',
    degradedReason: null,
    ...repair('status', [], 'runtime state is healthy; inspect status only'),
  };
}

async function readSourceFreshness(
  repoPath: string,
  meta: RepoMeta,
  warnings: string[],
): Promise<SourceFreshness> {
  const manifest = meta.sourceManifest;
  if (!manifest) {
    return { state: 'untrusted', reason: 'commitless index lacks a source manifest' };
  }
  if (
    manifest.version !== SOURCE_MANIFEST_VERSION ||
    manifest.analyzerContractVersion !== SOURCE_MANIFEST_CONTRACT ||
    !Array.isArray(manifest.includePaths) ||
    !manifest.includePaths.every((entry) => typeof entry === 'string') ||
    !['full', 'symbols', 'huge-repo-symbols'].includes(manifest.pipelineProfile) ||
    !['complete', 'degraded', 'unknown'].includes(manifest.coverage) ||
    !Number.isSafeInteger(manifest.sourceEntryCount) ||
    manifest.sourceEntryCount < 0 ||
    ![manifest.sourceDigest, manifest.scopeDigest, manifest.ignorePolicyDigest].every(
      (digest) => typeof digest === 'string' && /^[a-f0-9]{64}$/.test(digest),
    )
  ) {
    return { state: 'untrusted', reason: 'index source manifest is invalid or unsupported' };
  }
  try {
    const current = await computeSourceManifest(repoPath, {
      includePaths: manifest.includePaths,
      pipelineProfile: manifest.pipelineProfile,
    });
    if (!sourceInputsMatch(manifest, current)) {
      return { state: 'stale', reason: 'current source manifest does not match indexed manifest' };
    }
    if (manifest.coverage !== 'complete' || current.coverage !== 'complete') {
      return { state: 'degraded', reason: 'source manifest coverage is incomplete' };
    }
    return { state: 'clean', reason: null };
  } catch (error) {
    const reason = `source manifest unavailable: ${formatError(error)}`;
    warnings.push(reason);
    return { state: 'untrusted', reason };
  }
}

export function formatRuntimeHealthStatusLine(health: RuntimeHealthSnapshot): string {
  return `Runtime health: ${health.freshnessState}`;
}

export function formatRuntimeHealthDetailLines(health: RuntimeHealthSnapshot): string[] {
  const lines = [
    `  Indexed commit: ${shortCommit(health.indexedCommit)}`,
    `  Current commit: ${shortCommit(health.currentCommit)}`,
    `  Dirty worktree: ${formatBooleanState(health.dirtyWorktree)}`,
    `  Analyze lock: ${formatLockState(health.analyzeLock)}`,
    `  Analysis checkpoint: ${formatCheckpointState(health.analysisCheckpoint)}`,
    `  Embedding checkpoint: ${health.embeddingCheckpoint.present ? 'present' : 'absent'}`,
  ];

  if (health.bootstrapSource.present) {
    lines.push(
      `  Bootstrap source: restored ${health.bootstrapSource.restoredAt ?? 'unknown'} from ${
        health.bootstrapSource.sourceRepoLabel ?? 'artifact'
      } @ ${shortCommit(health.bootstrapSource.sourceIndexedCommit ?? null)}`,
    );
  }

  if (health.degradedReason) {
    lines.push(`  Reason: ${health.degradedReason}`);
  }
  lines.push(`  Repair: ${health.repairCommand}`);
  return lines;
}

function resolveMetaDegradedReason(
  meta: RepoMeta | null | undefined,
  repoPath: string,
): string | null {
  if (!meta) return null;
  if (meta.capabilities?.impact === 'degraded' || meta.capabilities?.processes === false) {
    return 'index capabilities are degraded';
  }
  if (meta.indexMode === 'symbols-only' || meta.pipelineProfile === 'symbols') {
    return 'symbols-only index';
  }
  if (meta.pipelineProfile === 'huge-repo-symbols') {
    return 'huge-repo-symbols profile with reduced enrichment';
  }
  if (meta.skippedPhases?.length) {
    return `skipped phases recorded: ${meta.skippedPhases.join(', ')}`;
  }
  if (meta.degradedFileAggregates || meta.degradedFiles?.length) {
    const files = meta.degradedFiles ?? [];
    const paths = files
      .slice(0, 5)
      .map(({ filePath }) =>
        path.isAbsolute(filePath) ? path.relative(repoPath, filePath) : filePath,
      );
    const remaining = files.length - paths.length;
    const details =
      paths.length > 0
        ? ` (${paths.join(', ')}${remaining > 0 ? `; +${remaining} more` : ''})`
        : '';
    const summary = meta.degradedFileAggregates
      ? `degraded files sampled: ${meta.degradedFileAggregates.sampledDegradedCount}`
      : `degraded files recorded: ${files.length}`;
    return summary + details;
  }
  if (meta.partialCheckpointPath) {
    return `partial checkpoint recorded at ${meta.partialCheckpointPath}`;
  }
  return null;
}

async function readDirtyWorktree(repoPath: string, warnings: string[]): Promise<boolean | null> {
  try {
    const output = await execFileText(
      'git',
      ['status', '--porcelain=v1', '--untracked-files=all'],
      { cwd: repoPath, timeoutMs: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER },
    );
    const summary = summarizeGitPorcelainStatus(output);
    return summary ? summary.dirtyFileCount > 0 : null;
  } catch (error) {
    warnings.push(`runtime health git status probe failed: ${formatError(error)}`);
    return null;
  }
}

async function readDirtyCoverage(
  repoPath: string,
  repoHasGit: boolean,
  warnings: string[],
): Promise<NonNullable<RuntimeHealthSnapshot['dirtyCoverage']>> {
  if (!repoHasGit) {
    warnings.push('runtime dirty overlay unavailable: repository has no Git directory');
    return {
      state: 'unknown',
      dirtySourceFiles: null,
      coveredFiles: null,
      uncoveredFiles: null,
      cap: DIRTY_COVERAGE_CAP,
    };
  }

  try {
    const plan = await planDirtyOverlay(repoPath);
    const coveredFiles = plan.includePaths.length + plan.tombstones.length;
    const uncoveredFiles = plan.uncoveredPaths.length;
    const dirtySourceFiles = new Set([
      ...plan.includePaths,
      ...plan.tombstones,
      ...plan.uncoveredPaths,
    ]).size;
    return {
      state: plan.tooMany ? 'over-cap' : dirtySourceFiles === 0 ? 'none' : 'coverable',
      dirtySourceFiles,
      coveredFiles,
      uncoveredFiles,
      cap: DIRTY_COVERAGE_CAP,
    };
  } catch (error) {
    warnings.push(`runtime dirty overlay probe failed: ${formatError(error)}`);
    return {
      state: 'unknown',
      dirtySourceFiles: null,
      coveredFiles: null,
      uncoveredFiles: null,
      cap: DIRTY_COVERAGE_CAP,
    };
  }
}

export async function readAnalyzeLock(
  storagePath: string,
  warnings: string[],
): Promise<RuntimeAnalyzeLockState> {
  const lockPath = path.join(storagePath, 'analyze.lock');
  try {
    const raw = await fs.readFile(lockPath, 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const pid = typeof parsed.pid === 'number' ? parsed.pid : undefined;
    const startedAt = typeof parsed.startedAt === 'string' ? parsed.startedAt : undefined;
    const processStartIdentity =
      typeof parsed.processStartIdentity === 'string' ? parsed.processStartIdentity : undefined;
    if (pid === undefined) {
      return {
        path: lockPath,
        present: true,
        state: 'unknown',
        startedAt,
        reason: 'analyze.lock exists but does not contain a pid',
      };
    }

    const currentIdentity = await readProcessStartIdentity(pid);
    const active = isProcessAlive(pid);
    const identityMatches =
      !processStartIdentity || !currentIdentity
        ? undefined
        : processStartIdentity === currentIdentity;
    const state =
      !active || identityMatches === false
        ? 'stale'
        : identityMatches === undefined
          ? 'unknown'
          : 'active';
    return {
      path: lockPath,
      present: true,
      state,
      pid,
      startedAt,
      ...(processStartIdentity ? { processStartIdentity } : {}),
      reason:
        state === 'active'
          ? `analyze.lock is owned by PID ${pid} with matching process identity`
          : state === 'stale'
            ? identityMatches === false
              ? `analyze.lock PID ${pid} was reused by a different process`
              : `analyze.lock refers to PID ${pid}, which is no longer running`
            : `analyze.lock PID ${pid} is running but process identity could not be verified`,
    };
  } catch (error) {
    if (!isFileMissing(error)) {
      warnings.push(`runtime health analyze.lock probe failed: ${formatError(error)}`);
      return {
        path: lockPath,
        present: true,
        state: 'unknown',
        reason: 'analyze.lock exists but could not be parsed',
      };
    }
    return {
      path: lockPath,
      present: false,
      state: 'absent',
    };
  }
}

async function readAnalysisCheckpoint(
  storagePath: string,
  warnings: string[],
): Promise<RuntimeAnalysisCheckpointState> {
  const checkpointPath = path.join(storagePath, 'analysis-checkpoint.json');
  try {
    const raw = await fs.readFile(checkpointPath, 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const status = typeof parsed.status === 'string' ? parsed.status : undefined;
    const phase = typeof parsed.phase === 'string' ? parsed.phase : undefined;
    const phaseStatus = isPhaseStatus(parsed.phaseStatus) ? parsed.phaseStatus : undefined;
    const updatedAt = typeof parsed.updatedAt === 'string' ? parsed.updatedAt : undefined;
    const failure = isObject(parsed.failure) ? parsed.failure : undefined;
    const reason = typeof failure?.message === 'string' ? failure.message : undefined;
    if (status === 'running' || status === 'partial' || status === 'failed') {
      return {
        path: checkpointPath,
        present: true,
        state: status,
        ...(phase ? { phase } : {}),
        ...(phaseStatus ? { phaseStatus } : {}),
        ...(updatedAt ? { updatedAt } : {}),
        ...(reason ? { reason } : {}),
      };
    }

    return {
      path: checkpointPath,
      present: true,
      state: 'unknown',
      ...(phase ? { phase } : {}),
      ...(phaseStatus ? { phaseStatus } : {}),
      ...(updatedAt ? { updatedAt } : {}),
      reason: reason ?? 'analysis-checkpoint.json exists but has an unknown status',
    };
  } catch (error) {
    if (!isFileMissing(error)) {
      warnings.push(`runtime health analysis-checkpoint.json probe failed: ${formatError(error)}`);
      return {
        path: checkpointPath,
        present: true,
        state: 'unknown',
        reason: 'analysis-checkpoint.json exists but could not be parsed',
      };
    }
    return {
      path: checkpointPath,
      present: false,
      state: 'absent',
    };
  }
}

async function readEmbeddingCheckpoint(
  storagePath: string,
  warnings: string[],
): Promise<RuntimeEmbeddingCheckpointState> {
  const checkpointPath = path.join(storagePath, 'embedding-checkpoint.json');
  try {
    await fs.access(checkpointPath);
    return {
      path: checkpointPath,
      present: true,
      reason: 'embedding-checkpoint.json exists from an incomplete embedding run',
    };
  } catch (error) {
    if (!isFileMissing(error)) {
      warnings.push(`runtime health embedding-checkpoint.json probe failed: ${formatError(error)}`);
    }
    return {
      path: checkpointPath,
      present: false,
    };
  }
}

async function readBootstrapSource(
  storagePath: string,
  warnings: string[],
): Promise<RuntimeBootstrapSourceState> {
  const bootstrapPath = path.join(storagePath, 'bootstrap-source.json');
  try {
    const raw = await fs.readFile(bootstrapPath, 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      path: bootstrapPath,
      present: true,
      restoredAt: typeof parsed.restoredAt === 'string' ? parsed.restoredAt : undefined,
      artifactGeneratedAt:
        typeof parsed.artifactGeneratedAt === 'string' ? parsed.artifactGeneratedAt : undefined,
      sourceIndexedCommit:
        typeof parsed.sourceIndexedCommit === 'string' ? parsed.sourceIndexedCommit : null,
      sourceRepoLabel:
        typeof parsed.sourceRepoLabel === 'string' ? parsed.sourceRepoLabel : undefined,
      sourceOntoindexVersion:
        typeof parsed.sourceOntoindexVersion === 'string'
          ? parsed.sourceOntoindexVersion
          : undefined,
    };
  } catch (error) {
    if (!isFileMissing(error)) {
      warnings.push(`runtime health bootstrap-source.json probe failed: ${formatError(error)}`);
      return {
        path: bootstrapPath,
        present: true,
        reason: 'bootstrap-source.json exists but could not be parsed',
      };
    }
    return {
      path: bootstrapPath,
      present: false,
    };
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isPermissionError(error);
  }
}

async function readProcessStartIdentity(pid: number): Promise<string | null> {
  if (process.platform !== 'linux') return null;
  try {
    const stat = await fs.readFile(`/proc/${pid}/stat`, 'utf-8');
    const fields = stat
      .slice(stat.lastIndexOf(')') + 2)
      .trim()
      .split(/\s+/);
    return fields[19] || null;
  } catch {
    return null;
  }
}

function isPermissionError(error: unknown): boolean {
  return isObject(error) && error.code === 'EPERM';
}

function isFileMissing(error: unknown): boolean {
  return isObject(error) && error.code === 'ENOENT';
}

function normalizeCommit(commit: string | undefined): string | null {
  const trimmed = commit?.trim();
  return trimmed ? trimmed : null;
}

function isPhaseStatus(value: unknown): value is 'started' | 'completed' | 'failed' {
  return value === 'started' || value === 'completed' || value === 'failed';
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function formatBooleanState(value: boolean | null): string {
  if (value === null) return 'unknown';
  return value ? 'yes' : 'no';
}

function formatLockState(lock: RuntimeAnalyzeLockState): string {
  if (!lock.present) return 'absent';
  if (lock.state === 'active') return `active${lock.pid ? ` (PID ${lock.pid})` : ''}`;
  if (lock.state === 'stale') return `stale${lock.pid ? ` (PID ${lock.pid})` : ''}`;
  return lock.reason ?? 'unknown';
}

function formatCheckpointState(checkpoint: RuntimeAnalysisCheckpointState): string {
  if (!checkpoint.present) return 'absent';
  const suffix = [checkpoint.phase ? `phase ${checkpoint.phase}` : null, checkpoint.phaseStatus]
    .filter((value): value is string => Boolean(value))
    .join(', ');
  const base = checkpoint.state;
  if (!suffix) return checkpoint.reason ?? base;
  return checkpoint.reason ? `${base} (${suffix}; ${checkpoint.reason})` : `${base} (${suffix})`;
}

function shortCommit(commit: string | null): string {
  return commit ? commit.slice(0, 7) : 'unavailable';
}

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
