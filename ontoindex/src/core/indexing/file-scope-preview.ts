import path from 'node:path';

import { explainPathScope, type FileScopeExplanation } from '../../config/ignore-service.js';
import { walkRepositoryPaths } from '../ingestion/filesystem-walker.js';

export interface FileScopePreview {
  repoPath: string;
  totalCandidates: number;
  includedCount: number;
  skippedCount: number;
  includedByExtension: Record<string, number>;
  topSkippedDirectories: Array<{ path: string; count: number; reason: string }>;
  largestIncludedFiles: Array<{ path: string; bytes: number }>;
  warnings: string[];
}

export interface CollectFileScopePreviewOptions {
  limit?: number;
  includePaths?: string[];
}

const DEFAULT_LIMIT = 10;

export async function collectFileScopePreview(
  repoPath: string,
  options: CollectFileScopePreviewOptions = {},
): Promise<FileScopePreview> {
  const limit = Math.max(1, Math.min(options.limit ?? DEFAULT_LIMIT, 100));
  const files = await walkRepositoryPaths(repoPath, undefined, {
    includePaths: options.includePaths,
  });

  const includedByExtension: Record<string, number> = {};
  const warnings: string[] = [];

  for (const file of files) {
    const ext = extensionKey(file.path);
    includedByExtension[ext] = (includedByExtension[ext] ?? 0) + 1;
    const warning = suspiciousIncludedWarning(file.path);
    if (warning) warnings.push(warning);
  }

  return {
    repoPath,
    totalCandidates: files.length,
    includedCount: files.length,
    skippedCount: 0,
    includedByExtension: sortRecord(includedByExtension),
    topSkippedDirectories: [],
    largestIncludedFiles: files
      .slice()
      .sort((a, b) => b.size - a.size)
      .slice(0, limit)
      .map((file) => ({ path: file.path, bytes: file.size })),
    warnings: warnings.slice(0, limit),
  };
}

export { explainPathScope, type FileScopeExplanation };

function extensionKey(filePath: string): string {
  if (filePath.toLowerCase().endsWith('.d.ts')) return '.d.ts';
  return path.extname(filePath).toLowerCase() || '<none>';
}

function suspiciousIncludedWarning(filePath: string): string | null {
  const normalized = filePath.replace(/\\/g, '/').toLowerCase();
  if (/(^|\/)(dist|build|node_modules)(\/|$)/.test(normalized)) {
    return `suspicious-include:${filePath}`;
  }
  if (/(^|\/)\.env(?:\.|$)/.test(normalized)) {
    return `secret-like-include:${filePath}`;
  }
  if (/\.(?:bundle|chunk|min)\./.test(normalized)) {
    return `generated-like-include:${filePath}`;
  }
  return null;
}

function sortRecord(record: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(record).sort((a, b) => a[0].localeCompare(b[0])));
}
