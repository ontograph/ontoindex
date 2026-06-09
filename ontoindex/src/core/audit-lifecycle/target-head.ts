import { execFileText } from '../process/exec-file.js';

const GIT_TIMEOUT_MS = 5_000;
const GIT_MAX_BUFFER = 1024 * 1024;

export interface AuditTargetHead {
  repoPath: string;
  gitRoot: string;
  ref: string;
  commit: string;
  shortCommit: string;
  lockedAt: string;
}

export interface ResolveTargetHeadOptions {
  ref?: string;
  now?: Date;
}

export async function resolveTargetHead(
  repoPath: string,
  options: ResolveTargetHeadOptions = {},
): Promise<AuditTargetHead> {
  const ref = options.ref?.trim() || 'HEAD';
  const gitRoot = (
    await execFileText('git', ['rev-parse', '--show-toplevel'], gitOptions(repoPath))
  ).trim();
  const commit = (
    await execFileText('git', ['rev-parse', '--verify', `${ref}^{commit}`], gitOptions(gitRoot))
  ).trim();
  const shortCommit = (
    await execFileText('git', ['rev-parse', '--short=12', commit], gitOptions(gitRoot))
  ).trim();

  return {
    repoPath,
    gitRoot,
    ref,
    commit,
    shortCommit,
    lockedAt: (options.now ?? new Date()).toISOString(),
  };
}

export const lockTargetHead = resolveTargetHead;

function gitOptions(cwd: string) {
  return {
    cwd,
    timeoutMs: GIT_TIMEOUT_MS,
    maxBuffer: GIT_MAX_BUFFER,
  };
}
