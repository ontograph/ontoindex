import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileText } from '../../core/process/exec-file.js';
import { readAnalyzeLock, readRuntimeHealth } from '../../core/runtime/runtime-health.js';
import { acquireNativeFileLock } from '../../native/file-lock.js';
import { readActiveGenerationMeta } from '../../storage/repo-manager.js';
import {
  currentCliCommand,
  gnEnsureFresh,
  type EnsureFreshParams,
  type EnsureFreshReport,
} from '../super/ensure-fresh.js';

interface RefreshRepo {
  id: string;
  name?: string;
  repoPath: string;
  storagePath: string;
}

type RefreshScope = NonNullable<EnsureFreshParams['scope']>;
interface RefreshDeps {
  ensureFresh?: typeof gnEnsureFresh;
  spawnRefresh?: (repo: RefreshRepo, scope: RefreshScope) => Promise<void>;
  now?: () => number;
}

const pending = new Map<string, Promise<string | undefined>>();
const sourceChecks = new Map<string, { expiresAt: number; warning?: string }>();
const STALE_DETAIL = 'This answer uses the existing index; results update after the background refresh finishes.';
const STALE = `OntoIndex index is stale. ${STALE_DETAIL}`;

async function spawnRefresh(repo: RefreshRepo, scope: RefreshScope): Promise<void> {
  const cli = currentCliCommand();
  const args = [...cli.argsPrefix, 'analyze', repo.repoPath];
  for (const includePath of scope.includePaths) args.push('--include-path', includePath);
  if (scope.pipelineProfile === 'symbols') args.push('--symbols-only');
  // An empty Git repository supports analyze; only plain folders need --skip-git.
  try {
    await execFileText('git', ['rev-parse', '--show-toplevel'], {
      cwd: repo.repoPath, timeoutMs: 1000,
    });
  } catch {
    args.push('--skip-git');
  }
  const log = await fs.open(path.join(repo.storagePath, 'auto-refresh.log'), 'a', 0o600);
  try {
    const child = spawn(cli.command, args, {
      cwd: repo.repoPath,
      detached: true,
      stdio: ['ignore', log.fd, log.fd],
    });
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    child.unref();
  } finally {
    await log.close();
  }
}

async function schedule(repo: RefreshRepo, deps: RefreshDeps): Promise<string | undefined> {
  const { meta } = await readActiveGenerationMeta(repo.storagePath);
  if (!meta) return undefined;
  const head = await execFileText('git', ['rev-parse', 'HEAD'], {
    cwd: repo.repoPath, timeoutMs: 1000,
  }).then((value) => value.trim(), () => undefined);
  const commitless = !head && !meta.lastCommit && !!meta.sourceManifest;
  if (!commitless && (!head || !meta.lastCommit || head === meta.lastCommit)) return undefined;
  const stale = commitless ? STALE
    : `OntoIndex index is stale (indexed ${meta.lastCommit.slice(0, 8)}, HEAD ${head!.slice(0, 8)}). ${STALE_DETAIL}`;
  const profile = meta.sourceManifest?.pipelineProfile ?? meta.pipelineProfile ?? 'full';
  if (profile === 'huge-repo-symbols') {
    return `${stale} Automatic refresh is disabled for huge-repo-symbols; run analyze manually with the recorded scope.`;
  }
  const scope: RefreshScope = {
    includePaths: meta.sourceManifest?.includePaths ?? meta.includePaths ?? [],
    pipelineProfile: profile,
  };
  const configured = Number(process.env.ONTOINDEX_AUTO_REFRESH_INTERVAL_MS ?? 300000);
  const interval = Number.isFinite(configured) && configured >= 0 ? configured : 300000;
  const now = (deps.now ?? Date.now)();
  const key = `${repo.id}:${repo.storagePath}`;
  if (commitless) {
    const cached = sourceChecks.get(key);
    if (cached && cached.expiresAt > now) return cached.warning;
  }
  // The OS lock serializes the stamp check/touch across CLI and MCP processes,
  // and is released by the OS if a process exits during the check.
  const lock = await acquireNativeFileLock(path.join(repo.storagePath, 'auto-refresh.stamp.lock'));
  try {
    const stamp = path.join(repo.storagePath, 'auto-refresh.stamp');
    const stat = await fs.stat(stamp).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
      return undefined;
    });
    if (stat && now - stat.mtimeMs < interval) {
      if (!commitless) return stale;
      const warning = (await fs.readFile(stamp, 'utf8')) === 'stale' ? stale : undefined;
      sourceChecks.set(key, { expiresAt: stat.mtimeMs + interval, warning });
      return warning;
    }
    await fs.writeFile(stamp, commitless ? 'checking' : 'stale', { mode: 0o600 });
    await fs.utimes(stamp, now / 1000, now / 1000);
    if (commitless) {
      const health = await readRuntimeHealth(repo.repoPath, { storagePath: repo.storagePath, meta });
      const isStale = health.freshnessState === 'stale';
      await fs.writeFile(stamp, isStale ? 'stale' : 'clean');
      await fs.utimes(stamp, now / 1000, now / 1000);
      sourceChecks.set(key, { expiresAt: now + interval, warning: isStale ? stale : undefined });
      if (!isStale) return undefined;
      const analyzeLock = await readAnalyzeLock(repo.storagePath, []);
      if (analyzeLock.state === 'active' || analyzeLock.state === 'unknown') {
        return `${stale} Refresh blocked: ${analyzeLock.reason ?? 'analysis is already running'}.`;
      }
      await (deps.spawnRefresh ?? spawnRefresh)(repo, scope);
      return `${stale} Refresh started in the background.`;
    }
    const report = await (deps.ensureFresh ?? gnEnsureFresh)(repo.repoPath, {
      repo: repo.repoPath, autoAnalyze: true, scope,
    }) as EnsureFreshReport;
    const submission = report.analysisSubmission;
    if (submission.status === 'queued' || submission.status === 'reused') {
      return `${stale} Refresh ${submission.status === 'reused' ? 'already running' : 'started in the background'} (job ${submission.jobId}).`;
    }
    if (
      submission.status === 'blocked' &&
      (submission.reasonCode === 'ACTIVE_JOB_CONFLICT' || submission.reasonCode === 'LOCK_CONFLICT')
    ) {
      // An earlier refresh is still running; the next query after it finishes
      // schedules the remaining catch-up.
      return `${stale} A refresh is already running; a later query schedules the next one after the refresh interval if HEAD has moved again.`;
    }
    if (submission.status === 'blocked') {
      return `${stale} Refresh blocked (${submission.reasonCode}): ${submission.message}`;
    }
    if (submission.status === 'failed') return `${stale} Refresh failed: ${submission.message}`;
    return stale;
  } finally {
    lock.release();
  }
}

/** Best-effort scheduling must never prevent a graph read. */
export function maybeScheduleAutoRefresh(
  repo: RefreshRepo,
  deps: RefreshDeps = {},
): Promise<string | undefined> {
  if (process.env.ONTOINDEX_AUTO_REFRESH === '0') return Promise.resolve(undefined);
  const key = `${repo.id}:${repo.storagePath}`;
  const existing = pending.get(key);
  if (existing) return existing;
  const result = schedule(repo, deps).catch(() => undefined).finally(() => pending.delete(key));
  pending.set(key, result);
  return result;
}
