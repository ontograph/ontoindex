import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

export const WORKSPACE_INPUT_REFUSED_EXIT_CODE = 3;

export function workspaceBuildExitCode(error: unknown): number {
  return typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    error.name === 'WorkspaceInputCaptureError' &&
    'code' in error &&
    (error.code === 'limit' || error.code === 'unsupported')
    ? WORKSPACE_INPUT_REFUSED_EXIT_CODE
    : 1;
}

export class WorkspaceBuildError extends Error {
  constructor(
    public readonly kind: 'timeout' | 'cancelled' | 'failed' | 'unstoppable' | 'input_refused',
    message: string,
    options?: ErrorOptions,
    public readonly termination?: { exitCode: number | null; signal: NodeJS.Signals | null },
  ) {
    super(message, options);
    this.name = 'WorkspaceBuildError';
  }
}

export interface SupervisedBuild {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /** Repository storage directory that owns `overlay/` and `workspace-inputs/`. */
  storagePath: string;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Observe the child PID after its owner identity and lifecycle handlers are installed. */
  onSpawn?: (pid: number) => void;
  /** How long to wait for the killed process group to disappear. */
  reapMs?: number;
  /**
   * Retry once, within the same deadline, when the child dies from a native crash signal. The
   * failed attempt is reaped and its artifacts removed before the retry starts.
   */
  retryNativeCrash?: boolean;
}

const STDERR_TAIL_BYTES = 4096;
const OWNER_MARKER = 'workspace-build.owner.json';
const NATIVE_CRASH_SIGNALS = new Set<NodeJS.Signals | null>(['SIGABRT', 'SIGSEGV', 'SIGBUS']);

interface OwnerMarker {
  parentPid: number;
  childPid?: number;
  state?: 'quarantined';
  /** Entries that existed before the build started; everything else is the build's own. */
  before: Record<string, string[]>;
}
const OWNED_DIRECTORIES = ['overlay', 'workspace-inputs'];

async function listEntries(directory: string): Promise<Set<string>> {
  try {
    return new Set(await fs.readdir(directory));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return new Set();
  }
}

async function snapshotArtifacts(storagePath: string): Promise<Map<string, Set<string>>> {
  const snapshot = new Map<string, Set<string>>();
  for (const name of OWNED_DIRECTORIES) {
    snapshot.set(name, await listEntries(path.join(storagePath, name)));
  }
  return snapshot;
}

/** Remove what an interrupted build left behind; never the generation that became current. */
async function removeNewArtifacts(
  storagePath: string,
  before: Map<string, Set<string>>,
): Promise<void> {
  const current = (
    await fs.readFile(path.join(storagePath, 'overlay', 'CURRENT'), 'utf8').catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return '';
    })
  ).trim();
  for (const name of OWNED_DIRECTORIES) {
    const known = before.get(name) ?? new Set<string>();
    for (const entry of await listEntries(path.join(storagePath, name))) {
      if (known.has(entry) || (name === 'overlay' && (entry === current || entry === 'CURRENT')))
        continue;
      await fs.rm(path.join(storagePath, name, entry), { recursive: true, force: true });
    }
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

async function readOwnerMarker(storagePath: string): Promise<OwnerMarker | null> {
  const markerPath = path.join(storagePath, OWNER_MARKER);
  try {
    if (!(await fs.lstat(markerPath)).isFile()) throw new Error('Owner marker is not a file.');
    const marker = JSON.parse(await fs.readFile(markerPath, 'utf8'));
    const validPid = (pid: unknown) =>
      Number.isInteger(pid) && Number(pid) > 0 && Number(pid) <= 2_147_483_647;
    if (
      !marker ||
      typeof marker !== 'object' ||
      Array.isArray(marker) ||
      !validPid(marker.parentPid) ||
      (marker.childPid !== undefined && !validPid(marker.childPid)) ||
      (marker.state !== undefined && marker.state !== 'quarantined') ||
      (marker.state === 'quarantined' && marker.childPid === undefined) ||
      !marker.before ||
      typeof marker.before !== 'object' ||
      Array.isArray(marker.before) ||
      Object.keys(marker.before).length !== OWNED_DIRECTORIES.length ||
      !OWNED_DIRECTORIES.every(
        (name) =>
          Array.isArray(marker.before[name]) &&
          marker.before[name].every(
            (entry: unknown) =>
              typeof entry === 'string' &&
              entry.length > 0 &&
              entry !== '.' &&
              entry !== '..' &&
              !/[\\/\0]/.test(entry),
          ),
      )
    )
      throw new Error('Invalid owner identity or incomplete artifact snapshot.');
    return marker as OwnerMarker;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(`Cannot safely recover workspace build. Inspect owner marker: ${markerPath}`, {
      cause: error,
    });
  }
}

/**
 * Remove what a build left behind when its server died. Call only while holding the analyze lock.
 * The marker names the dead owner and the entries that predate the build, so nothing else is
 * touched. A live owner or a surviving child group means we cannot prove the build stopped.
 */
export async function sweepOrphanedWorkspaceBuild(storagePath: string): Promise<boolean> {
  const markerPath = path.join(storagePath, OWNER_MARKER);
  const marker = await readOwnerMarker(storagePath);
  if (!marker) return false;
  if (
    (marker.state !== 'quarantined' && pidAlive(marker.parentPid)) ||
    (marker.childPid !== undefined && groupAlive(marker.childPid))
  ) {
    return false;
  }
  await removeNewArtifacts(
    storagePath,
    new Map(Object.entries(marker.before).map(([name, list]) => [name, new Set(list)])),
  );
  await fs.rm(markerPath, { force: true });
  return true;
}

/** Check only while holding the shared analyze lock, before admitting any writer. */
export async function assertWorkspaceBuildAdmission(storagePath: string): Promise<void> {
  await sweepOrphanedWorkspaceBuild(storagePath);
  if (await readOwnerMarker(storagePath)) {
    throw new Error(
      `Cannot safely recover workspace build. Owner is unresolved; retry after it stops. Marker: ${path.join(storagePath, OWNER_MARKER)}`,
    );
  }
}

function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

async function waitForGroupExit(pid: number, limitMs: number): Promise<boolean> {
  const stop = Date.now() + limitMs;
  while (groupAlive(pid) && Date.now() < stop) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return !groupAlive(pid);
}

/**
 * Run a build in its own process group with a hard deadline. On timeout or failure the whole group
 * is killed and reaped before this returns, so the caller can safely release the analyze lock.
 */
export async function superviseWorkspaceBuild(options: SupervisedBuild): Promise<void> {
  if (options.signal?.aborted)
    throw new WorkspaceBuildError('cancelled', 'Workspace graph build was cancelled.');
  await assertWorkspaceBuildAdmission(options.storagePath);
  const before = await snapshotArtifacts(options.storagePath);
  const markerPath = path.join(options.storagePath, OWNER_MARKER);
  const writeMarker = (childPid?: number, state?: 'quarantined') =>
    fs.writeFile(
      markerPath,
      JSON.stringify({
        parentPid: process.pid,
        childPid,
        ...(state ? { state } : {}),
        before: Object.fromEntries([...before].map(([name, set]) => [name, [...set]])),
      } satisfies OwnerMarker),
    );
  await writeMarker();
  const deadline = Date.now() + options.timeoutMs;
  for (let attempt = 0; ; attempt++) {
    try {
      await runSupervised(
        attempt === 0 ? options : { ...options, timeoutMs: deadline - Date.now() },
        before,
        writeMarker,
      );
      break;
    } catch (error) {
      if (!(error instanceof WorkspaceBuildError) || error.kind === 'unstoppable') throw error;
      if (
        options.retryNativeCrash &&
        attempt === 0 &&
        error.kind === 'failed' &&
        NATIVE_CRASH_SIGNALS.has(error.termination?.signal ?? null) &&
        !options.signal?.aborted &&
        deadline - Date.now() > 0
      ) {
        // runSupervised already reaped the group and removed this attempt's artifacts.
        continue;
      }
      await fs.rm(markerPath, { force: true });
      throw error;
    }
  }
  await fs.rm(markerPath, { force: true });
}

async function runSupervised(
  options: SupervisedBuild,
  before: Map<string, Set<string>>,
  writeMarker: (childPid?: number, state?: 'quarantined') => Promise<void>,
): Promise<void> {
  if (options.signal?.aborted)
    throw new WorkspaceBuildError('cancelled', 'Workspace graph build was cancelled.');
  const child = spawn(options.command, options.args, {
    cwd: options.cwd,
    env: options.env ? { ...process.env, ...options.env } : process.env,
    detached: true,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderrTail = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString('utf8')).slice(-STDERR_TAIL_BYTES);
  });
  const pid = child.pid;
  let cancelled = false;
  let escalationTimer: ReturnType<typeof setTimeout> | undefined;
  const abort = () => {
    cancelled = true;
    try {
      if (pid) process.kill(-pid, 'SIGTERM');
    } catch {
      /* Already gone. */
    }
    if (pid) {
      escalationTimer = setTimeout(() => {
        try {
          if (groupAlive(pid)) process.kill(-pid, 'SIGKILL');
        } catch {
          /* Already gone. */
        }
      }, 2000);
    }
  };
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) abort();
  const exited = new Promise<{
    code: number | null;
    signal?: NodeJS.Signals | null;
    timedOut: boolean;
    error?: Error;
  }>((resolve) => {
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (pid) process.kill(-pid, 'SIGKILL');
      } catch {
        // The group already exited.
      }
    }, options.timeoutMs);
    child.once('error', (error) => {
      clearTimeout(timer);
      clearTimeout(escalationTimer);
      options.signal?.removeEventListener('abort', abort);
      resolve({ code: null, timedOut, error });
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      clearTimeout(escalationTimer);
      options.signal?.removeEventListener('abort', abort);
      resolve({ code, signal, timedOut });
    });
  });
  let publicationError: unknown;
  let observerFailure: { cause: unknown } | undefined;
  let ownerPublished = false;
  if (pid) {
    try {
      await writeMarker(pid);
      ownerPublished = true;
    } catch (error) {
      publicationError = error;
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        /* Already gone. */
      }
    }
    if (ownerPublished) {
      try {
        options.onSpawn?.(pid);
      } catch (cause) {
        observerFailure = { cause };
        try {
          process.kill(-pid, 'SIGKILL');
        } catch {
          /* Already gone. */
        }
      }
    }
  }
  const outcome = await exited;
  // Kill stragglers (for example a grandchild) even after a normal exit.
  if (pid && groupAlive(pid)) {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
  if (pid && !(await waitForGroupExit(pid, options.reapMs ?? 5000))) {
    // Keep the published identity even if quarantine publication itself fails.
    if (!publicationError) await writeMarker(pid, 'quarantined').catch(() => {});
    throw new WorkspaceBuildError('unstoppable', 'Workspace build process group did not stop.');
  }
  if (publicationError) {
    throw new WorkspaceBuildError(
      'unstoppable',
      `Workspace build owner identity could not be recorded. Inspect ${path.join(options.storagePath, OWNER_MARKER)} before retrying.`,
    );
  }
  if (observerFailure) {
    await removeNewArtifacts(options.storagePath, before);
    throw new WorkspaceBuildError('failed', 'Workspace build spawn observer failed.', {
      cause: observerFailure.cause,
    });
  }
  if (cancelled) {
    await removeNewArtifacts(options.storagePath, before);
    throw new WorkspaceBuildError('cancelled', 'Workspace graph build was cancelled and stopped.');
  }
  if (outcome.error) {
    throw new WorkspaceBuildError('failed', outcome.error.message, { cause: outcome.error });
  }
  if (outcome.timedOut) {
    await removeNewArtifacts(options.storagePath, before);
    throw new WorkspaceBuildError(
      'timeout',
      `Workspace graph build exceeded ${options.timeoutMs} ms and was stopped.`,
    );
  }
  if (outcome.code !== 0) {
    await removeNewArtifacts(options.storagePath, before);
    const message = outcome.signal
      ? `Workspace graph build was terminated by signal ${outcome.signal}`
      : `Workspace graph build exited with code ${outcome.code}`;
    throw new WorkspaceBuildError(
      !outcome.signal && outcome.code === WORKSPACE_INPUT_REFUSED_EXIT_CODE
        ? 'input_refused'
        : 'failed',
      `${message}${stderrTail ? `: ${stderrTail.trim()}` : ''}`,
      undefined,
      { exitCode: outcome.code, signal: outcome.signal ?? null },
    );
  }
}
