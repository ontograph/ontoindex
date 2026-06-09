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
import { findTestFiles } from './_helpers/test-coverage.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ResolvedSymbol {
  nodeId: string;
  name: string;
  filePath: string;
  kind: string;
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
    type: 'caller' | 'test' | 'cross-repo' | 'co-change-recent';
    detail: string;
  }>;
  callers: Array<{ nodeId: string; name: string; filePath: string }>;
  tests: string[];
  crossRepoReferences?: Array<{ repoName: string; nodeId: string; filePath: string }>;
  coChangeNetwork: { siblings: string[]; recentTouchDays: number };
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Canonical nodeId pattern: starts with an uppercase letter followed by word chars and a colon. */
const CANONICAL_NODE_ID_RE = /^[A-Z]\w+:/;

type QueryRow = Record<string, unknown> & { readonly [index: number]: unknown };

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
    };
  } catch {
    return null;
  }
}

async function fetchCallers(repoId: string, nodeId: string): Promise<CanDeleteReport['callers']> {
  try {
    const rows: QueryRow[] = await executeParameterized(
      repoId,
      `MATCH (caller)-[r:CodeRelation]->(target {id: $id})
       WHERE r.type IN ['CALLS', 'REFERENCES']
       RETURN caller.id AS nodeId, caller.name AS name, caller.filePath AS filePath
       LIMIT 100`,
      { id: nodeId },
    );
    return rows.map((row) => ({
      nodeId: rowString(row, 'nodeId', 0),
      name: rowString(row, 'name', 1),
      filePath: rowString(row, 'filePath', 2),
    }));
  } catch {
    return [];
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
      verdict: 'DELETE-SAFE',
      reasoning: 'symbol not in index — already gone',
      blockers: [],
      callers: [],
      tests: [],
      coChangeNetwork: { siblings: [], recentTouchDays: -1 },
      warnings: ['symbol not in index'],
    };
  }

  // --- 2. Find callers -------------------------------------------------------
  const callers = await fetchCallers(repoId, resolved.nodeId);
  for (const caller of callers) {
    blockers.push({ type: 'caller', detail: `called by ${caller.name}` });
  }

  // --- 3. Find test files ----------------------------------------------------
  const { coveringTests: tests } = await findTestFiles(repoId, resolved.filePath, resolved.name);
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

  // --- 6. Verdict matrix ----------------------------------------------------
  const hasCallers = callers.length > 0;
  const hasTests = tests.length > 0;
  const hasCrossRepo = crossRepoReferences !== undefined && crossRepoReferences.length > 0;
  const isRecentlyTouched = recentTouchDays >= 0 && recentTouchDays < 7;

  let verdict: CanDeleteReport['verdict'];
  let reasoning: string;

  if (hasCallers || hasTests || hasCrossRepo) {
    verdict = 'DO-NOT-DELETE';
    const reasons: string[] = [];
    if (hasCallers) reasons.push(`${callers.length} caller(s)`);
    if (hasTests) reasons.push(`${tests.length} test file(s)`);
    if (hasCrossRepo) reasons.push('cross-repo references');
    reasoning = `Symbol has active dependencies: ${reasons.join(', ')}.`;
  } else if (isRecentlyTouched) {
    verdict = 'CAUTION';
    reasoning = `No callers or tests found, but symbol was recently touched (~${recentTouchDays} days ago) — recent activity may signal active use not yet indexed.`;
  } else {
    verdict = 'DELETE-SAFE';
    reasoning = 'No callers, no test coverage, and no recent co-change activity detected.';
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
    warnings,
  };
}
