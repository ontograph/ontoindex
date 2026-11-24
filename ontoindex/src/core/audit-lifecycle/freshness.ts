import path from 'node:path';
import { execFileText } from '../process/exec-file.js';
import { resolveTargetHead, type AuditTargetHead } from './target-head.js';

const GIT_TIMEOUT_MS = 5_000;
const GIT_MAX_BUFFER = 1024 * 1024;
const SOURCE_FILE_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.cts',
  '.mts',
  '.c',
  '.cc',
  '.cpp',
  '.cxx',
  '.h',
  '.hh',
  '.hpp',
  '.py',
  '.rs',
  '.go',
  '.java',
  '.kt',
  '.kts',
  '.swift',
  '.cs',
  '.php',
  '.rb',
  '.dart',
  '.lua',
  '.sh',
  '.sql',
  '.vue',
  '.html',
  '.htm',
]);

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

export interface GitPorcelainWorkspaceSummary {
  dirtyFiles: AuditDirtyFile[];
  dirtyFileCount: number;
  sourceFileCount: number;
  stagedSourceFileCount: number;
  unstagedSourceFileCount: number;
  untrackedSourceFileCount: number;
  unknownGraphCoverageCount: number;
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
    const workspaceSummary = summarizeGitPorcelainStatus(
      await execFileText(
        'git',
        ['status', '--porcelain=v1', '--untracked-files=all'],
        gitOptions(target.gitRoot),
      ),
    );
    const dirtyFiles = workspaceSummary?.dirtyFiles ?? [];
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

export function summarizeGitPorcelainStatus(
  output: string | null,
): GitPorcelainWorkspaceSummary | null {
  if (output === null) return null;
  const dirtyFiles = parsePorcelainStatus(output);
  const sourceFiles = new Set<string>();
  let stagedSourceFileCount = 0;
  let unstagedSourceFileCount = 0;
  let untrackedSourceFileCount = 0;

  for (const file of dirtyFiles) {
    if (!isSourceFilePath(file.path)) continue;
    sourceFiles.add(file.path);
    const isUntracked = file.indexStatus === '?' && file.worktreeStatus === '?';
    if (isUntracked) {
      untrackedSourceFileCount++;
      continue;
    }
    if (file.indexStatus !== ' ' && file.indexStatus !== '?') stagedSourceFileCount++;
    if (file.worktreeStatus !== ' ' && file.worktreeStatus !== '?') unstagedSourceFileCount++;
  }

  return {
    dirtyFiles,
    dirtyFileCount: dirtyFiles.length,
    sourceFileCount: sourceFiles.size,
    stagedSourceFileCount,
    unstagedSourceFileCount,
    untrackedSourceFileCount,
    unknownGraphCoverageCount: untrackedSourceFileCount,
  };
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
  const files: AuditDirtyFile[] = [];
  for (const line of output.split('\n')) {
    if (line.length < 4) continue;

    const indexStatus = line[0] ?? ' ';
    const worktreeStatus = line[1] ?? ' ';
    const rawPath = line.slice(3);
    const isRename = indexStatus === 'R' || indexStatus === 'C' || worktreeStatus === 'R' || worktreeStatus === 'C';
    const destination = isRename ? renameDestination(rawPath) : rawPath;
    files.push({
      path: decodeGitQuotedPath(destination),
      indexStatus,
      worktreeStatus,
    });
  }
  return files;
}

function renameDestination(rawPath: string): string {
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < rawPath.length - 3; index += 1) {
    const char = rawPath[index]!;
    if (escaped) {
      escaped = false;
    } else if (quoted && char === '\\') {
      escaped = true;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (!quoted && rawPath.startsWith(' -> ', index)) {
      return rawPath.slice(index + 4);
    }
  }
  return rawPath;
}

function decodeGitQuotedPath(rawPath: string): string {
  if (rawPath.length < 2 || !rawPath.startsWith('"') || !rawPath.endsWith('"')) {
    return rawPath;
  }

  const bytes: number[] = [];
  for (let index = 1; index < rawPath.length - 1; index += 1) {
    const char = rawPath[index]!;
    if (char !== '\\') {
      const codePoint = rawPath.codePointAt(index)!;
      const value = String.fromCodePoint(codePoint);
      bytes.push(...Buffer.from(value, 'utf8'));
      index += value.length - 1;
      continue;
    }

    const escaped = rawPath[++index];
    if (!escaped) {
      bytes.push(0x5c);
      break;
    }

    const namedEscapes: Record<string, number> = {
      a: 0x07,
      b: 0x08,
      t: 0x09,
      n: 0x0a,
      v: 0x0b,
      f: 0x0c,
      r: 0x0d,
      '\\': 0x5c,
      '"': 0x22,
    };
    if (escaped in namedEscapes) {
      bytes.push(namedEscapes[escaped]!);
    } else if (/[0-7]/.test(escaped)) {
      let octal = escaped;
      while (octal.length < 3 && /[0-7]/.test(rawPath[index + 1] ?? '')) {
        octal += rawPath[++index];
      }
      bytes.push(Number.parseInt(octal, 8));
    } else {
      // Preserve unknown escapes as literal path characters rather than silently dropping data.
      bytes.push(0x5c, ...Buffer.from(escaped, 'utf8'));
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

function isSourceFilePath(filePath: string): boolean {
  return SOURCE_FILE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
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
