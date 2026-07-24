import fs from 'fs/promises';
import syncFs from 'node:fs';
import path from 'path';
import { RepoHandle } from 'ontoindex-shared';

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
  now?: () => number;
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

async function readIndexedAt(storagePath: string): Promise<string | null> {
  try {
    const metaPath = path.join(storagePath, 'meta.json');
    const metaRaw = await fs.readFile(metaPath, 'utf-8');
    const meta = JSON.parse(metaRaw);
    return typeof meta.indexedAt === 'string' && meta.indexedAt.length > 0 ? meta.indexedAt : null;
  } catch {
    return null;
  }
}

export async function ensureRepoInitialized(options: EnsureRepoInitializedOptions): Promise<void> {
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
    now = Date.now,
  } = options;

  const pending = reinitPromises.get(repoId);
  if (pending) return pending;

  if (initializedRepos.has(repoId) && isLbugReady(repoId)) {
    const nowMs = now();
    const lastCheck = lastStalenessCheck.get(repoId) ?? 0;
    if (nowMs - lastCheck < 5000) return;

    lastStalenessCheck.set(repoId, nowMs);
    const indexedAt = await readIndexedAt(handle.storagePath);
    if (!indexedAt || indexedAt === handle.indexedAt) return;

    const reinit = (async () => {
      try {
        await assertIndexCanOpenReadOnly(handle, isLbugDbPathReady);
        handle.indexedAt = indexedAt;
        await closeLbug(repoId);
        initializedRepos.delete(repoId);
        await initLbug(repoId, handle.lbugPath);
        initializedRepos.add(repoId);
      } finally {
        reinitPromises.delete(repoId);
      }
    })();
    reinitPromises.set(repoId, reinit);
    return reinit;
  }

  try {
    await assertIndexCanOpenReadOnly(handle, isLbugDbPathReady);
    await initLbug(repoId, handle.lbugPath);
    initializedRepos.add(repoId);
  } catch (err: unknown) {
    initializedRepos.delete(repoId);
    throw await decorateInitError(handle, err, isLbugDbPathReady);
  }
}
