/**
 * ANN Neighbor Retrieval-Only Edges
 *
 * Provides a pure builder for semantic-neighbor relationships that are intended
 * for retrieval only, not dependency or impact traversal.
 */

export const ANN_NEIGHBOR_RELATION_TYPE = 'ANN_NEIGHBOR' as const;
export const ANN_NEIGHBOR_DEFAULT_OUTBOUND_DEGREE = 16;
export const ANN_NEIGHBOR_MAX_OUTBOUND_DEGREE = 32;

export type AnnNeighborRelationType = typeof ANN_NEIGHBOR_RELATION_TYPE;

export interface AnnEmbeddingRow {
  nodeId: string;
  model: string;
  buildId: string;
  builtAt: string;
  contentHash: string;
  embedding: readonly number[];
}

export interface AnnNeighborExplicitCandidate {
  sourceId: string;
  targetId: string;
  score: number;
  sourceContentHash: string;
  targetContentHash: string;
}

export type AnnNeighborStaleReason =
  | 'source-content-hash-mismatch'
  | 'target-content-hash-mismatch'
  | 'source-build-id-mismatch'
  | 'target-build-id-mismatch';

export interface AnnNeighborEdge {
  relationType: AnnNeighborRelationType;
  sourceId: string;
  targetId: string;
  score: number;
  rank: number;
  model: string;
  sourceContentHash: string;
  targetContentHash: string;
  builtAt: string;
  buildId: string;
  isStale: boolean;
  staleReasons: readonly AnnNeighborStaleReason[];
}

export interface AnnNeighborFreshnessState {
  nodeId: string;
  contentHash: string;
  buildId: string;
}

export interface AnnNeighborBuildContext {
  currentContentHashByNodeId?: ReadonlyMap<string, string>;
  currentBuildIdByNodeId?: ReadonlyMap<string, string>;
  maxOutboundDegree?: number;
  includeStaleEdges?: boolean;
}

export interface AnnNeighborBuildOptions extends AnnNeighborBuildContext {
  embeddings: readonly AnnEmbeddingRow[];
}

export interface AnnNeighborExplicitBuildOptions extends AnnNeighborBuildContext {
  candidates: readonly AnnNeighborExplicitCandidate[];
  model: string;
  buildId: string;
  builtAt: string;
}

const normalizeNodeId = (value: string): string => value.trim();

const normalizeDegree = (value: number | undefined): number => {
  if (!Number.isFinite(value) || value <= 0) return ANN_NEIGHBOR_DEFAULT_OUTBOUND_DEGREE;
  return Math.min(Math.max(Math.floor(value), 1), ANN_NEIGHBOR_MAX_OUTBOUND_DEGREE);
};

const scoreFromEmbedding = (
  source: readonly number[],
  target: readonly number[],
): number | undefined => {
  if (source.length !== target.length || source.length === 0) return undefined;
  let dot = 0;
  let sourceMagnitude = 0;
  let targetMagnitude = 0;

  for (let idx = 0; idx < source.length; idx += 1) {
    const sourceValue = source[idx];
    const targetValue = target[idx];
    dot += sourceValue * targetValue;
    sourceMagnitude += sourceValue * sourceValue;
    targetMagnitude += targetValue * targetValue;
  }

  if (!Number.isFinite(dot) || sourceMagnitude === 0 || targetMagnitude === 0) {
    return undefined;
  }

  return dot / Math.sqrt(sourceMagnitude) / Math.sqrt(targetMagnitude);
};

const staleReasons = (
  source: AnnNeighborFreshnessState,
  target: AnnNeighborFreshnessState,
  context: AnnNeighborBuildContext,
): AnnNeighborStaleReason[] => {
  const reasons: AnnNeighborStaleReason[] = [];
  const currentSourceHash = context.currentContentHashByNodeId?.get(source.nodeId);
  const currentTargetHash = context.currentContentHashByNodeId?.get(target.nodeId);
  const currentSourceBuild = context.currentBuildIdByNodeId?.get(source.nodeId);
  const currentTargetBuild = context.currentBuildIdByNodeId?.get(target.nodeId);

  if (currentSourceHash !== undefined && source.contentHash !== currentSourceHash) {
    reasons.push('source-content-hash-mismatch');
  }
  if (currentTargetHash !== undefined && target.contentHash !== currentTargetHash) {
    reasons.push('target-content-hash-mismatch');
  }
  if (currentSourceBuild !== undefined && source.buildId !== currentSourceBuild) {
    reasons.push('source-build-id-mismatch');
  }
  if (currentTargetBuild !== undefined && target.buildId !== currentTargetBuild) {
    reasons.push('target-build-id-mismatch');
  }

  return reasons;
};

interface AnnNeighborEdgeMetadata extends AnnNeighborFreshnessState {
  model: string;
  builtAt: string;
}

const buildEdge = (
  source: AnnNeighborEdgeMetadata,
  target: AnnNeighborEdgeMetadata,
  score: number,
  rank: number,
  isStale: boolean,
  reasons: readonly AnnNeighborStaleReason[],
): AnnNeighborEdge => {
  return {
    relationType: ANN_NEIGHBOR_RELATION_TYPE,
    sourceId: source.nodeId,
    targetId: target.nodeId,
    score,
    rank,
    model: source.model,
    sourceContentHash: source.contentHash,
    targetContentHash: target.contentHash,
    builtAt: source.builtAt,
    buildId: source.buildId,
    isStale,
    staleReasons: reasons,
  };
};

const mapEmbeddingRows = (rows: readonly AnnEmbeddingRow[]): Map<string, AnnEmbeddingRow> => {
  const normalized = new Map<string, AnnEmbeddingRow>();
  for (const row of rows) {
    const nodeId = normalizeNodeId(row.nodeId);
    if (!nodeId || normalized.has(nodeId)) continue;
    normalized.set(nodeId, { ...row, nodeId });
  }
  return normalized;
};

export const buildAnnNeighborsFromEmbeddingRows = (
  options: AnnNeighborBuildOptions,
): AnnNeighborEdge[] => {
  const { embeddings, includeStaleEdges = false } = options;
  const maxOutboundDegree = normalizeDegree(options.maxOutboundDegree);
  const rowsById = mapEmbeddingRows(embeddings);
  const rows = Array.from(rowsById.values()).sort((a, b) => a.nodeId.localeCompare(b.nodeId));
  const edges: AnnNeighborEdge[] = [];

  for (const source of rows) {
    const scoredTargets: Array<{ target: AnnEmbeddingRow; score: number }> = [];
    for (const target of rows) {
      if (source.nodeId === target.nodeId) continue;
      const score = scoreFromEmbedding(source.embedding, target.embedding);
      if (score === undefined || !Number.isFinite(score)) continue;
      scoredTargets.push({ target, score });
    }

    scoredTargets.sort((left, right) => {
      if (left.score !== right.score) return right.score - left.score;
      return left.target.nodeId.localeCompare(right.target.nodeId);
    });

    const capped = scoredTargets.slice(0, maxOutboundDegree);
    let rank = 0;
    for (const { target, score } of capped) {
      const reasons = staleReasons(source, target, options);
      if (reasons.length > 0 && !includeStaleEdges) continue;
      rank += 1;
      edges.push(buildEdge(source, target, score, rank, reasons.length > 0, reasons));
    }
  }

  return edges;
};

export const buildAnnNeighborsFromExplicitCandidates = (
  options: AnnNeighborExplicitBuildOptions,
): AnnNeighborEdge[] => {
  const {
    candidates,
    includeStaleEdges = false,
    maxOutboundDegree = ANN_NEIGHBOR_DEFAULT_OUTBOUND_DEGREE,
    model,
    buildId,
    builtAt,
  } = options;

  const outboundDegree = normalizeDegree(maxOutboundDegree);
  const grouped = new Map<string, Map<string, { score: number; sourceContentHash: string; targetContentHash: string }>>();

  for (const candidate of candidates) {
    const sourceId = normalizeNodeId(candidate.sourceId);
    const targetId = normalizeNodeId(candidate.targetId);
    if (!sourceId || !targetId || sourceId === targetId) continue;

    if (!Number.isFinite(candidate.score)) continue;

    const sourceMap =
      grouped.get(sourceId) ??
      new Map<string, { score: number; sourceContentHash: string; targetContentHash: string }>();
    const existing = sourceMap.get(targetId);
    if (!existing || candidate.score > existing.score) {
      sourceMap.set(targetId, {
        score: candidate.score,
        sourceContentHash: candidate.sourceContentHash,
        targetContentHash: candidate.targetContentHash,
      });
    }
    grouped.set(sourceId, sourceMap);
  }

  const result: AnnNeighborEdge[] = [];
  for (const [sourceId, targets] of [...grouped.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const sourceCandidateTargets = [...targets.entries()].sort((left, right) => {
      if (left[1].score !== right[1].score) return right[1].score - left[1].score;
      return left[0].localeCompare(right[0]);
    });

    let rank = 1;
    for (const [targetId, candidate] of sourceCandidateTargets.slice(0, outboundDegree)) {
      const reasons = staleReasons(
        {
          nodeId: sourceId,
          contentHash: candidate.sourceContentHash,
          buildId,
        },
        {
          nodeId: targetId,
          contentHash: candidate.targetContentHash,
          buildId,
        },
        options,
      );
      if (reasons.length > 0 && !includeStaleEdges) continue;
      const syntheticSource: AnnNeighborEdgeMetadata = {
        nodeId: sourceId,
        model,
        buildId,
        builtAt,
        contentHash: candidate.sourceContentHash,
      };
      const syntheticTarget: AnnNeighborEdgeMetadata = {
        nodeId: targetId,
        model,
        buildId,
        builtAt,
        contentHash: candidate.targetContentHash,
      };
      result.push(
        buildEdge(
          syntheticSource,
          syntheticTarget,
          candidate.score,
          rank,
          reasons.length > 0,
          reasons,
        ),
      );
      rank += 1;
    }
  }

  return result;
};
