import fs from 'node:fs/promises';
import path from 'node:path';

import { execFileText } from '../process/exec-file.js';
import { summarizeGitPorcelainStatus } from '../../core/audit-lifecycle/freshness.js';
import { getCurrentCommit } from '../../storage/git.js';
import { getStoragePaths, loadMeta, type RepoMeta } from '../../storage/repo-manager.js';

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
  reason?: string;
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
  hasRuntimeArtifacts: boolean;
  analyzeLock: RuntimeAnalyzeLockState;
  analysisCheckpoint: RuntimeAnalysisCheckpointState;
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
  const indexedCommit = normalizeCommit(meta?.lastCommit);
  const metaReason = resolveMetaDegradedReason(meta);
  const hasRuntimeArtifacts =
    analyzeLock.present ||
    analysisCheckpoint.present ||
    Boolean(metaReason) ||
    Boolean(meta?.partialCheckpointPath);

  const { freshnessState, degradedReason, repairCommand } = deriveRuntimeHealth({
    indexedCommit,
    currentCommit,
    dirtyWorktree,
    analyzeLock,
    analysisCheckpoint,
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
    hasRuntimeArtifacts,
    analyzeLock,
    analysisCheckpoint,
    warnings,
  };
}

export function deriveRuntimeHealth(input: {
  indexedCommit: string | null;
  currentCommit: string | null;
  dirtyWorktree: boolean | null;
  analyzeLock: RuntimeAnalyzeLockState;
  analysisCheckpoint: RuntimeAnalysisCheckpointState;
  metaReason: string | null;
  hasMeta: boolean;
}): Pick<RuntimeHealthSnapshot, 'freshnessState' | 'degradedReason' | 'repairCommand'> {
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

  if (input.analysisCheckpoint.state === 'failed') {
    return {
      freshnessState: 'failed-after-partial-run',
      degradedReason: checkpointReason,
      repairCommand: 'ontoindex analyze --force',
    };
  }

  if (!input.hasMeta || !input.indexedCommit || !input.currentCommit) {
    return {
      freshnessState: 'untrusted',
      degradedReason:
        input.hasMeta && !input.indexedCommit
          ? 'meta.json does not contain an indexed commit'
          : 'runtime health lacks an indexed commit or current commit',
      repairCommand: 'ontoindex analyze --force',
    };
  }

  if (input.analyzeLock.state === 'stale') {
    return {
      freshnessState: 'untrusted',
      degradedReason: lockReason,
      repairCommand: 'remove the stale analyze.lock, then rerun ontoindex analyze --force',
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
      repairCommand: 'ontoindex analyze --force',
    };
  }

  if (staleReason) {
    return {
      freshnessState: 'stale',
      degradedReason: staleReason,
      repairCommand: 'ontoindex analyze',
    };
  }

  if (dirtyReason) {
    return {
      freshnessState: 'dirty',
      degradedReason: dirtyReason,
      repairCommand: 'commit, stash, or clean the worktree, then rerun ontoindex analyze',
    };
  }

  if (input.analyzeLock.state === 'active' || checkpointReason) {
    return {
      freshnessState: 'degraded',
      degradedReason:
        input.analyzeLock.state === 'active' ? (lockReason ?? checkpointReason) : checkpointReason,
      repairCommand:
        input.analyzeLock.state === 'active'
          ? 'wait for the active analyze run to finish'
          : 'ontoindex analyze',
    };
  }

  if (input.metaReason) {
    return {
      freshnessState: 'degraded',
      degradedReason: input.metaReason,
      repairCommand: 'ontoindex analyze',
    };
  }

  return {
    freshnessState: 'clean',
    degradedReason: null,
    repairCommand: 'ontoindex status',
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
  ];

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

async function readAnalyzeLock(
  storagePath: string,
  warnings: string[],
): Promise<RuntimeAnalyzeLockState> {
  const lockPath = path.join(storagePath, 'analyze.lock');
  try {
    const raw = await fs.readFile(lockPath, 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const pid = typeof parsed.pid === 'number' ? parsed.pid : undefined;
    const startedAt = typeof parsed.startedAt === 'string' ? parsed.startedAt : undefined;
    if (pid === undefined) {
      return {
        path: lockPath,
        present: true,
        state: 'unknown',
        startedAt,
        reason: 'analyze.lock exists but does not contain a pid',
      };
    }

    const active = isProcessAlive(pid);
    return {
      path: lockPath,
      present: true,
      state: active ? 'active' : 'stale',
      pid,
      startedAt,
      reason: active
        ? `analyze.lock is owned by PID ${pid}`
        : `analyze.lock refers to PID ${pid}, which is no longer running`,
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

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isPermissionError(error);
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
