import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';

import {
  claimAnalysisJobRunner,
  completeAnalysisJob,
  type AnalysisJobRecord,
  type AnalysisJobRunnerOwner,
} from './analysis-coordinator.js';
import {
  assertValidManagedAnalysisContext,
  isValidSourceIdentity,
  MANAGED_ANALYSIS_ENV,
  type ManagedAnalysisContext,
} from './analysis-publication-receipt.js';

const MAX_LOG_BYTES = 1024 * 1024;
const JOB_TIMEOUT_MS = 30 * 60 * 1000;
const KILL_GRACE_MS = 5_000;
const PROCESS_GROUP_EXIT_TIMEOUT_MS = KILL_GRACE_MS + 5_000;
const PROCESS_GROUP_POLL_INTERVAL_MS = 25;
let runnerClaim: AnalysisJobRecord | null = null;

async function main(): Promise<void> {
  const jobFile = process.argv[2];
  if (!jobFile) throw new Error('analysis job file is required');
  const job = await claimAnalysisJobRunner(jobFile);
  if (!job) return;
  runnerClaim = job;
  const expectedRunner = runnerOwner(job);

  // Assigned after cancellation handlers are defined so early signals remain safe.
  // eslint-disable-next-line prefer-const
  let child: ReturnType<typeof spawn> | undefined;
  let terminal = false;
  let cancelling = false;
  let killTimer: NodeJS.Timeout | undefined;
  let written = 0;
  let appendQueue = Promise.resolve();
  const append = async (chunk: Buffer): Promise<void> => {
    if (written >= MAX_LOG_BYTES) return;
    const bounded = chunk.subarray(0, MAX_LOG_BYTES - written);
    written += bounded.length;
    appendQueue = appendQueue.then(() => fs.appendFile(job.logPath, bounded, { mode: 0o600 }));
    await appendQueue;
  };

  const stopChild = (): void => {
    if (!child) return;
    killAnalyzer(child, 'SIGTERM');
    killTimer = setTimeout(() => child && killAnalyzer(child, 'SIGKILL'), KILL_GRACE_MS);
    killTimer.unref?.();
  };
  const cancel = (reason = 'Analysis cancelled'): void => {
    if (terminal || cancelling) return;
    cancelling = true;
    job.error = reason;
    stopChild();
  };
  process.once('SIGTERM', () => cancel());
  process.once('SIGINT', () => cancel());

  child = spawn(job.command, job.args, {
    cwd: job.repoPath,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: managedAnalysisEnvironment(job),
  });
  if (cancelling) stopChild();
  const timeout = setTimeout(() => cancel('Analysis timed out (30 minute limit)'), JOB_TIMEOUT_MS);
  timeout.unref?.();
  child.stdout?.on('data', (chunk: Buffer) => void append(chunk));
  child.stderr?.on('data', (chunk: Buffer) => void append(chunk));
  child.once('error', async (error) => {
    if (terminal) return;
    terminal = true;
    clearTimeout(timeout);
    await appendQueue.catch(() => {});
    await completeAnalysisJob(
      jobFile,
      {
        status: 'failed',
        completedAt: new Date().toISOString(),
        error: error.message,
      },
      expectedRunner,
    );
  });
  child.once('exit', async (code, signal) => {
    if (terminal) return;
    terminal = true;
    clearTimeout(timeout);
    await appendQueue.catch(() => {});
    if (cancelling) {
      const analyzerGroupStopped = await waitForAnalyzerGroupExit(child.pid);
      if (killTimer) clearTimeout(killTimer);
      await completeAnalysisJob(
        jobFile,
        {
          status: analyzerGroupStopped ? 'cancelled' : 'failed',
          completedAt: new Date().toISOString(),
          exitCode: code,
          signal,
          error: analyzerGroupStopped
            ? (job.error ?? 'Analysis cancelled')
            : `Analysis process group remained active after ${PROCESS_GROUP_EXIT_TIMEOUT_MS}ms shutdown limit.`,
        },
        expectedRunner,
      );
      process.exitCode = analyzerGroupStopped ? 143 : 1;
      return;
    }
    await completeAnalysisJob(
      jobFile,
      {
        status: code === 0 ? 'complete' : 'failed',
        completedAt: new Date().toISOString(),
        exitCode: code,
        signal,
        ...(code === 0 ? {} : { error: `analyze exited with code ${code ?? 'null'}` }),
      },
      expectedRunner,
    );
  });
}

async function waitForAnalyzerGroupExit(pid: number | undefined): Promise<boolean> {
  if (process.platform === 'win32' || !pid) return true;
  const deadline = Date.now() + PROCESS_GROUP_EXIT_TIMEOUT_MS;
  while (isProcessGroupAlive(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, PROCESS_GROUP_POLL_INTERVAL_MS));
  }
  return !isProcessGroupAlive(pid);
}

function isProcessGroupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killAnalyzer(child: ReturnType<typeof spawn>, signal: NodeJS.Signals): void {
  try {
    if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    // The process may have exited between the status check and the signal.
  }
}

async function readProcessStartIdentity(pid: number): Promise<string | undefined> {
  if (process.platform !== 'linux') return undefined;
  try {
    const stat = await fs.readFile(`/proc/${pid}/stat`, 'utf8');
    return stat
      .slice(stat.lastIndexOf(')') + 2)
      .trim()
      .split(/\s+/)[19];
  } catch {
    return undefined;
  }
}

function runnerOwner(job: AnalysisJobRecord): AnalysisJobRunnerOwner {
  if (job.runnerPid === undefined) throw new Error('Managed analysis runner claim is incomplete.');
  return {
    pid: job.runnerPid,
    processStartIdentity: job.runnerProcessStartIdentity,
  };
}

function managedAnalysisEnvironment(job: AnalysisJobRecord): NodeJS.ProcessEnv {
  const context: ManagedAnalysisContext = {
    jobId: job.id,
    targetHead: job.targetHead,
    optionsDigest: job.optionsDigest,
    sourceIdentity: requireJobSourceIdentity(job),
    sourceManifestDigest: job.sourceManifestDigest,
    requestedCapabilities: job.requestedCapabilities,
  };
  assertValidManagedAnalysisContext(context);

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    [MANAGED_ANALYSIS_ENV.jobId]: context.jobId,
    [MANAGED_ANALYSIS_ENV.targetHead]: context.targetHead,
    [MANAGED_ANALYSIS_ENV.optionsDigest]: context.optionsDigest,
    [MANAGED_ANALYSIS_ENV.sourceIdentity]: context.sourceIdentity,
    [MANAGED_ANALYSIS_ENV.sourceManifestDigest]: context.sourceManifestDigest,
    [MANAGED_ANALYSIS_ENV.requestedCapabilities]: JSON.stringify(context.requestedCapabilities),
  };
  if (context.requestedCapabilities.embeddings) {
    env.ONTOINDEX_EMBEDDING_MODEL_HASH = context.requestedCapabilities.embeddingModelHash as string;
  } else {
    delete env.ONTOINDEX_EMBEDDING_MODEL_HASH;
  }
  return env;
}

function requireJobSourceIdentity(job: AnalysisJobRecord): string {
  if (!isValidSourceIdentity(job.sourceIdentity, job.targetHead, job.sourceManifestDigest)) {
    throw new Error('Managed analysis job does not contain a valid source identity.');
  }
  return job.sourceIdentity;
}

void main().catch(async (error: unknown) => {
  const jobFile = process.argv[2];
  if (jobFile && runnerClaim) {
    await completeAnalysisJob(
      jobFile,
      {
        status: 'failed',
        completedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error),
      },
      runnerOwner(runnerClaim),
    ).catch(() => {});
  }
  process.exitCode = 1;
});
