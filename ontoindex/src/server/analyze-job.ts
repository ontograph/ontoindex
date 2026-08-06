/**
 * Analyze Job Manager
 *
 * Tracks server-side analysis jobs with:
 * - In-memory Map storage
 * - Single-slot concurrency (one active job at a time)
 * - Same-repo deduplication (returns existing job)
 * - Progress event emission for SSE relay
 * - 1-hour TTL cleanup for completed/failed jobs
 */

import { randomUUID } from 'crypto';
import { EventEmitter } from 'events';
import type { ChildProcess } from 'child_process';
import fs from 'fs/promises';
import path from 'path';

export interface AnalyzeJobProgress {
  phase: string;
  percent: number;
  message: string;
}

export interface AnalyzeJob {
  id: string;
  status: 'queued' | 'cloning' | 'analyzing' | 'loading' | 'complete' | 'failed';
  repoUrl?: string;
  repoPath?: string;
  repoName?: string;
  progress: AnalyzeJobProgress;
  error?: string;
  startedAt: number;
  completedAt?: number;
  /** Number of times the worker has been retried after a crash. */
  retryCount: number;
}

interface JobLedger {
  jobs: AnalyzeJob[];
}

const JOB_TTL_MS = 60 * 60 * 1000; // 1 hour
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const JOB_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const CHILD_KILL_GRACE_MS = 5_000;
const LEDGER_PROGRESS_DEBOUNCE_MS = 1_000;

interface ChildRegistrationOptions {
  onTerminalExit?: () => void;
  killGraceMs?: number;
  processGroup?: boolean;
}

export class JobManager {
  private jobs = new Map<string, AnalyzeJob>();
  private children = new Map<string, ChildProcess>();
  private timeouts = new Map<string, ReturnType<typeof setTimeout>>();
  private killTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private childOptions = new Map<string, ChildRegistrationOptions>();
  private childCancellationReasons = new Map<string, string>();
  private cancelHandlers = new Map<string, () => void>();
  private emitter = new EventEmitter();
  private cleanupTimer: ReturnType<typeof setInterval>;
  private ledgerSaveTimer: ReturnType<typeof setTimeout> | null = null;
  private ledgerPath: string | null = null;
  private isLoading = false;
  private pendingSave: Promise<void> | null = null;

  constructor(persistencePath?: string) {
    if (persistencePath) {
      this.ledgerPath = path.join(persistencePath, 'jobs.json');
    }
    this.cleanupTimer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS);
    if (typeof this.cleanupTimer === 'object' && 'unref' in this.cleanupTimer) {
      this.cleanupTimer.unref();
    }
  }

  async init() {
    await this.loadLedger();
  }

  private async loadLedger() {
    if (!this.ledgerPath) return;
    this.isLoading = true;
    try {
      const data = await fs.readFile(this.ledgerPath, 'utf-8');
      const ledger = JSON.parse(data) as JobLedger;
      for (const job of ledger.jobs) {
        // Recover jobs. Active jobs from previous session are marked as failed
        if (!this.isTerminal(job.status)) {
          job.status = 'failed';
          job.error = 'Server restart';
          job.completedAt = Date.now();
        }
        this.jobs.set(job.id, job);
      }
    } catch (err) {
      // Ignore if file doesn't exist
    } finally {
      this.isLoading = false;
    }
  }

  private async saveLedger(): Promise<void> {
    if (!this.ledgerPath || this.isLoading) return;

    this.pendingSave = (this.pendingSave ?? Promise.resolve())
      .catch(() => {})
      .then(async () => {
        try {
          await fs.mkdir(path.dirname(this.ledgerPath!), { recursive: true });
          const ledger: JobLedger = {
            jobs: Array.from(this.jobs.values()),
          };
          await fs.writeFile(this.ledgerPath!, JSON.stringify(ledger, null, 2), 'utf-8');
        } catch (err) {
          console.error('Failed to save job ledger:', err);
        }
      });

    return this.pendingSave;
  }

  private scheduleLedgerSave(immediate = false): void {
    if (!this.ledgerPath || this.isLoading) return;

    if (immediate) {
      if (this.ledgerSaveTimer) {
        clearTimeout(this.ledgerSaveTimer);
        this.ledgerSaveTimer = null;
      }
      void this.saveLedger();
      return;
    }

    if (this.ledgerSaveTimer) return;
    this.ledgerSaveTimer = setTimeout(() => {
      this.ledgerSaveTimer = null;
      void this.saveLedger();
    }, LEDGER_PROGRESS_DEBOUNCE_MS);
    if (typeof this.ledgerSaveTimer === 'object' && 'unref' in this.ledgerSaveTimer) {
      this.ledgerSaveTimer.unref();
    }
  }

  /** Create a new job, or return existing active job for the same repo. */
  createJob(params: { repoUrl?: string; repoPath?: string }): AnalyzeJob {
    // Dedup: return existing active job for the same repo (by URL or path)
    for (const job of this.jobs.values()) {
      if (!this.isTerminal(job.status)) {
        const isSameRepo =
          (params.repoUrl && job.repoUrl === params.repoUrl) ||
          (params.repoPath && job.repoPath === params.repoPath);
        if (isSameRepo) {
          return job;
        }
      }
    }

    // Per-repo concurrency: reject if another job is active for the same repo path
    if (params.repoPath) {
      for (const job of this.jobs.values()) {
        if (!this.isTerminal(job.status) && job.repoPath === params.repoPath) {
          throw new Error(`Analysis already in progress for this repository (job ${job.id})`);
        }
      }
    }

    const job: AnalyzeJob = {
      id: randomUUID(),
      status: 'queued',
      repoUrl: params.repoUrl,
      repoPath: params.repoPath,
      progress: { phase: 'queued', percent: 0, message: 'Waiting to start...' },
      startedAt: Date.now(),
      retryCount: 0,
    };

    this.jobs.set(job.id, job);
    this.scheduleLedgerSave(true);
    return job;
  }

  getJob(id: string): AnalyzeJob | undefined {
    return this.jobs.get(id);
  }

  /** Return a snapshot of all tracked jobs for inspection. */
  listJobs(): AnalyzeJob[] {
    return Array.from(this.jobs.values());
  }

  updateJob(
    id: string,
    update: Partial<
      Pick<AnalyzeJob, 'status' | 'progress' | 'error' | 'repoPath' | 'repoName' | 'completedAt'>
    >,
  ) {
    const job = this.jobs.get(id);
    if (!job) return;

    Object.assign(job, update);

    if (this.isTerminal(job.status)) {
      job.completedAt = job.completedAt ?? Date.now();
      this.cancelHandlers.delete(id);
    }

    // Emit exactly one event per updateJob call to prevent SSE double-write
    if (update.status === 'complete' || update.status === 'failed') {
      // Terminal event takes precedence — don't also emit the progress event
      this.emitter.emit(`progress:${id}`, {
        phase: update.status,
        percent: update.status === 'complete' ? 100 : job.progress.percent,
        message: update.status === 'complete' ? 'Complete' : update.error || 'Failed',
      });
    } else if (update.progress) {
      this.emitter.emit(`progress:${id}`, update.progress);
    }

    const activeProgressUpdate =
      update.progress !== undefined &&
      update.error === undefined &&
      update.repoPath === undefined &&
      update.completedAt === undefined &&
      (update.status === undefined ||
        update.status === 'queued' ||
        update.status === 'cloning' ||
        update.status === 'analyzing' ||
        update.status === 'loading');
    this.scheduleLedgerSave(!activeProgressUpdate);
  }

  /** Register a child process for a job — enables cancellation and timeout. */
  registerChild(jobId: string, child: ChildProcess, options: ChildRegistrationOptions = {}) {
    this.children.set(jobId, child);
    this.childOptions.set(jobId, options);

    // 30-minute timeout
    const timer = setTimeout(() => {
      const job = this.jobs.get(jobId);
      if (job && !this.isTerminal(job.status)) {
        this.cancelJob(jobId, 'Analysis timed out (30 minute limit)');
      }
    }, JOB_TIMEOUT_MS);
    this.timeouts.set(jobId, timer);

    // Clean up tracking when child exits
    child.on('exit', () => {
      const t = this.timeouts.get(jobId);
      if (t) {
        clearTimeout(t);
        this.timeouts.delete(jobId);
      }
      const job = this.jobs.get(jobId);
      const registeredOptions = this.childOptions.get(jobId);
      const cancellationReason = this.childCancellationReasons.get(jobId);
      if (job && cancellationReason) {
        void this.finishCancelledChild(jobId, child, registeredOptions, cancellationReason);
      } else if (job && this.isTerminal(job.status)) {
        void this.finishTerminalChild(jobId, child, registeredOptions);
      } else {
        this.children.delete(jobId);
        this.childOptions.delete(jobId);
        this.clearKillTimer(jobId);
      }
    });
  }

  /** Register non-child cancellation work, such as aborting an in-process job. */
  registerCancelHandler(jobId: string, handler: () => void): () => void {
    this.cancelHandlers.set(jobId, handler);
    return () => {
      if (this.cancelHandlers.get(jobId) === handler) {
        this.cancelHandlers.delete(jobId);
      }
    };
  }

  /** Cancel a running job — sends SIGTERM to child process. */
  cancelJob(jobId: string, reason?: string): boolean {
    const job = this.jobs.get(jobId);
    if (!job || this.isTerminal(job.status)) return false;

    const cancelHandler = this.cancelHandlers.get(jobId);
    if (cancelHandler) {
      this.cancelHandlers.delete(jobId);
      cancelHandler();
    }

    const child = this.children.get(jobId);
    if (child) {
      const options = this.childOptions.get(jobId);
      const cancellationReason = reason || 'Analysis cancelled';
      signalChild(child, 'SIGTERM', options?.processGroup === true);
      if (options?.processGroup) {
        this.childCancellationReasons.set(jobId, cancellationReason);
      }
      const killGraceMs = options?.killGraceMs ?? CHILD_KILL_GRACE_MS;
      if (!this.killTimers.has(jobId)) {
        const killTimer = setTimeout(() => {
          const currentJob = this.jobs.get(jobId);
          if (
            currentJob &&
            (this.isTerminal(currentJob.status) || this.childCancellationReasons.has(jobId))
          ) {
            signalChild(child, 'SIGKILL', options?.processGroup === true);
          }
        }, killGraceMs);
        killTimer.unref?.();
        this.killTimers.set(jobId, killTimer);
      }
      if (options?.processGroup) {
        this.updateJob(jobId, {
          progress: {
            phase: 'cancelling',
            percent: job.progress.percent,
            message: cancellationReason,
          },
          error: cancellationReason,
        });
        return true;
      }
    }

    this.updateJob(jobId, {
      status: 'failed',
      error: reason || 'Analysis cancelled',
    });

    return true;
  }

  private async finishCancelledChild(
    jobId: string,
    child: ChildProcess,
    options: ChildRegistrationOptions | undefined,
    reason: string,
  ): Promise<void> {
    if (options?.processGroup && child.pid) {
      await waitForProcessGroupExit(child.pid);
    }
    this.childCancellationReasons.delete(jobId);
    this.children.delete(jobId);
    this.childOptions.delete(jobId);
    this.clearKillTimer(jobId);
    this.updateJob(jobId, { status: 'failed', error: reason });
    options?.onTerminalExit?.();
  }

  private async finishTerminalChild(
    jobId: string,
    child: ChildProcess,
    options: ChildRegistrationOptions | undefined,
  ): Promise<void> {
    if (options?.processGroup && child.pid) {
      await waitForProcessGroupExit(child.pid);
    }
    this.children.delete(jobId);
    this.childOptions.delete(jobId);
    this.clearKillTimer(jobId);
    options?.onTerminalExit?.();
  }

  private clearKillTimer(jobId: string): void {
    const killTimer = this.killTimers.get(jobId);
    if (!killTimer) return;
    clearTimeout(killTimer);
    this.killTimers.delete(jobId);
  }

  /** Subscribe to progress events for a job. Returns unsubscribe function. */
  onProgress(jobId: string, listener: (progress: AnalyzeJobProgress) => void): () => void {
    const event = `progress:${jobId}`;
    this.emitter.on(event, listener);
    return () => this.emitter.off(event, listener);
  }

  async dispose() {
    // Kill all active child processes
    for (const [jobId, child] of this.children) {
      signalChild(child, 'SIGTERM', this.childOptions.get(jobId)?.processGroup === true);
    }
    this.children.clear();

    // Clear all timeouts
    for (const timer of this.timeouts.values()) {
      clearTimeout(timer);
    }
    this.timeouts.clear();
    for (const timer of this.killTimers.values()) {
      clearTimeout(timer);
    }
    this.killTimers.clear();
    this.childOptions.clear();
    this.childCancellationReasons.clear();
    this.cancelHandlers.clear();

    clearInterval(this.cleanupTimer);
    if (this.ledgerSaveTimer) {
      clearTimeout(this.ledgerSaveTimer);
      this.ledgerSaveTimer = null;
      await this.saveLedger();
    }
    this.emitter.removeAllListeners();

    if (this.pendingSave) {
      await this.pendingSave.catch(() => {});
    }
  }

  private isTerminal(status: AnalyzeJob['status']): boolean {
    return status === 'complete' || status === 'failed';
  }

  private cleanup() {
    const now = Date.now();
    let changed = false;
    for (const [id, job] of this.jobs) {
      if (this.isTerminal(job.status) && job.completedAt && now - job.completedAt > JOB_TTL_MS) {
        this.jobs.delete(id);
        changed = true;
      }
    }
    if (changed) {
      this.scheduleLedgerSave(true);
    }
  }
}

function signalChild(child: ChildProcess, signal: NodeJS.Signals, processGroup: boolean): void {
  try {
    if (processGroup && process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    // The child or process group may already have exited.
  }
}

async function waitForProcessGroupExit(pid: number): Promise<void> {
  if (process.platform === 'win32') return;
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
