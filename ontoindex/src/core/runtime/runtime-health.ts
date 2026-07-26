import fs from 'node:fs/promises';
import path from 'node:path';

import { execFileText } from '../process/exec-file.js';
import { summarizeGitPorcelainStatus } from '../../core/audit-lifecycle/freshness.js';
import { getCurrentCommit } from '../../storage/git.js';
import {
  getStoragePaths,
  loadMeta,
  type RepoMeta,
  type DegradedFileAggregates,
} from '../../storage/repo-manager.js';

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
}

const GIT_TIMEOUT_MS = 5_000;
const GIT_MAX_BUFFER = 1024 * 1024;

export async function readRuntimeHealth(
  repoPath: string,
  options: ReadRuntimeHealthOptions = {},
): Promise<RuntimeHealthSnapshot> {
  const storagePath = options.storagePath ?? getStoragePaths(repoPath).storagePath;
  const repoLabel = options.repoLabel ?? path.basename(repoPath);
  const warnings: string[] = [];
  const meta = options.meta ?? (await loadMeta(storagePath));
  const currentCommit = normalizeCommit(getCurrentCommit(repoPath));
  const dirtyWorktree = await readDirtyWorktree(repoPath, warnings);
  const analyzeLock = await readAnalyzeLock(storagePath, warnings);
  const analysisCheckpoint = await readAnalysisCheckpoint(storagePath, warnings);
  const embeddingCheckpoint = await readEmbeddingCheckpoint(storagePath, warnings);
  const bootstrapSource = await readBootstrapSource(storagePath, warnings);
  const indexedCommit = normalizeCommit(meta?.lastCommit);
  const metaReason = resolveMetaDegradedReason(meta);
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
  });

  return {
    version: 1,
    repoLabel,
    repoPath,
    indexedCommit,
    currentCommit,
    dirtyWorktree,
    freshnessState,
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
    input.dirtyWorktree === true ? 'dirty worktree contains uncommitted changes' : null;
  const staleReason =
    input.indexedCommit && input.currentCommit && input.indexedCommit !== input.currentCommit
      ? 'current commit does not match indexed commit'
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

  if (!input.hasMeta || !input.indexedCommit || !input.currentCommit) {
    return {
      freshnessState: 'untrusted',
      degradedReason:
        input.hasMeta && !input.indexedCommit
          ? 'meta.json does not contain an indexed commit'
          : 'runtime health lacks an indexed commit or current commit',
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
      repairCommand: 'commit, stash, or clean the worktree, then rerun ontoindex analyze',
      repairAction: {
        tool: 'ontoindex',
        command: 'analyze',
        args: [],
        reason: 'analyze after the worktree is clean',
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

function resolveMetaDegradedReason(meta: RepoMeta | null | undefined): string | null {
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
  if (meta.degradedFileAggregates) {
    return `degraded files sampled: ${meta.degradedFileAggregates.sampledDegradedCount}`;
  }
  if (meta.degradedFiles?.length) {
    return `degraded files recorded: ${meta.degradedFiles.length}`;
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
