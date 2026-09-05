import { isVerboseIngestionEnabled } from './utils/verbose.js';
import fs from 'fs/promises';
import path from 'path';
import { globStream } from 'glob';
import { createIgnoreFilter } from '../../config/ignore-service.js';
import {
  getLanguageFromFilename,
  getLanguageFromShebang,
  type SupportedLanguages,
} from 'ontoindex-shared';

export interface FileEntry {
  path: string;
  content: string;
}

/** Lightweight entry — path + size from stat, no content in memory */
export interface ScannedFile {
  path: string;
  size: number;
  degraded?: boolean;
  /**
   * Content-aware fallback language for extensionless executable scripts,
   * detected from the first shebang line during scan. Only set when the path
   * yields no extension/basename language; extension detection always wins.
   */
  shebangLanguage?: SupportedLanguages | null;
}

export interface WalkRepositoryOptions {
  onSkippedLargeFile?: (file: ScannedFile) => void;
  onUnreadableFile?: (file: ScannedFile, error: unknown) => void;
  includePaths?: string[];
}

/** Path-only reference (for type signatures) */
export interface FilePath {
  path: string;
}

const READ_CONCURRENCY = 32;

/** Default discovery skip cap — large files are usually generated/vendored and crash tree-sitter */
const DEFAULT_MAX_FILE_SIZE = 512 * 1024;

const toPosixPath = (value: string): string => value.replace(/\\/g, '/');

/** Bytes read from the head of an extensionless file to inspect its shebang. */
const SHEBANG_PROBE_BYTES = 256;

/**
 * A `.git` marker only bounds a nested repository when it is a real one: a
 * worktree/submodule `.git` file, or a `.git` directory that holds `HEAD`.
 * Empty or partial `.git` directories are stray leftovers, and excluding their
 * parent would silently drop a first-party source tree from the index.
 */
async function isNestedGitMarker(markerPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(markerPath);
    if (!stat.isDirectory()) return true;
    await fs.stat(path.join(markerPath, 'HEAD'));
    return true;
  } catch {
    return false;
  }
}

async function findNestedGitRoots(
  repoPath: string,
  ignoreFilter: Awaited<ReturnType<typeof createIgnoreFilter>>,
): Promise<Set<string>> {
  const roots = new Set<string>();
  const ignoredMarkers: string[] = [];
  const markerIgnore = {
    ignored(p: Parameters<typeof ignoreFilter.ignored>[0]): boolean {
      const relative = toPosixPath(p.relative());
      if (p.name === '.git' && relative !== '.git') return false;
      return ignoreFilter.ignored(p);
    },
    childrenIgnored(p: Parameters<typeof ignoreFilter.childrenIgnored>[0]): boolean {
      if (p.name === '.git') return true;
      return ignoreFilter.childrenIgnored(p);
    },
  };
  for await (const entry of globStream('**/.git', {
    cwd: repoPath,
    dot: true,
    nodir: false,
    ignore: markerIgnore,
  })) {
    const relativeMarker = toPosixPath(String(entry));
    const parent = path.posix.dirname(relativeMarker);
    if (parent === '.') continue;
    if (await isNestedGitMarker(path.join(repoPath, relativeMarker))) {
      roots.add(parent);
    } else {
      ignoredMarkers.push(parent);
    }
  }
  if (ignoredMarkers.length > 0 && isVerboseIngestionEnabled()) {
    console.log(
      `[scan] Ignored ${ignoredMarkers.length} stray .git marker(s) without HEAD: ${ignoredMarkers
        .slice(0, 10)
        .join(', ')}`,
    );
  }
  return roots;
}

function isNestedGitPath(relativePath: string, roots: ReadonlySet<string>): boolean {
  for (const root of roots) {
    if (relativePath === root || relativePath.startsWith(`${root}/`)) return true;
  }
  return false;
}

/**
 * Bounded first-line detection for extensionless scripts. Reads at most
 * SHEBANG_PROBE_BYTES from the file head — never the whole file — and maps a
 * supported shebang (Python, Ruby, Node/JS, PHP) to its language. Returns null
 * for any read error, missing shebang, or unsupported interpreter (shell/bash
 * stay unsupported).
 */
async function detectShebangLanguage(fullPath: string): Promise<SupportedLanguages | null> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(fullPath, 'r');
    const buffer = Buffer.alloc(SHEBANG_PROBE_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, SHEBANG_PROBE_BYTES, 0);
    return getLanguageFromShebang(buffer.toString('utf8', 0, bytesRead));
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}

/** True when a path has no recognised extension or extensionless basename. */
function hasNoPathLanguage(relativePath: string): boolean {
  if (getLanguageFromFilename(relativePath) !== null) return false;
  const basename = relativePath.split('/').pop() ?? relativePath;
  // A leading-dot dotfile (.bashrc) has no extension; a trailing/middle dot does.
  return basename.lastIndexOf('.') <= 0;
}

function isPathInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative))
  );
}

export async function normalizeRepositoryIncludePaths(
  repoPath: string,
  includePaths?: readonly string[],
): Promise<string[]> {
  if (!includePaths || includePaths.length === 0) return [];

  const repoRoot = path.resolve(repoPath);
  const normalized: string[] = [];
  const seen = new Set<string>();

  for (const rawPath of includePaths) {
    const trimmed = rawPath.trim();
    if (!trimmed) {
      throw new Error('--include-path must not be empty');
    }

    const absolutePath = path.resolve(repoRoot, trimmed);
    if (!isPathInside(repoRoot, absolutePath)) {
      throw new Error(`--include-path must stay inside the repository: ${rawPath}`);
    }

    let stat;
    try {
      stat = await fs.stat(absolutePath);
    } catch {
      throw new Error(`--include-path does not exist: ${rawPath}`);
    }

    const relativePath = toPosixPath(path.relative(repoRoot, absolutePath));
    const includePath = relativePath === '' ? '.' : relativePath;
    const suffix = stat.isDirectory() && includePath !== '.' ? '/' : '';
    const key = `${includePath}${suffix}`;
    if (!seen.has(key)) {
      seen.add(key);
      normalized.push(key);
    }
  }

  return normalized;
}

function includePathToGlob(includePath: string): string {
  if (includePath === '.' || includePath === './') return '**/*';
  return includePath.endsWith('/') ? `${includePath}**/*` : includePath;
}

function getScanMaxFileSizeBytes(): number | null {
  const raw = process.env.ONTOINDEX_SCAN_MAX_FILE_KB;
  if (raw == null || raw.trim() === '') return DEFAULT_MAX_FILE_SIZE;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return DEFAULT_MAX_FILE_SIZE;
  return value === 0 ? null : Math.floor(value * 1024);
}

/**
 * Phase 1: Scan repository — stat files to get paths + sizes, no content loaded.
 * Memory: ~10MB for 100K files vs ~1GB+ with content.
 */
export const walkRepositoryPaths = async (
  repoPath: string,
  onProgress?: (current: number, total: number, filePath: string) => void,
  options?: WalkRepositoryOptions,
): Promise<ScannedFile[]> => {
  const ignoreFilter = await createIgnoreFilter(repoPath);
  const nestedGitRoots = await findNestedGitRoots(repoPath, ignoreFilter);
  const scanIgnore = {
    ignored(p: Parameters<typeof ignoreFilter.ignored>[0]): boolean {
      const relative = toPosixPath(p.relative());
      return isNestedGitPath(relative, nestedGitRoots) || ignoreFilter.ignored(p);
    },
    childrenIgnored(p: Parameters<typeof ignoreFilter.childrenIgnored>[0]): boolean {
      const relative = toPosixPath(p.relative());
      return isNestedGitPath(relative, nestedGitRoots) || ignoreFilter.childrenIgnored(p);
    },
  };
  const maxFileSizeBytes = getScanMaxFileSizeBytes();
  const includePaths = await normalizeRepositoryIncludePaths(repoPath, options?.includePaths);
  const includeGlobs = includePaths.length > 0 ? includePaths.map(includePathToGlob) : ['**/*'];

  const entries: ScannedFile[] = [];
  const seenEntries = new Set<string>();
  let processed = 0;
  let skippedLarge = 0;
  const skippedLargePaths: string[] = [];

  let batch: string[] = [];
  const flushBatch = async () => {
    if (batch.length === 0) return;
    const currentBatch = batch;
    batch = [];
    const results = await Promise.allSettled(
      currentBatch.map(async (relativePath) => {
        const fullPath = path.join(repoPath, relativePath);
        const stat = await fs.stat(fullPath);
        const skippedPath = relativePath.replace(/\\/g, '/');
        if (seenEntries.has(skippedPath)) {
          return null;
        }
        seenEntries.add(skippedPath);
        if (maxFileSizeBytes !== null && stat.size > maxFileSizeBytes) {
          skippedLarge++;
          skippedLargePaths.push(skippedPath);
          const file = { path: skippedPath, size: stat.size };
          options?.onSkippedLargeFile?.(file);
          return null;
        }
        // Extensionless scripts: attach a bounded shebang-detected language so
        // downstream parse routing can pick them up without re-reading later.
        // Extension/basename detection always wins, so only probe when the path
        // yields no language of its own.
        const shebangLanguage = hasNoPathLanguage(skippedPath)
          ? await detectShebangLanguage(fullPath)
          : undefined;
        return shebangLanguage
          ? { path: skippedPath, size: stat.size, shebangLanguage }
          : { path: skippedPath, size: stat.size };
      }),
    );

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      processed++;
      if (result.status === 'fulfilled' && result.value !== null) {
        entries.push(result.value);
        onProgress?.(processed, processed, result.value.path);
      } else {
        if (result.status === 'rejected') {
          options?.onUnreadableFile?.(
            { path: currentBatch[i].replace(/\\/g, '/'), size: 0, degraded: true },
            result.reason,
          );
        }
        onProgress?.(processed, processed, currentBatch[i]);
      }
    }
  };

  for await (const entry of globStream(includeGlobs, {
    cwd: repoPath,
    nodir: true,
    dot: true,
    ignore: scanIgnore,
  })) {
    batch.push(String(entry).replace(/\\/g, '/'));
    if (batch.length >= READ_CONCURRENCY) {
      await flushBatch();
    }
  }
  await flushBatch();

  if (skippedLarge > 0) {
    console.warn(
      `  Skipped ${skippedLarge} large files (>${maxFileSizeBytes! / 1024}KB, likely generated/vendored). Set ONTOINDEX_SCAN_MAX_FILE_KB=0 to include them.`,
    );
    if (isVerboseIngestionEnabled()) {
      for (const p of skippedLargePaths) {
        console.warn(`  - ${p}`);
      }
    }
  }

  return entries;
};

/**
 * Phase 2: Read file contents for a specific set of relative paths.
 * Returns a Map for O(1) lookup. Silently skips files that fail to read.
 */
export const readFileContents = async (
  repoPath: string,
  relativePaths: string[],
): Promise<Map<string, string>> => {
  const contents = new Map<string, string>();

  for (let start = 0; start < relativePaths.length; start += READ_CONCURRENCY) {
    const batch = relativePaths.slice(start, start + READ_CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(async (relativePath) => {
        const fullPath = path.join(repoPath, relativePath);
        const content = await fs.readFile(fullPath, 'utf-8');
        return { path: relativePath, content };
      }),
    );

    for (const result of results) {
      if (result.status === 'fulfilled') {
        contents.set(result.value.path, result.value.content);
      }
    }
  }

  return contents;
};

/**
 * Legacy API — scans and reads everything into memory.
 * Used by sequential fallback path only.
 */
export const walkRepository = async (
  repoPath: string,
  onProgress?: (current: number, total: number, filePath: string) => void,
): Promise<FileEntry[]> => {
  const scanned = await walkRepositoryPaths(repoPath, onProgress);
  const contents = await readFileContents(
    repoPath,
    scanned.map((f) => f.path),
  );
  return scanned
    .filter((f) => contents.has(f.path))
    .map((f) => ({ path: f.path, content: contents.get(f.path)! }));
};
