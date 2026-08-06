/**
 * PHP PSR-4 import resolution — internal helpers.
 *
 * Strategy lives in configs/php.ts.
 * This file contains the shared helper for PSR-4 resolution via composer.json.
 */

import type { SuffixIndex } from './utils.js';
import { suffixResolve } from './utils.js';
import type { ComposerConfig } from '../language-config.js';
import type { ImportResult } from './types.js';

export const PHP_SYMBOL_IMPORT_PREFIX = 'ontoindex-php-symbol:';

/** Get or compute the sorted PSR-4 entries (cached after first call). */
function getSortedPsr4(config: ComposerConfig): readonly [string, string][] {
  if (!config.psr4Sorted) {
    const sorted = [...config.psr4.entries()].sort((a, b) => b[0].length - a[0].length);
    config.psr4Sorted = sorted;
  }
  return config.psr4Sorted;
}

/**
 * Resolve a PHP use-statement import path using PSR-4 mappings (low-level helper).
 * e.g. "App\Http\Controllers\UserController" -> "app/Http/Controllers/UserController.php"
 *
 * For function/constant imports (use function App\Models\getUser), the last
 * segment is the symbol name, not a class name, so it may not map directly to
 * a file. When PSR-4 class-style resolution fails, we fall back to scanning
 * .php files in the namespace directory.
 *
 * Function/constant imports do not encode their declaring filename. When class-style
 * resolution fails, return every PHP file in the namespace as a lookup-only scope.
 * Call resolution can then select the file that actually declares the symbol without
 * publishing a guessed IMPORTS edge.
 */
export function resolvePhpImportInternal(
  importPath: string,
  composerConfig: ComposerConfig | null,
  allFiles: Set<string>,
  normalizedFileList: string[],
  allFileList: string[],
  index?: SuffixIndex,
): ImportResult {
  const isSymbolImport = importPath.startsWith(PHP_SYMBOL_IMPORT_PREFIX);
  if (isSymbolImport) importPath = importPath.slice(PHP_SYMBOL_IMPORT_PREFIX.length);

  // Normalize: replace backslashes with forward slashes
  const normalized = importPath.replace(/\\+/g, '/').replace(/\/+$/g, '');

  // Reject path traversal attempts (defense-in-depth — walker whitelist also prevents this)
  if (normalized.includes('..')) return null;

  if (composerConfig) {
    const sorted = getSortedPsr4(composerConfig);
    for (const [nsPrefix, dirPrefix] of sorted) {
      const nsPrefixSlash = nsPrefix.replace(/\\+/g, '/').replace(/\/+$/g, '');
      if (normalized.startsWith(nsPrefixSlash + '/') || normalized === nsPrefixSlash) {
        const remainder = normalized.slice(nsPrefixSlash.length).replace(/^\//, '');
        const baseDir = dirPrefix.replace(/[\\/]+$/, '');

        // 1. Try class-style PSR-4: full path → file (e.g. App\Models\User → app/Models/User.php)
        const filePath = baseDir + (remainder ? '/' + remainder : '') + '.php';
        if (allFiles.has(filePath)) return { kind: 'files', files: [filePath] };
        if (index) {
          const result = index.getInsensitive(filePath);
          if (result) return { kind: 'files', files: [result] };
        }

        if (!isSymbolImport) return null;

        // 2. Function/constant fallback: strip last segment (symbol name), scan namespace directory.
        //    e.g. App\Models\getUser → directory app/Models/, inspect every .php file in that dir.
        const lastSlash = remainder.lastIndexOf('/');
        const nsDir = lastSlash >= 0 ? baseDir + '/' + remainder.slice(0, lastSlash) : baseDir;

        // Prefer SuffixIndex directory lookup (O(log n + matches)) over linear scan.
        if (index) {
          const candidates = index.getFilesInDir(nsDir, '.php');
          if (candidates.length > 0) return { kind: 'scope', files: candidates };
        }

        // Fallback: linear scan (only when SuffixIndex unavailable).
        const nsDirPrefix = nsDir.endsWith('/') ? nsDir : nsDir + '/';
        const candidates: string[] = [];
        for (const f of allFiles) {
          if (
            f.startsWith(nsDirPrefix) &&
            f.endsWith('.php') &&
            !f.slice(nsDirPrefix.length).includes('/')
          ) {
            candidates.push(f);
          }
        }
        if (candidates.length > 0) return { kind: 'scope', files: candidates };
      }
    }
  }

  // Fallback: suffix matching (works without composer.json)
  const pathParts = normalized.split('/').filter(Boolean);
  const resolved = suffixResolve(pathParts, normalizedFileList, allFileList, index);
  return resolved ? { kind: 'files', files: [resolved] } : null;
}
