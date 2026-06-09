/**
 * ANN neighbor persistence/load adapter for LadybugDB relationship storage.
 *
 * This module intentionally stays query-builder + executor-driven and carries all
 * persistence details in a testable utility layer so backend wiring can be adapted
 * without changing query composition.
 */

import type { SemanticFrontierEdge } from '../search/semantic-frontier-search.js';
import {
  ANN_NEIGHBOR_DEFAULT_OUTBOUND_DEGREE,
  ANN_NEIGHBOR_RELATION_TYPE,
  type AnnNeighborEdge,
  type AnnNeighborStaleReason,
} from './ann-neighbor.js';

type PrimitiveParam = string | number | boolean | null;
type QueryParams = Readonly<Record<string, PrimitiveParam | ReadonlyArray<PrimitiveParam>>>;
type QueryRow = Record<string, unknown> | readonly unknown[];

type ExecuteQuery = (cypher: string, params?: QueryParams) => Promise<QueryRow[]>;
type ExecuteBatch = (cypher: string, paramsList: readonly AnnNeighborPersistParams[]) => Promise<void>;

type AnnNeighborPersistParams = {
  readonly sourceId: string;
  readonly targetId: string;
  readonly relationType: string;
  readonly score: number;
  readonly rank: number;
  readonly reason: string;
};

export interface AnnNeighborLoadOptions {
  readonly sourceIds?: readonly string[];
  readonly relationType?: string;
  readonly includeStale?: boolean;
  readonly currentContentHashByNodeId?: ReadonlyMap<string, string>;
  readonly currentBuildIdByNodeId?: ReadonlyMap<string, string>;
  readonly maxOutboundDegree?: number;
}

export interface AnnNeighborCleanupOptions {
  readonly sourceIds?: readonly string[];
  readonly relationType?: string;
  readonly staleOnly?: boolean;
  readonly currentContentHashByNodeId?: ReadonlyMap<string, string>;
  readonly currentBuildIdByNodeId?: ReadonlyMap<string, string>;
  readonly dryRun?: boolean;
}

export interface AnnNeighborStoredMetadata {
  readonly relationType: string;
  readonly model: string;
  readonly score: number;
  readonly rank: number;
  readonly sourceContentHash: string;
  readonly targetContentHash: string;
  readonly builtAt: string;
  readonly buildId: string;
  readonly isStale: boolean;
  readonly staleReasons: readonly AnnNeighborStaleReason[];
}

export interface AnnNeighborStoredEdge extends AnnNeighborStoredMetadata {
  readonly sourceId: string;
  readonly targetId: string;
}

type AnnNeighborStoredMetadataFromDb = {
  sourceId: string;
  targetId: string;
  score: number;
  rank: number;
  reason: string;
};

type PersistedAnnMetadata = {
  readonly model: string;
  readonly sourceContentHash: string;
  readonly targetContentHash: string;
  readonly builtAt: string;
  readonly buildId: string;
  readonly isStale: boolean;
  readonly staleReasons?: readonly AnnNeighborStaleReason[];
};

const DEFAULT_MAX_DEGREE = ANN_NEIGHBOR_DEFAULT_OUTBOUND_DEGREE;
const MAX_DEGREE = 32;
const MIN_DEGREE = 1;

const rowField = <T>(row: QueryRow, field: string, index: number): T | undefined =>
  (Array.isArray(row) ? (row[index] as T | undefined) : (row[field] as T | undefined));

const normalizeDegree = (value: number | undefined): number => {
  if (!Number.isFinite(value) || value === undefined) return DEFAULT_MAX_DEGREE;
  const normalized = Math.floor(value);
  if (normalized < MIN_DEGREE) return MIN_DEGREE;
  if (normalized > MAX_DEGREE) return MAX_DEGREE;
  return normalized;
};

const toNonEmptyString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined;

const toFiniteNumber = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;

const toStaleReasonList = (value: unknown): AnnNeighborStaleReason[] =>
  Array.isArray(value) ? (value.filter((item): item is AnnNeighborStaleReason => typeof item === 'string') as AnnNeighborStaleReason[]) : [];

const encodeMetadata = (
  edge: Pick<
    AnnNeighborEdge,
    'model' | 'sourceContentHash' | 'targetContentHash' | 'builtAt' | 'buildId' | 'isStale' | 'staleReasons'
  >,
): string =>
  JSON.stringify({
    model: edge.model,
    sourceContentHash: edge.sourceContentHash,
    targetContentHash: edge.targetContentHash,
    builtAt: edge.builtAt,
    buildId: edge.buildId,
    isStale: edge.isStale,
    staleReasons: [...edge.staleReasons],
  } satisfies PersistedAnnMetadata);

const parseMetadata = (value: unknown): PersistedAnnMetadata | undefined => {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  try {
    const parsed = JSON.parse(value);
    if (
      parsed === null ||
      typeof parsed !== 'object' ||
      typeof parsed.model !== 'string' ||
      typeof parsed.sourceContentHash !== 'string' ||
      typeof parsed.targetContentHash !== 'string' ||
      typeof parsed.builtAt !== 'string' ||
      typeof parsed.buildId !== 'string' ||
      typeof parsed.isStale !== 'boolean'
    ) {
      return undefined;
    }
    return {
      model: parsed.model,
      sourceContentHash: parsed.sourceContentHash,
      targetContentHash: parsed.targetContentHash,
      builtAt: parsed.builtAt,
      buildId: parsed.buildId,
      isStale: parsed.isStale,
      staleReasons: toStaleReasonList(parsed.staleReasons),
    };
  } catch {
    return undefined;
  }
};

const computeStaleReasons = (
  sourceId: string,
  targetId: string,
  metadata: PersistedAnnMetadata,
  options: AnnNeighborLoadOptions,
): AnnNeighborStaleReason[] => {
  const reasons: AnnNeighborStaleReason[] = [...(metadata.staleReasons ?? [])];

  const sourceCurrentContentHash = options.currentContentHashByNodeId?.get(sourceId);
  const targetCurrentContentHash = options.currentContentHashByNodeId?.get(targetId);
  const sourceCurrentBuildId = options.currentBuildIdByNodeId?.get(sourceId);
  const targetCurrentBuildId = options.currentBuildIdByNodeId?.get(targetId);

  if (sourceCurrentContentHash !== undefined && metadata.sourceContentHash !== sourceCurrentContentHash) {
    reasons.push('source-content-hash-mismatch');
  }
  if (targetCurrentContentHash !== undefined && metadata.targetContentHash !== targetCurrentContentHash) {
    reasons.push('target-content-hash-mismatch');
  }
  if (sourceCurrentBuildId !== undefined && metadata.buildId !== sourceCurrentBuildId) {
    reasons.push('source-build-id-mismatch');
  }
  if (targetCurrentBuildId !== undefined && metadata.buildId !== targetCurrentBuildId) {
    reasons.push('target-build-id-mismatch');
  }

  return reasons;
};

const mapRowToMetadata = (row: QueryRow): AnnNeighborStoredMetadataFromDb | undefined => {
  const sourceId = toNonEmptyString(rowField(row, 'sourceId', 0));
  const targetId = toNonEmptyString(rowField(row, 'targetId', 1));
  if (!sourceId || !targetId) return undefined;

  return {
    sourceId,
    targetId,
    score: toFiniteNumber(rowField(row, 'score', 2), 0),
    rank: toFiniteNumber(rowField(row, 'rank', 3), 0),
    reason: toNonEmptyString(rowField(row, 'reason', 4)) ?? '',
  };
};

export const buildAnnNeighborPersistQuery = (): string => `
  MATCH (source), (target)
  WHERE source.id = $sourceId
    AND target.id = $targetId
  MERGE (source)-[r:CodeRelation {type: $relationType}]->(target)
  SET r.confidence = $score,
      r.reason = $reason,
      r.step = $rank
`;

export const buildAnnNeighborLoadQuery = (hasSourceFilter: boolean): string =>
  `
  MATCH (source)-[r:CodeRelation]->(target)
  WHERE r.type = $relationType
    ${hasSourceFilter ? 'AND source.id IN $sourceIds' : ''}
  RETURN
    source.id AS sourceId,
    target.id AS targetId,
    r.confidence AS score,
    r.step AS rank,
    r.reason AS reason
  ORDER BY source.id, r.step
`;

export const buildAnnNeighborDeleteQuery = (): string => `
  MATCH (source), (target)
  WHERE source.id = $sourceId
    AND target.id = $targetId
  MATCH (source)-[r:CodeRelation]->(target)
  WHERE r.type = $relationType
  DELETE r
`;

export const persistAnnNeighborEdges = async (
  executeWithReusedStatement: ExecuteBatch,
  edges: readonly AnnNeighborEdge[],
): Promise<void> => {
  const params: AnnNeighborPersistParams[] = edges
    .filter((edge) => edge.relationType === ANN_NEIGHBOR_RELATION_TYPE)
    .map((edge) => ({
      sourceId: edge.sourceId,
      targetId: edge.targetId,
      relationType: ANN_NEIGHBOR_RELATION_TYPE,
      score: edge.score,
      rank: edge.rank,
      reason: encodeMetadata(edge),
    }));

  if (params.length === 0) return;
  await executeWithReusedStatement(buildAnnNeighborPersistQuery(), params);
};

export const loadAnnNeighborEdges = async (
  executeQuery: ExecuteQuery,
  options: AnnNeighborLoadOptions = {},
): Promise<readonly AnnNeighborStoredEdge[]> => {
  const relationType = options.relationType ?? ANN_NEIGHBOR_RELATION_TYPE;
  const includeStale = options.includeStale === true;
  const maxOutboundDegree = normalizeDegree(options.maxOutboundDegree);
  const sourceIds = options.sourceIds?.filter((value) => value.length > 0);

  if (sourceIds && sourceIds.length === 0) return [];

  const rows = await executeQuery(buildAnnNeighborLoadQuery(Boolean(sourceIds && sourceIds.length)), {
    relationType,
    ...(sourceIds && { sourceIds: [...sourceIds] }),
  });

  const groupedEdges = new Map<string, AnnNeighborStoredEdge[]>();
  const sourceFilter = sourceIds && new Set(sourceIds);

  for (const row of rows) {
    const parsedRow = mapRowToMetadata(row);
    if (!parsedRow) continue;
    if (sourceFilter && !sourceFilter.has(parsedRow.sourceId)) continue;

    const metadata = parseMetadata(parsedRow.reason);
    if (!metadata) continue;

    const staleReasons = computeStaleReasons(parsedRow.sourceId, parsedRow.targetId, metadata, options);
    const isStale = metadata.isStale || staleReasons.length > 0;
    if (!includeStale && isStale) continue;

    const edge: AnnNeighborStoredEdge = {
      relationType,
      sourceId: parsedRow.sourceId,
      targetId: parsedRow.targetId,
      score: parsedRow.score,
      rank: parsedRow.rank,
      model: metadata.model,
      sourceContentHash: metadata.sourceContentHash,
      targetContentHash: metadata.targetContentHash,
      builtAt: metadata.builtAt,
      buildId: metadata.buildId,
      isStale,
      staleReasons,
    };

    const current = groupedEdges.get(edge.sourceId) ?? [];
    if (current.some((existing) => existing.targetId === edge.targetId)) continue;
    current.push(edge);
    current.sort((a, b) => {
      if (a.rank !== b.rank) return a.rank - b.rank;
      return a.targetId.localeCompare(b.targetId);
    });
    groupedEdges.set(edge.sourceId, current.slice(0, maxOutboundDegree));
  }

  const loaded: AnnNeighborStoredEdge[] = [];
  for (const edgesForSource of groupedEdges.values()) {
    loaded.push(...edgesForSource);
  }
  return loaded;
};

export const cleanupAnnNeighborEdges = async (
  executeQuery: ExecuteQuery,
  executeWithReusedStatement: ExecuteBatch,
  options: AnnNeighborCleanupOptions = {},
): Promise<{ deletedCount: number }> => {
  const relationType = options.relationType ?? ANN_NEIGHBOR_RELATION_TYPE;
  const staleOnly = options.staleOnly !== false;

  const loadedEdges = await loadAnnNeighborEdges(executeQuery, {
    sourceIds: options.sourceIds,
    relationType,
    includeStale: true,
    currentContentHashByNodeId: options.currentContentHashByNodeId,
    currentBuildIdByNodeId: options.currentBuildIdByNodeId,
  });

  const deletable = staleOnly ? loadedEdges.filter((edge) => edge.isStale) : loadedEdges;
  if (deletable.length === 0 || options.dryRun) {
    return { deletedCount: options.dryRun ? deletable.length : 0 };
  }

  await executeWithReusedStatement(
    buildAnnNeighborDeleteQuery(),
    deletable.map((edge) => ({
      sourceId: edge.sourceId,
      targetId: edge.targetId,
      relationType,
      score: edge.score,
      rank: edge.rank,
      reason: 'removed',
    })),
  );

  return { deletedCount: deletable.length };
};

export const adaptAnnNeighborEdgesForFrontier = (
  edges: readonly AnnNeighborStoredEdge[],
): readonly SemanticFrontierEdge[] =>
  edges.map((edge) => ({
    fromId: edge.sourceId,
    toId: edge.targetId,
    score: edge.score,
    stale: edge.isStale,
  }));
