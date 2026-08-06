import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';

import {
  completeAnalysisJob,
  writeAnalysisJob,
  type AnalysisJobRecord,
} from './analysis-coordinator.js';

const MAX_LOG_BYTES = 1024 * 1024;
const JOB_TIMEOUT_MS = 30 * 60 * 1000;
const KILL_GRACE_MS = 5_000;

async function main(): Promise<void> {
  const jobFile = process.argv[2];
  if (!jobFile) throw new Error('analysis job file is required');
  const job = JSON.parse(await fs.readFile(jobFile, 'utf8')) as AnalysisJobRecord;
  job.status = 'running';
  job.runnerPid = process.pid;
  job.runnerProcessStartIdentity = await readProcessStartIdentity(process.pid);
  job.startedAt = new Date().toISOString();
  await writeAnalysisJob(job);

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
    await completeAnalysisJob(jobFile, {
      status: 'failed',
      completedAt: new Date().toISOString(),
      error: error.message,
    });
  });
  child.once('exit', async (code, signal) => {
    if (terminal) return;
    terminal = true;
    clearTimeout(timeout);
    await appendQueue.catch(() => {});
    if (cancelling) {
      await waitForAnalyzerGroupExit(child.pid);
      if (killTimer) clearTimeout(killTimer);
      await completeAnalysisJob(jobFile, {
        status: 'cancelled',
        completedAt: new Date().toISOString(),
        exitCode: code,
        signal,
        error: job.error ?? 'Analysis cancelled',
      });
      process.exitCode = 143;
      return;
    }
    await completeAnalysisJob(jobFile, {
      status: code === 0 ? 'complete' : 'failed',
      completedAt: new Date().toISOString(),
      exitCode: code,
      signal,
      ...(code === 0 ? {} : { error: `analyze exited with code ${code ?? 'null'}` }),
    });
  });
}

async function waitForAnalyzerGroupExit(pid: number | undefined): Promise<void> {
  if (process.platform === 'win32' || !pid) return;
  while (isProcessGroupAlive(pid)) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
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

void main().catch(async (error: unknown) => {
  const jobFile = process.argv[2];
  if (jobFile) {
    await completeAnalysisJob(jobFile, {
      status: 'failed',
      completedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
    }).catch(() => {});
  }
  process.exitCode = 1;
});
