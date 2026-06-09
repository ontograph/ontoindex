/**
 * Graph-aware diff review builder — shared core for `gn_diff_impact` and future CLI.
 *
 * `buildDiffReview` accepts a list of changed file paths and a numstat map, finds the symbols
 * defined in each file via the DEFINES relationship, then computes per-symbol blast-radius using
 * the authoritative impact kernel for upstream counts (depth=1, CALLS+REFERENCES).  Downstream
 * counts use a cheap heuristic direct probe and are labelled accordingly.
 */

import { executeParameterized } from '../lbug/pool-adapter.js';
import {
  runImpactKernel,
  SAFE_EDIT_UPSTREAM_RELATION_TYPES,
  type ImpactKernelRepoHandle,
} from '../impact/impact-kernel.js';
import {
  classifyReviewRisk,
  type AffectedCommunity,
  type AffectedProcess,
  type DiffReviewResult,
  type GraphSections,
  type ReviewFile,
  type ReviewSymbol,
} from './review-types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BuildDiffReviewOptions {
  /** Maximum symbols returned per file from the DEFINES query. Default: 50. */
  maxSymbolsPerFile?: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type QueryRow = Record<string, unknown> | readonly unknown[];

function rowStr(row: QueryRow, key: string, index: number, fallback = ''): string {
  const keyed = (row as Record<string, unknown>)[key];
  if (keyed !== undefined && keyed !== null) return String(keyed);
  if (Array.isArray(row) && row[index] !== undefined) return String(row[index]);
  return fallback;
}

function rowNum(row: QueryRow, key: string, index: number): number {
  const keyed = (row as Record<string, unknown>)[key];
  const raw = keyed !== undefined ? keyed : Array.isArray(row) ? row[index] : undefined;
  return Number(raw) || 0;
}

// ---------------------------------------------------------------------------
// Main builder
// ---------------------------------------------------------------------------

/**
 * Build a graph-aware diff review for the given changed file paths.
 *
 * @param repoId      - LadybugDB repo identifier.
 * @param changedPaths - Ordered list of changed file paths from `git diff --name-only`.
 * @param numstatMap  - Map of path → { added, removed } line counts from `git diff --numstat`.
 * @param opts        - Optional tuning parameters.
 */
export async function buildDiffReview(
  repoId: string,
  changedPaths: string[],
  numstatMap: Map<string, { added: number; removed: number }>,
  opts: BuildDiffReviewOptions = {},
): Promise<DiffReviewResult> {
  const { maxSymbolsPerFile = 50 } = opts;
  const warnings: string[] = [];
  const reviewedFiles: ReviewFile[] = [];
  const highRiskSymbols: string[] = [];
  let totalSymbolsChanged = 0;

  // Thin repo handle for the impact kernel — only the id is required.
  const repo: ImpactKernelRepoHandle = { id: repoId };

  for (const filePath of changedPaths) {
    const { added = 0, removed = 0 } = numstatMap.get(filePath) ?? {};

    // ---- Find symbols defined in this file via DEFINES relationship -------
    let symbolRows: QueryRow[] = [];
    try {
      symbolRows = (await executeParameterized(
        repoId,
        `MATCH (f:File {filePath: $path})-[r:CodeRelation {type: 'DEFINES'}]->(s)
         RETURN s.id AS id, s.name AS name LIMIT ${maxSymbolsPerFile}`,
        { path: filePath },
      )) as QueryRow[];
    } catch (err) {
      warnings.push(
        `graph query failed for ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const changedSymbols: ReviewSymbol[] = [];

    for (const row of symbolRows) {
      const nodeId = rowStr(row, 'id', 0);
      const name = rowStr(row, 'name', 1, '(unknown)');

      let upstreamCount = 0;
      let downstreamCount = 0;
      let heuristic = false;

      if (nodeId) {
        // ---- Authoritative upstream count via impact kernel (depth=1) -----
        // The kernel traverses the CALLS+REFERENCES edges one hop upstream and
        // returns an exact direct-caller count.  This is the authoritative number
        // that drives risk classification.
        try {
          const kernelResult = await runImpactKernel(
            repo,
            { id: nodeId, name, type: undefined, filePath },
            {
              direction: 'upstream',
              maxDepth: 1,
              relationTypes: SAFE_EDIT_UPSTREAM_RELATION_TYPES,
              includeTests: true,
            },
          );
          upstreamCount = kernelResult.rawCounts.direct;
          for (const w of kernelResult.warnings) {
            warnings.push(`[kernel:${name}] ${w}`);
          }
        } catch (err) {
          // Fall back to a cheap heuristic probe and label it as such.
          heuristic = true;
          warnings.push(
            `impact kernel failed for ${name}, using heuristic count: ${err instanceof Error ? err.message : String(err)}`,
          );
          try {
            const upRows = (await executeParameterized(
              repoId,
              `MATCH (caller)-[r:CodeRelation]->(target {id: $id})
               WHERE r.type IN ['CALLS', 'REFERENCES']
               RETURN count(*) AS count`,
              { id: nodeId },
            )) as QueryRow[];
            upstreamCount = upRows.length > 0 ? rowNum(upRows[0], 'count', 0) : 0;
          } catch {
            // best-effort
          }
        }

        // ---- Heuristic downstream count (cheap direct probe) --------------
        // Downstream count is informational only — risk is driven by upstream.
        // It is always a single-hop direct count and is not routed through the kernel.
        try {
          const downRows = (await executeParameterized(
            repoId,
            `MATCH (target {id: $id})-[r:CodeRelation]->(callee)
             WHERE r.type IN ['CALLS', 'REFERENCES', 'IMPORTS']
             RETURN count(*) AS count`,
            { id: nodeId },
          )) as QueryRow[];
          downstreamCount = downRows.length > 0 ? rowNum(downRows[0], 'count', 0) : 0;
        } catch {
          // best-effort
        }
      }

      const risk = classifyReviewRisk(upstreamCount);
      changedSymbols.push({
        nodeId,
        name,
        impact: { upstreamCount, downstreamCount, risk, heuristic },
      });

      if (risk === 'HIGH' && name && name !== '(unknown)') {
        highRiskSymbols.push(name);
      }
    }

    totalSymbolsChanged += changedSymbols.length;
    reviewedFiles.push({
      path: filePath,
      addedLines: added,
      removedLines: removed,
      changedSymbols,
    });
  }

  // ---- Collect all changed node IDs for cross-symbol graph queries ----------
  const allNodeIds = reviewedFiles
    .flatMap((f) => f.changedSymbols.map((s) => s.nodeId))
    .filter(Boolean);

  // ---- Process / execution-flow enrichment (REV-3) -------------------------
  const { affectedProcesses, processesAvailable } = await queryAffectedProcesses(
    repoId,
    allNodeIds,
    warnings,
  );

  // ---- Community / cluster enrichment (REV-3) ------------------------------
  const { affectedCommunities, communitiesAvailable } = await queryAffectedCommunities(
    repoId,
    allNodeIds,
    warnings,
  );

  // ---- Cross-community ranking hints (REV-3) --------------------------------
  // These are advisory only: they never trim complete impact output.
  const crossCommunityRiskReasons = buildCrossCommunityHints(
    affectedCommunities,
    communitiesAvailable,
    highRiskSymbols,
  );

  const graphSections: GraphSections = { processesAvailable, communitiesAvailable };

  return {
    reviewedFiles,
    totalSymbolsChanged,
    highRiskSymbols,
    warnings,
    affectedProcesses,
    affectedCommunities,
    crossCommunityRiskReasons,
    graphSections,
  };
}

// ---------------------------------------------------------------------------
// REV-3: Process enrichment helper
// ---------------------------------------------------------------------------

async function queryAffectedProcesses(
  repoId: string,
  nodeIds: string[],
  warnings: string[],
): Promise<{ affectedProcesses: AffectedProcess[]; processesAvailable: boolean }> {
  if (nodeIds.length === 0) {
    return { affectedProcesses: [], processesAvailable: true };
  }
  try {
    const rows = (await executeParameterized(
      repoId,
      `MATCH (n)-[r:CodeRelation {type: 'STEP_IN_PROCESS'}]->(p:Process)
       WHERE n.id IN $ids
       RETURN p.id AS pid, p.heuristicLabel AS name, p.processType AS processType,
              count(DISTINCT n.id) AS changedStepCount
       ORDER BY changedStepCount DESC
       LIMIT 50`,
      { ids: nodeIds },
    )) as QueryRow[];

    const seen = new Map<string, AffectedProcess>();
    for (const row of rows) {
      const pid = rowStr(row, 'pid', 0);
      if (!pid || seen.has(pid)) continue;
      seen.set(pid, {
        id: pid,
        name: rowStr(row, 'name', 1, '(unknown process)'),
        processType: rowStr(row, 'processType', 2, 'unknown'),
        changedStepCount: rowNum(row, 'changedStepCount', 3),
      });
    }
    return { affectedProcesses: Array.from(seen.values()), processesAvailable: true };
  } catch (err) {
    warnings.push(
      `process enrichment unavailable: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { affectedProcesses: [], processesAvailable: false };
  }
}

// ---------------------------------------------------------------------------
// REV-3: Community enrichment helper
// ---------------------------------------------------------------------------

async function queryAffectedCommunities(
  repoId: string,
  nodeIds: string[],
  warnings: string[],
): Promise<{ affectedCommunities: AffectedCommunity[]; communitiesAvailable: boolean }> {
  if (nodeIds.length === 0) {
    return { affectedCommunities: [], communitiesAvailable: true };
  }
  try {
    const rows = (await executeParameterized(
      repoId,
      `MATCH (n)-[:CodeRelation {type: 'MEMBER_OF'}]->(c:Community)
       WHERE n.id IN $ids
       RETURN c.id AS cid, c.heuristicLabel AS name,
              count(DISTINCT n.id) AS changedSymbolCount
       ORDER BY changedSymbolCount DESC
       LIMIT 30`,
      { ids: nodeIds },
    )) as QueryRow[];

    const seen = new Map<string, AffectedCommunity>();
    for (const row of rows) {
      const cid = rowStr(row, 'cid', 0);
      if (!cid || seen.has(cid)) continue;
      seen.set(cid, {
        id: cid,
        name: rowStr(row, 'name', 1, '(unknown cluster)'),
        changedSymbolCount: rowNum(row, 'changedSymbolCount', 2),
      });
    }
    return { affectedCommunities: Array.from(seen.values()), communitiesAvailable: true };
  } catch (err) {
    warnings.push(
      `community enrichment unavailable: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { affectedCommunities: [], communitiesAvailable: false };
  }
}

// ---------------------------------------------------------------------------
// REV-3: Cross-community risk hints (ranking aid only)
// ---------------------------------------------------------------------------

/**
 * Build advisory risk hint strings from community data.
 * These are ranking aids — they NEVER reduce complete impact output.
 */
function buildCrossCommunityHints(
  communities: AffectedCommunity[],
  communitiesAvailable: boolean,
  highRiskSymbols: string[],
): string[] {
  if (!communitiesAvailable) return [];
  const reasons: string[] = [];
  if (communities.length > 1) {
    reasons.push(
      `changes span ${communities.length} communities: ${communities.map((c) => c.name).join(', ')}`,
    );
  }
  if (communities.length > 1 && highRiskSymbols.length > 0) {
    reasons.push(
      `high-risk symbols in cross-community change: ${highRiskSymbols.slice(0, 5).join(', ')}`,
    );
  }
  return reasons;
}
