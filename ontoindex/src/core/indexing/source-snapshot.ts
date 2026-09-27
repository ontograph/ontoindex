/**
 * Frozen source snapshot for analysis.
 *
 * Analysis reads the working tree for minutes. Without a snapshot, any edit in
 * that window forces the result to be discarded ("Source inputs changed during
 * analysis"). A snapshot copies exactly the files the scanner would select
 * into a private directory, so the analyzed bytes, the source manifest, and
 * the published graph all describe one consistent state regardless of later
 * edits to the live tree.
 *
 * Fidelity contract: `computeSourceManifest(snapshot.root)` must equal the
 * manifest of the live tree at copy time. To keep that true the snapshot also
 * reproduces ignore-policy files, oversized files (as sparse placeholders of
 * the same size, which the scanner skips again), and dangling symlinks. When
 * a faithful copy is impossible the snapshot is refused and callers analyze
 * the live tree instead.
 */

import { randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

import type { PipelineProfile } from '../ingestion/pipeline.js';
import {
  normalizeRepositoryIncludePaths,
  walkRepositoryPaths,
  type ScannedFile,
} from '../ingestion/filesystem-walker.js';
import { computeSourceManifest, type IndexSourceManifest } from './source-manifest.js';

export const SOURCE_SNAPSHOTS_DIR = 'source-snapshots';
const IGNORE_POLICY_FILES = ['.gitignore', '.ontoindexignore'] as const;
const COPY_CONCURRENCY = 32;
const DEFAULT_MAX_SNAPSHOT_MB = 2048;

export type SourceSnapshotMode = 'auto' | 'always' | 'never';

/**
 * `ONTOINDEX_ANALYZE_SNAPSHOT`: `1`/`always` snapshots every analysis,
 * `0`/`never` disables snapshots, anything else (`auto`) snapshots managed
 * analysis jobs and interactive runs on a dirty Git worktree.
 */
export function resolveSourceSnapshotMode(
  raw = process.env.ONTOINDEX_ANALYZE_SNAPSHOT,
): SourceSnapshotMode {
  const value = raw?.trim().toLowerCase();
  if (value === '1' || value === 'true' || value === 'always') return 'always';
  if (value === '0' || value === 'false' || value === 'never') return 'never';
  return 'auto';
}

export interface SourceSnapshotDecisionInput {
  mode: SourceSnapshotMode;
  /** A readable Git HEAD exists; snapshots are labeled with it. */
  hasCommit: boolean;
  managed: boolean;
  /**
   * Interactive `auto` runs only: whether the worktree has uncommitted or
   * untracked changes. `undefined` means the probe was skipped or failed.
   */
  worktreeDirty?: boolean;
}

/**
 * Whether to analyze a frozen snapshot. In `auto` mode, managed jobs always
 * snapshot; interactive runs snapshot when the worktree is dirty, because
 * that is when concurrent edits (another session, an editor) can change the
 * sources under analysis and abort publication. A clean interactive run keeps
 * analyzing the live tree to avoid the copy.
 */
export function shouldSnapshotSources(input: SourceSnapshotDecisionInput): boolean {
  if (!input.hasCommit || input.mode === 'never') return false;
  if (input.mode === 'always' || input.managed) return true;
  return input.worktreeDirty === true;
}

function maxSnapshotBytes(): number {
  const raw = Number(process.env.ONTOINDEX_ANALYZE_SNAPSHOT_MAX_MB);
  const mb = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_SNAPSHOT_MB;
  return Math.floor(mb * 1024 * 1024);
}

/** A faithful snapshot could not be produced; callers fall back to the live tree. */
export class SourceSnapshotUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'SourceSnapshotUnavailableError';
  }
}

export interface SourceSnapshot {
  /** Absolute snapshot root to analyze instead of the live repository. */
  root: string;
  /** Manifest of the snapshot bytes, with `head` taken from the live repository. */
  manifest: IndexSourceManifest;
  fileCount: number;
  bytes: number;
  dispose(): Promise<void>;
}

export interface CreateSourceSnapshotOptions {
  includePaths?: readonly string[];
  pipelineProfile?: PipelineProfile;
  /** Live repository HEAD recorded in the manifest (the snapshot has no .git). */
  head: string | null;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isNodeError(error) && error.code === 'EPERM';
  }
}

/** Remove snapshots left behind by analysis processes that no longer exist. */
export async function reapStaleSourceSnapshots(snapshotsDir: string): Promise<string[]> {
  const removed: string[] = [];
  let names: string[];
  try {
    names = await fs.readdir(snapshotsDir);
  } catch {
    return removed;
  }
  for (const name of names) {
    const pid = Number.parseInt(name.split('-')[0] ?? '', 10);
    if (!Number.isSafeInteger(pid) || pid <= 0) continue;
    if (pid === process.pid || isProcessAlive(pid)) continue;
    await fs.rm(path.join(snapshotsDir, name), { recursive: true, force: true }).catch(() => {});
    removed.push(name);
  }
  return removed;
}

async function runPool<T>(items: readonly T[], worker: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const runners = Array.from({ length: Math.min(COPY_CONCURRENCY, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++];
      await worker(item);
    }
  });
  await Promise.all(runners);
}

async function copySelectedFile(repoPath: string, root: string, entry: ScannedFile): Promise<void> {
  const source = path.join(repoPath, entry.path);
  const target = path.join(root, entry.path);
  try {
    // Reflink where the filesystem supports it, byte copy otherwise. A plain
    // hardlink would share the inode, so in-place edits would leak through.
    await fs.copyFile(source, target, fsConstants.COPYFILE_FICLONE);
  } catch (error) {
    // Deleted after the scan: the snapshot reflects the deletion.
    if (isNodeError(error) && error.code === 'ENOENT') return;
    throw new SourceSnapshotUnavailableError(`could not copy ${entry.path}`, { cause: error });
  }
}

async function reproduceOversizedFile(root: string, entry: ScannedFile): Promise<void> {
  // Same size, no data: the scanner skips it again as oversized and records
  // the same degraded path, without the snapshot paying for its bytes.
  const handle = await fs.open(path.join(root, entry.path), 'w');
  try {
    await handle.truncate(entry.size);
  } finally {
    await handle.close();
  }
}

async function reproduceUnreadableFile(
  repoPath: string,
  root: string,
  entry: ScannedFile,
): Promise<void> {
  const source = path.join(repoPath, entry.path);
  let stat;
  try {
    stat = await fs.lstat(source);
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return;
    throw new SourceSnapshotUnavailableError(`could not inspect ${entry.path}`, { cause: error });
  }
  if (!stat.isSymbolicLink()) {
    throw new SourceSnapshotUnavailableError(`unreadable source file ${entry.path}`);
  }
  await fs.symlink(await fs.readlink(source), path.join(root, entry.path));
}

export async function createSourceSnapshot(
  repoPath: string,
  storagePath: string,
  options: CreateSourceSnapshotOptions,
): Promise<SourceSnapshot> {
  const snapshotsDir = path.join(storagePath, SOURCE_SNAPSHOTS_DIR);
  await fs.mkdir(snapshotsDir, { recursive: true, mode: 0o700 });
  await reapStaleSourceSnapshots(snapshotsDir);
  const root = path.join(snapshotsDir, `${process.pid}-${randomUUID()}`);
  await fs.mkdir(root, { mode: 0o700 });
  const dispose = () => fs.rm(root, { recursive: true, force: true });

  try {
    const includePaths = await normalizeRepositoryIncludePaths(repoPath, options.includePaths);
    const oversized: ScannedFile[] = [];
    const unreadable: ScannedFile[] = [];
    const entries = await walkRepositoryPaths(repoPath, undefined, {
      includePaths,
      onSkippedLargeFile: (file) => oversized.push(file),
      onUnreadableFile: (file) => unreadable.push(file),
    });

    const bytes = entries.reduce((sum, entry) => sum + entry.size, 0);
    const limit = maxSnapshotBytes();
    if (bytes > limit) {
      throw new SourceSnapshotUnavailableError(
        `selected sources are ${Math.ceil(bytes / 1024 / 1024)} MB, above the ${Math.floor(limit / 1024 / 1024)} MB snapshot limit (ONTOINDEX_ANALYZE_SNAPSHOT_MAX_MB)`,
      );
    }

    const dirs = new Set<string>();
    for (const entry of [...entries, ...oversized, ...unreadable]) {
      dirs.add(path.dirname(path.join(root, entry.path)));
    }
    for (const dir of [...dirs].sort()) await fs.mkdir(dir, { recursive: true });

    await runPool(entries, (entry) => copySelectedFile(repoPath, root, entry));
    for (const entry of oversized) await reproduceOversizedFile(root, entry);
    for (const entry of unreadable) await reproduceUnreadableFile(repoPath, root, entry);
    for (const filename of IGNORE_POLICY_FILES) {
      await fs.copyFile(path.join(repoPath, filename), path.join(root, filename)).catch((error) => {
        if (!(isNodeError(error) && error.code === 'ENOENT')) throw error;
      });
    }
    for (const includePath of includePaths) {
      if (includePath === '.' || includePath === './') continue;
      const target = path.join(root, includePath);
      if (includePath.endsWith('/')) {
        await fs.mkdir(target, { recursive: true });
      } else if (
        !(await fs.stat(target).then(
          () => true,
          () => false,
        ))
      ) {
        throw new SourceSnapshotUnavailableError(`include path ${includePath} was not captured`);
      }
    }

    const manifest = await computeSourceManifest(root, {
      includePaths,
      pipelineProfile: options.pipelineProfile,
    });
    return {
      root,
      manifest: { ...manifest, head: options.head },
      fileCount: entries.length,
      bytes,
      dispose,
    };
  } catch (error) {
    await dispose().catch(() => {});
    if (error instanceof SourceSnapshotUnavailableError) throw error;
    throw new SourceSnapshotUnavailableError(
      error instanceof Error ? error.message : String(error),
      { cause: error },
    );
  }
}
