/**
 * Standard import path resolution.
 * Handles relative imports, path alias rewriting, and generic suffix matching.
 * Used as the fallback when language-specific resolvers don't match.
 */

import type { SuffixIndex } from './utils.js';
import { tryResolveWithExtensions, suffixResolve } from './utils.js';
import { resolveRustImportInternal } from './rust.js';
import { SupportedLanguages } from 'ontoindex-shared';
import type { ImportResult, ImportResolverStrategy, ResolveCtx } from './types.js';
import type { TsconfigPaths } from '../language-config.js';

/** Max entries in the resolve cache. Beyond this, entries are evicted.
 *  100K entries ≈ 15MB — covers the most common import patterns. */
const RESOLVE_CACHE_CAP = 100_000;

/** TypeScript emit-extension specifiers and the source extensions they map back to. */
const TS_SOURCE_EXTENSION_SWAPS: ReadonlyArray<[string, readonly string[]]> = [
  ['.js', ['.ts', '.tsx']],
  ['.jsx', ['.tsx']],
  ['.mjs', ['.mts']],
  ['.cjs', ['.cts']],
];

/**
 * NodeNext/ESM TypeScript imports name the emitted file (`./foo.js`) while the
 * repository only contains the source (`./foo.ts`). Return the source paths that
 * such a specifier refers to, in TypeScript's lookup order.
 */
const tsSourceCandidates = (path: string): string[] => {
  for (const [emitted, sources] of TS_SOURCE_EXTENSION_SWAPS) {
    if (path.endsWith(emitted)) {
      const stem = path.slice(0, -emitted.length);
      return sources.map((source) => stem + source);
    }
  }
  return [];
};

/**
 * Resolve an import path to a file path in the repository.
 *
 * Language-specific preprocessing is applied before the generic resolution:
 * - TypeScript/JavaScript: rewrites tsconfig path aliases
 * - Rust: converts crate::/super::/self:: to relative paths
 *
 * Java wildcards and Go package imports are handled separately in processImports
 * because they resolve to multiple files.
 */
export const resolveImportPath = (
  currentFile: string,
  importPath: string,
  allFiles: Set<string>,
  allFileList: string[],
  normalizedFileList: string[],
  resolveCache: Map<string, string | null>,
  language: SupportedLanguages,
  tsconfigPaths: TsconfigPaths | null,
  index?: SuffixIndex,
): string | null => {
  const cacheKey = `${currentFile}::${importPath}`;
  if (resolveCache.has(cacheKey)) return resolveCache.get(cacheKey) ?? null;

  const cache = (result: string | null): string | null => {
    // Evict oldest 20% when cap is reached instead of clearing all
    if (resolveCache.size >= RESOLVE_CACHE_CAP) {
      const evictCount = Math.floor(RESOLVE_CACHE_CAP * 0.2);
      const iter = resolveCache.keys();
      for (let i = 0; i < evictCount; i++) {
        const key = iter.next().value;
        if (key !== undefined) resolveCache.delete(key);
      }
    }
    resolveCache.set(cacheKey, result);
    return result;
  };

  const isTsOrJs =
    language === SupportedLanguages.TypeScript || language === SupportedLanguages.JavaScript;

  /** Exact path first; for TS/JS fall back to the source a `.js` specifier names. */
  const resolveFromRoot = (path: string): string | null => {
    const resolved = tryResolveWithExtensions(path, allFiles);
    if (resolved || !isTsOrJs) return resolved;
    for (const candidate of tsSourceCandidates(path)) {
      if (allFiles.has(candidate)) return candidate;
    }
    return null;
  };

  const resolveBySuffix = (pathParts: string[]): string | null => {
    const resolved = suffixResolve(pathParts, normalizedFileList, allFileList, index);
    if (resolved || !isTsOrJs || pathParts.length === 0) return resolved;
    const head = pathParts.slice(0, -1);
    for (const candidate of tsSourceCandidates(pathParts[pathParts.length - 1])) {
      const swapped = suffixResolve([...head, candidate], normalizedFileList, allFileList, index);
      if (swapped) return swapped;
    }
    return null;
  };

  // ---- TypeScript/JavaScript: rewrite path aliases ----
  if (isTsOrJs && tsconfigPaths && !importPath.startsWith('.')) {
    for (const [aliasPrefix, targetPrefix] of tsconfigPaths.aliases) {
      if (importPath.startsWith(aliasPrefix)) {
        const remainder = importPath.slice(aliasPrefix.length);
        // Build the rewritten path relative to baseUrl
        const rewritten =
          tsconfigPaths.baseUrl === '.'
            ? targetPrefix + remainder
            : tsconfigPaths.baseUrl + '/' + targetPrefix + remainder;

        // Try direct resolution from repo root
        const resolved = resolveFromRoot(rewritten);
        if (resolved) return cache(resolved);

        // Try suffix matching as fallback
        const parts = rewritten.split('/').filter(Boolean);
        const suffixResult = resolveBySuffix(parts);
        if (suffixResult) return cache(suffixResult);
      }
    }
  }

  // ---- Rust: convert module path syntax to file paths ----
  if (language === SupportedLanguages.Rust) {
    // Handle grouped imports: use crate::module::{Foo, Bar, Baz}
    // Extract the prefix path before ::{...} and resolve the module, not the symbols
    let rustImportPath = importPath;
    const braceIdx = importPath.indexOf('::{');
    if (braceIdx !== -1) {
      rustImportPath = importPath.substring(0, braceIdx);
    } else if (importPath.startsWith('{') && importPath.endsWith('}')) {
      // Top-level grouped imports: use {crate::a, crate::b}
      // Iterate each part and return the first that resolves. This function returns a single
      // string, so callers that need ALL edges must intercept before reaching here (see the
      // Rust grouped-import blocks in processImports / processImportsBatch). This fallback
      // handles any path that reaches resolveImportPath directly.
      const inner = importPath.slice(1, -1);
      const parts = inner
        .split(',')
        .map((p) => p.trim())
        .filter(Boolean);
      for (const part of parts) {
        const partResult = resolveRustImportInternal(currentFile, part, allFiles);
        if (partResult) return cache(partResult);
      }
      return cache(null);
    }

    const rustResult = resolveRustImportInternal(currentFile, rustImportPath, allFiles);
    if (rustResult) return cache(rustResult);
    // Fall through to generic resolution if Rust-specific didn't match
  }

  // ---- Generic relative import resolution (./ and ../) ----
  const currentDir = currentFile.split('/').slice(0, -1);
  const parts = importPath.split('/');

  for (const part of parts) {
    if (part === '.') continue;
    if (part === '..') {
      currentDir.pop();
    } else {
      currentDir.push(part);
    }
  }

  const basePath = currentDir.join('/');

  if (importPath.startsWith('.')) {
    return cache(resolveFromRoot(basePath));
  }

  // ---- Generic package/absolute import resolution (suffix matching) ----
  // Java wildcards are handled in processImports, not here
  if (importPath.endsWith('.*')) {
    return cache(null);
  }

  // C/C++ includes use actual file paths (e.g. "animal.h") — don't convert dots to slashes
  const isCpp = language === SupportedLanguages.C || language === SupportedLanguages.CPlusPlus;
  const pathLike = importPath.includes('/') || isCpp ? importPath : importPath.replace(/\./g, '/');
  const pathParts = pathLike.split('/').filter(Boolean);

  const resolved = suffixResolve(pathParts, normalizedFileList, allFileList, index);
  return cache(resolved);
};

// ============================================================================
// Per-language dispatch functions (moved from import-resolution.ts)
// ============================================================================

/**
 * Standard single-file resolution (TS/JS/C/C++ and fallback for other languages).
 * Handles relative imports, tsconfig path aliases, and suffix matching.
 */
export function resolveStandard(
  rawImportPath: string,
  filePath: string,
  ctx: ResolveCtx,
  language: SupportedLanguages,
): ImportResult {
  const resolvedPath = resolveImportPath(
    filePath,
    rawImportPath,
    ctx.allFilePaths,
    ctx.allFileList,
    ctx.normalizedFileList,
    ctx.resolveCache,
    language,
    ctx.configs.tsconfigPaths,
    ctx.index,
  );
  return resolvedPath ? { kind: 'files', files: [resolvedPath] } : null;
}

// ============================================================================
// Strategy factory — composable hook for ImportResolutionConfig
// ============================================================================

/** Create a reusable standard-resolution strategy for a given language. */
export function createStandardStrategy(language: SupportedLanguages): ImportResolverStrategy {
  return (raw, fp, ctx) => resolveStandard(raw, fp, ctx, language);
}
