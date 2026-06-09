/**
 * Dead Code Detection MCP Tool
 *
 * Mark-and-sweep reachability over the code graph:
 *   1. Seed roots = exported symbols ∪ test-file contents ∪ entry-point files
 *   2. BFS forward through structural + call edges
 *   3. Any Function/Method/Class/Constructor not in the reached set is
 *      reported as dead — bucketed by confidence.
 *
 * The tool returns a review queue, not an auto-delete list. Framework-
 * invoked handlers, decorators, reflection, and dynamic require() will
 * all surface as false positives; the include_tests / include_exported
 * flags let callers tune noise.
 */
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { executeParameterized } from '../../core/lbug/pool-adapter.js';
import { getActiveModelPacks } from '../../analysis-packs/execution.js';
import { commitsByFile } from './backend-git-history.js';
import {
  collectNextFrontierFromRows,
  type ReachabilityTargetRow,
} from './backend-dead-code-reachability.js';
import { normalizeRepoRelativePath, resolveRepoFilePath } from './backend-repo-paths.js';
import { normalizeLimit } from './tool-utils.js';
import { AnalysisResult } from 'ontoindex-shared';
import { createPolicyFilter, resolveRepositoryPolicy } from '../../core/repository-policy.js';

type RepoHandle = {
  readonly id: string;
  readonly name: string;
  readonly repoPath?: string;
};

const SYMBOL_LABELS = ['Function', 'Method', 'Class', 'Constructor'];

const FORWARD_EDGE_TYPES = [
  'CALLS',
  'IMPORTS',
  'DEFINES',
  'HAS_METHOD',
  'HAS_PROPERTY',
  'EXTENDS',
  'IMPLEMENTS',
  'OVERRIDES',
  'METHOD_OVERRIDES',
  'ACCESSES',
];

const TEST_PATH_PATTERNS = [/\.test\./i, /\.spec\./i, /(^|\/)tests?\//i, /__tests__\//i];

const ENTRY_PATH_PATTERNS = [
  /(^|\/)index\.(c|m)?[jt]sx?$/i,
  /(^|\/)main\.(c|m)?[jt]sx?$/i,
  /(^|\/)cli\//i,
  /(^|\/)bin\//i,
  /(^|\/)hooks?\//i, // hook scripts (Claude/git/lint hooks)
  /(^|\/)scripts?\//i, // build/deploy/dev scripts
  /-hook\.(c|m)?[jt]sx?$/i, // *-hook.cjs / *-hook.mjs / *-hook.js
  /^[^/]+\.(c|m)js$/i, // top-level .cjs/.mjs entry scripts
];

// A function/method is treated as a possible React component when its
// filePath is JSX-capable and its name is PascalCase. The verify pass
// then checks for JSX usage (<Name>, <Name />, <Name prop=...>) since
// JSX invocations produce no CALLS edges in the current indexer.
const JSX_FILE_EXT = /\.(jsx|tsx)$/i;
const PASCAL_CASE_NAME = /^[A-Z][A-Za-z0-9_]*$/;

function isTestPath(p: string): boolean {
  return TEST_PATH_PATTERNS.some((re) => re.test(p));
}

function isEntryPath(p: string): boolean {
  return ENTRY_PATH_PATTERNS.some((re) => re.test(p));
}

function looksLikeReactComponent(entry: { type: string; name: string; filePath: string }): boolean {
  if (entry.type !== 'Function') return false;
  if (!JSX_FILE_EXT.test(entry.filePath)) return false;
  return PASCAL_CASE_NAME.test(entry.name);
}

/**
 * Scan the narrow line-window just before a symbol body for @deprecated or
 * @internal JSDoc tags. The window is [max(0, startLine-3), (endLine ?? startLine)+5]
 * which captures the JSDoc block above the symbol without scanning the whole file.
 *
 * Reads are cached per-file: when multiple dead candidates live in the same
 * file only one disk read occurs for the entire runDeadCode call.
 */
async function scanForJsDocTags(
  repoPath: string,
  filePath: string,
  startLine: number | undefined,
  endLine: number | undefined,
  cache: Map<string, string[]>,
): Promise<boolean> {
  if (startLine === undefined) return false;
  let lines = cache.get(filePath);
  if (lines === undefined) {
    try {
      const text = await fs.readFile(resolveRepoFilePath(repoPath, filePath), 'utf-8');
      lines = text.split('\n');
    } catch {
      lines = [];
    }
    cache.set(filePath, lines);
  }
  const from = Math.max(0, startLine - 3);
  const to = Math.min(lines.length, (endLine ?? startLine) + 5);
  for (let i = from; i < to; i++) {
    if (lines[i].includes('@deprecated') || lines[i].includes('@internal')) return true;
  }
  return false;
}

interface DeadCodeEntry {
  id: string;
  name: string;
  type: string;
  filePath: string;
  startLine?: number;
  endLine?: number;
  bucket: 'unreached' | 'unused' | 'weakly_referenced' | 'entrypoint_unknown' | 'test_only';
  verifiedIncomingRefs?: number;
  confidence: 'high' | 'medium' | 'low';
  reasonCodes: string[];
  includes_deprecated_tag: boolean;
}

interface DeadCodeResult {
  status: 'success' | 'error';
  tool: 'dead_code';
  repo: string;
  totalSymbols: number;
  reachableCount: number;
  deadCount: number;
  verifiedReachableCount: number;
  suppressed_count: number;
  excluded_path_count: number;
  representative_excluded_paths: string[];
  policyFilter: {
    applied: boolean;
    includeIgnored: boolean;
    excludedPathCount: number;
    representativeExcludedPaths: string[];
    globs: string[];
    sources: string[];
  };
  byBucket: {
    unreached: number;
    unused: number;
    weakly_referenced: number;
    entrypoint_unknown: number;
    test_only: number;
    /** @deprecated use unused */
    exported_uncalled: number;
  };
  activeModelPacks?: Array<{ id: string; tier: string; provides: string[] }>;
  entries: DeadCodeEntry[];
  summary: string;
  error?: string;
}

interface SymbolRow {
  id: string;
  name: string;
  type: string;
  filePath: string;
  startLine?: number;
  endLine?: number;
  isExported: boolean;
}

interface SymbolQueryRow {
  readonly id?: unknown;
  readonly name?: unknown;
  readonly filePath?: unknown;
  readonly startLine?: unknown;
  readonly endLine?: unknown;
  readonly isExported?: unknown;
  readonly 0?: unknown;
  readonly 1?: unknown;
  readonly 2?: unknown;
  readonly 3?: unknown;
  readonly 4?: unknown;
  readonly 5?: unknown;
}

interface FileSeedRow {
  readonly id?: unknown;
  readonly filePath?: unknown;
  readonly 0?: unknown;
  readonly 1?: unknown;
}

interface IdSeedRow {
  readonly id?: unknown;
  readonly 0?: unknown;
}

function symbolRowValue(
  row: SymbolQueryRow,
  key: keyof SymbolQueryRow,
  index: 0 | 1 | 2 | 3 | 4 | 5,
): unknown {
  return row[key] ?? row[index];
}

function fileSeedRowValue(row: FileSeedRow, key: keyof FileSeedRow, index: 0 | 1): unknown {
  return row[key] ?? row[index];
}

function idSeedRowValue(row: IdSeedRow): unknown {
  return row.id ?? row[0];
}

type MessageBearing = { readonly message?: unknown };

function deadCodeErrorMessage(err: unknown): unknown {
  const message =
    err !== null && err !== undefined && (typeof err === 'object' || typeof err === 'function')
      ? (err as MessageBearing).message
      : undefined;
  return message ?? String(err);
}

async function loadAllSymbols(repoId: string): Promise<SymbolRow[]> {
  const out: SymbolRow[] = [];
  // lbug/Kuzu partitions nodes by label, so an untyped MATCH (n) returns
  // nothing. Query each label table and merge.
  for (const label of SYMBOL_LABELS) {
    let rows: SymbolQueryRow[];
    try {
      rows = await executeParameterized(
        repoId,
        `
          MATCH (n:${label})
          WHERE n.id IS NOT NULL
            AND n.name IS NOT NULL
            AND n.filePath IS NOT NULL
          RETURN n.id AS id, n.name AS name,
                 n.filePath AS filePath, n.startLine AS startLine,
                 n.endLine AS endLine, n.isExported AS isExported
        `,
        {},
      );
    } catch {
      rows = [];
    }
    for (const r of rows || []) {
      const id = symbolRowValue(r, 'id', 0);
      const name = symbolRowValue(r, 'name', 1);
      const filePath = symbolRowValue(r, 'filePath', 2);
      if (typeof id !== 'string' || typeof name !== 'string' || typeof filePath !== 'string') {
        continue;
      }
      const startLineRaw = symbolRowValue(r, 'startLine', 3);
      const endLineRaw = symbolRowValue(r, 'endLine', 4);
      const isExportedRaw = symbolRowValue(r, 'isExported', 5);
      out.push({
        id,
        name,
        type: label,
        filePath,
        startLine: typeof startLineRaw === 'number' ? startLineRaw : undefined,
        endLine: typeof endLineRaw === 'number' ? endLineRaw : undefined,
        isExported: Boolean(isExportedRaw),
      });
    }
  }
  return out;
}

async function loadSeedIdsByKind(
  repoId: string,
  includeTests: boolean,
  allSymbols: SymbolRow[],
): Promise<{ exportSeeds: Set<string>; testSeeds: Set<string>; entrySeeds: Set<string> }> {
  const exportSeeds = new Set<string>();
  const testSeeds = new Set<string>();
  const entrySeeds = new Set<string>();

  for (const s of allSymbols) {
    if (s.isExported && !isTestPath(s.filePath)) {
      exportSeeds.add(s.id);
    }
    if (isEntryPath(s.filePath)) {
      entrySeeds.add(s.id);
    }
    if (includeTests && isTestPath(s.filePath)) {
      testSeeds.add(s.id);
    }
  }

  const fileRows = (await executeParameterized(
    repoId,
    `
      MATCH (f:File)
      WHERE f.id IS NOT NULL AND f.filePath IS NOT NULL
      RETURN f.id AS id, f.filePath AS filePath
    `,
    {},
  )) as FileSeedRow[];
  for (const r of fileRows || []) {
    const id = fileSeedRowValue(r, 'id', 0);
    const filePath = fileSeedRowValue(r, 'filePath', 1);
    if (typeof id !== 'string' || typeof filePath !== 'string') continue;
    if (isEntryPath(filePath)) entrySeeds.add(id);
    if (includeTests && isTestPath(filePath)) testSeeds.add(id);
  }

  return { exportSeeds, testSeeds, entrySeeds };
}

async function loadModelPackDeadCodeSeeds(repo: RepoHandle): Promise<{
  seedIds: Set<string>;
  activeModelPacks: Array<{ id: string; tier: string; provides: string[] }>;
}> {
  if (!repo.repoPath) {
    return { seedIds: new Set<string>(), activeModelPacks: [] };
  }

  const packs = await getActiveModelPacks(repo.repoPath, ['route-models']);
  if (packs.length === 0) {
    return { seedIds: new Set<string>(), activeModelPacks: [] };
  }

  const rows = (await executeParameterized(
    repo.id,
    `
      MATCH (handler)-[r:CodeRelation]->(route:Route)
      WHERE r.type = 'HANDLES_ROUTE'
        AND handler.id IS NOT NULL
      RETURN handler.id AS id
    `,
    {},
  )) as IdSeedRow[];

  const seedIds = new Set<string>();
  for (const row of rows || []) {
    const id = idSeedRowValue(row);
    if (typeof id === 'string' && id.length > 0) {
      seedIds.add(id);
    }
  }

  return {
    seedIds,
    activeModelPacks: packs.map((pack) => ({
      id: pack.id,
      tier: pack.tier,
      provides: pack.provides,
    })),
  };
}

async function bfsForward(
  repoId: string,
  seeds: Set<string>,
  maxIterations = 64,
): Promise<Set<string>> {
  const visited = new Set<string>(seeds);
  let frontier = Array.from(seeds);
  const relFilter = FORWARD_EDGE_TYPES.map((t) => `'${t}'`).join(', ');

  for (let depth = 0; depth < maxIterations && frontier.length > 0; depth++) {
    const idList = frontier.map((id) => `'${id.replace(/'/g, "''")}'`).join(', ');
    if (idList.length === 0) break;

    let rows: ReachabilityTargetRow[];
    try {
      rows = await executeParameterized(
        repoId,
        `
          MATCH (src)-[r:CodeRelation]->(tgt)
          WHERE src.id IN [${idList}]
            AND r.type IN [${relFilter}]
            AND tgt.id IS NOT NULL
          RETURN tgt.id AS id
        `,
        {},
      );
    } catch {
      break;
    }

    frontier = collectNextFrontierFromRows(rows || [], visited);
  }

  return visited;
}

/**
 * Scan node content for JSX tag usage of a React-component-shaped name.
 * The indexer does not produce CALLS edges for <Foo /> invocations, so
 * a Function named `Foo` defined in a .tsx file may look dead to BFS
 * even when it is rendered widely. Three patterns cover the common JSX
 * forms: `<Name>`, `<Name />`, `<Name prop=...>`.
 *
 * We scan Function.content and Method.content (full symbol bodies)
 * rather than File.content — File.content is truncated at ~10KB by
 * the indexer so JSX usages deep in a file would be missed. Symbol
 * bodies carry the complete source text for the symbol that wraps
 * the usage, so the literal `<Child>` reliably appears in the parent
 * component's content. A hit in any label table (Function, Method)
 * short-circuits the check.
 */
async function hasJsxUsageAnywhere(
  repoId: string,
  repoPath: string | undefined,
  name: string,
  filePath: string,
): Promise<boolean> {
  const params = {
    openGt: `<${name}>`,
    openSpace: `<${name} `,
    openSelf: `<${name}/`,
  };
  for (const label of ['Function', 'Method']) {
    try {
      const rows = await executeParameterized(
        repoId,
        `
          MATCH (n:${label})
          WHERE n.content CONTAINS $openGt
             OR n.content CONTAINS $openSpace
             OR n.content CONTAINS $openSelf
          RETURN n.id AS id
          LIMIT 1
        `,
        params,
      );
      if (Array.isArray(rows) && rows.length > 0) return true;
    } catch {
      // fall through to next label
    }
  }
  // Stored content is truncated at ~5KB/symbol, so JSX usage in large
  // component bodies (e.g. a long HelpPanel that renders TabContent
  // near the bottom) is invisible to the DB query. Fall back to a
  // direct disk read of the candidate's defining file — the most
  // common JSX-chain case has the usage in the same file.
  if (repoPath) {
    try {
      const abs = resolveRepoFilePath(repoPath, filePath);
      const text = await fs.readFile(abs, 'utf-8');
      if (text.includes(`<${name}>`) || text.includes(`<${name} `) || text.includes(`<${name}/`)) {
        return true;
      }
    } catch {
      // file missing or unreadable; fall through
    }
  }
  return false;
}

/**
 * Id-anchored incoming-ref lookup — the same pattern `context` uses.
 * Returns the caller ids so the caller can decide whether any of them
 * come from the live (reachable) subgraph. A candidate with incoming
 * refs only from other dead candidates is still dead (dead island);
 * only a ref from a live node is evidence the BFS missed something.
 */
async function fetchIncomingCallerIds(repoId: string, symId: string): Promise<string[]> {
  try {
    const rows = await executeParameterized(
      repoId,
      `
        MATCH (caller)-[r:CodeRelation]->(n)
        WHERE n.id = $symId
          AND r.type IN ['CALLS', 'IMPORTS', 'DEFINES', 'HAS_METHOD',
                          'HAS_PROPERTY', 'EXTENDS', 'IMPLEMENTS',
                          'OVERRIDES', 'METHOD_OVERRIDES', 'ACCESSES']
        RETURN caller.id AS callerId
      `,
      { symId },
    );
    const out: string[] = [];
    for (const r of rows || []) {
      const id = r.callerId ?? r[0];
      if (typeof id === 'string') out.push(id);
    }
    return out;
  } catch {
    return [];
  }
}

async function loadExcludeConfig(repoName: string): Promise<string[]> {
  const configPath = path.join(
    os.homedir(),
    '.ontoindex',
    'repos',
    repoName,
    'dead-code-excludes.json',
  );
  try {
    const raw = await fs.readFile(configPath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.filter((p) => typeof p === 'string');
    }
    return [];
  } catch {
    return [];
  }
}

function matchesExcludePattern(entry: DeadCodeEntry, patterns: string[]): boolean {
  for (const p of patterns) {
    if (
      entry.filePath === p ||
      entry.filePath.includes(p) ||
      entry.name === p ||
      entry.filePath.endsWith(p)
    ) {
      return true;
    }
  }
  return false;
}

interface DeadCodeBucketCounts {
  unreached: number;
  unused: number;
  weaklyReferenced: number;
  entrypointUnknown: number;
  testOnly: number;
}

function createEmptyBucketCounts(): DeadCodeBucketCounts {
  return {
    unreached: 0,
    unused: 0,
    weaklyReferenced: 0,
    entrypointUnknown: 0,
    testOnly: 0,
  };
}

function decrementBucketCount(bucket: DeadCodeEntry['bucket'], counts: DeadCodeBucketCounts): void {
  if (bucket === 'unreached') counts.unreached--;
  else if (bucket === 'unused') counts.unused--;
  else if (bucket === 'weakly_referenced') counts.weaklyReferenced--;
  else if (bucket === 'entrypoint_unknown') counts.entrypointUnknown--;
  else if (bucket === 'test_only') counts.testOnly--;
}

function incrementBucketCount(bucket: DeadCodeEntry['bucket'], counts: DeadCodeBucketCounts): void {
  if (bucket === 'unreached') counts.unreached++;
  else if (bucket === 'unused') counts.unused++;
  else if (bucket === 'weakly_referenced') counts.weaklyReferenced++;
  else if (bucket === 'entrypoint_unknown') counts.entrypointUnknown++;
  else if (bucket === 'test_only') counts.testOnly++;
}

function reclassifyBucket(
  entry: DeadCodeEntry,
  nextBucket: DeadCodeEntry['bucket'],
  counts: DeadCodeBucketCounts,
): void {
  if (entry.bucket === nextBucket) return;
  decrementBucketCount(entry.bucket, counts);
  entry.bucket = nextBucket;
  incrementBucketCount(nextBucket, counts);
}

function classifyDeadCodeCandidates(
  allSymbols: SymbolRow[],
  includeTests: boolean,
  includeExported: boolean,
  reachableAll: Set<string>,
  reachableWithoutTests: Set<string>,
  reachableWithoutExports: Set<string>,
  hasKnownRuntimeSeeds: boolean,
): { candidates: DeadCodeEntry[]; counts: DeadCodeBucketCounts } {
  const candidates: DeadCodeEntry[] = [];
  const counts = createEmptyBucketCounts();

  for (const symbol of allSymbols) {
    if (includeTests && isTestPath(symbol.filePath)) continue;

    const reached = reachableAll.has(symbol.id);
    const reachedWithoutTests = reachableWithoutTests.has(symbol.id);
    const reachedWithoutExports = reachableWithoutExports.has(symbol.id);

    let bucket: DeadCodeEntry['bucket'] | null = null;
    let reasonCodes: string[] = [];
    if (!reached) {
      bucket = hasKnownRuntimeSeeds ? 'unreached' : 'entrypoint_unknown';
      reasonCodes = hasKnownRuntimeSeeds
        ? ['not-reachable-from-known-roots']
        : ['no-known-entrypoint-seeds', 'not-reachable-from-known-roots'];
    } else if (!reachedWithoutTests && reached) {
      bucket = 'test_only';
      reasonCodes = ['reachable-only-from-tests'];
    } else if (symbol.isExported && !reachedWithoutExports && includeExported) {
      bucket = 'unused';
      reasonCodes = ['exported-symbol-no-internal-reachable-caller'];
    }

    if (!bucket) continue;
    incrementBucketCount(bucket, counts);
    candidates.push({
      id: symbol.id,
      name: symbol.name,
      type: symbol.type,
      filePath: symbol.filePath,
      startLine: symbol.startLine,
      endLine: symbol.endLine,
      bucket,
      confidence: 'medium',
      reasonCodes,
      includes_deprecated_tag: false,
    });
  }

  return { candidates, counts };
}

async function verifyDeadCodeCandidates(
  repo: RepoHandle,
  candidates: DeadCodeEntry[],
  reachableAll: Set<string>,
  counts: DeadCodeBucketCounts,
  verify: boolean,
): Promise<{ survivors: DeadCodeEntry[]; verifiedReachableCount: number }> {
  if (!verify) return { survivors: [...candidates], verifiedReachableCount: 0 };

  let verifiedReachableCount = 0;
  const survivors: DeadCodeEntry[] = [];
  for (const entry of candidates) {
    const callerIds = await fetchIncomingCallerIds(repo.id, entry.id);
    const liveRefs = callerIds.filter((id) => reachableAll.has(id)).length;
    if (liveRefs > 0) {
      verifiedReachableCount++;
      decrementBucketCount(entry.bucket, counts);
      continue;
    }
    if (callerIds.length > 0) {
      reclassifyBucket(entry, 'weakly_referenced', counts);
      entry.confidence = 'low';
      entry.reasonCodes = [
        ...new Set([
          ...entry.reasonCodes,
          'verified-incoming-refs-from-unreachable-symbols',
          'not-reachable-from-known-roots',
        ]),
      ];
    } else {
      entry.reasonCodes = [...new Set([...entry.reasonCodes, 'no-verified-incoming-refs'])];
    }
    if (
      looksLikeReactComponent(entry) &&
      (await hasJsxUsageAnywhere(repo.id, repo.repoPath, entry.name, entry.filePath))
    ) {
      verifiedReachableCount++;
      decrementBucketCount(entry.bucket, counts);
      continue;
    }
    survivors.push({ ...entry, verifiedIncomingRefs: callerIds.length });
  }

  return { survivors, verifiedReachableCount };
}

async function annotateDeadCodeConfidence(
  repoPath: string | undefined,
  entries: DeadCodeEntry[],
): Promise<void> {
  if (!repoPath) return;
  const churnMap = await commitsByFile(repoPath, '90.days.ago');
  for (const entry of entries) {
    if (entry.bucket === 'weakly_referenced' || entry.bucket === 'entrypoint_unknown') {
      entry.confidence = 'low';
      continue;
    }
    const relPath = normalizeRepoRelativePath(repoPath, entry.filePath);
    const commits = churnMap.get(relPath) ?? 0;
    entry.confidence = commits === 0 ? 'high' : commits <= 2 ? 'medium' : 'low';
  }
}

async function annotateDeadCodeJsDocTags(
  repoPath: string | undefined,
  entries: DeadCodeEntry[],
): Promise<void> {
  if (!repoPath) return;
  const fileCache = new Map<string, string[]>();
  for (const entry of entries) {
    entry.includes_deprecated_tag = await scanForJsDocTags(
      repoPath,
      entry.filePath,
      entry.startLine,
      entry.endLine,
      fileCache,
    );
  }
}

async function filterDeadCodeByStaleDays(
  repoPath: string | undefined,
  minStaleDays: number | undefined,
  entries: DeadCodeEntry[],
): Promise<DeadCodeEntry[]> {
  if (minStaleDays === undefined || !repoPath) return entries;
  const staleMap = await commitsByFile(repoPath, `${minStaleDays}.days.ago`);
  return entries.filter((entry) => {
    const relPath = normalizeRepoRelativePath(repoPath, entry.filePath);
    return (staleMap.get(relPath) ?? 0) === 0;
  });
}

function applyDeadCodeExcludePatterns(
  entries: DeadCodeEntry[],
  allExcludePatterns: string[],
): { entries: DeadCodeEntry[]; suppressedCount: number } {
  let suppressedCount = 0;
  if (allExcludePatterns.length === 0) {
    return { entries, suppressedCount };
  }

  return {
    entries: entries.filter((entry) => {
      if (matchesExcludePattern(entry, allExcludePatterns)) {
        suppressedCount++;
        return false;
      }
      return true;
    }),
    suppressedCount,
  };
}

function sortDeadCodeEntries(entries: DeadCodeEntry[]): void {
  entries.sort((a, b) => {
    const order = {
      unreached: 0,
      weakly_referenced: 1,
      entrypoint_unknown: 2,
      test_only: 3,
      unused: 4,
    } as const;
    if (order[a.bucket] !== order[b.bucket]) return order[a.bucket] - order[b.bucket];
    if (a.filePath !== b.filePath) return a.filePath.localeCompare(b.filePath);
    return (a.startLine ?? 0) - (b.startLine ?? 0);
  });
}

function buildDeadCodeSummary(params: {
  allSymbolsCount: number;
  counts: DeadCodeBucketCounts;
  verify: boolean;
  verifiedReachableCount: number;
  suppressedCount: number;
  policyExcludedCount: number;
  representativePolicyExcludedPaths: string[];
  entries: DeadCodeEntry[];
}): string {
  const deadCount =
    params.counts.unreached +
    params.counts.unused +
    params.counts.weaklyReferenced +
    params.counts.entrypointUnknown +
    params.counts.testOnly;
  const verifySuffix = params.verify
    ? ` — ${params.verifiedReachableCount} false positives filtered via context verification`
    : '';
  const suppressSuffix =
    params.suppressedCount > 0
      ? `; ${params.suppressedCount} entries suppressed by exclude_patterns.`
      : '';
  const policySuffix =
    params.policyExcludedCount > 0
      ? `; ${params.policyExcludedCount} paths excluded by repository policy (${params.representativePolicyExcludedPaths.join(', ')}). Use includeIgnored:true to include them.`
      : '';
  const highC = params.entries.filter((e) => e.confidence === 'high').length;
  const medC = params.entries.filter((e) => e.confidence === 'medium').length;
  const lowC = params.entries.filter((e) => e.confidence === 'low').length;
  const confidenceSuffix = `; confidence: H=${highC} M=${medC} L=${lowC}`;
  const deprecatedCount = params.entries.filter((e) => e.includes_deprecated_tag).length;
  const deprecatedSuffix =
    deprecatedCount > 0 ? `; ${deprecatedCount} entries flagged @deprecated/@internal` : '';

  return deadCount === 0
    ? `No dead code detected in ${params.allSymbolsCount} symbols${verifySuffix}${suppressSuffix}${policySuffix}.`
    : `${deadCount} dead-code candidates in ${params.allSymbolsCount} symbols (${params.counts.unreached} unreached, ${params.counts.unused} unused, ${params.counts.weaklyReferenced} weakly-referenced, ${params.counts.entrypointUnknown} entrypoint-unknown, ${params.counts.testOnly} test-only)${verifySuffix}${suppressSuffix}${policySuffix}${confidenceSuffix}${deprecatedSuffix}.`;
}

export async function runDeadCode(
  repo: RepoHandle,
  params: {
    include_tests?: boolean;
    include_exported?: boolean;
    limit?: number;
    verify?: boolean;
    exclude_patterns?: string[];
    min_stale_days?: number;
    includeIgnored?: boolean;
  },
): Promise<AnalysisResult & DeadCodeResult> {
  const start = Date.now();
  const includeTests = params?.include_tests !== false;
  const includeExported = params?.include_exported !== false;
  const verify = params?.verify !== false;
  const limit = normalizeLimit(params?.limit, 200, 5000);
  const minStaleDays =
    typeof params?.min_stale_days === 'number' && params.min_stale_days > 0
      ? params.min_stale_days
      : undefined;

  try {
    const configPatterns = await loadExcludeConfig(repo.name);
    const paramsPatterns = params?.exclude_patterns ?? [];
    const allExcludePatterns = Array.from(new Set([...configPatterns, ...paramsPatterns]));
    const resolvedPolicy = await resolveRepositoryPolicy({
      repoPath: repo.repoPath,
      toolPolicy: { includeIgnored: params?.includeIgnored },
    });
    const policyFilter = createPolicyFilter(resolvedPolicy.policy, {
      includeIgnored: resolvedPolicy.includeIgnored,
      sources: resolvedPolicy.sources,
    });

    if (!repo.repoPath) {
      console.warn('[dead_code] no repoPath — churn, min_stale_days, and JSDoc scanning disabled');
    }

    const allSymbols = await loadAllSymbols(repo.id);
    const { exportSeeds, testSeeds, entrySeeds } = await loadSeedIdsByKind(
      repo.id,
      includeTests,
      allSymbols,
    );
    const { seedIds: modelPackSeeds, activeModelPacks } = await loadModelPackDeadCodeSeeds(repo);

    const allSeeds = new Set<string>([
      ...exportSeeds,
      ...testSeeds,
      ...entrySeeds,
      ...modelPackSeeds,
    ]);
    const reachableAll = await bfsForward(repo.id, allSeeds);

    let reachableWithoutTests: Set<string>;
    if (includeTests && testSeeds.size > 0) {
      const nonTestSeeds = new Set<string>([...exportSeeds, ...entrySeeds, ...modelPackSeeds]);
      reachableWithoutTests = await bfsForward(repo.id, nonTestSeeds);
    } else {
      reachableWithoutTests = reachableAll;
    }

    let reachableWithoutExports: Set<string>;
    if (includeExported && exportSeeds.size > 0) {
      const nonExportSeeds = new Set<string>([...testSeeds, ...entrySeeds, ...modelPackSeeds]);
      reachableWithoutExports = await bfsForward(repo.id, nonExportSeeds);
    } else {
      reachableWithoutExports = reachableAll;
    }

    const { candidates, counts } = classifyDeadCodeCandidates(
      allSymbols,
      includeTests,
      includeExported,
      reachableAll,
      reachableWithoutTests,
      reachableWithoutExports,
      allSeeds.size > 0,
    );

    // Per-candidate context check: the IN-list BFS can miss edges the
    // planner does not resolve at scale. Re-query each candidate with
    // the id-anchored pattern `context` uses. A candidate is filtered
    // only when an incoming ref comes from a node in reachableAll —
    // refs from other dead candidates ("dead island") are not evidence
    // of life and the candidate stays in the dead list.
    const { survivors, verifiedReachableCount } = await verifyDeadCodeCandidates(
      repo,
      candidates,
      reachableAll,
      counts,
      verify,
    );

    // --- Churn-based confidence annotation (90-day window, best-effort) ---
    await annotateDeadCodeConfidence(repo.repoPath, survivors);
    // (else: confidence stays 'medium' — already set as default above)

    // --- JSDoc @deprecated / @internal tag annotation ---
    await annotateDeadCodeJsDocTags(repo.repoPath, survivors);

    // --- min_stale_days filter: drop entries whose file has recent commits ---
    const staleFiltered = await filterDeadCodeByStaleDays(repo.repoPath, minStaleDays, survivors);
    const policyFiltered = staleFiltered.filter(
      (entry) => !policyFilter.shouldExcludePath(entry.filePath),
    );
    const { entries: filteredSurvivors, suppressedCount } = applyDeadCodeExcludePatterns(
      policyFiltered,
      allExcludePatterns,
    );
    sortDeadCodeEntries(filteredSurvivors);

    const entries = filteredSurvivors.slice(0, limit);
    const deadCount =
      counts.unreached +
      counts.unused +
      counts.weaklyReferenced +
      counts.entrypointUnknown +
      counts.testOnly;
    const summary = buildDeadCodeSummary({
      allSymbolsCount: allSymbols.length,
      counts,
      verify,
      verifiedReachableCount,
      suppressedCount,
      policyExcludedCount: policyFilter.disclosure.excludedPathCount,
      representativePolicyExcludedPaths: policyFilter.disclosure.representativeExcludedPaths,
      entries,
    });

    const result = {
      status: 'success',
      tool: 'dead_code',
      repo: repo.name,
      totalSymbols: allSymbols.length,
      reachableCount: reachableAll.size,
      deadCount,
      verifiedReachableCount,
      suppressed_count: suppressedCount,
      excluded_path_count: policyFilter.disclosure.excludedPathCount,
      representative_excluded_paths: policyFilter.disclosure.representativeExcludedPaths,
      policyFilter: policyFilter.disclosure,
      byBucket: {
        unreached: counts.unreached,
        unused: counts.unused,
        weakly_referenced: counts.weaklyReferenced,
        entrypoint_unknown: counts.entrypointUnknown,
        test_only: counts.testOnly,
        exported_uncalled: counts.unused,
      },
      ...(activeModelPacks.length > 0 ? { activeModelPacks } : {}),
      entries,
      summary,
    };
    return result as AnalysisResult & DeadCodeResult;
  } catch (err) {
    const result = {
      status: 'error',
      tool: 'dead_code',
      repo: repo.name,
      totalSymbols: 0,
      reachableCount: 0,
      deadCount: 0,
      verifiedReachableCount: 0,
      suppressed_count: 0,
      excluded_path_count: 0,
      representative_excluded_paths: [],
      policyFilter: {
        applied: false,
        includeIgnored: false,
        excludedPathCount: 0,
        representativeExcludedPaths: [],
        globs: [],
        sources: [],
      },
      byBucket: {
        unreached: 0,
        unused: 0,
        weakly_referenced: 0,
        entrypoint_unknown: 0,
        test_only: 0,
        exported_uncalled: 0,
      },
      entries: [],
      error: `Dead-code analysis failed: ${deadCodeErrorMessage(err)}`,
      summary: '',
    };
    return result as AnalysisResult & DeadCodeResult;
  }
}
