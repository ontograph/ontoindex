import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadMeta } from '../../storage/repo-manager.js';

export type AnalysisJobStatus = 'queued' | 'running' | 'complete' | 'failed' | 'cancelled';
const JOB_TTL_MS = 60 * 60 * 1000;

export interface AnalysisJobRecord {
  version: 1;
  id: string;
  status: AnalysisJobStatus;
  repoPath: string;
  targetHead: string;
  sourceManifestDigest?: string;
  optionsDigest: string;
  command: string;
  args: string[];
  logPath: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  runnerPid?: number;
  runnerProcessStartIdentity?: string;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  generationId?: string;
  error?: string;
}

export interface SubmitAnalysisJobInput {
  repoPath: string;
  targetHead: string;
  command: string;
  args: string[];
  options: Record<string, unknown>;
}

export async function submitAnalysisJob(
  input: SubmitAnalysisJobInput,
): Promise<{ job: AnalysisJobRecord; reused: boolean }> {
  const repoPath = path.resolve(input.repoPath);
  const repoStat = await fs.stat(repoPath);
  if (!repoStat.isDirectory())
    throw new Error(`Analysis repository is not a directory: ${repoPath}`);
  const dir = jobsDir(repoPath);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await cleanupExpiredJobs(dir);

  const optionsDigest = digest(
    stableJson({ command: input.command, args: input.args, options: input.options }),
  );

  const active = await readActiveJob(repoPath);
  if (active && (await isActive(active))) {
    if (active.targetHead === input.targetHead && active.optionsDigest === optionsDigest) {
      return { job: active, reused: true };
    }
    throw new Error(
      `Analysis job ${active.id} is already active for a different analysis request.`,
    );
  }
  if (active) await clearActive(repoPath, active.id);

  const id = randomUUID();
  const job: AnalysisJobRecord = {
    version: 1,
    id,
    status: 'queued',
    repoPath,
    targetHead: input.targetHead,
    optionsDigest,
    command: input.command,
    args: input.args,
    logPath: path.join(dir, `${id}.log`),
    createdAt: new Date().toISOString(),
  };
  await writeJob(job);

  try {
    await fs.writeFile(activePath(repoPath), id, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const winner = await readActiveJob(repoPath);
    if (winner && (await isActive(winner))) {
      await fs.rm(jobPath(repoPath, id), { force: true });
      if (winner.targetHead === input.targetHead && winner.optionsDigest === optionsDigest) {
        return { job: winner, reused: true };
      }
      throw new Error(
        `Analysis job ${winner.id} is already active for a different analysis request.`,
      );
    }
    await clearActive(repoPath, winner?.id);
    await fs.writeFile(activePath(repoPath), id, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  }

  const runnerPath =
    process.env.ONTOINDEX_ANALYSIS_JOB_RUNNER_PATH ??
    fileURLToPath(new URL('./analysis-job-runner.js', import.meta.url));
  const child = spawn(process.execPath, [runnerPath, jobPath(repoPath, id)], {
    cwd: repoPath,
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  return { job, reused: false };
}

export async function getAnalysisJob(
  repoPath: string,
  id: string,
): Promise<AnalysisJobRecord | null> {
  try {
    await cleanupExpiredJobs(jobsDir(repoPath));
    const job = JSON.parse(await fs.readFile(jobPath(repoPath, id), 'utf8')) as AnalysisJobRecord;
    if (!isTerminal(job.status) && !(await isActive(job))) {
      return completeAnalysisJob(jobPath(repoPath, id), {
        status: 'failed',
        completedAt: new Date().toISOString(),
        error: 'Analysis runner is no longer active.',
      });
    }
    return job;
  } catch {
    return null;
  }
}

export async function cancelAnalysisJob(
  repoPath: string,
  id: string,
): Promise<{ job: AnalysisJobRecord | null; cancelled: boolean }> {
  const job = await getAnalysisJob(repoPath, id);
  if (!job || !(await isActive(job)) || !job.runnerPid) return { job, cancelled: false };
  try {
    process.kill(job.runnerPid, 'SIGTERM');
    return { job, cancelled: true };
  } catch {
    return { job: await getAnalysisJob(repoPath, id), cancelled: false };
  }
}

export async function completeAnalysisJob(
  jobFile: string,
  update: Partial<AnalysisJobRecord>,
): Promise<AnalysisJobRecord> {
  const current = JSON.parse(await fs.readFile(jobFile, 'utf8')) as AnalysisJobRecord;
  const next = { ...current, ...update };
  const meta =
    next.status === 'complete' ? await loadMeta(path.join(next.repoPath, '.ontoindex')) : null;
  if (meta?.generationId) next.generationId = meta.generationId;
  await writeJob(next);
  if (!(await isActive(next))) await clearActive(next.repoPath, next.id);
  return next;
}

export async function writeAnalysisJob(job: AnalysisJobRecord): Promise<void> {
  await writeJob(job);
}

async function isActive(job: AnalysisJobRecord): Promise<boolean> {
  if (job.status !== 'queued' && job.status !== 'running') return false;
  if (!job.runnerPid) {
    return job.status === 'queued' && Date.now() - Date.parse(job.createdAt) < 10_000;
  }
  try {
    process.kill(job.runnerPid, 0);
    if (!job.runnerProcessStartIdentity) return true;
    const currentIdentity = await readProcessStartIdentity(job.runnerPid);
    return currentIdentity === job.runnerProcessStartIdentity;
  } catch {
    return false;
  }
}

async function readActiveJob(repoPath: string): Promise<AnalysisJobRecord | null> {
  try {
    const id = (await fs.readFile(activePath(repoPath), 'utf8')).trim();
    return id ? await getAnalysisJob(repoPath, id) : null;
  } catch {
    return null;
  }
}

async function clearActive(repoPath: string, expectedId?: string): Promise<void> {
  if (expectedId) {
    const current = await fs.readFile(activePath(repoPath), 'utf8').catch(() => '');
    if (current.trim() !== expectedId) return;
  }
  await fs.rm(activePath(repoPath), { force: true });
}

async function readProcessStartIdentity(pid: number): Promise<string | null> {
  if (process.platform !== 'linux') return null;
  try {
    const stat = await fs.readFile(`/proc/${pid}/stat`, 'utf8');
    return (
      stat
        .slice(stat.lastIndexOf(')') + 2)
        .trim()
        .split(/\s+/)[19] ?? null
    );
  } catch {
    return null;
  }
}

function isTerminal(status: AnalysisJobStatus): boolean {
  return status === 'complete' || status === 'failed' || status === 'cancelled';
}

function jobsDir(repoPath: string): string {
  return path.join(path.resolve(repoPath), '.ontoindex', 'analysis-jobs');
}

function jobPath(repoPath: string, id: string): string {
  if (!/^[0-9a-f-]+$/i.test(id)) throw new Error('Invalid analysis job id.');
  return path.join(jobsDir(repoPath), `${id}.json`);
}

function activePath(repoPath: string): string {
  return path.join(jobsDir(repoPath), 'active');
}

async function writeJob(job: AnalysisJobRecord): Promise<void> {
  const file = jobPath(job.repoPath, job.id);
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temp, JSON.stringify(job, null, 2), { encoding: 'utf8', mode: 0o600 });
  await fs.rename(temp, file);
}

async function cleanupExpiredJobs(dir: string): Promise<void> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const now = Date.now();
  await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map(async (entry) => {
        const file = path.join(dir, entry.name);
        const job = await fs
          .readFile(file, 'utf8')
          .then((value) => JSON.parse(value) as AnalysisJobRecord)
          .catch(() => null);
        if (!job || !isTerminal(job.status) || !job.completedAt) return;
        if (now - Date.parse(job.completedAt) <= JOB_TTL_MS) return;
        const log = path.join(dir, `${path.basename(entry.name, '.json')}.log`);
        await Promise.all([fs.rm(file, { force: true }), fs.rm(log, { force: true })]);
      }),
  );
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
