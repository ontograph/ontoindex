/**
 * gn_explore — concept-level discovery super-function (Phase 1 W1a).
 *
 * Composes primitives to produce a structured ExploreReport from a free-text
 * query.
 *
 * Pure facade — no caching, no DB writes, no process-global side effects.
 */

import {
  classifyIntent,
  type Intent,
  type IntentClassification,
} from '../../core/search/intent-classifier.js';
import path from 'path';
import { getFileSkeleton } from '../../core/search/skeleton.js';
import { computeGraphPath, type GraphPathEdge } from '../../core/search/graph-path.js';
import { executeParameterized, initLbug } from '../../core/lbug/pool-adapter.js';
import { query as backendQuery } from '../local/backend-search.js';

// Re-export so callers can use IntentLabel without importing intent-classifier.
export type IntentLabel = Intent;

export interface ExploreParams {
  query: string;
  depth?: 'shallow' | 'balanced' | 'deep'; // default: 'balanced'
  qualityMode?: 'fast' | 'balanced' | 'thorough'; // default: 'balanced'
  includeSkeletons?: boolean; // default: true
  includeCitations?: boolean; // default: true
}

export interface ExploreReport {
  version: 1;
  query: {
    original: string;
    classified: { intent: IntentLabel; confidence: number };
  };
  topProcesses: Array<{
    name: string;
    description: string;
    keySymbols: string[];
    relevanceScore: number;
  }>;
  topSymbols: Array<{
    nodeId: string;
    name: string;
    skeleton?: string;
    filePath: string;
    cluster: string;
    citations?: GraphPathEdge[];
    coChangedFiles: string[];
  }>;
  clusters: Array<{ name: string; role: string; fileCount: number; keyFiles: string[] }>;
  suggestedEntryPoints: Array<{
    type: 'process' | 'symbol' | 'file';
    nodeId: string;
    rationale: string;
  }>;
  warnings: string[];
}

/** Skeleton depth per intent class — mirrors backend-search.ts internal table. */
const SKELETON_DEPTH_BY_INTENT: Record<Intent, number> = {
  'calls-of': 2,
  'cross-file-impact': 2,
  'nl-conceptual': 3,
  ambiguous: 3,
};

/** Top-N symbols to process per depth setting. */
const TOP_N_BY_DEPTH: Record<NonNullable<ExploreParams['depth']>, number> = {
  shallow: 3,
  balanced: 5,
  deep: 10,
};
const ENRICH_SYMBOL_CONCURRENCY = 2;

type QueryRow = Record<string, unknown> | readonly unknown[];

interface QuerySymbol {
  nodeId?: unknown;
  id?: unknown;
  filePath?: unknown;
  name?: unknown;
  process_id?: unknown;
}

interface QueryProcess {
  id?: unknown;
  summary?: unknown;
  heuristicLabel?: unknown;
  label?: unknown;
  priority?: unknown;
}

interface ExploreQueryResult {
  processes?: QueryProcess[];
  process_symbols?: QuerySymbol[];
  definitions?: QuerySymbol[];
}

function rowValue(row: QueryRow, key: string, index: number): unknown {
  const values = row as Record<string, unknown>;
  return values[key] ?? values[index];
}

function rowString(row: QueryRow, key: string, index: number): string {
  return (rowValue(row, key, index) ?? '') as string;
}

async function mapLimited<T, R>(
  values: T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < values.length) {
      const index = next++;
      results[index] = await mapper(values[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, () => worker()));
  return results;
}

// ---------------------------------------------------------------------------
// Cypher helpers (best-effort — failures push a warning, do not throw).
// ---------------------------------------------------------------------------

async function fetchCluster(
  repoId: string,
  nodeId: string,
): Promise<{ name: string; role: string } | null> {
  try {
    const rows = await executeParameterized(
      repoId,
      `MATCH (n {id: $nodeId})-[:CodeRelation {type: 'MEMBER_OF'}]->(c:Community)
       RETURN c.heuristicLabel AS name, c.role AS role
       LIMIT 1`,
      { nodeId },
    );
    if (rows.length === 0) return null;
    const row = rows[0] as QueryRow;
    return {
      name: rowString(row, 'name', 0),
      role: rowString(row, 'role', 1),
    };
  } catch {
    return null;
  }
}

async function fetchCoChangedFiles(repoId: string, filePath: string): Promise<string[]> {
  try {
    const rows = await executeParameterized(
      repoId,
      `MATCH (f:File {filePath: $path})-[r:CodeRelation {type: 'CO_CHANGED_WITH'}]-(other:File)
       RETURN other.filePath AS otherPath, r.count AS cnt
       ORDER BY r.count DESC
       LIMIT 5`,
      { path: filePath },
    );
    return (rows as QueryRow[]).map((row) => rowString(row, 'otherPath', 0)).filter(Boolean);
  } catch {
    return [];
  }
}

async function fetchClusterFileCount(repoId: string, clusterName: string): Promise<number> {
  try {
    const rows = await executeParameterized(
      repoId,
      `MATCH (f:File)-[:CodeRelation {type: 'IN_COMMUNITY'}]->(c:Community {heuristicLabel: $name})
       RETURN count(f) AS cnt
       LIMIT 1`,
      { name: clusterName },
    );
    if (rows.length === 0) return 0;
    const row = rows[0] as QueryRow;
    return Number(rowValue(row, 'cnt', 0) ?? 0);
  } catch {
    return 0;
  }
}

async function fetchClusterKeyFiles(repoId: string, clusterName: string): Promise<string[]> {
  try {
    const rows = await executeParameterized(
      repoId,
      `MATCH (f:File)-[:CodeRelation {type: 'IN_COMMUNITY'}]->(c:Community {heuristicLabel: $name})
       RETURN f.filePath AS fp
       LIMIT 3`,
      { name: clusterName },
    );
    return (rows as QueryRow[]).map((row) => rowString(row, 'fp', 0)).filter(Boolean);
  } catch {
    return [];
  }
}

import { listRegisteredRepos } from '../../storage/repo-manager.js';

// ---------------------------------------------------------------------------
// Main export.
// ---------------------------------------------------------------------------

export async function gnExplore(repoId: string, params: ExploreParams): Promise<ExploreReport> {
  const warnings: string[] = [];
  const allRepos = await listRegisteredRepos();
  const requestedRepo = repoId.toLowerCase();
  const repo = allRepos.find(
    (r) =>
      r.name === repoId ||
      r.path === repoId ||
      r.name.toLowerCase() === requestedRepo ||
      r.path.toLowerCase() === requestedRepo,
  );
  if (!repo) {
    throw new Error(`Repository not found: ${repoId}`);
  }
  const canonicalRepoId = repo.name.toLowerCase();
  const resolvedRepo = { ...repo, id: canonicalRepoId, repoPath: repo.path };
  await initLbug(canonicalRepoId, path.join(repo.storagePath, 'lbug'));

  // --- 1. Classify intent -------------------------------------------------
  const classification: IntentClassification = classifyIntent(params.query);
  const intent: Intent = classification.intent;

  // --- 2. Run query primitive (ensemble applied internally) ---------------
  let queryResult: ExploreQueryResult;
  try {
    queryResult = (await backendQuery(resolvedRepo as any, {
      query: params.query,
      include_citations: params.includeCitations !== false,
      intent_ensemble: true,
    })) as ExploreQueryResult;
  } catch (err) {
    warnings.push(`query primitive failed: ${err instanceof Error ? err.message : String(err)}`);
    queryResult = { processes: [], process_symbols: [], definitions: [] };
  }

  // --- 3. Select top-N symbols ------------------------------------------
  const depth = params.depth ?? 'balanced';
  const topN = TOP_N_BY_DEPTH[depth];

  const allSymbols: QuerySymbol[] = [
    ...(queryResult.process_symbols ?? []),
    ...(queryResult.definitions ?? []),
  ];
  const candidateSymbols = allSymbols.filter((s) => s && (s.nodeId || s.id)).slice(0, topN);

  // --- 4. Enrich each symbol with bounded DB concurrency -----------------
  const skeletonDepth = SKELETON_DEPTH_BY_INTENT[intent] ?? 3;
  const includeSkeletons = params.includeSkeletons !== false;
  const includeCitations = params.includeCitations !== false;

  const enrichedSymbols = await mapLimited(
    candidateSymbols,
    ENRICH_SYMBOL_CONCURRENCY,
    async (sym) => {
      const nodeId = (sym.nodeId ?? sym.id ?? '') as string;
      const filePath = (sym.filePath ?? '') as string;
      const name = (sym.name ?? '') as string;

      // Skeleton
      let skeleton: string | undefined;
      if (includeSkeletons && filePath) {
        try {
          const text = await getFileSkeleton(canonicalRepoId, filePath, skeletonDepth);
          if (text) skeleton = text;
        } catch {
          // best-effort
        }
      }

      // Citations (graph-path BFS)
      let citations: GraphPathEdge[] | undefined;
      if (includeCitations && nodeId) {
        try {
          citations = await computeGraphPath(canonicalRepoId, nodeId);
        } catch {
          // best-effort
        }
      }

      // Cluster
      const clusterInfo = nodeId ? await fetchCluster(canonicalRepoId, nodeId) : null;
      const cluster = clusterInfo?.name ?? '';

      // Co-changed files
      const coChangedFiles = filePath ? await fetchCoChangedFiles(canonicalRepoId, filePath) : [];

      return {
        nodeId,
        name,
        ...(skeleton !== undefined ? { skeleton } : {}),
        filePath,
        cluster,
        ...(citations !== undefined ? { citations } : {}),
        coChangedFiles,
      };
    },
  );

  // --- 5. Top processes -------------------------------------------------
  const rawProcesses: QueryProcess[] = queryResult.processes ?? [];
  const topProcesses = rawProcesses.slice(0, topN).map((p) => ({
    name: (p.id ?? '') as string,
    description: (p.summary ?? p.heuristicLabel ?? p.label ?? '') as string,
    keySymbols: (queryResult.process_symbols ?? [])
      .filter((s) => s.process_id === p.id)
      .slice(0, 3)
      .map((s) => s.name ?? '') as string[],
    relevanceScore: (p.priority ?? 0) as number,
  }));

  // --- 6. Clusters (deduplicated) ----------------------------------------
  const clusterMap = new Map<string, { role: string }>();
  for (const sym of enrichedSymbols) {
    if (sym.cluster && !clusterMap.has(sym.cluster)) {
      const nodeId = sym.nodeId;
      const clusterInfo = nodeId ? await fetchCluster(canonicalRepoId, nodeId) : null;
      clusterMap.set(sym.cluster, { role: clusterInfo?.role ?? '' });
    }
  }

  const clusters = await mapLimited(
    Array.from(clusterMap.entries()).slice(0, 3),
    ENRICH_SYMBOL_CONCURRENCY,
    async ([name, { role }]) => {
      const fileCount = await fetchClusterFileCount(canonicalRepoId, name);
      const keyFiles = await fetchClusterKeyFiles(canonicalRepoId, name);
      return { name, role, fileCount, keyFiles };
    },
  );

  // --- 7. Suggested entry points (max 3) --------------------------------
  const suggestedEntryPoints: ExploreReport['suggestedEntryPoints'] = [];

  // Top process when available
  if (topProcesses.length > 0) {
    suggestedEntryPoints.push({
      type: 'process',
      nodeId: topProcesses[0].name,
      rationale: `Top-ranked process: ${topProcesses[0].description || topProcesses[0].name}`,
    });
  }

  // Top symbol with non-trivial relevance
  const topSym = enrichedSymbols[0];
  if (topSym?.nodeId && suggestedEntryPoints.length < 3) {
    suggestedEntryPoints.push({
      type: 'symbol',
      nodeId: topSym.nodeId,
      rationale: `Top-ranked symbol: ${topSym.name}`,
    });
  }

  // File of top symbol
  if (topSym?.filePath && suggestedEntryPoints.length < 3) {
    suggestedEntryPoints.push({
      type: 'file',
      nodeId: topSym.filePath,
      rationale: `File containing top-ranked symbol: ${topSym.name}`,
    });
  }

  return {
    version: 1,
    query: {
      original: params.query,
      classified: {
        intent: classification.intent,
        confidence: classification.confidence,
      },
    },
    topProcesses,
    topSymbols: enrichedSymbols,
    clusters,
    suggestedEntryPoints,
    warnings,
  };
}
