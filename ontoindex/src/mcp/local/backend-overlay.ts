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
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { getCurrentCommit } from '../../storage/git.js';
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
import { LbugOpenError } from '../../core/lbug/open-error.js';
import { digestDatabaseFile } from '../../core/lbug/database-digest.js';
import {
  acquireOverlayGenerationPin,
  readActiveGenerationMeta,
} from '../../storage/repo-manager.js';

/** Read the activation setting per request so explicit disablement takes effect immediately. */
export function isAutomaticWorkspaceEnabled(): boolean {
  const value = process.env.ONTOINDEX_AUTO_WORKSPACE;
  return value === undefined || value === '1';
}

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
  /**
   * Dirty resolver-configuration files. Reported only when automatic workspace reads are enabled, so they
   * stay out of the source-only `dirtyPaths` that the flag-off routes rely on.
   */
  configPaths?: ReadonlySet<string>;
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
  manifestDigest?: string;
  /** Validated current input content, independent of publication or database identity. */
  repairInputDigest?: string;
  baseGenerationId?: string | null;
  baseCommit?: string | null;
  currentHead?: string | null;
  baseMatches?: boolean;
  headChanged?: boolean;
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

const committedRead = new AsyncLocalStorage<{ repoId: string; generation: string }>();

export function getCommittedRead(repoId: string): { generation: string } | undefined {
  const current = committedRead.getStore();
  return current?.repoId === repoId ? current : undefined;
}

/** Select the committed view for this repository without changing concurrent requests. */
export function withCommittedRead<T>(
  repoId: string,
  generation: string,
  operation: () => Promise<T>,
): Promise<T> {
  return committedRead.run({ repoId, generation }, operation);
}

const SNAPSHOT_TTL_MS = 2_000;
const MAX_SNAPSHOTS = 64;
const snapshotCache = new Map<
  string,
  {
    at: number;
    baseIdentity: string | null;
    /** The flag changes what a persisted workspace graph means, so it is part of the identity. */
    workspaceFlag: boolean;
    value: Promise<OverlaySnapshot>;
    plan: Promise<DirtyOverlayPlan>;
    settled: boolean;
    usable: boolean;
  }
>();
const overlayFileIdentities = new Map<string, string>();
const verifiedDatabaseDigests = new Map<string, { identity: string; sha256: string }>();
const overlayQueries = new Map<string, Promise<unknown>>();
const pinnedOverlay = new AsyncLocalStorage<{
  repoId: string;
  dbPath: string;
  generation: string;
  capability?: OverlaySnapshot['capability'];
  /** The snapshot this request was admitted with; nested readers must see the same one. */
  snapshot: OverlaySnapshot;
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
    const runOverlay = () =>
      withPinnedGeneration(overlayRepoId(repo.id), dbPath, () =>
        pinnedOverlay.run(
          { repoId: repo.id, dbPath, generation, capability: snapshot.capability, snapshot },
          fn,
        ),
      );
    return await (isAutomaticWorkspaceEnabled() && snapshot.capability === 'workspace-graph'
      ? withPinnedGeneration(repo.id, dbPath, runOverlay)
      : runOverlay());
  } catch (error) {
    // Only a typed native failure for this admitted database can quarantine it.
    let cause: unknown = error;
    for (let depth = 0; depth <= 3; depth++) {
      if (
        cause instanceof LbugOpenError &&
        path.resolve(cause.dbPath) === path.resolve(dbPath) &&
        (cause.kind === 'corrupt' || cause.kind === 'incompatible')
      ) {
        snapshotCache.delete(repo.id);
        const markerPath = path.join(path.dirname(dbPath), 'READ_FAILURE.json');
        const temporaryPath = `${markerPath}.${randomUUID()}.tmp`;
        try {
          const { dev, ino, size, mtimeMs } = await fs.stat(dbPath);
          await fs.writeFile(
            temporaryPath,
            JSON.stringify({
              version: 1,
              generation,
              databaseIdentity: { dev, ino, size, mtimeMs },
              reason: `native_open_${cause.kind}`,
            }),
            { flag: 'wx' },
          );
          await fs.rename(temporaryPath, markerPath);
        } catch {
          // Persist diagnostics best-effort without replacing the original read failure.
        } finally {
          await fs.unlink(temporaryPath).catch(() => {});
        }
        break;
      }
      if (typeof cause !== 'object' || cause === null || !('cause' in cause)) break;
      cause = cause.cause;
    }
    throw error;
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
  if (getCommittedRead(repoId)) return repoId;
  // Opt-in only: a working-tree graph left on disk must not change flag-off behavior.
  if (!isAutomaticWorkspaceEnabled()) return repoId;
  const pinned = pinnedOverlay.getStore();
  return pinned?.repoId === repoId && pinned.capability === 'workspace-graph'
    ? overlayRepoId(repoId)
    : repoId;
}

/** True when the current request holds a pinned overlay generation for this repository. */
export function hasPinnedOverlay(repoId: string): boolean {
  if (getCommittedRead(repoId)) return false;
  return pinnedOverlay.getStore()?.repoId === repoId;
}

/** Snapshot admitted for this request, without re-reading overlay CURRENT. */
export function getPinnedOverlaySnapshot(repoId: string): OverlaySnapshot | undefined {
  if (getCommittedRead(repoId)) return EMPTY;
  const pinned = pinnedOverlay.getStore();
  return pinned?.repoId === repoId ? pinned.snapshot : undefined;
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
  // A configuration-only edit is a change only for the working-tree graph route.
  const configPaths = isAutomaticWorkspaceEnabled()
    ? new Set(plan.configPaths ?? [])
    : new Set<string>();
  const automatic = isAutomaticWorkspaceEnabled();
  if (!automatic && dirtyPaths.size === 0 && configPaths.size === 0) return EMPTY;
  const activeBase = await readActiveGenerationMeta(repo.storagePath);
  const baseGenerationId = activeBase.activeGeneration?.generationId ?? null;
  const baseCommit = activeBase.meta?.lastCommit ?? null;
  const currentHead = automatic ? getCurrentCommit(repo.repoPath) || null : null;
  const identity = automatic
    ? {
        currentHead,
        baseGenerationId,
        baseCommit,
        baseMatches: currentHead !== null && baseCommit === currentHead,
        headChanged: currentHead === null || baseCommit !== currentHead,
      }
    : {};
  if (dirtyPaths.size === 0 && configPaths.size === 0 && identity.baseMatches)
    return { ...EMPTY, ...identity };
  const base: Pick<
    OverlaySnapshot,
    'dirtyPaths' | 'parseErrorPaths' | 'overlayPaths' | 'uncoveredPaths' | 'tombstones'
  > & {
    generation?: string;
    capability?: OverlaySnapshot['capability'];
    coverage?: OverlaySnapshot['coverage'];
    ftsIndexes?: readonly string[];
    configPaths?: ReadonlySet<string>;
    currentHead?: string | null;
    baseGenerationId?: string | null;
    baseCommit?: string | null;
    baseMatches?: boolean;
    headChanged?: boolean;
  } = {
    ...identity,
    dirtyPaths,
    parseErrorPaths: new Set(),
    overlayPaths,
    uncoveredPaths,
    tombstones,
    ...(configPaths.size ? { configPaths } : {}),
  };

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
    head?: string | null;
    databaseDigest?: unknown;
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
  if (
    recordedBase.baseGenerationId !== baseGenerationId ||
    recordedBase.baseCommit !== baseCommit
  ) {
    const short = (id: string | null, commit: string | null) =>
      `${id ?? 'legacy'}/${commit?.slice(0, 8) ?? 'unknown'}`;
    return {
      ...base,
      usable: false,
      ...(automatic ? { baseMatches: false } : {}),
      reason: `overlay was built on base ${short(recordedBase.baseGenerationId, recordedBase.baseCommit)} but the active base is ${short(baseGenerationId, baseCommit)}; rebuild: ontoindex analyze --dirty-overlay`,
    };
  }
  const workspaceGraph = recordedBase.capability === 'workspace-graph';
  if (automatic && (currentHead === null || recordedBase.head !== currentHead)) {
    return { ...base, usable: false, reason: 'overlay HEAD identity differs; rebuild required' };
  }
  if ('databaseDigest' in recordedBase) {
    try {
      const digest = recordedBase.databaseDigest;
      if (
        typeof digest !== 'object' ||
        digest === null ||
        !('sha256' in digest) ||
        typeof digest.sha256 !== 'string' ||
        !/^[a-f0-9]{64}$/.test(digest.sha256) ||
        !('size' in digest) ||
        typeof digest.size !== 'number' ||
        !Number.isInteger(digest.size) ||
        digest.size < 0
      ) {
        throw new Error('malformed database digest');
      }
      const { dev, ino, size, mtimeMs } = await fs.stat(dbPath);
      if (size !== digest.size) throw new Error('database size mismatch');
      const identity = `${dev}:${ino}:${size}:${mtimeMs}`;
      const verified = verifiedDatabaseDigests.get(dbPath);
      const sha256 =
        verified?.identity === identity
          ? verified.sha256
          : (await digestDatabaseFile(dbPath)).sha256;
      if (sha256 !== digest.sha256) throw new Error('database digest mismatch');
      verifiedDatabaseDigests.set(dbPath, { identity, sha256 });
      while (verifiedDatabaseDigests.size > 16)
        verifiedDatabaseDigests.delete(verifiedDatabaseDigests.keys().next().value!);
    } catch {
      return {
        ...base,
        usable: false,
        reason:
          'overlay database failed integrity check; rebuild: ontoindex analyze --dirty-overlay',
      };
    }
  }
  if (workspaceGraph && !isAutomaticWorkspaceEnabled()) {
    // A persisted working-tree graph is invisible to every reader unless the feature is on.
    return {
      ...base,
      usable: false,
      reason: 'workspace graph ignored: ONTOINDEX_AUTO_WORKSPACE is not enabled',
    };
  }
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
  const validatedInputs = new Map<string, string>();
  let validatedConfiguration: { configurationDigest: string; parserIdentity: string } | undefined;
  if (
    (typeof (recordedBase as { manifestDigest?: unknown }).manifestDigest !== 'string' ||
      !(recordedBase as { manifestDigest?: string }).manifestDigest?.trim()) &&
    (workspaceGraph || overlayPaths.size > 0)
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
    validatedConfiguration = identity;
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
      const currentPaths = [...current];
      for (let offset = 0; offset < currentPaths.length; offset += 4) {
        const results = await Promise.allSettled(
          currentPaths.slice(offset, offset + 4).map(async (rel) => {
            const recorded = inventory[rel];
            if (
              !Array.isArray(recorded) ||
              recorded.length !== 4 ||
              typeof recorded[3] !== 'string'
            ) {
              return {
                rel,
                digest: null,
                reason: `workspace graph has malformed inventory for ${rel}; rebuild`,
              };
            }
            const stat = await fs.lstat(path.join(repo.repoPath, rel));
            if (!stat.isFile())
              return {
                rel,
                digest: null,
                reason: `workspace graph input is not a regular file: ${rel}; rebuild`,
              };
            // Metadata can be preserved across byte changes, so every input needs a digest.
            const digest = createHash('sha256')
              .update(await fs.readFile(path.join(repo.repoPath, rel)))
              .digest('hex');
            return {
              rel,
              digest,
              reason:
                digest !== recorded[3]
                  ? `overlay is stale for ${rel}; rebuild: ontoindex analyze --dirty-overlay`
                  : null,
            };
          }),
        );
        for (const result of results) {
          if (result.status === 'rejected') throw result.reason;
          const { rel, digest, reason } = result.value;
          if (digest !== null) validatedInputs.set(rel, digest);
          if (reason) return { ...base, usable: false, reason };
        }
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
      validatedInputs.set(rel, digest);
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
  try {
    const failure = JSON.parse(
      await fs.readFile(path.join(path.dirname(dbPath), 'READ_FAILURE.json'), 'utf8'),
    );
    if (
      failure?.version === 1 &&
      failure.generation === base.generation &&
      (failure.reason === 'native_open_corrupt' || failure.reason === 'native_open_incompatible')
    ) {
      const { dev, ino, size, mtimeMs } = await fs.stat(dbPath);
      const recorded = failure.databaseIdentity;
      if (
        recorded?.dev === dev &&
        recorded.ino === ino &&
        recorded.size === size &&
        recorded.mtimeMs === mtimeMs
      ) {
        return {
          ...base,
          usable: false,
          ...(validatedConfiguration
            ? {
                repairInputDigest: createHash('sha256')
                  .update(
                    JSON.stringify([
                      'ontoindex-overlay-repair-input-v1',
                      base.capability ?? 'symbols',
                      validatedConfiguration.configurationDigest,
                      validatedConfiguration.parserIdentity,
                      [...validatedInputs].sort(([left], [right]) =>
                        left < right ? -1 : left > right ? 1 : 0,
                      ),
                      [...dirtyPaths].sort(),
                      [...overlayPaths].sort(),
                      [...uncoveredPaths].sort(),
                      [...tombstones].sort(),
                      [...configPaths].sort(),
                    ]),
                  )
                  .digest('hex'),
              }
            : {}),
          reason: `overlay generation unreadable (${failure.reason}); rebuild required`,
        };
      }
    }
  } catch {
    // A missing, malformed, or unreadable diagnostic cannot quarantine a database.
  }
  return {
    ...base,
    usable: true,
    reason: null,
    manifestDigest: (recordedBase as { manifestDigest?: string }).manifestDigest,
    baseGenerationId: recordedBase.baseGenerationId,
    baseCommit: recordedBase.baseCommit,
  };
}

/** Cached for a short TTL so one tool call (and bursts of calls) share one git probe. */
export function getOverlaySnapshot(repo: OverlayRepo): Promise<OverlaySnapshot> {
  if (getCommittedRead(repo.id)) return Promise.resolve(EMPTY);
  // One snapshot per response: a request that already pinned a generation reads through it.
  // Re-probing here repeats the dirty plan and the configuration walk for every nested reader.
  if (isAutomaticWorkspaceEnabled()) {
    const pinned = pinnedOverlay.getStore();
    if (pinned?.repoId === repo.id) return Promise.resolve(pinned.snapshot);
  }
  const hit = snapshotCache.get(repo.id);
  const now = Date.now();
  const workspaceFlag = isAutomaticWorkspaceEnabled();
  let baseIdentity: string | null = null;
  try {
    baseIdentity = realpathSync(path.join(repo.storagePath, 'current'));
  } catch {
    // No active generation, including legacy root stores.
  }
  if (
    hit &&
    hit.baseIdentity === baseIdentity &&
    hit.workspaceFlag === workspaceFlag &&
    now - hit.at < SNAPSHOT_TTL_MS &&
    // A settled clean/unusable result cannot observe edits made after its probe.
    !(workspaceFlag && hit.settled && !hit.usable) &&
    // Usable results must revalidate; cache the replacement so concurrent readers share it.
    !(hit.settled && hit.usable)
  ) {
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
  const entry = {
    at: now,
    baseIdentity,
    workspaceFlag,
    value,
    plan,
    settled: false,
    usable: false,
  };
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
  verifiedDatabaseDigests.clear();
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
