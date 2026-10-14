/**
 * Read-only access to the disposable dirty-file overlay built by
 * `ontoindex analyze --dirty-overlay` (<storagePath>/overlay/<CURRENT>/lbug).
 *
 * The overlay holds symbols only (no edges to the base graph), so callers must
 * treat anything served from it as identity/location data, never as proof of
 * "no callers" or "zero impact".
 */
import fs from 'node:fs/promises';
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { planDirtyOverlay, type DirtyOverlayPlan } from '../../core/analyze-delta.js';
import { closeLbug, executeParameterized, initLbug } from '../../core/lbug/pool-adapter.js';
import { readActiveGenerationMeta } from '../../storage/repo-manager.js';

export interface OverlayRepo {
  id: string;
  repoPath: string;
  storagePath: string;
}

export interface OverlaySnapshot {
  /** True only when an overlay exists and is newer than every dirty source file. */
  usable: boolean;
  /** Why the overlay is not usable (for diagnostics); null when usable. */
  reason: string | null;
  /** Repo-relative paths that are dirty (modified/added/untracked/deleted); base symbols for these are stale. */
  dirtyPaths: ReadonlySet<string>;
  /** Dirty paths that still exist and are covered by the overlay. */
  overlayPaths: ReadonlySet<string>;
  /** Dirty existing paths omitted from a bounded overlay build. */
  uncoveredPaths: ReadonlySet<string>;
  /** Deleted or renamed-away paths: base symbols must be suppressed, overlay has none. */
  tombstones: ReadonlySet<string>;
}

const EMPTY: OverlaySnapshot = {
  usable: false,
  reason: 'no dirty files',
  dirtyPaths: new Set(),
  overlayPaths: new Set(),
  uncoveredPaths: new Set(),
  tombstones: new Set(),
};

const SNAPSHOT_TTL_MS = 2_000;
const MAX_SNAPSHOTS = 64;
const snapshotCache = new Map<
  string,
  { at: number; baseIdentity: string | null; value: Promise<OverlaySnapshot> }
>();
const overlayFileIdentities = new Map<string, string>();
const overlayQueries = new Map<string, Promise<unknown>>();

export const overlayRepoId = (repoId: string): string => `${repoId}::overlay`;

function validGeneration(value: string): string | null {
  const id = value.trim();
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id) ? id : null;
}

/** Synchronous path helper retained for callers; use the resolver to check availability. */
export const overlayDbPath = (storagePath: string): string => {
  try {
    const generation = validGeneration(
      readFileSync(path.join(storagePath, 'overlay', 'CURRENT'), 'utf8'),
    );
    if (generation) return path.join(storagePath, 'overlay', generation, 'lbug');
  } catch {
    // Preserve the legacy helper's return type, not legacy reader behavior.
  }
  return path.join(storagePath, 'overlay', 'lbug');
};

/** Missing, malformed or incomplete publication means no overlay, including legacy stores. */
export async function resolveOverlayDbPath(storagePath: string): Promise<string | null> {
  try {
    const overlayPath = path.join(storagePath, 'overlay');
    const generation = validGeneration(
      await fs.readFile(path.join(overlayPath, 'CURRENT'), 'utf8'),
    );
    if (!generation) return null;
    const generationPath = path.join(overlayPath, generation);
    if (!(await fs.lstat(generationPath)).isDirectory()) return null;
    const dbPath = path.join(generationPath, 'lbug');
    return (await fs.lstat(dbPath)).isFile() ? dbPath : null;
  } catch {
    return null;
  }
}

async function computeSnapshot(repo: OverlayRepo): Promise<OverlaySnapshot> {
  const plan: DirtyOverlayPlan = await planDirtyOverlay(repo.repoPath);
  const overlayPaths = new Set(plan.includePaths);
  const uncoveredPaths = new Set(plan.uncoveredPaths);
  const tombstones = new Set(plan.tombstones);
  const dirtyPaths = new Set(plan.allDirtyPaths);
  if (dirtyPaths.size === 0) return EMPTY;
  const base = { dirtyPaths, overlayPaths, uncoveredPaths, tombstones };

  let builtAt: number;
  let dbPath: string;
  try {
    const resolved = await resolveOverlayDbPath(repo.storagePath);
    if (!resolved) throw new Error('no published overlay');
    dbPath = resolved;
    builtAt = (await fs.stat(dbPath)).mtimeMs;
  } catch {
    return {
      ...base,
      usable: false,
      reason: 'no valid overlay CURRENT generation (run: ontoindex analyze --dirty-overlay)',
    };
  }
  let recordedBase: { baseGenerationId: string | null; baseCommit: string | null };
  try {
    recordedBase = JSON.parse(
      await fs.readFile(path.join(path.dirname(dbPath), 'base.json'), 'utf8'),
    );
    if (
      !recordedBase ||
      !('baseGenerationId' in recordedBase) ||
      !('baseCommit' in recordedBase) ||
      (recordedBase.baseGenerationId !== null &&
        typeof recordedBase.baseGenerationId !== 'string') ||
      (recordedBase.baseCommit !== null && typeof recordedBase.baseCommit !== 'string')
    ) {
      throw new Error('invalid recorded base');
    }
  } catch {
    return {
      ...base,
      usable: false,
      reason: 'overlay has no recorded base; rebuild: ontoindex analyze --dirty-overlay',
    };
  }
  const activeBase = await readActiveGenerationMeta(repo.storagePath);
  const baseGenerationId = activeBase.activeGeneration?.generationId ?? null;
  const baseCommit = activeBase.meta?.lastCommit ?? null;
  if (
    recordedBase.baseGenerationId !== baseGenerationId ||
    recordedBase.baseCommit !== baseCommit
  ) {
    const short = (id: string | null, commit: string | null) =>
      `${id ?? 'legacy'}/${commit?.slice(0, 8) ?? 'unknown'}`;
    return {
      ...base,
      usable: false,
      reason: `overlay was built on base ${short(recordedBase.baseGenerationId, recordedBase.baseCommit)} but the active base is ${short(baseGenerationId, baseCommit)}; rebuild: ontoindex analyze --dirty-overlay`,
    };
  }
  for (const rel of overlayPaths) {
    try {
      if ((await fs.stat(path.join(repo.repoPath, rel))).mtimeMs > builtAt) {
        return { ...base, usable: false, reason: `overlay is older than ${rel}` };
      }
    } catch {
      return { ...base, usable: false, reason: `cannot stat ${rel}` };
    }
  }
  return { ...base, usable: true, reason: null };
}

/** Cached for a short TTL so one tool call (and bursts of calls) share one git probe. */
export function getOverlaySnapshot(repo: OverlayRepo): Promise<OverlaySnapshot> {
  const hit = snapshotCache.get(repo.id);
  const now = Date.now();
  let baseIdentity: string | null = null;
  try {
    baseIdentity = realpathSync(path.join(repo.storagePath, 'current'));
  } catch {
    // No active generation, including legacy root stores.
  }
  if (hit && hit.baseIdentity === baseIdentity && now - hit.at < SNAPSHOT_TTL_MS) return hit.value;
  const value = computeSnapshot(repo).catch((err: unknown) => {
    // A late failure must not evict a newer probe started after reset/expiry.
    if (snapshotCache.get(repo.id)?.value === value) snapshotCache.delete(repo.id);
    return { ...EMPTY, reason: `dirty planning failed: ${(err as Error).message}` };
  });
  for (const [id, cached] of snapshotCache) {
    if (now - cached.at >= SNAPSHOT_TTL_MS) snapshotCache.delete(id);
  }
  while (snapshotCache.size >= MAX_SNAPSHOTS)
    snapshotCache.delete(snapshotCache.keys().next().value!);
  snapshotCache.set(repo.id, { at: now, baseIdentity, value });
  return value;
}

export function evictOverlayState(repoKey: string): void {
  snapshotCache.delete(repoKey);
  overlayFileIdentities.delete(overlayRepoId(repoKey));
}

export function resetOverlaySnapshotCache(): void {
  snapshotCache.clear();
}

/** True when `filePath` (repo-relative, any separator) is dirty in this snapshot. */
export function isDirtyPath(
  snapshot: OverlaySnapshot,
  filePath: string | null | undefined,
): boolean {
  if (!filePath) return false;
  return snapshot.dirtyPaths.has(filePath.replace(/\\/g, '/'));
}

/** True when an overlay row replaces the base row for this dirty path. */
export function isOverlayReplacedPath(
  snapshot: OverlaySnapshot,
  filePath: string | null | undefined,
): boolean {
  if (!filePath) return false;
  const normalized = filePath.replace(/\\/g, '/');
  return snapshot.overlayPaths.has(normalized) || snapshot.tombstones.has(normalized);
}

/** Query the overlay store read-only through the MCP pool under a distinct pool id. */
export async function queryOverlay<TRow extends object = Record<string, unknown>>(
  repo: OverlayRepo,
  cypher: string,
  params: Record<string, unknown> = {},
): Promise<TRow[]> {
  const id = overlayRepoId(repo.id);
  // Serialize this overlay's reads so replacement cannot close a handle between
  // another read's init and execution. Different repositories remain independent.
  const query = (overlayQueries.get(id) ?? Promise.resolve())
    .catch(() => {})
    .then(async () => {
      const dbPath = await resolveOverlayDbPath(repo.storagePath);
      let identity: string;
      try {
        if (!dbPath) throw new Error('no published overlay');
        const { dev, ino, mtimeMs, size } = await fs.stat(dbPath);
        identity = `${dbPath}:${dev}:${ino}:${mtimeMs}:${size}`;
      } catch (error) {
        await closeLbug(id);
        overlayFileIdentities.delete(id);
        snapshotCache.delete(repo.id);
        throw error;
      }
      if (overlayFileIdentities.get(id) !== identity) {
        await closeLbug(id);
        overlayFileIdentities.delete(id);
        snapshotCache.delete(repo.id);
      }
      await initLbug(id, dbPath);
      overlayFileIdentities.set(id, identity);
      return (await executeParameterized(id, cypher, params)) as TRow[];
    });
  overlayQueries.set(id, query);
  try {
    return await query;
  } finally {
    if (overlayQueries.get(id) === query) overlayQueries.delete(id);
  }
}
