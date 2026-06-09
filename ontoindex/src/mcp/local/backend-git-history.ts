import { execFile } from 'child_process';

const COMMIT_SEPARATOR = '__GN_COMMIT__';

function boundedEnvInt(name: string, defaultValue: number, min: number, max: number): number {
  const raw = Number.parseInt(process.env[name] ?? '', 10);
  if (!Number.isFinite(raw)) return defaultValue;
  return Math.max(min, Math.min(raw, max));
}

const GIT_LOG_TIMEOUT_MS = boundedEnvInt('ONTOINDEX_GIT_HISTORY_TIMEOUT_MS', 5_000, 500, 60_000);
const GIT_LOG_MAX_BUFFER = boundedEnvInt(
  'ONTOINDEX_GIT_HISTORY_MAX_BUFFER',
  16 * 1024 * 1024,
  1024 * 1024,
  128 * 1024 * 1024,
);
const GIT_LOG_MAX_COMMITS = boundedEnvInt('ONTOINDEX_GIT_HISTORY_MAX_COMMITS', 5000, 1, 100_000);
const GIT_LOG_MAX_FILES_PER_COMMIT = boundedEnvInt(
  'ONTOINDEX_GIT_HISTORY_MAX_FILES_PER_COMMIT',
  300,
  1,
  10_000,
);

export interface GitCommitRecord {
  sha: string;
  author: string;
  timestamp: number;
  files: string[];
}

export interface GitHistoryResult {
  commits: GitCommitRecord[];
  warnings: string[];
}

function execGitLog(repoPath: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      {
        cwd: repoPath,
        encoding: 'utf-8',
        maxBuffer: GIT_LOG_MAX_BUFFER,
        timeout: GIT_LOG_TIMEOUT_MS,
        windowsHide: true,
      },
      (err, stdout) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(stdout);
      },
    );
  });
}

export async function collectGitCommits(
  repoPath: string,
  since: string,
): Promise<GitHistoryResult> {
  let output = '';
  try {
    output = await execGitLog(repoPath, [
      'log',
      `--since=${since}`,
      `--max-count=${GIT_LOG_MAX_COMMITS}`,
      `--pretty=format:${COMMIT_SEPARATOR}%H|%at|%an`,
      '--name-only',
    ]);
  } catch {
    return { commits: [], warnings: [] };
  }

  const warnings: string[] = [];
  const commits: GitCommitRecord[] = [];
  let current: GitCommitRecord | null = null;
  let currentFileCount = 0;
  let currentSkipped = false;

  for (const rawLine of output.split('\n')) {
    const line = rawLine.trimEnd();
    if (line.startsWith(COMMIT_SEPARATOR)) {
      if (current) commits.push(current);
      const payload = line.slice(COMMIT_SEPARATOR.length);
      const [sha, tsStr, ...rest] = payload.split('|');
      const ts = Number.parseInt(tsStr, 10);
      current = {
        sha,
        author: rest.join('|'),
        timestamp: Number.isFinite(ts) ? ts * 1000 : Date.now(),
        files: [],
      };
      currentFileCount = 0;
      currentSkipped = false;
      continue;
    }
    if (!current || line.length === 0) continue;
    currentFileCount++;
    if (currentFileCount > GIT_LOG_MAX_FILES_PER_COMMIT) {
      if (!currentSkipped) {
        warnings.push(
          `Commit ${current.sha.slice(0, 12)} exceeded ${GIT_LOG_MAX_FILES_PER_COMMIT} files; remaining files ignored`,
        );
        currentSkipped = true;
      }
      continue;
    }
    current.files.push(line);
  }
  if (current) commits.push(current);
  if (commits.length >= GIT_LOG_MAX_COMMITS) {
    warnings.push(`Git history scan capped at ${GIT_LOG_MAX_COMMITS} commits`);
  }
  return { commits, warnings };
}

export async function commitsByFile(repoPath: string, since: string): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  const { commits } = await collectGitCommits(repoPath, since);
  for (const commit of commits) {
    for (const file of commit.files) {
      counts.set(file, (counts.get(file) ?? 0) + 1);
    }
  }

  return counts;
}
