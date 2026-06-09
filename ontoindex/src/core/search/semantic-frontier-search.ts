/**
 * Internal one-shot semantic frontier search for ANN-like neighbor graphs.
 *
 * Expands ANN neighbors in-process in one call from provided edges or a single
 * neighbor-provider call, scores candidates against a query vector, ranks them, and
 * returns advisory diagnostics.
 */
import type { QueryFreshnessStatus } from '../runtime/query-diagnostics.js';

export type SemanticFrontierSeedLane = string;

export type VectorLike = readonly number[] | Float32Array;

export type SemanticFrontierEdgeSource = 'ann';

export interface SemanticFrontierSeed {
  readonly nodeId: string;
  readonly lanes?: readonly SemanticFrontierSeedLane[];
  readonly vector?: VectorLike;
  readonly freshness?: QueryFreshnessStatus;
}

export interface SemanticFrontierCandidate {
  readonly nodeId: string;
  readonly vector?: VectorLike;
  readonly name?: string;
  readonly filePath?: string;
  readonly startLine?: number;
  readonly endLine?: number;
  readonly lanes?: readonly SemanticFrontierSeedLane[];
  readonly freshness?: QueryFreshnessStatus;
}

export interface SemanticFrontierEdge {
  readonly fromId: string;
  readonly toId: string;
  readonly score?: number;
  readonly target?: SemanticFrontierCandidate;
  readonly freshness?: QueryFreshnessStatus;
  readonly stale?: boolean;
}

export type SemanticFrontierNeighborProvider = (
  repo: string,
  seeds: readonly SemanticFrontierSeed[],
) => Promise<readonly SemanticFrontierEdge[]>;

export interface SemanticFrontierSearchOptions {
  readonly edges?: readonly SemanticFrontierEdge[];
  readonly neighborProvider?: SemanticFrontierNeighborProvider;
  readonly edgeMap?: ReadonlyMap<string, readonly SemanticFrontierEdge[]>;
}

export interface SemanticFrontierSearchParams extends SemanticFrontierSearchOptions {
  readonly repo: string;
  readonly repoPath?: string;
  readonly queryVector: VectorLike;
  readonly seeds: readonly SemanticFrontierSeed[];
  readonly topK?: number;
  readonly ef?: number;
  readonly maxVisited?: number;
  readonly freshnessRequired?: boolean;
}

export interface SemanticFrontierSearchResult {
  readonly nodeId: string;
  readonly score: number;
  readonly annScore: number;
  readonly lanes: SemanticFrontierSeedLane[];
  readonly sourceIds: string[];
  readonly name?: string;
  readonly filePath?: string;
  readonly startLine?: number;
  readonly endLine?: number;
  readonly freshness?: QueryFreshnessStatus;
}

export interface SemanticFrontierSearchDiagnostics {
  readonly repo: string;
  readonly repoPath?: string;
  readonly mode: SemanticFrontierEdgeSource;
  readonly embeddingReady: boolean;
  readonly indexFreshness: QueryFreshnessStatus;
  readonly visited: number;
  readonly maxVisited: number;
  readonly truncated: boolean;
  readonly seedLanes: string[];
  readonly warnings: string[];
  readonly fallbackReason?: string;
  readonly results: readonly SemanticFrontierSearchResult[];
}

type MutableSemanticFrontierSearchDiagnostics = {
  -readonly [K in keyof SemanticFrontierSearchDiagnostics]: SemanticFrontierSearchDiagnostics[K];
};

const DEFAULT_TOP_K = 10;
const DEFAULT_EF = 64;
const DEFAULT_MAX_VISITED = 512;

const FRESHNESS_ORDER: Record<QueryFreshnessStatus, number> = {
  fresh: 0,
  'not-applicable': 1,
  unknown: 2,
  degraded: 3,
  stale: 4,
};

function toVector(value: VectorLike): number[] {
  return Array.isArray(value) ? [...value] : Array.from(value);
}

function hasValidVector(value: VectorLike): boolean {
  if (!value || value.length === 0) {
    return false;
  }
  for (const item of value) {
    if (!Number.isFinite(item)) {
      return false;
    }
  }
  return true;
}

function cosSim(query: number[], candidate: number[]): number {
  const limit = Math.min(query.length, candidate.length);
  if (limit === 0) return 0;

  let dot = 0;
  let queryNormSq = 0;
  let candidateNormSq = 0;

  for (let i = 0; i < limit; i += 1) {
    const q = query[i];
    const c = candidate[i];
    dot += q * c;
    queryNormSq += q * q;
    candidateNormSq += c * c;
  }

  if (queryNormSq === 0 || candidateNormSq === 0) return 0;
  return dot / (Math.sqrt(queryNormSq) * Math.sqrt(candidateNormSq));
}

function mergeFreshness(current: QueryFreshnessStatus, next?: QueryFreshnessStatus): QueryFreshnessStatus {
  if (next === undefined) {
    return current;
  }
  return FRESHNESS_ORDER[next] > FRESHNESS_ORDER[current] ? next : current;
}

function uniqSorted(items?: readonly string[]): string[] {
  if (!items || items.length === 0) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (!item || seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out.sort();
}

function addUnique(target: string[], value?: string): void {
  if (!value || target.includes(value)) return;
  target.push(value);
}

/**
 * Expand ANN-like neighbors in a single in-process traversal and return ranked
 * diagnostics. No repeated external MCP/tool calls are made.
 */
export async function semanticFrontierSearch(
  params: SemanticFrontierSearchParams,
): Promise<SemanticFrontierSearchDiagnostics> {
  const topK = Number.isFinite(params.topK) ? Math.max(0, Math.floor(params.topK)) : DEFAULT_TOP_K;
  const ef = Number.isFinite(params.ef) ? Math.max(1, Math.floor(params.ef)) : DEFAULT_EF;
  const maxVisited = Number.isFinite(params.maxVisited)
    ? Math.max(1, Math.floor(params.maxVisited))
    : DEFAULT_MAX_VISITED;
  const freshnessRequired = params.freshnessRequired === true;

  const warnings = new Set<string>();
  const seedLanes = uniqSorted(params.seeds.flatMap((seed) => seed.lanes ?? []));
  const result: MutableSemanticFrontierSearchDiagnostics = {
    repo: params.repo,
    repoPath: params.repoPath,
    mode: 'ann',
    embeddingReady: true,
    indexFreshness: 'fresh',
    visited: 0,
    maxVisited,
    truncated: false,
    seedLanes,
    warnings: [],
    results: [],
  };

  if (!hasValidVector(params.queryVector)) {
    return {
      ...result,
      embeddingReady: false,
      indexFreshness: 'degraded',
      fallbackReason: 'queryVector-invalid',
      warnings: ['queryVector is missing or contains invalid numbers.'],
    };
  }

  const validSeeds = params.seeds.filter((seed) => seed.nodeId && seed.nodeId.trim().length > 0);
  if (validSeeds.length === 0) {
    return {
      ...result,
      indexFreshness: 'unknown',
      fallbackReason: 'seed-missing',
      warnings: ['No valid seed ids were supplied.'],
    };
  }

  let edges: SemanticFrontierEdge[] = [];
  let externalCallMade = false;
  if (params.neighborProvider) {
    externalCallMade = true;
    try {
      edges = [...(await params.neighborProvider(params.repo, validSeeds))];
    } catch (error) {
      return {
        ...result,
        indexFreshness: 'degraded',
        fallbackReason: 'neighbor-provider-failed',
        warnings: [
          `neighborProvider failed: ${error instanceof Error ? error.message : String(error)}`,
        ],
      };
    }
  }

  if (params.edges) {
    edges = [...edges, ...params.edges];
  }

  if (params.edgeMap) {
    for (const [fromId, groupedEdges] of params.edgeMap.entries()) {
      for (const edge of groupedEdges) {
        edges.push({ ...edge, fromId: edge.fromId || fromId });
      }
    }
  }

  if (!externalCallMade && edges.length === 0) {
    return {
      ...result,
      indexFreshness: 'degraded',
      fallbackReason: 'neighbor-source-missing',
      warnings: ['No ANN edge source supplied.'],
    };
  }

  const adjacency = new Map<string, SemanticFrontierEdge[]>();
  const candidateMap = new Map<string, SemanticFrontierCandidate>();
  const laneByNode = new Map<string, string[]>();
  let indexFreshness: QueryFreshnessStatus = 'fresh';

  for (const seed of validSeeds) {
    candidateMap.set(seed.nodeId, {
      nodeId: seed.nodeId,
      vector: seed.vector,
      freshness: seed.freshness,
    });
    laneByNode.set(seed.nodeId, uniqSorted(seed.lanes));
    indexFreshness = mergeFreshness(indexFreshness, seed.freshness);
  }

  for (const edge of edges) {
    if (!edge.fromId || !edge.toId) continue;
    if (!edge.target) {
      adjacency.set(edge.fromId, [...(adjacency.get(edge.fromId) ?? []), edge]);
      continue;
    }

    const mergedLanes = uniqSorted([...(edge.target.lanes ?? []), ...(laneByNode.get(edge.toId) ?? [])]);
    const existing = candidateMap.get(edge.toId);
    if (existing) {
      candidateMap.set(edge.toId, {
        ...existing,
        ...edge.target,
        lanes: mergedLanes,
      });
    } else {
      candidateMap.set(edge.toId, {
        nodeId: edge.toId,
        ...edge.target,
      });
    }
    adjacency.set(edge.fromId, [...(adjacency.get(edge.fromId) ?? []), edge]);
    indexFreshness = mergeFreshness(indexFreshness, edge.freshness);
    indexFreshness = mergeFreshness(indexFreshness, edge.target.freshness);
    if (edge.stale) {
      indexFreshness = mergeFreshness(indexFreshness, 'stale');
    }
    if (edge.score !== undefined && typeof edge.score !== 'number') {
      warnings.add(`Invalid ANN score for edge ${edge.fromId}->${edge.toId}; treated as 0.`);
    }
  }

  result.indexFreshness = indexFreshness;

  const queryVector = toVector(params.queryVector);
  const frontier: string[] = [];
  const frontierSeen = new Set<string>();
  const visitedCandidates = new Set<string>();
  const scoredResults: SemanticFrontierSearchResult[] = [];
  let truncatedByEf = false;
  let truncatedByVisited = false;

  for (const seed of validSeeds) {
    if (frontierSeen.has(seed.nodeId)) continue;
    frontier.push(seed.nodeId);
    frontierSeen.add(seed.nodeId);
  }

  if (frontier.length > ef) {
    frontier.length = ef;
    truncatedByEf = true;
  }

  let frontierIndex = 0;
  while (frontierIndex < frontier.length) {
    const currentId = frontier[frontierIndex];
    frontierIndex += 1;

    const outgoing = adjacency.get(currentId) ?? [];
    const sourceLanes = laneByNode.get(currentId) ?? [];

    for (const edge of outgoing) {
      if (visitedCandidates.size >= maxVisited) {
        truncatedByVisited = true;
        break;
      }

      const nextId = edge.toId;
      if (!nextId || visitedCandidates.has(nextId)) {
        continue;
      }

      visitedCandidates.add(nextId);
      result.visited += 1;

      const candidate = candidateMap.get(nextId);
      const candidateFreshness = candidate?.freshness;
      result.indexFreshness = mergeFreshness(result.indexFreshness, candidateFreshness);

      if (candidateFreshness === 'stale' && freshnessRequired) {
        warnings.add(`Skipped stale candidate ${nextId} due to freshnessRequired.`);
        continue;
      }

      if (!candidate?.vector || !hasValidVector(candidate.vector)) {
        warnings.add(`No candidate vector for ${nextId}; skipped.`);
        continue;
      }

      const candidateLanes = uniqSorted([
        ...sourceLanes,
        ...(candidate.lanes ?? []),
      ]);
      const finalLanes = candidateLanes.length > 0 ? candidateLanes : ['ann'];

      scoredResults.push({
        nodeId: nextId,
        score: cosSim(queryVector, toVector(candidate.vector)),
        annScore: typeof edge.score === 'number' ? edge.score : 0,
        lanes: finalLanes,
        sourceIds: [currentId],
        name: candidate.name,
        filePath: candidate.filePath,
        startLine: candidate.startLine,
        endLine: candidate.endLine,
        freshness: candidateFreshness,
      });

      const nextLanes = laneByNode.get(nextId) ?? [];
      for (const lane of finalLanes) {
        addUnique(nextLanes, lane);
      }
      laneByNode.set(nextId, nextLanes);

      if (frontier.length < ef && !frontierSeen.has(nextId)) {
        frontier.push(nextId);
        frontierSeen.add(nextId);
      } else if (frontier.length >= ef) {
        truncatedByEf = true;
      }

      if (visitedCandidates.size >= maxVisited) {
        truncatedByVisited = true;
        break;
      }
    }

    if (truncatedByVisited || truncatedByEf) {
      break;
    }
  }

  scoredResults.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    if (a.annScore !== b.annScore) return b.annScore - a.annScore;
    return a.nodeId.localeCompare(b.nodeId);
  });

  result.results = scoredResults.slice(0, topK);
  result.truncated = truncatedByEf || truncatedByVisited;
  result.warnings = [...warnings].sort();

  if (result.results.length === 0) {
    if (!result.fallbackReason) {
      result.fallbackReason =
        visitedCandidates.size === 0 ? 'no-neighbors' : 'no-scored-results';
    }
  } else if (result.truncated && !result.fallbackReason) {
    if (truncatedByVisited) {
      result.fallbackReason = 'maxVisited-cap';
    } else if (truncatedByEf) {
      result.fallbackReason = 'ef-cap';
    }
  }

  if (result.warnings.length > 0 && result.indexFreshness === 'fresh') {
    result.indexFreshness = 'degraded';
  }

  return result;
}
