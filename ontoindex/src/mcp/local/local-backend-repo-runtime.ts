import fs from 'fs/promises';
import syncFs from 'node:fs';
import path from 'path';
import { RepoHandle } from 'ontoindex-shared';
import { resolveActiveIndexGeneration } from '../../storage/repo-manager.js';
import { readActiveGenerationMeta } from '../../storage/repo-manager.js';
import {
  evictOverlayState,
  getOverlaySnapshot,
  isResolverConfigPath,
  selectWorkspaceCapability,
  type OverlaySnapshot,
} from './backend-overlay.js';

export interface WorkspaceReadRepo {
  id: string;
  repoPath: string;
  storagePath: string;
}

export interface WorkspacePreparationDependencies {
  getSnapshot(repo: WorkspaceReadRepo): Promise<OverlaySnapshot>;
  acquireLock(repoPath: string): Promise<{ release(): Promise<void> }>;
  buildWorkspaceGraph(repoPath: string, signal?: AbortSignal): Promise<void>;
  evictSnapshot(repoId: string): void;
  /** Committed-index file count, used to refuse builds that cost too much. */
  baseFileCount(repo: WorkspaceReadRepo): Promise<number | undefined>;
  now(): number;
}

export class WorkspacePreparationError extends Error {
  constructor(
    public readonly code:
      | 'workspace_busy'
      | 'workspace_build_failed'
      | 'workspace_too_large'
      | 'workspace_timeout'
      | 'workspace_cancelled',
    message: string = code,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'WorkspacePreparationError';
  }
}

const workspaceDependencies: WorkspacePreparationDependencies = {
  getSnapshot: getOverlaySnapshot,
  acquireLock: async (repoPath) =>
    (await import('../../cli/analyze.js')).acquireAnalyzeLock(repoPath),
  buildWorkspaceGraph: async (repoPath) => {
    const { runFullAnalysis } = await import('../../core/run-analyze.js');
    await runFullAnalysis(
      repoPath,
      { workspaceGraph: true, skipNativeClose: true },
      { onProgress() {} },
    );
  },
  evictSnapshot: evictOverlayState,
  baseFileCount: async (repo) =>
    (await readActiveGenerationMeta(repo.storagePath)).meta?.stats?.files,
  now: () => Date.now(),
};

/** Measured: 1.3k files ~ 47 s and 1.9 GiB; cost grows with file count. */
const DEFAULT_MAX_WORKSPACE_FILES = 2500;
const FAILED_BUILD_COOLDOWN_MS = 30_000;
const failedBuilds = new Map<string, { identity: string; until: number; message: string }>();

export function resetWorkspaceBuildFailures(): void {
  failedBuilds.clear();
}

/**
 * Tools that read the committed graph directly (super-tools, facade audit aliases) do not use the
 * workspace generation. Say so, instead of letting them look consistent with context/impact.
 */
export async function committedGraphNotice(
  repo: WorkspaceReadRepo,
  getSnapshot: WorkspacePreparationDependencies['getSnapshot'] = getOverlaySnapshot,
): Promise<string | undefined> {
  if (process.env.ONTOINDEX_AUTO_WORKSPACE !== '1') return undefined;
  try {
    const snapshot = await getSnapshot(repo);
    if (snapshot.dirtyPaths.size === 0) return undefined;
    return `This tool reads the committed index and does not include ${snapshot.dirtyPaths.size} uncommitted file change(s); use context, impact or query for the working tree.`;
  } catch {
    return undefined;
  }
}

interface WorkspaceBuild {
  identity: string;
  promise: Promise<OverlaySnapshot>;
  pending?: {
    identity: string;
    run: () => Promise<OverlaySnapshot>;
    promise: Promise<OverlaySnapshot>;
    resolve: (value: OverlaySnapshot) => void;
    reject: (error: unknown) => void;
  };
}
const workspaceBuilds = new Map<string, WorkspaceBuild>();

function workspaceBuild(
  repoId: string,
  identity: string,
  run: () => Promise<OverlaySnapshot>,
): Promise<OverlaySnapshot> {
  const current = workspaceBuilds.get(repoId);
  if (current) {
    if (current.identity === identity && !current.pending) return current.promise;
    if (!current.pending) {
      let resolve!: (value: OverlaySnapshot) => void;
      let reject!: (error: unknown) => void;
      const promise = new Promise<OverlaySnapshot>((yes, no) => {
        resolve = yes;
        reject = no;
      });
      void promise.catch(() => {});
      current.pending = { identity, run, promise, resolve, reject };
    } else {
      current.pending.run = run;
      current.pending.identity = identity;
    }
    return current.pending.promise;
  }
  const state: WorkspaceBuild = { identity, promise: Promise.resolve().then(run) };
  workspaceBuilds.set(repoId, state);
  const settle = () => {
    workspaceBuilds.delete(repoId);
    if (state.pending) {
      const pending = state.pending;
      workspaceBuild(repoId, pending.identity, pending.run).then(pending.resolve, pending.reject);
    }
  };
  state.promise = state.promise.then(
    (value) => {
      settle();
      return value;
    },
    (error) => {
      settle();
      throw error;
    },
  );
  void state.promise.catch(() => {});
  return state.promise;
}

export async function prepareWorkspaceRead(options: {
  repo: WorkspaceReadRepo;
  needsRelationships: boolean;
  /** Build the working-tree graph even when no relationships are needed; failure degrades. */
  wantsWorkspaceGraph?: boolean;
  signal?: AbortSignal;
  deadline?: number;
  dependencies?: Partial<WorkspacePreparationDependencies>;
}): Promise<OverlaySnapshot> {
  const dependencies = { ...workspaceDependencies, ...options.dependencies };
  if (process.env.ONTOINDEX_AUTO_WORKSPACE !== '1') return dependencies.getSnapshot(options.repo);
  const deadline = Math.min(options.deadline ?? Infinity, performance.now() + 60_000);
  if (options.signal?.aborted) throw new WorkspacePreparationError('workspace_cancelled');
  if (!(deadline > performance.now())) throw new WorkspacePreparationError('workspace_timeout');
  // Bound the entire preparation, including the initial snapshot probe, per caller.
  const work = async (onSnapshot: (snapshot: OverlaySnapshot) => void) => {
    const snapshot = await dependencies.getSnapshot(options.repo);
    onSnapshot(snapshot);
    if (snapshot.dirtyPaths.size === 0) return snapshot;
    const activeBaseChanged = snapshot.reason?.includes('active base') ?? false;
    const decision = selectWorkspaceCapability({
      eligibleChangeCount: snapshot.dirtyPaths.size,
      configChanged: [...snapshot.dirtyPaths].some(isResolverConfigPath),
      needsRelationships: options.needsRelationships || options.wantsWorkspaceGraph === true,
      haveUsableSymbolsOverlay: snapshot.usable && snapshot.capability !== 'workspace-graph',
      haveUsableWorkspaceGraph:
        snapshot.usable &&
        snapshot.capability === 'workspace-graph' &&
        snapshot.coverage !== 'degraded',
      baseMatches: !activeBaseChanged,
      headChanged: activeBaseChanged,
    });
    if (decision.action !== 'build-workspace-graph') return snapshot;
    // A read that needs no relationships can still answer from the committed graph plus the
    // dirty-file merge, so a refused or failing build degrades the answer instead of failing it.
    const degrade = (error: unknown): OverlaySnapshot => {
      if (
        options.needsRelationships ||
        !(error instanceof WorkspacePreparationError) ||
        !['workspace_too_large', 'workspace_busy', 'workspace_build_failed'].includes(error.code)
      ) {
        throw error;
      }
      return {
        ...snapshot,
        // The fallback may be a generation that a concurrent build prunes before the request pins
        // it, so a degraded answer never pins an overlay: it reads the committed index only.
        ...(snapshot.usable
          ? { usable: false, reason: 'working-tree graph not built; overlay not used' }
          : {}),
        preparationNote: `Working-tree graph not built (${error.code}); results use the committed index and may miss uncommitted changes. ${error.message}`,
      };
    };
    const maxFiles =
      Number(process.env.ONTOINDEX_WORKSPACE_MAX_FILES) || DEFAULT_MAX_WORKSPACE_FILES;
    const fileCount = await dependencies.baseFileCount(options.repo);
    if (fileCount !== undefined && fileCount > maxFiles) {
      return degrade(
        new WorkspacePreparationError(
          'workspace_too_large',
          `Repository has ${fileCount} indexed files (limit ${maxFiles}); a full workspace graph build is refused. Run \`ontoindex analyze\` or raise ONTOINDEX_WORKSPACE_MAX_FILES.`,
        ),
      );
    }
    const identity = JSON.stringify([
      snapshot.generation,
      snapshot.reason,
      [...snapshot.dirtyPaths].sort(),
    ]);
    const failed = failedBuilds.get(options.repo.id);
    if (failed && failed.identity === identity && failed.until > dependencies.now()) {
      return degrade(new WorkspacePreparationError('workspace_build_failed', failed.message));
    }
    const built = workspaceBuild(options.repo.id, identity, async () => {
      let lock: Awaited<ReturnType<WorkspacePreparationDependencies['acquireLock']>>;
      try {
        lock = await dependencies.acquireLock(options.repo.repoPath);
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        throw new WorkspacePreparationError(
          /already running|Cannot safely recover|recovering the analyze lock/i.test(message)
            ? 'workspace_busy'
            : 'workspace_build_failed',
          message,
          { cause },
        );
      }
      try {
        try {
          await dependencies.buildWorkspaceGraph(options.repo.repoPath);
        } finally {
          await lock.release();
        }
        dependencies.evictSnapshot(options.repo.id);
        const updated = await dependencies.getSnapshot(options.repo);
        if (!updated.usable) throw new Error(updated.reason ?? 'Workspace snapshot is unusable');
        return updated;
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        failedBuilds.set(options.repo.id, {
          identity,
          until: dependencies.now() + FAILED_BUILD_COOLDOWN_MS,
          message,
        });
        throw new WorkspacePreparationError('workspace_build_failed', message, { cause });
      }
    });
    try {
      return await built;
    } catch (error) {
      return degrade(error);
    }
  };
  return new Promise<OverlaySnapshot>((resolve, reject) => {
    let settled = false;
    // Set once the wait budget is spent: a read that can degrade answers from the committed index.
    let latestSnapshot: OverlaySnapshot | undefined;
    const finish = (error?: unknown, value?: OverlaySnapshot) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      if (error) reject(error);
      else resolve(value!);
    };
    const abort = () => finish(new WorkspacePreparationError('workspace_cancelled'));
    const timer = setTimeout(
      () => {
        if (!options.needsRelationships && latestSnapshot && latestSnapshot.dirtyPaths.size > 0) {
          finish(undefined, {
            ...latestSnapshot,
            ...(latestSnapshot.usable
              ? { usable: false, reason: 'working-tree graph not built; overlay not used' }
              : {}),
            preparationNote:
              'Working-tree graph not built (workspace_timeout); the build is still running, so results use the committed index and may miss uncommitted changes. Retry shortly.',
          });
          return;
        }
        finish(new WorkspacePreparationError('workspace_timeout'));
      },
      Math.max(0, deadline - performance.now()),
    );
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    void work((snapshot) => {
      latestSnapshot = snapshot;
    }).then(
      (value) => finish(undefined, value),
      (error) => finish(error),
    );
  });
}

interface EnsureRepoInitializedOptions {
  repoId: string;
  handle: RepoHandle;
  initializedRepos: Set<string>;
  reinitPromises: Map<string, Promise<void>>;
  lastStalenessCheck: Map<string, number>;
  isLbugReady: (repoId: string) => boolean;
  isLbugDbPathReady?: (dbPath: string) => boolean;
  initLbug: (repoId: string, lbugPath: string) => Promise<void>;
  closeLbug: (repoId: string) => Promise<void>;
  resolveActiveLbugPath?: (storagePath: string) => Promise<string | null>;
  now?: () => number;
  signal?: AbortSignal;
  deadline?: number;
}

async function readAnalyzeLock(storagePath: string): Promise<string | null> {
  const lockPath = path.join(storagePath, 'analyze.lock');
  try {
    const raw = await fs.readFile(lockPath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (typeof parsed.pid === 'number' && !isProcessAlive(parsed.pid)) return null;
    const pid = typeof parsed.pid === 'number' ? ` PID ${parsed.pid}` : '';
    const startedAt = typeof parsed.startedAt === 'string' ? ` since ${parsed.startedAt}` : '';
    return `${lockPath}${pid}${startedAt}`;
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function hasRecoverySidecar(storagePath: string): Promise<string | null> {
  for (const suffix of ['wal', 'shadow']) {
    const sidecarPath = path.join(storagePath, `lbug.${suffix}`);
    try {
      const stat = await fs.stat(sidecarPath);
      if (stat.size > 0) return sidecarPath;
    } catch {
      // absent sidecars are fine
    }
  }
  return null;
}

async function assertIndexCanOpenReadOnly(
  handle: RepoHandle,
  isLbugDbPathReady?: (dbPath: string) => boolean,
): Promise<void> {
  const lock = await readAnalyzeLock(handle.storagePath);
  if (lock) {
    throw new Error(
      `OntoIndex index for "${handle.name}" is currently being rebuilt (${lock}). ` +
        'Wait for analyze to finish before using MCP tools.',
    );
  }

  const sidecar = isLbugDbPathReady?.(handle.lbugPath)
    ? null
    : await hasRecoverySidecar(handle.storagePath);
  if (sidecar) {
    throw new Error(
      `OntoIndex index for "${handle.name}" needs LadybugDB recovery before MCP can open it read-only (${sidecar}). ` +
        'Run one coordinated `ontoindex analyze` after stopping other MCP users.',
    );
  }
}

async function decorateInitError(
  handle: RepoHandle,
  err: unknown,
  isLbugDbPathReady?: (dbPath: string) => boolean,
): Promise<Error> {
  try {
    await assertIndexCanOpenReadOnly(handle, isLbugDbPathReady);
  } catch (preflightErr) {
    return preflightErr instanceof Error ? preflightErr : new Error(String(preflightErr));
  }

  const message = err instanceof Error ? err.message : String(err);
  if (message.includes('Could not set lock') || message.toLowerCase().includes('lock')) {
    return new Error(
      `LadybugDB unavailable for repo "${handle.name}". Another OntoIndex process may be analyzing ` +
        `or holding the index lock at ${handle.lbugPath}. Original error: ${message}`,
    );
  }
  return err instanceof Error ? err : new Error(message);
}

export type RepoResolution =
  | { kind: 'resolved'; repo: RepoHandle }
  | { kind: 'not-found' }
  | { kind: 'ambiguous'; candidates: RepoHandle[] };

function resolved(repo: RepoHandle): RepoResolution {
  return { kind: 'resolved', repo };
}

function canonicalRepoPath(repoPath: string): string {
  const resolvedPath = path.resolve(repoPath);
  try {
    return syncFs.realpathSync.native(resolvedPath);
  } catch {
    return resolvedPath;
  }
}

function choosePreferredRepo(candidates: RepoHandle[], preferredRepoPath?: string): RepoResolution {
  if (candidates.length === 1) return resolved(candidates[0]);
  if (!preferredRepoPath) return { kind: 'ambiguous', candidates };

  const preferred = canonicalRepoPath(preferredRepoPath);
  const containing = candidates
    .filter((handle) => {
      const repoPath = canonicalRepoPath(handle.repoPath);
      return preferred === repoPath || preferred.startsWith(`${repoPath}${path.sep}`);
    })
    .sort((a, b) => canonicalRepoPath(b.repoPath).length - canonicalRepoPath(a.repoPath).length);

  if (containing.length === 0) return { kind: 'ambiguous', candidates };
  const longestLength = canonicalRepoPath(containing[0].repoPath).length;
  const longest = containing.filter(
    (handle) => canonicalRepoPath(handle.repoPath).length === longestLength,
  );
  return longest.length === 1 ? resolved(longest[0]) : { kind: 'ambiguous', candidates };
}

function resolveRepoByParam(
  handles: Iterable<RepoHandle>,
  repoParam: string,
  preferredRepoPath?: string,
): RepoResolution {
  const allHandles = Array.from(handles);
  const paramLower = repoParam.toLowerCase();

  const resolvedPath = canonicalRepoPath(repoParam);
  const pathMatches = allHandles.filter(
    (handle) => canonicalRepoPath(handle.repoPath) === resolvedPath,
  );
  if (pathMatches.length > 0) return choosePreferredRepo(pathMatches, preferredRepoPath);

  const nameMatches = allHandles.filter((handle) => handle.name.toLowerCase() === paramLower);
  if (nameMatches.length > 0) return choosePreferredRepo(nameMatches, preferredRepoPath);

  const idMatches = allHandles.filter((handle) => handle.id === paramLower);
  if (idMatches.length > 0) return choosePreferredRepo(idMatches, preferredRepoPath);

  const partialMatches = allHandles.filter((handle) =>
    handle.name.toLowerCase().includes(paramLower),
  );
  if (partialMatches.length > 0) return choosePreferredRepo(partialMatches, preferredRepoPath);

  return { kind: 'not-found' };
}

export function resolveRepoFromHandles(
  repos: ReadonlyMap<string, RepoHandle>,
  repoParam?: string,
  preferredRepoPath?: string,
): RepoResolution {
  if (repos.size === 0) return { kind: 'not-found' };
  if (repoParam) return resolveRepoByParam(repos.values(), repoParam, preferredRepoPath);
  if (preferredRepoPath) {
    const preferred = choosePreferredRepo([...repos.values()], preferredRepoPath);
    if (preferred.kind === 'resolved') return preferred;
  }
  if (repos.size === 1) {
    const repo = repos.values().next().value;
    return repo ? resolved(repo) : { kind: 'not-found' };
  }
  return { kind: 'ambiguous', candidates: [...repos.values()] };
}

export function buildAvailableRepoLabels(repos: ReadonlyMap<string, RepoHandle>): string[] {
  const nameCounts = new Map<string, number>();
  for (const handle of repos.values()) {
    const key = handle.name.toLowerCase();
    nameCounts.set(key, (nameCounts.get(key) ?? 0) + 1);
  }

  return [...repos.values()].map((handle) =>
    (nameCounts.get(handle.name.toLowerCase()) ?? 0) > 1
      ? `${handle.name} (${handle.repoPath})`
      : handle.name,
  );
}

interface PublishedIndexIdentity {
  indexedAt: string;
  lastCommit?: string;
}

async function readPublishedIndexIdentity(
  storagePath: string,
): Promise<PublishedIndexIdentity | null> {
  try {
    const metaPath = path.join(storagePath, 'meta.json');
    const metaRaw = await fs.readFile(metaPath, 'utf-8');
    const meta = JSON.parse(metaRaw);
    if (typeof meta.indexedAt !== 'string' || meta.indexedAt.length === 0) return null;
    return {
      indexedAt: meta.indexedAt,
      ...(typeof meta.lastCommit === 'string' && meta.lastCommit.length > 0
        ? { lastCommit: meta.lastCommit }
        : {}),
    };
  } catch {
    return null;
  }
}

interface RepoPreparationWait {
  promise: Promise<void>;
  waiters: number;
}

export class RepoPreparationWaitError extends Error {
  constructor(public readonly code: 'cancelled' | 'timeout') {
    super(`Repository preparation wait ${code}`);
    this.name = 'RepoPreparationWaitError';
  }
}

interface RepoPreparation extends RepoPreparationWait {
  snapshot: string;
  pending?: RepoPreparationWait & {
    options: EnsureRepoInitializedOptions;
    resolve: () => void;
    reject: (error: unknown) => void;
  };
}

const preparations = new WeakMap<Map<string, Promise<void>>, Map<string, RepoPreparation>>();

export function ensureRepoInitialized(options: EnsureRepoInitializedOptions): Promise<void> {
  const now = performance.now();
  const deadline = Math.min(options.deadline ?? Infinity, now + 60_000);
  if (options.signal?.aborted) return Promise.reject(new RepoPreparationWaitError('cancelled'));
  if (!(deadline > now)) return Promise.reject(new RepoPreparationWaitError('timeout'));
  const state = getRepoPreparation(options);
  state.waiters++;
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown, failed = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      state.waiters--;
      if (failed) reject(error);
      else resolve();
    };
    const abort = () => finish(new RepoPreparationWaitError('cancelled'), true);
    const timer = setTimeout(
      () => finish(new RepoPreparationWaitError('timeout'), true),
      Math.max(0, deadline - performance.now()),
    );
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    state.promise.then(
      () => finish(),
      (error) => finish(error, true),
    );
  });
}

function getRepoPreparation(options: EnsureRepoInitializedOptions): RepoPreparationWait {
  let repos = preparations.get(options.reinitPromises);
  if (!repos) {
    repos = new Map();
    preparations.set(options.reinitPromises, repos);
  }
  const snapshot = JSON.stringify([
    options.handle.lbugPath,
    options.handle.indexedAt,
    options.handle.lastCommit,
  ]);
  const current = repos.get(options.repoId);
  if (current) {
    if (snapshot === current.snapshot && !current.pending) return current;
    if (!current.pending) {
      let resolve!: () => void;
      let reject!: (error: unknown) => void;
      const promise = new Promise<void>((yes, no) => {
        resolve = yes;
        reject = no;
      });
      void promise.catch(() => {});
      current.pending = { options, promise, resolve, reject, waiters: 0 };
    } else {
      current.pending.options = options;
    }
    return current.pending;
  }
  const state: RepoPreparation = { snapshot, promise: Promise.resolve(), waiters: 0 };
  // Register before asynchronous preparation starts, including the initial open.
  const promise = Promise.resolve().then(() => initializeRepo(options));
  state.promise = promise.then(
    () => settle(),
    (error) => {
      settle();
      throw error;
    },
  );
  void state.promise.catch(() => {});
  repos.set(options.repoId, state);
  function settle(): void {
    repos!.delete(options.repoId);
    if (state.pending) {
      const pending = state.pending;
      getRepoPreparation(pending.options).promise.then(pending.resolve, pending.reject);
    }
  }
  return state;
}

async function initializeRepo(options: EnsureRepoInitializedOptions): Promise<void> {
  const {
    repoId,
    handle,
    initializedRepos,
    reinitPromises,
    lastStalenessCheck,
    isLbugReady,
    isLbugDbPathReady,
    initLbug,
    closeLbug,
    resolveActiveLbugPath = async (storagePath) =>
      (await resolveActiveIndexGeneration(storagePath))?.lbugPath ?? null,
    now = Date.now,
  } = options;

  const pending = reinitPromises.get(repoId);
  if (pending) return pending;

  if (initializedRepos.has(repoId) && isLbugReady(repoId)) {
    const nowMs = now();
    const lastCheck = lastStalenessCheck.get(repoId) ?? 0;
    if (nowMs - lastCheck < 5000) return;

    lastStalenessCheck.set(repoId, nowMs);
    const [published, activeLbugPath] = await Promise.all([
      readPublishedIndexIdentity(handle.storagePath),
      resolveActiveLbugPath(handle.storagePath),
    ]);
    const lbugPath = activeLbugPath ?? handle.lbugPath;
    if ((!published || published.indexedAt === handle.indexedAt) && lbugPath === handle.lbugPath)
      return;

    const reinit = (async () => {
      try {
        await assertIndexCanOpenReadOnly({ ...handle, lbugPath }, isLbugDbPathReady);
        await closeLbug(repoId);
        initializedRepos.delete(repoId);
        await initLbug(repoId, lbugPath);
        handle.lbugPath = lbugPath;
        if (published) {
          handle.indexedAt = published.indexedAt;
          if (published.lastCommit) handle.lastCommit = published.lastCommit;
        }
        initializedRepos.add(repoId);
      } catch (err) {
        lastStalenessCheck.delete(repoId);
        throw err;
      } finally {
        reinitPromises.delete(repoId);
      }
    })();
    reinitPromises.set(repoId, reinit);
    return reinit;
  }

  try {
    const [published, activeLbugPath] = await Promise.all([
      readPublishedIndexIdentity(handle.storagePath),
      resolveActiveLbugPath(handle.storagePath),
    ]);
    const lbugPath = activeLbugPath ?? handle.lbugPath;
    await assertIndexCanOpenReadOnly({ ...handle, lbugPath }, isLbugDbPathReady);
    await initLbug(repoId, lbugPath);
    handle.lbugPath = lbugPath;
    if (published) {
      handle.indexedAt = published.indexedAt;
      if (published.lastCommit) handle.lastCommit = published.lastCommit;
    }
    initializedRepos.add(repoId);
  } catch (err: unknown) {
    initializedRepos.delete(repoId);
    throw await decorateInitError(handle, err, isLbugDbPathReady);
  }
}
