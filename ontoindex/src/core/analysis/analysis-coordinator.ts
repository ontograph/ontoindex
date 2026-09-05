import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getStoragePaths } from '../../storage/repo-manager.js';
import { readAnalyzeLock } from '../runtime/runtime-health.js';
import {
  ANALYSIS_REQUESTED_CAPABILITIES_VERSION,
  assertValidManagedAnalysisContext,
  isValidSourceIdentity,
  type AnalysisRequestedCapabilities,
  type ManagedAnalysisContext,
} from './analysis-publication-receipt.js';

export type AnalysisJobStatus = 'queued' | 'running' | 'complete' | 'failed' | 'cancelled';
export type AnalysisJobPublicationState = 'publishing' | 'published';
const JOB_TTL_MS = 60 * 60 * 1000;
const RUNNER_LAUNCH_TIMEOUT_MS = 30_000;
const ACTIVE_MUTATION_LOCK_MAX_ATTEMPTS = 500;
const ACTIVE_MUTATION_LOCK_RETRY_DELAY_MS = 10;

export interface AnalysisJobRecord {
  version: 1;
  id: string;
  status: AnalysisJobStatus;
  repoPath: string;
  targetHead: string;
  requestedCapabilities: AnalysisRequestedCapabilities;
  sourceIdentity: string;
  sourceManifestDigest: string;
  optionsDigest: string;
  command: string;
  args: string[];
  logPath: string;
  createdAt: string;
  launchDeadlineAt?: string;
  startedAt?: string;
  completedAt?: string;
  runnerPid?: number;
  runnerProcessStartIdentity?: string;
  analyzerPid?: number;
  analyzerProcessStartIdentity?: string;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  generationId?: string;
  publicationState?: AnalysisJobPublicationState;
  error?: string;
}

export interface SubmitAnalysisJobInput {
  repoPath: string;
  targetHead: string;
  command: string;
  args: string[];
  options: Record<string, unknown>;
  requestedCapabilities?: AnalysisRequestedCapabilities;
  sourceIdentity: string;
  sourceManifestDigest: string;
}

export class AnalysisJobLockConflictError extends Error {
  readonly code = 'LOCK_CONFLICT';
  readonly lockState: 'active' | 'unknown';
  readonly lockReason?: string;

  constructor(lockState: 'active' | 'unknown', lockReason?: string) {
    super(lockReason ?? 'Analysis lock ownership could not be safely reconciled.');
    this.name = 'AnalysisJobLockConflictError';
    this.lockState = lockState;
    this.lockReason = lockReason;
  }
}

export class AnalysisJobActiveConflictError extends Error {
  readonly code = 'ACTIVE_JOB_CONFLICT';
  readonly activeJobId: string;

  constructor(activeJobId: string) {
    super(`Analysis job ${activeJobId} is already active for a different analysis request.`);
    this.name = 'AnalysisJobActiveConflictError';
    this.activeJobId = activeJobId;
  }
}

export type AnalysisJobCancellationRefusalReason =
  | 'JOB_NOT_FOUND'
  | 'JOB_NOT_CANCELLABLE'
  | 'PROCESS_IDENTITY_UNAVAILABLE'
  | 'PROCESS_IDENTITY_MISMATCH'
  | 'SIGNAL_FAILED';

export interface AnalysisJobCancellationResult {
  job: AnalysisJobRecord | null;
  cancelled: boolean;
  refusal?: {
    reasonCode: AnalysisJobCancellationRefusalReason;
    message: string;
  };
}

export interface AnalysisJobRunnerOwner {
  pid: number;
  processStartIdentity?: string;
}

export class ManagedAnalysisFencedAttemptError extends Error {
  readonly code = 'MANAGED_ANALYSIS_FENCED_ATTEMPT';

  constructor(message = 'Managed analysis attempt was fenced by the canonical job owner.') {
    super(message);
    this.name = 'ManagedAnalysisFencedAttemptError';
  }
}

interface ActiveMutationLockRecord {
  version: 1;
  token: string;
  pid: number;
  processStartIdentity: string;
  acquiredAt: string;
  repoPath: string;
}

interface ActiveJobSnapshot {
  markerId: string;
  job: AnalysisJobRecord | null;
}

export type AnalysisJobLifecycleUpdate = Partial<
  Pick<
    AnalysisJobRecord,
    | 'status'
    | 'startedAt'
    | 'completedAt'
    | 'runnerPid'
    | 'runnerProcessStartIdentity'
    | 'exitCode'
    | 'signal'
    | 'error'
  >
>;

const ANALYSIS_JOB_LIFECYCLE_FIELDS = [
  'status',
  'startedAt',
  'completedAt',
  'runnerPid',
  'runnerProcessStartIdentity',
  'exitCode',
  'signal',
  'error',
] as const satisfies readonly (keyof AnalysisJobLifecycleUpdate)[];

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

  const requestedCapabilities = input.requestedCapabilities ?? {
    version: ANALYSIS_REQUESTED_CAPABILITIES_VERSION,
    graph: true,
    graphCapabilities: ['symbols'],
    embeddings: false,
    embeddingModelHash: null,
  };
  validateRequestedCapabilities(requestedCapabilities);
  validateTargetHead(input.targetHead);
  validateSha256(input.sourceManifestDigest, 'Analysis source manifest digest');
  validateSourceIdentity(input.sourceIdentity, input.targetHead, input.sourceManifestDigest);

  const optionsDigest = digest(
    stableJson({
      command: input.command,
      args: input.args,
      options: input.options,
      requestedCapabilities,
      sourceIdentity: input.sourceIdentity,
      sourceManifestDigest: input.sourceManifestDigest,
    }),
  );

  const submission = await withActiveMutationLock(repoPath, async () => {
    let active = await readActiveSnapshotLocked(repoPath);
    if (active?.job) {
      const expired = await expireQueuedLaunchLocked(repoPath, active.job);
      if (expired) active = null;
    }
    const activeIsLive = active?.job ? await isActive(active.job) : false;
    if (active?.job && activeIsLive) {
      if (
        isCompatibleActiveRequest(
          active.job,
          input.targetHead,
          optionsDigest,
          requestedCapabilities,
          input.sourceIdentity,
          input.sourceManifestDigest,
        )
      ) {
        return { job: active.job, reused: true };
      }
      throw new AnalysisJobActiveConflictError(active.job.id);
    }
    if (active) await clearActiveLocked(repoPath, active.markerId);
    const analyzeLock = await readAnalyzeLock(getStoragePaths(repoPath).storagePath, []);
    if (analyzeLock.state === 'active' || analyzeLock.state === 'unknown') {
      throw new AnalysisJobLockConflictError(analyzeLock.state, analyzeLock.reason);
    }

    const id = randomUUID();
    const job: AnalysisJobRecord = {
      version: 1,
      id,
      status: 'queued',
      repoPath,
      targetHead: input.targetHead,
      requestedCapabilities,
      sourceIdentity: input.sourceIdentity,
      sourceManifestDigest: input.sourceManifestDigest,
      optionsDigest,
      command: input.command,
      args: input.args,
      logPath: path.join(dir, `${id}.log`),
      createdAt: new Date().toISOString(),
      launchDeadlineAt: new Date(Date.now() + RUNNER_LAUNCH_TIMEOUT_MS).toISOString(),
    };
    await writeJob(job);
    try {
      await fs.writeFile(activePath(repoPath), id, {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
      });
    } catch (error: unknown) {
      await fs.rm(jobPath(repoPath, id), { force: true }).catch(() => {});
      throw error;
    }
    return { job, reused: false };
  });

  if (submission.reused) return submission;

  const runnerPath =
    process.env.ONTOINDEX_ANALYSIS_JOB_RUNNER_PATH ??
    fileURLToPath(new URL('./analysis-job-runner.js', import.meta.url));
  try {
    const child = spawn(process.execPath, [runnerPath, jobPath(repoPath, submission.job.id)], {
      cwd: repoPath,
      detached: true,
      stdio: 'ignore',
    });
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    child.unref();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await failAnalysisJobLaunch(repoPath, submission.job.id, message);
    throw error;
  }
  return submission;
}

export async function failAnalysisJobLaunch(
  repoPath: string,
  id: string,
  error: string,
): Promise<AnalysisJobRecord | null> {
  const resolvedRepoPath = path.resolve(repoPath);
  return withActiveMutationLock(resolvedRepoPath, async () => {
    const active = await readActiveSnapshotLocked(resolvedRepoPath);
    const job =
      active?.markerId === id
        ? active.job
        : await readJobFile(jobPath(resolvedRepoPath, id)).catch(() => null);
    if (!job || job.status !== 'queued' || hasRecordedOwner(job)) return job;
    const failed: AnalysisJobRecord = {
      ...job,
      status: 'failed',
      completedAt: new Date().toISOString(),
      error: `Analysis runner launch failed: ${error}`,
    };
    await writeJob(failed);
    await clearActiveLocked(resolvedRepoPath, id);
    return failed;
  });
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

export async function claimAnalysisJobRunner(jobFile: string): Promise<AnalysisJobRecord | null> {
  const supplied = await readJobFile(jobFile).catch(() => null);
  if (!supplied) return null;
  const repoPath = path.resolve(supplied.repoPath);
  if (path.resolve(jobFile) !== jobPath(repoPath, supplied.id)) return null;

  return withActiveMutationLock(repoPath, async () => {
    const active = await readActiveSnapshotLocked(repoPath);
    if (
      active?.markerId !== supplied.id ||
      !active.job ||
      active.job.id !== supplied.id ||
      active.job.repoPath !== repoPath ||
      active.job.status !== 'queued' ||
      hasRecordedOwner(active.job) ||
      active.job.startedAt !== undefined ||
      active.job.completedAt !== undefined ||
      active.job.exitCode !== undefined ||
      active.job.signal !== undefined
    ) {
      return null;
    }

    const processStartIdentity = await readProcessStartIdentity(process.pid);
    const claimed: AnalysisJobRecord = {
      ...active.job,
      status: 'running',
      runnerPid: process.pid,
      ...(processStartIdentity ? { runnerProcessStartIdentity: processStartIdentity } : {}),
      startedAt: new Date().toISOString(),
    };
    await writeJob(claimed);
    return claimed;
  });
}

export async function claimManagedAnalysisAnalyzer(
  repoPath: string,
  context: ManagedAnalysisContext,
): Promise<AnalysisJobRecord> {
  assertValidManagedAnalysisContext(context);
  const resolvedRepoPath = path.resolve(repoPath);
  return withActiveMutationLock(resolvedRepoPath, async () => {
    const job = await requireManagedAnalysisJobLocked(resolvedRepoPath, context);
    if (!job.runnerPid || !(await isVerifiedRunnerOwner(job))) {
      throw fencedAttempt('Managed analysis runner ownership is no longer compatible.');
    }

    const processStartIdentity = await readProcessStartIdentity(process.pid);
    if (job.analyzerPid !== undefined || job.analyzerProcessStartIdentity !== undefined) {
      if (
        job.analyzerPid !== process.pid ||
        job.analyzerProcessStartIdentity !== (processStartIdentity ?? undefined)
      ) {
        throw fencedAttempt('Managed analysis analyzer ownership is already claimed.');
      }
      return job;
    }

    const claimed: AnalysisJobRecord = {
      ...job,
      analyzerPid: process.pid,
      ...(processStartIdentity ? { analyzerProcessStartIdentity: processStartIdentity } : {}),
    };
    await writeJob(claimed);
    return claimed;
  });
}

export async function beginManagedAnalysisPublication(
  repoPath: string,
  context: ManagedAnalysisContext,
): Promise<AnalysisJobRecord> {
  assertValidManagedAnalysisContext(context);
  const resolvedRepoPath = path.resolve(repoPath);
  return withActiveMutationLock(resolvedRepoPath, async () => {
    const job = await requireManagedAnalysisJobLocked(resolvedRepoPath, context);
    await requireCurrentAnalyzerOwner(job);
    if (job.publicationState === 'published') return job;
    const publishing: AnalysisJobRecord = { ...job, publicationState: 'publishing' };
    await writeJob(publishing);
    return publishing;
  });
}

export async function commitManagedAnalysisPublication(
  repoPath: string,
  context: ManagedAnalysisContext,
  generationId: string,
  sourceManifestDigest: string,
): Promise<AnalysisJobRecord> {
  assertValidManagedAnalysisContext(context);
  validateSafeIdentifier(generationId, 'Analysis generation id');
  validateSha256(sourceManifestDigest, 'Analysis publication source manifest digest');
  if (sourceManifestDigest.toLowerCase() !== context.sourceManifestDigest.toLowerCase()) {
    throw fencedAttempt(
      'Managed analysis publication source manifest does not match the submitted manifest.',
    );
  }
  const resolvedRepoPath = path.resolve(repoPath);
  return withActiveMutationLock(resolvedRepoPath, async () => {
    const job = await requireManagedAnalysisJobLocked(resolvedRepoPath, context);
    await requireCurrentAnalyzerOwner(job);
    if (job.publicationState !== 'publishing') {
      throw fencedAttempt('Managed analysis publication was not begun by the canonical analyzer.');
    }
    const published: AnalysisJobRecord = {
      ...job,
      publicationState: 'published',
      generationId,
      sourceManifestDigest,
    };
    await writeJob(published);
    return published;
  });
}

export async function cancelAnalysisJob(
  repoPath: string,
  id: string,
): Promise<AnalysisJobCancellationResult> {
  const resolvedRepoPath = path.resolve(repoPath);
  return withActiveMutationLock(resolvedRepoPath, async () => {
    const job = await readJobFile(jobPath(resolvedRepoPath, id)).catch(() => null);
    if (!job) {
      return cancellationRefusal(
        null,
        'JOB_NOT_FOUND',
        'The analysis job does not exist or is no longer available.',
      );
    }
    if (isTerminal(job.status) || job.publicationState) {
      return cancellationRefusal(
        job,
        'JOB_NOT_CANCELLABLE',
        job.publicationState
          ? 'The analysis job has begun generation publication and can no longer be cancelled.'
          : 'The analysis job is already terminal.',
      );
    }
    if (!job.runnerPid && !job.analyzerPid) {
      const cancelled: AnalysisJobRecord = {
        ...job,
        status: 'cancelled',
        completedAt: new Date().toISOString(),
        error: 'Analysis cancelled before the runner claimed the job.',
      };
      await writeJob(cancelled);
      await clearActiveLocked(resolvedRepoPath, id);
      return { job: cancelled, cancelled: true };
    }

    const runnerTarget = await verifiedCancellationTarget(
      job.runnerPid,
      job.runnerProcessStartIdentity,
    );
    if (runnerTarget.verified && job.runnerPid) {
      return signalCancellationTarget(job, job.runnerPid, false, 'runner');
    }
    const analyzerTarget = await verifiedCancellationTarget(
      job.analyzerPid,
      job.analyzerProcessStartIdentity,
    );
    if (analyzerTarget.verified && job.analyzerPid) {
      return signalCancellationTarget(job, job.analyzerPid, true, 'analyzer');
    }
    const refusal = runnerTarget.reason ?? analyzerTarget.reason ?? 'PROCESS_IDENTITY_UNAVAILABLE';
    return cancellationRefusal(
      job,
      refusal,
      refusal === 'PROCESS_IDENTITY_MISMATCH'
        ? 'Cancellation was refused because an owned PID now belongs to a different process.'
        : 'Cancellation was refused because no active process start identity can be verified on this host.',
    );
  });
}

export async function completeAnalysisJob(
  jobFile: string,
  update: AnalysisJobLifecycleUpdate,
  expectedRunner?: AnalysisJobRunnerOwner,
): Promise<AnalysisJobRecord> {
  const supplied = await readJobFile(jobFile);
  const repoPath = path.resolve(supplied.repoPath);
  if (path.resolve(jobFile) !== jobPath(repoPath, supplied.id)) {
    throw fencedAttempt('Analysis completion did not target the canonical job file.');
  }

  return withActiveMutationLock(repoPath, async () => {
    const current = await readJobFile(jobFile);
    if (isTerminal(current.status)) return current;
    if (expectedRunner) {
      const active = await readActiveSnapshotLocked(repoPath);
      if (
        active?.markerId !== current.id ||
        current.runnerPid !== expectedRunner.pid ||
        current.runnerProcessStartIdentity !== expectedRunner.processStartIdentity
      ) {
        return current;
      }
    }

    const lifecycleUpdate = Object.fromEntries(
      ANALYSIS_JOB_LIFECYCLE_FIELDS.filter((field) => Object.hasOwn(update, field)).map((field) => [
        field,
        update[field],
      ]),
    ) as AnalysisJobLifecycleUpdate;
    if (lifecycleUpdate.status === 'complete' && current.publicationState !== 'published') {
      lifecycleUpdate.status = 'failed';
      lifecycleUpdate.error =
        lifecycleUpdate.error ??
        'Analysis exited successfully without committing generation publication.';
    }
    if (lifecycleUpdate.status === 'cancelled' && current.publicationState) {
      lifecycleUpdate.status = 'failed';
      lifecycleUpdate.error =
        lifecycleUpdate.error ??
        'Analysis termination occurred after generation publication began.';
    }
    const next = { ...current, ...lifecycleUpdate };
    await writeJob(next);
    if (isTerminal(next.status) || !(await isActive(next))) {
      await clearActiveLocked(repoPath, next.id);
    }
    return next;
  });
}

async function isActive(job: AnalysisJobRecord): Promise<boolean> {
  if (job.status !== 'queued' && job.status !== 'running') return false;
  if (job.status === 'queued') return !launchDeadlineExpired(job);
  const owners = [
    ownerTuple(job.runnerPid, job.runnerProcessStartIdentity),
    ownerTuple(job.analyzerPid, job.analyzerProcessStartIdentity),
  ].filter((owner): owner is AnalysisJobRunnerOwner => owner !== null);
  if (owners.length === 0) return true;
  const states = await Promise.all(
    owners.map((owner) => processOwnerState(owner.pid, owner.processStartIdentity)),
  );
  return states.some((state) => state !== 'stale');
}

async function expireQueuedLaunchLocked(
  repoPath: string,
  job: AnalysisJobRecord,
): Promise<AnalysisJobRecord | null> {
  if (job.status !== 'queued' || hasRecordedOwner(job) || !launchDeadlineExpired(job)) return null;
  const failed: AnalysisJobRecord = {
    ...job,
    status: 'failed',
    completedAt: new Date().toISOString(),
    error: 'Analysis runner did not claim the job before the launch deadline.',
  };
  await writeJob(failed);
  await clearActiveLocked(repoPath, job.id);
  return failed;
}

function launchDeadlineExpired(job: AnalysisJobRecord): boolean {
  if (!job.launchDeadlineAt) return true;
  const deadline = Date.parse(job.launchDeadlineAt);
  return !Number.isFinite(deadline) || Date.now() >= deadline;
}

async function requireManagedAnalysisJobLocked(
  repoPath: string,
  context: ManagedAnalysisContext,
): Promise<AnalysisJobRecord> {
  const active = await readActiveSnapshotLocked(repoPath);
  const job = active?.job;
  if (
    active?.markerId !== context.jobId ||
    !job ||
    job.id !== context.jobId ||
    job.repoPath !== repoPath ||
    job.status !== 'running' ||
    job.targetHead !== context.targetHead ||
    job.optionsDigest !== context.optionsDigest ||
    job.sourceIdentity !== context.sourceIdentity ||
    job.sourceManifestDigest !== context.sourceManifestDigest ||
    !sameRequestedCapabilities(job.requestedCapabilities, context.requestedCapabilities)
  ) {
    throw fencedAttempt('Managed analysis context no longer matches the active running job.');
  }
  return job;
}

function sameRequestedCapabilities(
  left: AnalysisRequestedCapabilities | undefined,
  right: AnalysisRequestedCapabilities,
): boolean {
  return stableJson(left) === stableJson(right);
}

async function isVerifiedRunnerOwner(job: AnalysisJobRecord): Promise<boolean> {
  if (!job.runnerPid) return false;
  const state = await processOwnerState(job.runnerPid, job.runnerProcessStartIdentity);
  if (state === 'live') return true;
  return state === 'unknown' && job.runnerPid === process.ppid && isPidReachable(job.runnerPid);
}

async function requireCurrentAnalyzerOwner(job: AnalysisJobRecord): Promise<void> {
  if (!job.analyzerPid || job.analyzerPid !== process.pid) {
    throw fencedAttempt(
      'Managed analysis publication is not owned by the current analyzer process.',
    );
  }
  if (!job.analyzerProcessStartIdentity) return;
  const currentIdentity = await readProcessStartIdentity(process.pid);
  if (!currentIdentity || currentIdentity !== job.analyzerProcessStartIdentity) {
    throw fencedAttempt('Managed analysis analyzer process identity can no longer be verified.');
  }
}

function isPidReachable(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function hasRecordedOwner(job: AnalysisJobRecord): boolean {
  return (
    job.runnerPid !== undefined ||
    job.runnerProcessStartIdentity !== undefined ||
    job.analyzerPid !== undefined ||
    job.analyzerProcessStartIdentity !== undefined
  );
}

function ownerTuple(
  pid: number | undefined,
  processStartIdentity: string | undefined,
): AnalysisJobRunnerOwner | null {
  return pid === undefined ? null : { pid, processStartIdentity };
}

async function processOwnerState(
  pid: number,
  expectedIdentity: string | undefined,
): Promise<'live' | 'stale' | 'unknown'> {
  try {
    process.kill(pid, 0);
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === 'EPERM') return 'unknown';
    return 'stale';
  }
  if (!expectedIdentity) return 'unknown';
  const currentIdentity = await readProcessStartIdentity(pid);
  if (!currentIdentity) return 'unknown';
  return currentIdentity === expectedIdentity ? 'live' : 'stale';
}

async function verifiedCancellationTarget(
  pid: number | undefined,
  expectedIdentity: string | undefined,
): Promise<{
  verified: boolean;
  reason?: Extract<
    AnalysisJobCancellationRefusalReason,
    'PROCESS_IDENTITY_UNAVAILABLE' | 'PROCESS_IDENTITY_MISMATCH'
  >;
}> {
  if (pid === undefined) return { verified: false };
  if (!expectedIdentity) {
    return { verified: false, reason: 'PROCESS_IDENTITY_UNAVAILABLE' };
  }
  try {
    process.kill(pid, 0);
  } catch {
    return { verified: false, reason: 'PROCESS_IDENTITY_UNAVAILABLE' };
  }
  const currentIdentity = await readProcessStartIdentity(pid);
  if (!currentIdentity) {
    return { verified: false, reason: 'PROCESS_IDENTITY_UNAVAILABLE' };
  }
  if (currentIdentity !== expectedIdentity) {
    return { verified: false, reason: 'PROCESS_IDENTITY_MISMATCH' };
  }
  return { verified: true };
}

async function signalCancellationTarget(
  job: AnalysisJobRecord,
  pid: number,
  signalProcessGroup: boolean,
  ownerLabel: 'runner' | 'analyzer',
): Promise<AnalysisJobCancellationResult> {
  try {
    process.kill(signalProcessGroup && process.platform !== 'win32' ? -pid : pid, 'SIGTERM');
    return { job, cancelled: true };
  } catch {
    return cancellationRefusal(
      job,
      'SIGNAL_FAILED',
      `The ${ownerLabel} identity was verified, but the cancellation signal could not be delivered.`,
    );
  }
}

function fencedAttempt(message: string): ManagedAnalysisFencedAttemptError {
  return new ManagedAnalysisFencedAttemptError(message);
}

async function readJobFile(file: string): Promise<AnalysisJobRecord> {
  return JSON.parse(await fs.readFile(file, 'utf8')) as AnalysisJobRecord;
}

async function readActiveSnapshotLocked(repoPath: string): Promise<ActiveJobSnapshot | null> {
  const rawMarker = await fs.readFile(activePath(repoPath), 'utf8').catch((error: unknown) => {
    if (isNodeError(error) && error.code === 'ENOENT') return null;
    throw error;
  });
  if (rawMarker === null) return null;
  const markerId = rawMarker.trim();
  if (!/^[0-9a-f-]+$/i.test(markerId)) return { markerId, job: null };
  const job = await fs
    .readFile(jobPath(repoPath, markerId), 'utf8')
    .then((value) => JSON.parse(value) as AnalysisJobRecord)
    .catch(() => null);
  return { markerId, job };
}

async function clearActiveLocked(repoPath: string, expectedId: string): Promise<void> {
  const current = await fs.readFile(activePath(repoPath), 'utf8').catch((error: unknown) => {
    if (isNodeError(error) && error.code === 'ENOENT') return null;
    throw error;
  });
  if (current === null || current.trim() !== expectedId) return;
  await fs.rm(activePath(repoPath), { force: true });
}

async function withActiveMutationLock<T>(repoPath: string, callback: () => Promise<T>): Promise<T> {
  const lockPath = activeMutationLockPath(repoPath);
  const token = randomUUID();
  const processStartIdentity = await readProcessStartIdentity(process.pid);
  await acquireActiveMutationLock(lockPath, repoPath, token, processStartIdentity);
  try {
    return await callback();
  } finally {
    await releaseActiveMutationLock(lockPath, token, processStartIdentity);
  }
}

async function acquireActiveMutationLock(
  lockPath: string,
  repoPath: string,
  token: string,
  processStartIdentity: string | null,
): Promise<void> {
  const recoveryPath = `${lockPath}.recovery`;
  await fs.mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < ACTIVE_MUTATION_LOCK_MAX_ATTEMPTS; attempt += 1) {
    if (await hasActiveRecoveryClaim(recoveryPath)) {
      if (attempt + 1 < ACTIVE_MUTATION_LOCK_MAX_ATTEMPTS) {
        await delay(ACTIVE_MUTATION_LOCK_RETRY_DELAY_MS);
        continue;
      }
      break;
    }
    const recovery = await readActiveMutationLock(recoveryPath);
    if (recovery) {
      const recoveryOwnerActive = await isActiveMutationLockOwnerActive(recovery);
      if (recoveryOwnerActive === false) {
        if (await reclaimStaleRecoveryOwner(recoveryPath, recovery, processStartIdentity)) {
          continue;
        }
      } else if (recoveryOwnerActive === null) {
        throw new Error(`Cannot safely validate analysis lock recovery owner: ${recoveryPath}`);
      }
      if (attempt + 1 < ACTIVE_MUTATION_LOCK_MAX_ATTEMPTS) {
        await delay(ACTIVE_MUTATION_LOCK_RETRY_DELAY_MS);
        continue;
      }
      break;
    }
    if (await pathExists(recoveryPath)) {
      throw new Error(
        `Cannot safely recover malformed analysis lock recovery owner: ${recoveryPath}`,
      );
    }
    if (await hasActiveRecoveryClaim(recoveryPath)) continue;

    try {
      await createActiveMutationLock(lockPath, repoPath, token, processStartIdentity);
      return;
    } catch (error: unknown) {
      if (!isNodeError(error) || error.code !== 'EEXIST') throw error;
    }

    const existing = await readActiveMutationLock(lockPath);
    if (!existing) {
      if (!(await pathExists(lockPath))) {
        await delay(ACTIVE_MUTATION_LOCK_RETRY_DELAY_MS);
        continue;
      }
      throw new Error(`Cannot safely recover malformed analysis active mutation lock: ${lockPath}`);
    }
    const ownerActive = await isActiveMutationLockOwnerActive(existing);
    if (ownerActive === false) {
      const recoveryToken = randomUUID();
      let recoveryAcquired = false;
      try {
        await createActiveMutationLock(recoveryPath, repoPath, recoveryToken, processStartIdentity);
        recoveryAcquired = true;
      } catch (error: unknown) {
        if (!isNodeError(error) || error.code !== 'EEXIST') throw error;
      }
      if (recoveryAcquired) {
        try {
          const current = await readActiveMutationLock(lockPath);
          if (!current) {
            if (await pathExists(lockPath)) {
              throw new Error(
                `Cannot safely recover malformed analysis active mutation lock: ${lockPath}`,
              );
            }
            await createActiveMutationLock(lockPath, repoPath, token, processStartIdentity);
            return;
          }
          const currentOwnerActive = await isActiveMutationLockOwnerActive(current);
          if (currentOwnerActive === null) {
            throw new Error(`Cannot safely recover analysis active mutation lock: ${lockPath}`);
          }
          if (currentOwnerActive === true) continue;
          if (!(await removeActiveMutationLockIfOwner(lockPath, current))) {
            throw new Error(`Cannot safely recover analysis active mutation lock: ${lockPath}`);
          }
          await createActiveMutationLock(lockPath, repoPath, token, processStartIdentity);
          return;
        } finally {
          await releaseActiveMutationLock(recoveryPath, recoveryToken, processStartIdentity);
        }
      }
    } else if (ownerActive === null) {
      throw new Error(`Cannot safely validate analysis active mutation lock: ${lockPath}`);
    }

    if (attempt + 1 < ACTIVE_MUTATION_LOCK_MAX_ATTEMPTS) {
      await delay(ACTIVE_MUTATION_LOCK_RETRY_DELAY_MS);
    }
  }
  throw new Error(`Timed out acquiring analysis active mutation lock: ${lockPath}`);
}

async function createActiveMutationLock(
  lockPath: string,
  repoPath: string,
  token: string,
  processStartIdentity: string | null,
): Promise<void> {
  const record: ActiveMutationLockRecord = {
    version: 1,
    token,
    pid: process.pid,
    processStartIdentity: processStartIdentity ?? '',
    acquiredAt: new Date().toISOString(),
    repoPath,
  };
  const tempPath = `${lockPath}.${process.pid}.${token}.tmp`;
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(tempPath, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf8' });
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.link(tempPath, lockPath);
  } finally {
    await handle?.close().catch(() => {});
    await fs.rm(tempPath, { force: true }).catch(() => {});
  }
}

async function releaseActiveMutationLock(
  lockPath: string,
  token: string,
  processStartIdentity: string | null,
): Promise<void> {
  const current = await readActiveMutationLock(lockPath);
  if (
    !current ||
    current.token !== token ||
    current.pid !== process.pid ||
    current.processStartIdentity !== (processStartIdentity ?? '')
  ) {
    return;
  }
  await removeActiveMutationLockIfOwner(lockPath, current);
}

async function removeActiveMutationLockIfOwner(
  lockPath: string,
  expected: ActiveMutationLockRecord,
): Promise<boolean> {
  const current = await readActiveMutationLock(lockPath);
  if (
    !current ||
    current.token !== expected.token ||
    current.pid !== expected.pid ||
    current.processStartIdentity !== expected.processStartIdentity
  ) {
    return false;
  }
  await fs.rm(lockPath, { force: true });
  return true;
}

async function reclaimStaleRecoveryOwner(
  recoveryPath: string,
  expected: ActiveMutationLockRecord,
  processStartIdentity: string | null,
): Promise<boolean> {
  const claimPath = `${recoveryPath}.claim.${process.pid}.${encodeRecoveryClaimIdentity(processStartIdentity)}.${randomUUID()}`;
  try {
    await fs.rename(recoveryPath, claimPath);
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === 'ENOENT') return false;
    throw error;
  }

  const claimed = await readActiveMutationLock(claimPath);
  if (!claimed) {
    throw new Error(`Cannot safely recover malformed analysis lock recovery claim: ${claimPath}`);
  }
  if (!sameActiveMutationLockOwner(claimed, expected)) {
    try {
      await fs.link(claimPath, recoveryPath);
    } catch (error: unknown) {
      if (!isNodeError(error) || error.code !== 'EEXIST') throw error;
    }
    await fs.rm(claimPath, { force: true });
    return false;
  }
  await fs.rm(claimPath, { force: true });
  return true;
}

async function hasActiveRecoveryClaim(recoveryPath: string): Promise<boolean> {
  const directory = path.dirname(recoveryPath);
  const prefix = `${path.basename(recoveryPath)}.claim.`;
  const entries = await fs.readdir(directory).catch((error: unknown) => {
    if (isNodeError(error) && error.code === 'ENOENT') return [];
    throw error;
  });
  for (const entry of entries) {
    if (!entry.startsWith(prefix)) continue;
    const claimPath = path.join(directory, entry);
    const claim = await readActiveMutationLock(claimPath);
    if (!claim) {
      throw new Error(`Cannot safely recover malformed analysis lock recovery claim: ${claimPath}`);
    }
    const claimOwner = parseRecoveryClaimOwner(entry, prefix);
    if (!claimOwner) {
      throw new Error(`Cannot safely validate analysis lock recovery claim owner: ${claimPath}`);
    }
    const ownerActive = await isActiveMutationLockOwnerActive(claimOwner);
    if (ownerActive === false) {
      await fs.rm(claimPath, { force: true });
      continue;
    }
    if (ownerActive === null) {
      throw new Error(`Cannot safely validate analysis lock recovery claim: ${claimPath}`);
    }
    return true;
  }
  return false;
}

function encodeRecoveryClaimIdentity(processStartIdentity: string | null): string {
  return processStartIdentity
    ? Buffer.from(processStartIdentity, 'utf8').toString('hex')
    : 'unavailable';
}

function parseRecoveryClaimOwner(entry: string, prefix: string): ActiveMutationLockRecord | null {
  const [pidRaw, identityRaw, token] = entry.slice(prefix.length).split('.', 3);
  const pid = Number(pidRaw);
  if (!Number.isSafeInteger(pid) || pid <= 0 || !identityRaw || !token) return null;
  let processStartIdentity = '';
  if (identityRaw !== 'unavailable') {
    if (!/^(?:[0-9a-f]{2})+$/i.test(identityRaw)) return null;
    processStartIdentity = Buffer.from(identityRaw, 'hex').toString('utf8');
    if (!processStartIdentity) return null;
  }
  return {
    version: 1,
    token,
    pid,
    processStartIdentity,
    acquiredAt: '',
    repoPath: '',
  };
}

function sameActiveMutationLockOwner(
  left: ActiveMutationLockRecord,
  right: ActiveMutationLockRecord,
): boolean {
  return (
    left.token === right.token &&
    left.pid === right.pid &&
    left.processStartIdentity === right.processStartIdentity
  );
}

async function readActiveMutationLock(lockPath: string): Promise<ActiveMutationLockRecord | null> {
  const raw = await fs.readFile(lockPath, 'utf8').catch((error: unknown) => {
    if (isNodeError(error) && error.code === 'ENOENT') return null;
    throw error;
  });
  if (raw === null) return null;
  try {
    const value = JSON.parse(raw) as Partial<ActiveMutationLockRecord>;
    if (
      value.version !== 1 ||
      typeof value.token !== 'string' ||
      typeof value.pid !== 'number' ||
      !Number.isSafeInteger(value.pid) ||
      value.pid <= 0 ||
      typeof value.processStartIdentity !== 'string' ||
      typeof value.acquiredAt !== 'string' ||
      typeof value.repoPath !== 'string'
    ) {
      return null;
    }
    return value as ActiveMutationLockRecord;
  } catch {
    return null;
  }
}

async function isActiveMutationLockOwnerActive(
  record: ActiveMutationLockRecord,
): Promise<boolean | null> {
  try {
    process.kill(record.pid, 0);
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === 'EPERM') return null;
    return false;
  }
  if (!record.processStartIdentity) return true;
  const currentIdentity = await readProcessStartIdentity(record.pid);
  if (!currentIdentity) return null;
  return currentIdentity === record.processStartIdentity;
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

function activeMutationLockPath(repoPath: string): string {
  return path.join(jobsDir(repoPath), 'active.mutation.lock');
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

function validateRequestedCapabilities(requestedCapabilities: AnalysisRequestedCapabilities): void {
  const graphCapabilities = requestedCapabilities.graphCapabilities;
  if (
    requestedCapabilities.version !== ANALYSIS_REQUESTED_CAPABILITIES_VERSION ||
    requestedCapabilities.graph !== true ||
    !Array.isArray(graphCapabilities) ||
    graphCapabilities.length === 0 ||
    graphCapabilities.some(
      (capability) =>
        capability !== 'symbols' && capability !== 'impact' && capability !== 'processes',
    ) ||
    graphCapabilities.some((capability, index) =>
      index > 0 ? graphCapabilities[index - 1].localeCompare(capability) >= 0 : false,
    ) ||
    typeof requestedCapabilities.embeddings !== 'boolean' ||
    (requestedCapabilities.embeddings
      ? typeof requestedCapabilities.embeddingModelHash !== 'string' ||
        requestedCapabilities.embeddingModelHash.trim().length === 0
      : requestedCapabilities.embeddingModelHash !== null)
  ) {
    throw new Error('Invalid requested analysis capabilities.');
  }
}

function validateSha256(value: unknown, fieldName: string): asserts value is string {
  if (typeof value !== 'string' || !/^[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`${fieldName} must be a SHA-256 digest.`);
  }
}

function validateSafeIdentifier(value: unknown, fieldName: string): asserts value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw new Error(`${fieldName} is malformed.`);
  }
}

function validateTargetHead(targetHead: unknown): asserts targetHead is string {
  if (typeof targetHead !== 'string' || !/^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/.test(targetHead)) {
    throw new Error('Analysis target HEAD must be a 40- or 64-character git object identity.');
  }
}

function validateSourceIdentity(
  sourceIdentity: unknown,
  targetHead: string,
  sourceManifestDigest: string,
): asserts sourceIdentity is string {
  if (!isValidSourceIdentity(sourceIdentity, targetHead, sourceManifestDigest)) {
    throw new Error(
      'Analysis source identity must match the requested target HEAD or the analyzed source manifest.',
    );
  }
}

function isCompatibleActiveRequest(
  active: AnalysisJobRecord,
  targetHead: string,
  optionsDigest: string,
  requestedCapabilities: AnalysisRequestedCapabilities,
  sourceIdentity: string,
  sourceManifestDigest: string,
): boolean {
  return (
    active.sourceIdentity === sourceIdentity &&
    active.sourceManifestDigest === sourceManifestDigest &&
    active.targetHead === targetHead &&
    active.optionsDigest === optionsDigest &&
    sameRequestedCapabilities(active.requestedCapabilities, requestedCapabilities)
  );
}

function cancellationRefusal(
  job: AnalysisJobRecord | null,
  reasonCode: AnalysisJobCancellationRefusalReason,
  message: string,
): AnalysisJobCancellationResult {
  return { job, cancelled: false, refusal: { reasonCode, message } };
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function pathExists(filePath: string): Promise<boolean> {
  return fs.stat(filePath).then(
    () => true,
    () => false,
  );
}
