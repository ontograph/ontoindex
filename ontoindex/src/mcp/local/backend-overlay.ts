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
import { createHash } from 'node:crypto';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  CAPTURE_CONFIGURATION,
  planDirtyOverlay,
  workspaceConfigurationIdentity,
  type DirtyOverlayPlan,
} from '../../core/analyze-delta.js';
import {
  closeLbug,
  executeParameterized,
  initLbug,
  withPinnedGeneration,
} from '../../core/lbug/pool-adapter.js';
import { walkRepositoryPaths } from '../../core/ingestion/filesystem-walker.js';
import {
  acquireOverlayGenerationPin,
  readActiveGenerationMeta,
} from '../../storage/repo-manager.js';

export interface OverlayRepo {
  id: string;
  repoPath: string;
  storagePath: string;
}

export interface OverlaySnapshot {
  /** True only when an overlay exists and is newer than every dirty source file. */
  usable: boolean;
  capability?: 'symbols' | 'workspace-graph';
  coverage?: 'complete' | 'degraded' | 'partial';
  /** Full-text indexes built into a workspace-graph generation (empty or absent: no lexical lane). */
  ftsIndexes?: readonly string[];
  /** Set when a full workspace build was skipped and this snapshot is a degraded fallback. */
  preparationNote?: string;
  /** Why the overlay is not usable (for diagnostics); null when usable. */
  reason: string | null;
  /** Repo-relative paths that are dirty (modified/added/untracked/deleted); base symbols for these are stale. */
  dirtyPaths: ReadonlySet<string>;
  /** Paths whose parse errors prevent authoritative relationship answers. */
  parseErrorPaths: ReadonlySet<string>;
  /** Dirty paths that still exist and are covered by the overlay. */
  overlayPaths: ReadonlySet<string>;
  /** Dirty existing paths omitted from a bounded overlay build. */
  uncoveredPaths: ReadonlySet<string>;
  /** Deleted or renamed-away paths: base symbols must be suppressed, overlay has none. */
  tombstones: ReadonlySet<string>;
  /** Overlay generation whose identity this snapshot validated; queries must read the same one. */
  generation?: string;
}

export function isResolverConfigPath(filePath: string): boolean {
  return CAPTURE_CONFIGURATION.test(path.posix.basename(filePath.replace(/\\/g, '/')));
}

export function selectWorkspaceCapability(input: {
  eligibleChangeCount: number;
  configChanged: boolean;
  needsRelationships: boolean;
  haveUsableSymbolsOverlay: boolean;
  haveUsableWorkspaceGraph: boolean;
  baseMatches: boolean;
  headChanged: boolean;
}): {
  action:
    | 'reuse-base'
    | 'reuse-symbols-overlay'
    | 'reuse-workspace-graph'
    | 'build-symbols-overlay'
    | 'build-workspace-graph';
  reason: string;
} {
  if (
    input.eligibleChangeCount === 0 &&
    input.baseMatches &&
    !input.headChanged &&
    !input.configChanged
  ) {
    return { action: 'reuse-base', reason: 'no eligible workspace changes and base matches' };
  }
  if (input.haveUsableWorkspaceGraph)
    return { action: 'reuse-workspace-graph', reason: 'matching complete workspace graph' };
  if (
    input.needsRelationships ||
    input.eligibleChangeCount > 50 ||
    input.configChanged ||
    !input.baseMatches ||
    input.headChanged
  ) {
    return {
      action: 'build-workspace-graph',
      reason:
        'workspace relationships, configuration, size, or base identity require full analysis',
    };
  }
  return input.haveUsableSymbolsOverlay
    ? { action: 'reuse-symbols-overlay', reason: 'matching symbols overlay' }
    : { action: 'build-symbols-overlay', reason: 'bounded symbol changes' };
}

const EMPTY: OverlaySnapshot = {
  usable: false,
  reason: 'no dirty files',
  dirtyPaths: new Set(),
  parseErrorPaths: new Set(),
  overlayPaths: new Set(),
  uncoveredPaths: new Set(),
  tombstones: new Set(),
};

const SNAPSHOT_TTL_MS = 2_000;
const MAX_SNAPSHOTS = 64;
const snapshotCache = new Map<
  string,
  {
    at: number;
    baseIdentity: string | null;
    value: Promise<OverlaySnapshot>;
    plan: Promise<DirtyOverlayPlan>;
    settled: boolean;
    usable: boolean;
  }
>();
const overlayFileIdentities = new Map<string, string>();
const overlayQueries = new Map<string, Promise<unknown>>();
const pinnedOverlay = new AsyncLocalStorage<{
  repoId: string;
  dbPath: string;
  generation: string;
  capability?: OverlaySnapshot['capability'];
}>();

/** Keep every overlay query in a request on the generation its snapshot validated. */
export async function withPinnedOverlay<T>(
  repo: OverlayRepo,
  snapshot: OverlaySnapshot,
  fn: () => Promise<T>,
): Promise<T> {
  if (!snapshot.usable || !snapshot.generation) return fn();
  const generation = snapshot.generation;
  const dbPath = path.join(repo.storagePath, 'overlay', generation, 'lbug');
  try {
    if (validGeneration(generation) !== generation || !(await fs.lstat(dbPath)).isFile()) {
      throw new Error('overlay generation no longer available');
    }
  } catch {
    throw new Error('overlay generation no longer available');
  }
  // The on-disk marker is what pruning honors; the pool pin alone does not protect an overlay
  // generation directory. Acquire it before any read and release it however the request ends.
  let marker: { release(): Promise<void> };
  try {
    marker = await acquireOverlayGenerationPin(path.dirname(dbPath));
  } catch {
    throw new Error('overlay generation no longer available');
  }
  try {
    return await withPinnedGeneration(overlayRepoId(repo.id), dbPath, () =>
      pinnedOverlay.run(
        { repoId: repo.id, dbPath, generation, capability: snapshot.capability },
        fn,
      ),
    );
  } finally {
    await marker.release().catch(() => {});
  }
}

export const overlayRepoId = (repoId: string): string => `${repoId}::overlay`;

/**
 * Pool id that serves the whole working tree for this request, or the committed id when the
 * request holds no pinned workspace graph. A symbols-only overlay is never returned: it holds
 * the changed files alone, so reading it as the whole graph would drop every clean file.
 */
export function workspaceGraphPoolId(repoId: string): string {
  // Opt-in only: a working-tree graph left on disk must not change flag-off behavior.
  if (process.env.ONTOINDEX_AUTO_WORKSPACE !== '1') return repoId;
  const pinned = pinnedOverlay.getStore();
  return pinned?.repoId === repoId && pinned.capability === 'workspace-graph'
    ? overlayRepoId(repoId)
    : repoId;
}

/** True when the current request holds a pinned overlay generation for this repository. */
export function hasPinnedOverlay(repoId: string): boolean {
  return pinnedOverlay.getStore()?.repoId === repoId;
}

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

async function computeSnapshot(
  repo: OverlayRepo,
  plan: DirtyOverlayPlan,
): Promise<OverlaySnapshot> {
  const overlayPaths = new Set(plan.includePaths);
  const uncoveredPaths = new Set(plan.uncoveredPaths);
  const tombstones = new Set(plan.tombstones);
  const dirtyPaths = new Set(plan.allDirtyPaths);
  if (dirtyPaths.size === 0) return EMPTY;
  const base: Pick<
    OverlaySnapshot,
    'dirtyPaths' | 'parseErrorPaths' | 'overlayPaths' | 'uncoveredPaths' | 'tombstones'
  > & {
    generation?: string;
    capability?: OverlaySnapshot['capability'];
    coverage?: OverlaySnapshot['coverage'];
    ftsIndexes?: readonly string[];
  } = { dirtyPaths, parseErrorPaths: new Set(), overlayPaths, uncoveredPaths, tombstones };

  let dbPath: string;
  try {
    const resolved = await resolveOverlayDbPath(repo.storagePath);
    if (!resolved) throw new Error('no published overlay');
    dbPath = resolved;
    base.generation = path.basename(path.dirname(dbPath));
  } catch {
    return {
      ...base,
      usable: false,
      reason: 'no valid overlay CURRENT generation (run: ontoindex analyze --dirty-overlay)',
    };
  }
  let recordedBase: {
    baseGenerationId: string | null;
    baseCommit: string | null;
    configurationDigest?: string;
    parserIdentity?: string;
    includePaths?: string[];
    capability?: OverlaySnapshot['capability'];
    coverage?: OverlaySnapshot['coverage'];
    ftsIndexes?: unknown;
    dirtyPaths?: string[];
    tombstones?: string[];
  };
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
  const workspaceGraph = recordedBase.capability === 'workspace-graph';
  if (workspaceGraph) {
    base.capability = 'workspace-graph';
    base.coverage = recordedBase.coverage;
    if (
      Array.isArray(recordedBase.ftsIndexes) &&
      recordedBase.ftsIndexes.every((item) => typeof item === 'string')
    ) {
      base.ftsIndexes = recordedBase.ftsIndexes as string[];
    }
    overlayPaths.clear();
    for (const rel of dirtyPaths) if (!tombstones.has(rel)) overlayPaths.add(rel);
    uncoveredPaths.clear();
    const sameSet = (recorded: unknown, current: ReadonlySet<string>) =>
      Array.isArray(recorded) &&
      recorded.every((item) => typeof item === 'string') &&
      new Set(recorded).size === current.size &&
      recorded.every((item) => current.has(item));
    if (
      !sameSet(recordedBase.dirtyPaths, dirtyPaths) ||
      !sameSet(recordedBase.tombstones, tombstones)
    ) {
      return {
        ...base,
        usable: false,
        reason: 'workspace graph dirty paths or tombstones differ; rebuild required',
      };
    }
    if (recordedBase.coverage === 'partial') {
      const parseErrorFiles = (recordedBase as { parseErrorFiles?: unknown }).parseErrorFiles;
      if (
        !Array.isArray(parseErrorFiles) ||
        !parseErrorFiles.every((item) => typeof item === 'string')
      ) {
        return {
          ...base,
          usable: false,
          reason: 'workspace graph has malformed parse-error metadata',
        };
      }
      base.parseErrorPaths = new Set(parseErrorFiles.map((item) => item.replace(/\\/g, '/')));
    } else if (recordedBase.coverage !== 'complete') {
      return {
        ...base,
        usable: false,
        reason: `workspace graph coverage is ${recordedBase.coverage ?? 'unknown'}; parse or resolution failures require rebuilding`,
      };
    }
  }
  // Content identity, not mtime: the overlay is reusable only for the exact bytes it was built from.
  const inputs = (recordedBase as { inputs?: Record<string, string> }).inputs;
  if (
    typeof (recordedBase as { manifestDigest?: unknown }).manifestDigest !== 'string' &&
    overlayPaths.size > 0
  ) {
    return {
      ...base,
      usable: false,
      reason: 'overlay has no manifest identity; rebuild: ontoindex analyze --dirty-overlay',
    };
  }
  if (workspaceGraph || overlayPaths.size > 0) {
    if (
      !workspaceGraph &&
      (!Array.isArray(recordedBase.includePaths) ||
        recordedBase.includePaths.length !== overlayPaths.size ||
        [...overlayPaths].some((rel) => !recordedBase.includePaths!.includes(rel)))
    ) {
      return {
        ...base,
        usable: false,
        reason: 'overlay include paths differ; rebuild: ontoindex analyze --dirty-overlay',
      };
    }
    if (
      typeof recordedBase.configurationDigest !== 'string' ||
      typeof recordedBase.parserIdentity !== 'string'
    ) {
      return {
        ...base,
        usable: false,
        reason:
          'overlay has no configuration or parser identity; rebuild: ontoindex analyze --dirty-overlay',
      };
    }
    const identity = await workspaceConfigurationIdentity(
      repo.repoPath,
      workspaceGraph ? undefined : { includePaths: [...overlayPaths] },
    );
    if (recordedBase.configurationDigest !== identity.configurationDigest) {
      return {
        ...base,
        usable: false,
        reason:
          'overlay configuration identity changed; rebuild: ontoindex analyze --dirty-overlay',
      };
    }
    if (recordedBase.parserIdentity !== identity.parserIdentity) {
      return {
        ...base,
        usable: false,
        reason: 'overlay parser identity changed; rebuild: ontoindex analyze --dirty-overlay',
      };
    }
  }
  if (workspaceGraph) {
    const inventory = (
      recordedBase as { inventory?: Record<string, [number, number | null, number | null, string]> }
    ).inventory;
    if (!inventory || typeof inventory !== 'object' || Array.isArray(inventory)) {
      return { ...base, usable: false, reason: 'workspace graph has no input inventory; rebuild' };
    }
    try {
      let unreadable = false;
      const scanned = await walkRepositoryPaths(repo.repoPath, undefined, {
        onUnreadableFile: () => {
          unreadable = true;
        },
        onSkippedLargeFile: () => {
          unreadable = true;
        },
      });
      if (unreadable)
        return { ...base, usable: false, reason: 'workspace graph has unreadable inputs; rebuild' };
      // Configuration eligibility is checked by workspaceConfigurationIdentity above;
      // those inputs are also retained here for stat/content validation.
      const current = new Set(scanned.map((entry) => entry.path));
      for (const rel of Object.keys(inventory)) {
        if (
          isResolverConfigPath(rel) &&
          (await fs.lstat(path.join(repo.repoPath, rel)).catch(() => null))?.isFile()
        )
          current.add(rel);
      }
      const changedPaths = [...current].filter((rel) => !Object.hasOwn(inventory, rel));
      changedPaths.push(...Object.keys(inventory).filter((rel) => !current.has(rel)));
      if (changedPaths.length)
        return {
          ...base,
          usable: false,
          reason: `workspace graph input paths changed: ${changedPaths.slice(0, 5).join(', ')}; rebuild`,
        };
      const changed: string[] = [];
      for (const rel of current) {
        const recorded = inventory[rel];
        if (!Array.isArray(recorded) || recorded.length !== 4 || typeof recorded[3] !== 'string') {
          return {
            ...base,
            usable: false,
            reason: `workspace graph has malformed inventory for ${rel}; rebuild`,
          };
        }
        const stat = await fs.lstat(path.join(repo.repoPath, rel));
        if (!stat.isFile())
          return {
            ...base,
            usable: false,
            reason: `workspace graph input is not a regular file: ${rel}; rebuild`,
          };
        if (stat.size !== recorded[0] || stat.mtimeMs !== recorded[1] || stat.ino !== recorded[2])
          changed.push(rel);
      }
      if (changed.length > 200)
        return {
          ...base,
          usable: false,
          reason: 'workspace graph has too many changed inputs; rebuild',
        };
      for (const rel of changed) {
        const digest = createHash('sha256')
          .update(await fs.readFile(path.join(repo.repoPath, rel)))
          .digest('hex');
        if (digest !== inventory[rel][3])
          return {
            ...base,
            usable: false,
            reason: `overlay is stale for ${rel}; rebuild: ontoindex analyze --dirty-overlay`,
          };
      }
    } catch {
      return {
        ...base,
        usable: false,
        reason: 'cannot validate workspace graph input inventory; rebuild',
      };
    }
  }
  for (const rel of overlayPaths) {
    try {
      const digest = createHash('sha256')
        .update(await fs.readFile(path.join(repo.repoPath, rel)))
        .digest('hex');
      if (inputs?.[rel] !== digest) {
        return {
          ...base,
          usable: false,
          reason: `overlay is stale for ${rel}; rebuild: ontoindex analyze --dirty-overlay`,
        };
      }
    } catch {
      return { ...base, usable: false, reason: `cannot read ${rel}` };
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
  if (hit && hit.baseIdentity === baseIdentity && now - hit.at < SNAPSHOT_TTL_MS) {
    // A usable answer authorizes overlay reads, so it is never served from cache: re-plan the
    // dirty set (a newly dirty file must not be missed) and re-verify byte/config identity.
    if (hit.settled && hit.usable) {
      return planDirtyOverlay(repo.repoPath)
        .then((plan) => computeSnapshot(repo, plan))
        .catch((err: unknown) => ({
          ...EMPTY,
          reason: `dirty planning failed: ${(err as Error).message}`,
        }));
    }
    return hit.value;
  }
  const plan = planDirtyOverlay(repo.repoPath);
  const value = plan
    .then((plan) => computeSnapshot(repo, plan))
    .catch((err: unknown) => {
      // A late failure must not evict a newer probe started after reset/expiry.
      if (snapshotCache.get(repo.id)?.value === value) snapshotCache.delete(repo.id);
      return { ...EMPTY, reason: `dirty planning failed: ${(err as Error).message}` };
    });
  for (const [id, cached] of snapshotCache) {
    if (now - cached.at >= SNAPSHOT_TTL_MS) snapshotCache.delete(id);
  }
  while (snapshotCache.size >= MAX_SNAPSHOTS)
    snapshotCache.delete(snapshotCache.keys().next().value!);
  const entry = { at: now, baseIdentity, value, plan, settled: false, usable: false };
  snapshotCache.set(repo.id, entry);
  void value.then((snapshot) => {
    entry.settled = true;
    entry.usable = snapshot.usable;
  });
  return value;
}

export function evictOverlayState(repoKey: string): void {
  snapshotCache.delete(repoKey);
  overlayFileIdentities.delete(overlayRepoId(repoKey));
}

export function resetOverlaySnapshotCache(): void {
  snapshotCache.clear();
}

/** Callers must not present an empty caller/impact answer as authoritative for a non-authoritative path. */
export function isAuthoritativePath(snapshot: OverlaySnapshot, filePath: string): boolean {
  return !snapshot.parseErrorPaths.has(filePath.replace(/\\/g, '/'));
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
  expectedGeneration?: string,
): Promise<TRow[]> {
  const id = overlayRepoId(repo.id);
  const pinned = pinnedOverlay.getStore();
  const activePin = pinned?.repoId === repo.id ? pinned : undefined;
  // Serialize this overlay's reads so replacement cannot close a handle between
  // another read's init and execution. Different repositories remain independent.
  const query = (overlayQueries.get(id) ?? Promise.resolve())
    .catch(() => {})
    .then(async () => {
      if (activePin) {
        if (expectedGeneration && expectedGeneration !== activePin.generation) {
          throw new Error('overlay generation changed since the snapshot was validated');
        }
        return (await executeParameterized(id, cypher, params)) as TRow[];
      }
      const dbPath = await resolveOverlayDbPath(repo.storagePath);
      let identity: string;
      try {
        if (!dbPath) throw new Error('no published overlay');
        if (expectedGeneration && path.basename(path.dirname(dbPath)) !== expectedGeneration) {
          throw new Error('overlay generation changed since the snapshot was validated');
        }
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
