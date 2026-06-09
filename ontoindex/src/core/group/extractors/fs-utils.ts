import * as fs from 'node:fs';
import * as path from 'node:path';

function clampPositiveInt(raw: string | undefined, fallback: number, max: number): number {
  const n = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(n, max));
}

export const MAX_EXTRACTOR_FILE_BYTES = clampPositiveInt(
  process.env.ONTOINDEX_GROUP_EXTRACTOR_MAX_FILE_BYTES,
  1024 * 1024,
  32 * 1024 * 1024,
);

export const MAX_EXTRACTOR_SCAN_FILES = clampPositiveInt(
  process.env.ONTOINDEX_GROUP_EXTRACTOR_MAX_FILES,
  20_000,
  1_000_000,
);

/**
 * Safely read a file inside a repo, rejecting any path that escapes
 * `repoPath` via `..` traversal or absolute segments. Returns `null` if
 * the path is outside the repo, too large, or can't be read.
 *
 * Used by every source-scan extractor under this directory. Kept as a
 * single shared implementation so the path-traversal guard (security-
 * sensitive) lives in exactly one place.
 */
export function readSafe(repoPath: string, rel: string): string | null {
  const abs = path.resolve(repoPath, rel);
  const base = path.resolve(repoPath);
  const relToBase = path.relative(base, abs);
  if (relToBase.startsWith('..') || path.isAbsolute(relToBase)) return null;
  try {
    const stat = fs.statSync(abs);
    if (!stat.isFile() || stat.size > MAX_EXTRACTOR_FILE_BYTES) return null;
    return fs.readFileSync(abs, 'utf-8');
  } catch {
    return null;
  }
}

export function capScanFiles(files: string[], label: string): string[] {
  if (files.length <= MAX_EXTRACTOR_SCAN_FILES) return files;
  console.warn(
    `[group:${label}] matched ${files.length} files; scanning first ${MAX_EXTRACTOR_SCAN_FILES}. Set ONTOINDEX_GROUP_EXTRACTOR_MAX_FILES to adjust.`,
  );
  return files.slice(0, MAX_EXTRACTOR_SCAN_FILES);
}
