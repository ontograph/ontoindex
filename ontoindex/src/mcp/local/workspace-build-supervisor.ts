import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

export class WorkspaceBuildError extends Error {
  constructor(
    public readonly kind: 'timeout' | 'failed' | 'unstoppable',
    message: string,
  ) {
    super(message);
    this.name = 'WorkspaceBuildError';
  }
}

export interface SupervisedBuild {
  command: string;
  args: string[];
  cwd: string;
  /** Repository storage directory that owns `overlay/` and `workspace-inputs/`. */
  storagePath: string;
  timeoutMs: number;
  /** How long to wait for the killed process group to disappear. */
  reapMs?: number;
}

const STDERR_TAIL_BYTES = 4096;
const OWNED_DIRECTORIES = ['overlay', 'workspace-inputs'];

async function listEntries(directory: string): Promise<Set<string>> {
  try {
    return new Set(await fs.readdir(directory));
  } catch {
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
    await fs.readFile(path.join(storagePath, 'overlay', 'CURRENT'), 'utf8').catch(() => '')
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

function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
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
  const before = await snapshotArtifacts(options.storagePath);
  const child = spawn(options.command, options.args, {
    cwd: options.cwd,
    detached: true,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderrTail = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString('utf8')).slice(-STDERR_TAIL_BYTES);
  });
  const pid = child.pid;
  const outcome = await new Promise<{ code: number | null; timedOut: boolean; error?: Error }>(
    (resolve) => {
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
        resolve({ code: null, timedOut, error });
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        resolve({ code, timedOut });
      });
    },
  );
  // Kill stragglers (for example a grandchild) even after a normal exit.
  if (pid && groupAlive(pid)) {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
  if (pid && !(await waitForGroupExit(pid, options.reapMs ?? 5000))) {
    throw new WorkspaceBuildError('unstoppable', 'Workspace build process group did not stop.');
  }
  if (outcome.error) throw new WorkspaceBuildError('failed', outcome.error.message);
  if (outcome.timedOut) {
    await removeNewArtifacts(options.storagePath, before).catch(() => {});
    throw new WorkspaceBuildError(
      'timeout',
      `Workspace graph build exceeded ${options.timeoutMs} ms and was stopped.`,
    );
  }
  if (outcome.code !== 0) {
    await removeNewArtifacts(options.storagePath, before).catch(() => {});
    throw new WorkspaceBuildError(
      'failed',
      `Workspace graph build exited with code ${outcome.code}${stderrTail ? `: ${stderrTail.trim()}` : ''}`,
    );
  }
}
