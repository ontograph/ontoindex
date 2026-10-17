import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
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

export interface CapturedSourceEntry {
  path: string;
  byteLength: number;
  digest: string;
  executable: boolean;
}

export interface WorkspaceCaptureManifest {
  contract: 'ontoindex-workspace-input-v1';
  entries: CapturedSourceEntry[];
  configurationDigest: string;
  parserIdentity: string;
}

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
  workspaceCapture?: WorkspaceCaptureManifest;
}

export interface ComputeSourceManifestOptions {
  includePaths?: readonly string[];
  pipelineProfile?: PipelineProfile;
  degradedPaths?: readonly string[];
  capture?: {
    parserIdentity: string;
    configurationPaths: readonly string[];
    check: () => void;
    read: (relativePath: string) => Promise<{ content: Buffer; executable: boolean }>;
    onEntry?: (entry: CapturedSourceEntry, content: Buffer) => Promise<void>;
  };
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
    const filePath = path.join(repoPath, filename);
    try {
      const handle = await fs.open(
        filePath,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        const stat = await handle.stat();
        if (!stat.isFile()) {
          throw new Error(`Ignore file is not a regular file: ${filename}`);
        }
        parts.push(`${filename}\0${await handle.readFile('utf8')}`);
      } finally {
        await handle.close();
      }
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      parts.push(`${filename}\0`);
    }
  }
  return parts;
}

export async function workspaceIgnorePolicyDigest(repoPath: string): Promise<string> {
  return hashParts(await readIgnorePolicy(repoPath));
}

export function workspaceConfigurationDigest(
  entries: readonly CapturedSourceEntry[],
  ignorePolicyDigest: string,
): string {
  return hashParts([ignorePolicyDigest, ...entries.map((entry) => JSON.stringify(entry))]);
}

export async function computeSourceManifest(
  repoPath: string,
  options: ComputeSourceManifestOptions = {},
): Promise<IndexSourceManifest> {
  const includePaths = await normalizeRepositoryIncludePaths(repoPath, options.includePaths);
  const pipelineProfile = options.pipelineProfile ?? 'full';
  const scanDegradedPaths: string[] = [];
  const capture = options.capture;
  const entries = await walkRepositoryPaths(repoPath, capture ? () => capture.check() : undefined, {
    includePaths,
    onSkippedLargeFile: (file) => scanDegradedPaths.push(file.path),
    onUnreadableFile: (file) => scanDegradedPaths.push(file.path),
  });
  capture?.check();
  if (capture && scanDegradedPaths.length > 0) {
    throw new Error(
      `Workspace capture cannot read eligible inputs: ${scanDegradedPaths.join(', ')}`,
    );
  }
  if (capture) {
    for (const configurationPath of capture.configurationPaths) {
      if (!entries.some((entry) => entry.path === configurationPath)) {
        entries.push({ path: configurationPath, size: 0 });
      }
    }
  }
  entries.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));

  const sourceHash = createHash('sha256');
  let sourceEntryCount = 0;
  const capturedEntries: CapturedSourceEntry[] = [];
  for (const entry of entries) {
    capture?.check();
    const fullPath = path.join(repoPath, entry.path);
    let content: Buffer;
    let stat;
    try {
      if (capture) {
        const input = await capture.read(entry.path);
        content = input.content;
        stat = { mode: input.executable ? 0o100 : 0 };
      } else {
        [content, stat] = await Promise.all([fs.readFile(fullPath), fs.stat(fullPath)]);
      }
    } catch (error) {
      if (capture) throw error;
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
    const digest = createHash('sha256').update(content).digest('hex');
    sourceHash.update(digest);
    sourceHash.update('\n');
    sourceEntryCount++;
    if (capture) {
      const captured = {
        path: normalizedPath,
        byteLength: content.length,
        digest,
        executable: Boolean(stat.mode & 0o111),
      };
      capturedEntries.push(captured);
      await capture.onEntry?.(captured, content);
    }
  }

  const ignorePolicyDigest = await workspaceIgnorePolicyDigest(repoPath);
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
    ...(capture
      ? {
          workspaceCapture: {
            contract: 'ontoindex-workspace-input-v1' as const,
            entries: capturedEntries,
            configurationDigest: workspaceConfigurationDigest(
              capturedEntries.filter((entry) => capture.configurationPaths.includes(entry.path)),
              ignorePolicyDigest,
            ),
            parserIdentity: capture.parserIdentity,
          },
        }
      : {}),
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
    left.degradedInputsDigest === right.degradedInputsDigest &&
    // Capture proof is additive; a persisted v1 manifest is never capture proof.
    left?.workspaceCapture?.configurationDigest === right?.workspaceCapture?.configurationDigest &&
    left?.workspaceCapture?.parserIdentity === right?.workspaceCapture?.parserIdentity,
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
    left.analyzerContractVersion === right.analyzerContractVersion &&
    left.workspaceCapture?.configurationDigest === right.workspaceCapture?.configurationDigest &&
    left.workspaceCapture?.parserIdentity === right.workspaceCapture?.parserIdentity,
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
    ...(manifest.workspaceCapture
      ? [
          manifest.workspaceCapture.contract,
          manifest.workspaceCapture.configurationDigest,
          manifest.workspaceCapture.parserIdentity,
          JSON.stringify(manifest.workspaceCapture.entries),
        ]
      : []),
  ]);
}
