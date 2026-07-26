/**
 * gn_can_delete — dead-code safety super-function (Phase 2 W2b).
 *
 * Composes primitives to produce a structured CanDeleteReport for a given
 * symbol (by canonical nodeId or fuzzy name).  Resolves the symbol, then
 * checks callers, test-file imports, and co-change recency to synthesise
 * a DELETE-SAFE / CAUTION / DO-NOT-DELETE verdict.
 *
 * Pure facade — no caching, no DB writes, no side effects.
 *
 * Cross-repo: kill-switch pattern from Phase 1 W1c — returns [] + warning
 * if GroupToolPort is not wired.
 */

import { executeParameterized } from '../../core/lbug/pool-adapter.js';
import { execFileText } from '../../core/process/exec-file.js';
import { getCurrentCommit } from '../../storage/git.js';
import {
  getStoragePaths,
  listRegisteredRepos,
  loadMeta,
  type RepoMeta,
} from '../../storage/repo-manager.js';
import { findTestFiles } from './_helpers/test-coverage.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ResolvedSymbol {
  nodeId: string;
  name: string;
  filePath: string;
  kind: string;
  ambiguous?: boolean;
}

export interface CanDeleteParams {
  symbol: string;
  includeCrossRepo?: boolean; // default: false (kill-switch as in Phase 1 W1c)
}

export interface CanDeleteReport {
  version: 1;
  symbol: ResolvedSymbol;
  verdict: 'DELETE-SAFE' | 'CAUTION' | 'DO-NOT-DELETE';
  reasoning: string;
  blockers: Array<{
    type:
      | 'caller'
      | 'test'
      | 'cross-repo'
      | 'co-change-recent'
      | 'source-reference'
      | 'incomplete-evidence';
    detail: string;
  }>;
  callers: Array<{ nodeId: string; name: string; filePath: string }>;
  tests: string[];
  crossRepoReferences?: Array<{ repoName: string; nodeId: string; filePath: string }>;
  coChangeNetwork: { siblings: string[]; recentTouchDays: number };
  evidence: {
    graph: 'complete' | 'unavailable';
    tests: 'complete' | 'unavailable';
    source: 'complete' | 'truncated' | 'unavailable';
    freshness: 'fresh' | 'stale' | 'unavailable';
    parserCoverage: 'complete' | 'incomplete' | 'unavailable';
    repositoryMembership: 'tracked' | 'untracked' | 'unavailable';
    buildManifest: 'unavailable';
    sourceReferences: Array<{ filePath: string; line: number; text: string }>;
  };
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Canonical nodeId pattern: starts with an uppercase letter followed by word chars and a colon. */
const CANONICAL_NODE_ID_RE = /^[A-Z]\w+:/;

type QueryRow = Record<string, unknown> & { readonly [index: number]: unknown };

interface EvidenceResult<T> {
  value: T;
  available: boolean;
}

const SOURCE_SEARCH_MAX_MATCHES = 100;
const SOURCE_SEARCH_MAX_BUFFER = 256 * 1024;
const PRODUCTION_SOURCE_GLOBS = [
  '*.ts',
  '*.tsx',
  '*.js',
  '*.jsx',
  '*.mjs',
  '*.cjs',
  '*.mts',
  '*.cts',
];
const TEST_PATH_RE =
  /(^|\/)(?:test|tests|__tests__|fixtures)(?:\/|$)|\.(?:test|spec)\.[cm]?[jt]sx?$/i;

function rowValue(row: QueryRow, key: string, index: number, fallback: unknown): unknown {
  return row[key] ?? row[index] ?? fallback;
}

function rowString(row: QueryRow, key: string, index: number, fallback = ''): string {
  return rowValue(row, key, index, fallback) as string;
}

/**
 * Resolve a fuzzy name to a canonical nodeId.
 * If multiple matches exist, prefer the node with the most incoming CALLS edges.
 * Mirrors the resolution logic from find-related.ts.
 */
async function resolveSymbol(repoId: string, symbol: string): Promise<ResolvedSymbol | null> {
  if (CANONICAL_NODE_ID_RE.test(symbol)) {
    try {
      const rows: QueryRow[] = await executeParameterized(
        repoId,
        `MATCH (s) WHERE s.id = $id
         RETURN s.id AS nodeId, s.name AS name, s.filePath AS filePath, labels(s)[0] AS kind
         LIMIT 1`,
        { id: symbol },
      );
      if (rows.length === 0) return null;
      const row = rows[0];
      return {
        nodeId: rowString(row, 'nodeId', 0),
        name: rowString(row, 'name', 1),
        filePath: rowString(row, 'filePath', 2),
        kind: rowString(row, 'kind', 3),
      };
    } catch {
      return null;
    }
  }

  try {
    const candidates: QueryRow[] = await executeParameterized(
      repoId,
      `MATCH (s) WHERE s.name = $name
       OPTIONAL MATCH (caller)-[r:CodeRelation]->(s) WHERE r.type = 'CALLS'
       RETURN s.id AS nodeId, s.name AS name, s.filePath AS filePath, labels(s)[0] AS kind,
              COUNT(caller) AS callerCount
       ORDER BY callerCount DESC
       LIMIT 5`,
      { name: symbol },
    );
    if (candidates.length === 0) return null;
    const row = candidates[0];
    return {
      nodeId: rowString(row, 'nodeId', 0),
      name: rowString(row, 'name', 1),
      filePath: rowString(row, 'filePath', 2),
      kind: rowString(row, 'kind', 3),
      ...(candidates.length > 1 ? { ambiguous: true } : {}),
    };
  } catch {
    return null;
  }
}

async function fetchCallers(
  repoId: string,
  nodeId: string,
): Promise<EvidenceResult<CanDeleteReport['callers']>> {
  try {
    const rows: QueryRow[] = await executeParameterized(
      repoId,
      `MATCH (caller)-[r:CodeRelation]->(target {id: $id})
       WHERE r.type IN ['CALLS', 'REFERENCES']
       RETURN caller.id AS nodeId, caller.name AS name, caller.filePath AS filePath
       LIMIT 100`,
      { id: nodeId },
    );
    return {
      value: rows.map((row) => ({
        nodeId: rowString(row, 'nodeId', 0),
        name: rowString(row, 'name', 1),
        filePath: rowString(row, 'filePath', 2),
      })),
      available: true,
    };
  } catch {
    return { value: [], available: false };
  }
}

interface CoChangeResult {
  siblings: string[];
  recentTouchDays: number;
}

async function fetchCoChangeNetwork(repoId: string, filePath: string): Promise<CoChangeResult> {
  if (!filePath) return { siblings: [], recentTouchDays: -1 };
  try {
    const rows: QueryRow[] = await executeParameterized(
      repoId,
      `MATCH (f:File {filePath: $path})-[r:CodeRelation {type: 'CO_CHANGED_WITH'}]-(other:File)
       RETURN other.filePath AS filePath, r.confidence AS confidence, r.lastDate AS lastDate
       ORDER BY r.confidence DESC
       LIMIT 10`,
      { path: filePath },
    );

    const siblings: string[] = [];
    let mostRecentMs = -1;

    for (const row of rows) {
      const fp = rowString(row, 'filePath', 0);
      if (fp) siblings.push(fp);

      const lastDate = rowString(row, 'lastDate', 2);
      if (lastDate) {
        const ms = Date.parse(lastDate);
        if (!Number.isNaN(ms) && ms > mostRecentMs) mostRecentMs = ms;
      }
    }

    const recentTouchDays =
      mostRecentMs > 0 ? Math.floor((Date.now() - mostRecentMs) / (1000 * 60 * 60 * 24)) : -1;

    return { siblings, recentTouchDays };
  } catch {
    return { siblings: [], recentTouchDays: -1 };
  }
}

async function resolveRepoRoot(repoId: string): Promise<string | null> {
  const normalized = repoId.trim().toLowerCase();
  const repos = await listRegisteredRepos();
  return (
    repos.find((repo) => repo.name.toLowerCase() === normalized || repo.path === repoId)?.path ??
    null
  );
}

function parserCoverage(
  meta: RepoMeta | null,
  filePath: string,
): CanDeleteReport['evidence']['parserCoverage'] {
  if (!meta) return 'unavailable';
  if (meta.indexMode === 'symbols-only' || meta.pipelineProfile !== 'full') return 'incomplete';
  if (meta.skippedPhases?.includes('parse')) return 'incomplete';
  if (meta.degradedFiles?.some((file) => file.filePath === filePath)) return 'incomplete';
  return 'complete';
}

function isDefinitionLine(text: string, symbol: ResolvedSymbol): boolean {
  const escaped = symbol.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = [
    new RegExp(`\\b(?:class|interface|enum|type|function)\\s+${escaped}\\b`),
    new RegExp(`\\b(?:const|let|var)\\s+${escaped}\\b`),
    new RegExp(`\\b${escaped}\\s*[:=]\\s*(?:class|function|\\()`),
  ];
  return patterns.some((pattern) => pattern.test(text));
}

async function searchProductionReferences(
  repoRoot: string,
  symbol: ResolvedSymbol,
): Promise<{
  status: CanDeleteReport['evidence']['source'];
  references: CanDeleteReport['evidence']['sourceReferences'];
}> {
  try {
    const output = await execFileText(
      'git',
      ['grep', '-n', '-I', '-F', '-e', symbol.name, '--', ...PRODUCTION_SOURCE_GLOBS],
      { cwd: repoRoot, timeoutMs: 5_000, maxBuffer: SOURCE_SEARCH_MAX_BUFFER },
    );
    const matches = output
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const match = /^(.+?):(\d+):(.*)$/.exec(line);
        return match
          ? { filePath: match[1], line: Number(match[2]), text: match[3].trim().slice(0, 240) }
          : null;
      })
      .filter((match): match is NonNullable<typeof match> => Boolean(match))
      .filter((match) => !TEST_PATH_RE.test(match.filePath));

    let skippedDefinition = false;
    const references = matches.filter((match) => {
      if (
        !skippedDefinition &&
        match.filePath === symbol.filePath &&
        isDefinitionLine(match.text, symbol)
      ) {
        skippedDefinition = true;
        return false;
      }
      return true;
    });

    return {
      status: references.length >= SOURCE_SEARCH_MAX_MATCHES ? 'truncated' : 'complete',
      references: references.slice(0, SOURCE_SEARCH_MAX_MATCHES),
    };
  } catch (error) {
    const code =
      typeof error === 'object' && error !== null && 'code' in error
        ? String((error as { code?: unknown }).code)
        : '';
    if (code === '1') return { status: 'complete', references: [] };
    if (code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
      return { status: 'truncated', references: [] };
    }
    return { status: 'unavailable', references: [] };
  }
}

async function checkTracked(
  repoRoot: string,
  filePath: string,
): Promise<'tracked' | 'untracked' | 'unavailable'> {
  try {
    await execFileText('git', ['ls-files', '--error-unmatch', '--', filePath], {
      cwd: repoRoot,
      timeoutMs: 5_000,
      maxBuffer: 16 * 1024,
    });
    return 'tracked';
  } catch (error) {
    const code =
      typeof error === 'object' && error !== null && 'code' in error
        ? String((error as { code?: unknown }).code)
        : '';
    return code === '1' ? 'untracked' : 'unavailable';
  }
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export async function gnCanDelete(
  repoId: string,
  params: CanDeleteParams,
): Promise<CanDeleteReport> {
  const warnings: string[] = [];
  const blockers: CanDeleteReport['blockers'] = [];

  // --- 1. Resolve symbol -----------------------------------------------------
  const resolved = await resolveSymbol(repoId, params.symbol);
  if (!resolved || !resolved.nodeId) {
    return {
      version: 1,
      symbol: { nodeId: '', name: params.symbol, filePath: '', kind: '' },
      verdict: 'CAUTION',
      reasoning: 'Symbol could not be resolved; deletion safety cannot be proven.',
      blockers: [{ type: 'incomplete-evidence', detail: 'symbol resolution failed' }],
      callers: [],
      tests: [],
      coChangeNetwork: { siblings: [], recentTouchDays: -1 },
      evidence: {
        graph: 'unavailable',
        tests: 'unavailable',
        source: 'unavailable',
        freshness: 'unavailable',
        parserCoverage: 'unavailable',
        repositoryMembership: 'unavailable',
        buildManifest: 'unavailable',
        sourceReferences: [],
      },
      warnings: ['symbol not in index'],
    };
  }

  // --- 2. Find callers -------------------------------------------------------
  const callerResult = await fetchCallers(repoId, resolved.nodeId);
  const callers = callerResult.value;
  for (const caller of callers) {
    blockers.push({ type: 'caller', detail: `called by ${caller.name}` });
  }

  // --- 3. Find test files ----------------------------------------------------
  let tests: string[] = [];
  let testsAvailable = true;
  try {
    ({ coveringTests: tests } = await findTestFiles(repoId, resolved.filePath, resolved.name));
  } catch {
    testsAvailable = false;
  }
  for (const testPath of tests) {
    blockers.push({ type: 'test', detail: `imported by test ${testPath}` });
  }

  // --- 4. Co-change recency --------------------------------------------------
  const coChangeNetwork = await fetchCoChangeNetwork(repoId, resolved.filePath);
  const { recentTouchDays } = coChangeNetwork;
  if (recentTouchDays >= 0 && recentTouchDays < 7) {
    blockers.push({
      type: 'co-change-recent',
      detail: `recently touched (~${recentTouchDays} days ago)`,
    });
  }

  // --- 5. Cross-repo (kill-switch: not yet wired) ---------------------------
  let crossRepoReferences: CanDeleteReport['crossRepoReferences'] | undefined;
  if (params.includeCrossRepo === true) {
    // GroupToolPort.query discovery not yet wired — kill-switch per plan §10.
    crossRepoReferences = [];
    warnings.push('cross-repo not yet wired');
  }

  const repoRoot = await resolveRepoRoot(repoId).catch(() => null);
  const meta = repoRoot ? await loadMeta(getStoragePaths(repoRoot).storagePath) : null;
  const currentCommit = repoRoot ? getCurrentCommit(repoRoot) : undefined;
  const freshness =
    !meta?.lastCommit || !currentCommit
      ? 'unavailable'
      : meta.lastCommit === currentCommit
        ? 'fresh'
        : 'stale';
  const sourceEvidence = repoRoot
    ? await searchProductionReferences(repoRoot, resolved)
    : { status: 'unavailable' as const, references: [] };
  const repositoryMembership = repoRoot
    ? await checkTracked(repoRoot, resolved.filePath)
    : ('unavailable' as const);
  const coverage = parserCoverage(meta, resolved.filePath);

  for (const reference of sourceEvidence.references) {
    blockers.push({
      type: 'source-reference',
      detail: `${reference.filePath}:${reference.line}: ${reference.text}`,
    });
  }

  const incompleteEvidence = [
    !callerResult.available ? 'graph caller/reference query unavailable' : '',
    !testsAvailable ? 'test-import query unavailable' : '',
    sourceEvidence.status !== 'complete' ? `production source search ${sourceEvidence.status}` : '',
    freshness !== 'fresh' ? `index freshness ${freshness}` : '',
    coverage !== 'complete' ? `parser coverage ${coverage}` : '',
    repositoryMembership !== 'tracked' ? `repository membership ${repositoryMembership}` : '',
    'build-manifest coverage unavailable',
    resolved.ambiguous ? 'multiple indexed symbols share this name' : '',
    params.includeCrossRepo === true ? 'cross-repo reference search unavailable' : '',
  ].filter(Boolean);
  for (const detail of incompleteEvidence) {
    blockers.push({ type: 'incomplete-evidence', detail });
    warnings.push(detail);
  }

  // --- 6. Verdict matrix ----------------------------------------------------
  const hasCallers = callers.length > 0;
  const hasTests = tests.length > 0;
  const hasSourceReferences = sourceEvidence.references.length > 0;
  const hasCrossRepo = crossRepoReferences !== undefined && crossRepoReferences.length > 0;
  const isRecentlyTouched = recentTouchDays >= 0 && recentTouchDays < 7;

  let verdict: CanDeleteReport['verdict'];
  let reasoning: string;

  if (hasCallers || hasTests || hasCrossRepo || hasSourceReferences) {
    verdict = 'DO-NOT-DELETE';
    const reasons: string[] = [];
    if (hasCallers) reasons.push(`${callers.length} caller(s)`);
    if (hasTests) reasons.push(`${tests.length} test file(s)`);
    if (hasCrossRepo) reasons.push('cross-repo references');
    if (hasSourceReferences)
      reasons.push(`${sourceEvidence.references.length} production reference(s)`);
    reasoning = `Symbol has active dependencies: ${reasons.join(', ')}.`;
  } else if (incompleteEvidence.length > 0) {
    verdict = 'CAUTION';
    reasoning = `No active dependency was proven${
      isRecentlyTouched ? `; symbol was recently touched (~${recentTouchDays} days ago)` : ''
    }, but deletion safety is incomplete: ${incompleteEvidence.join(', ')}.`;
  } else if (isRecentlyTouched) {
    verdict = 'CAUTION';
    reasoning = `No callers or tests found, but symbol was recently touched (~${recentTouchDays} days ago) — recent activity may signal active use not yet indexed.`;
  } else {
    verdict = 'DELETE-SAFE';
    reasoning =
      'No graph, test, bounded production-source, manifest, freshness, or parser-coverage blocker was detected.';
  }

  return {
    version: 1,
    symbol: resolved,
    verdict,
    reasoning,
    blockers,
    callers,
    tests,
    ...(crossRepoReferences !== undefined ? { crossRepoReferences } : {}),
    coChangeNetwork,
    evidence: {
      graph: callerResult.available ? 'complete' : 'unavailable',
      tests: testsAvailable ? 'complete' : 'unavailable',
      source: sourceEvidence.status,
      freshness,
      parserCoverage: coverage,
      repositoryMembership,
      buildManifest: 'unavailable',
      sourceReferences: sourceEvidence.references,
    },
    warnings,
  };
}
