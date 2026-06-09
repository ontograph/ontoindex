/**
 * BFS graph-path computation for citation graphPath field (v11 W3a).
 *
 * Computes bounded BFS from a symbol nodeId via IMPORTS/CALLS/REFERENCES/
 * CO_CHANGED_WITH edges up to depth 4. Returns edges in BFS traversal order
 * for the citation graphPath field added stub-form in v10 W3a (commit db5b5e1f).
 *
 * Bounded: max 4 hops, max 500 nodes visited (circuit-breaker).
 * p95 target: < 200ms per call (per v11 plan §6 kill-switch).
 *
 * Schema note: CodeRelation is the single relationship table (REL_TABLE_NAME).
 * Edge types are stored as the `type` property. REFERENCES and CO_CHANGED_WITH
 * may not yet be present in all indexes (added by P1 gitMining streaming fix);
 * the query returns 0 rows for absent types without error.
 */
import { executeParameterized } from '../lbug/pool-adapter.js';

export interface GraphPathEdge {
  fromId: string;
  toId: string;
  type: string;
  depth: number;
}

export interface GraphPathReport {
  maxObservedDepth: number;
  nodesVisited: number;
  byRelationshipType: Record<string, number>;
  truncated: boolean;
  truncatedReasons: string[];
  traversalStrategy: GraphTraversalStrategy;
  weightedTraversal: WeightedTraversalDiagnostics;
  passiveFacts: PassiveFactDiagnostics;
}

export interface GraphPathResult {
  edges: GraphPathEdge[];
  passiveFacts: GraphPathEdge[];
  traversalStrategy: GraphTraversalStrategy;
  report: GraphPathReport;
}

const MAX_DEPTH = 4;
const MAX_NODES = 500;

export type GraphTraversalStrategy = 'simple-bfs' | 'weighted-bfs';

export interface GraphPathOptions {
  traversalStrategy?: GraphTraversalStrategy;
}

export interface WeightedTraversalRank {
  fromId: string;
  toId: string;
  type: string;
  depth: number;
  edgeWeight: number;
  depthWeight: number;
  score: number;
  reason: string;
}

export interface WeightedTraversalDiagnostics {
  status: 'not-requested' | 'available';
  edgeWeights: Record<string, number>;
  depthWeighting: 'score=edgeWeight/depth';
  rankedEdges: WeightedTraversalRank[];
}

export interface PassiveFactDiagnostics {
  status: 'unavailable';
  reason: 'passive-fact-source-not-configured';
  facts: GraphPathEdge[];
}

const EDGE_WEIGHTS: Record<string, number> = {
  CALLS: 1.0,
  IMPORTS: 0.8,
  REFERENCES: 0.5,
  CO_CHANGED_WITH: 0.3,
};

type GraphPathQueryRow = Record<string, unknown> & { readonly [index: number]: unknown };

function rowValue(row: GraphPathQueryRow, key: string, index: number): unknown {
  return row[key] ?? row[index];
}

function createReport(traversalStrategy: GraphTraversalStrategy): GraphPathReport {
  return {
    maxObservedDepth: 0,
    nodesVisited: 0,
    byRelationshipType: {},
    truncated: false,
    truncatedReasons: [],
    traversalStrategy,
    weightedTraversal: {
      status: traversalStrategy === 'weighted-bfs' ? 'available' : 'not-requested',
      edgeWeights: EDGE_WEIGHTS,
      depthWeighting: 'score=edgeWeight/depth',
      rankedEdges: [],
    },
    passiveFacts: {
      status: 'unavailable',
      reason: 'passive-fact-source-not-configured',
      facts: [],
    },
  };
}

function rankEdge(edge: GraphPathEdge): WeightedTraversalRank {
  const edgeWeight = EDGE_WEIGHTS[edge.type] ?? 0.1;
  const depthWeight = edge.depth;
  const score = edgeWeight / depthWeight;
  return {
    ...edge,
    edgeWeight,
    depthWeight,
    score,
    reason: `${edge.type} weight ${edgeWeight} divided by depth ${depthWeight}`,
  };
}

function compareRankedEdges(a: WeightedTraversalRank, b: WeightedTraversalRank): number {
  return (
    b.score - a.score ||
    a.depth - b.depth ||
    a.fromId.localeCompare(b.fromId) ||
    a.toId.localeCompare(b.toId) ||
    a.type.localeCompare(b.type)
  );
}

/**
 * BFS from startNodeId over IMPORTS/CALLS/REFERENCES/CO_CHANGED_WITH edges.
 * Returns edges in BFS traversal order.
 * Returns [] if startNodeId is null/undefined OR if DB call fails (best-effort).
 */
export async function computeGraphPath(
  repoId: string,
  startNodeId: string | null | undefined,
): Promise<GraphPathEdge[]> {
  const result = await computeGraphPathWithDiagnostics(repoId, startNodeId);
  return result.edges;
}

/**
 * BFS from startNodeId with diagnostics reporting.
 */
export async function computeGraphPathWithDiagnostics(
  repoId: string,
  startNodeId: string | null | undefined,
  options: GraphPathOptions = {},
): Promise<GraphPathResult> {
  const traversalStrategy = options.traversalStrategy ?? 'simple-bfs';
  const report = createReport(traversalStrategy);

  if (!startNodeId) {
    return { edges: [], passiveFacts: [], report, traversalStrategy };
  }

  const edges: GraphPathEdge[] = [];
  const visited = new Set<string>([startNodeId]);

  let frontier: string[] = [startNodeId];
  let depth = 0;

  report.nodesVisited = 1;

  while (frontier.length > 0 && depth < MAX_DEPTH) {
    if (visited.size >= MAX_NODES) {
      report.truncated = true;
      if (!report.truncatedReasons.includes('MAX_NODES')) {
        report.truncatedReasons.push('MAX_NODES');
      }
      break;
    }

    const nextFrontier: string[] = [];

    // Collect all neighbors for all nodes in the current frontier
    const levelNeighbors: Array<{ fromId: string; toId: string; type: string; weight: number }> =
      [];

    for (const nodeId of frontier) {
      if (visited.size >= MAX_NODES) break;

      let rows: GraphPathQueryRow[] = [];
      try {
        rows = await executeParameterized(
          repoId,
          `MATCH (n {id: $nodeId})-[r:CodeRelation]->(m)
           WHERE r.type IN ['IMPORTS', 'CALLS', 'REFERENCES', 'CO_CHANGED_WITH']
           RETURN m.id AS toId, r.type AS edgeType
           LIMIT 50`,
          { nodeId },
        );
      } catch {
        continue;
      }

      for (const row of rows) {
        const toId = rowValue(row, 'toId', 0) as string | undefined;
        const edgeType = rowValue(row, 'edgeType', 1) as string;
        if (!toId) continue;

        const edge = { fromId: nodeId, toId, type: edgeType, depth: depth + 1 };
        const rank = rankEdge(edge);
        levelNeighbors.push({ ...edge, weight: rank.score });
        if (traversalStrategy === 'weighted-bfs') {
          report.weightedTraversal.rankedEdges.push(rank);
        }
      }
    }

    if (traversalStrategy === 'weighted-bfs') {
      levelNeighbors.sort(
        (a, b) =>
          b.weight - a.weight ||
          a.fromId.localeCompare(b.fromId) ||
          a.toId.localeCompare(b.toId) ||
          a.type.localeCompare(b.type),
      );
    }

    for (const neighbor of levelNeighbors) {
      if (visited.size >= MAX_NODES) {
        report.truncated = true;
        if (!report.truncatedReasons.includes('MAX_NODES')) {
          report.truncatedReasons.push('MAX_NODES');
        }
        break;
      }

      const { fromId, toId, type } = neighbor;

      report.byRelationshipType[type] = (report.byRelationshipType[type] ?? 0) + 1;

      const edge: GraphPathEdge = { fromId, toId, type, depth: depth + 1 };
      edges.push(edge);

      if (visited.has(toId)) continue;
      visited.add(toId);
      report.nodesVisited = visited.size;
      nextFrontier.push(toId);

      if (depth + 1 > report.maxObservedDepth) {
        report.maxObservedDepth = depth + 1;
      }
    }

    frontier = nextFrontier;
    depth++;
  }

  if (depth >= MAX_DEPTH && frontier.length > 0 && !report.truncated) {
    report.truncated = true;
    report.truncatedReasons.push('MAX_DEPTH');
  }

  if (traversalStrategy === 'weighted-bfs') {
    report.weightedTraversal.rankedEdges.sort(compareRankedEdges);
  }

  return { edges, passiveFacts: [], report, traversalStrategy };
}
