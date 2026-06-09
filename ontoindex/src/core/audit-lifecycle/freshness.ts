import { execFileText } from '../process/exec-file.js';
import { resolveTargetHead, type AuditTargetHead } from './target-head.js';

const GIT_TIMEOUT_MS = 5_000;
const GIT_MAX_BUFFER = 1024 * 1024;

export type AuditFreshnessState = 'clean' | 'dirty' | 'stale' | 'partial';
export type AuditLifecycleStatus = string;

export interface AuditDirtyFile {
  path: string;
  indexStatus: string;
  worktreeStatus: string;
}

export interface AuditFreshnessMetadata {
  state: AuditFreshnessState;
  targetHead: AuditTargetHead;
  currentHead?: string;
  commitsAfterTarget?: number;
  dirtyFiles: AuditDirtyFile[];
  changedFiles: string[];
  warnings: string[];
  recommendedAction?: string;
  checkedAt: string;
}

export interface ComputeAuditFreshnessOptions {
  target?: AuditTargetHead;
  ref?: string;
  now?: Date;
}

export interface ProjectAuditStatusOptions {
  availableStatuses?: readonly AuditLifecycleStatus[];
  staleStatus?: AuditLifecycleStatus;
  verifyStatus?: AuditLifecycleStatus;
}

export async function computeAuditFreshness(
  repoPath: string,
  options: ComputeAuditFreshnessOptions = {},
): Promise<AuditFreshnessMetadata> {
  const target =
    options.target ?? (await resolveTargetHead(repoPath, { ref: options.ref, now: options.now }));
  const checkedAt = (options.now ?? new Date()).toISOString();

  try {
    const currentHead = (
      await execFileText(
        'git',
        ['rev-parse', '--verify', 'HEAD^{commit}'],
        gitOptions(target.gitRoot),
      )
    ).trim();
    const commitsAfterTarget = await countCommitsAfterTarget(target.gitRoot, target.commit);
    const dirtyFiles = parsePorcelainStatus(
      await execFileText(
        'git',
        ['status', '--porcelain=v1', '--untracked-files=all'],
        gitOptions(target.gitRoot),
      ),
    );
    const changedFiles = Array.from(new Set(dirtyFiles.map((file) => file.path))).sort();
    const warnings = freshnessWarnings({
      currentHead,
      target,
      commitsAfterTarget,
      changedFiles,
    });
    const state = freshnessState({
      isDirty: changedFiles.length > 0,
      isStale: currentHead !== target.commit || commitsAfterTarget > 0,
    });

    return {
      state,
      targetHead: target,
      currentHead,
      commitsAfterTarget,
      dirtyFiles,
      changedFiles,
      warnings,
      recommendedAction:
        warnings.length > 0
          ? 'Re-run audit verification against the locked target HEAD.'
          : undefined,
      checkedAt,
    };
  } catch (error) {
    return {
      state: 'partial',
      targetHead: target,
      dirtyFiles: [],
      changedFiles: [],
      warnings: [`Unable to compute complete git freshness metadata: ${errorMessage(error)}`],
      recommendedAction: 'Re-check the target checkout before trusting audit evidence.',
      checkedAt,
    };
  }
}

export function isFreshAuditEvidence(freshness: Pick<AuditFreshnessMetadata, 'state'>): boolean {
  return freshness.state === 'clean';
}

export function projectAuditStatusForFreshness<TStatus extends AuditLifecycleStatus>(
  status: TStatus,
  freshness: Pick<AuditFreshnessMetadata, 'state'>,
  options: ProjectAuditStatusOptions = {},
): TStatus | AuditLifecycleStatus {
  if (isFreshAuditEvidence(freshness)) return status;

  const available = new Set(options.availableStatuses ?? ['NEEDS-REVERIFY', 'NEEDS-VERIFY']);
  const staleStatus = options.staleStatus ?? 'NEEDS-REVERIFY';
  const verifyStatus = options.verifyStatus ?? 'NEEDS-VERIFY';

  if (available.has(staleStatus)) return staleStatus;
  if (available.has(verifyStatus)) return verifyStatus;
  return status;
}

export const downgradeStaleAuditStatus = projectAuditStatusForFreshness;

async function countCommitsAfterTarget(gitRoot: string, targetCommit: string): Promise<number> {
  try {
    const output = (
      await execFileText(
        'git',
        ['rev-list', '--count', `${targetCommit}..HEAD`],
        gitOptions(gitRoot),
      )
    ).trim();
    return Number.parseInt(output, 10) || 0;
  } catch {
    return 0;
  }
}

function parsePorcelainStatus(output: string): AuditDirtyFile[] {
  return output
    .split('\n')
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => {
      const indexStatus = line[0] ?? ' ';
      const worktreeStatus = line[1] ?? ' ';
      const rawPath = line.slice(3);
      const path = rawPath.includes(' -> ') ? rawPath.split(' -> ').at(-1) || rawPath : rawPath;
      return { path, indexStatus, worktreeStatus };
    });
}

function freshnessState(input: { isDirty: boolean; isStale: boolean }): AuditFreshnessState {
  if (input.isDirty) return 'dirty';
  if (input.isStale) return 'stale';
  return 'clean';
}

function freshnessWarnings(input: {
  currentHead: string;
  target: AuditTargetHead;
  commitsAfterTarget: number;
  changedFiles: string[];
}): string[] {
  const warnings: string[] = [];
  if (input.currentHead !== input.target.commit || input.commitsAfterTarget > 0) {
    warnings.push(
      `Target HEAD ${input.target.shortCommit} is stale relative to checkout HEAD ${input.currentHead.slice(0, 12)}.`,
    );
  }
  if (input.changedFiles.length > 0) {
    warnings.push(
      `Dirty checkout has ${input.changedFiles.length} changed file(s) after target HEAD lock.`,
    );
  }
  return warnings;
}

function gitOptions(cwd: string) {
  return {
    cwd,
    timeoutMs: GIT_TIMEOUT_MS,
    maxBuffer: GIT_MAX_BUFFER,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
