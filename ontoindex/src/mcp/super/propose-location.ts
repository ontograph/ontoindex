/**
 * gn_propose_location — where-to-add-new-code suggester (Phase 4 W4c).
 *
 * Composes gnExplore and direct Cypher queries to propose the best directory
 * and filename for new code, based on a free-text intent description.
 *
 * Pure facade — read-only, no DB writes, no side effects.
 */

import { gnExplore } from './explore.js';
import { executeParameterized } from '../../core/lbug/pool-adapter.js';
import { constants as fsConstants } from 'fs';
import { access, readFile, realpath, stat } from 'fs/promises';
import { basename, isAbsolute, relative, resolve } from 'path';

const IMPORT_PATTERN_FILE_LIMIT = 3;
const IMPORT_PATTERN_MAX_FILE_BYTES = 512 * 1024;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ProposeLocationParams {
  intent: string;
  language?: string;
}

export interface ProposeLocationReport {
  version: 1;
  intent: string;
  candidates: Array<{
    directory: string;
    suggestedFilename: string;
    rationale: string;
    matchedCluster?: string;
    siblingFiles: string[];
    importPattern?: string;
  }>;
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function siblingFilePathFromRow(row: unknown): string {
  if ((typeof row !== 'object' && typeof row !== 'function') || row === null) {
    throw new TypeError('Expected query row to be object-like');
  }

  const fields = row as { fp?: unknown; 0?: unknown };
  return (fields.fp ?? fields[0] ?? '') as string;
}

/**
 * Fetch sibling files that belong to a Community node by name.
 * Returns at most 10 file paths.
 */
async function fetchSiblingFiles(repoId: string, clusterName: string): Promise<string[]> {
  try {
    const rows = await executeParameterized(
      repoId,
      `MATCH (f:File)-[r:CodeRelation {type: 'IN_COMMUNITY'}]->(c:Community {name: $cluster})
       RETURN f.filePath AS fp
       LIMIT 10`,
      { cluster: clusterName },
    );
    const paths = rows.map(siblingFilePathFromRow).filter(Boolean);
    if (paths.length > 0) return paths;

    // Fallback: try heuristicLabel if name did not match
    const rows2 = await executeParameterized(
      repoId,
      `MATCH (f:File)-[r:CodeRelation {type: 'IN_COMMUNITY'}]->(c:Community {heuristicLabel: $cluster})
       RETURN f.filePath AS fp
       LIMIT 10`,
      { cluster: clusterName },
    );
    return rows2.map(siblingFilePathFromRow).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Derive the longest common directory prefix from a list of file paths.
 * E.g. ['src/auth/login.ts', 'src/auth/logout.ts'] → 'src/auth'
 */
function longestCommonDirectory(filePaths: string[]): string {
  if (filePaths.length === 0) return '';

  // Split each path into its directory segments (drop the filename part).
  const dirParts = filePaths.map((fp) => {
    const lastSlash = fp.lastIndexOf('/');
    return lastSlash >= 0 ? fp.slice(0, lastSlash).split('/') : [];
  });

  const base = dirParts[0];
  let commonLength = base.length;

  for (let i = 1; i < dirParts.length; i++) {
    const parts = dirParts[i];
    let j = 0;
    while (j < commonLength && j < parts.length && base[j] === parts[j]) {
      j++;
    }
    commonLength = j;
  }

  return base.slice(0, commonLength).join('/');
}

/**
 * Detect a common filename suffix among siblings.
 * Returns the suffix (e.g. '-service.ts', '.handler.ts') that appears in the
 * majority of sibling filenames, or '' if none stands out.
 */
function detectNamingSuffix(filePaths: string[]): string {
  if (filePaths.length === 0) return '';

  const filenames = filePaths.map((fp) => {
    const lastSlash = fp.lastIndexOf('/');
    return lastSlash >= 0 ? fp.slice(lastSlash + 1) : fp;
  });

  // Try multi-part suffixes like '-service.ts', '.handler.ts', '.test.ts'
  const suffixCandidates = [
    /(-[a-z]+\.[a-z]+)$/, // e.g. -service.ts
    /(\.[a-z]+\.[a-z]+)$/, // e.g. .handler.ts
    /(\.[a-z]+)$/, // e.g. .ts
  ];

  for (const pattern of suffixCandidates) {
    const counts = new Map<string, number>();
    for (const name of filenames) {
      const m = name.match(pattern);
      if (m) {
        const suffix = m[1];
        counts.set(suffix, (counts.get(suffix) ?? 0) + 1);
      }
    }
    // Pick the most-common suffix if it appears in >50% of siblings
    let bestSuffix = '';
    let bestCount = 0;
    for (const [suffix, count] of counts) {
      if (count > bestCount) {
        bestCount = count;
        bestSuffix = suffix;
      }
    }
    if (bestSuffix && bestCount > filenames.length / 2) {
      return bestSuffix;
    }
  }

  return '';
}

/**
 * Derive a base filename stem from the intent string.
 * Lowercases, strips non-alphanumeric characters, joins with hyphens, takes
 * at most the first 3 meaningful words.
 */
function stemFromIntent(intent: string): string {
  const stopWords = new Set([
    'a',
    'an',
    'the',
    'add',
    'new',
    'create',
    'implement',
    'write',
    'build',
    'make',
    'and',
    'or',
    'for',
    'to',
    'of',
    'in',
    'on',
    'with',
  ]);

  const words = intent
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1 && !stopWords.has(w));

  return words.slice(0, 3).join('-') || 'new-module';
}

function isContainedPath(childPath: string, parentPath: string): boolean {
  const relativePath = relative(parentPath, childPath);
  return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath));
}

function resolveKnownRepoRoot(repoId: string): string | undefined {
  const cwdRoot = resolve(process.cwd());
  if (repoId === cwdRoot || repoId.toLowerCase() === basename(cwdRoot).toLowerCase()) {
    return cwdRoot;
  }

  if (isAbsolute(repoId)) {
    const absoluteRepoId = resolve(repoId);
    if (absoluteRepoId === cwdRoot) return cwdRoot;
  }

  return undefined;
}

async function resolveSafeSourcePath(
  filePath: string,
  repoRoot: string,
): Promise<string | undefined> {
  const absolutePath = isAbsolute(filePath) ? filePath : resolve(repoRoot, filePath);
  const absoluteRepoRoot = resolve(repoRoot);
  if (!isContainedPath(absolutePath, absoluteRepoRoot)) {
    return undefined;
  }

  try {
    const [realRepoRoot, realSourcePath] = await Promise.all([
      realpath(absoluteRepoRoot),
      realpath(absolutePath),
    ]);
    if (!isContainedPath(realSourcePath, realRepoRoot)) {
      return undefined;
    }
    return realSourcePath;
  } catch {
    return undefined;
  }
}

async function readSmallTextFile(filePath: string, repoRoot: string): Promise<string | null> {
  const safePath = await resolveSafeSourcePath(filePath, repoRoot);
  if (!safePath) return null;

  try {
    await access(safePath, fsConstants.R_OK);
    const fileStats = await stat(safePath);
    if (!fileStats.isFile() || fileStats.size > IMPORT_PATTERN_MAX_FILE_BYTES) {
      return null;
    }
    return await readFile(safePath, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Extract the top-3 most-common import statements from a list of source files.
 * Reads each file from disk (best-effort) and counts raw import lines.
 */
async function extractImportPattern(
  filePaths: string[],
  repoRoot: string,
): Promise<string | undefined> {
  const importCounts = new Map<string, number>();

  for (const fp of filePaths.slice(0, IMPORT_PATTERN_FILE_LIMIT)) {
    const text = await readSmallTextFile(fp, repoRoot);
    if (text === null) continue;
    const lines = text.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('import ') || trimmed.startsWith('from ')) {
        importCounts.set(trimmed, (importCounts.get(trimmed) ?? 0) + 1);
      }
    }
  }

  if (importCounts.size === 0) return undefined;

  const top3 = Array.from(importCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([line]) => line);

  return top3.join('\n');
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export async function gnProposeLocation(
  repoId: string,
  params: ProposeLocationParams,
): Promise<ProposeLocationReport> {
  const warnings: string[] = [];
  const repoRoot = resolveKnownRepoRoot(repoId);
  if (!repoRoot) {
    warnings.push('import pattern sniffing skipped: target repo root is unknown');
  }

  // --- 1. Run gnExplore (shallow) to find relevant clusters -----------------
  let exploreResult: Awaited<ReturnType<typeof gnExplore>>;
  try {
    exploreResult = await gnExplore(repoId, { query: params.intent, depth: 'shallow' });
    if (exploreResult.warnings.length > 0) {
      warnings.push(...exploreResult.warnings.map((w) => `explore: ${w}`));
    }
  } catch (err) {
    warnings.push(`explore failed: ${err instanceof Error ? err.message : String(err)}`);
    return { version: 1, intent: params.intent, candidates: [], warnings };
  }

  // --- 2. Pick top-3 clusters -----------------------------------------------
  const clusters = exploreResult.clusters.slice(0, 3);

  if (clusters.length === 0) {
    warnings.push('no clusters found for intent — cannot propose a location');
    return { version: 1, intent: params.intent, candidates: [], warnings };
  }

  // --- 3. Build a candidate per cluster -------------------------------------
  const candidates: ProposeLocationReport['candidates'] = [];

  for (const cluster of clusters) {
    // Enumerate sibling files from the graph
    const siblingFiles = await fetchSiblingFiles(repoId, cluster.name);

    // Derive common directory
    const directory = longestCommonDirectory(siblingFiles) || cluster.name;

    // Sniff naming suffix
    const namingSuffix = detectNamingSuffix(siblingFiles);

    // Suggest filename
    const stem = stemFromIntent(params.intent);
    const ext = namingSuffix || (params.language === 'python' ? '.py' : '.ts');
    const suggestedFilename = `${stem}${ext}`;

    // Extract import patterns (best-effort)
    const importPattern =
      repoRoot !== undefined ? await extractImportPattern(siblingFiles, repoRoot) : undefined;

    candidates.push({
      directory,
      suggestedFilename,
      rationale: `Cluster "${cluster.name}" (role: ${cluster.role || 'unknown'}, ${cluster.fileCount} files) matched intent via semantic search.`,
      matchedCluster: cluster.name,
      siblingFiles,
      ...(importPattern !== undefined ? { importPattern } : {}),
    });
  }

  return { version: 1, intent: params.intent, candidates, warnings };
}
