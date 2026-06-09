/**
 * Bounded multi-seed BFS graph traversal for per-intent ensemble (v13 P1 W1b-step-2).
 *
 * Provides graphTraversalRank(): takes top-N BM25 seed symbols, expands them
 * via BFS over specified edge types (CALLS and/or IMPORTS), deduplicates by
 * minimum BFS depth, and returns ranked EnrichedSymbolRow[] for the graph leg
 * of applyEnsemble().
 *
 * Design constraints (from audit_v13-w1a-ensemble-design.md §D and §H W1b-step-2):
 *   - depth=2 (NOT 4 like graph-path.ts citation BFS)
 *   - max 50 results per intent
 *   - edge types: CALLS for calls-of; IMPORTS|CALLS for cross-file-impact
 *   - best-effort error handling: DB failure → return []
 *   - total query count bounded at 4 * seeds.length (avoid runaway BFS)
 *   - latency target: < 200ms p95 per query
 *
 * NOTE: graph-path.ts (citation BFS) is NOT modified — it is a separate use case
 * at depth=4 with a different edge-type set.
 */
import { executeParameterized } from '../lbug/pool-adapter.js';
import type { EnrichedSymbolRow } from './symbol-merge.js';

export type GraphEdgeType = 'CALLS' | 'IMPORTS' | 'REFERENCES';
export type GraphTraversalRankStrategy = 'simple-bfs' | 'weighted-bfs';

export interface GraphTraversalRankOptions {
  traversalStrategy?: GraphTraversalRankStrategy;
  edgeWeights?: Partial<Record<GraphEdgeType, number>>;
}

export interface GraphTraversalEdgeDiagnostic {
  fromId: string;
  toId: string;
  edgeType: GraphEdgeType;
  depth: number;
  edgeWeight: number;
  distance: number;
  score: number;
  reason: string;
}

export interface GraphTraversalNodeDiagnostic {
  nodeId: string;
  depth: number;
  distance: number;
  score: number;
  via: {
    fromId: string;
    edgeType: GraphEdgeType;
  };
  reason: string;
}

export interface GraphTraversalPassiveFactDiagnostics {
  status: 'unavailable';
  reason: 'passive-fact-source-not-configured';
  facts: [];
}

export interface GraphTraversalRankReport {
  traversalStrategy: GraphTraversalRankStrategy;
  maxDepth: number;
  maxResults: number;
  byDepth: Record<number, number>;
  byEdgeType: Record<string, number>;
  edgeWeights: Record<GraphEdgeType, number>;
  depthWeighting: 'weightedDistance=sum(1/edgeWeight)' | 'simpleDepth=min-hop-count';
  rankedEdges: GraphTraversalEdgeDiagnostic[];
  rankedNodes: GraphTraversalNodeDiagnostic[];
  passiveFacts: GraphTraversalPassiveFactDiagnostics;
  truncated: boolean;
  truncatedReasons: string[];
}

export interface GraphTraversalRankResult {
  rows: EnrichedSymbolRow[];
  report: GraphTraversalRankReport;
}

const MAX_DEPTH = 2;
const DEFAULT_MAX_RESULTS = 50;
/** Hard cap on BFS expansion per query (G6 mitigation). */
const BFS_VISIT_CAP = 200;

const EDGE_WEIGHTS: Record<GraphEdgeType, number> = {
  CALLS: 1.0,
  IMPORTS: 0.8,
  REFERENCES: 0.5,
};

type GraphTraversalQueryRow = Record<string, unknown> & { readonly [index: number]: unknown };

function rowValue(row: GraphTraversalQueryRow, key: string, index: number): unknown {
  return row[key] ?? row[index];
}

function createReport(
  traversalStrategy: GraphTraversalRankStrategy,
  maxDepth: number,
  maxResults: number,
  edgeWeights: Record<GraphEdgeType, number>,
): GraphTraversalRankReport {
  return {
    traversalStrategy,
    maxDepth,
    maxResults,
    byDepth: {},
    byEdgeType: {},
    edgeWeights,
    depthWeighting:
      traversalStrategy === 'weighted-bfs'
        ? 'weightedDistance=sum(1/edgeWeight)'
        : 'simpleDepth=min-hop-count',
    rankedEdges: [],
    rankedNodes: [],
    passiveFacts: {
      status: 'unavailable',
      reason: 'passive-fact-source-not-configured',
      facts: [],
    },
    truncated: false,
    truncatedReasons: [],
  };
}

function addTruncatedReason(report: GraphTraversalRankReport, reason: string): void {
  report.truncated = true;
  if (!report.truncatedReasons.includes(reason)) {
    report.truncatedReasons.push(reason);
  }
}

/**
 * Multi-seed bounded BFS over CALLS/IMPORTS/REFERENCES edges.
 *
 * @param repoId      - Repository ID (passed to executeParameterized)
 * @param seeds       - Seed symbols (typically top-10 BM25 results)
 * @param edgeTypes   - Edge types to traverse
 * @param maxDepth    - BFS depth bound (default 2)
 * @param maxResults  - Maximum ranked results to return (default 50)
 * @returns EnrichedSymbolRow[] ranked by simple BFS distance unless weighted traversal is requested
 */
export async function graphTraversalRank(
  repoId: string,
  seeds: EnrichedSymbolRow[],
  edgeTypes: GraphEdgeType[],
  maxDepth: number = MAX_DEPTH,
  maxResults: number = DEFAULT_MAX_RESULTS,
  options: GraphTraversalRankOptions = {},
): Promise<EnrichedSymbolRow[]> {
  const result = await graphTraversalRankWithDiagnostics(
    repoId,
    seeds,
    edgeTypes,
    maxDepth,
    maxResults,
    options,
  );
  return result.rows;
}

export async function graphTraversalRankWithDiagnostics(
  repoId: string,
  seeds: EnrichedSymbolRow[],
  edgeTypes: GraphEdgeType[],
  maxDepth: number = MAX_DEPTH,
  maxResults: number = DEFAULT_MAX_RESULTS,
  options: GraphTraversalRankOptions = {},
): Promise<GraphTraversalRankResult> {
  const traversalStrategy = options.traversalStrategy ?? 'simple-bfs';
  const edgeWeights: Record<GraphEdgeType, number> = { ...EDGE_WEIGHTS, ...options.edgeWeights };
  const report = createReport(traversalStrategy, maxDepth, maxResults, edgeWeights);

  if (seeds.length === 0 || edgeTypes.length === 0) return { rows: [], report };

  const distanceMap = new Map<string, number>();
  const depthMap = new Map<string, number>();
  const dataMap = new Map<string, EnrichedSymbolRow>();
  const orderMap = new Map<string, number>();
  const viaMap = new Map<string, { fromId: string; edgeType: GraphEdgeType }>();
  let discoveryOrder = 0;

  const seedIds: string[] = [];
  for (const seed of seeds) {
    const id = seed.nodeId;
    if (!id) continue;
    if (!distanceMap.has(id)) {
      distanceMap.set(id, 0);
      depthMap.set(id, 0);
      dataMap.set(id, seed);
      seedIds.push(id);
    }
  }

  if (seedIds.length === 0) return { rows: [], report };

  const queryBudget = 4 * seeds.length;
  let queriesUsed = 0;

  let frontier: string[] = seedIds;

  for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
    const nextFrontier: string[] = [];

    const neighbors: Array<{
      fromId: string;
      toId: string;
      row: GraphTraversalQueryRow;
      edgeType: GraphEdgeType;
      distance: number;
      score: number;
      diagnostic: GraphTraversalEdgeDiagnostic;
    }> = [];

    for (const nodeId of frontier) {
      if (queriesUsed >= queryBudget) {
        addTruncatedReason(report, 'QUERY_BUDGET');
        break;
      }
      if (distanceMap.size > BFS_VISIT_CAP) {
        addTruncatedReason(report, 'BFS_VISIT_CAP');
        break;
      }

      let rows: GraphTraversalQueryRow[] = [];
      try {
        rows = await executeParameterized(
          repoId,
          `MATCH (n {id: $nodeId})-[r:CodeRelation]->(m)
           WHERE r.type IN $edgeTypes
           RETURN m.id AS toId, m.name AS name, m.type AS nodeType,
                  m.filePath AS filePath, m.startLine AS startLine, r.type AS edgeType
           LIMIT 50`,
          { nodeId, edgeTypes },
        );
        queriesUsed++;
      } catch {
        queriesUsed++;
        continue;
      }

      for (const row of rows) {
        const toId = rowValue(row, 'toId', 0) as string | undefined;
        if (!toId) continue;
        const edgeType =
          ((rowValue(row, 'edgeType', 5) as GraphEdgeType | undefined) ?? edgeTypes[0]) || 'CALLS';
        const edgeWeight = edgeWeights[edgeType] ?? 0.1;
        const nextDepth = depth + 1;
        const parentDistance = distanceMap.get(nodeId) ?? 0;
        const distance =
          traversalStrategy === 'weighted-bfs' ? parentDistance + 1 / edgeWeight : nextDepth;
        const score = 1 / distance;
        const diagnostic = {
          fromId: nodeId,
          toId,
          edgeType,
          depth: nextDepth,
          edgeWeight,
          distance,
          score,
          reason:
            traversalStrategy === 'weighted-bfs'
              ? `${edgeType} weight ${edgeWeight} contributes ${1 / edgeWeight} distance at depth ${nextDepth}`
              : `simple BFS ranks by minimum depth ${nextDepth}; ${edgeType} weight ${edgeWeight} is diagnostic only`,
        };
        neighbors.push({ fromId: nodeId, toId, row, edgeType, distance, score, diagnostic });
        report.byDepth[nextDepth] = (report.byDepth[nextDepth] ?? 0) + 1;
        report.byEdgeType[edgeType] = (report.byEdgeType[edgeType] ?? 0) + 1;
        report.rankedEdges.push(diagnostic);
      }
    }

    if (traversalStrategy === 'weighted-bfs') {
      neighbors.sort(
        (a, b) =>
          a.distance - b.distance ||
          a.fromId.localeCompare(b.fromId) ||
          a.toId.localeCompare(b.toId) ||
          a.edgeType.localeCompare(b.edgeType),
      );
    }

    for (const neighbor of neighbors) {
      const { fromId, toId, row, edgeType, distance } = neighbor;
      const currentDistance = distanceMap.get(toId);
      const shouldUpdate =
        currentDistance === undefined ||
        (traversalStrategy === 'weighted-bfs' && distance < currentDistance);

      if (shouldUpdate) {
        const firstTime = !distanceMap.has(toId);
        distanceMap.set(toId, distance);
        depthMap.set(toId, depth + 1);
        dataMap.set(toId, {
          nodeId: toId,
          name: (rowValue(row, 'name', 1) ?? '') as string,
          type: (rowValue(row, 'nodeType', 2) ?? 'Unknown') as string,
          filePath: (rowValue(row, 'filePath', 3) ?? '') as string,
          startLine: (rowValue(row, 'startLine', 4) ?? 0) as number,
        });
        viaMap.set(toId, { fromId, edgeType });
        if (firstTime) {
          orderMap.set(toId, discoveryOrder++);
          nextFrontier.push(toId);
        }
        if (distanceMap.size > BFS_VISIT_CAP) {
          addTruncatedReason(report, 'BFS_VISIT_CAP');
          break;
        }
      }
    }

    frontier = nextFrontier;
  }

  const results: Array<{
    depth: number;
    distance: number;
    order: number;
    row: EnrichedSymbolRow;
  }> = [];
  for (const [nodeId, distance] of distanceMap.entries()) {
    if (distance === 0) continue;
    const row = dataMap.get(nodeId);
    const depth = depthMap.get(nodeId) ?? 0;
    if (row) {
      results.push({
        depth,
        distance,
        order: orderMap.get(nodeId) ?? Number.MAX_SAFE_INTEGER,
        row,
      });
    }
  }

  results.sort((a, b) => {
    if (traversalStrategy === 'weighted-bfs') {
      return a.distance - b.distance || a.depth - b.depth || a.order - b.order;
    }
    return a.depth - b.depth || a.order - b.order;
  });

  const rankedRows = results.slice(0, maxResults);
  report.rankedNodes = rankedRows.map(({ row, depth, distance }) => {
    const via = viaMap.get(row.nodeId ?? '') ?? { fromId: '', edgeType: 'CALLS' as GraphEdgeType };
    const score = 1 / distance;
    return {
      nodeId: row.nodeId ?? '',
      depth,
      distance,
      score,
      via,
      reason:
        traversalStrategy === 'weighted-bfs'
          ? `ranked by weighted distance ${distance}`
          : `ranked by simple BFS depth ${depth}`,
    };
  });
  report.rankedEdges.sort((a, b) =>
    traversalStrategy === 'weighted-bfs'
      ? a.distance - b.distance ||
        a.depth - b.depth ||
        a.fromId.localeCompare(b.fromId) ||
        a.toId.localeCompare(b.toId)
      : a.depth - b.depth || a.fromId.localeCompare(b.fromId) || a.toId.localeCompare(b.toId),
  );

  return { rows: rankedRows.map((r) => r.row), report };
}
