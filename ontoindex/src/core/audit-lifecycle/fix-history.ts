import { execFileText } from '../process/exec-file.js';

const GIT_TIMEOUT_MS = 5_000;
const GIT_MAX_BUFFER = 1024 * 1024;

export interface FixHistoryCandidate {
  commit: string;
  subject: string;
  path: string;
  matchedPattern: string;
}

export interface FindFixHistoryOptions {
  repoPath: string;
  targetHead: string;
  path: string;
  patterns: readonly string[];
  limit?: number;
}

export async function findFixHistoryCandidates(
  options: FindFixHistoryOptions,
): Promise<FixHistoryCandidate[]> {
  const patterns = options.patterns.map((pattern) => pattern.trim()).filter(Boolean);
  if (patterns.length === 0) return [];

  const candidates: FixHistoryCandidate[] = [];
  for (const pattern of patterns) {
    const output = await tryGitLog(options.repoPath, [
      'log',
      '--format=%H%x00%s',
      `-G${pattern}`,
      `-${String(options.limit ?? 20)}`,
      options.targetHead,
      '--',
      options.path,
    ]);
    for (const line of output.split('\n').filter(Boolean)) {
      const [commit = '', subject = ''] = line.split('\0');
      if (commit) {
        candidates.push({ commit, subject, path: options.path, matchedPattern: pattern });
      }
    }
  }

  return dedupeCandidates(candidates).slice(0, options.limit ?? 20);
}

async function tryGitLog(repoPath: string, args: string[]): Promise<string> {
  try {
    return await execFileText('git', args, {
      cwd: repoPath,
      timeoutMs: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER,
    });
  } catch {
    return '';
  }
}

function dedupeCandidates(candidates: readonly FixHistoryCandidate[]): FixHistoryCandidate[] {
  const seen = new Set<string>();
  const result: FixHistoryCandidate[] = [];
  for (const candidate of candidates) {
    const key = `${candidate.commit}:${candidate.path}:${candidate.matchedPattern}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(candidate);
  }
  return result;
}
