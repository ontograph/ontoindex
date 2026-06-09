/**
 * gn_find_related — symbol-level neighborhood super-function (Phase 1 W1c).
 *
 * Composes primitives to produce a structured FindRelatedReport for a given
 * symbol (by canonical nodeId or fuzzy name).  Resolves the symbol, then
 * fans out to callers, callees, co-changed files, cluster siblings, and
 * optionally cross-repo references.
 *
 * Pure facade — no caching, no DB writes, no side effects.
 *
 * NOTE: MCP protocol guarantees sequential tool calls.  If future
 * super-functions run concurrently, revisit cross-repo wiring (see
 * project_super-functions-phase-1.md Appendix A item 1).
 */

import { executeParameterized } from '../../core/lbug/pool-adapter.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface FindRelatedParams {
  symbol: string; // canonical nodeId or fuzzy name
  includeCallers?: boolean; // default: true
  includeCallees?: boolean; // default: true
  includeCoChanged?: boolean; // default: true
  includeClusterSiblings?: boolean; // default: true
  includeCrossRepo?: boolean; // default: false (requires group config)
  maxItemsPerCategory?: number; // default: 10
}

export interface FindRelatedReport {
  version: 1;
  resolvedSymbol: { nodeId: string; name: string; filePath: string; kind: string };
  callers: Array<{
    nodeId: string;
    name: string;
    filePath: string;
    relationshipKind: 'CALLS' | 'REFERENCES';
  }>;
  callees: Array<{
    nodeId: string;
    name: string;
    filePath: string;
    relationshipKind: 'CALLS' | 'REFERENCES' | 'IMPORTS';
  }>;
  coChangedFiles: Array<{ filePath: string; coChangeCount: number; lastChangedTogether: string }>;
  clusterSiblings: Array<{ nodeId: string; name: string; filePath: string; reason: string }>;
  crossRepoReferences?: Array<{ repoName: string; nodeId: string; name: string; filePath: string }>;
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Internal Cypher helpers (best-effort — failures push a warning, no throw).
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
 */
async function resolveSymbol(
  repoId: string,
  symbol: string,
): Promise<{ nodeId: string; name: string; filePath: string; kind: string } | null> {
  if (CANONICAL_NODE_ID_RE.test(symbol)) {
    // Treat as a canonical nodeId — verify it exists.
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

  // Fuzzy name lookup — pick the node with the most incoming CALLS edges.
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

async function fetchCallers(
  repoId: string,
  nodeId: string,
  max: number,
): Promise<FindRelatedReport['callers']> {
  try {
    const rows: QueryRow[] = await executeParameterized(
      repoId,
      `MATCH (caller)-[r:CodeRelation]->(target {id: $id})
       WHERE r.type IN ['CALLS', 'REFERENCES']
       RETURN caller.id AS nodeId, caller.name AS name, caller.filePath AS filePath, r.type AS relKind
       LIMIT $max`,
      { id: nodeId, max },
    );
    return rows.map((row) => ({
      nodeId: rowString(row, 'nodeId', 0),
      name: rowString(row, 'name', 1),
      filePath: rowString(row, 'filePath', 2),
      relationshipKind: rowValue(row, 'relKind', 3, 'CALLS') as 'CALLS' | 'REFERENCES',
    }));
  } catch {
    return [];
  }
}

async function fetchCallees(
  repoId: string,
  nodeId: string,
  max: number,
): Promise<FindRelatedReport['callees']> {
  try {
    const rows: QueryRow[] = await executeParameterized(
      repoId,
      `MATCH (target {id: $id})-[r:CodeRelation]->(callee)
       WHERE r.type IN ['CALLS', 'REFERENCES', 'IMPORTS']
       RETURN callee.id AS nodeId, callee.name AS name, callee.filePath AS filePath, r.type AS relKind
       LIMIT $max`,
      { id: nodeId, max },
    );
    return rows.map((row) => ({
      nodeId: rowString(row, 'nodeId', 0),
      name: rowString(row, 'name', 1),
      filePath: rowString(row, 'filePath', 2),
      relationshipKind: rowValue(row, 'relKind', 3, 'CALLS') as 'CALLS' | 'REFERENCES' | 'IMPORTS',
    }));
  } catch {
    return [];
  }
}

async function fetchSymbolFilePath(repoId: string, nodeId: string): Promise<string | null> {
  try {
    const rows: QueryRow[] = await executeParameterized(
      repoId,
      `MATCH (s {id: $id}) RETURN s.filePath AS filePath LIMIT 1`,
      { id: nodeId },
    );
    if (rows.length === 0) return null;
    const row = rows[0];
    return rowValue(row, 'filePath', 0, null) as string | null;
  } catch {
    return null;
  }
}

async function fetchCoChangedFiles(
  repoId: string,
  filePath: string,
  max: number,
): Promise<FindRelatedReport['coChangedFiles']> {
  try {
    const rows: QueryRow[] = await executeParameterized(
      repoId,
      `MATCH (f:File {filePath: $path})-[r:CodeRelation {type: 'CO_CHANGED_WITH'}]-(other:File)
       RETURN other.filePath AS filePath, r.confidence AS coChangeCount, r.lastDate AS lastDate
       ORDER BY r.confidence DESC
       LIMIT $max`,
      { path: filePath, max },
    );
    return rows.map((row) => ({
      filePath: rowString(row, 'filePath', 0),
      coChangeCount: Number(rowValue(row, 'coChangeCount', 1, 0)),
      lastChangedTogether: rowString(row, 'lastDate', 2),
    }));
  } catch {
    return [];
  }
}

async function fetchClusterSiblings(
  repoId: string,
  nodeId: string,
  max: number,
): Promise<FindRelatedReport['clusterSiblings']> {
  try {
    const rows: QueryRow[] = await executeParameterized(
      repoId,
      `MATCH (target {id: $id})-[:CodeRelation {type: 'MEMBER_OF'}]->(c:Community)<-[:CodeRelation {type: 'MEMBER_OF'}]-(sibling)
       WHERE sibling.id <> $id
       RETURN sibling.id AS nodeId, sibling.name AS name, sibling.filePath AS filePath, c.heuristicLabel AS clusterName
       LIMIT $max`,
      { id: nodeId, max },
    );
    return rows.map((row) => {
      const clusterName = rowString(row, 'clusterName', 3);
      return {
        nodeId: rowString(row, 'nodeId', 0),
        name: rowString(row, 'name', 1),
        filePath: rowString(row, 'filePath', 2),
        reason: `same Leiden community: ${clusterName}`,
      };
    });
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Main export.
// ---------------------------------------------------------------------------

export async function gnFindRelated(
  repoId: string,
  params: FindRelatedParams,
): Promise<FindRelatedReport> {
  const warnings: string[] = [];
  const max = params.maxItemsPerCategory ?? 10;

  // Empty resolved symbol used as the "not found" sentinel.
  const emptyResolved = { nodeId: '', name: '', filePath: '', kind: '' };

  // --- 1. Resolve symbol ---------------------------------------------------
  const resolved = await resolveSymbol(repoId, params.symbol);
  if (!resolved || !resolved.nodeId) {
    warnings.push('symbol not found in index');
    return {
      version: 1,
      resolvedSymbol: emptyResolved,
      callers: [],
      callees: [],
      coChangedFiles: [],
      clusterSiblings: [],
      warnings,
    };
  }

  const nodeId = resolved.nodeId;

  // --- 2. Callers ----------------------------------------------------------
  const callers: FindRelatedReport['callers'] =
    params.includeCallers !== false ? await fetchCallers(repoId, nodeId, max) : [];

  // --- 3. Callees ----------------------------------------------------------
  const callees: FindRelatedReport['callees'] =
    params.includeCallees !== false ? await fetchCallees(repoId, nodeId, max) : [];

  // --- 4. Co-changed files -------------------------------------------------
  let coChangedFiles: FindRelatedReport['coChangedFiles'] = [];
  if (params.includeCoChanged !== false) {
    const filePath = resolved.filePath || (await fetchSymbolFilePath(repoId, nodeId));
    if (filePath) {
      coChangedFiles = await fetchCoChangedFiles(repoId, filePath, max);
    }
  }

  // --- 5. Cluster siblings -------------------------------------------------
  const clusterSiblings: FindRelatedReport['clusterSiblings'] =
    params.includeClusterSiblings !== false ? await fetchClusterSiblings(repoId, nodeId, max) : [];

  // --- 6. Cross-repo references (kill-switch: not yet wired) ---------------
  let crossRepoReferences: FindRelatedReport['crossRepoReferences'] | undefined;
  if (params.includeCrossRepo === true) {
    // GroupToolPort.query discovery not yet wired — kill-switch per plan §9.
    crossRepoReferences = [];
    warnings.push('cross-repo not yet wired');
  }

  return {
    version: 1,
    resolvedSymbol: resolved,
    callers,
    callees,
    coChangedFiles,
    clusterSiblings,
    ...(crossRepoReferences !== undefined ? { crossRepoReferences } : {}),
    warnings,
  };
}
