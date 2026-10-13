/**
 * Repository Manager
 *
 * Manages OntoIndex index storage in .ontoindex/ at repo root.
 * Also maintains a global registry at ~/.ontoindex/registry.json
 * so the MCP server can discover indexed repos from any cwd.
 */

import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { getInferredRepoName } from './git.js';
import { CURRENT_CONTRACT } from '../core/contract/versions.js';
import type { RelationshipDistributions } from '../core/graph/fact-provenance.js';
import type { IndexSourceManifest } from '../core/indexing/source-manifest.js';

export interface DegradedFileEntry {
  filePath: string;
  reason: string;
  phase?: string;
  language?: string;
}

export interface DegradedFileGroupCount {
  /** Stable, normalized degradation cause (byte sizes and limits removed). */
  cause: string;
  phase: string;
  language: string;
  count: number;
}

export interface DegradedFileAggregates {
  /**
   * Number of degraded files reflected in these aggregates. This is derived
   * from bounded per-phase telemetry samples, not a true repository-wide
   * degraded-file total, so it is named `sampled*` to avoid overclaiming.
   */
  sampledDegradedCount: number;
  /** Bounded, deterministically ordered group counts (top-N by count). */
  groups: DegradedFileGroupCount[];
  /** Groups omitted from `groups` because of the top-N bound. */
  omittedGroupCount: number;
  /**
   * Optional sample entries. Omitted when the top-level `degradedFiles` list
   * already carries the same bounded sample to avoid duplicate nesting.
   */
  sampleFiles?: DegradedFileEntry[];
}

export interface RepoMeta {
  repoPath: string;
  lastCommit: string;
  indexedAt: string;
  generationId?: string;
  sourceManifest?: IndexSourceManifest;
  indexMode?: 'full' | 'symbols-only';
  pipelineProfile?: 'full' | 'symbols' | 'huge-repo-symbols';
  capabilities?: {
    symbols?: boolean;
    impact?: 'full' | 'degraded';
    processes?: boolean;
  };
  skippedPhases?: string[];
  includePaths?: string[];
  degradedFiles?: DegradedFileEntry[];
  degradedFileAggregates?: DegradedFileAggregates;
  partialCheckpointPath?: string;
  /**
   * Bounded relation-type and provenance-band distributions for the built
   * graph. Optional and additive: legacy meta without this field remains
   * readable. Both distributions sum exactly to the total relationship count.
   */
  relationshipDistributions?: RelationshipDistributions;
  /**
   * Hash of the embedding model used to populate this index. Checked on
   * re-analyze against `process.env.ONTOINDEX_EMBEDDING_MODEL_HASH`; a
   * mismatch with `--embeddings` aborts the run so we never mix vectors
   * from different model versions in the same index.
   */
  model_hash?: string;
  embeddingVectorIndexDigest?: string;
  stats?: {
    files?: number;
    nodes?: number;
    edges?: number;
    communities?: number;
    processes?: number;
    embeddings?: number;
  };
}

interface IndexedRepo {
  repoPath: string;
  storagePath: string;
  lbugPath: string;
  metaPath: string;
  meta: RepoMeta;
}

/**
 * Shape of an entry in the global registry (~/.ontoindex/registry.json)
 */
export interface RegistryEntry {
  name: string;
  path: string;
  storagePath: string;
  indexedAt: string;
  lastCommit: string;
  stats?: RepoMeta['stats'];
}

export interface IndexGenerationPaths {
  generationId: string;
  generationPath: string;
  lbugPath: string;
  metaPath: string;
  snapshotPath: string;
}

export type ActiveGenerationMetaAuthority = 'active-generation' | 'legacy-root' | 'untrusted';

export interface ActiveGenerationMetaPair {
  activeGeneration: IndexGenerationPaths | null;
  meta: RepoMeta | null;
  authority: ActiveGenerationMetaAuthority;
  reason?:
    | 'active-generation-metadata-unavailable'
    | 'active-generation-metadata-mismatch'
    | 'active-generation-changed-during-read'
    | 'generation-tagged-root-metadata-without-active-generation'
    | 'legacy-root-metadata-unavailable';
}

export interface ActiveGenerationMetaReadDeps {
  resolveActiveGeneration?: typeof resolveActiveIndexGeneration;
  readMetaFile?: (metaPath: string) => Promise<RepoMeta | null>;
}

const ONTOINDEX_DIR = '.ontoindex';
const GENERATIONS_DIR = 'generations';
const CURRENT_GENERATION_LINK = 'current';
const GENERATION_POINTER_LOCK = 'current.mutation.lock';
const GENERATION_POINTER_LOCK_TIMEOUT_MS = 10_000;
const REGISTRY_LOCK_TIMEOUT_MS = 10_000;
const REGISTRY_LOCK_STALE_MS = 2 * 60_000;
const REGISTRY_LOCK_RETRY_MS = 50;
const REGISTRY_RECLAIM_LOCK_TIMEOUT_MS = 1_000;
const LOCK_TOKEN_ABSENT = Symbol('lock-token-absent');

type ErrorWithCode = {
  code?: unknown;
};

type ErrorWithMessage = {
  message?: unknown;
};

type ParsedRegistryLock = {
  pid?: unknown;
  token?: unknown;
  startedAt?: unknown;
};

const hasProperties = (value: unknown): value is ErrorWithCode & ErrorWithMessage => {
  return (typeof value === 'object' && value !== null) || typeof value === 'function';
};

const errorCode = (err: unknown): unknown => {
  return hasProperties(err) ? err.code : undefined;
};

const errorMessage = (err: unknown): unknown => {
  return hasProperties(err) ? err.message : undefined;
};

const sameRepoPath = (left: string, right: string): boolean =>
  process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;

const canonicalRepoPath = async (repoPath: string): Promise<string> => {
  const resolved = path.resolve(repoPath);
  try {
    return await fs.realpath(resolved);
  } catch {
    return resolved;
  }
};

// ─── Local Storage Helpers ─────────────────────────────────────────────

/**
 * Get the .ontoindex storage path for a repository
 */
export const getStoragePath = (repoPath: string): string => {
  return path.join(path.resolve(repoPath), ONTOINDEX_DIR);
};

/**
 * Get paths to key storage files
 */
export const getStoragePaths = (repoPath: string) => {
  const storagePath = getStoragePath(repoPath);
  return {
    storagePath,
    lbugPath: path.join(storagePath, 'lbug'),
    metaPath: path.join(storagePath, 'meta.json'),
  };
};

function generationPaths(
  storagePath: string,
  generationId: string,
  generationPath: string,
): IndexGenerationPaths {
  return {
    generationId,
    generationPath,
    lbugPath: path.join(generationPath, 'lbug'),
    metaPath: path.join(generationPath, 'meta.json'),
    snapshotPath: path.join(generationPath, 'snapshot.json'),
  };
}

function safeGenerationId(generationId: string): string {
  const safe = generationId.replace(/[^A-Za-z0-9._-]/g, '-');
  if (!safe || safe === '.' || safe === '..') throw new Error('Invalid index generation id');
  return safe;
}

export const createIndexGeneration = async (
  storagePath: string,
  generationId: string,
): Promise<IndexGenerationPaths> => {
  const safeId = safeGenerationId(generationId);
  const generationsPath = path.join(storagePath, GENERATIONS_DIR);
  await fs.mkdir(generationsPath, { recursive: true });
  await migrateLegacyGeneration(storagePath);
  const stagingPath = path.join(
    generationsPath,
    `.staging-${safeId}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await fs.mkdir(stagingPath, { recursive: false });
  return generationPaths(storagePath, safeId, stagingPath);
};

export const discardIndexGeneration = async (generation: IndexGenerationPaths): Promise<void> => {
  await fs.rm(generation.generationPath, { recursive: true, force: true });
};

export interface IndexGenerationActivation {
  activeGeneration: IndexGenerationPaths;
  previousGeneration: IndexGenerationPaths | null;
}

export interface IndexGenerationPublication<T> extends IndexGenerationActivation {
  result: T;
}

async function replaceWithSymlink(target: string, linkPath: string): Promise<void> {
  const tmpPath = `${linkPath}.${process.pid}.${Date.now()}.tmp`;
  await fs.symlink(target, tmpPath);
  try {
    await fs.rename(tmpPath, linkPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'EPERM') {
      await fs.rm(tmpPath, { force: true });
      throw err;
    }

    const backupPath = `${linkPath}.${process.pid}.${Date.now()}.bak`;
    try {
      await fs.rename(linkPath, backupPath);
      try {
        await fs.rename(tmpPath, linkPath);
      } catch (replaceError) {
        await fs.rename(backupPath, linkPath);
        throw replaceError;
      }
      await fs.rm(backupPath, { force: true });
    } catch (fallbackError) {
      await fs.rm(tmpPath, { force: true });
      throw fallbackError;
    }
  }
}

async function ensureGenerationAliases(storagePath: string): Promise<void> {
  for (const filename of ['lbug', 'lbug.wal', 'lbug.lock', 'meta.json', 'snapshot.json']) {
    const linkPath = path.join(storagePath, filename);
    const target = path.join(CURRENT_GENERATION_LINK, filename);
    if ((await fs.readlink(linkPath).catch(() => null)) === target) continue;
    await replaceWithSymlink(target, linkPath);
  }
}

async function migrateLegacyGeneration(storagePath: string): Promise<void> {
  const currentPath = path.join(storagePath, CURRENT_GENERATION_LINK);
  const currentExists = await fs
    .lstat(currentPath)
    .then(() => true)
    .catch(() => false);
  if (currentExists) {
    // A resolvable pointer means migration already happened.
    if (
      await fs
        .stat(currentPath)
        .then(() => true)
        .catch(() => false)
    )
      return;
    // A dangling pointer must not let alias repair overwrite the only legacy root copies.
    await fs.unlink(currentPath);
  }

  const publishedFiles = ['lbug', 'lbug.wal', 'lbug.lock', 'meta.json', 'snapshot.json'];
  const existingFiles: string[] = [];
  for (const filename of publishedFiles) {
    const filePath = path.join(storagePath, filename);
    if (
      await fs
        .lstat(filePath)
        .then((stat) => stat.isFile())
        .catch(() => false)
    ) {
      existingFiles.push(filename);
    }
  }
  if (existingFiles.length === 0) return;

  const generationsPath = path.join(storagePath, GENERATIONS_DIR);
  const generationId = `legacy-${Date.now()}-${process.pid}`;
  const generationPath = path.join(generationsPath, generationId);
  await fs.mkdir(generationPath, { recursive: false });
  try {
    for (const filename of existingFiles) {
      await fs.copyFile(path.join(storagePath, filename), path.join(generationPath, filename));
    }
    await fs.symlink(path.join(GENERATIONS_DIR, generationId), currentPath);
    await ensureGenerationAliases(storagePath);
  } catch (err) {
    await fs.rm(generationPath, { recursive: true, force: true });
    throw err;
  }
}

async function withGenerationPointerLock<T>(
  storagePath: string,
  callback: () => Promise<T>,
): Promise<T> {
  await fs.mkdir(storagePath, { recursive: true });
  const lockPath = path.join(storagePath, GENERATION_POINTER_LOCK);
  const release = await acquireExclusiveFile(lockPath, GENERATION_POINTER_LOCK_TIMEOUT_MS);
  if (!release) throw new Error(`Timed out acquiring index generation pointer lock: ${lockPath}`);
  let result: T | undefined;
  let callbackError: unknown;
  try {
    result = await callback();
  } catch (err) {
    callbackError = err;
  }

  let releaseError: unknown;
  try {
    await release();
  } catch (err) {
    releaseError = err;
  }

  if (callbackError !== undefined && releaseError !== undefined) {
    throw new AggregateError(
      [callbackError, releaseError],
      'Index generation pointer mutation failed and its lock could not be released.',
    );
  }
  if (callbackError !== undefined) throw callbackError;
  if (releaseError !== undefined) throw releaseError;
  return result as T;
}

async function requirePublishedGeneration(
  storagePath: string,
  generation: IndexGenerationPaths,
): Promise<IndexGenerationPaths> {
  const generationId = safeGenerationId(generation.generationId);
  if (generationId !== generation.generationId) {
    throw new Error('Index generation id is not canonical');
  }
  const generationPath = path.join(
    await fs.realpath(path.join(storagePath, GENERATIONS_DIR)),
    generationId,
  );
  if (path.resolve(generation.generationPath) !== path.resolve(generationPath)) {
    throw new Error('Index generation path is outside the repository generations directory');
  }
  return generationPaths(storagePath, generationId, generationPath);
}

async function activateIndexGenerationLocked(
  storagePath: string,
  generation: IndexGenerationPaths,
): Promise<IndexGenerationActivation> {
  const generationId = safeGenerationId(generation.generationId);
  if (generationId !== generation.generationId) {
    throw new Error('Index generation id is not canonical');
  }
  const previousGeneration = await resolveActiveIndexGeneration(storagePath);
  const generationsPath = path.join(storagePath, GENERATIONS_DIR);
  const finalPath = path.join(generationsPath, generationId);
  await fs.rename(generation.generationPath, finalPath);

  const currentPath = path.join(storagePath, CURRENT_GENERATION_LINK);
  await replaceWithSymlink(path.join(GENERATIONS_DIR, generationId), currentPath);
  try {
    await ensureGenerationAliases(storagePath);
  } catch (aliasError) {
    // Never leave a new generation active without its aliases: restore the previous pointer.
    try {
      if (previousGeneration) {
        await replaceWithSymlink(
          path.join(GENERATIONS_DIR, previousGeneration.generationId),
          currentPath,
        );
      } else {
        await fs.unlink(currentPath);
      }
      await fs.rename(finalPath, generation.generationPath);
    } catch (restoreError) {
      throw new AggregateError(
        [aliasError, restoreError],
        'Index generation alias repair failed and the previous generation could not be restored.',
      );
    }
    throw aliasError;
  }
  return {
    activeGeneration: generationPaths(storagePath, generationId, finalPath),
    previousGeneration,
  };
}

export const activateIndexGenerationTransaction = async (
  storagePath: string,
  generation: IndexGenerationPaths,
): Promise<IndexGenerationActivation> =>
  withGenerationPointerLock(storagePath, () =>
    activateIndexGenerationLocked(storagePath, generation),
  );

export const activateIndexGeneration = async (
  storagePath: string,
  generation: IndexGenerationPaths,
): Promise<IndexGenerationPaths> =>
  (await activateIndexGenerationTransaction(storagePath, generation)).activeGeneration;

async function removeGenerationAliases(storagePath: string): Promise<void> {
  for (const filename of ['lbug', 'lbug.wal', 'lbug.lock', 'meta.json', 'snapshot.json']) {
    const linkPath = path.join(storagePath, filename);
    try {
      if ((await fs.readlink(linkPath)) === path.join(CURRENT_GENERATION_LINK, filename)) {
        await fs.unlink(linkPath);
      }
    } catch {}
  }
}

async function rollbackIndexGenerationActivationLocked(
  storagePath: string,
  expectedActiveGenerationId: string,
  previousGeneration: IndexGenerationPaths | null,
): Promise<void> {
  const expectedId = safeGenerationId(expectedActiveGenerationId);
  if (expectedId !== expectedActiveGenerationId) {
    throw new Error('Expected active index generation id is not canonical');
  }
  const currentGeneration = await resolveActiveIndexGeneration(storagePath);
  if (currentGeneration?.generationId !== expectedId) {
    throw new Error(
      `Refusing index generation rollback: expected ${expectedId} to remain active, found ${currentGeneration?.generationId ?? 'none'}`,
    );
  }

  const currentPath = path.join(storagePath, CURRENT_GENERATION_LINK);
  if (previousGeneration) {
    const previous = await requirePublishedGeneration(storagePath, previousGeneration);
    const stat = await fs.lstat(previous.generationPath);
    if (stat.isSymbolicLink()) {
      throw new Error('Previous index generation must not be a symbolic link');
    }
    if (!stat.isDirectory()) throw new Error('Previous index generation is not a directory');
    const generationsPath = await fs.realpath(path.join(storagePath, GENERATIONS_DIR));
    const previousPath = await fs.realpath(previous.generationPath);
    if (previousPath !== path.join(generationsPath, previous.generationId)) {
      throw new Error('Previous index generation resolves outside the generations directory');
    }
    await replaceWithSymlink(path.join(GENERATIONS_DIR, previous.generationId), currentPath);
    return;
  }

  await fs.unlink(currentPath);
  await removeGenerationAliases(storagePath);
}

export const rollbackIndexGenerationActivation = async (
  storagePath: string,
  expectedActiveGenerationId: string,
  previousGeneration: IndexGenerationPaths | null,
): Promise<void> =>
  withGenerationPointerLock(storagePath, () =>
    rollbackIndexGenerationActivationLocked(
      storagePath,
      expectedActiveGenerationId,
      previousGeneration,
    ),
  );

export const publishIndexGenerationTransaction = async <T>(
  storagePath: string,
  generation: IndexGenerationPaths,
  commit: (activation: IndexGenerationActivation) => Promise<T>,
): Promise<IndexGenerationPublication<T>> =>
  withGenerationPointerLock(storagePath, async () => {
    const activation = await activateIndexGenerationLocked(storagePath, generation);
    try {
      const result = await commit(activation);
      // Retention is post-commit maintenance; its failure must not roll back publication.
      await markManagedGenerationLocked(
        storagePath,
        activation.activeGeneration.generationPath,
      ).catch(() => {});
      await pruneIndexGenerationsLocked(storagePath).catch(() => {});
      return { ...activation, result };
    } catch (commitError) {
      try {
        await rollbackIndexGenerationActivationLocked(
          storagePath,
          activation.activeGeneration.generationId,
          activation.previousGeneration,
        );
      } catch (rollbackError) {
        throw new AggregateError(
          [commitError, rollbackError],
          'Index generation publication commit failed and the active generation could not be rolled back.',
        );
      }
      throw commitError;
    }
  });

export const resolveActiveIndexGeneration = async (
  storagePath: string,
): Promise<IndexGenerationPaths | null> => {
  try {
    const generationPath = await fs.realpath(path.join(storagePath, CURRENT_GENERATION_LINK));
    const generationId = path.basename(generationPath);
    return generationPaths(storagePath, generationId, generationPath);
  } catch {
    return null;
  }
};

export interface GenerationCleanupPlan {
  keepNewest: number;
  kept: Array<{ name: string; reason: string }>;
  candidates: Array<{ name: string; reason: string; bytes: number }>;
  bytesReclaimable: number;
}

export interface GenerationCleanupResult {
  kept: Array<{ name: string; reason: string }>;
  candidates?: Array<{ name: string; reason: string; bytes: number }>;
  deleted: Array<{ name: string; bytes: number }>;
  skipped: Array<{ name: string; reason: string }>;
  bytesReclaimable: number;
  dryRun: boolean;
  keepNewest?: number;
}

async function generationCleanupReason(directory: string): Promise<string | null> {
  const stat = await fs.lstat(directory).catch(() => null);
  if (!stat?.isDirectory() || stat.isSymbolicLink()) return 'unverified';
  for (const name of ['meta.json', 'snapshot.json', 'lbug']) {
    const file = await fs.lstat(path.join(directory, name)).catch(() => null);
    if (!file?.isFile() || file.isSymbolicLink()) return 'unverified';
  }
  for (const name of await fs.readdir(directory)) {
    if (!name.startsWith('.reader-')) continue;
    const pin = /^\.reader-(\d+)-[a-z0-9]+$/.exec(name);
    const stat = await fs.lstat(path.join(directory, name));
    if (!pin || !stat.isFile() || stat.isSymbolicLink() || !processDefinitelyDead(Number(pin[1])))
      return 'live-pin';
  }
  return null;
}

async function generationCleanupBytes(directory: string): Promise<number> {
  let bytes = 0;
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    const stat = await fs.lstat(target);
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) bytes += await generationCleanupBytes(target);
    else if (stat.isFile()) bytes += stat.size;
  }
  return bytes;
}

async function planGenerationCleanupLocked(
  storagePath: string,
  keepNewest: number,
): Promise<GenerationCleanupPlan> {
  if (!Number.isInteger(keepNewest) || keepNewest < 0 || keepNewest > 10)
    throw new Error('--keep must be an integer from 0 to 10');
  const plan: GenerationCleanupPlan = { keepNewest, kept: [], candidates: [], bytesReclaimable: 0 };
  const root = path.resolve(storagePath, GENERATIONS_DIR);
  const rootStat = await fs.lstat(root).catch(() => null);
  if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) return plan;
  const entries = (await fs.readdir(root, { withFileTypes: true })).filter(
    (entry) =>
      entry.isDirectory() &&
      !entry.isSymbolicLink() &&
      !entry.name.startsWith('.') &&
      /^[A-Za-z0-9._-]+$/.test(entry.name),
  );
  const active = await resolveActiveIndexGeneration(storagePath);
  const canonicalRoot = await fs.realpath(root);
  const noActive =
    !active ||
    path.dirname(active.generationPath) !== canonicalRoot ||
    !entries.some((entry) => entry.name === active.generationId);
  const lock = await fs.lstat(path.join(storagePath, 'analyze.lock')).catch(() => null);
  const checkpointPath = path.join(storagePath, 'analysis-checkpoint.json');
  const checkpoint = await fs.lstat(checkpointPath).catch(() => null);
  let analyzing = !!lock;
  if (checkpoint) {
    try {
      const value = JSON.parse(await fs.readFile(checkpointPath, 'utf8'));
      analyzing ||= !['completed', 'failed'].includes(value.status);
    } catch {
      analyzing = true;
    }
  }
  const generations = await Promise.all(
    entries.map(async (entry) => {
      const leading = /^(\d+)-/.exec(entry.name);
      const marker = path.join(root, entry.name, '.retention-managed');
      const markerStat = await fs.lstat(marker).catch(() => null);
      const epoch = leading
        ? Number(leading[1])
        : markerStat?.isFile() && !markerStat.isSymbolicLink()
          ? Number(await fs.readFile(marker, 'utf8'))
          : 0;
      return { name: entry.name, epoch: Number.isFinite(epoch) ? epoch : 0 };
    }),
  );
  generations.sort((a, b) => b.epoch - a.epoch || b.name.localeCompare(a.name));
  const rollback = new Set(
    generations
      .filter((g) => g.name !== active?.generationId)
      .slice(0, keepNewest)
      .map((g) => g.name),
  );
  for (const generation of generations) {
    const directory = path.join(root, generation.name);
    const reason = noActive
      ? 'no-active-generation'
      : analyzing
        ? 'analysis-in-progress'
        : generation.name === active?.generationId
          ? 'active'
          : rollback.has(generation.name)
            ? 'rollback'
            : await generationCleanupReason(directory);
    if (reason) plan.kept.push({ name: generation.name, reason });
    else {
      const bytes = await generationCleanupBytes(directory);
      plan.candidates.push({ name: generation.name, bytes, reason: 'obsolete-generation' });
      plan.bytesReclaimable += bytes;
    }
  }
  return plan;
}

export const planGenerationCleanup = (storagePath: string, options: { keepNewest?: number } = {}) =>
  withGenerationPointerLock(storagePath, () =>
    planGenerationCleanupLocked(storagePath, options.keepNewest ?? 2),
  );

async function executeGenerationCleanupLocked(
  storagePath: string,
  plan: GenerationCleanupPlan,
): Promise<GenerationCleanupResult> {
  const fresh = await planGenerationCleanupLocked(storagePath, plan.keepNewest);
  if (fresh.candidates.length) await sweepDeadReaderPins(storagePath);
  const eligible = new Set(fresh.candidates.map((candidate) => candidate.name));
  const deleted: Array<{ name: string; bytes: number }> = [];
  const skipped: Array<{ name: string; reason: string }> = [];
  for (const candidate of plan.candidates) {
    if (
      !/^[A-Za-z0-9._-]+$/.test(candidate.name) ||
      candidate.name.startsWith('.') ||
      !eligible.has(candidate.name)
    ) {
      skipped.push({
        name: candidate.name,
        reason: fresh.kept.find((g) => g.name === candidate.name)?.reason ?? 'unverified',
      });
      continue;
    }
    if (deleted.length >= 50) {
      skipped.push({ name: candidate.name, reason: 'deletion-limit' });
      continue;
    }
    const directory = path.resolve(storagePath, GENERATIONS_DIR, candidate.name);
    const active = await resolveActiveIndexGeneration(storagePath);
    const reason =
      active?.generationId === candidate.name ? 'active' : await generationCleanupReason(directory);
    if (reason) {
      skipped.push({ name: candidate.name, reason });
      continue;
    }
    const bytes = await generationCleanupBytes(directory);
    await fs.rm(directory, { recursive: true, force: true });
    deleted.push({ name: candidate.name, bytes });
  }
  return {
    kept: fresh.kept,
    deleted,
    skipped,
    bytesReclaimable: fresh.bytesReclaimable,
    dryRun: false,
  };
}

export const executeGenerationCleanup = (storagePath: string, plan: GenerationCleanupPlan) =>
  withGenerationPointerLock(storagePath, () => executeGenerationCleanupLocked(storagePath, plan));

export const cleanGenerations = (
  storagePath: string,
  options: { dryRun?: boolean; keepNewest?: number } = {},
): Promise<GenerationCleanupResult> =>
  withGenerationPointerLock(storagePath, async (): Promise<GenerationCleanupResult> => {
    const plan = await planGenerationCleanupLocked(storagePath, options.keepNewest ?? 2);
    if (options.dryRun !== false) return { ...plan, deleted: [], skipped: [], dryRun: true };
    return executeGenerationCleanupLocked(storagePath, plan);
  });

export const resolveActiveLbugPath = async (storagePath: string): Promise<string> =>
  (await resolveActiveIndexGeneration(storagePath))?.lbugPath ?? path.join(storagePath, 'lbug');

export interface IndexGenerationPin {
  dbPath: string;
  published?: boolean;
  release: () => Promise<void>;
}

const processDefinitelyDead = (pid: number): boolean => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ESRCH';
  }
};

async function markManagedGenerationLocked(
  storagePath: string,
  generationPath: string,
): Promise<void> {
  const root = path.join(storagePath, GENERATIONS_DIR);
  const rootStat = await fs.lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
    throw new Error('Invalid generations directory');
  let maximum = 0;
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || !/^[A-Za-z0-9._-]+$/.test(entry.name))
      continue;
    const marker = path.join(root, entry.name, '.retention-managed');
    const stat = await fs.lstat(marker).catch(() => null);
    if (!stat?.isFile() || stat.isSymbolicLink()) continue;
    const value = Number(await fs.readFile(marker, 'utf8'));
    if (Number.isSafeInteger(value) && value > 0) maximum = Math.max(maximum, value);
  }
  const next = Math.max(Date.now(), maximum + 1);
  if (!Number.isSafeInteger(next) || next <= 0)
    throw new Error('Generation retention sequence exhausted');
  await fs.writeFile(path.join(generationPath, '.retention-managed'), String(next), { flag: 'wx' });
}

/** Called under the pointer lock; retained and unmanaged generations also need cleanup. */
async function sweepDeadReaderPins(storagePath: string): Promise<void> {
  const root = path.join(storagePath, GENERATIONS_DIR);
  const rootStat = await fs.lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return;
  let removed = 0;
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    if (
      !entry.isDirectory() ||
      entry.isSymbolicLink() ||
      entry.name.startsWith('.') ||
      safeGenerationId(entry.name) !== entry.name
    )
      continue;
    const directory = path.join(root, entry.name);
    for (const name of await fs.readdir(directory)) {
      const pin = /^\.reader-(\d+)-[a-z0-9]+$/.exec(name);
      if (!pin || !processDefinitelyDead(Number(pin[1]))) continue;
      const pinPath = path.join(directory, name);
      try {
        const stat = await fs.lstat(pinPath);
        if (!stat.isFile() || stat.isSymbolicLink()) continue;
        await fs.unlink(pinPath);
        if (++removed >= 2000) return;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
    }
  }
}

/** Only generations published after reader pin adoption are eligible for removal. */
async function pruneIndexGenerationsLocked(storagePath: string): Promise<void> {
  await sweepDeadReaderPins(storagePath);
  const root = path.join(storagePath, GENERATIONS_DIR);
  const rootStat = await fs.lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return;
  const active = await resolveActiveIndexGeneration(storagePath);
  if (!active) return;
  const entries = await fs.readdir(root, { withFileTypes: true });
  const managed: Array<{ name: string; committedAt: number }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const directory = path.join(root, entry.name);
    const staging = /^\.staging-.+-(\d+)-(\d+)-[a-z0-9]+$/.exec(entry.name);
    if (staging) {
      if (
        Date.now() - Number(staging[2]) > 24 * 60 * 60 * 1000 &&
        processDefinitelyDead(Number(staging[1]))
      ) {
        await fs.rm(directory, { recursive: true, force: true });
      }
      continue;
    }
    if (entry.name.startsWith('.') || !/^[A-Za-z0-9._-]+$/.test(entry.name)) continue;
    const marker = path.join(directory, '.retention-managed');
    const stat = await fs.lstat(marker).catch(() => null);
    if (!stat?.isFile() || stat.isSymbolicLink()) continue;
    const committedAt = Number(await fs.readFile(marker, 'utf8'));
    if (Number.isSafeInteger(committedAt) && committedAt > 0)
      managed.push({ name: entry.name, committedAt });
  }
  managed.sort((a, b) => b.committedAt - a.committedAt || b.name.localeCompare(a.name));
  const retained = new Set([
    active.generationId,
    ...managed
      .filter((g) => g.name !== active.generationId)
      .slice(0, 2)
      .map((g) => g.name),
  ]);
  for (const generation of managed) {
    const directory = path.join(root, generation.name);
    let pinned = false;
    for (const name of await fs.readdir(directory)) {
      if (!name.startsWith('.reader-')) continue;
      const pid = /^\.reader-(\d+)-[a-z0-9]+$/.exec(name);
      if (!pid || !processDefinitelyDead(Number(pid[1]))) {
        pinned = true;
        continue;
      }
      const pinPath = path.join(directory, name);
      const stat = await fs.lstat(pinPath);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        pinned = true;
        continue;
      }
      await fs.unlink(pinPath);
    }
    if (!pinned && !retained.has(generation.name))
      await fs.rm(directory, { recursive: true, force: true });
  }
}

/** Select and pin under the publication lock, before opening a native handle. */
export async function acquireIndexGenerationPin(
  requestedPath: string,
): Promise<IndexGenerationPin> {
  const absolute = path.resolve(requestedPath);
  const parent = path.dirname(absolute);
  const storagePath =
    path.basename(path.dirname(parent)) === GENERATIONS_DIR
      ? path.dirname(path.dirname(parent))
      : path.basename(parent) === CURRENT_GENERATION_LINK
        ? path.dirname(parent)
        : parent;
  // Staging databases retain their existing lifecycle.
  if (path.basename(parent).startsWith('.staging-')) {
    return { dbPath: requestedPath, release: async () => {} };
  }
  if (path.basename(absolute) !== 'lbug') {
    const target = await fs.realpath(absolute).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== 'ENOENT') throw err;
      return absolute;
    });
    const generation = path.dirname(target);
    if (path.basename(generation).startsWith('.staging-'))
      return { dbPath: requestedPath, release: async () => {} };
    if (
      path.basename(target) !== 'lbug' ||
      path.basename(path.dirname(generation)) !== GENERATIONS_DIR
    )
      return { dbPath: requestedPath, release: async () => {} };
    if ((await fs.realpath(storagePath)) !== path.dirname(path.dirname(generation)))
      throw new Error('Database generation resolves outside its generations directory');
  }
  return withGenerationPointerLock(storagePath, async () => {
    const resolved = await fs.realpath(absolute).catch(async (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT' && parent === storagePath)
        return path.join(await fs.realpath(parent), 'lbug');
      throw err;
    });
    const root = await fs
      .realpath(path.join(storagePath, GENERATIONS_DIR))
      .catch(() => path.join(storagePath, GENERATIONS_DIR));
    const rootStat = await fs.lstat(path.join(storagePath, GENERATIONS_DIR)).catch(() => null);
    if (rootStat?.isSymbolicLink())
      throw new Error('Generations directory must not be a symbolic link');
    const generationPath = path.dirname(resolved);
    const name = path.basename(generationPath);
    if (path.dirname(generationPath) !== root) {
      const canonicalStorage = await fs.realpath(storagePath);
      if (parent !== storagePath || resolved !== path.join(canonicalStorage, 'lbug'))
        throw new Error('Database generation resolves outside its generations directory');
      return { dbPath: resolved, release: async () => {} };
    }
    const stat = await fs.lstat(generationPath);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      name.startsWith('.') ||
      safeGenerationId(name) !== name
    )
      throw new Error('Invalid database generation directory');
    const databaseStat = await fs.lstat(resolved);
    if (!databaseStat.isFile() || databaseStat.isSymbolicLink())
      throw new Error('Published generation database must be a regular file');
    const pinPath = path.join(
      generationPath,
      `.reader-${process.pid}-${Math.random().toString(36).slice(2)}`,
    );
    await fs.writeFile(pinPath, '', { flag: 'wx', mode: 0o600 });
    await sweepDeadReaderPins(storagePath).catch(() => {});
    let released = false;
    return {
      dbPath: resolved,
      published: true,
      release: async () => {
        if (released) return;
        await withGenerationPointerLock(storagePath, async () => {
          if (released) return;
          await fs.unlink(pinPath);
          released = true;
          await pruneIndexGenerationsLocked(storagePath).catch(() => {});
        });
      },
    };
  });
}

async function readMetaFile(metaPath: string): Promise<RepoMeta | null> {
  try {
    return JSON.parse(await fs.readFile(metaPath, 'utf-8')) as RepoMeta;
  } catch {
    return null;
  }
}

/**
 * Read the active generation pointer and its metadata as one bounded stable
 * authority pair. A concurrent activation is retried once; metadata is only
 * returned when it identifies the exact generation that remains active after
 * the read. Without an active generation, only generationless legacy root
 * metadata is trusted.
 */
export const readActiveGenerationMeta = async (
  storagePath: string,
  deps: ActiveGenerationMetaReadDeps = {},
): Promise<ActiveGenerationMetaPair> => {
  const resolveActive = deps.resolveActiveGeneration ?? resolveActiveIndexGeneration;
  const readMeta = deps.readMetaFile ?? readMetaFile;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const generationBeforeRead = await resolveActive(storagePath);
    if (!generationBeforeRead) {
      const legacyMeta = await readMeta(path.join(storagePath, 'meta.json'));
      const generationAfterRead = await resolveActive(storagePath);
      if (generationAfterRead) {
        if (attempt === 0) continue;
        return {
          activeGeneration: generationAfterRead,
          meta: null,
          authority: 'untrusted',
          reason: 'active-generation-changed-during-read',
        };
      }
      if (legacyMeta && legacyMeta.generationId === undefined) {
        return {
          activeGeneration: null,
          meta: legacyMeta,
          authority: 'legacy-root',
        };
      }
      return {
        activeGeneration: null,
        meta: null,
        authority: 'untrusted',
        reason: legacyMeta
          ? 'generation-tagged-root-metadata-without-active-generation'
          : 'legacy-root-metadata-unavailable',
      };
    }

    const meta = await readMeta(generationBeforeRead.metaPath);
    const generationAfterRead = await resolveActive(storagePath);
    const pointerStable = generationAfterRead?.generationId === generationBeforeRead.generationId;
    if (!pointerStable) {
      if (attempt === 0) continue;
      return {
        activeGeneration: generationAfterRead,
        meta: null,
        authority: 'untrusted',
        reason: 'active-generation-changed-during-read',
      };
    }
    if (!meta) {
      return {
        activeGeneration: generationAfterRead,
        meta: null,
        authority: 'untrusted',
        reason: 'active-generation-metadata-unavailable',
      };
    }
    if (meta.generationId !== generationAfterRead.generationId) {
      return {
        activeGeneration: generationAfterRead,
        meta: null,
        authority: 'untrusted',
        reason: 'active-generation-metadata-mismatch',
      };
    }
    return {
      activeGeneration: generationAfterRead,
      meta,
      authority: 'active-generation',
    };
  }

  return {
    activeGeneration: null,
    meta: null,
    authority: 'untrusted',
    reason: 'active-generation-changed-during-read',
  };
};

/**
 * Check whether a KuzuDB index exists in the given storage path.
 * Non-destructive — safe to call from status commands.
 */
export const hasKuzuIndex = async (storagePath: string): Promise<boolean> => {
  try {
    await fs.stat(path.join(storagePath, 'kuzu'));
    return true;
  } catch {
    return false;
  }
};

/**
 * Clean up stale KuzuDB files after migration to LadybugDB.
 *
 * Returns:
 *   found        — true if .ontoindex/kuzu existed and was deleted
 *   needsReindex — true if kuzu existed but lbug does not (re-analyze required)
 *
 * Callers own the user-facing messaging; this function only deletes files.
 */
export const cleanupOldKuzuFiles = async (
  storagePath: string,
): Promise<{ found: boolean; needsReindex: boolean }> => {
  const oldPath = path.join(storagePath, 'kuzu');
  const newPath = path.join(storagePath, 'lbug');
  try {
    await fs.stat(oldPath);
    // Old kuzu file/dir exists — determine if lbug is already present
    let needsReindex = false;
    try {
      await fs.stat(newPath);
    } catch {
      needsReindex = true;
    }
    // Delete kuzu database file and its sidecars (.wal, .lock)
    for (const suffix of ['', '.wal', '.lock']) {
      try {
        await fs.unlink(oldPath + suffix);
      } catch {}
    }
    // Also handle the case where kuzu was stored as a directory
    try {
      await fs.rm(oldPath, { recursive: true, force: true });
    } catch {}
    return { found: true, needsReindex };
  } catch {
    // Old path doesn't exist — nothing to do
    return { found: false, needsReindex: false };
  }
};

/**
 * Load metadata from an indexed repo
 */
export const loadMeta = async (storagePath: string): Promise<RepoMeta | null> => {
  try {
    const activeGeneration = await resolveActiveIndexGeneration(storagePath);
    const metaPath = activeGeneration?.metaPath ?? path.join(storagePath, 'meta.json');
    const raw = await fs.readFile(metaPath, 'utf-8');
    return JSON.parse(raw) as RepoMeta;
  } catch {
    return null;
  }
};

/**
 * Save metadata to storage
 */
export const saveMeta = async (storagePath: string, meta: RepoMeta): Promise<void> => {
  await fs.mkdir(storagePath, { recursive: true });
  const metaPath = path.join(storagePath, 'meta.json');
  const tmpPath = `${metaPath}.${process.pid}.${Date.now()}.tmp`;
  // Persist repoPath as '.' — meta.json lives inside the repo's .ontoindex/,
  // so the absolute path is non-portable and leaks the build host's layout.
  // Inject CURRENT_CONTRACT so loaders can detect schema drift.
  const persisted = { ...meta, repoPath: '.', contract: CURRENT_CONTRACT };
  await fs.writeFile(tmpPath, JSON.stringify(persisted, null, 2), 'utf-8');
  try {
    await fs.rename(tmpPath, metaPath);
  } catch (err) {
    await fs.rm(tmpPath, { force: true });
    throw err;
  }
};

/**
 * Check if a path has a OntoIndex index
 */
export const hasIndex = async (repoPath: string): Promise<boolean> => {
  const { metaPath } = getStoragePaths(repoPath);
  try {
    await fs.access(metaPath);
    return true;
  } catch {
    return false;
  }
};

/**
 * Load an indexed repo from a path
 */
export const loadRepo = async (repoPath: string): Promise<IndexedRepo | null> => {
  const paths = getStoragePaths(repoPath);
  const activeGeneration = await resolveActiveIndexGeneration(paths.storagePath);
  const boundPaths = activeGeneration
    ? { ...paths, lbugPath: activeGeneration.lbugPath, metaPath: activeGeneration.metaPath }
    : paths;
  const meta = activeGeneration
    ? await fs
        .readFile(activeGeneration.metaPath, 'utf-8')
        .then((raw) => JSON.parse(raw) as RepoMeta)
        .catch(() => null)
    : await loadMeta(paths.storagePath);
  if (!meta) return null;

  return {
    repoPath: path.resolve(repoPath),
    ...boundPaths,
    meta,
  };
};

/**
 * Find .ontoindex by walking up from a starting path
 */
export const findRepo = async (startPath: string): Promise<IndexedRepo | null> => {
  let current = path.resolve(startPath);
  const root = path.parse(current).root;

  while (current !== root) {
    const repo = await loadRepo(current);
    if (repo) return repo;
    current = path.dirname(current);
  }

  return null;
};

/**
 * Add .ontoindex to .gitignore if not already present
 */
export const addToGitignore = async (repoPath: string): Promise<void> => {
  const gitignorePath = path.join(repoPath, '.gitignore');

  try {
    const content = await fs.readFile(gitignorePath, 'utf-8');
    if (content.includes(ONTOINDEX_DIR)) return;

    const newContent = content.endsWith('\n')
      ? `${content}${ONTOINDEX_DIR}\n`
      : `${content}\n${ONTOINDEX_DIR}\n`;
    await fs.writeFile(gitignorePath, newContent, 'utf-8');
  } catch {
    // .gitignore doesn't exist, create it
    await fs.writeFile(gitignorePath, `${ONTOINDEX_DIR}\n`, 'utf-8');
  }
};

// ─── Global Registry (~/.ontoindex/registry.json) ───────────────────────

/**
 * Get the path to the global OntoIndex directory
 */
export const getGlobalDir = (): string => {
  return process.env.ONTOINDEX_HOME || path.join(os.homedir(), '.ontoindex');
};

/**
 * Get the path to the global registry file
 */
export const getGlobalRegistryPath = (): string => {
  return path.join(getGlobalDir(), 'registry.json');
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    if (errorCode(err) === 'ESRCH') return false;
    return true;
  }
}

async function removeRegistryLockIfOwner(
  lockPath: string,
  expectedPid: number,
  expectedToken: unknown = LOCK_TOKEN_ABSENT,
): Promise<boolean> {
  try {
    const current = JSON.parse(await fs.readFile(lockPath, 'utf-8'));
    if (current?.pid !== expectedPid) return false;
    if (expectedToken === LOCK_TOKEN_ABSENT) {
      if (current?.token !== undefined) return false;
    } else if (!lockTokensEqual(current?.token, expectedToken)) {
      return false;
    }
    await fs.unlink(lockPath);
    return true;
  } catch {
    return false;
  }
}

function lockTokensEqual(actual: unknown, expected: unknown): boolean {
  if (Object.is(actual, expected)) return true;
  if (
    actual !== null &&
    expected !== null &&
    typeof actual === 'object' &&
    typeof expected === 'object'
  ) {
    try {
      return JSON.stringify(actual) === JSON.stringify(expected);
    } catch {
      return false;
    }
  }
  return false;
}

function lockTokenFromExisting(existing: ParsedRegistryLock | null): unknown {
  return Object.prototype.hasOwnProperty.call(existing ?? {}, 'token')
    ? existing.token
    : LOCK_TOKEN_ABSENT;
}

async function acquireExclusiveFile(
  lockPath: string,
  timeoutMs: number,
): Promise<(() => Promise<void>) | null> {
  const token = `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    try {
      const handle = await fs.open(lockPath, 'wx');
      const created = await handle.stat();
      try {
        await handle.writeFile(
          JSON.stringify({ pid: process.pid, token, startedAt: new Date().toISOString() }, null, 2),
          'utf-8',
        );
        await handle.close();
      } catch (error) {
        try {
          const current = await fs.lstat(lockPath);
          if (current.dev === created.dev && current.ino === created.ino) await fs.unlink(lockPath);
        } catch {}
        await handle.close().catch(() => {});
        throw error;
      }
      let released = false;
      return async () => {
        if (released) return;
        const removed = await removeRegistryLockIfOwner(lockPath, process.pid, token);
        if (!removed) {
          throw new Error(`Failed to release owned lock: ${lockPath}`);
        }
        released = true;
      };
    } catch (err: unknown) {
      if (errorCode(err) !== 'EEXIST') throw err;

      let existing: ParsedRegistryLock | null = null;
      try {
        existing = JSON.parse(await fs.readFile(lockPath, 'utf-8'));
      } catch {}

      const pid = typeof existing?.pid === 'number' ? existing.pid : null;
      const startedAt =
        typeof existing?.startedAt === 'string' ? Date.parse(existing.startedAt) : NaN;
      let lockAgeMs = Number.isFinite(startedAt) ? Date.now() - startedAt : Number.NaN;
      if (!Number.isFinite(lockAgeMs)) {
        try {
          const stat = await fs.stat(lockPath);
          lockAgeMs = Date.now() - stat.mtimeMs;
        } catch {}
      }

      const staleByAge = Number.isFinite(lockAgeMs) && lockAgeMs > REGISTRY_LOCK_STALE_MS;
      if (pid !== null && !isProcessAlive(pid)) {
        const staleToken = lockTokenFromExisting(existing);
        if (await removeRegistryLockIfOwner(lockPath, pid, staleToken)) continue;
      } else if (pid === null && staleByAge) {
        try {
          await fs.unlink(lockPath);
          continue;
        } catch {}
      }

      await sleep(REGISTRY_LOCK_RETRY_MS);
    }
  }

  return null;
}

async function tryReclaimRegistryLock(lockPath: string): Promise<boolean> {
  const releaseReclaim = await acquireExclusiveFile(
    `${lockPath}.reclaim`,
    REGISTRY_RECLAIM_LOCK_TIMEOUT_MS,
  );
  if (!releaseReclaim) return false;

  try {
    let existing: ParsedRegistryLock | null = null;
    try {
      existing = JSON.parse(await fs.readFile(lockPath, 'utf-8'));
    } catch {}

    const pid = typeof existing?.pid === 'number' ? existing.pid : null;
    const startedAt =
      typeof existing?.startedAt === 'string' ? Date.parse(existing.startedAt) : NaN;
    let lockAgeMs = Number.isFinite(startedAt) ? Date.now() - startedAt : Number.NaN;
    if (!Number.isFinite(lockAgeMs)) {
      try {
        const stat = await fs.stat(lockPath);
        lockAgeMs = Date.now() - stat.mtimeMs;
      } catch {
        return false;
      }
    }

    const staleByAge = Number.isFinite(lockAgeMs) && lockAgeMs > REGISTRY_LOCK_STALE_MS;
    if (pid !== null) {
      if (isProcessAlive(pid)) return false;
      const staleToken = lockTokenFromExisting(existing);
      return await removeRegistryLockIfOwner(lockPath, pid, staleToken);
    }
    if (!staleByAge) return false;

    try {
      await fs.unlink(lockPath);
      return true;
    } catch {
      return false;
    }
  } finally {
    await releaseReclaim();
  }
}

async function acquireRegistryLock(): Promise<() => Promise<void>> {
  const dir = getGlobalDir();
  await fs.mkdir(dir, { recursive: true });
  const lockPath = path.join(dir, 'registry.json.lock');
  const token = `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
  const started = Date.now();

  while (Date.now() - started < REGISTRY_LOCK_TIMEOUT_MS) {
    try {
      const handle = await fs.open(lockPath, 'wx');
      const created = await handle.stat();
      try {
        await handle.writeFile(
          JSON.stringify({ pid: process.pid, token, startedAt: new Date().toISOString() }, null, 2),
          'utf-8',
        );
        await handle.close();
      } catch (error) {
        try {
          const current = await fs.lstat(lockPath);
          if (current.dev === created.dev && current.ino === created.ino) await fs.unlink(lockPath);
        } catch {}
        await handle.close().catch(() => {});
        throw error;
      }
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        await removeRegistryLockIfOwner(lockPath, process.pid, token);
      };
    } catch (err: unknown) {
      if (errorCode(err) !== 'EEXIST') throw err;

      if (await tryReclaimRegistryLock(lockPath)) continue;

      await sleep(REGISTRY_LOCK_RETRY_MS);
    }
  }

  throw new Error(`Timed out waiting for registry lock: ${lockPath}`);
}

async function withRegistryMutation<T>(fn: () => Promise<T>): Promise<T> {
  const release = await acquireRegistryLock();
  try {
    return await fn();
  } finally {
    await release();
  }
}

/**
 * Read the global registry. Returns empty array if not found.
 */
export const readRegistry = async (): Promise<RegistryEntry[]> => {
  try {
    const raw = await fs.readFile(getGlobalRegistryPath(), 'utf-8');
    const data = JSON.parse(raw);
    if (!Array.isArray(data)) {
      throw new Error('registry.json must contain an array');
    }
    return data;
  } catch (err: unknown) {
    if (errorCode(err) === 'ENOENT') return [];
    throw new Error(
      `Failed to read OntoIndex registry at ${getGlobalRegistryPath()}: ${errorMessage(err)}`,
    );
  }
};

/**
 * Write the global registry to disk
 */
const writeRegistry = async (entries: RegistryEntry[]): Promise<void> => {
  const dir = getGlobalDir();
  await fs.mkdir(dir, { recursive: true });
  const registryPath = getGlobalRegistryPath();
  const tmpPath = path.join(
    dir,
    `registry.json.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`,
  );
  try {
    await fs.writeFile(tmpPath, JSON.stringify(entries, null, 2), 'utf-8');
    await fs.rename(tmpPath, registryPath);
  } catch (err) {
    await fs.rm(tmpPath, { force: true }).catch(() => {});
    throw err;
  }
};

/**
 * Options for {@link registerRepo}. All optional — callers without any
 * disambiguation requirement can keep calling `registerRepo(path, meta)`
 * unchanged.
 */
interface RegisterRepoOptions {
  /**
   * User-provided alias from `analyze --name <alias>` (#829). Overrides
   * the default basename-derived registry `name`. Persisted — subsequent
   * re-analyses of the same path without `--name` preserve the alias.
   */
  name?: string;
  /** Deprecated compatibility field. Duplicate names are always rejected. */
  allowDuplicateName?: boolean;
}

/**
 * Thrown by {@link registerRepo} when a requested name is already in
 * use by a DIFFERENT path. The CLI layer surfaces this as an actionable
 * error instead of relying on `.message` string-matching.
 *
 * The colliding alias is exposed as `err.registryName` (not `err.name`).
 * `err.name` keeps its inherited `Error.prototype.name` semantics (the
 * class name) so downstream code can do the usual `err.name ===
 * 'RegistryNameCollisionError'` checks; use the `kind` discriminant or
 * `instanceof RegistryNameCollisionError` for type-safe narrowing.
 */
export class RegistryNameCollisionError extends Error {
  readonly kind = 'RegistryNameCollisionError' as const;
  constructor(
    public readonly registryName: string,
    public readonly existingPath: string,
    public readonly requestedPath: string,
  ) {
    super(
      `Registry name "${registryName}" is already used by "${existingPath}".\n` +
        `Pass --name <unique-alias> to register "${requestedPath}" under a different name.`,
    );
    this.name = 'RegistryNameCollisionError';
  }
}

/** Returns true when a previously-registered entry's `name` differs from
 *  both `path.basename(entry.path)` and the git-remote-derived name —
 *  i.e. a user explicitly aliased it via `analyze --name <alias>` on a
 *  prior run. Used to preserve the alias across re-analyses that omit
 *  `--name`. The remote-derived name is treated as an inference, not a
 *  custom alias, so re-analyses keep tracking remote renames.
 *
 *  `inferredName` is passed in (rather than re-derived) so callers can
 *  avoid a second `git config` subprocess invocation. */
const hasCustomAlias = (entry: RegistryEntry, inferredName: string | null): boolean => {
  const resolved = path.resolve(entry.path);
  if (entry.name === path.basename(resolved)) return false;
  if (inferredName && entry.name === inferredName) return false;
  return true;
};

/**
 * Register (add or update) a repo in the global registry.
 * Called after `ontoindex analyze` completes.
 *
 * Name resolution precedence (#829, #979):
 *   1. explicit `opts.name` (from `analyze --name <alias>`)
 *   2. preserved alias on an existing entry for this path
 *   3. `git config --get remote.origin.url` repo name (#979 — recovers
 *      a meaningful name for monorepo subprojects, git worktrees, and
 *      Gas-Town-style `<rig>/refinery/rig/` layouts where the basename
 *      is generic)
 *   4. `path.basename(repoPath)` (the original default)
 *
 * Duplicate-name guard: if another path already uses the resolved
 * `name`, throw {@link RegistryNameCollisionError}. Existing duplicate
 * registry entries remain readable, but no new ambiguity is introduced.
 *
 * Returns the `name` that was actually written to the registry — the
 * caller can re-use it to keep AGENTS.md / skill files aligned with the
 * MCP-visible repo name (#979).
 */
export const registerRepo = async (
  repoPath: string,
  meta: RepoMeta,
  opts?: RegisterRepoOptions,
): Promise<string> => {
  return withRegistryMutation(async () => {
    const resolved = await canonicalRepoPath(repoPath);
    const { storagePath } = getStoragePaths(resolved);

    const entries = await readRegistry();
    const canonicalEntryPaths = await Promise.all(
      entries.map((entry) => canonicalRepoPath(entry.path)),
    );
    const existingIdx = canonicalEntryPaths.findIndex((entryPath) =>
      sameRepoPath(entryPath, resolved),
    );
    const existing = existingIdx >= 0 ? entries[existingIdx] : null;

    // Precedence: explicit --name > preserved alias > remote-inferred > basename.
    // Skip the `git config` subprocess entirely when --name was passed —
    // the remote isn't consulted in that case.
    let name: string;
    let isPreservedAlias = false;
    if (opts?.name !== undefined) {
      name = opts.name;
    } else {
      // Compute the remote-derived name at most once. It feeds both the
      // alias-preservation check (`hasCustomAlias` needs it to distinguish
      // a sticky user alias from a previously-stored remote inference) and
      // the fallback name when neither --name nor a preserved alias apply.
      const inferred = getInferredRepoName(resolved);
      if (existing && hasCustomAlias(existing, inferred)) {
        name = existing.name;
        isPreservedAlias = true;
      } else {
        name = inferred ?? path.basename(resolved);
      }
    }

    const collidingEntry = entries.find(
      (e, i) =>
        i !== existingIdx &&
        e.name.toLowerCase() === name.toLowerCase() &&
        !sameRepoPath(canonicalEntryPaths[i], resolved),
    );
    if (collidingEntry) {
      throw new RegistryNameCollisionError(name, collidingEntry.path, resolved);
    }

    const entry: RegistryEntry = {
      name,
      path: resolved,
      storagePath,
      indexedAt: meta.indexedAt,
      lastCommit: meta.lastCommit,
      stats: meta.stats,
    };

    if (existingIdx >= 0) {
      entries[existingIdx] = entry;
    } else {
      entries.push(entry);
    }

    await writeRegistry(entries);
    return name;
  });
};

/**
 * Remove a repo from the global registry.
 * Called after `ontoindex clean`.
 */
export const unregisterRepo = async (repoPath: string): Promise<void> => {
  await withRegistryMutation(async () => {
    const resolved = await canonicalRepoPath(repoPath);
    const entries = await readRegistry();
    const canonicalEntryPaths = await Promise.all(
      entries.map((entry) => canonicalRepoPath(entry.path)),
    );
    const filtered = entries.filter(
      (_, index) => !sameRepoPath(canonicalEntryPaths[index], resolved),
    );
    await writeRegistry(filtered);
  });
};

/**
 * List all registered repos from the global registry.
 * Optionally validates that each entry's .ontoindex/ still exists.
 */
export const listRegisteredRepos = async (opts?: {
  validate?: boolean;
}): Promise<RegistryEntry[]> => {
  const entries = await readRegistry();
  if (!opts?.validate) return entries;

  // Validate each entry still has a .ontoindex/ directory
  const valid: RegistryEntry[] = [];
  for (const entry of entries) {
    try {
      await fs.access(path.join(entry.storagePath, 'meta.json'));
      valid.push(entry);
    } catch {
      // Index no longer exists — skip
    }
  }

  if (valid.length !== entries.length) {
    return withRegistryMutation(async () => {
      const latest = await readRegistry();
      const latestValid: RegistryEntry[] = [];
      for (const entry of latest) {
        try {
          await fs.access(path.join(entry.storagePath, 'meta.json'));
          latestValid.push(entry);
        } catch {
          // Index no longer exists — skip
        }
      }
      await writeRegistry(latestValid);
      return latestValid;
    });
  }

  return valid;
};

// ─── Global CLI Config (~/.ontoindex/config.json) ─────────────────────────

interface CLIConfig {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  provider?: 'openai' | 'openrouter' | 'azure' | 'custom' | 'cursor';
  cursorModel?: string;
  /** Azure api-version query param (e.g. '2024-10-21'). Only used when provider is 'azure'. */
  apiVersion?: string;
  /** Set true when the deployment is a reasoning model (o1, o3, o4-mini). Auto-detected for OpenAI; must be set for Azure deployments. */
  isReasoningModel?: boolean;
}

/**
 * Get the path to the global CLI config file
 */
const getGlobalConfigPath = (): string => {
  return path.join(getGlobalDir(), 'config.json');
};

/**
 * Load CLI config from ~/.ontoindex/config.json
 */
export const loadCLIConfig = async (): Promise<CLIConfig> => {
  try {
    const raw = await fs.readFile(getGlobalConfigPath(), 'utf-8');
    return JSON.parse(raw) as CLIConfig;
  } catch {
    return {};
  }
};

/**
 * Save CLI config to ~/.ontoindex/config.json
 */
export const saveCLIConfig = async (config: CLIConfig): Promise<void> => {
  const dir = getGlobalDir();
  await fs.mkdir(dir, { recursive: true });
  const configPath = getGlobalConfigPath();
  await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf-8');
  // Restrict file permissions on Unix (config may contain API keys)
  if (process.platform !== 'win32') {
    try {
      await fs.chmod(configPath, 0o600);
    } catch {
      /* best-effort */
    }
  }
};
