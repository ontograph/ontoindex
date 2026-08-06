import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import type { PipelineProfile } from '../ingestion/pipeline.js';
import {
  normalizeRepositoryIncludePaths,
  walkRepositoryPaths,
} from '../ingestion/filesystem-walker.js';
import { getCurrentCommit, hasGitDir } from '../../storage/git.js';

export const SOURCE_MANIFEST_VERSION = 1 as const;
export const SOURCE_MANIFEST_CONTRACT = 'ontoindex-source-manifest-v1';
export const IGNORE_POLICY_VERSION = 'ignore-service-v1';

export interface IndexSourceManifest {
  version: typeof SOURCE_MANIFEST_VERSION;
  head: string | null;
  sourceDigest: string;
  sourceEntryCount: number;
  includePaths: string[];
  scopeDigest: string;
  ignorePolicyDigest: string;
  pipelineProfile: PipelineProfile;
  analyzerContractVersion: typeof SOURCE_MANIFEST_CONTRACT;
  coverage: 'complete' | 'degraded' | 'unknown';
  degradedInputsDigest?: string;
}

export interface ComputeSourceManifestOptions {
  includePaths?: readonly string[];
  pipelineProfile?: PipelineProfile;
  degradedPaths?: readonly string[];
}

function normalizeManifestPath(value: string): string {
  return value.replace(/\\/g, '/');
}

function hashParts(parts: readonly string[]): string {
  const hash = createHash('sha256');
  for (const part of parts) {
    hash.update(String(Buffer.byteLength(part, 'utf8')));
    hash.update(':');
    hash.update(part);
    hash.update('\n');
  }
  return hash.digest('hex');
}

async function readIgnorePolicy(repoPath: string): Promise<string[]> {
  const parts = [
    IGNORE_POLICY_VERSION,
    `noGitignore=${process.env.ONTOINDEX_NO_GITIGNORE === '1'}`,
    `includeThirdParty=${process.env.ONTOINDEX_INCLUDE_THIRD_PARTY === '1'}`,
    `scanMaxFileKb=${process.env.ONTOINDEX_SCAN_MAX_FILE_KB ?? ''}`,
  ];
  for (const filename of ['.gitignore', '.ontoindexignore']) {
    try {
      parts.push(`${filename}\0${await fs.readFile(path.join(repoPath, filename), 'utf8')}`);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      parts.push(`${filename}\0`);
    }
  }
  return parts;
}

export async function computeSourceManifest(
  repoPath: string,
  options: ComputeSourceManifestOptions = {},
): Promise<IndexSourceManifest> {
  const includePaths = await normalizeRepositoryIncludePaths(repoPath, options.includePaths);
  const pipelineProfile = options.pipelineProfile ?? 'full';
  const scanDegradedPaths: string[] = [];
  const entries = await walkRepositoryPaths(repoPath, undefined, {
    includePaths,
    onSkippedLargeFile: (file) => scanDegradedPaths.push(file.path),
    onUnreadableFile: (file) => scanDegradedPaths.push(file.path),
  });
  entries.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));

  const sourceHash = createHash('sha256');
  let sourceEntryCount = 0;
  for (const entry of entries) {
    const fullPath = path.join(repoPath, entry.path);
    let content: Buffer;
    let stat;
    try {
      [content, stat] = await Promise.all([fs.readFile(fullPath), fs.stat(fullPath)]);
    } catch {
      scanDegradedPaths.push(entry.path);
      continue;
    }
    const normalizedPath = normalizeManifestPath(entry.path);
    sourceHash.update(String(Buffer.byteLength(normalizedPath, 'utf8')));
    sourceHash.update(':');
    sourceHash.update(normalizedPath);
    sourceHash.update('\0');
    sourceHash.update(stat.mode & 0o111 ? 'executable' : 'regular');
    sourceHash.update('\0');
    sourceHash.update(createHash('sha256').update(content).digest('hex'));
    sourceHash.update('\n');
    sourceEntryCount++;
  }

  const ignorePolicyDigest = hashParts(await readIgnorePolicy(repoPath));
  const scopeDigest = hashParts([
    SOURCE_MANIFEST_CONTRACT,
    pipelineProfile,
    JSON.stringify(includePaths),
    ignorePolicyDigest,
  ]);
  const degradedPaths = [
    ...new Set([...scanDegradedPaths, ...(options.degradedPaths ?? [])].map(normalizeManifestPath)),
  ].sort();

  return {
    version: SOURCE_MANIFEST_VERSION,
    head: hasGitDir(repoPath) ? getCurrentCommit(repoPath) || null : null,
    sourceDigest: sourceHash.digest('hex'),
    sourceEntryCount,
    includePaths,
    scopeDigest,
    ignorePolicyDigest,
    pipelineProfile,
    analyzerContractVersion: SOURCE_MANIFEST_CONTRACT,
    coverage: degradedPaths.length > 0 ? 'degraded' : 'complete',
    ...(degradedPaths.length > 0 ? { degradedInputsDigest: hashParts(degradedPaths) } : {}),
  };
}

export function manifestsMatch(
  left: IndexSourceManifest | null | undefined,
  right: IndexSourceManifest | null | undefined,
): boolean {
  return Boolean(
    left &&
    right &&
    left.version === right.version &&
    left.sourceDigest === right.sourceDigest &&
    left.sourceEntryCount === right.sourceEntryCount &&
    left.scopeDigest === right.scopeDigest &&
    left.pipelineProfile === right.pipelineProfile &&
    left.analyzerContractVersion === right.analyzerContractVersion &&
    left.coverage === right.coverage &&
    left.degradedInputsDigest === right.degradedInputsDigest,
  );
}

export function sourceInputsMatch(
  left: IndexSourceManifest | null | undefined,
  right: IndexSourceManifest | null | undefined,
): boolean {
  return Boolean(
    left &&
    right &&
    left.version === right.version &&
    left.sourceDigest === right.sourceDigest &&
    left.sourceEntryCount === right.sourceEntryCount &&
    left.scopeDigest === right.scopeDigest &&
    left.pipelineProfile === right.pipelineProfile &&
    left.analyzerContractVersion === right.analyzerContractVersion,
  );
}

export function sourceManifestDigest(manifest: IndexSourceManifest): string {
  return hashParts([
    String(manifest.version),
    manifest.sourceDigest,
    String(manifest.sourceEntryCount),
    manifest.scopeDigest,
    manifest.coverage,
    manifest.degradedInputsDigest ?? '',
  ]);
}
